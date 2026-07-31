import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Lock, Eye } from 'lucide-react'
import { getDaysInMonth } from 'date-fns'
import type { Transaction, Category, Budget, Bill, Account } from '../lib/db'
import { thisMonthKey, monthLabel, monthKey, fmtDay, daysUntil, fmtFullDate } from '../lib/dates'
import { spendByCategory, monthlySeries, monthTotals } from '../lib/stats'
import { balanceOf } from '../lib/accounts'
import { useApp } from '../state/AppContext'
import { Card, CategoryDot, Progress, cx } from './ui'
import { CategoryIcon } from './CategoryIcon'
import { CategoryDonut, SpendBars } from './charts'

export interface HomeData {
  txns: Transaction[]
  categories: Category[]
  budgets: Budget[]
  bills: Bill[]
  accounts: Account[]
  /** Server-computed balances for accounts whose transactions we cannot read. */
  remoteBalances: Map<string, number>
  userId?: string
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
  const totals = useMemo(() => monthTotals(data.txns, month()), [data.txns])
  const budgetTotal = data.budgets.reduce((s, b) => (b.ownerId ? s : s + b.amountMinor), 0)
  const frac = budgetTotal > 0 ? totals.spend / budgetTotal : 0
  const over = frac > 1
  const bar = budgetTotal > 0 && <Progress fraction={frac} tone={over ? 'over' : frac > 0.85 ? 'warn' : 'ok'} />

  return (
    <Card className="p-4 md:p-3">
      {/* Phone: one headline figure with the detail stacked underneath. */}
      <div className="flex flex-wrap items-end justify-between gap-3 md:hidden">
        <div>
          <p className="text-sm text-ink-3">{monthLabel(month())} · spent so far</p>
          <p className="mt-0.5 text-3xl font-bold tracking-tight tabular">{money(totals.spend)}</p>
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
          <div className="mb-1.5 flex justify-between text-xs text-ink-3">
            <span>In {money(totals.income, { compact: true })}</span>
            <span>Net {money(totals.net, { sign: true, compact: true })}</span>
          </div>
          {bar}
        </div>
      </div>

      {/* Desktop: a strip of figures across the full width — the numbers that
          were buried in a sub-line each get their own column. */}
      <div className="hidden md:block">
        <p className="text-xs text-ink-3">{monthLabel(month())}</p>
        <div className="mt-1 flex flex-wrap items-start divide-x divide-hairline">
          <Stat label="Spent so far" value={money(totals.spend)} />
          {budgetTotal > 0 && <Stat label="Budgeted" value={money(budgetTotal, { hideDecimals: true })} />}
          {budgetTotal > 0 && (
            <Stat
              label={over ? 'Over budget' : 'Left to spend'}
              value={money(over ? totals.spend - budgetTotal : budgetTotal - totals.spend)}
              tone={over ? 'bad' : 'good'}
            />
          )}
          <Stat label="Income" value={money(totals.income)} />
          <Stat label="Net" value={money(totals.net, { sign: true })} tone={totals.net < 0 ? 'bad' : 'good'} />
        </div>
        {budgetTotal > 0 && <div className="mt-2.5">{bar}</div>}
      </div>
    </Card>
  )
}

/* ---------- Budgets at a glance ---------- */
export function BudgetGlanceWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const now = new Date()
  const paceFrac = now.getDate() / getDaysInMonth(now)
  const spent = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of data.txns) {
      if (t.amountMinor >= 0 || !t.categoryId || monthKey(t.date) !== month()) continue
      m.set(t.categoryId, (m.get(t.categoryId) ?? 0) - t.amountMinor)
    }
    return m
  }, [data.txns])
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const rows = data.budgets
    .filter((b) => !b.ownerId && catMap.has(b.categoryId)) // the household's budgets
    .map((b) => ({
      cat: catMap.get(b.categoryId)!,
      budget: b.amountMinor,
      spent: spent.get(b.categoryId) ?? 0,
    }))
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
        {rows.map(({ cat, budget, spent: catSpent }) => {
          const frac = catSpent / budget
          const over = frac > 1
          const barColor = over ? 'var(--critical)' : frac > 0.85 ? 'var(--warning)' : 'var(--accent)'
          return (
            <li key={cat.id} className="flex items-center gap-2.5 md:gap-2">
              <span className="grid w-5 shrink-0 place-items-center" style={{ color: `var(--series-${cat.slot})` }} aria-hidden>
                <CategoryIcon icon={cat.icon} size={15} />
              </span>
              <span className="w-24 truncate text-sm text-ink-2 sm:w-32">{cat.name}</span>
              <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-2 md:h-1.5">
                <span
                  className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
                  style={{ width: `${Math.min(100, frac * 100)}%`, background: barColor }}
                />
                {/* today's pace marker: fill left of this line = on track */}
                <span
                  className="absolute inset-y-0 w-px bg-ink-3/70"
                  style={{ left: `${paceFrac * 100}%` }}
                  aria-hidden
                />
              </span>
              <span className={cx('w-16 shrink-0 text-right text-xs font-medium tabular', over ? 'text-critical-text' : 'text-ink-2')}>
                {over ? `+${money(catSpent - budget, { compact: true })}` : money(budget - catSpent, { compact: true })}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-xs text-ink-3 md:mt-2">
        Bar = spent · line = where today sits in the month · right column = left (or over)
      </p>
    </Card>
  )
}

/* ---------- Accounts ---------- */
export function AccountsWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  if (data.accounts.length === 0) return null
  const balance = (a: Account) => balanceOf(a, data.txns, data.remoteBalances, data.userId)
  const total = data.accounts.reduce((s, a) => s + balance(a), 0)
  return (
    <Card className="p-4 md:p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-semibold md:text-sm">Accounts</h3>
        <span className="text-sm font-semibold tabular">{money(total)}</span>
      </div>
      <ul className="divide-y divide-hairline">
        {data.accounts.map((a) => {
          const vis = a.visibility
          const bal = balance(a)
          return (
            <li key={a.id} className="flex items-center gap-2 py-2 md:py-1">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {a.name}
                {vis === 'private' && <Lock size={12} className="ml-1.5 inline text-ink-3" />}
                {vis === 'balance' && <Eye size={12} className="ml-1.5 inline text-ink-3" />}
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
  const totals = useMemo(() => monthTotals(data.txns, month()), [data.txns])
  const slices = useMemo(() => spendByCategory(data.txns, data.categories, month(), 6), [data.txns, data.categories])
  if (slices.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <h3 className="mb-2 font-semibold md:mb-1.5 md:text-sm">Where it went</h3>
      <CategoryDonut slices={slices} height={180} centerLabel={{ title: 'spent', value: money(totals.spend, { compact: true }) }} />
    </Card>
  )
}

/* ---------- Trend ---------- */
export function TrendWidget({ data }: { data: HomeData }) {
  const series = useMemo(() => monthlySeries(data.txns, data.categories, 6), [data.txns, data.categories])
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
