import { describe, expect, it } from 'vitest'
import type { Account, AccountGrant, Category, Transaction } from './db'
import { classifyAccounts, classifyFlows, type BookMap } from './books'
import {
  categoryHeatmap,
  fixedVsVariable,
  householdWaterfall,
  pace,
  salaryBars,
  savingsRate,
  topPayees,
} from './insights'

/**
 * The same household as books.test.ts, seen from Gabi's device: he is on both
 * joint accounts and his own private one, and cannot see a row of his
 * partner's. Every figure below has to come out right anyway.
 */
const ME = 'gabi'
const HER = 'wife'

const account = (id: string, kind: Account['kind'] = 'current'): Account => ({
  id,
  name: id,
  kind,
  openingBalanceMinor: 0,
  sortOrder: 0,
  updatedAt: 'x',
})

const grant = (accountId: string, userId: string, level: AccountGrant['level'] = 'owner'): AccountGrant => ({
  id: `${accountId}:${userId}`,
  accountId,
  userId,
  level,
  updatedAt: 'x',
})

const accounts = [account('joint'), account('jointSavings', 'savings'), account('myPrivate')]

const books: BookMap = classifyAccounts(
  accounts,
  new Map([
    ['joint', [grant('joint', ME), grant('joint', HER)]],
    ['jointSavings', [grant('jointSavings', ME), grant('jointSavings', HER)]],
    ['myPrivate', [grant('myPrivate', ME)]],
  ]),
  ME,
)

const cat = (id: string, name: string, over: Partial<Category> = {}): Category => ({
  id,
  name,
  kind: 'expense',
  icon: 'tag',
  slot: 1,
  sortOrder: 0,
  updatedAt: 'x',
  ...over,
})

const categories: Category[] = [
  cat('home', 'Home'),
  cat('insurance', 'Insurance', { parentId: 'home', icon: undefined, slot: undefined }),
  cat('food', 'Groceries', { slot: 2 }),
  cat('fun', 'Fun', { slot: 3 }),
  cat('salary', 'Salary', { kind: 'income', slot: 4 }),
]

