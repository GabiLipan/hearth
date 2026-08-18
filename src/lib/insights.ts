import type { Account, Category, Transaction } from './db'
import { budgetCategoryId, styleOf } from './categories'
import { monthKey, monthLabel, shiftMonth, todayISO } from './dates'
import { matchKey, normalizePayee, payeeSimilar, prettyPayee } from './rules'
import {
  accountsInBook,
  bookTotals,
  effectiveMonth,
  spendsIn,
  type BookId,
  type BookMap,
  type Flow,
} from './books'

/**
 * The arithmetic behind the report views that are not a donut.
 *
 * Kept out of books.ts, which is the model — what an account is, what a
 * transaction means, what a month came to. Everything here is a QUESTION asked
 * of that model, and questions come and go. The dividing line has held once
 * already: `bookSpendByCategory` lives in books.ts because the donut and the
 * budgets both need it, and none of these are load-bearing in that way.
 *
 * Every function takes the flows map rather than recomputing it. Classification
 * is O(all transactions) and needs an index of transfer legs, so seven views
 * each classifying for themselves would be seven full passes on every render.
 */

/* ---------- 1. Where the household's money went, in steps ---------- */

export interface WaterfallStep {
  key: string
  label: string
  /** Signed: the change this step makes. */
  deltaMinor: number
  /** The running total after this step. */
  runningMinor: number
  /** A total rather than a movement — drawn from the axis, not floating. */
  total?: boolean
}

/**
 * Contributions in → household spending → money moved to savings → what is
 * still in the current account.
 *
 * The one view that says what actually happened to the money, in the order it
 * happened, rather than as three figures you have to subtract in your head.
 *
 * "To savings" is a movement WITHIN the household book, which every other
 * aggregate in the app correctly treats as a non-event — `classifyFlows` calls
 * it `internal`. It is an event here because the question is different: not
 * "what did the household earn and spend" but "where did the money end up",
 * and money in the savings account ended up somewhere different from money in
 * the current account.
 */
export function householdWaterfall(
  txns: Transaction[],
  flows: Map<string, Flow>,
  books: BookMap,
  accounts: Account[],
  month: string,
): WaterfallStep[] {
  const totals = bookTotals(txns, flows, 'household', month, books)
  const savings = new Set(
    accounts.filter((a) => a.kind === 'savings' && books.household.has(a.id)).map((a) => a.id),
  )

  let toSavings = 0
  for (const t of txns) {
    // The arriving leg only: the pair nets to zero across the book, so counting
    // both would show nothing moving at all.
    if (!savings.has(t.accountId) || t.amountMinor <= 0) continue
    if (flows.get(t.id) !== 'internal') continue
    if (monthKey(t.date) !== month) continue
    toSavings += t.amountMinor
  }

  const steps: WaterfallStep[] = []
  let running = 0

  const push = (key: string, label: string, deltaMinor: number, total?: boolean) => {
    running += deltaMinor
    steps.push({ key, label, deltaMinor, runningMinor: running, total })
  }

  push('in', 'Paid in', totals.contributions + totals.externalIncome)
  push('spend', 'Spent', -totals.spend)
  // Withdrawals only appear once somebody has linked them; unlinked they are
  // still sitting inside "Spent", which is what the unexplained note is about.
  if (totals.withdrawn > 0) push('out', 'Taken back out', -totals.withdrawn)
  push('savings', 'Moved to savings', -toSavings)
  push('left', 'Left in current', 0, true)

  return steps
}

/* ---------- 2. What a salary turned into ---------- */

export interface SalaryBar {
  key: string
  label: string
  partial: boolean
  /** Moved to the household. Positive. */
  contributedMinor: number
  /** Spent on myself. Positive. */
  spentMinor: number
  /** Still sitting in my account. Positive; zero where the month went negative. */
  leftMinor: number
  /** What the three are shares of. */
  earnedMinor: number
}

/**
 * `contributed | personal spend | left over` — one bar per month, and the bar
 * IS the salary.
 *
 * A stack rather than three lines because the interesting thing is the
 * proportion: whether the share going to the household is steady, and whether
 * what is left is growing. Three separate series answer "how much" and make you
 * do the division yourself.
 *
 * A month that went negative — spending more than came in — has nothing left
 * over rather than a negative slice, because a stack cannot draw one without
 * lying about the total. The three parts then exceed the bar, which is honest:
 * more went out than came in.
 */
export function salaryBars(
  txns: Transaction[],
  flows: Map<string, Flow>,
  books: BookMap,
  months: string[],
): SalaryBar[] {
  const now = monthKey(todayISO())
  return months.map((key) => {
    const t = bookTotals(txns, flows, 'mine', key, books)
    return {
      key,
      label: monthLabel(key, 'short'),
      partial: key === now,
      contributedMinor: t.contributed,
      spentMinor: t.spend,
      leftMinor: Math.max(0, t.income - t.spend - t.contributed - t.withdrawn),
      earnedMinor: t.income,
    }
  })
}

