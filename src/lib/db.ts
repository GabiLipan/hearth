import Dexie, { type EntityTable } from 'dexie'

/**
 * The local cache.
 *
 * This is NOT the source of truth — Supabase is. Everything in the entity
 * tables below is a mirror of rows the server has confirmed, kept so the app
 * paints instantly and still works with no signal. Anything the user changes
 * is applied here optimistically *and* written to `outbox`, which is the only
 * thing that is genuinely local state.
 *
 * Consequences worth knowing before changing anything here:
 *
 *  - **The cache holds live rows only.** A delete removes the row outright.
 *    Tombstones exist on the server (so the other device learns about the
 *    deletion) but they are never stored here, which is why no query in the app
 *    filters on a `deleted` flag any more — and why the Dexie indexes below are
 *    actually usable rather than degrading into full scans.
 *  - **There is no `dirty` flag.** Whether a row has unsent changes is answered
 *    by the outbox, not by a bit on the row. The old design had both and they
 *    could disagree.
 *  - **`updatedAt` is the server's timestamp**, an ISO string exactly as
 *    PostgREST emitted it. Never round-trip it through `new Date()`: PostgREST
 *    emits microseconds and JS truncates to milliseconds, and the pull cursor
 *    is compared as a string.
 *  - **The cache does not enforce foreign keys.** A transaction can arrive
 *    before the category it points at, so `categoryId` may dangle; the UI
 *    renders that as "Uncategorised" rather than crashing.
 *
 * Amounts are integer minor units (pence). Negative = money out.
 */

