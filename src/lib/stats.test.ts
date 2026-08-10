import { describe, it, expect } from 'vitest'
import { monthsOfHistory } from './stats'

const on = (date: string) => ({ date })

describe('monthsOfHistory', () => {
  it('counts inclusively from the earliest month to the last', () => {
    expect(monthsOfHistory([on('2026-03-04'), on('2026-05-30')], '2026-05')).toBe(3)
  })

  it('crosses a year boundary', () => {
    expect(monthsOfHistory([on('2025-11-02')], '2026-02')).toBe(4)
  })

  it('ignores rows dated after the month in view', () => {
    // A future-dated row must not stretch the axis backwards from a month that
    // has not happened.
    expect(monthsOfHistory([on('2026-04-01'), on('2027-01-01')], '2026-05')).toBe(2)
  })

  it('gives an empty book an axis rather than nothing', () => {
    expect(monthsOfHistory([], '2026-05')).toBe(1)
    expect(monthsOfHistory([on('2030-01-01')], '2026-05')).toBe(1)
  })

  it('stops at the cap, because nobody scrolls back five years', () => {
    expect(monthsOfHistory([on('2010-01-01')], '2026-05')).toBe(36)
    expect(monthsOfHistory([on('2010-01-01')], '2026-05', 12)).toBe(12)
  })
})
