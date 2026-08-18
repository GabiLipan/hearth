import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeftRight, ArrowRight, ChevronLeft, Eye } from 'lucide-react'
import { getDaysInMonth } from 'date-fns'
import type { Transaction, Category, Budget, Bill, Account, GrantLevel } from '../lib/db'
import { thisMonthKey, monthLabel, fmtDay, daysUntil, fmtFullDate, todayISO } from '../lib/dates'
import { monthlySpendByCategory, monthsEndingAt, monthsOfHistory, OTHER_SLICE_ID } from '../lib/stats'
import {
  accountsInBook,
  bookSeries,
  bookSlices,
  bookTotals,
  contributionSplit,
  hasBreakdown,
  BOOK_WORDS,
  type BookId,
  type BookMap,
  type Flow,
} from '../lib/books'
import { spendFlow } from '../lib/sankey'
import { openDrill, type Drill } from '../lib/drill'
import { useMemberMap } from '../lib/cache'
import { TxnName } from './TxnName'
import { nameOf } from './PersonDot'
import { Sankey } from './Sankey'
import { settlement } from '../lib/reimbursements'
import { typicalRange } from '../lib/budgetHistory'
import { accountFace, balanceHistory, balanceOf, canAddTransactions, canSeeTransactionsAt, levelOn } from '../lib/accounts'
import { paintOf } from '../lib/palette'
import { transfer } from '../lib/goals'
import { parseAmount, currencySymbol } from '../lib/money'
import { syncNow } from '../lib/session'
import { useSyncState } from '../hooks/useSync'
import { useApp } from '../state/AppContext'
import { AccountDot, Button, Card, CardHeader, CategoryDot, Field, Fill, Progress, Select, Sheet, TextInput, cx } from './ui'
import { BudgetBullet } from './BudgetBullet'
import { CategoryIcon } from './CategoryIcon'
import { CategoryBars, CategoryDonut, CategoryMosaic, Sparkline, SpendBars, type TrendShape } from './charts'

export interface HomeData {
  txns: Transaction[]
  /**
   * Every transaction this device can see, NOT narrowed to the chosen book.
   *
   * Almost nothing should want this — `txns` is scoped for a reason, and a
   * widget adding up rows from outside the book on screen is the double-count
   * the book model exists to prevent. `ReimbursementWidget` wants it because
   * what it measures genuinely straddles two books: what I paid out of mine and
   * what the household has paid back into it. Narrowing to either one would
   * show half the sum.
   */
  allTxns: Transaction[]
  /** Likewise unscoped: paying yourself back moves money between two books. */
  allAccounts: Account[]
  categories: Category[]
  /** This month's budgets only — see Dashboard. Widgets must not assume history. */
  budgets: Budget[]
  bills: Bill[]
  accounts: Account[]
  /** Server-computed balances for accounts whose transactions we cannot read. */
  remoteBalances: Map<string, number>
  /** What I may do on each account — the mirror of `my_account_ids()`. */
  levels: Map<string, GrantLevel>
  userId?: string
  /**
   * Which book is on screen. Dashboard has already narrowed `txns`, `accounts`,
   * `bills` and `budgets` to it, so a widget that only lists rows needs to do
   * nothing — but anything that ADDS money up must go through `bookTotals` and
   * friends, because a contribution is not income and not spending and only
   * these know which.
   */
  book: BookId
  books: BookMap
  flows: Map<string, Flow>
}

/**
 * What every widget on the home page is handed.
 *
 * `variant` and `controls` come from the page's stored arrangement — see
 * `lib/layout.ts`. A widget that offers no choice of shape simply ignores both,
 * which is most of them. The picker is passed in rather than rendered over the
 * card because the corner of a card is already spoken for on most of them: a
 * widget knows where its own heading is, and nothing else does.
 */
export interface WidgetProps {
  data: HomeData
  variant?: string
  /**
   * Everything the widget lets you decide beyond its shape, resolved from the
   * stored arrangement — how many categories, how many months, how far ahead.
   * Values are strings because that is what a stored choice is; a widget that
   * wants a number says `Number(options.count)` at the point of use rather than
   * the layout pretending to know what each option means.
   */
  options?: Record<string, string>
  controls?: ReactNode
}

