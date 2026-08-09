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
  /** Set on both legs of a transfer. Neither leg is spending or income. */
  transferId?: string
  /** Money paid into a savings goal — set on the incoming leg. */
  goalId?: string
  /**
   * "I paid for this out of my own account, but it was the household's."
   *
   * Counted as a contribution out of my book and as household spending in
   * theirs — the same row read two ways, which is the rule that already governs
   * a transfer crossing between books. See `classifyFlows`.
   */
  paidForHousehold?: boolean
  /**
   * Somebody who can see this row has asked whoever holds its other half to
   * explain it. Server-owned — `request_explanation` and `clear_explanation`
   * are the only writers — and meaningful only while the row is still unpaired:
   * linking answers the question without clearing the mark, so every reader
   * checks `transferId` first. See `lib/unexplained.ts`.
   */
  explainRequestedAt?: string
  explainRequestedBy?: string
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
  /**
   * Undefined on a subcategory means "inherit from my parent", so changing a
   * parent's colour carries to its children instead of them drifting apart.
   * Always set on a top-level category — resolve with `styleOf` in categories.ts
   * rather than reading these directly.
   */
  icon?: string // key into CATEGORY_ICONS
  slot?: number // 1..12 -> --series-N colour
  kind: 'expense' | 'income'
  sortOrder: number
  /** Set on a subcategory. Nesting stops at one level. */
  parentId?: string
  /** null = the household's; set = that person's own, usable only on their non-shared accounts. */
  ownerId?: string
  updatedAt: string
}

export interface Budget {
  id: string
  categoryId: string
  /** null/undefined = a household budget; set = that person's own, private to them. */
  ownerId?: string
  amountMinor: number // positive
  /**
   * The first of the month this budget applies to (yyyy-MM-01). A budget is a
   * fact about a particular month, which is what makes history — and therefore
   * suggestions and past adherence — possible at all.
   */
  month: string
  updatedAt: string
}

/**
 * A pot you save towards, as opposed to a ceiling that resets. Deliberately not
 * a budget: folding either into the other makes both harder to explain.
 */
