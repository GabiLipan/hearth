import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: {}, isConfigured: true }))

const { db } = await import('./db')
const { seedDemoData, defaultDemoAccount } = await import('./demo')
const { insertToDb } = await import('./mapping')

/**
 * Demo data goes through the ordinary write path, so anything malformed here
 * does not fail loudly — it is queued, sent, and rejected by the server minutes
 * later as a dead letter the user has to read a PostgREST message to understand.
 * That is exactly how "load demo data" came to produce eight
 * `could not find the function public.upsert_budget(...)` errors: every budget
 * was built without a `month`, and a lying type predicate stopped the compiler
 * from noticing.
 */

const account = (over: Partial<Awaited<ReturnType<typeof db.accounts.get>>> = {}) => ({
  id: 'acct-shared',
  name: 'Joint account',
  kind: 'current' as const,
  visibility: 'shared' as const,
  ownerId: 'someone-else',
  openingBalanceMinor: 0,
  sortOrder: 0,
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

beforeEach(async () => {
  await Promise.all([db.transactions.clear(), db.categories.clear(), db.accounts.clear(), db.bills.clear(), db.budgets.clear(), db.outbox.clear()])
  await db.categories.bulkPut(
    ['Groceries', 'Home & utilities', 'Transport', 'Dining out', 'Shopping', 'Subscriptions', 'Health', 'Fun & leisure', 'Salary'].map(
      (name, i) => ({ id: `cat-${i}`, name, kind: name === 'Salary' ? 'income' : 'expense', sortOrder: i, icon: 'tag', slot: 1, updatedAt: '2026-01-01T00:00:00Z' }),
    ),
  )
})

describe('seedDemoData', () => {
  it('gives every budget a month, so upsert_budget resolves to the right overload', async () => {
    await db.accounts.put(account())
    await seedDemoData('acct-shared')

    const budgets = await db.budgets.toArray()
    expect(budgets.length).toBeGreaterThan(0)
    for (const b of budgets) {
      expect(b.month, `budget for ${b.categoryId} has no month`).toBeTruthy()
      // The server checks `month = date_trunc('month', month)`, so anything but
      // the first of a month is rejected outright.
      expect(b.month).toMatch(/^\d{4}-\d{2}-01$/)
    }
  })

  it('writes only to the account it was given', async () => {
    await db.accounts.bulkPut([account(), account({ id: 'acct-private', name: 'My account', visibility: 'private', ownerId: 'me' })])
    await seedDemoData('acct-private')

    const accountIds = new Set((await db.transactions.toArray()).map((t) => t.accountId))
    expect([...accountIds]).toEqual(['acct-private'])
    expect((await db.bills.toArray()).every((b) => b.accountId === 'acct-private')).toBe(true)
  })

  it('refuses an account that does not exist rather than guessing one', async () => {
    await db.accounts.put(account())
    await expect(seedDemoData('acct-missing')).rejects.toThrow(/no longer exists/i)
    expect(await db.transactions.count()).toBe(0)
  })

  it('queues every row it creates through the outbox', async () => {
    await db.accounts.put(account())
    await seedDemoData('acct-shared')
    // A cache write with no queued mutation is a change that never saves.
    const queued = await db.outbox.count()
    const rows = (await db.transactions.count()) + (await db.bills.count()) + (await db.budgets.count())
    expect(queued).toBe(rows)
  })

  it('only sends columns the server accepts as writable', async () => {
    await db.accounts.put(account())
    await seedDemoData('acct-shared')
    // `insertToDb` is the real boundary: it throws on any key that is not
    // client-writable, so this catches a demo row carrying a trigger-stamped
    // column long before the server rejects it.
    for (const entry of await db.outbox.toArray()) {
      expect(() => insertToDb(entry.table, { id: entry.rowId, ...entry.payload })).not.toThrow()
    }
  })
})

describe('defaultDemoAccount', () => {
  it('prefers a shared account over a private one', () => {
    const shared = account()
    const priv = account({ id: 'acct-private', visibility: 'private', ownerId: 'me' })
    expect(defaultDemoAccount([priv, shared], 'me')?.id).toBe('acct-shared')
  })

  it('never picks an account the user cannot record against', () => {
    const theirs = account({ id: 'acct-theirs', visibility: 'private', ownerId: 'partner' })
    expect(defaultDemoAccount([theirs], 'me')).toBeUndefined()
  })

  it('falls back to the user’s own account when nothing is shared', () => {
    const mine = account({ id: 'acct-mine', visibility: 'private', ownerId: 'me' })
    expect(defaultDemoAccount([mine], 'me')?.id).toBe('acct-mine')
  })
})
