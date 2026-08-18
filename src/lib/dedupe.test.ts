import { describe, expect, it } from 'vitest'
import type { Transaction } from './db'
import { findLikelyDuplicate } from './dedupe'

let seq = 0
const txn = (over: Partial<Transaction> & { payee: string }): Transaction => ({
  id: `t${++seq}`,
  accountId: 'current',
  date: '2026-03-04',
  amountMinor: -4520,
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

describe('finding the entry a statement line is a second copy of', () => {
  it('matches a manual entry with no reference on the amount and the date alone', () => {
    // The whole point of the completion flow: somebody typed "Dinner out" the
    // evening it happened, with no idea what the card machine would call it.
    // There is nothing to compare but the money and the day.
    const manual = txn({ payee: '', title: 'Dinner out', date: '2026-03-02' })

    const found = findLikelyDuplicate(
      { date: '2026-03-04', payee: 'SQ *THE GOOD FORK 3241', amountMinor: -4520 },
      [manual],
    )

    expect(found?.id).toBe(manual.id)
  })

  it('still requires a similar payee where the existing row has one', () => {
    // Loosening the payee test for referenceless rows must not loosen it for
    // everything else, or two £45.20 payments in one week become one.
    const other = txn({ payee: 'PIZZA EXPRESS', date: '2026-03-02' })

    expect(
      findLikelyDuplicate({ date: '2026-03-04', payee: 'SQ *THE GOOD FORK 3241', amountMinor: -4520 }, [other]),
    ).toBeUndefined()
  })

  it('will not reach past the date window, however little it has to go on', () => {
    const manual = txn({ payee: '', title: 'Dinner out', date: '2026-02-20' })

    expect(
      findLikelyDuplicate({ date: '2026-03-04', payee: 'SQ *THE GOOD FORK 3241', amountMinor: -4520 }, [manual]),
    ).toBeUndefined()
  })

  it('never matches a different amount', () => {
    const manual = txn({ payee: '', title: 'Dinner out', amountMinor: -4500 })

    expect(
      findLikelyDuplicate({ date: '2026-03-04', payee: 'SQ *THE GOOD FORK 3241', amountMinor: -4520 }, [manual]),
    ).toBeUndefined()
  })
})