export interface Goal {
  id: string
  name: string
  icon: string
  slot: number
  targetMinor: number
  targetDate?: string // yyyy-MM-dd
  /** null = the household's; set = that person's own. */
  ownerId?: string
  /** Optionally, the account the money actually sits in. */
  accountId?: string
  sortOrder: number
  createdBy?: string
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
 * @deprecated Migration 07 replaced this with per-person grants. The column
 * still exists and is pinned inert server-side so a write queued by an older
 * tab still matches a row instead of dead-lettering; migration 08 drops it.
 * Nothing may read it.
 */
export type AccountVisibility = 'shared' | 'balance' | 'private'

export interface Account {
  id: string
  name: string
  kind: 'current' | 'credit' | 'savings' | 'cash'
  /** @deprecated 07 — see AccountVisibility. Optional: the server pins it. */
  visibility?: AccountVisibility
  /** @deprecated 07 — ownership is an `owner` grant in account_grants. */
  ownerId?: string
  openingBalanceMinor: number
  /**
   * Which book this account is in, when deriving it from grants gets it wrong.
   * Undefined — the normal case — means derive. See `classifyAccounts`.
   */
  bookOverride?: 'household' | 'mine'
  sortOrder: number
  createdBy?: string
  updatedAt: string
}

/**
 * What one person may do with one account, lowest to highest.
 *
 * Mirrors `public.access_level` in supabase/07-permissions.sql, which is an
 * ORDERED enum — `level >= 'contribute'` is a native comparison there, and
 * `atLeast()` in lib/accounts.ts is the same comparison here.
 *
 *  - balance    — sees the account and what it holds, not what it was spent on
 *  - view       — sees everything on it, changes nothing
 *  - contribute — adds transactions, and edits or removes the ones they added
 *  - manage     — adds, edits and removes anything on it, but cannot re-share it
 *  - owner      — all of that, plus deciding who else can see it
 */
export type AccessLevel = 'balance' | 'view' | 'contribute' | 'manage' | 'owner'

/**
 * `none` is never stored — the absence of a grant is what no access means. It
 * exists so the revoke path has something to send, and so `levelOn()` can
 * answer for an account you hold nothing on.
 */
export type GrantLevel = AccessLevel | 'none'

export type MemberRole = 'member' | 'admin'

/**
 * Somebody in your household. A projection of `profiles`, maintained by a
 * trigger server-side, so the client has one syncable table with a tombstone
 * rather than having to read profiles it may not be allowed to see.
 */
export interface HouseholdMember {
  id: string
  userId: string
  displayName?: string
  /** Optional, and a downscaled data URL rather than a link — see 08-profiles.sql. */
  avatarUrl?: string
  role: MemberRole
  joinedAt: string
  updatedAt: string
}

/** One person's access to one account. Written only by RPC. */
export interface AccountGrant {
  id: string
  accountId: string
  userId: string
  level: AccessLevel
  grantedBy?: string
  updatedAt: string
}

/**
 * Balances for accounts whose transactions this device cannot see (one held at
 * `balance` level). Read from the server's `account_balances()` function,
 * which sums the rows RLS hides from us. For accounts we CAN see in full the
 * balance is computed locally instead, so optimistic edits show up immediately.
 */
export interface CachedBalance {
  accountId: string
  balanceMinor: number
  fetchedAt: number
}

/**
 * Parents before children: a full pull applies them in this order, so a
 * transaction is never written before the account it belongs to.
 *
 * The two snake_case names are deliberate. A `SyncedTable` value is used
 * verbatim as the PostgREST table name, the Dexie store name and the
 * `sync_checksums()` key; mapping.ts converts *columns* between cases, never
 * table names. `household_members` comes first because a name is needed to
 * render anything about a person, and `account_grants` after `accounts`
 * because it points at them.
 */
export const SYNCED_TABLES = [
  'household_members',
  'categories',
  'accounts',
  'account_grants',
  'goals',
  'bills',
  'transactions',
  'budgets',
  'rules',
] as const
export type SyncedTable = (typeof SYNCED_TABLES)[number]

export interface TableRowMap {
  household_members: HouseholdMember
  categories: Category
  accounts: Account
  account_grants: AccountGrant
  goals: Goal
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
  goals: EntityTable<Goal, 'id'>
  household_members: EntityTable<HouseholdMember, 'id'>
  account_grants: EntityTable<AccountGrant, 'id'>
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

// v2 adds goals and the indexes the new columns need. Dexie keeps the existing
// rows; anything missing is filled in by the next pull, and a version bump is
// cheap because the cache is derived rather than authoritative.
db.version(2).stores({
  transactions: 'id, date, categoryId, accountId, importHash, billId, transferId, goalId, updatedAt',
  categories: 'id, kind, sortOrder, parentId, updatedAt',
  budgets: 'id, categoryId, month, [categoryId+month], updatedAt',
  goals: 'id, sortOrder, updatedAt',
})

// v3 adds the two tables migration 07 introduced. `[accountId+userId]` is the
// lookup the permissions UI does per row; `userId` on its own answers "what may
// I do here", which every account picker in the app asks.
db.version(3).stores({
  household_members: 'id, userId, updatedAt',
  account_grants: 'id, accountId, userId, [accountId+userId], updatedAt',
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

/**
 * Wipe every cached row, keeping the outbox and device settings intact.
 *
 * Derived from SYNCED_TABLES rather than listing the tables by hand. The hand
 * written version was a standing trap: a table left out of it survives an epoch
 * bump as stale rows, and nothing type-checks the omission.
 */
export async function clearCache() {
  const tables = [...SYNCED_TABLES.map((t) => db.table(t)), db.balances]
  await db.transaction('rw', tables, async () => {
    await Promise.all(tables.map((t) => t.clear()))
  })
}

/** Sign-out / leave-household: everything goes, including pending writes. */
export async function clearEverything() {
  await clearCache()
  await db.outbox.clear()
  await db.deadLetters.clear()
  await db.meta.clear()
}
