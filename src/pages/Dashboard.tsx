import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowRight, Sparkles } from 'lucide-react'
import { db } from '../lib/db'
import { notDeleted } from '../lib/data'
import { thisMonthKey, monthLabel, fmtDay, daysUntil, fmtFullDate } from '../lib/dates'
import { spendByCategory, monthlySeries, monthTotals } from '../lib/stats'
import { seedDemoData } from '../lib/demo'
import { useApp } from '../state/AppContext'
import { Card, SectionTitle, Button, CategoryDot, Empty, Progress } from '../components/ui'
import { CategoryDonut, SpendBars } from '../components/charts'

export default function Dashboard() {
  const { money } = useApp()
  const month = thisMonthKey()
  const txns = useLiveQuery(() => db.transactions.filter(notDeleted).toArray(), [])
  const categories = useLiveQuery(() => db.categories.filter(notDeleted).toArray(), []) ?? []
  const budgets = useLiveQuery(() => db.budgets.filter(notDeleted).toArray(), []) ?? []
  const bills = useLiveQuery(() => db.bills.where('active').equals(1).filter(notDeleted).sortBy('nextDue'), []) ?? []
  const [seeding, setSeeding] = useState(false)

  const totals = useMemo(() => monthTotals(txns ?? [], month), [txns, month])
  const slices = useMemo(() => spendByCategory(txns ?? [], categories, month, 6), [txns, categories, month])
  const trend = useMemo(() => monthlySeries(txns ?? [], categories, 6), [txns, categories])
  const budgetTotal = budgets.reduce((s, b) => s + b.amountMinor, 0)
  const upcoming = bills.filter((b) => daysUntil(b.nextDue) <= 14).slice(0, 5)
  const recent = useMemo(
    () => [...(txns ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 5),
    [txns],
  )
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id!, c])), [categories])

  if (txns && txns.length === 0) {
    return (
      <Empty
        emoji="👋"
        title="Welcome to Hearth"
        hint="Your shared home for budgets, bills and spending. Add your first transaction with the + button, import a bank statement from the Activity tab — or explore with demo data first."
        action={
          <Button
            disabled={seeding}
            onClick={async () => {
              setSeeding(true)
              await seedDemoData()
            }}
          >
            <Sparkles size={16} /> {seeding ? 'Loading…' : 'Load demo data'}
          </Button>
        }
      />
    )
  }

  const spentFraction = budgetTotal > 0 ? totals.spend / budgetTotal : 0

  return (
    <div>
      {/* Hero summary */}
      <Card className="p-5 md:p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm text-ink-3">{monthLabel(month)} · spent so far</p>
            <p className="mt-1 text-4xl font-bold tracking-tight tabular md:text-5xl">{money(totals.spend)}</p>
            {budgetTotal > 0 && (
              <p className="mt-1 text-sm text-ink-2">
                of {money(budgetTotal, { hideDecimals: true })} budgeted
                {spentFraction <= 1 ? (
                  <span className="text-good-text font-medium"> · {money(budgetTotal - totals.spend)} left</span>
                ) : (
                  <span className="text-critical-text font-medium"> · {money(totals.spend - budgetTotal)} over</span>
                )}
              </p>
            )}
          </div>
          <div className="min-w-40 flex-1 md:max-w-60">
            <div className="mb-1.5 flex justify-between text-xs text-ink-3">
              <span>Income {money(totals.income, { compact: true })}</span>
              <span>Net {money(totals.net, { sign: true, compact: true })}</span>
            </div>
            {budgetTotal > 0 && (
              <Progress fraction={spentFraction} tone={spentFraction > 1 ? 'over' : spentFraction > 0.85 ? 'warn' : 'ok'} />
            )}
          </div>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* Where it went */}
        {slices.length > 0 && (
          <Card className="p-5">
            <h3 className="mb-3 font-semibold">Where it went</h3>
            <CategoryDonut slices={slices} height={200} centerLabel={{ title: 'spent', value: money(totals.spend, { compact: true }) }} />
          </Card>
        )}

        {/* 6-month trend */}
        <Card className="p-5">
          <h3 className="mb-3 font-semibold">Spending, last 6 months</h3>
          <SpendBars data={trend} height={200} />
        </Card>
      </div>

      {/* Upcoming bills */}
      {upcoming.length > 0 && (
        <>
          <SectionTitle
            action={
              <Link to="/bills" className="flex items-center gap-1 text-sm font-medium text-accent">
                All bills <ArrowRight size={14} />
              </Link>
            }
          >
            Coming up
          </SectionTitle>
          <Card>
            <ul className="divide-y divide-hairline">
              {upcoming.map((b) => {
                const days = daysUntil(b.nextDue)
                return (
                  <li key={b.id} className="flex items-center gap-3 px-4 py-3">
                    <CategoryDot category={catMap.get(b.categoryId)} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{b.name}</p>
                      <p className="text-sm text-ink-3">
                        {days < 0 ? `Overdue — was due ${fmtFullDate(b.nextDue)}` : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due ${fmtDay(b.nextDue)}`}
                      </p>
                    </div>
                    <span className="font-semibold tabular">{money(b.amountMinor)}</span>
                  </li>
                )
              })}
            </ul>
          </Card>
        </>
      )}

      {/* Recent activity */}
      <SectionTitle
        action={
          <Link to="/activity" className="flex items-center gap-1 text-sm font-medium text-accent">
            All activity <ArrowRight size={14} />
          </Link>
        }
      >
        Recent
      </SectionTitle>
      <Card>
        <ul className="divide-y divide-hairline">
          {recent.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-3">
              <CategoryDot category={catMap.get(t.categoryId)} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{t.payee}</p>
                <p className="text-sm text-ink-3">{fmtDay(t.date)}</p>
              </div>
              <span className={`font-semibold tabular ${t.amountMinor > 0 ? 'text-good-text' : ''}`}>
                {money(t.amountMinor, { sign: t.amountMinor > 0 })}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
