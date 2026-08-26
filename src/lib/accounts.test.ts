import { describe, expect, it } from 'vitest'
import { format, subDays } from 'date-fns'
import type { Account, Transaction } from './db'
import { accountFace, balanceHistory, byLedger, computeBalance, runningBalances } from './accounts'

const day = (offset: number) => format(subDays(new Date(), offset), 'yyyy-MM-dd')

const txn = (accountId: string, amountMinor: number, date: string, id?: string): Transaction => ({
  id: id ?? `${accountId}${date}${amountMinor}`,
  accountId,
  date,
  payee: 'x',
  amountMinor,
  createdAt: 'x',
  updatedAt: 'x',
})

describe('balanceHistory', () => {
  it('ends on the balance it was given', () => {
    // The figure printed beside the line comes from `balanceOf`, so the line
    // has to arrive exactly on it however incomplete the cache is.
    const series = balanceHistory('a', [txn('a', -500, day(3))], 10_000, 30)
    expect(series).toHaveLength(31)
    expect(series[series.length - 1]).toBe(10_000)
  })

  it('walks backwards through the days movements', () => {
    // Each point is a day's CLOSING balance, so `series[30 - k]` is the end of
    // the day k days ago and includes that day's own movements.
    //
    // 10,000 today; 500 went out three days ago, so every day that closed
    // before it is 500 higher and every day since matches today.
    const series = balanceHistory('a', [txn('a', -500, day(3))], 10_000, 30)
    expect(series[30]).toBe(10_000) // end of today
    expect(series[28]).toBe(10_000) // end of two days ago
    expect(series[27]).toBe(10_000) // end of three days ago — after the withdrawal
    expect(series[26]).toBe(10_500) // end of four days ago — before it
    expect(series[0]).toBe(10_500)
  })

  it('ignores other accounts', () => {
    const series = balanceHistory('a', [txn('b', -9_000, day(3))], 10_000, 30)
    expect(new Set(series)).toEqual(new Set([10_000]))
  })

  it('ignores movements older than the window', () => {
    const series = balanceHistory('a', [txn('a', -500, day(90))], 10_000, 30)
    expect(new Set(series)).toEqual(new Set([10_000]))
  })

  it('adds up several movements on the same day', () => {
    const series = balanceHistory('a', [txn('a', -500, day(2)), txn('a', -300, day(2))], 10_000, 30)
    expect(series[28]).toBe(10_000) // end of that day, both movements counted
    expect(series[27]).toBe(10_800) // the day before
  })

  it('counts today itself', () => {
    // The last point is today's closing balance, so today's movements must be
    // behind it rather than still to come.
    const series = balanceHistory('a', [txn('a', -500, day(0))], 10_000, 30)
    expect(series[30]).toBe(10_000)
    expect(series[29]).toBe(10_500)
  })
})

const account = (id: string, openingBalanceMinor = 0): Account => ({
  id,
  name: id,
  kind: 'current',
  openingBalanceMinor,
  sortOrder: 0,
  updatedAt: 'x',
})

