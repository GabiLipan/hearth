import type { PostgrestError } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { SyncedTable } from './db'
import { insertToDb, patchToDb, selectColumns, type DbRow } from './mapping'

/**
 * The single boundary between the app and PostgREST.
 *
 * Everything that talks to the server goes through here so that two rules are
 * applied in exactly one place:
 *
 *  1. **Every failure is classified** as transient (retry) or permanent
 *     (dead-letter). Getting this wrong either loses a write or wedges the
 *     queue forever retrying something that can never succeed.
 *
 *  2. **Updates and deletes assert they matched a row.** PostgREST answers an
 *     UPDATE that matched nothing with HTTP 204 and `error: null` — a success.
 *     So a write to a row that was hard-deleted, or that RLS has since hidden,
 *     silently does nothing while the client goes on believing it landed. Every
 *     update here asks for the id back and treats zero rows as a failure.
 */

export type FailureKind = 'transient' | 'permanent'

export class SyncError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

/**
 * SQLSTATE classes that mean "the server or the network had a moment". Anything
 * not listed is assumed permanent, because retrying a genuine constraint
 * violation forever is worse than surfacing it: the user can act on a message,
 * they cannot act on a queue that has quietly stopped.
 */
const TRANSIENT_CLASSES = ['08', '53', '57', '58'] // connection, out-of-resources, operator intervention, system error
const TRANSIENT_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  'PGRST301', // JWT expired — the client refreshes and the retry succeeds
])

export function classify(error: unknown): SyncError {
  // fetch() rejects (offline, DNS, TLS, aborted) without a PostgREST body.
  if (error instanceof TypeError || (error instanceof Error && /fetch|network|Failed to fetch/i.test(error.message))) {
    return new SyncError(error.message || 'Network unavailable', 'transient')
  }
  if (error instanceof SyncError) return error

  const pg = error as Partial<PostgrestError> & { status?: number }
  const code = pg?.code
  const status = pg?.status

  if (typeof status === 'number' && status >= 500) {
    return new SyncError(pg.message ?? `Server error ${status}`, 'transient', code)
  }
  if (code) {
    if (TRANSIENT_CODES.has(code)) return new SyncError(pg.message ?? code, 'transient', code)
    if (TRANSIENT_CLASSES.includes(code.slice(0, 2))) return new SyncError(pg.message ?? code, 'transient', code)
  }
  return new SyncError(pg?.message ?? 'Request failed', 'permanent', code)
}

/* ---------- writes ---------- */

/**
 * Insert rows, ignoring ones that already exist.
 *
 * This is the whole idempotency story. Ids are generated on the client, so a
 * request that reached the server and whose response was lost replays as a
 * conflict on the primary key and is dropped — not written twice. It is why
 * flaky connections no longer produce duplicates.
 *
 * Note this swallows conflicts on the PRIMARY KEY only. `on_conflict` cannot
 * name a partial or expression index through PostgREST, which is why the two
 * tables with those constraints (budgets, rules) are written by RPC instead.
 */
export async function insertRows(table: SyncedTable, rows: Record<string, unknown>[]) {
  const payload = rows.map((r) => insertToDb(table, r))
  const { error } = await supabase.from(table).upsert(payload, { onConflict: 'id', ignoreDuplicates: true })
  if (error) throw classify(error)
}

/** Field-level update: only the columns in `patch` are touched. */
export async function patchRow(table: SyncedTable, id: string, patch: Record<string, unknown>) {
  const payload = patchToDb(table, patch)
  if (Object.keys(payload).length === 0) return
  const { data, error } = await supabase.from(table).update(payload).eq('id', id).select('id')
  if (error) throw classify(error)
  assertMatched(data, table, id, 'update')
}

/** Soft delete. The row stays on the server as a tombstone so the other device learns about it. */
export async function softDeleteRow(table: SyncedTable, id: string) {
  const { data, error } = await supabase
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
  if (error) throw classify(error)
  // Already tombstoned is success, not failure: a replayed delete must be a
  // no-op rather than a dead letter.
  if (!data?.length) return
}

