import { describe, expect, it } from 'vitest'
import { format, subDays } from 'date-fns'
import type { Goal, GoalEntry } from './db'
import { accountAllocation, goalProgress, shortfall } from './goals'

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

const funding = (amountMinor: number, date: string, goalId = 'g'): GoalEntry => ({
  id: `e${date}${amountMinor}`,
  goalId,
  date,
  amountMinor,
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

describe('what an account\'s goals have claimed', () => {
  const deposit = goal({ id: 'deposit', name: 'House deposit', accountId: 'savings', targetMinor: 1000000 })
  const car = goal({ id: 'car', name: 'New car', accountId: 'savings', targetMinor: 500000 })
  const holiday = goal({ id: 'holiday', name: 'Holiday', accountId: 'current', targetMinor: 200000 })
  const goals = [deposit, car, holiday]
  const entries = [
    funding(200000, '2026-03-01', 'deposit'),
    funding(50000, '2026-03-02', 'car'),
    funding(20000, '2026-03-03', 'holiday'),
  ]

  it('counts only the goals sitting on that account', () => {
    const a = accountAllocation('savings', goals, entries, 300000)
    expect(a.goals.map((r) => r.goal.id)).toEqual(['deposit', 'car'])
    expect(a.assignedMinor).toBe(250000)
    expect(a.unassignedMinor).toBe(50000)
  })

  it('needs no money to have moved', () => {
    // The whole point: the balance is an opening figure with no transactions
    // behind it and the pot is full all the same.
    expect(accountAllocation('savings', goals, [funding(300000, '2026-03-01', 'deposit')], 300000).unassignedMinor).toBe(0)
  })

  it('lists the pots largest first, which is the order money comes off them', () => {
    expect(accountAllocation('savings', goals, entries, 300000).goals[0].goal.id).toBe('deposit')
  })

  it('reports an over-claim rather than clamping it', () => {
    // A figure that can only be one sign hides the case where it is wrong.
    expect(accountAllocation('savings', goals, entries, 100000).unassignedMinor).toBe(-150000)
  })
})

describe('when the money has left the account', () => {
  const big = goal({ id: 'big', accountId: 'a', targetMinor: 1000000 })
  const small = goal({ id: 'small', accountId: 'a', targetMinor: 1000000 })
  const goals = [big, small]
  const entries = [funding(200000, '2026-03-01', 'big'), funding(100000, '2026-03-01', 'small')]

  it('takes nothing while the account still covers the pots', () => {
    expect(shortfall(accountAllocation('a', goals, entries, 300000)).size).toBe(0)
    expect(shortfall(accountAllocation('a', goals, entries, 400000)).size).toBe(0)
  })

  it('spends what is unassigned before it touches a pot', () => {
    // £3,500 in the account against £3,000 claimed, then £800 leaves: £500 was
    // spare, so only £300 falls on a pot.
    const out = shortfall(accountAllocation('a', goals, entries, 350000 - 80000))
    expect(out.get('big')).toBe(30000)
    expect(out.has('small')).toBe(false)
  })

  it('takes it from the largest pot', () => {
    const out = shortfall(accountAllocation('a', goals, entries, 250000))
    expect(out.get('big')).toBe(50000)
    expect(out.has('small')).toBe(false)
  })

  it('moves on to the next largest once the first is empty', () => {
    const out = shortfall(accountAllocation('a', goals, entries, 50000))
    expect(out.get('big')).toBe(200000)
    expect(out.get('small')).toBe(50000)
  })

  it('never takes more than a pot holds', () => {
    const out = shortfall(accountAllocation('a', goals, entries, -100000))
    expect(out.get('big')).toBe(200000)
    expect(out.get('small')).toBe(100000)
  })
})

describe('the pace mark, now that a pot can go down as well as up', () => {
  it('starts the clock at the first thing PUT IN, not the first entry', () => {
    // A release is not the day somebody began saving, and on a pot whose first
    // event was money leaving the account it would put the start after the mark.
    const g = goal({ targetDate: day(-30) })
    const p = goalProgress(g, [funding(-5000, day(90)), funding(20000, day(60))])
    expect(p.savedMinor).toBe(15000)
  })
})