const month = () => thisMonthKey()

/**
 * Out of a figure on the home page and into the rows behind it.
 *
 * The same vocabulary Reports uses — see `lib/drill.ts` — with one difference:
 * home has no period, no drill and no view to carry, so "back" is just the
 * page. Everything here is about the current month, so the month travels on
 * every drill rather than being left to the reader to infer.
 */
function useHomeDrill(book: BookId) {
  return (extra: Partial<Drill> = {}) =>
    openDrill({ book, month: month(), backTo: '/', backLabel: 'Home', ...extra })
}

/* ---------- Month summary hero ---------- */

/**
 * One figure in the desktop stat strip.
 *
 * `lead` is the card's focal point, and exactly one figure gets it. The strip
 * used to be five equal `text-lg` figures divided by hairlines, which made the
 * most important card on the page the flattest thing on it — while the phone
 * layout, six lines above, leads with a `text-3xl` headline and subordinates
 * everything else. Same hierarchy, both widths.
 *
 * There is no `tone` any more, and its absence is the point. Green and red on
 * `--panel-2` are a dark green and a dark red on a dark blue — the two figures
 * that most need to be read, made the hardest to. The panel says which state
 * the month is in with its own colour, and the words "left" and "over" say it
 * in text; both survive being colour-blind, which the green/red pair never did.
 */
function Stat({ label, value, lead }: { label: string; value: string; lead?: boolean }) {
  return (
    /* The hairline is stated here rather than as `divide-x` on the row: a
       `divide-*` utility sets only the width, so the colour falls back to the
       child's `currentColor` — which on this panel is full-strength white, four
       times too strong for a divider. */
    <div
      className="min-w-0 border-l px-4 first:border-l-0 first:pl-0 last:pr-0"
      style={{ borderColor: 'var(--panel-line)' }}
    >
      <p className="text-xs" style={{ color: 'var(--panel-ink-2)' }}>{label}</p>
      <p className={cx('mt-0.5 truncate font-bold tracking-tight tabular', lead ? 'text-2xl' : 'text-lg')}>
        {value}
      </p>
    </div>
  )
}

/**
 * The month, as the page's one painted surface.
 *
 * Home is opened to learn one thing — how this month is going — and then either
 * closed or used to go looking. So this card stops being the first of nine
 * near-white rectangles and becomes the top of the page: a deep gradient, the
 * figure at `text-4xl`, and everything else on the page left exactly as quiet as
 * it was. The colour is spent once, here, deliberately; a second painted card
 * would leave the page with two focal points, which is none.
 *
 * Three things this has to keep being true, because they were all easy to get
 * wrong:
 *
 *   - **It is not always at the top.** Every card on this page can be dragged,
 *     resized to one column or switched off, so the panel has to read as itself
 *     in a masonry column halfway down. Nothing here assumes its position or its
 *     width — the phone layout stacks, the wide one strips, and both are the
 *     same panel.
 *   - **Every colour comes from `--panel-*`.** The gradient, the quiet ink, the
 *     divider and the bar's track are all tokens defined per theme, so a dark
 *     screen gets deeper stops rather than the light ones glowing on black. No
 *     `text-ink-3`, no `divide-hairline`, no `--accent-ink`: those are ink for a
 *     surface, and this is not one.
 *   - **The state is the panel's colour, not the figure's.** Over budget turns
 *     the whole card oxblood via `data-over`, which is why `Stat` has no tone
 *     and the phone layout's "over"/"left" is plain semibold white.
 */