describe('runningBalances', () => {
  const a = account('a', 10_000)
  const b = account('b', 500)

  it('counts each account forwards from its own opening balance', () => {
    const rows = [txn('a', -2_000, '2026-01-02'), txn('a', 1_000, '2026-01-03'), txn('b', -100, '2026-01-02')]
    const out = runningBalances([a, b], rows)
    expect(out.get(rows[0].id)).toBe(8_000)
    expect(out.get(rows[1].id)).toBe(9_000)
    // The other account's rows never enter this one's arithmetic.
    expect(out.get(rows[2].id)).toBe(400)
  })

  /** The one thing the column and the figure beside the account must agree on. */
  it('lands the last row exactly on the balance the rest of the app prints', () => {
    const rows = [txn('a', -2_000, '2026-01-02'), txn('a', 1_000, '2026-01-03')]
    const out = runningBalances([a], rows)
    expect(out.get(rows[1].id)).toBe(computeBalance(a, rows))
  })

  /**
   * The invariant the column rests on, and the one that was broken: the
   * balances are this list walked BACKWARDS, so reading them from the bottom of
   * the page upwards steps by each row's own amount.
   *
   * The case that broke it is an import. Every row of a statement goes in
   * inside one transaction and `now()` is the transaction's clock, so all forty
   * carry an identical `createdAt` — and two orderings that are reverses of
   * each other only while nothing ties then stop being reverses at all. The
   * page listed a day in one order and the balance counted it in the same one,
   * so the column stepped down the page instead of up: an opening balance of
   * £3,597.93 less £8.70 appeared on the row at the TOP of the second of
   * January rather than the bottom.
   */
  /**
   * The discriminating half, and where the fault actually was.
   *
   * `runningBalances` broke ties on the id and Activity's own sort did not, so
   * a tie left the page in whatever order Dexie returned — primary-key order,
   * which is id ASCENDING. Two orderings that are reverses of each other only
   * while nothing ties are not reverses at all once something does, and a
   * statement import ties every row it writes.
   */
  it('breaks a tie on the id, so the page is the exact reverse of the balances', () => {
    // As Dexie hands them back, which is where the page used to leave them.
    const rows = [txn('a', -870, '2026-01-02', 'aaa'), txn('a', -949, '2026-01-02', 'zzz')]
    expect([...rows].sort(byLedger).map((r) => r.id)).toEqual(['zzz', 'aaa'])
  })

  /**
   * The bank's own order, which is the only evidence there is inside a day.
   *
   * Every row of one import carries the same `created_at` — one insert, one
   * transaction clock — so without this the whole day fell through to the id,
   * which is a random uuid. `statementOrder` counts up with time, so the ledger
   * sorts it descending like the date.
   */
  it('lists a day in the statement\'s order, newest of the day first', () => {
    const rows = [
      txn('a', -870, '2026-01-02', 'zzz'),
      txn('a', -949, '2026-01-02', 'aaa'),
      txn('a', -50_568, '2026-01-02', 'mmm'),
    ]
    // As the file had them: union first, then Amazon, then the Amex payment.
    rows[0].statementOrder = 0
    rows[1].statementOrder = 1
    rows[2].statementOrder = 2

    expect([...rows].sort(byLedger).map((r) => r.amountMinor)).toEqual([-50_568, -949, -870])

    // And the balances still read the other way: the earliest row of the day is
    // the opening balance less its own amount.
    const out = runningBalances([a], rows)
    expect(out.get(rows[0].id)).toBe(a.openingBalanceMinor - 870)
    expect(out.get(rows[1].id)).toBe(a.openingBalanceMinor - 870 - 949)
  })

  it('falls back to the stamp where only one row came from a file', () => {
    // A row typed by hand has no position in anybody's statement, and a number
    // on the other row is not evidence about it.
    const typed = txn('a', -100, '2026-01-02', 'aaa')
    const imported = { ...txn('a', -200, '2026-01-02', 'zzz'), statementOrder: 5 }
    expect([...[typed, imported]].sort(byLedger).map((r) => r.id)).toEqual(['zzz', 'aaa'])
  })

  it('steps in the order Activity lists, even when every stamp is identical', () => {
    const rows = [
      txn('a', -870, '2026-01-02', 'zzz'),
      txn('a', -949, '2026-01-02', 'aaa'),
      txn('a', -50_568, '2026-01-02', 'mmm'),
    ]
    const listed = [...rows].sort(byLedger)
    const out = runningBalances([a], rows)

    // The bottom row of the day is its earliest: the opening balance, less it.
    const bottom = listed[listed.length - 1]
    expect(out.get(bottom.id)).toBe(a.openingBalanceMinor + bottom.amountMinor)

    // And every row above differs from the one below by exactly its own amount.
    for (let i = listed.length - 2; i >= 0; i--) {
      expect(out.get(listed[i].id)).toBe(out.get(listed[i + 1].id)! + listed[i].amountMinor)
    }
  })

  it('reads in the ledger order, oldest first, whatever order it was handed', () => {
    const rows = [txn('a', 1_000, '2026-01-03'), txn('a', -2_000, '2026-01-02')]
    const out = runningBalances([a], rows)
    expect(out.get(rows[1].id)).toBe(8_000)
    expect(out.get(rows[0].id)).toBe(9_000)
  })

  /**
   * A published household row is readable without its account being — there is
   * no opening balance and no other row on it to add up, so a figure here would
   * be the sum of the one row we happen to hold, dressed as a balance.
   */
  it('says nothing about an account this device does not hold', () => {
    const rows = [txn('elsewhere', -900, '2026-01-02')]
    expect(runningBalances([a], rows).has(rows[0].id)).toBe(false)
  })
})

describe('accountFace', () => {
  const base = { kind: 'current' as const, slot: undefined, icon: undefined, color: undefined, ink: undefined }

  it('derives a face from the type when nobody has chosen one', () => {
    // The state this feature exists to remove: a raw `account.slot` read is
    // undefined on the common case and paints the badge grey.
    expect(accountFace(base)).toEqual({ slot: 1, icon: 'bank', color: undefined, ink: undefined })
    expect(accountFace({ ...base, kind: 'savings' }).icon).toBe('piggy')
    expect(accountFace({ ...base, kind: 'credit' }).icon).toBe('card')
  })

  it('never derives a colour or a mark from the type', () => {
    // The derived faces are palette slots, and the palette is the one thing
    // whose ink can always be measured — so there is nothing to derive, and a
    // derived override would be a decision nobody made.
    for (const kind of ['current', 'savings', 'credit', 'cash'] as const) {
      expect(accountFace({ ...base, kind }).color).toBeUndefined()
      expect(accountFace({ ...base, kind }).ink).toBeUndefined()
    }
  })

  it('carries a chosen colour and mark through unchanged', () => {
    const face = accountFace({ ...base, slot: 5, icon: 'bankOfScotland', color: '#0a2d5e', ink: '#ffffff' })
    expect(face).toEqual({ slot: 5, icon: 'bankOfScotland', color: '#0a2d5e', ink: '#ffffff' })
  })
})
