import { useCallback, useSyncExternalStore } from 'react'
import type { Category, Transaction } from './db'
import { monthKey } from './dates'
import { payeeSimilar } from './rules'
import type { BookId } from './books'

/**
 * Out of a figure and into the rows behind it.
 *
 * Every chart in the app is an arithmetic claim about a set of transactions,
 * and the question a chart raises is always the same one: WHICH transactions.
 *
 * It is answered TWICE, on purpose, and the difference is what you are about to
 * do with the answer:
 *
 *   - A SHEET over the chart, which is the default. Reading the rows behind a
 *     figure is usually a glance — is that £412 one thing or forty? — and a
 *     glance should not cost you the page you were reading. The sheet leaves
 *     Reports exactly as it was underneath: same month, same period, same
 *     scroll position, same drilled-into category. Closing it is not a
 *     navigation, so there is nothing to restore and nothing to get wrong.
 *   - ACTIVITY, prefiltered, from the button inside that sheet. The moment the
 *     answer is "one of these is filed wrong", you want the page that edits
 *     rows in place, links transfers and attaches receipts — and rebuilding any
 *     of that inside a modal would be a second, weaker copy of it.
 *
 * So a drill is a description, not a destination: `matchesDrill` filters rows
 * for the sheet, `drillTo` spells the same thing as a URL for Activity, and
 * this file is the only place that knows either.
 *
 * Three things it has to carry, and the third only matters for the Activity
 * route — the sheet has nothing to go back to:
 *
 *   - WHAT was narrowed to. A month, a range of days, a category, a payee, an
 *     account — whatever the figure was made of, and nothing it was not.
 *   - WHICH BOOK it was read under. A figure means nothing without its lens:
 *     the same category in the household book and in mine are two different
 *     numbers, and arriving at a list under the wrong one shows rows that do
 *     not add up to the figure that was clicked.
 *   - WHERE IT CAME FROM, including that page's own state. "Back" has to
 *     return you to the chart you left — March, as a year, in the table view —
 *     and a bare `/reports` is a different page that merely has the same
 *     address. The origin path carries the sending page's state, and the
 *     sending page reads it back on arrival.
 *
 * The params are read once on arrival and cleared from the URL, so a filter
 * changed afterwards is not silently undone by something nobody can see. What
 * survives is the FILTERS, which are sticky for the session — see `sticky.ts`.
 */

export interface Drill {
  book?: BookId
  /** One month, as `YYYY-MM`. */
  month?: string
  /** Or a run of days, inclusive, as ISO dates. Not combined with `month`. */
  from?: string
  to?: string
  /** A top-level category id; subcategories count towards it, as everywhere. */
  category?: string
  /** A payee as the chart labelled it — matched loosely, see `payeeMatches`. */
  payee?: string
  account?: string
  /** Where to go back to, with the sending page's state in it. */
  backTo?: string
  /** What to call that place: "Reports", "Home". */
  backLabel?: string
}

const KEYS = ['book', 'month', 'from', 'to', 'category', 'payee', 'account', 'backTo', 'backLabel'] as const

const BOOKS = new Set<string>(['household', 'mine', 'all'])

/** The Activity URL that answers this drill. */
export function drillTo(drill: Drill): string {
  const q = new URLSearchParams()
  for (const key of KEYS) {
    const value = drill[key]
    if (value) q.set(key, value)
  }
  const query = q.toString()
  return query ? `/activity?${query}` : '/activity'
}

/**
 * A drill, read off a URL.
 *
 * Defensive in the same way `normaliseLayout` is: the params are a string
 * somebody could have typed, edited or bookmarked from an older build. An
 * unknown book is dropped rather than becoming a lens nobody can name, and a
 * `backTo` is only honoured if it is a path within the app — an absolute URL
 * here would turn a breadcrumb into an open redirect.
 */
