import { useCallback, useMemo, useRef, useState } from 'react'
import { Target, Copy, Check } from 'lucide-react'
import type { Budget, Category } from '../lib/db'
import { create, update, remove } from '../lib/data'
import { rpc } from '../lib/api'
import { syncNow } from '../lib/session'
import { useAllTransactions, useBook, useBooks, useBudgets, useCategories, useFlows, useCacheReady } from '../lib/cache'
import { accountsInBook, isSpend } from '../lib/books'
import { BookSwitcher } from '../components/BookSwitcher'
import { budgetCategoryId, styleOf, topLevel } from '../lib/categories'
import { monthlySpendByCategory, monthsEndingAt, typicalSpend } from '../lib/stats'
import { budgetSeries, fillBudgets, typicalRange, type FilledBudgets } from '../lib/budgetHistory'
import { thisMonthKey, monthLabel, monthKey, shiftMonth } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { useSyncState } from '../hooks/useSync'
import { parseAmount, currencySymbol } from '../lib/money'
import { Card, CategoryDot, Progress, Button, Empty, Toolbar, FilterBar, FilterChip, MonthStepper, ScrollTable, table, cx } from '../components/ui'
import { BudgetBullet } from '../components/BudgetBullet'
import { BudgetBars } from '../components/BudgetBars'

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
  /** The six finished months `history` covers, oldest first. */
  months: string[]
  /** The budget in force for each of those months, gaps filled. */
  budgetHistory: FilledBudgets
  /** The range this category normally spends in, for the bullet's context band. */
  typical?: [number, number]
  suggestion?: number
}

