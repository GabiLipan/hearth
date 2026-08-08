import type { SyncedTable } from './db'

/**
 * Translation between the app's camelCase rows and Postgres' snake_case
 * columns.
 *
 * The subtlety that matters here is `undefined` vs `null`. In a field-level
 * update, a key that is ABSENT means "leave this alone" and a key set to NULL
 * means "clear it". JavaScript conflates the two: `{ note: undefined }` and
 * `{}` look nearly identical, so a naive converter that drops undefined values
 * would turn "clear the note" into a silent no-op. So:
 *
 *   - a key not present in a patch is not sent
 *   - a key present with value `undefined` is sent as `null`
 *
 * which means patches must be built by listing the keys that changed, and
 * clearing a field is `{ note: undefined }` rather than omitting it.
 */

const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

// The one column whose name is not a mechanical conversion. `date` is too
// generic for a SQL column and shadows the type name; `occurred_on` is clearer
// server-side. Keeping the client field as `date` avoids churning every page.
const TO_DB: Record<string, string> = { date: 'occurred_on' }
const FROM_DB: Record<string, string> = { occurred_on: 'date' }

const dbName = (k: string) => TO_DB[k] ?? camelToSnake(k)
const appName = (k: string) => FROM_DB[k] ?? snakeToCamel(k)

/**
 * Columns a client is allowed to write, per table. An explicit allow-list
 * rather than "convert whatever the caller passed": `household_id`,
 * `owner_id` on non-account rows, `created_by`, `created_at`, `updated_at` and
 * `deleted_at` are all stamped by triggers, and a client that sent them would
 * either be ignored or rejected. Keeping the list here means a typo'd field
 * name fails loudly at the boundary instead of being posted and dropped.
 */
const WRITABLE: Record<SyncedTable, readonly string[]> = {
  // Read-only on the client: membership is a projection of `profiles`, written
  // by a trigger. An empty allow-list makes patchToDb throw at the boundary
  // rather than posting something the server would refuse.
  household_members: [],
  categories: ['id', 'name', 'icon', 'slot', 'kind', 'sortOrder', 'parentId', 'ownerId'],
  // `visibility` and `ownerId` are deprecated by 07 and pinned inert on the
  // server. They stay writable for one release so a patch queued by an older
  // tab still matches a row and drains, instead of dead-lettering; 08 removes
  // them from here and from the table.
  accounts: ['id', 'name', 'kind', 'visibility', 'ownerId', 'openingBalanceMinor', 'sortOrder', 'bookOverride'],
  // Written by upsert_account_grant, so the whole row is the RPC's argument
  // list — see RPC_TABLES in outbox.ts.
  account_grants: ['id', 'accountId', 'userId', 'level'],
  goals: ['id', 'name', 'icon', 'slot', 'targetMinor', 'targetDate', 'ownerId', 'accountId', 'sortOrder'],
  bills: ['id', 'name', 'payee', 'amountMinor', 'categoryId', 'accountId', 'freq', 'nextDue', 'active', 'autoPost'],
  // transferId and goalId are set by create_transfer server-side, never posted
  // directly — a client that could write transferId could fabricate half a transfer.
  transactions: ['id', 'accountId', 'categoryId', 'billId', 'date', 'payee', 'note', 'amountMinor', 'importHash', 'paidForHousehold'],
  budgets: ['id', 'categoryId', 'ownerId', 'amountMinor', 'month'],
  rules: ['id', 'match', 'categoryId'],
} as const

/** Columns to request when pulling. Explicit, so adding a server column does not silently change payload size. */
const READABLE: Record<SyncedTable, readonly string[]> = {
  household_members: ['id', 'userId', 'displayName', 'avatarUrl', 'role', 'joinedAt', 'updatedAt', 'deletedAt'],
  categories: [...WRITABLE.categories, 'updatedAt', 'deletedAt'],
  account_grants: [...WRITABLE.account_grants, 'grantedBy', 'updatedAt', 'deletedAt'],
  accounts: [...WRITABLE.accounts, 'createdBy', 'updatedAt', 'deletedAt'],
  goals: [...WRITABLE.goals, 'createdBy', 'updatedAt', 'deletedAt'],
  bills: [...WRITABLE.bills, 'createdBy', 'updatedAt', 'deletedAt'],
  transactions: [...WRITABLE.transactions, 'transferId', 'goalId', 'createdBy', 'createdAt', 'updatedAt', 'deletedAt'],
  budgets: [...WRITABLE.budgets, 'updatedAt', 'deletedAt'],
  rules: [...WRITABLE.rules, 'createdBy', 'createdAt', 'updatedAt', 'deletedAt'],
} as const

/** The `select=` list for a pull, e.g. `id,account_id,occurred_on,...`. */
export function selectColumns(table: SyncedTable): string {
  return READABLE[table].map(dbName).join(',')
}

export interface DbRow {
  id: string
  updated_at: string
  deleted_at: string | null
  [key: string]: unknown
}

/** A server row as the app wants it: camelCase, nulls collapsed to undefined. */
export function fromDb<T>(row: DbRow): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (k === 'deleted_at') continue // tombstones are handled by the caller, never stored
    out[appName(k)] = v === null ? undefined : v
  }
  return out as T
}

function convert(table: SyncedTable, input: Record<string, unknown>, keys: readonly string[]) {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (!WRITABLE[table].includes(k)) {
      throw new Error(`${table}.${k} is not a client-writable column`)
    }
    const v = input[k]
    // Present-but-undefined means "clear it", which on the wire is null.
    out[dbName(k)] = v === undefined ? null : v
  }
  return out
}

/** A whole row for an insert. Every writable column is sent, so omissions become explicit nulls. */
export function insertToDb(table: SyncedTable, row: Record<string, unknown>): Record<string, unknown> {
  const keys = WRITABLE[table].filter((k) => k in row)
  return convert(table, row, keys)
}

/**
 * A partial row for a field-level update. Only the keys actually present are
 * sent, so two devices changing different fields of the same row both survive.
 */
export function patchToDb(table: SyncedTable, patch: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(patch).filter((k) => k !== 'id')
  return convert(table, patch, keys)
}

/**
 * The changed fields between two versions of a row, as a patch. Keys whose
 * value became undefined are kept (they mean "clear"), which is exactly the
 * distinction `patchToDb` relies on.
 */
export function diffToPatch<T extends object>(before: T, after: T): Partial<T> {
  const patch: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = (before as Record<string, unknown>)[k]
    const b = (after as Record<string, unknown>)[k]
    if (a !== b) patch[k] = b
  }
  return patch as Partial<T>
}