export interface Transaction {
  id: string
  accountId: string
  categoryId?: string
  billId?: string
  date: string // yyyy-MM-dd (server column `occurred_on`)
  payee: string
  note?: string
  amountMinor: number
  /** `date|amount|payee` fingerprint feeding the import wizard's duplicate check. */
  importHash?: string
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export interface Category {
  id: string
  name: string
  icon: string // key into CATEGORY_ICONS
  slot: number // 1..8 -> --series-N colour
  kind: 'expense' | 'income'
  sortOrder: number
  updatedAt: string
}

export interface Budget {
  id: string
  categoryId: string
  /** null/undefined = a household budget; set = that person's own, private to them. */
  ownerId?: string
  amountMinor: number // positive, monthly
  updatedAt: string
}

export type BillFreq = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'yearly'

export interface Bill {
  id: string
  name: string
  payee: string
  amountMinor: number // negative (outgoing)
  categoryId?: string
  accountId: string
  freq: BillFreq
  nextDue: string // yyyy-MM-dd
  active: boolean
  autoPost: boolean
  createdBy?: string
  updatedAt: string
}

export interface Rule {
  id: string
  match: string // normalised lowercase payee substring
  categoryId: string
  createdBy?: string
  createdAt: string
  updatedAt: string
}

/**
 * Account visibility, enforced by RLS on the server (see supabase/02-rls.sql):
 *  - 'shared'  — partner sees the account and every transaction on it
 *  - 'balance' — partner sees the account and its total, but no line items
 *  - 'private' — partner sees nothing at all
 */
export type AccountVisibility = 'shared' | 'balance' | 'private'

export interface Account {
  id: string
  name: string
  kind: 'current' | 'credit' | 'savings' | 'cash'
  visibility: AccountVisibility
  ownerId?: string
  openingBalanceMinor: number
  sortOrder: number
  createdBy?: string
  updatedAt: string
}

/**
 * Balances for accounts whose transactions this device cannot see (a partner's
 * 'balance'-tier account). Read from the server's `account_balances()` function,
 * which sums the rows RLS hides from us. For accounts we CAN see in full the
 * balance is computed locally instead, so optimistic edits show up immediately.
 */
export interface CachedBalance {
  accountId: string
  balanceMinor: number
  fetchedAt: number
}

export const SYNCED_TABLES = ['categories', 'accounts', 'bills', 'transactions', 'budgets', 'rules'] as const
export type SyncedTable = (typeof SYNCED_TABLES)[number]

export interface TableRowMap {
  categories: Category
  accounts: Account
  bills: Bill
  transactions: Transaction
  budgets: Budget
  rules: Rule
}

/* ---------- outbox ---------- */

export type OutboxOp = 'insert' | 'update' | 'delete'
export type OutboxStatus = 'pending' | 'blocked'

/**
 * One pending write. Flushed strictly in `seq` order, which is also what
 * guarantees a category is created before the transaction that references it.
 *
 * `payload` is the whole row for an insert and ONLY the changed fields for an
 * update — that field-level granularity is what stops two people editing
 * different fields of the same transaction from overwriting each other.
 */
export interface OutboxEntry {
  seq?: number
  table: SyncedTable
  op: OutboxOp
  rowId: string
  /** `${table}:${rowId}` — the key later entries name in `refs`. */
  rowKey: string
  payload: Record<string, unknown>
  /** rowKeys this entry depends on, so a failure can quarantine its dependants. */
  refs: string[]
  createdAt: number
  attempts: number
  /** Epoch ms; the flush skips entries backing off after a transient failure. */
  nextAttemptAt: number
  status: OutboxStatus
  lastError?: string
}

/**
 * A write the server refused for a reason retrying cannot fix — a foreign key
 * that no longer exists, an RLS denial, an update matching zero rows. Kept so
 * the user is told rather than silently losing the change, and so the
 * optimistic row it created can be rolled back.
 */
export interface DeadLetter {
  id: string
  table: SyncedTable
  op: OutboxOp
  rowId: string
  payload: Record<string, unknown>
  /** Plain English, e.g. "Tesco, £12.40, 3 Mar" — shown in Settings. */
  summary: string
  code?: string
  message: string
  failedAt: number
}

export interface Meta {
  key: string
  value: string
}

export const db = new Dexie('hearth') as Dexie & {
  transactions: EntityTable<Transaction, 'id'>
  categories: EntityTable<Category, 'id'>
  budgets: EntityTable<Budget, 'id'>
  bills: EntityTable<Bill, 'id'>
  rules: EntityTable<Rule, 'id'>
  accounts: EntityTable<Account, 'id'>
  balances: EntityTable<CachedBalance, 'accountId'>
  outbox: EntityTable<OutboxEntry, 'seq'>
  deadLetters: EntityTable<DeadLetter, 'id'>
  meta: EntityTable<Meta, 'key'>
}

// A new database name, not a migration: the old `hearth-finance` store held
// rows keyed by ids that no longer mean anything (`def-groceries`, numeric
// auto-increments) and carried `dirty`/`deleted` flags this design does not
// have. It is abandoned rather than converted, and the server is re-pulled.
db.version(1).stores({
  transactions: 'id, date, categoryId, accountId, importHash, billId, updatedAt',
  categories: 'id, kind, sortOrder, updatedAt',
  budgets: 'id, categoryId, updatedAt',
  bills: 'id, nextDue, active, updatedAt',
  rules: 'id, match, categoryId, updatedAt',
  accounts: 'id, sortOrder, updatedAt',
  balances: 'accountId',
  outbox: '++seq, rowKey, status, table',
  deadLetters: 'id, failedAt',
  meta: 'key',
})

export const newId = () => crypto.randomUUID()

export const rowKey = (table: SyncedTable, id: string) => `${table}:${id}`

/* ---------- device-local settings ---------- */
//
// These never sync. Theme and the dashboard layout are properties of *this*
// screen, not of the household — the old design synced neither but exported
// both, which is how one device's sync cursor could be restored onto another.

export async function getSetting(key: string): Promise<string | undefined> {
  return (await db.meta.get(key))?.value
}

export async function setSetting(key: string, value: string) {
  await db.meta.put({ key, value })
}

export async function delSetting(key: string) {
  await db.meta.delete(key)
}

/** Wipe every cached row, keeping the outbox and device settings intact. */
export async function clearCache() {
  await db.transaction('rw', [db.transactions, db.categories, db.budgets, db.bills, db.rules, db.accounts, db.balances], async () => {
    await Promise.all([
      db.transactions.clear(),
      db.categories.clear(),
      db.budgets.clear(),
      db.bills.clear(),
      db.rules.clear(),
      db.accounts.clear(),
      db.balances.clear(),
    ])
  })
}

/** Sign-out / leave-household: everything goes, including pending writes. */
export async function clearEverything() {
  await clearCache()
  await db.outbox.clear()
  await db.deadLetters.clear()
  await db.meta.clear()
}
