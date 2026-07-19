import Dexie, { type EntityTable } from 'dexie'

/**
 * Amounts are integer minor units (pence/cents). Negative = money out.
 * All synced rows carry: `id` (uuid string), `updatedAt` (client ms, used for
 * last-write-wins), `dirty` (1 = has local changes not yet pushed) and
 * `deleted` (soft-delete tombstone so deletions sync too).
 */
export interface SyncedRow {
  id?: string
  updatedAt?: number
  dirty?: 0 | 1
  deleted?: 0 | 1
}

export interface Transaction extends SyncedRow {
  date: string // yyyy-MM-dd
  payee: string
  note?: string
  categoryId: string
  accountId?: string
  amountMinor: number
  importHash?: string
  billId?: string
  createdAt: number
}

export interface Category extends SyncedRow {
  name: string
  emoji: string
  slot: number // 1..8 -> --series-N color
  kind: 'expense' | 'income'
  sortOrder: number
}

export interface Budget extends SyncedRow {
  categoryId: string
  amountMinor: number // monthly budget, positive
}

export type BillFreq = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'yearly'

export interface Bill extends SyncedRow {
  name: string
  payee: string
  amountMinor: number // negative (outgoing)
  categoryId: string
  accountId?: string
  freq: BillFreq
  nextDue: string // yyyy-MM-dd
  active: 1 | 0
  autoPost: 1 | 0
}

export interface Rule extends SyncedRow {
  match: string // lowercased substring matched against payee
  categoryId: string
  createdAt: number
}

/**
 * Account visibility (enforced server-side by RLS on the `private` column):
 * - 'shared': account and its transactions sync to the whole household
 * - 'balance': partner sees the account and its balance, not its transactions
 * - 'private': partner never sees the account at all
 */
export type AccountVisibility = 'shared' | 'balance' | 'private'

export interface Account extends SyncedRow {
  name: string
  kind: 'current' | 'credit' | 'savings' | 'cash'
  visibility?: AccountVisibility // undefined = 'shared' (pre-privacy rows)
  ownerId?: string // auth user id of the creator; undefined = household-owned
  openingBalanceMinor?: number
  balanceMinor?: number // maintained by the owner's device, synced for display
}

/**
 * When an account becomes more private, a purge record tells every non-owner
 * device to drop its local copies of that account's transactions.
 */
export interface Purge extends SyncedRow {
  accountId: string
  ownerId: string
  createdAt: number
}

export interface KV {
  key: string
  value: string
}

export const SYNCED_TABLES = ['transactions', 'categories', 'budgets', 'bills', 'rules', 'accounts', 'purges'] as const
export type SyncedTable = (typeof SYNCED_TABLES)[number]

export const db = new Dexie('hearth-finance') as Dexie & {
  transactions: EntityTable<Transaction, 'id'>
  categories: EntityTable<Category, 'id'>
  budgets: EntityTable<Budget, 'id'>
  bills: EntityTable<Bill, 'id'>
  rules: EntityTable<Rule, 'id'>
  accounts: EntityTable<Account, 'id'>
  purges: EntityTable<Purge, 'id'>
  kv: EntityTable<KV, 'key'>
}

db.version(1).stores({
  transactions: '++id, date, categoryId, accountId, importHash, billId',
  categories: '++id, kind, sortOrder',
  budgets: '++id, &categoryId',
  bills: '++id, nextDue, active',
  rules: '++id, categoryId',
  accounts: '++id',
  kv: 'key',
})

// v2: drop the unique index on budgets.categoryId (sync upserts need plain puts)
db.version(2).stores({
  budgets: '++id, categoryId',
})

// v3: purge records for account-privacy changes
db.version(3).stores({
  purges: '++id, accountId',
})

export const newId = () => crypto.randomUUID()

export async function getSetting(key: string): Promise<string | undefined> {
  return (await db.kv.get(key))?.value
}

