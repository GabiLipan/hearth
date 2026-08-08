import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Eye } from 'lucide-react'
import { getDaysInMonth } from 'date-fns'
import type { Transaction, Category, Budget, Bill, Account, GrantLevel } from '../lib/db'
import { thisMonthKey, monthLabel, fmtDay, daysUntil, fmtFullDate } from '../lib/dates'
import { monthlySpendByCategory, monthsEndingAt } from '../lib/stats'
import {
  bookSeries,
  bookSlices,
  bookTotals,
  BOOK_WORDS,
  type BookId,
  type BookMap,
  type Flow,
} from '../lib/books'
import { typicalRange } from '../lib/budgetHistory'
import { balanceOf, canSeeTransactionsAt, levelOn } from '../lib/accounts'
import { useApp } from '../state/AppContext'
import { Card, CategoryDot, Progress, cx } from './ui'
import { BudgetBullet } from './BudgetBullet'
import { CategoryIcon } from './CategoryIcon'
import { CategoryDonut, SpendBars } from './charts'

export interface HomeData {
  txns: Transaction[]
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

const month = () => thisMonthKey()

/* ---------- Month summary hero ---------- */

/** One figure in the desktop stat strip. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="min-w-0 px-4 first:pl-0 last:pr-0">
      <p className="text-xs text-ink-3">{label}</p>
      <p
        className={cx(
          'mt-0.5 truncate text-lg font-bold tracking-tight tabular',
          tone === 'good' && 'text-good-text',
          tone === 'bad' && 'text-critical-text',
        )}
      >
        {value}
      </p>
    </div>
  )
}

export function HeroWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const words = BOOK_WORDS[data.book]
  const totals = useMemo(
    () => bookTotals(data.txns, data.flows, data.book, month(), data.books),
    [data.txns, data.flows, data.book, data.books],
  )
  const budgetTotal = data.budgets.reduce((s, b) => s + b.amountMinor, 0)
  const frac = budgetTotal > 0 ? totals.spend / budgetTotal : 0
  const over = frac > 1
  const bar = budgetTotal > 0 && <Progress fraction={frac} tone={over ? 'over' : frac > 0.85 ? 'warn' : 'ok'} />

  return (
    <Card className="p-4 md:p-3">
      {/* Phone: one headline figure with the detail stacked underneath. */}
      <div className="flex flex-wrap items-end justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <p className="text-sm text-ink-3">{monthLabel(month())} · {words.spend.toLowerCase()}</p>
          <p className="mt-0.5 truncate text-3xl font-bold tracking-tight tabular">{money(totals.spend)}</p>
          {budgetTotal > 0 && (
            <p className="mt-0.5 text-sm text-ink-2">
              of {money(budgetTotal, { hideDecimals: true })}
              {over ? (
                <span className="font-medium text-critical-text"> · {money(totals.spend - budgetTotal)} over</span>
              ) : (
                <span className="font-medium text-good-text"> · {money(budgetTotal - totals.spend)} left</span>
              )}
            </p>
          )}
        </div>
        <div className="min-w-36 flex-1">
          <div className="mb-1.5 flex justify-between gap-2 text-xs text-ink-3">
            <span className="truncate">{words.income} {money(totals.income, { compact: true })}</span>
            <span className="truncate">{words.net} {money(totals.net, { sign: true, compact: true })}</span>
          </div>
          {bar}
        </div>
      </div>

      {/* Desktop: a strip of figures across the full width. */}
      <div className="hidden md:block">
        <p className="text-xs text-ink-3">{monthLabel(month())}</p>
        <div className="mt-1 flex flex-nowrap items-start divide-x divide-hairline">
          <Stat label={words.spend} value={money(totals.spend)} />
          <Stat label={words.income} value={money(totals.income)} />
          {data.book === 'mine' && totals.contributed > 0 && (
            <Stat label="To household" value={money(totals.contributed)} />
          )}
          <Stat
            label={words.net}
            value={money(totals.net, { sign: true })}
            tone={totals.net < 0 ? 'bad' : 'good'}
          />
          {budgetTotal > 0 && <Stat label="Budgeted" value={money(budgetTotal, { hideDecimals: true })} />}
        </div>
        {budgetTotal > 0 && <div className="mt-2">{bar}</div>}
      </div>
    </Card>
  )
}

