#!/usr/bin/env node
/**
 * Two-device concurrency check, run against a real Supabase project.
 *
 * Two independent clients, signed in as two different people, hitting the same
 * household at the same moment — no browser, so the interleaving is
 * deterministic and repeatable in a way manual testing never is.
 *
 * The vitest suite covers the client's logic against a fake server. This covers
 * what only the real one can answer: whether row level security, the unique
 * indexes and the RPCs actually behave as designed when two people race.
 *
 *   VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=... \
 *   TEST_EMAIL_A=... TEST_PASSWORD_A=... \
 *   TEST_EMAIL_B=... TEST_PASSWORD_B=... \
 *   node scripts/concurrency.mjs
 *
 * Use throwaway accounts: it writes to whatever household they are in.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// Read .env so the script needs no extra setup beyond the two test accounts.
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {
  /* no .env; rely on the environment */
}

const { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key } = process.env
const A = { email: process.env.TEST_EMAIL_A, password: process.env.TEST_PASSWORD_A }
const B = { email: process.env.TEST_EMAIL_B, password: process.env.TEST_PASSWORD_B }

if (!url || !key || !A.email || !B.email) {
  console.error('Set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and the four TEST_* variables. See the header.')
  process.exit(2)
}

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

async function signIn({ email, password }) {
  const client = createClient(url, key, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`${email}: ${error.message}`)
  const { data } = await client.auth.getUser()
  return { client, userId: data.user.id, email }
}

const uuid = () => crypto.randomUUID()

async function main() {
  console.log('Signing in two devices…')
  const a = await signIn(A)
  const b = await signIn(B)

  // Put both in one household.
  const { data: household, error: hErr } = await a.client.rpc('create_household', { household_name: 'Concurrency test' })
  if (hErr) throw new Error(hErr.message)
  const { error: jErr } = await b.client.rpc('join_household', { code: household.join_code })
  if (jErr) throw new Error(jErr.message)
  console.log(`Household ${household.id}\n`)

  const { data: accounts } = await a.client.from('accounts').select('id').limit(1)
  const accountId = accounts[0].id
  const { data: cats } = await a.client.from('categories').select('id').eq('name', 'Groceries').limit(1)
  const categoryId = cats[0].id

  // ---- 1. Concurrent edits to different fields of one transaction ----
  // The core claim of the whole rewrite. Field-level updates mean the last
  // writer does not carry the other's stale copy of the rest of the row.
  console.log('1. Two people editing different fields of one transaction')
  const txnId = uuid()
  await a.client.from('transactions').insert({
    id: txnId, account_id: accountId, category_id: categoryId,
    occurred_on: '2026-03-01', payee: 'Original', amount_minor: -1000,
  })
  await Promise.all([
    a.client.from('transactions').update({ payee: 'Renamed by A' }).eq('id', txnId).select('id'),
    b.client.from('transactions').update({ amount_minor: -2500 }).eq('id', txnId).select('id'),
  ])
  const { data: merged } = await a.client.from('transactions').select('payee,amount_minor').eq('id', txnId).single()
  check('both edits survive', merged.payee === 'Renamed by A' && merged.amount_minor === -2500,
    `${merged.payee} / ${merged.amount_minor}`)

  // ---- 2. Both create the same category at once ----
  // Names are deliberately NOT unique: a hard write failure on a row the user
  // has already watched appear is worse than two rows in a list.
  console.log('2. Both creating a category called "Coffee" at the same moment')
  const results = await Promise.all([
    a.client.from('categories').insert({ id: uuid(), name: 'Coffee', icon: 'coffee', slot: 3, kind: 'expense', sort_order: 50 }).select('id'),
    b.client.from('categories').insert({ id: uuid(), name: 'Coffee', icon: 'coffee', slot: 3, kind: 'expense', sort_order: 51 }).select('id'),
  ])
  check('neither write is rejected', results.every((r) => !r.error), results.map((r) => r.error?.code ?? 'ok').join(', '))

  // ---- 3. Paging across rows that share a timestamp ----
  console.log('3. 501 rows written together, pulled 500 at a time')
  const bulk = Array.from({ length: 501 }, (_, i) => ({
    id: uuid(), account_id: accountId, category_id: categoryId,
    occurred_on: '2026-04-01', payee: `Bulk ${i}`, amount_minor: -100 - i,
  }))
  await a.client.from('transactions').insert(bulk)

  const seen = new Set()
  let cursor
  for (;;) {
    let q = b.client.from('transactions').select('id,updated_at')
      .eq('occurred_on', '2026-04-01')
      .order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(500)
    if (cursor) {
      const ts = cursor.updated_at.replace(/\+00:?00$/, 'Z')
      q = q.or(`updated_at.gt.${ts},and(updated_at.eq.${ts},id.gt.${cursor.id})`)
    }
    const { data, error } = await q
    if (error) throw new Error(error.message)
    if (!data.length) break
    for (const r of data) seen.add(r.id)
    cursor = data[data.length - 1]
    if (data.length < 500) break
  }
  check('all 501 arrive on the other device', seen.size === 501, `${seen.size} of 501`)

  // ---- 4. Both catching up the same overdue bill ----
  console.log('4. Both devices auto-posting the same overdue bill')
  const billId = uuid()
  const overdue = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10)
  await a.client.from('bills').insert({
    id: billId, name: 'Rent', payee: 'Landlord', amount_minor: -80000,
    category_id: categoryId, account_id: accountId, freq: 'monthly',
    next_due: overdue, active: true, auto_post: true,
  })
  await Promise.all([a.client.rpc('post_due_bills', {}), b.client.rpc('post_due_bills', {})])
  const { count: postings } = await a.client.from('bill_postings').select('*', { count: 'exact', head: true }).eq('bill_id', billId)
  const { count: billTxns } = await a.client.from('transactions').select('*', { count: 'exact', head: true }).eq('bill_id', billId)
  check('one transaction per occurrence, not two', postings === billTxns, `${billTxns} transactions, ${postings} postings`)

  // ---- 5. A visibility change while the other device is writing ----
  console.log('5. Making an account private while the partner writes to it')
  const privateId = uuid()
  await a.client.from('accounts').insert({ id: privateId, name: 'Secret stash', kind: 'cash', visibility: 'shared' })
  const before = (await a.client.from('households').select('visibility_epoch').single()).data.visibility_epoch

  await a.client.from('accounts').update({ visibility: 'private', owner_id: a.userId }).eq('id', privateId).select('id')
  const after = (await a.client.from('households').select('visibility_epoch').single()).data.visibility_epoch
  check('the epoch bumps so the partner rebuilds its cache', after > before, `${before} → ${after}`)

  const { data: bSees } = await b.client.from('accounts').select('id').eq('id', privateId)
  check('the partner can no longer see the account', bSees.length === 0)

  const { error: bWrite } = await b.client.from('transactions').insert({
    id: uuid(), account_id: privateId, category_id: categoryId,
    occurred_on: '2026-03-01', payee: 'Sneaky', amount_minor: -100,
  })
  check('the partner cannot write to it either', !!bWrite, bWrite?.code ?? 'no error — LEAK')

  // ---- cleanup ----
  await a.client.rpc('wipe_household')
  await b.client.rpc('leave_household')
  await a.client.rpc('leave_household')

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nHarness error:', e.message)
  process.exit(2)
})
