import { db, newId, rowKey, type SyncedTable, type TableRowMap } from './db'
import { enqueue } from './outbox'

/**
 * Every change the user makes goes through here.
 *
 * Each call does two things in one Dexie transaction: update the cache so the
 * screen reacts instantly, and append a write to the outbox so the server finds
 * out. Neither half is optional — a cache write with no queued mutation is a
 * change that silently never saves, and a queued mutation with no cache write
 * is a UI that appears to ignore the user for a second.
 *
 * There is no `dirty` flag and no `deleted` flag. Whether a row has unsent
 * changes is a question about the outbox, and a deleted row is simply not in
 * the cache. The old design tracked both on the row itself and they could
 * disagree with each other.
 */

/**
 * Foreign keys per table, used to record what each queued write depends on. If
 * creating a category fails, the transactions referencing it must be
 * quarantined rather than each failing separately against a row that will never
 * exist.
 */
const FOREIGN_KEYS: Record<SyncedTable, Record<string, SyncedTable>> = {
  transactions: { accountId: 'accounts', categoryId: 'categories', billId: 'bills' },
  bills: { accountId: 'accounts', categoryId: 'categories' },
  budgets: { categoryId: 'categories' },
  rules: { categoryId: 'categories' },
  accounts: {},
  categories: {},
}

/**
 * Tables written through an RPC rather than plain PostgREST, because their
 * uniqueness rule is a partial or expression index that `on_conflict` cannot
 * name. Their queued payload is always the WHOLE row, since the RPC needs every
 * argument to resolve the conflict — not just what changed.
 */
const RPC_TABLES: ReadonlySet<SyncedTable> = new Set(['budgets', 'rules'])

function refsFor(table: SyncedTable, row: Record<string, unknown>): string[] {
  return Object.entries(FOREIGN_KEYS[table])
    .filter(([field]) => typeof row[field] === 'string')
    .map(([field, target]) => rowKey(target, row[field] as string))
}

/** Placeholder until the server's real timestamp arrives on the next pull. */
const provisionalTimestamp = () => new Date().toISOString()

/** A row as callers supply it: no server-assigned timestamp, and an optional id. */
type NewRow<T extends SyncedTable> = Omit<TableRowMap[T], 'updatedAt' | 'id'> & { id?: string }

export async function create<T extends SyncedTable>(table: T, row: NewRow<T>): Promise<string> {
  const id = row.id ?? newId()
  const cached = { ...row, id, updatedAt: provisionalTimestamp() }

  await db.table(table).put(cached)
  await enqueue({
    table,
    op: 'insert',
    rowId: id,
    payload: stripLocal(cached),
    refs: refsFor(table, cached as Record<string, unknown>),
  })
  return id
}

export async function createMany<T extends SyncedTable>(table: T, rows: NewRow<T>[]): Promise<string[]> {
  const now = provisionalTimestamp()
  const prepared = rows.map((r) => ({ ...r, id: r.id ?? newId(), updatedAt: now }))
  await db.table(table).bulkPut(prepared)
  // Enqueued individually so one bad row can be isolated and dead-lettered on
  // its own; the outbox re-batches consecutive inserts into single requests.
  for (const row of prepared) {
    await enqueue({
      table,
      op: 'insert',
      rowId: row.id,
      payload: stripLocal(row),
      refs: refsFor(table, row as Record<string, unknown>),
    })
  }
  return prepared.map((r) => r.id)
}

/**
 * Change some fields of a row.
 *
 * Only the fields named here are sent, which is what lets two people edit
 * different parts of the same transaction at the same time without one
 * overwriting the other. To CLEAR a field, pass it explicitly as `undefined` —
 * omitting it means "leave it alone" (see mapping.ts).
 */
export async function update<T extends SyncedTable>(table: T, id: string, changes: Partial<TableRowMap[T]>) {
  const existing = await db.table(table).get(id)
  if (!existing) return
  const next = { ...existing, ...changes, updatedAt: provisionalTimestamp() }
  await db.table(table).put(next)

  await enqueue({
    table,
    op: 'update',
    rowId: id,
    // An RPC-backed table needs the full row to resolve its own conflict; a
    // plain one sends only what changed.
    payload: RPC_TABLES.has(table) ? stripLocal(next) : stripLocal(changes as Record<string, unknown>),
    refs: refsFor(table, next as Record<string, unknown>),
  })
}

export async function remove(table: SyncedTable, id: string) {
  const existing = (await db.table(table).get(id)) as Record<string, unknown> | undefined
  await db.table(table).delete(id)
  await enqueue({
    table,
    op: 'delete',
    rowId: id,
    // Removing a budget is an upsert with a null amount, so its RPC still needs
    // to know which category and scope it belonged to.
    payload: RPC_TABLES.has(table) && existing ? stripLocal(existing) : {},
    refs: [],
  })
}

/** Fields that live only in the cache and must never be sent to the server. */
function stripLocal(row: Record<string, unknown>): Record<string, unknown> {
  const { updatedAt: _u, createdAt: _c, createdBy: _b, ...rest } = row
  return rest
}
