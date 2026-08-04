import { describe, expect, it } from 'vitest'
import type { Budget } from './db'
import { budgetSeries, cumulativeDrift, fillBudgets, typicalRange } from './budgetHistory'

/**
 * The regression this file exists for.
 *
 * The Budgets page drew six months of spending against a single budget — the
 * one for the month you were looking at. A month you budgeted £300 and spent
 * £340 rendered as comfortably under whenever today's budget was £450, and a
 * month you kept to a generous budget rendered as an overspend once you
 * tightened it. Budgets have belonged to a month since migration 04; the whole
 * point of these helpers is that each month is judged against its own.
 */

const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']
const HOUSEHOLD = () => true

function budget(categoryId: string, month: string, amountMinor: number, ownerId?: string): Budget {
  return { id: `${categoryId}-${month}`, categoryId, month: `${month}-01`, amountMinor, ownerId, updatedAt: month }
}

describe('budgetSeries', () => {
  it('reads the budget in force for each month, not the latest one', () => {
    const budgets = [
      budget('groceries', '2026-03', 30000),
      budget('groceries', '2026-06', 45000),
      budget('groceries', '2026-08', 45000),
    ]
    expect(budgetSeries(budgets, 'groceries', MONTHS, HOUSEHOLD)).toEqual([30000, null, null, 45000, null, 45000])
  })

  it('ignores other categories and rows the scope does not own', () => {
    const budgets = [
      budget('groceries', '2026-03', 30000),
      budget('dining', '2026-03', 12000),
      budget('groceries', '2026-04', 99900, 'partner'),
    ]
    const series = budgetSeries(budgets, 'groceries', MONTHS, (b) => !b.ownerId)
    expect(series).toEqual([30000, null, null, null, null, null])
  })
})

describe('fillBudgets', () => {
  it('fills a gap with the median of the months that do have a budget', () => {
    const { amounts, inferred, usable } = fillBudgets([30000, null, 30000, 45000, null, 45000], MONTHS.map(() => 0))
    expect(amounts).toEqual([30000, 37500, 30000, 45000, 37500, 45000])
    expect(inferred).toEqual([false, true, false, false, true, false])
    expect(usable).toBe(true)
  })

  it('falls back to typical spending when a category has never been budgeted', () => {
    // typicalSpend medians the non-zero months and rounds to the pound.
    const { amounts, inferred } = fillBudgets(MONTHS.map(() => null), [20000, 22000, 0, 24000, 20000, 21000])
    expect(new Set(amounts)).toEqual(new Set([21000]))
    expect(inferred.every(Boolean)).toBe(true)
  })

  it('reports itself unusable when there is neither a budget nor any spending', () => {
    expect(fillBudgets(MONTHS.map(() => null), MONTHS.map(() => 0)).usable).toBe(false)
  })
})

describe('cumulativeDrift', () => {
  it('judges each month against its own budget', () => {
    // £340 against a £300 budget is over; £410 against £450 is under. Judged
    // against August's £450 alone, the first month would have looked fine.
    const drift = cumulativeDrift([34000, 41000], [30000, 45000])
    expect(drift).toEqual([4000, 0])
  })

  it('runs as a total, so an overspend clawed back returns to zero', () => {
    const drift = cumulativeDrift([20000, 10000], [10000, 20000])
    expect(drift).toEqual([10000, 0])
  })

  it('ends at the half-year balance', () => {
    const spend = [34000, 28000, 31500, 41000, 45500, 39500]
    const budgets = [30000, 30000, 30000, 45000, 45000, 45000]
    const drift = cumulativeDrift(spend, budgets)
    const total = spend.reduce((s, v) => s + v, 0) - budgets.reduce((s, v) => s + v, 0)
    expect(drift[drift.length - 1]).toBe(total)
  })
})

describe('typicalRange', () => {
  it('spans the months that had spending', () => {
    expect(typicalRange([20000, 25000, 22000])).toEqual([20000, 25000])
  })

  it('drops untouched months rather than dragging the floor to zero', () => {
    expect(typicalRange([0, 20000, 25000])).toEqual([20000, 25000])
  })

  it('says nothing when there is only one month to go on', () => {
    expect(typicalRange([0, 0, 20000])).toBeUndefined()
  })
})