function assertMatched(data: unknown[] | null, table: SyncedTable, id: string, op: string) {
  if (!data || data.length === 0) {
    throw new SyncError(
      `${op} on ${table}/${id} matched no rows — it was deleted, or you no longer have access to it`,
      'permanent',
      'NO_ROWS',
    )
  }
}

/* ---------- reads ---------- */

export interface PullPage {
  rows: DbRow[]
  /** Raw PostgREST timestamp of the last row, for the next request. Never parsed. */
  lastUpdatedAt?: string
  lastId?: string
}

/**
 * PostgREST emits `+00:00` offsets; `+` is ambiguous in a query string. The `Z`
 * form parses identically server-side and sidesteps the encoding question.
 */
const sendableTimestamp = (ts: string) => ts.replace(/\+00:?00$/, 'Z')

/**
 * One page of rows changed at or after the cursor, ordered by `(updated_at, id)`.
 *
 * The `id` half of that ordering is load-bearing. Rows written by one statement
 * can share a timestamp, and the old sync ordered by timestamp alone with a
 * `limit` — so a page boundary landing inside a group of ties skipped the
 * remainder of that group permanently. That is the bug that lost transactions
 * after a large import.
 */
export async function pullPage(
  table: SyncedTable,
  cursor: { updatedAt: string; id?: string } | undefined,
  limit: number,
): Promise<PullPage> {
  let q = supabase
    .from(table)
    .select(selectColumns(table))
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)

  if (cursor) {
    const ts = sendableTimestamp(cursor.updatedAt)
    q = cursor.id
      ? // Resuming mid-pull: strictly after this exact (timestamp, id).
        q.or(`updated_at.gt.${ts},and(updated_at.eq.${ts},id.gt.${cursor.id})`)
      : // Starting a pull: inclusive, so the rewind window actually re-reads.
        q.gte('updated_at', ts)
  }

  const { data, error } = await q
  if (error) throw classify(error)
  const rows = (data ?? []) as unknown as DbRow[]
  const last = rows[rows.length - 1]
  return { rows, lastUpdatedAt: last?.updated_at, lastId: last?.id }
}

/** Every live row of a table, paged. Used on cold start and after an epoch bump. */
export async function pullAll(table: SyncedTable, pageSize = 1000): Promise<DbRow[]> {
  const out: DbRow[] = []
  let cursor: { updatedAt: string; id: string } | undefined
  for (;;) {
    const page = await pullPage(table, cursor, pageSize)
    out.push(...page.rows)
    if (page.rows.length < pageSize || !page.lastUpdatedAt || !page.lastId) return out
    cursor = { updatedAt: page.lastUpdatedAt, id: page.lastId }
  }
}

/**
 * A single row by id, or undefined if it is gone or no longer visible. Used to
 * repair the cache after a write is rejected, so an optimistic value that never
 * landed cannot linger on screen looking saved.
 */
export async function fetchRow(table: SyncedTable, id: string): Promise<DbRow | undefined> {
  const { data, error } = await supabase.from(table).select(selectColumns(table)).eq('id', id).maybeSingle()
  if (error) throw classify(error)
  return (data as unknown as DbRow) ?? undefined
}

/* ---------- rpc ---------- */

export async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw classify(error)
  return data as T
}

export interface Checksum {
  table_name: string
  live_rows: number
  max_updated_at: string | null
}

/**
 * Per-table row counts as the SERVER sees them for this user. Compared against
 * the cache after each delta pull; a mismatch means something was missed, and
 * that table is fully re-pulled. This is what turns "a row was silently skipped
 * and is gone forever" into "the cache heals itself within seconds".
 */
export const fetchChecksums = () => rpc<Checksum[]>('sync_checksums')

export const fetchBalances = () => rpc<{ account_id: string; balance_minor: number }[]>('account_balances')

export interface RemoteHousehold {
  id: string
  name: string
  join_code: string
  currency: string
  visibility_epoch: number
}

/** The household row, including the epoch that signals "your cache may be stale". */
export async function fetchHousehold(): Promise<RemoteHousehold | undefined> {
  const { data, error } = await supabase
    .from('households')
    .select('id,name,join_code,currency,visibility_epoch')
    .maybeSingle()
  if (error) throw classify(error)
  return (data as RemoteHousehold) ?? undefined
}
