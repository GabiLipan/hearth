import { describe, expect, it } from 'vitest'
import { format, subDays } from 'date-fns'
import type { Transaction } from './db'
import { accountFace, balanceHistory } from './accounts'

const day = (offset: number) => format(subDays(new Date(), offset), 'yyyy-MM-dd')

const txn = (accountId: string, amountMinor: number, date: string): Transaction => ({
  id: `${accountId}${date}${amountMinor}`,
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
