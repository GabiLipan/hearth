import { describe, expect, it } from 'vitest'
import type { Category, Transaction } from './db'
import { budgetCategoryId, fullName, grouped, styleOf, usableOn } from './categories'
import { monthlySpendByCategory, monthTotals, typicalSpend } from './stats'

const cat = (over: Partial<Category> & { id: string; name: string }): Category => ({
  kind: 'expense',
  sortOrder: 0,
  updatedAt: 'x',
  ...over,
})

const home = cat({ id: 'home', name: 'Home & utilities', icon: 'home', slot: 5, sortOrder: 0 })
const insurance = cat({ id: 'ins', name: 'Insurance', parentId: 'home' })
const groceries = cat({ id: 'groc', name: 'Groceries', icon: 'cart', slot: 2, sortOrder: 1 })
const byId = new Map([home, insurance, groceries].map((c) => [c.id, c]))

describe('inherited style', () => {
  it('takes the parent’s icon and colour when it has none of its own', () => {
    // Storing nothing rather than copying is what keeps a parent and its
    // children looking like a set when the parent's colour later changes.
    expect(styleOf(insurance, byId)).toEqual({ icon: 'home', slot: 5 })
  })

  it('keeps its own when overridden', () => {
    const override = cat({ id: 'ins2', name: 'Insurance', parentId: 'home', icon: 'shirt', slot: 7 })
    expect(styleOf(override, new Map([...byId, [override.id, override]]))).toEqual({ icon: 'shirt', slot: 7 })
  })

  it('falls back to something drawable when the parent has not arrived yet', () => {
    // The cache does not enforce foreign keys, so a child can be pulled first.
    const orphan = cat({ id: 'x', name: 'Orphan', parentId: 'missing' })
    expect(styleOf(orphan, byId)).toEqual({ icon: 'tag', slot: 1 })
  })
})

describe('roll-up', () => {
  it('counts a subcategory towards its parent', () => {
    expect(budgetCategoryId(insurance)).toBe('home')
  })

  it('counts a top-level category towards itself', () => {
    expect(budgetCategoryId(groceries)).toBe('groc')
  })

  it('names a subcategory with its parent for context', () => {
    expect(fullName(insurance, byId)).toBe('Home & utilities · Insurance')
    expect(fullName(groceries, byId)).toBe('Groceries')
  })

  it('lists parents in sort order, each followed by their own children', () => {
    // Deliberately passed out of order: the listing follows sortOrder, not the
    // order rows happen to arrive from the cache.
    const groups = grouped([insurance, groceries, home])
    expect(groups.map((g) => g.parent.id)).toEqual(['home', 'groc'])
    expect(groups[0].children.map((c) => c.id)).toEqual(['ins'])
  })
})

describe('personal categories', () => {
  const mine = cat({ id: 'p', name: 'Therapy', icon: 'health', slot: 4, ownerId: 'me' })
  const all = [groceries, mine]
  // Since migration 07 "private" means one thing: nobody else holds a grant.
  const onlyMine = [{ userId: 'me' }]
  const sharedWithThem = [{ userId: 'me' }, { userId: 'them' }]
  const onlyTheirs = [{ userId: 'them' }]

  it('offers a personal category on an account nobody else shares', () => {
    expect(usableOn(all, onlyMine, 'me').map((c) => c.id)).toEqual(['groc', 'p'])
  })

  it('hides it as soon as somebody else can see the account', () => {
    expect(usableOn(all, sharedWithThem, 'me').map((c) => c.id)).toEqual(['groc'])
  })

  it('hides someone else’s personal category everywhere', () => {
    expect(usableOn(all, onlyTheirs, 'me').map((c) => c.id)).toEqual(['groc'])
  })

  it('keeps household categories available regardless', () => {
    expect(usableOn(all, [], undefined).map((c) => c.id)).toEqual(['groc'])
  })
})

const txn = (over: Partial<Transaction> & { id: string; amountMinor: number; date: string }): Transaction => ({
  accountId: 'a',
  payee: 'x',
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

describe('transfers are neither spending nor income', () => {
  const month = '2026-03'
  const txns = [
    txn({ id: '1', amountMinor: -1000, date: '2026-03-02', categoryId: 'groc' }),
    txn({ id: '2', amountMinor: -5000, date: '2026-03-03', transferId: 't1' }),
    txn({ id: '3', amountMinor: 5000, date: '2026-03-03', transferId: 't1' }),
    txn({ id: '4', amountMinor: 20000, date: '2026-03-01' }),
  ]

  it('leaves both legs out of the month’s totals', () => {
    // Moving your own money between pockets must not read as £50 spent and
    // £50 earned, which is what made the old balances drift.
    const totals = monthTotals(txns, month)
    expect(totals.spend).toBe(1000)
    expect(totals.income).toBe(20000)
  })

  it('leaves them out of category history too', () => {
    const history = monthlySpendByCategory(txns, [groceries], [month])
    expect(history.get('groc')).toEqual([1000])
  })

  it('rolls subcategory spending into the parent’s history', () => {
    const spend = [
      txn({ id: '5', amountMinor: -4000, date: '2026-03-04', categoryId: 'ins' }),
      txn({ id: '6', amountMinor: -1000, date: '2026-03-05', categoryId: 'home' }),
    ]
    const history = monthlySpendByCategory(spend, [home, insurance], [month])
    expect(history.get('home')).toEqual([5000])
    expect(history.get('ins')).toBeUndefined()
  })
})

describe('suggestions', () => {
  it('uses the median so one annual bill does not skew eleven months', () => {
    // The mean of these is ~£104, which would suggest a budget nobody needs.
    expect(typicalSpend([3000, 3200, 2900, 40000, 3100])).toBe(3100)
  })

  it('rounds to the nearest pound, because a suggestion is not a measurement', () => {
    expect(typicalSpend([3123, 3456, 3789])).toBe(3500)
  })

  it('says nothing when there is not enough history to be worth suggesting from', () => {
    expect(typicalSpend([5000])).toBeUndefined()
    expect(typicalSpend([])).toBeUndefined()
    expect(typicalSpend(undefined)).toBeUndefined()
  })

  it('ignores months with no spending rather than treating them as zero', () => {
    // A category you only touched twice should suggest from those two months,
    // not be dragged to nothing by four empty ones.
    expect(typicalSpend([0, 0, 4000, 0, 6000, 0])).toBe(5000)
  })
})
