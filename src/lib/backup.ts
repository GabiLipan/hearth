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

/** Full-household JSON snapshot. */
export async function exportJSON(): Promise<string> {
  const dump: Record<string, unknown[]> = {}
  for (const name of SYNCED_TABLES) {
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

  // Parents before children, so a transaction is never queued ahead of the
  // account it belongs to.
  const order: SyncedTable[] = ['categories', 'accounts', 'bills', 'transactions', 'budgets', 'rules']
  for (const name of order) {
    const rows = parsed.data[name]
    if (!Array.isArray(rows) || !rows.length) continue
    await createMany(name, rows)
  }
}

/**
 * Delete everything in the household.
 *
 * Done server-side so it is one atomic operation that the other device learns
 * about through ordinary tombstones. The RPC re-seeds the starter categories
 * and account afterwards, because a transaction cannot be recorded without an
 * account and a wipe that removed the last one would brick the add form.
 */
export async function clearAllData() {
  await rpc('wipe_household')
  await fullPull()
}
