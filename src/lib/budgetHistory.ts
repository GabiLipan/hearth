import type { Budget } from './db'
import { typicalSpend } from './stats'

/**
 * The budget history behind the Budgets page charts.
 *
 * The old sparkline compared six months of spending against a single number —
 * the budget for the month you happened to be looking at — so a month you
 * budgeted £300 and spent £340 rendered as comfortably under if today's budget
 * were £450. Budgets have belonged to a month since migration 04; these helpers
 * read the budget that was actually in force for each month.
 */

/** A budget per month, `null` where none was ever set. Owner-scoped by the caller's predicate. */
export function budgetSeries(
  budgets: Budget[],
  categoryId: string,
  months: string[],
  owned: (b: Budget) => boolean,
): (number | null)[] {
  const byMonth = new Map<string, number>()
  for (const b of budgets) {
    if (b.categoryId !== categoryId || !owned(b)) continue
    byMonth.set(b.month, b.amountMinor)
  }
  return months.map((m) => byMonth.get(`${m}-01`) ?? null)
}

export interface FilledBudgets {
  amounts: number[]
  /** True where the amount was assumed rather than set. */
  inferred: boolean[]
  /** False when there was nothing at all to go on — no budget, no spending. */
  usable: boolean
}

/**
 * Fill the months with no budget set.
 *
 * A gap becomes the median of the months that *do* have one, so a category
 * budgeted from May onwards is still judged against something sensible in
 * April. With no budget ever set we fall back to `typicalSpend` over the
 * category's own history — the same figure the page offers as a suggestion, so
 * an assumed baseline agrees with what it would tell you to set.
 */
export function fillBudgets(series: (number | null)[], spend: number[]): FilledBudgets {
  const known = series.filter((v): v is number => v !== null)
  let fallback: number | undefined
  if (known.length > 0) {
    const sorted = [...known].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    fallback = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  } else {
    fallback = typicalSpend(spend)
  }
  if (fallback === undefined) return { amounts: series.map(() => 0), inferred: series.map(() => true), usable: false }
  return {
    amounts: series.map((v) => v ?? fallback),
    inferred: series.map((v) => v === null),
    usable: true,
  }
}

/**
 * Running total of overspend minus underspend, starting from zero.
 *
 * Returns one point per month; each uses that month's own budget, which is what
 * makes the zero line an honest reference rather than a snapshot of today.
 */
export function cumulativeDrift(spend: number[], budgets: number[]): number[] {
  let running = 0
  return spend.map((v, i) => (running += v - (budgets[i] ?? 0)))
}

/**
 * The range a category normally spends in, for the bullet's context band.
 *
 * Months with no spending at all are dropped rather than dragging the floor to
 * zero — a category you did not touch in March says nothing about what is
 * normal for it.
 */
export function typicalRange(history: number[]): [number, number] | undefined {
  const spent = history.filter((v) => v > 0)
  if (spent.length < 2) return undefined
  return [Math.min(...spent), Math.max(...spent)]
}