let seq = 0
const txn = (over: Partial<Transaction> & { accountId: string; amountMinor: number }): Transaction => ({
  id: `t${++seq}`,
  date: '2026-03-15',
  payee: 'x',
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

/** March: two salaries in, both contributed, the household spends and saves. */
function march(): Transaction[] {
  return [
    txn({ accountId: 'myPrivate', amountMinor: 300000, date: '2026-03-01', categoryId: 'salary' }),
    // My contribution, both legs visible.
    txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-03-02', transferId: 'mine' }),
    txn({ accountId: 'joint', amountMinor: 200000, date: '2026-03-02', transferId: 'mine' }),
    // Hers: only the arrival is visible to me, and she has linked it.
    txn({ accountId: 'joint', amountMinor: 180000, date: '2026-03-02', transferId: 'hers' }),

    txn({ accountId: 'joint', amountMinor: -120000, date: '2026-03-03', categoryId: 'home', payee: 'NATIONWIDE MTG', billId: 'b1' }),
    txn({ accountId: 'joint', amountMinor: -25000, date: '2026-03-04', categoryId: 'insurance', payee: 'AVIVA', billId: 'b2' }),
    txn({ accountId: 'joint', amountMinor: -40000, date: '2026-03-10', categoryId: 'food', payee: 'TESCO STORES 3456' }),
    txn({ accountId: 'joint', amountMinor: -20000, date: '2026-03-20', categoryId: 'food', payee: 'TESCO EXPRESS 88' }),
    txn({ accountId: 'joint', amountMinor: -15000, date: '2026-03-22', categoryId: 'fun', payee: 'ODEON' }),

    // Joint current → joint savings: internal to the book.
    txn({ accountId: 'joint', amountMinor: -100000, date: '2026-03-28', transferId: 'save' }),
    txn({ accountId: 'jointSavings', amountMinor: 100000, date: '2026-03-28', transferId: 'save' }),

    txn({ accountId: 'myPrivate', amountMinor: -70000, date: '2026-03-18', categoryId: 'fun' }),
  ]
}

const flowsOf = (rows: Transaction[]) => classifyFlows(rows, books)

describe('the household waterfall', () => {
  it('walks paid in → spent → saved → left, and the steps reconcile', () => {
    const rows = march()
    const steps = householdWaterfall(rows, flowsOf(rows), books, accounts, '2026-03')
    const by = Object.fromEntries(steps.map((s) => [s.key, s]))

    expect(by.in.deltaMinor).toBe(380000) // both contributions
    expect(by.spend.deltaMinor).toBe(-220000) // 120 + 25 + 40 + 20 + 15
    expect(by.savings.deltaMinor).toBe(-100000)
    // What is left in the current account is the running total, and it is a
    // total rather than a movement.
    expect(by.left.runningMinor).toBe(60000)
    expect(by.left.total).toBe(true)
  })

  it('counts the arriving leg of an internal transfer only', () => {
    // Both legs are inside the household book and net to zero, so counting the
    // pair would show nothing moving at all.
    const rows = march()
    const steps = householdWaterfall(rows, flowsOf(rows), books, accounts, '2026-03')
    expect(steps.find((s) => s.key === 'savings')!.deltaMinor).toBe(-100000)
  })

  it('leaves the withdrawal step out when there is none', () => {
    const rows = march()
    const steps = householdWaterfall(rows, flowsOf(rows), books, accounts, '2026-03')
    expect(steps.map((s) => s.key)).toEqual(['in', 'spend', 'savings', 'left'])
  })
})

describe('what a salary turned into', () => {
  it('splits the month into contributed, spent and left over', () => {
    const rows = march()
    const [bar] = salaryBars(rows, flowsOf(rows), books, ['2026-03'])

    expect(bar.earnedMinor).toBe(300000)
    expect(bar.contributedMinor).toBe(200000)
    expect(bar.spentMinor).toBe(70000)
    expect(bar.leftMinor).toBe(30000)
    expect(bar.contributedMinor + bar.spentMinor + bar.leftMinor).toBe(bar.earnedMinor)
  })

  it('shows nothing left rather than a negative slice', () => {
    // A stack cannot draw a negative part without lying about the total. The
    // three parts then exceed the bar, which is the honest reading: more went
    // out than came in.
    const rows = [
      txn({ accountId: 'myPrivate', amountMinor: 100000, date: '2026-03-01', categoryId: 'salary' }),
      txn({ accountId: 'myPrivate', amountMinor: -150000, date: '2026-03-05', categoryId: 'fun' }),
    ]
    const [bar] = salaryBars(rows, flowsOf(rows), books, ['2026-03'])

    expect(bar.leftMinor).toBe(0)
    expect(bar.spentMinor).toBe(150000)
  })
})

describe('fixed against variable', () => {
  it('counts spending recorded against a bill as fixed', () => {
    const rows = march()
    const [m] = fixedVsVariable(rows, flowsOf(rows), 'household', books, ['2026-03'])

    expect(m.fixedMinor).toBe(145000) // mortgage + insurance
    expect(m.variableMinor).toBe(75000) // groceries twice + cinema
  })

  it('gives a month with no rows two zeroes rather than dropping it', () => {
    const rows = march()
    const series = fixedVsVariable(rows, flowsOf(rows), 'household', books, ['2026-01', '2026-03'])
    expect(series).toHaveLength(2)
    expect(series[0]).toMatchObject({ key: '2026-01', fixedMinor: 0, variableMinor: 0 })
  })
})

describe('the savings rate', () => {
  it('is what did not go out again, over what came in', () => {
    const rows = march()
    const [m] = savingsRate(rows, flowsOf(rows), 'household', books, ['2026-03'])

    expect(m.incomeMinor).toBe(380000)
    expect(m.savedMinor).toBe(160000)
    expect(m.rate).toBeCloseTo(160000 / 380000)
  })

  it('is null for a month with nothing coming in, not zero', () => {
    // A rate is a fraction of something. Plotting an absence as 0% draws a
    // collapse where there is only silence.
    const rows = [txn({ accountId: 'joint', amountMinor: -5000, date: '2026-03-04', categoryId: 'food' })]
    const [m] = savingsRate(rows, flowsOf(rows), 'household', books, ['2026-03'])
    expect(m.rate).toBeNull()
  })
})

describe('top payees', () => {
  it('groups the same shop under one line', () => {
    // TESCO STORES 3456 and TESCO EXPRESS 88 are one merchant, and this uses
    // the same normalisation the rules engine learns on.
    const rows = march()
    const top = topPayees(rows, flowsOf(rows), categories, 'household', books, '2026-03')

    const tesco = top.find((p) => p.payee.toLowerCase().startsWith('tesco'))
    expect(tesco).toBeDefined()
    expect(tesco!.count).toBe(2)
    expect(tesco!.totalMinor).toBe(60000)
  })

  it('is biggest first, and stops where it is told', () => {
    const rows = march()
    const top = topPayees(rows, flowsOf(rows), categories, 'household', books, '2026-03', 2)

    expect(top).toHaveLength(2)
    expect(top[0].totalMinor).toBeGreaterThanOrEqual(top[1].totalMinor)
    expect(top[0].totalMinor).toBe(120000) // the mortgage
  })

  it('takes its colour from where most of the money went, not most of the rows', () => {
    // One £400 line says more about what a payee is than nine £3 ones.
    const rows = [
      txn({ accountId: 'joint', amountMinor: -40000, date: '2026-03-02', payee: 'AMAZON', categoryId: 'fun' }),
      txn({ accountId: 'joint', amountMinor: -300, date: '2026-03-03', payee: 'AMAZON', categoryId: 'food' }),
      txn({ accountId: 'joint', amountMinor: -300, date: '2026-03-04', payee: 'AMAZON', categoryId: 'food' }),
    ]
    const [amazon] = topPayees(rows, flowsOf(rows), categories, 'household', books, '2026-03')
    expect(amazon.slot).toBe(3) // Fun, not Groceries
  })
})

describe('the category heatmap', () => {
  const months = ['2026-01', '2026-02', '2026-03']

  it('rolls a subcategory up to its parent', () => {
    // Insurance is under Home, and a heatmap of forty subcategories is a wall.
    const rows = march()
    const grid = categoryHeatmap(rows, flowsOf(rows), categories, 'household', books, months)

    const home = grid.rows.find((r) => r.categoryId === 'home')!
    expect(home.cells[2]).toBe(145000) // mortgage + insurance, in March
    expect(grid.rows.map((r) => r.categoryId)).not.toContain('insurance')
  })

  it('scales every cell against the largest single cell', () => {
    // Per row makes the £8 category and the £800 one both run pale to solid,
    // and comparing categories is the whole point.
    const rows = march()
    const grid = categoryHeatmap(rows, flowsOf(rows), categories, 'household', books, months)
    expect(grid.peakMinor).toBe(145000)
  })

  it('is biggest first and gives every row a cell per month', () => {
    const rows = march()
    const grid = categoryHeatmap(rows, flowsOf(rows), categories, 'household', books, months)

    expect(grid.rows.every((r) => r.cells.length === months.length)).toBe(true)
    expect([...grid.rows].sort((a, b) => b.totalMinor - a.totalMinor)).toEqual(grid.rows)
  })
})

describe('the pace line', () => {
  it('accumulates through the month, and compares against the one before', () => {
    const rows = [
      txn({ accountId: 'joint', amountMinor: -10000, date: '2026-02-05', categoryId: 'food' }),
      txn({ accountId: 'joint', amountMinor: -10000, date: '2026-02-20', categoryId: 'food' }),
      txn({ accountId: 'joint', amountMinor: -30000, date: '2026-03-05', categoryId: 'food' }),
    ]
    const points = pace(rows, flowsOf(rows), 'household', books, '2026-03')

    const at = (day: number) => points.find((p) => p.day === day)!
    expect(at(4).thisMonthMinor).toBe(0)
    expect(at(5).thisMonthMinor).toBe(30000)
    expect(at(31).thisMonthMinor).toBe(30000)
    // Last month's line runs the whole way, so the ends are comparable.
    expect(at(5).lastMonthMinor).toBe(10000)
    expect(at(31).lastMonthMinor).toBe(20000)
  })

  it('runs a finished month to its end', () => {
    // The truncation is for the month we are IN. A month in the past is whole,
    // and stopping it early would invent a slowdown.
    const rows = [txn({ accountId: 'joint', amountMinor: -10000, date: '2026-03-28', categoryId: 'food' })]
    const points = pace(rows, flowsOf(rows), 'household', books, '2026-03')
    expect(points[30].thisMonthMinor).toBe(10000)
  })
})
