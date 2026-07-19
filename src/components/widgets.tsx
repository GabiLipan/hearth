import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Lock, Eye } from 'lucide-react'
import { getDaysInMonth } from 'date-fns'
import type { Transaction, Category, Budget, Bill, Account } from '../lib/db'
import { thisMonthKey, monthLabel, monthKey, fmtDay, daysUntil, fmtFullDate } from '../lib/dates'
import { spendByCategory, monthlySeries, monthTotals } from '../lib/stats'
import { computeBalance } from '../lib/accounts'
import { useApp } from '../state/AppContext'
import { Card, CategoryDot, Progress, cx } from './ui'
import { CategoryDonut, SpendBars } from './charts'

export interface HomeData {
  txns: Transaction[]
  categories: Category[]
  budgets: Budget[]
  bills: Bill[]
  accounts: Account[]
  userId?: string
}

const month = () => thisMonthKey()

/* ---------- Month summary hero ---------- */
export function HeroWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const totals = useMemo(() => monthTotals(data.txns, month()), [data.txns])
  const budgetTotal = data.budgets.reduce((s, b) => s + b.amountMinor, 0)
  const frac = budgetTotal > 0 ? totals.spend / budgetTotal : 0
  return (
    <Card className="p-4 md:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-ink-3">{monthLabel(month())} · spent so far</p>
          <p className="mt-0.5 text-3xl font-bold tracking-tight tabular md:text-4xl">{money(totals.spend)}</p>
          {budgetTotal > 0 && (
            <p className="mt-0.5 text-sm text-ink-2">
              of {money(budgetTotal, { hideDecimals: true })}
              {frac <= 1 ? (
                <span className="font-medium text-good-text"> · {money(budgetTotal - totals.spend)} left</span>
              ) : (
                <span className="font-medium text-critical-text"> · {money(totals.spend - budgetTotal)} over</span>
              )}
            </p>
          )}
        </div>
        <div className="min-w-36 flex-1 md:max-w-56">
          <div className="mb-1.5 flex justify-between text-xs text-ink-3">
            <span>In {money(totals.income, { compact: true })}</span>
            <span>Net {money(totals.net, { sign: true, compact: true })}</span>
          </div>
          {budgetTotal > 0 && <Progress fraction={frac} tone={frac > 1 ? 'over' : frac > 0.85 ? 'warn' : 'ok'} />}
        </div>
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
      if (t.amountMinor >= 0 || t.deleted || monthKey(t.date) !== month()) continue
      m.set(t.categoryId, (m.get(t.categoryId) ?? 0) - t.amountMinor)
    }
    return m
  }, [data.txns])
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id!, c])), [data.categories])
  const rows = data.budgets
    .filter((b) => catMap.has(b.categoryId))
    .map((b) => ({
      cat: catMap.get(b.categoryId)!,
      budget: b.amountMinor,
      spent: spent.get(b.categoryId) ?? 0,
    }))
    .sort((a, b) => b.spent / b.budget - a.spent / a.budget)
  if (rows.length === 0) {
    return (
      <Card className="p-4">
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
    <Card className="p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="font-semibold">Budgets</h3>
        <p className="text-sm text-ink-2 tabular">
          <span className="font-semibold text-ink">{money(totalSpent, { compact: true })}</span> of{' '}
          {money(totalBudget, { compact: true, hideDecimals: true })}
        </p>
      </div>
      <ul className="space-y-2.5">
        {rows.map(({ cat, budget, spent: catSpent }) => {
          const frac = catSpent / budget
          const over = frac > 1
          const barColor = over ? 'var(--critical)' : frac > 0.85 ? 'var(--warning)' : 'var(--accent)'
          return (
            <li key={cat.id} className="flex items-center gap-2.5">
              <span className="w-5 text-center text-sm" aria-hidden>
                {cat.emoji}
              </span>
              <span className="w-24 truncate text-sm text-ink-2 sm:w-32">{cat.name}</span>
              <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
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
      <p className="mt-3 text-xs text-ink-3">
        Bar = spent · line = where today sits in the month · right column = left (or over)
      </p>
    </Card>
  )
}

/* ---------- Accounts ---------- */
export function AccountsWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  if (data.accounts.length === 0) return null
  const balanceOf = (a: Account) =>
    a.ownerId && a.ownerId !== data.userId ? (a.balanceMinor ?? 0) : computeBalance(a, data.txns)
  const total = data.accounts.reduce((s, a) => s + balanceOf(a), 0)
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-semibold">Accounts</h3>
        <span className="text-sm font-semibold tabular">{money(total)}</span>
      </div>
      <ul className="divide-y divide-hairline">
        {data.accounts.map((a) => {
          const vis = a.visibility ?? 'shared'
          const bal = balanceOf(a)
          return (
            <li key={a.id} className="flex items-center gap-2 py-2">
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
    <Card className="p-4">
      <h3 className="mb-2 font-semibold">Where it went</h3>
      <CategoryDonut slices={slices} height={180} centerLabel={{ title: 'spent', value: money(totals.spend, { compact: true }) }} />
    </Card>
  )
}

/* ---------- Trend ---------- */
export function TrendWidget({ data }: { data: HomeData }) {
  const series = useMemo(() => monthlySeries(data.txns, data.categories, 6), [data.txns, data.categories])
  return (
    <Card className="p-4">
      <h3 className="mb-2 font-semibold">Spending, last 6 months</h3>
      <SpendBars data={series} height={170} />
    </Card>
  )
}

/* ---------- Upcoming bills ---------- */
export function BillsWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id!, c])), [data.categories])
  const upcoming = data.bills
    .filter((b) => b.active && !b.deleted && daysUntil(b.nextDue) <= 14)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
    .slice(0, 5)
  if (upcoming.length === 0) return null
  return (
    <Card className="p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="font-semibold">Coming up</h3>
        <Link to="/bills" className="flex items-center gap-1 text-sm font-medium text-accent">
          All bills <ArrowRight size={13} />
        </Link>
      </div>
      <ul className="divide-y divide-hairline">
        {upcoming.map((b) => {
          const days = daysUntil(b.nextDue)
          return (
            <li key={b.id} className="flex items-center gap-2.5 py-2">
              <CategoryDot category={catMap.get(b.categoryId)} size={30} />
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
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id!, c])), [data.categories])
  const recent = useMemo(
    () => [...data.txns].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 5),
    [data.txns],
  )
  if (recent.length === 0) return null
  return (
    <Card className="p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="font-semibold">Recent</h3>
        <Link to="/activity" className="flex items-center gap-1 text-sm font-medium text-accent">
          All activity <ArrowRight size={13} />
        </Link>
      </div>
      <ul className="divide-y divide-hairline">
        {recent.map((t) => (
          <li key={t.id} className="flex items-center gap-2.5 py-2">
            <CategoryDot category={catMap.get(t.categoryId)} size={30} />
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