export function readDrill(params: URLSearchParams): Drill {
  const out: Drill = {}
  const str = (key: string) => {
    const v = params.get(key)?.trim()
    return v ? v : undefined
  }

  const book = str('book')
  if (book && BOOKS.has(book)) out.book = book as BookId
  if (/^\d{4}-\d{2}$/.test(str('month') ?? '')) out.month = str('month')
  const from = str('from')
  const to = str('to')
  if (isDate(from) && isDate(to)) {
    // Both or neither: half a range is not a narrower question, it is an
    // unbounded one wearing the label of a bounded one.
    out.from = from
    out.to = to
  }
  out.category = str('category')
  out.payee = str('payee')
  out.account = str('account')

  const back = str('backTo')
  if (back && back.startsWith('/') && !back.startsWith('//')) {
    out.backTo = back
    out.backLabel = str('backLabel') ?? 'where you were'
  }
  return out
}

const isDate = (v: string | undefined): v is string => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '')

/** Does this drill narrow anything at all? A bare book is a lens, not a drill. */
export function narrows(drill: Drill): boolean {
  return Boolean(drill.month || drill.from || drill.category || drill.payee || drill.account)
}

/**
 * Does this row sit behind the figure that was pressed?
 *
 * The one definition of what a drill MEANS, so the sheet that lists the rows
 * and the Activity page that filters to them cannot come to disagree — the
 * figure would then be explained by two different lists depending on which way
 * you asked. It deliberately says nothing about which accounts you may see or
 * which book is in view: both callers have already narrowed to those, from
 * `accountsInBook` and the grants, and folding that in here would give this
 * function a second job it cannot check.
 */
export function matchesDrill(
  t: Transaction,
  drill: Drill,
  catMap: Map<string, Category>,
): boolean {
  if (drill.month && monthKey(t.date) !== drill.month) return false
  if (drill.from && t.date < drill.from) return false
  if (drill.to && t.date > drill.to) return false
  if (drill.account && t.accountId !== drill.account) return false
  if (drill.category) {
    // Top-level, with subcategories counting towards their parent — the rule
    // budgets, the donut and the report slices all use.
    const cat = t.categoryId ? catMap.get(t.categoryId) : undefined
    if (!cat) return false
    if (cat.id !== drill.category && cat.parentId !== drill.category) return false
  }
  // The same fuzzy comparison `topPayees` groups by: that list folds "TESCO
  // STORES 3456" and "TESCO EXPRESS" into one row, so an exact match here would
  // open a list adding up to less than the figure that was pressed.
  if (drill.payee && !payeeSimilar(t.payee, drill.payee)) return false
  return true
}

/* ---------- The drill that is currently open ---------- */

/**
 * One drill at a time, for the whole app.
 *
 * A module-level value with subscribers, like `useBook`, rather than state on
 * whichever page happened to raise it. Two reasons. The chart that starts a
 * drill is three components deep in a widget catalogue, and threading a
 * callback down through `Arrange` to reach it would make every widget's
 * signature carry something only two of them use. And the sheet has to be
 * mounted ABOVE the page — it is a modal over the whole app — which is one
 * place, in `Layout`, rather than one per page.
 */
let openDrillState: Drill | null = null
const drillListeners = new Set<() => void>()

/** Show the rows behind a figure, over the page that asked. */
export function openDrill(drill: Drill): void {
  openDrillState = drill
  drillListeners.forEach((fn) => fn())
}

export function closeDrill(): void {
  if (openDrillState === null) return
  openDrillState = null
  drillListeners.forEach((fn) => fn())
}

export function useOpenDrill(): Drill | null {
  return useSyncExternalStore(
    useCallback((fn: () => void) => {
      drillListeners.add(fn)
      return () => drillListeners.delete(fn)
    }, []),
    () => openDrillState,
    () => null,
  )
}

/**
 * A path with state on it, for a page to send as its own `backTo`.
 *
 * Empty values are dropped rather than written as `?month=`, so a page with
 * nothing to remember produces a plain path and two drills from the same place
 * produce the same string.
 */
export function pathWithState(path: string, state: Record<string, string | undefined>): string {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(state)) {
    if (value) q.set(key, value)
  }
  const query = q.toString()
  return query ? `${path}?${query}` : path
}
