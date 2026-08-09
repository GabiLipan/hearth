import { describe, expect, it } from 'vitest'
import type { Account, AccountGrant, Transaction } from './db'
import { classifyAccounts, classifyFlows, type BookMap } from './books'
import { settlement } from './reimbursements'

/**
 * Same household as `books.test.ts`, and asserted from the same device: Gabi
 * can see the joint accounts and his own, and not one row of his partner's.
 * The figure here is what the household owes HIM, which is the only version of
 * it that can be computed without breaking that.
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

const grant = (accountId: string, userId: string): AccountGrant => ({
  id: `${accountId}:${userId}`,
  accountId,
  userId,
  level: 'owner',
  updatedAt: 'x',
})

const accounts = [account('joint'), account('myPrivate'), account('myCard', 'credit')]

const books: BookMap = classifyAccounts(
  accounts,
  new Map([
    ['joint', [grant('joint', ME), grant('joint', HER)]],
    ['myPrivate', [grant('myPrivate', ME)]],
    ['myCard', [grant('myCard', ME)]],
  ]),
  ME,
)

let seq = 0
const txn = (over: Partial<Transaction> & { accountId: string; amountMinor: number }): Transaction => ({
  id: `t${++seq}`,
  date: '2026-03-15',
  payee: 'x',
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

/** A shop put on my own card and ticked. */
const paid = (amountMinor: number, date: string) =>
  txn({ accountId: 'myCard', amountMinor: -amountMinor, date, paidForHousehold: true, categoryId: 'groceries' })

/** The household paying me back: a linked transfer, joint → mine. */
const repaid = (amountMinor: number, date: string, id: string) => [
  txn({ accountId: 'joint', amountMinor: -amountMinor, date, transferId: id }),
  txn({ accountId: 'myPrivate', amountMinor, date, transferId: id }),
]

const run = (txns: Transaction[]) => settlement(txns, classifyFlows(txns, books), books)

describe('settlement', () => {
  it('is nothing when nothing has been paid for', () => {
    const s = run([
      txn({ accountId: 'joint', amountMinor: -4520, categoryId: 'groceries' }),
      txn({ accountId: 'myCard', amountMinor: -1200, categoryId: 'fun' }),
    ])
    expect(s).toEqual({ paidMinor: 0, returnedMinor: 0, outstandingMinor: 0, items: [] })
  })

  it('counts what I paid for the household', () => {
    const s = run([paid(9000, '2026-03-10'), paid(2500, '2026-03-12')])
    expect(s.paidMinor).toBe(11500)
    expect(s.returnedMinor).toBe(0)
    expect(s.outstandingMinor).toBe(11500)
    expect(s.items.map((i) => i.owedMinor)).toEqual([2500, 9000])
  })

  it('nets off a repayment, and counts it once', () => {
    // The point of taking only my leg: `withdrawal` is on both, and counting
    // the joint one too would settle the debt twice over.
    const s = run([paid(9000, '2026-03-10'), ...repaid(9000, '2026-03-20', 'r1')])
    expect(s.returnedMinor).toBe(9000)
    expect(s.outstandingMinor).toBe(0)
    expect(s.items).toEqual([])
  })

  it('settles oldest first, and reports the part that is left', () => {
    const s = run([
      paid(9000, '2026-03-10'),
      paid(2500, '2026-03-12'),
      paid(4000, '2026-03-14'),
      ...repaid(10000, '2026-03-20', 'r1'),
    ])
    expect(s.outstandingMinor).toBe(5500)
    // £90 gone entirely, £10 of the £25 gone, and the £40 untouched. Newest
    // first for the screen, so the partial row is at the bottom.
    expect(s.items.map((i) => [i.txn.date, i.owedMinor])).toEqual([
      ['2026-03-14', 4000],
      ['2026-03-12', 1500],
    ])
  })

  it('reports an overpayment rather than clamping it', () => {
    const s = run([paid(9000, '2026-03-10'), ...repaid(12000, '2026-03-20', 'r1')])
    expect(s.outstandingMinor).toBe(-3000)
    expect(s.items).toEqual([])
  })

  it('ignores a refund back onto the card', () => {
    // `classifyFlows` will not flag a credit as paid-for-household, and this is
    // the row that would otherwise credit the household with money it never had.
    const s = run([
      paid(9000, '2026-03-10'),
      txn({ accountId: 'myCard', amountMinor: 1500, date: '2026-03-11', paidForHousehold: true }),
    ])
    expect(s.paidMinor).toBe(9000)
    expect(s.outstandingMinor).toBe(9000)
  })

  it('does not count my contribution as being paid back', () => {
    // Money going the OTHER way — my salary into the joint account — is a
    // contribution, not a repayment, and must not reduce what I am owed.
    const s = run([
      paid(9000, '2026-03-10'),
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-03-02', transferId: 'c1' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-03-02', transferId: 'c1' }),
    ])
    expect(s.returnedMinor).toBe(0)
    expect(s.outstandingMinor).toBe(9000)
  })

  it('does not count a move between two of my own accounts', () => {
    const s = run([
      paid(9000, '2026-03-10'),
      txn({ accountId: 'myPrivate', amountMinor: -5000, date: '2026-03-11', transferId: 'i1' }),
      txn({ accountId: 'myCard', amountMinor: 5000, date: '2026-03-11', transferId: 'i1' }),
    ])
    expect(s.returnedMinor).toBe(0)
    expect(s.outstandingMinor).toBe(9000)
  })

  it('does not count an unlinked repayment, and says I am still owed', () => {
    // The limit stated in the module header, pinned so it cannot change by
    // accident. Two unpaired legs read as household spending and personal
    // income; over-reporting the debt is the safe direction to be wrong in,
    // because it prompts somebody to go and link them.
    const s = run([
      paid(9000, '2026-03-10'),
      txn({ accountId: 'joint', amountMinor: -9000, date: '2026-03-20', payee: 'TFR' }),
      txn({ accountId: 'myPrivate', amountMinor: 9000, date: '2026-03-20', payee: 'TFR' }),
    ])
    expect(s.returnedMinor).toBe(0)
    expect(s.outstandingMinor).toBe(9000)
  })

  it('is stable when several rows share a date', () => {
    const rows = [paid(1000, '2026-03-10'), paid(2000, '2026-03-10'), paid(3000, '2026-03-10')]
    const a = run(rows)
    const b = run([...rows].reverse())
    expect(a.items.map((i) => i.txn.id)).toEqual(b.items.map((i) => i.txn.id))
  })
})