/* ---------- 3. What we are committed to, against what we choose ---------- */

export interface FixedVariable {
  key: string
  label: string
  partial: boolean
  /** Spending recorded against a tracked bill. Positive. */
  fixedMinor: number
  /** Everything else. Positive. */
  variableMinor: number
}

/**
 * Tracked bills against everything else, per month.
 *
 * The question underneath it is "how much of this could we actually change if
 * we had to", and the answer is only as good as the bills that are tracked —
 * an untracked direct debit counts as variable and is nothing of the sort. That
 * is a real limitation and the screen says so rather than this pretending
 * otherwise.
 */
export function fixedVsVariable(
  txns: Transaction[],
  flows: Map<string, Flow>,
  book: BookId,
  books: BookMap,
  months: string[],
): FixedVariable[] {
  const ids = accountsInBook(book, books)
  const now = monthKey(todayISO())
  const byMonth = new Map(months.map((m) => [m, { fixedMinor: 0, variableMinor: 0 }]))

  for (const t of txns) {
    const flow = flows.get(t.id)
    if (!spendsIn(flow, book, t.accountId, ids)) continue
    const bucket = byMonth.get(effectiveMonth(t, flow))
    if (!bucket) continue
    if (t.billId) bucket.fixedMinor -= t.amountMinor
    else bucket.variableMinor -= t.amountMinor
  }

  return months.map((key) => ({
    key,
    label: monthLabel(key, 'short'),
    partial: key === now,
    ...byMonth.get(key)!,
  }))
}

/* ---------- 4. How much we are keeping ---------- */

export interface SavingsRatePoint {
  key: string
  label: string
  partial: boolean
  /** 0–1, or null for a month with nothing coming in. */
  rate: number | null
  savedMinor: number
  incomeMinor: number
}

/**
 * What share of what came in did not go out again.
 *
 * `null` rather than zero for a month with no income. A rate is a fraction of
 * something, and a month with nothing coming in has no denominator — plotting
 * it as 0% would draw a collapse where there is only an absence, which is the
 * same mistake as drawing a part-finished month solid.
 */
export function savingsRate(
  txns: Transaction[],
  flows: Map<string, Flow>,
  book: BookId,
  books: BookMap,
  months: string[],
): SavingsRatePoint[] {
  const now = monthKey(todayISO())
  return months.map((key) => {
    const t = bookTotals(txns, flows, book, key, books)
    // On the personal book, money moved to the household has not been spent,
    // but it is not saved BY ME either — it left. `net` already has it out.
    const saved = t.net
    return {
      key,
      label: monthLabel(key, 'short'),
      partial: key === now,
      rate: t.income > 0 ? saved / t.income : null,
      savedMinor: saved,
      incomeMinor: t.income,
    }
  })
}

/* ---------- 5. Where the money actually goes ---------- */

export interface PayeeTotal {
  payee: string
  totalMinor: number
  count: number
  /** The category most of it was filed under, for the colour. */
  slot: number
  /** That category's own colour, where it has one. Overrides `slot`. */
  color?: string
  icon: string
}

/**
 * Spending grouped by who it went to, under the category level.
 *
 * Grouped with `payeeSimilar`, not by exact normalised string. That matters:
 * `normalizePayee` strips the long reference numbers, so "TESCO STORES 3456"
 * and "TESCO STORES 9912" already collapse — but "TESCO EXPRESS" does not, and
 * every other feature in the app (duplicate detection, bulk recategorisation,
 * transfer pairing) would call those the same merchant. A top-payee list that
 * disagreed with the categoriser about what a payee IS would be a list nobody
 * could act on.
 *
 * The cost is a clustering pass rather than a map lookup, and an answer that
 * depends on the order rows arrive in. Both are acceptable here: one month is a
 * few hundred rows against a few dozen groups, and the row order is the stable
 * one the caller already has. The exact-string map in front of it means the
 * fuzzy comparison runs once per distinct payee, not once per transaction.
 */
