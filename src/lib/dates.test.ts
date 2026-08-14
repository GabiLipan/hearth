import { describe, expect, it } from 'vitest'
import { differenceInCalendarDays, parseISO } from 'date-fns'
import { dateWindow } from './dates'

/**
 * The window is what makes the duplicate check and the transfer picker indexed
 * queries rather than full scans, so it has to be at least as wide as the rules
 * that read from it — a window one day short silently stops finding pairs the
 * matcher would still accept, and nothing would fail loudly.
 */
describe('dateWindow', () => {
  it('reaches exactly as far as it is asked to, both ways', () => {
    const [from, to] = dateWindow('2026-06-15', 3)
    expect(from).toBe('2026-06-12')
    expect(to).toBe('2026-06-18')
  })

  it('crosses a month end', () => {
    expect(dateWindow('2026-03-01', 3)).toEqual(['2026-02-26', '2026-03-04'])
  })

  it('crosses a year end', () => {
    expect(dateWindow('2026-01-02', 10)).toEqual(['2025-12-23', '2026-01-12'])
  })

  it('crosses a leap day', () => {
    expect(dateWindow('2028-03-01', 1)).toEqual(['2028-02-29', '2028-03-02'])
  })

  it('sorts lexicographically in date order, which is what makes it usable as an index range', () => {
    const [from, to] = dateWindow('2026-01-02', 10)
    expect(from < to).toBe(true)
    expect('2025-12-31' >= from && '2025-12-31' <= to).toBe(true)
    expect('2026-01-13' <= to).toBe(false)
  })

  it('admits every date the matchers accept, at the boundary', () => {
    // `findLikelyDuplicate` keeps gaps <= 3; `findTransferCandidates` <= 10.
    for (const days of [3, 10]) {
      const [from, to] = dateWindow('2026-06-15', days)
      for (const edge of [from, to]) {
        expect(Math.abs(differenceInCalendarDays(parseISO(edge), parseISO('2026-06-15')))).toBe(days)
      }
    }
  })
})
