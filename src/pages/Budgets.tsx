import { useMemo, useRef, useState } from 'react'
import { Target, Copy, Check } from 'lucide-react'
import type { Budget, Category } from '../lib/db'
import { create, update, remove } from '../lib/data'
import { rpc } from '../lib/api'
import { syncNow } from '../lib/session'
import { useAllTransactions, useBudgetsForMonth, useCategories } from '../lib/cache'
import { budgetCategoryId, styleOf, topLevel } from '../lib/categories'
import { monthlySpendByCategory, monthsEndingAt, typicalSpend, isTransfer } from '../lib/stats'
import { thisMonthKey, monthLabel, monthKey, shiftMonth } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { useSyncState } from '../hooks/useSync'
import { parseAmount, currencySymbol } from '../lib/money'
import { Card, CategoryDot, Progress, Button, Empty, Segmented, Toolbar, MonthStepper, cx } from '../components/ui'
import { Sparkline } from '../components/Sparkline'

/**
 * Budgets are set in place.
 *
 * The previous version opened a sheet per category, so setting eight budgets
 * meant eight sheets. Here the amount is an input where the number already is:
 * on desktop you tab down the column and set the lot in one pass, and on a
 * phone the field takes a numeric keypad with steppers either side.
 *
 * Budgets belong to a month, so moving back through the stepper shows what was
 * actually budgeted then rather than today's figure projected backwards.
 */

const HISTORY_MONTHS = 6

interface Row {
  category: Category
  budget?: Budget
  spent: number
  history: number[]
  suggestion?: number
}