export function topPayees(
  txns: Transaction[],
  flows: Map<string, Flow>,
  categories: Category[],
  book: BookId,
  books: BookMap,
  month: string,
  limit = 10,
): PayeeTotal[] {
  const ids = accountsInBook(book, books)
  const catMap = new Map(categories.map((c) => [c.id, c]))

  interface Group {
    /** The shortest normalised form seen — the most generic, so "tesco" beats "tesco express". */
    key: string
    raw: string
    /** The label is a name somebody typed, so it is printed as they typed it. */
    verbatim: boolean
    totalMinor: number
    count: number
    cats: Map<string, number>
  }
  const groups: Group[] = []
  const seen = new Map<string, Group>()

  for (const t of txns) {
    const flow = flows.get(t.id)
    if (!spendsIn(flow, book, t.accountId, ids)) continue
    if (effectiveMonth(t, flow) !== month) continue

    // A row added by hand may have no reference at all, and there its name is
    // the only identity it has — grouping on the payee alone would collect
    // every such row of the month into one blank "payee".
    const source = matchKey(t)
    const verbatim = !t.payee.trim()
    const key = normalizePayee(source) || source.toLowerCase()
    let g = seen.get(key)
    if (!g) {
      g = groups.find((x) => payeeSimilar(x.key, key))
      if (g) {
        // The more generic name is the better label for the group.
        if (key.length < g.key.length) {
          g.key = key
          g.raw = source
          g.verbatim = verbatim
        }
      } else {
        g = { key, raw: source, verbatim, totalMinor: 0, count: 0, cats: new Map() }
        groups.push(g)
      }
      seen.set(key, g)
    }
    g.totalMinor -= t.amountMinor
    g.count += 1
    if (t.categoryId) g.cats.set(t.categoryId, (g.cats.get(t.categoryId) ?? 0) - t.amountMinor)
  }

  return groups
    .sort((a, b) => b.totalMinor - a.totalMinor)
    .slice(0, limit)
    .map((g) => {
      // The category most of the money went to, not the commonest row: one
      // £400 line says more about what a payee is than nine £3 ones.
      const top = [...g.cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      const style = styleOf(top ? catMap.get(top) : undefined, catMap)
      return {
        payee: g.verbatim ? g.raw : prettyPayee(g.raw),
        totalMinor: g.totalMinor,
        count: g.count,
        ...style,
      }
    })
}

/* ---------- 6. Drift, at a glance ---------- */

export interface HeatmapRow {
  categoryId: string
  name: string
  slot: number
  /** The category's own colour, where it has one. Overrides `slot`. */
  color?: string
  icon: string
  /** One per month, in the order asked for. */
  cells: number[]
  totalMinor: number
}

export interface Heatmap {
  months: string[]
  rows: HeatmapRow[]
  /** The largest single cell, which every cell's intensity is a share of. */
  peakMinor: number
}

/**
 * Months across, categories down — for seeing a category creep up over half a
 * year, which is invisible in a donut of one month and lost in a line chart of
 * everything added together.
 *
 * Intensity is scaled to the largest single CELL rather than per row. Per row
 * makes every category look equally dramatic — the £8 one and the £800 one both
 * run pale to solid — and the whole point is comparing categories against each
 * other.
 */
export function categoryHeatmap(
  txns: Transaction[],
  flows: Map<string, Flow>,
  categories: Category[],
  book: BookId,
  books: BookMap,
  months: string[],
  maxRows = 10,
): Heatmap {
  const ids = accountsInBook(book, books)
  const catMap = new Map(categories.map((c) => [c.id, c]))
  const index = new Map(months.map((m, i) => [m, i]))
  const rows = new Map<string, number[]>()

  for (const t of txns) {
    if (!t.categoryId) continue
    const flow = flows.get(t.id)
    if (!spendsIn(flow, book, t.accountId, ids)) continue
    const at = index.get(effectiveMonth(t, flow))
    if (at === undefined) continue
    const cat = catMap.get(t.categoryId)
    if (!cat || cat.kind !== 'expense') continue
    // Rolled up to the parent, the same rule budgets and the donut use. A
    // heatmap of forty subcategories is a wall, not a picture.
    const key = budgetCategoryId(cat)!
    const cells = rows.get(key) ?? months.map(() => 0)
    cells[at] -= t.amountMinor
    rows.set(key, cells)
  }

  const out: HeatmapRow[] = [...rows.entries()]
    .map(([categoryId, cells]) => {
      const c = catMap.get(categoryId)
      const style = styleOf(c, catMap)
      return {
        categoryId,
        name: c?.name ?? 'Uncategorised',
        cells,
        totalMinor: cells.reduce((s, v) => s + v, 0),
        ...style,
      }
    })
    .sort((a, b) => b.totalMinor - a.totalMinor)
    .slice(0, maxRows)

  const peakMinor = out.reduce((max, r) => Math.max(max, ...r.cells), 0)
  return { months, rows: out, peakMinor }
}

/* ---------- 7. Are we ahead of ourselves? ---------- */

export interface PacePoint {
  day: number
  /** Cumulative spend to this day of the month being watched. */
  thisMonthMinor: number | null
  /** The same point in the month before it. */
  lastMonthMinor: number | null
}

/**
 * Spend-to-date against the same point last month.
 *
 * The only view here that answers a question about *now*: on the 12th, is the
 * household ahead of where it was on the 12th of last month? Comparing whole
 * months cannot say — the current one is a fifth finished.
 *
 * This month's line stops at today rather than running flat to the 31st. A flat
 * tail reads as three weeks of spending nothing, and the gap between the two
 * lines at the end of it would be the gap between a part-month and a whole one.
 */
export function pace(
  txns: Transaction[],
  flows: Map<string, Flow>,
  book: BookId,
  books: BookMap,
  month: string,
): PacePoint[] {
  const ids = accountsInBook(book, books)
  const previous = shiftMonth(month, -1)
  const today = todayISO()
  // How far to draw the current line: today if we are in this month, otherwise
  // the whole of it.
  const upto = monthKey(today) === month ? Number(today.slice(8, 10)) : 31

  const daily = (key: string) => {
    const byDay = new Array<number>(32).fill(0)
    for (const t of txns) {
      const flow = flows.get(t.id)
      if (!spendsIn(flow, book, t.accountId, ids)) continue
      if (effectiveMonth(t, flow) !== key) continue
      byDay[Number(t.date.slice(8, 10))] -= t.amountMinor
    }
    return byDay
  }

  const now = daily(month)
  const before = daily(previous)
  const out: PacePoint[] = []
  let runNow = 0
  let runBefore = 0

  for (let day = 1; day <= 31; day++) {
    runNow += now[day]
    runBefore += before[day]
    out.push({
      day,
      thisMonthMinor: day <= upto ? runNow : null,
      lastMonthMinor: runBefore,
    })
  }
  return out
}

/* ---------- 8. Is this month unusual? ---------- */

export interface CategoryDelta {
  categoryId: string
  /** What this month came to. Positive. */
  thisMonthMinor: number
  /** The median of the months before it that had any spending. Positive. */
  typicalMinor: number
  /** Signed: above typical is positive. */
  deltaMinor: number
  /** How many past months the median rests on — below three it is not a claim. */
  basis: number
}

/**
 * How this month compares with what a category normally costs.
 *
 * The median rather than the mean, and months with NO spending are dropped
 * rather than counted as zero — the same rule `typicalRange` uses, for the same
 * reason. One £900 annual insurance payment would otherwise drag the mean up
 * for the rest of the year, and a category you did not touch in March says
 * nothing about what is normal for it.
 *
 * `basis` is reported rather than hidden behind a threshold, so the caller can
 * decide what is worth saying out loud. Two past months is not a typical
 * anything, and "£120 above typical" on that evidence is a confident number
 * about nothing.
 */
export function categoryDeltas(
  txns: Transaction[],
  flows: Map<string, Flow>,
  categories: Category[],
  book: BookId,
  books: BookMap,
  months: string[],
  month: string,
): Map<string, CategoryDelta> {
  const ids = accountsInBook(book, books)
  const catMap = new Map(categories.map((c) => [c.id, c]))
  // Only the months BEFORE the one being looked at: comparing August against a
  // window that includes August pulls the typical figure towards it.
  const past = months.filter((m) => m < month)
  const at = new Map(past.map((m, i) => [m, i]))

  const history = new Map<string, number[]>()
  const current = new Map<string, number>()

  for (const t of txns) {
    if (!t.categoryId) continue
    const flow = flows.get(t.id)
    if (!spendsIn(flow, book, t.accountId, ids)) continue
    const cat = catMap.get(t.categoryId)
    if (!cat || cat.kind !== 'expense') continue
    const key = budgetCategoryId(cat)!
    const when = effectiveMonth(t, flow)

    if (when === month) {
      current.set(key, (current.get(key) ?? 0) - t.amountMinor)
      continue
    }
    const i = at.get(when)
    if (i === undefined) continue
    const row = history.get(key) ?? past.map(() => 0)
    row[i] -= t.amountMinor
    history.set(key, row)
  }

  const out = new Map<string, CategoryDelta>()
  for (const [categoryId, thisMonthMinor] of current) {
    const spent = (history.get(categoryId) ?? []).filter((v) => v > 0).sort((a, b) => a - b)
    if (spent.length === 0) continue
    const mid = Math.floor(spent.length / 2)
    const typicalMinor =
      spent.length % 2 === 1 ? spent[mid] : Math.round((spent[mid - 1] + spent[mid]) / 2)
    out.set(categoryId, {
      categoryId,
      thisMonthMinor,
      typicalMinor,
      deltaMinor: thisMonthMinor - typicalMinor,
      basis: spent.length,
    })
  }
  return out
}