export function HeroWidget({ data }: WidgetProps) {
  const { money } = useApp()
  const words = BOOK_WORDS[data.book]
  const totals = useMemo(
    () => bookTotals(data.txns, data.flows, data.book, month(), data.books),
    [data.txns, data.flows, data.book, data.books],
  )
  const budgetTotal = data.budgets.reduce((s, b) => s + b.amountMinor, 0)
  const frac = budgetTotal > 0 ? totals.spend / budgetTotal : 0
  const over = frac > 1
  const bar = budgetTotal > 0 && (
    <Progress fraction={frac} tone={over ? 'over' : frac > 0.85 ? 'warn' : 'ok'} on="panel" />
  )
  const quiet = { color: 'var(--panel-ink-2)' }

  return (
    <Card className={cx('panel-month p-4 md:p-3.5', over && 'panel-over')}>
      {/* Phone: one headline figure with the detail stacked underneath. */}
      <div className="flex flex-wrap items-end justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <p className="text-sm" style={quiet}>{monthLabel(month())} · {words.spend.toLowerCase()}</p>
          <p className="mt-0.5 truncate text-4xl font-bold tracking-tight tabular">{money(totals.spend)}</p>
          {budgetTotal > 0 && (
            <p className="mt-1 text-sm" style={quiet}>
              of {money(budgetTotal, { hideDecimals: true })}
              <span className="font-semibold" style={{ color: 'var(--panel-ink)' }}>
                {' · '}
                {over
                  ? `${money(totals.spend - budgetTotal)} over`
                  : `${money(budgetTotal - totals.spend)} left`}
              </span>
            </p>
          )}
        </div>
        <div className="min-w-36 flex-1">
          <div className="mb-1.5 flex justify-between gap-2 text-xs" style={quiet}>
            <span className="truncate">{words.income} {money(totals.income, { compact: true })}</span>
            <span className="truncate">{words.net} {money(totals.net, { sign: true, compact: true })}</span>
          </div>
          {bar}
        </div>
      </div>

      {/* Desktop: a strip of figures across the full width. */}
      <div className="hidden md:block">
        <p className="text-xs" style={quiet}>{monthLabel(month())}</p>
        <div className="mt-1 flex flex-nowrap items-start">
          <Stat label={words.spend} value={money(totals.spend)} lead />
          <Stat label={words.income} value={money(totals.income)} />
          {data.book === 'mine' && totals.contributed > 0 && (
            <Stat label="To household" value={money(totals.contributed)} />
          )}
          <Stat label={words.net} value={money(totals.net, { sign: true })} />
          {budgetTotal > 0 && <Stat label="Budgeted" value={money(budgetTotal, { hideDecimals: true })} />}
        </div>
        {budgetTotal > 0 && <div className="mt-2.5">{bar}</div>}
      </div>
    </Card>
  )
}

