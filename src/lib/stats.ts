import type { Category, Transaction } from './db'
import { budgetCategoryId, styleOf } from './categories'
import { monthKey, shiftMonth, thisMonthKey, monthLabel } from './dates'
// `bookedMonth`, not `monthKey`, wherever a row is being put IN a month: a row
// somebody has moved counts where they said. `monthKey` stays for questions
// about the calendar itself, like how far back the history runs.
import { bookedMonth } from './books'

/**
 * Moving your own money between accounts is neither spending nor income, so
 * both legs of a transfer are excluded from every total on this page.
 */
export const isTransfer = (t: Transaction) => t.transferId != null

export const OTHER_SLICE_ID = '__other__'

export interface CategorySlice {
  categoryId: string
  name: string
  icon: string
  slot: number
  /**
   * The category's own colour, where it has been given one. Carried on the
   * slice rather than looked up again by the chart: a chart resolves a slot
   * through `useChartColors`, which knows about the twelve tokens and nothing
   * about a row — so a colour that did not travel with the figure would show on
   * the badge and not in the ring beside it.
   */
  color?: string
  totalMinor: number // positive spend
  fraction: number
}

/** Spend per expense category for one month, largest first, small tail folded into "Other". */
export function spendByCategory(txns: Transaction[], categories: Category[], month: string, maxSlices = 7): CategorySlice[] {
  const catMap = new Map(categories.map((c) => [c.id, c]))
  const totals = new Map<string, number>()
  for (const t of txns) {
    // A transaction can point at a category this device has not pulled yet, or
    // one the other person deleted; it simply does not count towards a slice.
    if (t.amountMinor >= 0 || !t.categoryId || isTransfer(t) || bookedMonth(t) !== month) continue
    const cat = catMap.get(t.categoryId)
    if (!cat || cat.kind !== 'expense') continue
    // Subcategory spending rolls up: "Insurance" shows under "Home & utilities".
    const key = budgetCategoryId(cat)!
    totals.set(key, (totals.get(key) ?? 0) - t.amountMinor)
  }
  const grand = [...totals.values()].reduce((s, v) => s + v, 0)
  if (grand === 0) return []
  const slices: CategorySlice[] = [...totals.entries()]
    .map(([categoryId, totalMinor]) => {
      const c = catMap.get(categoryId)!
      const style = styleOf(c, catMap)
      return {
        categoryId,
        name: c.name,
        icon: style.icon,
        slot: style.slot,
        color: style.color,
        totalMinor,
        fraction: totalMinor / grand,
      }
    })
    .sort((a, b) => b.totalMinor - a.totalMinor)
  if (slices.length <= maxSlices) return slices
  const head = slices.slice(0, maxSlices - 1)
  const tail = slices.slice(maxSlices - 1)
  const tailTotal = tail.reduce((s, v) => s + v.totalMinor, 0)
  head.push({ categoryId: OTHER_SLICE_ID, name: 'Other', icon: 'package', slot: 0, totalMinor: tailTotal, fraction: tailTotal / grand })
  return head
}

export interface MonthPoint {
  key: string
  label: string
  spend: number // positive minor units
  income: number
  net: number
  /**
   * A month that has not finished yet.
   *
   * The current month is a part-month, and on the 3rd it is a very small part
   * of one. Plotted beside eleven finished months it reads as a collapse in
   * spending rather than as a month that has barely started, so everything
   * drawing a series has to be able to tell the two apart.
   */
  partial?: boolean
}

/** Aggregate the last n months (oldest first). */
export function monthlySeries(txns: Transaction[], categories: Category[], n: number): MonthPoint[] {
  const kinds = new Map(categories.map((c) => [c.id, c.kind]))
  const now = thisMonthKey()
  const keys: string[] = []
  for (let i = n - 1; i >= 0; i--) keys.push(shiftMonth(now, -i))
  const byKey = new Map(keys.map((k) => [k, { spend: 0, income: 0 }]))
  for (const t of txns) {
    if (isTransfer(t)) continue
    const k = bookedMonth(t)
    const agg = byKey.get(k)
    if (!agg) continue
    if (t.amountMinor < 0) agg.spend -= t.amountMinor
    // Only a category marked as income counts as income. The two branches here
    // used to have identical bodies, which meant ANY credit did: a refund, a
    // cashback, and — worst — the incoming leg of a transfer nobody had linked
    // yet, which inflated income by money that was only ever moved.
    else if (t.categoryId && kinds.get(t.categoryId) === 'income') agg.income += t.amountMinor
  }
  return keys.map((key) => {
    const { spend, income } = byKey.get(key)!
    return { key, label: monthLabel(key, 'short'), spend, income, net: income - spend }
  })
}