export default function Budgets() {
  const { money, currency } = useApp()
  const { userId } = useSyncState()
  const [month, setMonth] = useState(thisMonthKey())
  // The same lens as Home and Reports, rather than a second toggle that means
  // almost the same thing. A budget belongs to a book: the household's shared
  // ones, or my own.
  const [book, setBook] = useBook()
  const [copying, setCopying] = useState(false)

  const categories = useCategories()
  const ready = useCacheReady()
  // Every month, not just this one: the history column judges each month against
  // the budget that was actually in force for it.
  const allBudgets = useBudgets()
  const txns = useAllTransactions() ?? []

  const mine = book === 'mine' && !!userId
  const books = useBooks()
  const flows = useFlows(txns, books)
  const bookAccounts = useMemo(() => accountsInBook(book, books), [book, books])
  const isCurrent = month === thisMonthKey()

  const owned = useCallback(
    (b: Budget) =>
      book === 'mine' ? b.ownerId === userId : book === 'household' ? !b.ownerId : !b.ownerId || b.ownerId === userId,
    [book, userId],
  )
  const scoped = useMemo(
    () => allBudgets.filter((b) => owned(b) && b.month === `${month}-01`),
    [allBudgets, owned, month],
  )
  const budgetByCategory = useMemo(() => new Map(scoped.map((b) => [b.categoryId, b])), [scoped])

  // Six *finished* months, ending the month before the one on screen. The month
  // you are looking at is already in the row twice — the bullet and the spent
  // and left columns — and on the 4th of the month it is 90% "under budget",
  // which in a chart of percentages is a lie with a bar attached.
  const months = useMemo(() => monthsEndingAt(shiftMonth(month, -1), HISTORY_MONTHS), [month])
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  /**
   * A budget is judged against the spending of its own book.
   *
   * This used to filter personal budgets by `created_by`, which is a different
   * question and got both cases wrong: a household budget counted groceries put
   * on my private card — spending my partner cannot even see, so their screen
   * showed a different figure against the same shared budget — and a personal
   * budget counted anything I happened to record on a joint account.
   */
  const relevantTxns = useMemo(
    () => txns.filter((t) => bookAccounts.has(t.accountId)),
    [txns, bookAccounts],
  )
  const history = useMemo(
    () => monthlySpendByCategory(relevantTxns, categories, months),
    [relevantTxns, categories, months],
  )

  const spentThisMonth = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of relevantTxns) {
      // `isSpend` rather than "negative and not a transfer": a contribution to
      // the household leaves my account looking exactly like an expense.
      if (!isSpend(flows.get(t.id)) || monthKey(t.date) !== month) continue
      const key = budgetCategoryId(catMap.get(t.categoryId ?? ''))
      if (!key) continue
      m.set(key, (m.get(key) ?? 0) - t.amountMinor)
    }
    return m
  }, [relevantTxns, flows, catMap, month])

  const rows: Row[] = useMemo(() => {
    // Budgets live on top-level categories; subcategory spending rolls up.
    const expense = topLevel(categories).filter((c) => c.kind === 'expense')
    return expense.map((category) => {
      // Every month here has finished, so all six count towards what is
      // typical — no part-way month to exclude.
      const series = history.get(category.id) ?? months.map(() => 0)
      return {
        category,
        budget: budgetByCategory.get(category.id),
        spent: spentThisMonth.get(category.id) ?? 0,
        history: series,
        months,
        budgetHistory: fillBudgets(budgetSeries(allBudgets, category.id, months, owned), series),
        typical: typicalRange(series),
        suggestion: typicalSpend(series),
      }
    })
  }, [categories, history, months, budgetByCategory, spentThisMonth, allBudgets, owned])

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
      {/* Wide screens keep every control visible at once. */}
      <Toolbar className="max-md:hidden">
        <MonthStepper month={month} onChange={setMonth} label={monthLabel} canGoForward={!isCurrent} />
        {userId && <BookSwitcher book={book} onChange={setBook} className="md:w-auto" />}
        {budgeted.length > 0 && (
          <div className="flex min-w-64 flex-1 items-center gap-2.5">
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

      {/* A phone gets the same row every other page has: 36px pills, scrolling
          sideways. This page used to put the toolbar's own control here, which
          left the month as the one picker in the app that was a different
          height and a different shape from the one on Activity beside it. */}
      <FilterBar>
        <MonthStepper
          variant="chip"
          month={month}
          onChange={setMonth}
          label={monthLabel}
          canGoForward={!isCurrent}
        />
        {budgeted.length === 0 && rows.length > 0 && (
          <FilterChip
            chevron={false}
            disabled={copying}
            onClick={copyLastMonth}
            icon={<Copy size={15} />}
            label={`Copy ${monthLabel(shiftMonth(month, -1), 'short')}`}
          />
        )}
      </FilterBar>

      {/* Left, like the row above it. It was centred to match a centred toolbar
          that is no longer there. */}
      {mine && (
        <p className="mb-3 text-xs text-ink-3 md:mb-2">
          Personal budgets count spending on your own accounts. Moving money to the household is not spending.
        </p>
      )}

      {/* `ready` first: `[]` from a cache that has not opened yet is not the
          same claim as `[]` from one that has. See `useCacheReady`. */}
      {rows.length === 0 ? (
        ready ? (
          <Empty icon={Target} title="No expense categories yet" hint="Add some in Settings and they'll appear here." />
        ) : null
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
            {/* The two chart columns are percentages so they give width back as
                the window narrows; the rest are the widths their contents need. */}
            <ScrollTable minWidth={880}>
              <thead>
                <tr className="border-b border-hairline text-xs uppercase tracking-wide text-ink-3">
                  <th className={cx('w-[20%] min-w-36 py-2 pl-3 text-left font-medium', table.pinned)}>Category</th>
                  <th className="w-[24%] px-3 text-left font-medium">Last {HISTORY_MONTHS} months</th>
                  <th className="w-28 px-3 text-right font-medium">Budget</th>
                  <th className="w-24 px-3 text-right font-medium">Spent</th>
                  <th className="w-24 px-3 text-right font-medium">Left</th>
                  <th className="w-[26%] pr-3 text-left font-medium">Progress</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <BudgetRow key={row.category.id} row={row} catMap={catMap} symbol={symbol} money={money} onCommit={setAmount} />
                ))}
              </tbody>
            </ScrollTable>
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

/** Hover text for each bar — the figures the chart deliberately leaves out. */
function barLabels(row: Row, money: MoneyFn): string[] {
  return row.months.map((m, i) => {
    const spent = row.history[i]
    const budget = row.budgetHistory.amounts[i]
    const when = monthLabel(m, 'short')
    if (!row.budgetHistory.usable || budget <= 0) return `${when} · ${money(spent)}`
    const pct = Math.round(((spent - budget) / budget) * 100)
    const basis = row.budgetHistory.inferred[i] ? ' (assumed)' : ''
    return `${when} · ${money(spent)} of ${money(budget)}${basis} — ${Math.abs(pct)}% ${pct > 0 ? 'over' : 'under'}`
  })
}

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
      type="button"
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
  const style = styleOf(row.category, catMap)

  return (
    <tr className="group border-b border-hairline/60 last:border-0">
      <td className={cx('py-1.5 pl-3', table.pinned)}>
        <span className="flex items-center gap-2">
          <CategoryDot category={{ ...row.category, ...style }} size={24} />
          <span className="truncate font-medium">{row.category.name}</span>
        </span>
      </td>
      <td className="px-3">
        <BudgetBars
          fluid
          values={row.history}
          budgets={row.budgetHistory.amounts}
          inferred={row.budgetHistory.inferred}
          labels={barLabels(row, money)}
        />
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
        {budget != null && (
          <BudgetBullet
            spent={row.spent}
            budget={budget}
            typical={row.typical}
            color={`var(--series-${style.slot})`}
            label={`${money(row.spent)} spent of a ${money(budget)} budget`}
          />
        )}
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
            type="button"
            onClick={() => nudge(-step)}
            aria-label={`Reduce ${row.category.name} budget`}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-lg text-ink-2 active:scale-95"
          >
            −
          </button>
        )}
        <AmountInput value={budget} symbol={symbol} className="flex-1" onCommit={(minor) => onCommit(row, minor)} />
        {budget != null && (
          <button
            type="button"
            onClick={() => nudge(step)}
            aria-label={`Increase ${row.category.name} budget`}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-lg text-ink-2 active:scale-95"
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
            <BudgetBullet
              spent={row.spent}
              budget={budget}
              typical={row.typical}
              color={`var(--series-${style.slot})`}
              label={`${money(row.spent)} spent of a ${money(budget)} budget`}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <p className="text-sm text-ink-3 tabular">
              {money(row.spent)} of {money(budget, { hideDecimals: true })}
            </p>
            <BudgetBars
              values={row.history}
              budgets={row.budgetHistory.amounts}
              inferred={row.budgetHistory.inferred}
              labels={barLabels(row, money)}
              width={96}
              height={22}
            />
          </div>
        </>
      )}
    </Card>
  )
}