export default function Budgets() {
  const { money, currency } = useApp()
  const { userId } = useSyncState()
  const [month, setMonth] = useState(thisMonthKey())
  const [scope, setScope] = useState<'household' | 'mine'>('household')
  const [copying, setCopying] = useState(false)

  const categories = useCategories()
  const budgets = useBudgetsForMonth(month)
  const txns = useAllTransactions() ?? []

  const mine = scope === 'mine' && !!userId
  const isCurrent = month === thisMonthKey()

  const scoped = useMemo(
    () => budgets.filter((b) => (mine ? b.ownerId === userId : !b.ownerId)),
    [budgets, mine, userId],
  )
  const budgetByCategory = useMemo(() => new Map(scoped.map((b) => [b.categoryId, b])), [scoped])

  const months = useMemo(() => monthsEndingAt(month, HISTORY_MONTHS), [month])
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  // Personal budgets track only what you recorded yourself, so the history they
  // are judged against has to be filtered the same way.
  const relevantTxns = useMemo(
    () => (mine ? txns.filter((t) => t.createdBy === userId) : txns),
    [txns, mine, userId],
  )
  const history = useMemo(
    () => monthlySpendByCategory(relevantTxns, categories, months),
    [relevantTxns, categories, months],
  )

  const spentThisMonth = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of relevantTxns) {
      if (t.amountMinor >= 0 || isTransfer(t) || monthKey(t.date) !== month) continue
      const key = budgetCategoryId(catMap.get(t.categoryId ?? ''))
      if (!key) continue
      m.set(key, (m.get(key) ?? 0) - t.amountMinor)
    }
    return m
  }, [relevantTxns, catMap, month])

  const rows: Row[] = useMemo(() => {
    // Budgets live on top-level categories; subcategory spending rolls up.
    const expense = topLevel(categories).filter((c) => c.kind === 'expense')
    return expense.map((category) => {
      const series = history.get(category.id) ?? months.map(() => 0)
      return {
        category,
        budget: budgetByCategory.get(category.id),
        spent: spentThisMonth.get(category.id) ?? 0,
        history: series,
        // Suggest from every month except the one being edited, so a part-way
        // month does not drag its own suggestion down.
        suggestion: typicalSpend(series.slice(0, -1)),
      }
    })
  }, [categories, history, months, budgetByCategory, spentThisMonth])

  const budgeted = rows.filter((r) => r.budget)
  const unbudgeted = rows.filter((r) => !r.budget)
  const totalBudget = budgeted.reduce((s, r) => s + r.budget!.amountMinor, 0)
  const totalSpent = budgeted.reduce((s, r) => s + r.spent, 0)
  const totalFrac = totalBudget > 0 ? totalSpent / totalBudget : 0

  async function setAmount(row: Row, minor: number | null) {
    if (minor === null || minor <= 0) {
      if (row.budget) await remove('budgets', row.budget.id)
      return
    }
    if (row.budget) {
      await update('budgets', row.budget.id, { amountMinor: minor })
    } else {
      await create('budgets', {
        categoryId: row.category.id,
        amountMinor: minor,
        ownerId: mine ? userId : undefined,
        month: `${month}-01`,
      })
    }
  }

  async function copyLastMonth() {
    setCopying(true)
    try {
      await rpc('copy_budgets', { p_from: `${shiftMonth(month, -1)}-01`, p_to: `${month}-01` })
      await syncNow()
    } finally {
      setCopying(false)
    }
  }

  const symbol = currencySymbol(currency)

  return (
    <div>
      <Toolbar className="justify-center md:justify-start">
        <MonthStepper month={month} onChange={setMonth} label={monthLabel} canGoForward={!isCurrent} />
        {userId && (
          <Segmented
            value={scope}
            onChange={setScope}
            className="w-48"
            options={[
              { value: 'household', label: 'Household' },
              { value: 'mine', label: 'Just mine' },
            ]}
          />
        )}
        {budgeted.length > 0 && (
          <div className="hidden min-w-64 flex-1 items-center gap-2.5 md:flex">
            <span className="text-sm text-ink-2 tabular">
              <span className="font-semibold text-ink">{money(totalSpent)}</span> of{' '}
              {money(totalBudget, { hideDecimals: true })}
            </span>
            <Progress
              className="max-w-64 flex-1"
              fraction={totalFrac}
              tone={totalFrac > 1 ? 'over' : totalFrac > 0.85 ? 'warn' : 'ok'}
            />
          </div>
        )}
        {budgeted.length === 0 && rows.length > 0 && (
          <Button size="sm" variant="subtle" disabled={copying} onClick={copyLastMonth}>
            <Copy size={14} /> Copy {monthLabel(shiftMonth(month, -1), 'short')}
          </Button>
        )}
      </Toolbar>

      {mine && (
        <p className="mb-3 text-center text-xs text-ink-3 md:mb-2 md:text-left">
          Personal budgets count only the spending you record yourself.
        </p>
      )}

      {rows.length === 0 ? (
        <Empty icon={Target} title="No expense categories yet" hint="Add some in Settings and they'll appear here." />
      ) : (
        <>
          <Card className="mb-3 p-4 md:hidden">
            <div className="flex items-baseline justify-between">
              <p className="text-sm text-ink-3">Total budgeted</p>
              <p className="text-sm text-ink-2 tabular">
                <span className="font-semibold text-ink">{money(totalSpent)}</span> of{' '}
                {money(totalBudget, { hideDecimals: true })}
              </p>
            </div>
            <div className="mt-2">
              <Progress fraction={totalFrac} tone={totalFrac > 1 ? 'over' : totalFrac > 0.85 ? 'warn' : 'ok'} />
            </div>
          </Card>

          {/* Desktop: one dense table you can tab straight down. */}
          <Card className="hidden overflow-hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-3">
                  <th className="py-2 pl-3 text-left font-medium">Category</th>
                  <th className="px-3 text-left font-medium">Last {HISTORY_MONTHS} months</th>
                  <th className="px-3 text-right font-medium">Budget</th>
                  <th className="px-3 text-right font-medium">Spent</th>
                  <th className="px-3 text-right font-medium">Left</th>
                  <th className="w-40 pr-3 text-left font-medium">Progress</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <BudgetRow key={row.category.id} row={row} catMap={catMap} symbol={symbol} money={money} onCommit={setAmount} />
                ))}
              </tbody>
            </table>
          </Card>

          {/* Phone: the same edit-in-place, as cards. */}
          <div className="space-y-2 md:hidden">
            {[...budgeted, ...unbudgeted].map((row) => (
              <BudgetCard key={row.category.id} row={row} catMap={catMap} symbol={symbol} money={money} onCommit={setAmount} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

type MoneyFn = (minor: number, opts?: { sign?: boolean; compact?: boolean; hideDecimals?: boolean }) => string
type CommitFn = (row: Row, minor: number | null) => void | Promise<void>

/**
 * The amount field.
 *
 * Kept as local text while focused so a half-typed "4" does not momentarily
 * save a £4 budget, and committed on blur or Enter. Escape restores what was
 * there, which matters when the value is saved the instant you look away.
 */
function AmountInput({
  value,
  symbol,
  onCommit,
  className,
}: {
  value?: number
  symbol: string
  onCommit: (minor: number | null) => void
  className?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const shown = draft ?? (value != null ? String(value / 100) : '')

  return (
    <div className={cx('relative', className)}>
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3">{symbol}</span>
      <input
        ref={ref}
        value={shown}
        inputMode="decimal"
        aria-label="Budget amount"
        placeholder="—"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          if (draft !== null) onCommit(draft.trim() === '' ? null : parseAmount(draft))
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
        className={cx(
          'w-full rounded-lg border border-transparent bg-surface-2 py-1.5 pl-6 pr-2 text-right tabular',
          'transition-colors hover:border-hairline focus:border-accent focus:bg-surface focus:outline-none',
        )}
      />
    </div>
  )
}

function SuggestionButton({ minor, money, onAccept }: { minor: number; money: MoneyFn; onAccept: () => void }) {
  return (
    <button
      onClick={onAccept}
      className="whitespace-nowrap rounded-full px-2 py-0.5 text-xs text-ink-3 ring-1 ring-hairline transition-colors hover:text-ink hover:ring-ink-3/40"
      title="Use this amount"
    >
      typically {money(minor, { hideDecimals: true })}
    </button>
  )
}

function BudgetRow({
  row, catMap, symbol, money, onCommit,
}: {
  row: Row
  catMap: Map<string, Category>
  symbol: string
  money: MoneyFn
  onCommit: CommitFn
}) {
  const budget = row.budget?.amountMinor
  const left = budget != null ? budget - row.spent : undefined
  const frac = budget ? row.spent / budget : 0
  const style = styleOf(row.category, catMap)

  return (
    <tr className="border-b border-hairline/60 last:border-0">
      <td className="py-1.5 pl-3">
        <span className="flex items-center gap-2">
          <CategoryDot category={{ ...row.category, ...style }} size={24} />
          <span className="truncate font-medium">{row.category.name}</span>
        </span>
      </td>
      <td className="px-3">
        <Sparkline values={row.history} budget={budget} />
      </td>
      <td className="px-3 py-1.5 text-right">
        <div className="flex items-center justify-end gap-2">
          {budget == null && row.suggestion != null && (
            <SuggestionButton minor={row.suggestion} money={money} onAccept={() => onCommit(row, row.suggestion!)} />
          )}
          <AmountInput
            value={budget}
            symbol={symbol}
            className="w-28"
            onCommit={(minor) => onCommit(row, minor)}
          />
        </div>
      </td>
      <td className="px-3 text-right tabular text-ink-2">{row.spent > 0 ? money(row.spent) : '—'}</td>
      <td className={cx('px-3 text-right font-medium tabular', left != null && left < 0 && 'text-critical-text')}>
        {left != null ? money(left) : '—'}
      </td>
      <td className="py-1.5 pr-3">
        {budget != null && <Progress fraction={frac} tone={frac > 1 ? 'over' : frac > 0.85 ? 'warn' : 'ok'} />}
      </td>
    </tr>
  )
}

function BudgetCard({
  row, catMap, symbol, money, onCommit,
}: {
  row: Row
  catMap: Map<string, Category>
  symbol: string
  money: MoneyFn
  onCommit: CommitFn
}) {
  const budget = row.budget?.amountMinor
  const left = budget != null ? budget - row.spent : undefined
  const frac = budget ? row.spent / budget : 0
  const style = styleOf(row.category, catMap)

  // ±10% of the current amount, rounded to the nearest pound: a nudge that
  // stays useful whether the budget is £30 or £900.
  const step = budget ? Math.max(500, Math.round(budget * 0.1 / 100) * 100) : 1000
  const nudge = (by: number) => onCommit(row, Math.max(0, (budget ?? 0) + by))

  return (
    <Card className="p-3.5">
      <div className="flex items-center gap-2.5">
        <CategoryDot category={{ ...row.category, ...style }} size={34} />
        <span className="min-w-0 flex-1 truncate font-medium">{row.category.name}</span>
        {budget != null && (
          <span className={cx('shrink-0 text-sm font-semibold tabular', left! < 0 ? 'text-critical-text' : 'text-good-text')}>
            {left! < 0 ? `${money(-left!)} over` : `${money(left!)} left`}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        {budget != null && (
          <button
            onClick={() => nudge(-step)}
            aria-label={`Reduce ${row.category.name} budget`}
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-lg text-ink-2 active:scale-95"
          >
            −
          </button>
        )}
        <AmountInput value={budget} symbol={symbol} className="flex-1" onCommit={(minor) => onCommit(row, minor)} />
        {budget != null && (
          <button
            onClick={() => nudge(step)}
            aria-label={`Increase ${row.category.name} budget`}
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-lg text-ink-2 active:scale-95"
          >
            +
          </button>
        )}
        {budget == null && row.suggestion != null && (
          <Button size="sm" variant="subtle" className="shrink-0" onClick={() => onCommit(row, row.suggestion!)}>
            <Check size={14} /> {money(row.suggestion, { hideDecimals: true })}
          </Button>
        )}
      </div>

      {budget != null && (
        <>
          <div className="mt-2.5">
            <Progress fraction={frac} tone={frac > 1 ? 'over' : frac > 0.85 ? 'warn' : 'ok'} />
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <p className="text-sm text-ink-3 tabular">
              {money(row.spent)} of {money(budget, { hideDecimals: true })}
            </p>
            <Sparkline values={row.history} budget={budget} width={72} height={18} />
          </div>
        </>
      )}
    </Card>
  )
}