/** Total spent / earned within a month. */
export function monthTotals(txns: Transaction[], month: string) {
  let spend = 0
  let income = 0
  for (const t of txns) {
    if (isTransfer(t) || bookedMonth(t) !== month) continue
    if (t.amountMinor < 0) spend -= t.amountMinor
    else income += t.amountMinor
  }
  return { spend, income, net: income - spend }
}

/**
 * Spend per budget-category for each of the given months, in the order given.
 *
 * Subcategories roll up to their parent, transfers are excluded, and a month
 * with no spending is a zero rather than a gap — a sparkline with holes in it
 * reads as missing data rather than as a quiet month.
 *
 * **Flow-blind, and no longer used by any screen.** Use
 * `bookMonthlySpendByCategory` in books.ts instead.
 *
 * "Negative and not a transfer" is not the same question as "spending in this
 * book", and the two come apart on exactly the row that is hardest to reason
 * about: household shopping bought off a personal card is spending in the
 * household's book while living in an account outside it, and this counts it
 * wherever the rows happen to come from. The Budgets page used this for its
 * six-month "typical" while computing the current month with `isSpend`, so the
 * two columns beside each other were computed by two different rules.
 *
 * Kept because `categories.test.ts` uses it to check the subcategory rollup,
 * which is the one thing here that is not about books.
 */
export function monthlySpendByCategory(
  txns: Transaction[],
  categories: Category[],
  months: string[],
): Map<string, number[]> {
  const catMap = new Map(categories.map((c) => [c.id, c]))
  const index = new Map(months.map((m, i) => [m, i]))
  const out = new Map<string, number[]>()

  for (const t of txns) {
    if (t.amountMinor >= 0 || !t.categoryId || isTransfer(t)) continue
    const i = index.get(bookedMonth(t))
    if (i === undefined) continue
    const key = budgetCategoryId(catMap.get(t.categoryId))
    if (!key) continue
    let series = out.get(key)
    if (!series) {
      series = months.map(() => 0)
      out.set(key, series)
    }
    series[i] -= t.amountMinor
  }
  return out
}

/**
 * A typical month's spend for a category: the median of the months given,
 * rounded to the nearest pound.
 *
 * Median rather than mean because one annual insurance payment should not drag
 * the suggestion up for the other eleven months. Returns undefined when there
 * is not enough history to be worth suggesting from.
 */
export function typicalSpend(series: number[] | undefined): number | undefined {
  const months = (series ?? []).filter((v) => v > 0)
  if (months.length < 2) return undefined
  const sorted = [...months].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  return Math.round(median / 100) * 100
}

/** The n month keys ending at `month`, oldest first. */
export function monthsEndingAt(month: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => shiftMonth(month, -(n - 1 - i)))
}

/**
 * How many months of history there actually are, ending at `month`.
 *
 * What a chart that scrolls needs: the window is what the toggle says, and this
 * is how far back there is anything to scroll TO. Building the series over a
 * fixed thirty-six months instead would draw two years of empty bars for a
 * household that started in March, which reads as two years of spending nothing.
 *
 * Capped, because the series is recomputed on every change and nobody scrolls
 * back five years; and floored at one, because a book with no rows in it still
 * has to draw an axis.
 */
export function monthsOfHistory(
  txns: { date: string }[],
  endingAt = thisMonthKey(),
  cap = 36,
): number {
  let earliest: string | undefined
  for (const t of txns) {
    const k = monthKey(t.date)
    if (k > endingAt) continue
    if (!earliest || k < earliest) earliest = k
  }
  if (!earliest) return 1
  const [ey, em] = earliest.split('-').map(Number)
  const [ly, lm] = endingAt.split('-').map(Number)
  const months = (ly - ey) * 12 + (lm - em) + 1
  return Math.max(1, Math.min(cap, months))
}
