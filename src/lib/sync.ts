import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { db, getSetting, setSetting, delSetting, SYNCED_TABLES, type SyncedTable, type SyncedRow } from './db'
import { setOnLocalChange } from './data'
import { recomputeOwnedBalances } from './accounts'

/**
 * Household sync engine.
 *
 * Model: one `records` table on Supabase holding every row as
 * { id, household_id, tbl, data (jsonb), deleted, updated_at }.
 * - Push: local rows with dirty=1 are upserted.
 * - Pull: records with server updated_at > cursor are applied locally,
 *   last-write-wins on the client-side `data.updatedAt` when a local row
 *   is dirty.
 * - Realtime: postgres_changes on the household streams edits in live.
 */

export interface SyncState {
  email?: string
  userId?: string
  householdId?: string
  joinCode?: string
  syncing: boolean
  lastSyncAt?: number
  error?: string
  ready: boolean
}

let state: SyncState = { syncing: false, ready: false }
const listeners = new Set<() => void>()
let channel: RealtimeChannel | null = null
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let syncQueued = false

function set(partial: Partial<SyncState>) {
  state = { ...state, ...partial }
  listeners.forEach((l) => l())
}

export const syncStore = {
  getState: () => state,
  subscribe: (cb: () => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
}

/* ---------- auth ---------- */

export async function signUp(email: string, password: string) {
  // Send the confirmation link back to wherever the app is actually served
  // (the hosted gh-pages URL in production, localhost during dev) rather than
  // inheriting the project's Site URL. Stripping the hash keeps HashRouter's
  // route out of the redirect target.
  const emailRedirectTo = window.location.href.split('#')[0]
  const { error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo } })
  if (error) throw new Error(error.message)
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
}

export async function signOut() {
  await supabase.auth.signOut()
  stopRealtime()
  await delSetting('householdId')
  await delSetting('joinCode')
  await delSetting('syncCursor')
  set({ email: undefined, householdId: undefined, joinCode: undefined, error: undefined })
}

/* ---------- household ---------- */

async function adoptHousehold(id: string, joinCode: string) {
  await setSetting('householdId', id)
  await setSetting('joinCode', joinCode)
  set({ householdId: id, joinCode })
  startRealtime()
}

/** Create a household and upload everything on this device. */
export async function createHousehold() {
  const { data, error } = await supabase.rpc('create_household')
  if (error) throw new Error(error.message)
  const row = Array.isArray(data) ? data[0] : data
  // Everything local becomes the household's starting data.
  for (const t of SYNCED_TABLES) {
    await db.table(t).toCollection().modify((r) => {
      r.dirty = 1
    })
  }
  await adoptHousehold(row.id, row.join_code)
  await syncNow()
}

/** Join the partner's household: local data is replaced by the household's. */
export async function joinHousehold(code: string) {
  const { data, error } = await supabase.rpc('join_household', { code })
  if (error) throw new Error(error.message)
  const row = Array.isArray(data) ? data[0] : data
  for (const t of SYNCED_TABLES) await db.table(t).clear()
  await delSetting('syncCursor')
  await adoptHousehold(row.id, row.join_code)
  await syncNow()
}

/** Look up an existing membership after signing in on a new device. */
async function findMembership(): Promise<boolean> {
  const { data, error } = await supabase.from('household_members').select('household_id').limit(1)
  if (error || !data?.length) return false
  const householdId = data[0].household_id as string
  const { data: hh } = await supabase.from('households').select('join_code').eq('id', householdId).limit(1)
  await adoptHousehold(householdId, hh?.[0]?.join_code ?? '')
  return true
}

/* ---------- sync core ---------- */

/** Account ids whose transactions must not be visible to the partner. */
async function privateAccountIds(): Promise<Set<string>> {
  const accounts = await db.accounts.toArray()
  return new Set(accounts.filter((a) => a.visibility === 'private' || a.visibility === 'balance').map((a) => a.id!))
}

async function pushDirty(householdId: string) {
  const privateAccounts = await privateAccountIds()
  const isPrivate = (tbl: SyncedTable, r: SyncedRow & Record<string, unknown>) => {
    if (tbl === 'accounts') return (r as { visibility?: string }).visibility === 'private'
    if (tbl === 'transactions') {
      const accountId = (r as { accountId?: string }).accountId
      return !!accountId && privateAccounts.has(accountId)
    }
    return false
  }
  for (const tbl of SYNCED_TABLES) {
    const dirty = (await db.table(tbl).filter((r) => r.dirty === 1).toArray()) as (SyncedRow & Record<string, unknown>)[]
    for (let i = 0; i < dirty.length; i += 400) {
      const chunk = dirty.slice(i, i + 400)
      const payload = chunk.map((r) => {
        const { dirty: _d, deleted, ...data } = r
        return { id: r.id!, household_id: householdId, tbl, data, deleted: !!deleted, private: isPrivate(tbl, r) }
      })
      const { error } = await supabase.from('records').upsert(payload)
      if (error) throw new Error(`push ${tbl}: ${error.message}`)
      for (const r of chunk) {
        // Only clear dirty if the row didn't change again mid-push.
        const current = (await db.table(tbl).get(r.id!)) as SyncedRow | undefined
        if (current && current.updatedAt === r.updatedAt) {
          await db.table(tbl).update(r.id!, { dirty: 0 })
        }
      }
    }
  }
}

