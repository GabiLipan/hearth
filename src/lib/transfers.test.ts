import { describe, expect, it } from 'vitest'
import type { Transaction } from './db'
import { findTransferCandidates } from './transfers'

let seq = 0
const txn = (over: Partial<Transaction> & { accountId: string; amountMinor: number }): Transaction => ({
  id: `t${++seq}`,
  date: '2026-03-04',
  payee: 'Something',
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

describe('transfer pairing', () => {
  it('pairs opposite legs of the same amount in different accounts', () => {
    const out = txn({ accountId: 'current', amountMinor: -50000, payee: 'TFR TO SAVINGS' })
    const inc = txn({ accountId: 'savings', amountMinor: 50000, payee: 'TFR FROM CURRENT' })

    const [found] = findTransferCandidates([out, inc])

    expect(found.out.id).toBe(out.id)
    expect(found.in.id).toBe(inc.id)
    expect(found.daysApart).toBe(0)
    expect(found.unambiguous).toBe(true)
    expect(found.namedTransfer).toBe(true)
  })

  it('will not pair two legs in the same account', () => {
    // £500 out and £500 back into one account is a refund, not a movement.
    // Treating it as a transfer would remove a real refund from the totals.
    const out = txn({ accountId: 'current', amountMinor: -50000 })
    const inc = txn({ accountId: 'current', amountMinor: 50000 })

    expect(findTransferCandidates([out, inc])).toHaveLength(0)
  })

  it('requires the amounts to match exactly', () => {
    // Every other matcher here works to a tolerance. This one must not: a
    // tolerance would decide that the difference between two amounts is nothing
    // and then hide both, so the money could never be found again.
    const out = txn({ accountId: 'current', amountMinor: -50000 })
    const inc = txn({ accountId: 'savings', amountMinor: 49900 })

    expect(findTransferCandidates([out, inc])).toHaveLength(0)
  })

  it('allows a few days for the far side to post, but not a fortnight', () => {
    const out = txn({ accountId: 'current', amountMinor: -20000, date: '2026-03-04' })
    const near = txn({ accountId: 'savings', amountMinor: 20000, date: '2026-03-06' })
    const far = txn({ accountId: 'isa', amountMinor: 20000, date: '2026-03-20' })

    const found = findTransferCandidates([out, near, far])

    expect(found).toHaveLength(1)
    expect(found[0].in.id).toBe(near.id)
    expect(found[0].daysApart).toBe(2)
  })

  it('flags a pair as ambiguous when either side has more than one reading', () => {
    // Two identical payments out and one in is a question, not one transfer and
    // one coincidence. Both readings are offered; neither may be auto-linked.
    const outA = txn({ accountId: 'current', amountMinor: -50000 })
    const outB = txn({ accountId: 'credit', amountMinor: -50000 })
    const inc = txn({ accountId: 'savings', amountMinor: 50000 })

    const found = findTransferCandidates([outA, outB, inc])

    expect(found).toHaveLength(2)
    expect(found.every((c) => !c.unambiguous)).toBe(true)
  })

  it('leaves a clean pair unambiguous even when other transfers exist nearby', () => {
    const outA = txn({ accountId: 'current', amountMinor: -50000 })
    const inA = txn({ accountId: 'savings', amountMinor: 50000 })
    const outB = txn({ accountId: 'current', amountMinor: -12345 })
    const inB = txn({ accountId: 'isa', amountMinor: 12345 })

    const found = findTransferCandidates([outA, inA, outB, inB])

    expect(found).toHaveLength(2)
    expect(found.every((c) => c.unambiguous)).toBe(true)
  })

  it('ignores transactions already spoken for', () => {
    // A leg of an existing transfer, or a recorded bill payment. link_transfer
    // refuses both, so proposing them would only produce a failing RPC.
    const linked = txn({ accountId: 'current', amountMinor: -50000, transferId: 'existing' })
    const billed = txn({ accountId: 'current', amountMinor: -50000, billId: 'mortgage' })
    const inc = txn({ accountId: 'savings', amountMinor: 50000 })

    expect(findTransferCandidates([linked, billed, inc])).toHaveLength(0)
  })

  it('honours dismissed pairs', () => {
    const out = txn({ accountId: 'current', amountMinor: -50000 })
    const inc = txn({ accountId: 'savings', amountMinor: 50000 })

    const dismissed = new Set([`${out.id}>${inc.id}`])

    expect(findTransferCandidates([out, inc])).toHaveLength(1)
    expect(findTransferCandidates([out, inc], { dismissed })).toHaveLength(0)
  })

  it('does not treat an ordinary purchase and an unrelated refund as a transfer', () => {
    // Different amounts, so nothing pairs — the everyday case, asserted so a
    // future loosening of the amount rule fails here rather than in production.
    const shop = txn({ accountId: 'current', amountMinor: -2499, payee: 'Tesco' })
    const refund = txn({ accountId: 'savings', amountMinor: 1999, payee: 'Refund' })

    expect(findTransferCandidates([shop, refund])).toHaveLength(0)
  })
})

describe('ambiguity that does not matter, and ambiguity that does', () => {
  // Both of us are paid at the end of the month and both move a round sum into
  // the joint account. My one outgoing leg matches two identical arrivals, so
  // `unambiguous` is false and always will be — but the question "which £2,000
  // was mine" has no consequence for any figure the app shows.
  const books = {
    household: new Set(['joint']),
    mine: new Set(['myPrivate']),
    others: new Set<string>(),
  }

  it('links my payday contribution even though two arrivals match it', () => {
    const out = txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-07-31' })
    const mineIn = txn({ accountId: 'joint', amountMinor: 200000, date: '2026-07-31' })
    const hersIn = txn({ accountId: 'joint', amountMinor: 200000, date: '2026-07-31' })

    const found = findTransferCandidates([out, mineIn, hersIn], { books })

    expect(found).toHaveLength(2)
    expect(found.every((c) => !c.unambiguous)).toBe(true)
    // Whichever arrival is chosen, my leg is a £2,000 contribution and the
    // leftover counts as outside income — the household's total is the same.
    expect(found.every((c) => c.bookSafe)).toBe(true)
  })

  it('refuses the mirror image, where the leftover would become spending', () => {
    // Two outgoing legs of mine competing for one arrival. Pick either and the
    // other is stranded as personal SPENDING, which is a different number and a
    // wrong one. This is the case that must never be linked unattended.
    const outA = txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-07-31' })
    const outB = txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-07-31' })
    const onlyIn = txn({ accountId: 'joint', amountMinor: 200000, date: '2026-07-31' })

    const found = findTransferCandidates([outA, outB, onlyIn], { books })

    expect(found).toHaveLength(2)
    expect(found.every((c) => !c.unambiguous)).toBe(true)
    expect(found.every((c) => !c.bookSafe)).toBe(true)
  })

  it('does not guess at a transfer between two of my own accounts', () => {
    // Nothing crosses a book, so no total moves whichever way it is read, and
    // guessing buys nothing.
    const twoOfMine = {
      household: new Set<string>(),
      mine: new Set(['myPrivate', 'mySavings']),
      others: new Set<string>(),
    }
    const out = txn({ accountId: 'myPrivate', amountMinor: -10000 })
    const a = txn({ accountId: 'mySavings', amountMinor: 10000 })

    const [found] = findTransferCandidates([out, a], { books: twoOfMine })

    expect(found.unambiguous).toBe(true)
    expect(found.bookSafe).toBe(false)
  })

  it('reports nothing book-safe when it has not been given the books', () => {
    const out = txn({ accountId: 'myPrivate', amountMinor: -200000 })
    const inc = txn({ accountId: 'joint', amountMinor: 200000 })

    expect(findTransferCandidates([out, inc])[0].bookSafe).toBe(false)
  })
})
