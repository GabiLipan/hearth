import { describe, expect, it } from 'vitest'
import { format, subDays } from 'date-fns'
import type { Goal, Transaction } from './db'
import { goalProgress } from './goals'

const day = (offset: number) => format(subDays(new Date(), offset), 'yyyy-MM-dd')

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g',
  name: 'Holiday',
  icon: 'plane',
  slot: 9,
  targetMinor: 100_000,
  sortOrder: 0,
  updatedAt: 'x',
  ...over,
})

const funding = (amountMinor: number, date: string, goalId = 'g'): Transaction => ({
  id: `t${date}${amountMinor}`,
  accountId: 'a',
  goalId,
  date,
  payee: 'Transfer',
  amountMinor,
  createdAt: 'x',
  updatedAt: 'x',
})

describe('goalProgress', () => {
  it('sums only the transactions tagged with this goal', () => {
    const p = goalProgress(goal(), [
      funding(20_000, day(10)),
      funding(5_000, day(5), 'other'),
    ])
    expect(p.savedMinor).toBe(20_000)
    expect(p.remainingMinor).toBe(80_000)
    expect(p.fraction).toBeCloseTo(0.2)
  })

  describe('the pace mark', () => {
    it('is undefined without a deadline', () => {
      expect(goalProgress(goal(), [funding(20_000, day(10))]).elapsed).toBeUndefined()
    })

    it('is undefined before any money has gone in', () => {
      // Nothing has been contributed, so there is no start to measure from —
      // and inventing one from today would put the mark at zero on a goal that
      // may have been sitting there for months.
      expect(goalProgress(goal({ targetDate: day(-100) }), []).elapsed).toBeUndefined()
    })

    it('runs from the FIRST contribution to the target date', () => {
      // Started 30 days ago, due in 30 more: half way through the period.
      const p = goalProgress(goal({ targetDate: day(-30) }), [
        funding(10_000, day(20)),
        funding(10_000, day(30)),
        funding(10_000, day(5)),
      ])
      expect(p.elapsed).toBeCloseTo(0.5, 2)
    })

    it('is undefined once the deadline has passed', () => {
      // Past the date the mark would sit off the end of the bar, and the
      // sentence beside it already says so.
      const p = goalProgress(goal({ targetDate: day(1) }), [funding(10_000, day(30))])
      expect(p.elapsed).toBeUndefined()
      expect(p.behind).toBe(true)
    })

    it('is undefined when the deadline is the day saving started', () => {
      // A zero-length period would divide by zero.
      expect(goalProgress(goal({ targetDate: day(0) }), [funding(10_000, day(0))]).elapsed).toBeUndefined()
    })
  })

  it('reports a fully funded goal as neither behind nor short', () => {
    const p = goalProgress(goal({ targetDate: day(-30) }), [funding(100_000, day(10))])
    expect(p.remainingMinor).toBe(0)
    expect(p.behind).toBe(false)
    expect(p.neededPerMonthMinor).toBe(0)
  })
})
