import type { BookId } from './books'

/**
 * Out of a figure and into the rows behind it.
 *
 * Every chart in the app is an arithmetic claim about a set of transactions,
 * and the question a chart raises is always the same one: WHICH transactions.
 * The answer is Activity — the page that already lists rows, edits them in
 * place, links transfers, attaches receipts and knows what you may change —
 * rather than a modal holding a second, weaker copy of all that. So a drill is
 * a navigation, and this file is the only place that knows how to spell one.
 *
 * Three things it has to carry, and the third is the one that is easy to
 * forget:
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
