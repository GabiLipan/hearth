import { db, SYNCED_TABLES, type SyncedTable } from './db'
import { createMany } from './data'
import { rpc } from './api'
import { fullPull } from './pull'

/**
 * Backup and restore.
 *
 * A snapshot is a convenience, not the sync mechanism it used to double as.
 * Notably it no longer includes the key-value table: that used to carry the
 * household id and the sync cursor, so restoring one device's backup onto
 * another transplanted its sync state along with the data.
 */

/**
 * Tables a backup deliberately leaves out.
 *
 * Both describe PEOPLE rather than money. A grant names a user id that means
 * nothing in anybody else's household, and the membership list is a projection
 * the server maintains — restoring either would at best dead-letter and at
 * worst hand somebody a stale claim on an account. Restoring a backup gives you
 * your accounts back; who they are shared with is decided fresh.
 */
const NOT_BACKED_UP: readonly SyncedTable[] = ['household_members', 'account_grants']
const backupTables = () => SYNCED_TABLES.filter((t) => !NOT_BACKED_UP.includes(t))

/** Full-household JSON snapshot. */
export async function exportJSON(): Promise<string> {
  const dump: Record<string, unknown[]> = {}
  for (const name of backupTables()) {
    dump[name] = await db.table(name).toArray()
  }
  return JSON.stringify({ app: 'hearth', version: 2, exportedAt: new Date().toISOString(), data: dump }, null, 2)
}

export function downloadJSON(json: string) {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `hearth-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Add a snapshot's contents to the current household.
 *
 * This adds rather than replaces, and it goes through the normal write path so
 * every row is queued for the server like any other change. Restoring straight
 * into the cache would produce rows the server has never heard of, which the
 * next reconcile would notice as a count mismatch and quietly delete again.
 *
 * Ids are preserved, so re-importing the same file twice is a no-op rather than
 * a second copy of everything.
 */
export async function importJSON(text: string) {
  const parsed = JSON.parse(text)
  if (parsed?.app !== 'hearth' || !parsed.data) throw new Error('Not a Hearth backup file')

  // SYNCED_TABLES, not a second hand-written list. The list here used to omit
  // `goals` while `exportJSON` wrote them from SYNCED_TABLES, so a backup
  // round-trip silently dropped every goal. Deriving both from one source is
  // what stops the two drifting apart again — and SYNCED_TABLES is already
  // ordered parents-before-children, so a transaction is never queued ahead of
  // the account it belongs to.
  for (const name of backupTables()) {
    const rows = parsed.data[name]
    if (!Array.isArray(rows) || !rows.length) continue
    await createMany(name, name === 'budgets' ? rows.map(withMonth) : rows)
  }
}

/**
 * A budget from a backup taken before migration 04 has no `month`.
 *
 * Left alone it reaches the outbox without one, which makes `upsert_budget`
 * resolve to a four-argument overload that no longer exists — so the restore
 * appears to work and then produces a pile of "could not find the function"
 * dead letters. Defaulting to the current month is a guess, but it is the same
 * guess migration 04 made when it backfilled the column, and a budget in the
 * wrong month is far easier to notice and fix than a rejected write.
 */
function withMonth(row: unknown): Record<string, unknown> {
  const b = row as Record<string, unknown>
  if (typeof b.month === 'string' && b.month) return b
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  return { ...b, month }
}

/**
 * Delete everything this person is entitled to delete.
 *
 * "Everything" is the shared household data — which both people own jointly, so
 * either may erase it — plus whatever is private to the caller. It is NOT the
 * partner's private accounts, their transactions, or their personal categories,
 * budgets and goals. `wipe_household()` used to take those too: it is
 * `security definer`, which switches RLS off, and it filtered on nothing but the
 * household id. See supabase/05-ownership-and-deletes.sql.
 *
 * Done server-side so it is one atomic operation that the other device learns
 * about through ordinary tombstones. The RPC re-seeds the starter categories and
 * account afterwards, because a transaction cannot be recorded without an
 * account and a wipe that removed the last one would brick the add form.
 */
export async function clearAllData() {
  await rpc('wipe_household')
  await fullPull()
}