/* ---------- Budgets at a glance ---------- */
export function BudgetGlanceWidget({ data }: { data: HomeData }) {
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
      <div className="mb-3 flex items-baseline justify-between gap-2 md:mb-2">
        <h3 className="font-semibold md:text-sm">Budgets</h3>
        <p className="text-sm text-ink-2 tabular">
          <span className="font-semibold text-ink">{money(totalSpent, { compact: true })}</span> of{' '}
          {money(totalBudget, { compact: true, hideDecimals: true })}
        </p>
      </div>
      {/* This widget spans the full page width, so on a wide screen the rows
          split into columns — a bar 1,000px long is harder to read, not easier. */}
      <ul className="grid gap-2.5 md:gap-x-6 md:gap-y-1.5 lg:grid-cols-2 min-[1800px]:grid-cols-3">
        {rows.map(({ cat, budget, spent: catSpent, typical }) => {
          const over = catSpent > budget
          return (
            <li key={cat.id} className="flex items-center gap-2.5 md:gap-2">
              <span className="grid w-5 shrink-0 place-items-center" style={{ color: `var(--series-${cat.slot})` }} aria-hidden>
                <CategoryIcon icon={cat.icon} size={15} />
              </span>
              <span className="w-24 truncate text-sm text-ink-2 sm:w-32">{cat.name}</span>
              <BudgetBullet
                className="flex-1"
                spent={catSpent}
                budget={budget}
                typical={typical}
                pace={paceFrac}
                color={`var(--series-${cat.slot})`}
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
export function AccountsWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  if (data.accounts.length === 0) return null
  const balance = (a: Account) => balanceOf(a, data.txns, data.remoteBalances, levelOn(a.id, data.levels))
  const total = data.accounts.reduce((s, a) => s + balance(a), 0)
  return (
    <Card className="p-4 md:p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-semibold md:text-sm">Accounts</h3>
        <span className="text-sm font-semibold tabular">{money(total)}</span>
      </div>
      <ul className="divide-y divide-hairline">
        {data.accounts.map((a) => {
          const level = levelOn(a.id, data.levels)
          const bal = balance(a)
          return (
            <li key={a.id} className="flex items-center gap-2 py-2 md:py-1">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {a.name}
                {/* The eye means "you can see what is in it, not what it was
                    spent on" — the one tier where the total on the right comes
                    from the server rather than from rows this device holds. */}
                {!canSeeTransactionsAt(level) && <Eye size={12} className="ml-1.5 inline text-ink-3" />}
              </span>
              <span className={cx('text-sm font-semibold tabular', bal < 0 && 'text-critical-text')}>{money(bal)}</span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ---------- Where it went ---------- */
export function DonutWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const slices = useMemo(
    () => bookSlices(data.txns, data.flows, data.categories, data.book, month(), data.books, undefined, 6),
    [data.txns, data.flows, data.categories, data.book, data.books],
  )
  const spent = slices.reduce((s, x) => s + x.totalMinor, 0)
  if (slices.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <h3 className="mb-2 font-semibold md:mb-1.5 md:text-sm">Where it went</h3>
      <CategoryDonut slices={slices} height={180} centerLabel={{ title: 'spent', value: money(spent, { compact: true }) }} />
    </Card>
  )
}

/* ---------- Trend ---------- */
export function TrendWidget({ data }: { data: HomeData }) {
  const series = useMemo(
    () => bookSeries(data.txns, data.flows, data.book, 6, data.books),
    [data.txns, data.flows, data.book, data.books],
  )
  return (
    <Card className="p-4 md:p-3">
      <h3 className="mb-2 font-semibold md:mb-1.5 md:text-sm">Spending, last 6 months</h3>
      <SpendBars data={series} height={170} />
    </Card>
  )
}

/* ---------- Upcoming bills ---------- */
export function BillsWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const upcoming = data.bills
    .filter((b) => b.active && daysUntil(b.nextDue) <= 14)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
    .slice(0, 5)
  if (upcoming.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="font-semibold md:text-sm">Coming up</h3>
        <Link to="/bills" className="flex items-center gap-1 text-sm font-medium text-accent">
          All bills <ArrowRight size={13} />
        </Link>
      </div>
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
export function RecentWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const recent = useMemo(
    () => [...data.txns].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, 5),
    [data.txns],
  )
  if (recent.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="font-semibold md:text-sm">Recent</h3>
        <Link to="/activity" className="flex items-center gap-1 text-sm font-medium text-accent">
          All activity <ArrowRight size={13} />
        </Link>
      </div>
      <ul className="divide-y divide-hairline">
        {recent.map((t) => (
          <li key={t.id} className="flex items-center gap-2.5 py-2 md:gap-2 md:py-1">
            <CategoryDot category={t.categoryId ? catMap.get(t.categoryId) : undefined} size={30} className="md:[--dot:24px]" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{t.payee}</p>
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