export async function setSetting(key: string, value: string) {
  await db.kv.put({ key, value })
}

export async function delSetting(key: string) {
  await db.kv.delete(key)
}

/**
 * One-time migration: rows created before sync support have auto-increment
 * numeric ids. Rewrite them (and every cross-reference) with uuid strings so
 * ids are globally unique across the household's devices.
 */
export async function migrateIdsToUuid() {
  if (await getSetting('uuidMigrated')) return
  await db.transaction('rw', [db.transactions, db.categories, db.budgets, db.bills, db.rules, db.accounts, db.kv], async () => {
    const now = Date.now()
    const remap = async (table: SyncedTable) => {
      const map = new Map<number, string>()
      const rows = await db.table(table).toArray()
      for (const row of rows) {
        if (typeof row.id !== 'number') continue
        const id = newId()
        map.set(row.id, id)
        await db.table(table).delete(row.id)
        await db.table(table).add({ ...row, id, updatedAt: now, dirty: 1 })
      }
      return map
    }
    const catMap = await remap('categories')
    const accMap = await remap('accounts')
    const billMap = await remap('bills')
    await remap('budgets')
    await remap('rules')
    await remap('transactions')
    const fixRef = (v: unknown, map: Map<number, string>) => (typeof v === 'number' ? map.get(v) : (v as string | undefined))
    await db.transactions.toCollection().modify((t) => {
      t.categoryId = fixRef(t.categoryId, catMap)!
      t.accountId = fixRef(t.accountId, accMap)
      t.billId = fixRef(t.billId, billMap)
    })
    await db.budgets.toCollection().modify((b) => {
      b.categoryId = fixRef(b.categoryId, catMap)!
    })
    await db.bills.toCollection().modify((b) => {
      b.categoryId = fixRef(b.categoryId, catMap)!
      b.accountId = fixRef(b.accountId, accMap)
    })
    await db.rules.toCollection().modify((r) => {
      r.categoryId = fixRef(r.categoryId, catMap)!
    })
    await db.kv.put({ key: 'uuidMigrated', value: '1' })
  })
}

const DEFAULT_CATEGORIES: Omit<Category, 'id'>[] = [
  { name: 'Groceries', emoji: '🛒', slot: 2, kind: 'expense', sortOrder: 0 },
  { name: 'Home & utilities', emoji: '🏠', slot: 5, kind: 'expense', sortOrder: 1 },
  { name: 'Transport', emoji: '🚗', slot: 1, kind: 'expense', sortOrder: 2 },
  { name: 'Dining out', emoji: '🍽️', slot: 8, kind: 'expense', sortOrder: 3 },
  { name: 'Shopping', emoji: '🛍️', slot: 7, kind: 'expense', sortOrder: 4 },
  { name: 'Subscriptions', emoji: '📺', slot: 6, kind: 'expense', sortOrder: 5 },
  { name: 'Health', emoji: '💊', slot: 4, kind: 'expense', sortOrder: 6 },
  { name: 'Fun & leisure', emoji: '🎉', slot: 3, kind: 'expense', sortOrder: 7 },
  { name: 'Other', emoji: '📦', slot: 1, kind: 'expense', sortOrder: 8 },
  { name: 'Salary', emoji: '💼', slot: 2, kind: 'income', sortOrder: 9 },
  { name: 'Other income', emoji: '💰', slot: 4, kind: 'income', sortOrder: 10 },
]

/** Seed default categories and account on first run. */
export async function ensureDefaults() {
  const now = Date.now()
  const count = await db.categories.count()
  if (count === 0) {
    await db.categories.bulkAdd(DEFAULT_CATEGORIES.map((c) => ({ ...c, id: newId(), updatedAt: now, dirty: 1 as const })))
  }
  const accounts = await db.accounts.count()
  if (accounts === 0) {
    await db.accounts.add({ id: newId(), name: 'Joint account', kind: 'current', updatedAt: now, dirty: 1 })
  }
}