/* ---------- Budgets at a glance ---------- */
export function BudgetGlanceWidget({ data }: WidgetProps) {
  const { money } = useApp()
  const now = new Date()
  const paceFrac = now.getDate() / getDaysInMonth(now)
  // Six months, so the bullet can say what "normal" looks like for a category.
  // This also aligns the widget with the Budgets page, which rolls subcategory
  // spending up to the parent and excludes transfers — the hand-rolled loop
  // that used to live here did neither, so the two pages disagreed.
  const months = useMemo(() => monthsEndingAt(month(), 6), [])
  const history = useMemo(
    () => monthlySpendByCategory(data.txns, data.categories, months),
    [data.txns, data.categories, months],
  )
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  // Budgets follow the book: the household's shared ones under "Our household",
  // my own under "Mine". Spending is already narrowed to the book's accounts by
  // Dashboard, so a household budget stops counting my private card.
  const rows = data.budgets
    .filter((b) => catMap.has(b.categoryId))
    .map((b) => {
      const series = history.get(b.categoryId) ?? months.map(() => 0)
      return {
        cat: catMap.get(b.categoryId)!,
        budget: b.amountMinor,
        spent: series[series.length - 1],
        typical: typicalRange(series.slice(0, -1)),
      }
    })
    .sort((a, b) => b.spent / b.budget - a.spent / a.budget)
  if (rows.length === 0) {
    return (
      <Card className="p-4 md:p-3">
        <p className="text-sm text-ink-3">
          No budgets yet — set some in the <Link to="/budgets" className="text-accent">Budgets</Link> tab and they'll
          appear here.
        </p>
      </Card>
    )
  }
  const totalBudget = rows.reduce((s, r) => s + r.budget, 0)
  const totalSpent = rows.reduce((s, r) => s + r.spent, 0)
  return (
    <Card className="p-4 md:p-3">
      <CardHeader
        title="Budgets"
        action={
          <p className="shrink-0 text-sm text-ink-2 tabular">
            <span className="font-semibold text-ink">{money(totalSpent, { compact: true })}</span> of{' '}
            {money(totalBudget, { compact: true, hideDecimals: true })}
          </p>
        }
      />
      {/* This widget spans the full page width, so on a wide screen the rows
          split into columns — a bar 1,000px long is harder to read, not easier. */}
      <ul className="grid gap-2.5 md:gap-x-6 md:gap-y-1.5 lg:grid-cols-2 min-[1800px]:grid-cols-3">
        {rows.map(({ cat, budget, spent: catSpent, typical }) => {
          const over = catSpent > budget
          return (
            <li key={cat.id} className="flex items-center gap-2.5 md:gap-2">
              <span className="grid w-5 shrink-0 place-items-center" style={{ color: paintOf(cat.slot, cat.color) }} aria-hidden>
                <CategoryIcon icon={cat.icon} size={15} />
              </span>
              <span className="w-24 truncate text-sm text-ink-2 sm:w-32">{cat.name}</span>
              <BudgetBullet
                className="flex-1"
                spent={catSpent}
                budget={budget}
                typical={typical}
                pace={paceFrac}
                color={paintOf(cat.slot, cat.color)}
                label={`${cat.name}: ${money(catSpent)} spent of a ${money(budget)} budget`}
              />
              <span className={cx('w-16 shrink-0 text-right text-xs font-medium tabular', over ? 'text-critical-text' : 'text-ink-2')}>
                {over ? `+${money(catSpent - budget, { compact: true })}` : money(budget - catSpent, { compact: true })}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-xs text-ink-3 md:mt-2">
        Bar = spent · dark tick = budget · pale block = what this category normally costs · right column = left (or over)
      </p>
    </Card>
  )
}

/* ---------- Accounts ---------- */
/** How much history the sparkline beside each balance covers. */
const SPARK_DAYS = 30

export function AccountsWidget({ data }: WidgetProps) {
  const { money } = useApp()
  const balance = (a: Account) => balanceOf(a, data.txns, data.remoteBalances, levelOn(a.id, data.levels))
  const total = data.accounts.reduce((s, a) => s + balance(a), 0)
  if (data.accounts.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <CardHeader title="Accounts" action={<span className="text-sm font-semibold tabular">{money(total)}</span>} />
      <ul className="divide-y divide-hairline">
        {data.accounts.map((a) => {
          const level = levelOn(a.id, data.levels)
          const bal = balance(a)
          const face = accountFace(a)
          // No line at `balance` level: there are no rows to draw one from, and
          // a flat line would be a claim about a month nobody here can see.
          const spark = canSeeTransactionsAt(level)
            ? balanceHistory(a.id, data.txns, bal, SPARK_DAYS)
            : undefined
          return (
            <li key={a.id} className="flex items-center gap-2.5 py-2 md:gap-2 md:py-1.5">
              {/* The account's own colour and icon — `accountFace`, so an
                  account nobody has styled still gets the one its kind
                  implies. A rounded square, where a category is a circle. */}
              <AccountDot account={a} size={30} className="md:[--dot:26px]" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {a.name}
                {/* The eye means "you can see what is in it, not what it was
                    spent on" — the one tier where the total on the right comes
                    from the server rather than from rows this device holds. */}
                {!canSeeTransactionsAt(level) && <Eye size={12} className="ml-1.5 inline text-ink-3" />}
              </span>
              {spark && (
                <Sparkline
                  values={spark}
                  color={paintOf(face.slot, face.color)}
                  className="h-5 w-12 shrink-0 opacity-70 sm:w-14"
                  label={`${a.name}: the last ${SPARK_DAYS} days`}
                />
              )}
              <span className={cx('text-sm font-semibold tabular', bal < 0 && 'text-critical-text')}>{money(bal)}</span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ---------- Where it went ---------- */
export function DonutWidget({ data, variant, options, controls }: WidgetProps) {
  const { money } = useApp()
  /** The category being looked inside, or null for the top level. */
  const [drill, setDrill] = useState<string | null>(null)

  const count = Number(options?.count ?? 6)
  const slices = useMemo(
    () => bookSlices(data.txns, data.flows, data.categories, data.book, month(), data.books, drill ?? undefined, count),
    [data.txns, data.flows, data.categories, data.book, data.books, drill, count],
  )
  // Changing book empties the breadcrumb: it would otherwise point at a
  // category that is no longer on this screen.
  useEffect(() => setDrill(null), [data.book])

  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const canDrill = (categoryId: string) =>
    categoryId !== OTHER_SLICE_ID &&
    hasBreakdown(categoryId, data.txns, data.flows, data.categories, data.book, month(), data.books)

  /**
   * Deeper while there is a deeper, and the transactions when there is not —
   * the same rule Reports gives the same gesture.
   */
  const openRows = useHomeDrill(data.book)
  const pickSlice = (slice: { categoryId: string }) => {
    if (!drill && canDrill(slice.categoryId)) return setDrill(slice.categoryId)
    if (slice.categoryId === OTHER_SLICE_ID) return openRows()
    openRows({ category: slice.categoryId })
  }

  const spent = slices.reduce((s, x) => s + x.totalMinor, 0)
  if (slices.length === 0 && !drill) return null

  return (
    <Card className="p-4 md:p-3">
      <div className="mb-2 flex items-center gap-1 md:mb-1.5">
        <h3 className="flex min-w-0 flex-1 items-center gap-1 font-semibold md:text-sm">
          {drill && (
            <button
              type="button"
              onClick={() => setDrill(null)}
              className="flex items-center gap-0.5 rounded-full px-1 py-0.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink"
            >
              <ChevronLeft size={14} /> All
            </button>
          )}
          <span className="truncate">{drill ? (catMap.get(drill)?.name ?? 'Category') : 'Where it went'}</span>
        </h3>
        {controls}
      </div>
      {variant === 'bars' || variant === 'mosaic' ? (
        <>
          <p className="mb-2 text-sm text-ink-2">
            <span className="font-semibold tabular">{money(spent)}</span>{' '}
            <span className="text-ink-3">{drill ? 'in here' : 'spent'}</span>
          </p>
          {variant === 'mosaic' ? (
            /* A little taller than the ring's 180: the blocks are the full
               width of the card, so height is what decides how many of them can
               carry a legible name rather than falling back to a chip. */
            <Fill min={190}>
              {(height) => <CategoryMosaic slices={slices} height={height} onPick={pickSlice} />}
            </Fill>
          ) : (
            <CategoryBars slices={slices} onPick={pickSlice} />
          )}
        </>
      ) : (
        <Fill min={180}>
          {(height) => (
            <CategoryDonut
              slices={slices}
              height={height}
              onPick={pickSlice}
              pickLabel={(s) => (!drill && canDrill(s.categoryId) ? 'Look inside' : 'See transactions')}
              centerLabel={{ title: drill ? 'in here' : 'spent', value: money(spent, { compact: true }) }}
            />
          )}
        </Fill>
      )}
      {/* The donut itself is not clickable, so the way in is a row of buttons
          under it — the same arrangement Reports uses, and the same reasons:
          a keyboard path, and a target big enough for a thumb. The blocks need
          neither: each one is a real button, in reading order, and the ones too
          small to press carry their own chip. */}
      {!drill && variant !== 'mosaic' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {slices.filter((s) => canDrill(s.categoryId)).map((s) => (
            <button
              type="button"
              key={s.categoryId}
              onClick={() => setDrill(s.categoryId)}
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-xs font-medium text-ink-2 transition hover:text-ink"
            >
              <CategoryIcon icon={s.icon} size={12} /> {s.name}
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}

/* ---------- Trend ---------- */

export function TrendWidget({ data, variant, options, controls }: WidgetProps) {
  // The window is what the card was asked for; the series is everything there
  // is, so the chart has something to scroll back to. A household three months
  // old gets three bars rather than three bars and thirty-three empty ones.
  // Not named `window`: a local of that name shadows the global for the whole
  // function, which is the same trap `CategoryIcon` aliases `Map` around.
  const across = Number(options?.months ?? 6)
  const openRows = useHomeDrill(data.book)
  const months = useMemo(() => monthsOfHistory(data.txns), [data.txns])
  const series = useMemo(
    () => bookSeries(data.txns, data.flows, data.book, months, data.books),
    [data.txns, data.flows, data.book, months, data.books],
  )
  return (
    <Card className="p-4 md:p-3">
      <div className="mb-2 flex items-center gap-1 md:mb-1.5">
        <h3 className="min-w-0 flex-1 truncate font-semibold md:text-sm">
          Spending, last {Math.min(across, months)} months
        </h3>
        {controls}
      </div>
      <Fill min={170}>
        {(height) => (
          <SpendBars
            data={series}
            height={height}
            visible={across}
            shape={(variant as TrendShape) ?? 'bars'}
            onPickMonth={(m) => openRows({ month: m })}
          />
        )}
      </Fill>
      {months > across && (
        <p className="mt-1 text-xs text-ink-3">Scroll the chart back for earlier months.</p>
      )}
    </Card>
  )
}

/* ---------- The month as one path ---------- */

/**
 * Where the money came from and what it became, in one picture.
 *
 * Off by default. It is the widest thing on the page and it says something the
 * hero and the donut between them already say in figures — so it earns its
 * place by being asked for, rather than by turning up on everyone's home page
 * on the strength of being new.
 */
export function FlowWidget({ data, options, controls }: WidgetProps) {
  const memberMap = useMemberMap()
  const totals = useMemo(
    () => bookTotals(data.txns, data.flows, data.book, month(), data.books),
    [data.txns, data.flows, data.book, data.books],
  )
  const count = Number(options?.count ?? 8)
  const slices = useMemo(
    () => bookSlices(data.txns, data.flows, data.categories, data.book, month(), data.books, undefined, count),
    [data.txns, data.flows, data.categories, data.book, data.books, count],
  )
  const split = useMemo(
    () => contributionSplit(data.allTxns, data.flows, month(), data.books, data.userId),
    [data.allTxns, data.flows, data.books, data.userId],
  )
  const partner = useMemo(() => {
    const others = [...memberMap.values()].filter((m) => m.userId !== data.userId)
    return others.length === 1 ? nameOf(others[0]) : undefined
  }, [memberMap, data.userId])

  const graph = useMemo(
    () => spendFlow({ book: data.book, totals, slices, split, partner }),
    [data.book, totals, slices, split, partner],
  )
  const openRows = useHomeDrill(data.book)
  if (graph.totalMinor === 0) return null

  return (
    <Card className="p-4 md:p-3">
      <div className="mb-2 flex items-center gap-1 md:mb-1.5">
        <h3 className="min-w-0 flex-1 truncate font-semibold md:text-sm">{monthLabel(month())} · where it flowed</h3>
        {controls}
      </div>
      {/* Only the category bands lead anywhere — the left-hand side is income
          and contributions, which are not a category filter. */}
      <Sankey
        graph={graph}
        canPick={(n) => n.id.startsWith('cat:')}
        onPick={(n) => openRows({ category: n.id.slice(4) })}
      />
    </Card>
  )
}

/* ---------- Upcoming bills ---------- */
export function BillsWidget({ data, options }: WidgetProps) {
  const { money } = useApp()
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const ahead = Number(options?.ahead ?? 14)
  const upcoming = data.bills
    .filter((b) => b.active && daysUntil(b.nextDue) <= ahead)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
    // Still capped: "the next two months" is a horizon, not an instruction to
    // fill the home page with thirty rows.
    .slice(0, ahead > 30 ? 10 : 5)
  if (upcoming.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <CardHeader
        title="Coming up"
        action={
          <Link to="/bills" className="flex shrink-0 items-center gap-1 text-sm font-medium text-accent">
            All bills <ArrowRight size={13} />
          </Link>
        }
      />
      <ul className="divide-y divide-hairline">
        {upcoming.map((b) => {
          const days = daysUntil(b.nextDue)
          return (
            <li key={b.id} className="flex items-center gap-2.5 py-2 md:gap-2 md:py-1">
              <CategoryDot category={b.categoryId ? catMap.get(b.categoryId) : undefined} size={30} className="md:[--dot:24px]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{b.name}</p>
                <p className="text-xs text-ink-3">
                  {days < 0 ? `Overdue — ${fmtFullDate(b.nextDue)}` : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : fmtDay(b.nextDue)}
                </p>
              </div>
              <span className="text-sm font-semibold tabular">{money(b.amountMinor)}</span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ---------- Recent activity ---------- */
/* ---------- What the household owes me ---------- */

/**
 * The other half of migration 13.
 *
 * Ticking "paid for the household" on a row already puts the spending in the
 * right book. This is the consequence nobody was told about: the money is still
 * mine, the household still has it, and until now nothing in the app said so.
 *
 * Deliberately one-sided, and worded that way. My partner's flagged rows are in
 * accounts I am not on, so this can never be a ledger of the two of us without
 * showing each of us the other's private spending — see `reimbursements.ts`.
 * "You" throughout; never "we".
 *
 * Hidden entirely until the mechanism has been used, so a household that never
 * pays for anything out of its own pockets never sees it.
 */
export function ReimbursementWidget({ data }: WidgetProps) {
  const { money } = useApp()
  const [paying, setPaying] = useState(false)
  const s = useMemo(
    () => settlement(data.allTxns, data.flows, data.books),
    [data.allTxns, data.flows, data.books],
  )

  if (s.paidMinor === 0) return null

  const owed = s.outstandingMinor
  return (
    <>
      <Card className="p-4 md:p-3">
        <CardHeader
          title="Owed to you"
          action={
            <Link to="/activity" className="flex shrink-0 items-center gap-1 text-sm font-medium text-accent">
              Activity <ArrowRight size={13} />
            </Link>
          }
        />

        <p className={cx('text-2xl font-bold tracking-tight tabular', owed > 0 && 'text-good-text')}>
          {money(Math.abs(owed))}
        </p>
        <p className="mt-0.5 text-xs text-ink-3">
          {owed > 0
            ? `You have paid ${money(s.paidMinor)} for the household and had ${money(s.returnedMinor)} back.`
            : owed === 0
              ? `Square — all ${money(s.paidMinor)} of it has come back.`
              : /* Reported rather than hidden: it usually means a withdrawal from
                   the joint account was something other than paying you back. */
                'The household has paid you back more than you put in.'}
        </p>

        {s.items.length > 0 && (
          <ul className="mt-2 divide-y divide-hairline">
            {s.items.slice(0, 4).map(({ txn, owedMinor }) => (
              <li key={txn.id} className="flex items-center gap-2 py-2 md:py-1">
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 text-sm font-medium">
                    <TxnName txn={txn} />
                  </p>
                  <p className="text-xs text-ink-3">{fmtDay(txn.date)}</p>
                </div>
                <span className="text-sm font-semibold tabular">{money(owedMinor)}</span>
              </li>
            ))}
          </ul>
        )}
        {s.items.length > 4 && (
          <p className="mt-1 text-xs text-ink-3">and {s.items.length - 4} more</p>
        )}

        {owed > 0 && (
          <Button size="sm" variant="subtle" className="mt-3 w-full" onClick={() => setPaying(true)}>
            <ArrowLeftRight size={14} /> Pay it back
          </Button>
        )}
      </Card>

      {/* Outside the Card on purpose, the way Goals renders FundGoal. A Sheet
          is `position: fixed`, and burying one inside a widget puts it under
          every ancestor that could ever become a containing block for it — a
          transform on a card, the clip on `main`. Nothing does today, and
          nothing should have to keep not doing it.

          Nothing is "marked settled" here: the repayment is an ordinary
          transfer, and the figure above goes to zero because the sum changed. */}
      <PayBack
        open={paying}
        amountMinor={Math.max(owed, 0)}
        data={data}
        onClose={() => setPaying(false)}
      />
    </>
  )
}

/**
 * Moving the money back: joint account → one of mine.
 *
 * The same shape as funding a goal, and the same reason for being online-only —
 * `create_transfer` writes two rows and they must land together or not at all.
 * Prefilled with the whole outstanding amount, because paying back all of it is
 * what usually happens; it is an ordinary editable field for when it is not.
 */
function PayBack({
  open,
  amountMinor,
  data,
  onClose,
}: {
  open: boolean
  amountMinor: number
  data: HomeData
  onClose: () => void
}) {
  const { currency, money } = useApp()
  const { online } = useSyncState()
  const household = accountsInBook('household', data.books)
  const mine = accountsInBook('mine', data.books)

  const payable = data.allAccounts.filter(
    (a) => household.has(a.id) && canAddTransactions(levelOn(a.id, data.levels)),
  )
  const receivable = data.allAccounts.filter(
    (a) => mine.has(a.id) && canAddTransactions(levelOn(a.id, data.levels)),
  )

  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  // Reset on each opening rather than on mount: the sheet outlives `open` by
  // its exit animation, so it is still rendered when the next open happens.
  useEffect(() => {
    if (!open) return
    setFromId(payable.length === 1 ? payable[0].id : '')
    setToId(receivable.length === 1 ? receivable[0].id : '')
    setAmount(amountMinor ? (amountMinor / 100).toFixed(2) : '')
    setDate(todayISO())
    setError(undefined)
    // `open` alone, on purpose. The account lists are rebuilt every render, so
    // depending on them would wipe what the user has just chosen; `amountMinor`
    // changes the moment a repayment syncs, which would clear the field
    // mid-edit.
  }, [open])

  const minor = parseAmount(amount)
  // `online` is part of it, as in Goals: `create_transfer` writes two legs and
  // they must land together or not at all, so there is nothing sensible for the
  // outbox to queue. Said up front rather than as a failure after the press.
  const canSave = !!fromId && !!toId && fromId !== toId && minor !== null && minor > 0 && online

  async function save() {
    if (!canSave) return
    setBusy(true)
    setError(undefined)
    try {
      await transfer({ fromAccountId: fromId, toAccountId: toId, amountMinor: minor!, date })
      await syncNow()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move the money')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Pay it back"
      footer={
        <Button size="lg" className="w-full" disabled={!canSave || busy} onClick={save}>
          {busy ? 'Moving…' : 'Move money'}
        </Button>
      }
    >
      <div className="space-y-4">
        {(payable.length === 0 || receivable.length === 0) && (
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-2">
            This needs a household account you can post to and one of your own to receive it.
          </p>
        )}
        {!online && (
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-2">
            Moving money needs a connection — both halves have to be recorded together, so this one
            can't be queued.
          </p>
        )}
        <Field label="From">
          <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
            <option value="" disabled>
              Choose an account…
            </option>
            {payable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To">
          <Select value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="" disabled>
              Choose an account…
            </option>
            {receivable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Amount (${currencySymbol(currency)})`}>
            <TextInput value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Date">
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        {minor != null && minor > 0 && (
          <p className="text-sm text-ink-3">
            Counts as a withdrawal from the household and takes {money(minor)} off what you are owed.
          </p>
        )}
        {error && <p className="text-sm text-critical-text">{error}</p>}
      </div>
    </Sheet>
  )
}

export function RecentWidget({ data, options }: WidgetProps) {
  const { money } = useApp()
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const rows = Number(options?.rows ?? 5)
  const recent = useMemo(
    () => [...data.txns].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, rows),
    [data.txns, rows],
  )
  if (recent.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <CardHeader
        title="Recent"
        action={
          <Link to="/activity" className="flex shrink-0 items-center gap-1 text-sm font-medium text-accent">
            All activity <ArrowRight size={13} />
          </Link>
        }
      />
      <ul className="divide-y divide-hairline">
        {recent.map((t) => (
          <li key={t.id} className="flex items-center gap-2.5 py-2 md:gap-2 md:py-1">
            <CategoryDot category={t.categoryId ? catMap.get(t.categoryId) : undefined} size={30} className="md:[--dot:24px]" />
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 text-sm font-medium">
                <TxnName txn={t} />
              </p>
              <p className="text-xs text-ink-3">{fmtDay(t.date)}</p>
            </div>
            <span className={cx('text-sm font-semibold tabular', t.amountMinor > 0 && 'text-good-text')}>
              {money(t.amountMinor, { sign: t.amountMinor > 0 })}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
