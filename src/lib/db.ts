import Dexie, { type EntityTable } from 'dexie'

/** Amounts are integer minor units (pence/cents). Negative = money out. */
export interface Transaction {
  id?: number
  date: string // yyyy-MM-dd
  payee: string
  note?: string
  categoryId: number
  accountId?: number
  amountMinor: number
  importHash?: string
  billId?: number
  createdAt: number
}

export interface Category {
  id?: number
  name: string
  emoji: string
  slot: number // 1..8 -> --series-N color
  kind: 'expense' | 'income'
  sortOrder: number
}

export interface Budget {
  id?: number
  categoryId: number
  amountMinor: number // monthly budget, positive
}

export type BillFreq = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'yearly'

export interface Bill {
  id?: number
  name: string
  payee: string
  amountMinor: number // negative (outgoing)
  categoryId: number
  accountId?: number
  freq: BillFreq
  nextDue: string // yyyy-MM-dd
  active: 1 | 0
  autoPost: 1 | 0
}

export interface Rule {
  id?: number
  match: string // lowercased substring matched against payee
  categoryId: number
  createdAt: number
}

export interface Account {
  id?: number
  name: string
  kind: 'current' | 'credit' | 'savings' | 'cash'
}

export interface KV {
  key: string
  value: string
}

export const db = new Dexie('hearth-finance') as Dexie & {
  transactions: EntityTable<Transaction, 'id'>
  categories: EntityTable<Category, 'id'>
  budgets: EntityTable<Budget, 'id'>
  bills: EntityTable<Bill, 'id'>
  rules: EntityTable<Rule, 'id'>
  accounts: EntityTable<Account, 'id'>
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
  const count = await db.categories.count()
  if (count === 0) {
    await db.categories.bulkAdd(DEFAULT_CATEGORIES)
  }
  const accounts = await db.accounts.count()
  if (accounts === 0) {
    await db.accounts.add({ name: 'Joint account', kind: 'current' })
  }
}

export async function getSetting(key: string): Promise<string | undefined> {
  return (await db.kv.get(key))?.value
}

export async function setSetting(key: string, value: string) {
  await db.kv.put({ key, value })
}
