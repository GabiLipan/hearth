import { db, newId, type SyncedTable, type SyncedRow } from './db'

/**
 * Every mutation of synced tables goes through these helpers so rows always
 * get an id, a fresh `updatedAt` and the `dirty` flag, and the sync engine is
 * poked afterwards. Reads stay plain Dexie (filter `notDeleted` in queries).
 */

let onLocalChange: (() => void) | undefined

export function setOnLocalChange(fn: () => void) {
  onLocalChange = fn
}

function poke() {
  onLocalChange?.()
}

export const notDeleted = <T extends SyncedRow>(row: T) => !row.deleted

export async function createRow<T extends SyncedRow>(table: SyncedTable, row: T): Promise<string> {
  const id = row.id ?? newId()
  await db.table(table).put({ ...row, id, updatedAt: Date.now(), dirty: 1 })
  poke()
  return id
}

export async function createMany<T extends SyncedRow>(table: SyncedTable, rows: T[]) {
  const now = Date.now()
  await db.table(table).bulkPut(rows.map((r) => ({ ...r, id: r.id ?? newId(), updatedAt: now, dirty: 1 })))
  poke()
}

export async function updateRow(table: SyncedTable, id: string, changes: object) {
  await db.table(table).update(id, { ...changes, updatedAt: Date.now(), dirty: 1 })
  poke()
}

/** Soft delete: tombstone the row so the deletion syncs to other devices. */
export async function removeRow(table: SyncedTable, id: string) {
  await db.table(table).update(id, { deleted: 1, updatedAt: Date.now(), dirty: 1 })
  poke()
}