interface RemoteRecord {
  id: string
  tbl: string
  data: SyncedRow & Record<string, unknown>
  deleted: boolean
  updated_at: string
  owner_id?: string
  private?: boolean
}

async function applyRemote(rec: RemoteRecord) {
  const tbl = rec.tbl as SyncedTable
  if (!SYNCED_TABLES.includes(tbl)) return
  const local = (await db.table(tbl).get(rec.id)) as SyncedRow | undefined
  const remoteUpdatedAt = (rec.data.updatedAt as number) ?? 0
  if (local?.dirty && (local.updatedAt ?? 0) > remoteUpdatedAt) return // ours is newer; will push
  const row: Record<string, unknown> = { ...rec.data, id: rec.id, deleted: rec.deleted ? 1 : 0, dirty: 0 }
  if (tbl === 'accounts' && rec.owner_id) row.ownerId = rec.owner_id
  await db.table(tbl).put(row)
  // A purge means an account went private: non-owner devices drop its
  // transactions locally (the server already refuses to send them anew).
  if (tbl === 'purges' && !rec.deleted) {
    const accountId = rec.data.accountId as string
    const ownerId = rec.data.ownerId as string
    if (ownerId && ownerId !== state.userId) {
      await db.transactions.where('accountId').equals(accountId).delete()
      const account = await db.accounts.get(accountId)
      if (account && account.visibility === 'private') await db.accounts.delete(accountId)
    }
  }
}

async function pullSince(cursor: string | undefined): Promise<string | undefined> {
  let latest = cursor
  for (;;) {
    let q = supabase.from('records').select('*').order('updated_at', { ascending: true }).limit(1000)
    if (latest) q = q.gt('updated_at', latest)
    const { data, error } = await q
    if (error) throw new Error(`pull: ${error.message}`)
    if (!data?.length) return latest
    for (const rec of data as RemoteRecord[]) await applyRemote(rec)
    latest = (data[data.length - 1] as RemoteRecord).updated_at
    await setSetting('syncCursor', latest)
    if (data.length < 1000) return latest
  }
}

export async function syncNow() {
  const householdId = state.householdId
  if (!householdId || state.syncing) {
    syncQueued = state.syncing
    return
  }
  set({ syncing: true, error: undefined })
  try {
    await recomputeOwnedBalances(state.userId)
    await pushDirty(householdId)
    await pullSince(await getSetting('syncCursor'))
    set({ syncing: false, lastSyncAt: Date.now() })
  } catch (e) {
    set({ syncing: false, error: e instanceof Error ? e.message : 'Sync failed' })
  }
  if (syncQueued) {
    syncQueued = false
    void syncNow()
  }
}

export function queueSync(delay = 1500) {
  if (!state.householdId) return
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => void syncNow(), delay)
}

/* ---------- realtime ---------- */

function startRealtime() {
  if (!state.householdId || channel) return
  channel = supabase
    .channel('records-sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'records', filter: `household_id=eq.${state.householdId}` },
      (payload) => {
        const rec = payload.new as RemoteRecord
        if (rec?.id) void applyRemote(rec).then(() => setSetting('syncCursor', rec.updated_at))
      },
    )
    .subscribe()
}

function stopRealtime() {
  if (channel) {
    void supabase.removeChannel(channel)
    channel = null
  }
}

/* ---------- boot ---------- */

export async function initSync() {
  setOnLocalChange(() => queueSync())

  supabase.auth.onAuthStateChange((_event, session) => {
    void (async () => {
      if (session?.user) {
        set({ email: session.user.email ?? undefined, userId: session.user.id })
        const storedHousehold = await getSetting('householdId')
        const storedCode = await getSetting('joinCode')
        if (storedHousehold) {
          set({ householdId: storedHousehold, joinCode: storedCode })
          startRealtime()
          void syncNow()
        } else {
          const joined = await findMembership()
          if (joined) void syncNow()
        }
      } else {
        set({ email: undefined })
      }
      set({ ready: true })
    })()
  })

  window.addEventListener('online', () => queueSync(200))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') queueSync(200)
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') queueSync(0)
  }, 60_000)
}
