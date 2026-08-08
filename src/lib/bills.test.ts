import { beforeEach, describe, expect, it } from 'vitest'
import { addDays, format, subMonths } from 'date-fns'
import { db, type Bill, type Transaction } from './db'
import { detectBillPayments, dueAfter } from './bills'
import { todayISO } from './dates'

const iso = (d: Date) => format(d, 'yyyy-MM-dd')
const monthsAgo = (n: number, day = 4) => {
  const d = subMonths(new Date(), n)
  d.setDate(day)
  return iso(d)
}

let seq = 0
const bill = (over: Partial<Bill> & { nextDue: string }): Bill => ({
  id: `b${++seq}`,
  name: 'Mortgage',
  payee: 'NATIONWIDE MTG',
  amountMinor: -120000,
  accountId: 'current',
  freq: 'monthly',
  active: true,
  autoPost: false,
  updatedAt: 'x',
  ...over,
})

const txn = (over: Partial<Transaction> & { date: string }): Transaction => ({
  id: `t${++seq}`,
  accountId: 'current',
  payee: 'NATIONWIDE MTG 0021',
  amountMinor: -120000,
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

async function load(bills: Bill[], txns: Transaction[]) {
  await db.bills.clear()
  await db.transactions.clear()
  await db.meta.clear()
  await db.bills.bulkPut(bills)
  await db.transactions.bulkPut(txns)
}

beforeEach(async () => {
  await db.open()
})

describe('reconciling a bill against money that already moved', () => {
  it('matches an imported payment to the occurrence it satisfies', async () => {
    // The whole complaint: the mortgage went out, it is in the statement, and
    // the bill still reads "overdue" until you record a second one by hand.
    const due = monthsAgo(1, 1)
    await load([bill({ nextDue: due })], [txn({ date: monthsAgo(1, 2) })])

    const [m] = await detectBillPayments()

    expect(m).toBeDefined()
    expect(m.dueOn).toBe(due)
    expect(m.daysOff).toBe(1)
    expect(m.amountDeltaMinor).toBe(0)
  })

  it('maps several months of history onto separate occurrences', async () => {
    // Twelve identical payments must not all pile onto January.
    await load(
      [bill({ nextDue: monthsAgo(3, 1) })],
      [txn({ date: monthsAgo(3, 2) }), txn({ date: monthsAgo(2, 2) }), txn({ date: monthsAgo(1, 2) })],
    )

    const found = await detectBillPayments()

    expect(found).toHaveLength(3)
    expect(new Set(found.map((m) => m.dueOn)).size).toBe(3)
    expect(new Set(found.map((m) => m.txn.id)).size).toBe(3)
    // Oldest first, so each link walks next_due on from the last.
    expect([...found].sort((a, b) => a.dueOn.localeCompare(b.dueOn))).toEqual(found)
  })

  it('absorbs the wobble in a variable bill but not a different amount', async () => {
    const due = monthsAgo(1, 1)
    await load(
      [bill({ name: 'Electricity', payee: 'OCTOPUS ENERGY', amountMinor: -13800, nextDue: due })],
      [
        txn({ payee: 'OCTOPUS ENERGY LTD', amountMinor: -14200, date: monthsAgo(1, 2) }),
        txn({ payee: 'OCTOPUS ENERGY LTD', amountMinor: -4200, date: monthsAgo(1, 3) }),
      ],
    )

    const found = await detectBillPayments()

    expect(found).toHaveLength(1)
    expect(found[0].amountDeltaMinor).toBe(-400)
  })

  it('will not claim a payment from a different account', async () => {
    const due = monthsAgo(1, 1)
    await load([bill({ nextDue: due })], [txn({ accountId: 'joint', date: monthsAgo(1, 2) })])

    expect(await detectBillPayments()).toHaveLength(0)
  })

  it('ignores payments already spoken for', async () => {
    const due = monthsAgo(1, 1)
    await load(
      [bill({ nextDue: due })],
      [
        txn({ date: monthsAgo(1, 2), billId: 'someone-elses-bill' }),
        txn({ date: monthsAgo(1, 3), transferId: 'a-transfer' }),
      ],
    )

    expect(await detectBillPayments()).toHaveLength(0)
  })

  it('will not reconcile an occurrence that has not come due yet', async () => {
    // Claiming a payment for next month would advance the bill past a month
    // nothing has happened in.
    const future = iso(addDays(new Date(), 20))
    await load([bill({ nextDue: future })], [txn({ date: iso(addDays(new Date(), 19)) })])

    expect(await detectBillPayments()).toHaveLength(0)
  })

  it('does not match a payment too far from the due date', async () => {
    // A monthly bill allows eight days either side; three weeks out is a
    // different payment to the same merchant.
    const due = monthsAgo(1, 1)
    await load([bill({ nextDue: due })], [txn({ date: monthsAgo(1, 22) })])

    expect(await detectBillPayments()).toHaveLength(0)
  })

  it('skips paused bills', async () => {
    await load([bill({ nextDue: monthsAgo(1, 1), active: false })], [txn({ date: monthsAgo(1, 2) })])

    expect(await detectBillPayments()).toHaveLength(0)
  })
})

describe('reconciling history that predates the bill', () => {
  /**
   * The case the detector was missing entirely: you start tracking the mortgage
   * today, then import a year of statements. Every payment in them is BEFORE
   * `nextDue`, which is where nothing was looking — so the history stayed
   * unreconciled and nothing on screen said why.
   */
  it('offers payments from before nextDue', async () => {
    // Tracked from next month; three payments already in the account.
    await load(
      [bill({ nextDue: monthsAgo(-1, 1) })],
      [txn({ date: monthsAgo(3, 2) }), txn({ date: monthsAgo(2, 2) }), txn({ date: monthsAgo(1, 2) })],
    )

    const found = await detectBillPayments()

    expect(found).toHaveLength(3)
    expect(new Set(found.map((m) => m.dueOn)).size).toBe(3)
    expect(new Set(found.map((m) => m.txn.id)).size).toBe(3)
    // Still oldest first, so each link walks next_due on from the last.
    expect([...found].sort((a, b) => a.dueOn.localeCompare(b.dueOn))).toEqual(found)
  })

  it('stops walking back at the oldest payment there is to match', async () => {
    // The backwards walk is bounded by the data, not by a guess: one payment
    // eight months back must not produce eight months of empty occurrences.
    await load([bill({ nextDue: monthsAgo(-1, 1) })], [txn({ date: monthsAgo(8, 2) })])

    const found = await detectBillPayments()

    expect(found).toHaveLength(1)
    expect(found[0].txn.date).toBe(monthsAgo(8, 2))
  })

  it('still refuses an occurrence that has not happened yet', async () => {
    // Forwards is still capped at today. A payment cannot satisfy next month.
    await load([bill({ nextDue: monthsAgo(-1, 1) })], [txn({ date: monthsAgo(-1, 2) })])

    expect(await detectBillPayments()).toHaveLength(0)
  })

  it('leaves a payment already recorded against the bill alone', async () => {
    // What makes looking backwards safe: a settled occurrence has a linked
    // payment, and a linked payment is not a candidate.
    await load(
      [bill({ nextDue: monthsAgo(-1, 1) })],
      [txn({ date: monthsAgo(1, 2), billId: 'b-whatever' })],
    )

    expect(await detectBillPayments()).toHaveLength(0)
  })
})

describe('where a newly tracked bill is next due', () => {
  it('lands one period after the last payment, not today', async () => {
    // "Next due today" on a bill that goes out on the 4th is both wrong and
    // immediately overdue — the first thing a new bill did was complain.
    const last = monthsAgo(1, 4)
    const next = dueAfter(last, 'monthly')

    expect(next).not.toBe(todayISO())
    expect(next > last).toBe(true)
    expect(next.slice(-2)).toBe('04')
  })

  it('walks forward past a gap in the history rather than landing in the past', async () => {
    const next = dueAfter(monthsAgo(8, 4), 'monthly')

    expect(next >= todayISO()).toBe(true)
  })
})
