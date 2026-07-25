import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Plus, Target } from 'lucide-react'
import { db, type Category, type Budget } from '../lib/db'
import { createRow, updateRow, removeRow, notDeleted } from '../lib/data'
import { thisMonthKey, monthLabel, monthKey } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { useSyncState } from '../hooks/useSync'
import { parseAmount, currencySymbol } from '../lib/money'
import {
  Card, CategoryDot, Progress, Sheet, Button, TextInput, Field, Empty, Segmented, Toolbar, MonthStepper, cx,
} from '../components/ui'

/**
 * Budget cells auto-fill the available width: two columns on a phone-width
 * screen, four or five on a wide monitor. The track adapts to the viewport
 * rather than to a fixed breakpoint ladder.
 */
const BUDGET_GRID = 'grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr))] md:gap-1.5'

export default function Budgets() {
  const { money, currency } = useApp()
  const { userId } = useSyncState()
  const [month, setMonth] = useState(thisMonthKey())
  const [scope, setScope] = useState<'household' | 'mine'>('household')
  const [editingCat, setEditingCat] = useState<Category | null>(null)
  const [amount, setAmount] = useState('')

  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').filter(notDeleted).toArray(), []) ?? []
  const allBudgets = useLiveQuery(() => db.budgets.filter(notDeleted).toArray(), []) ?? []
  const txns = useLiveQuery(() => db.transactions.filter((t) => !t.deleted && monthKey(t.date) === month).toArray(), [month]) ?? []

  const mine = scope === 'mine' && !!userId
  const budgets = useMemo(
    () => allBudgets.filter((b) => (mine ? b.ownerId === userId : !b.ownerId)),
    [allBudgets, mine, userId],
  )
  const budgetMap = useMemo(() => new Map(budgets.map((b) => [b.categoryId, b])), [budgets])
  const spentMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of txns) {
      if (t.amountMinor >= 0) continue
      if (mine && t.createdBy !== userId) continue // personal budgets track what *you* recorded
      m.set(t.categoryId, (m.get(t.categoryId) ?? 0) - t.amountMinor)
    }
    return m
  }, [txns, mine, userId])

  const expenseCats = categories.filter((c) => c.kind === 'expense')
  const budgeted = expenseCats.filter((c) => budgetMap.has(c.id!))
  const unbudgeted = expenseCats.filter((c) => !budgetMap.has(c.id!))
  const totalBudget = budgeted.reduce((s, c) => s + budgetMap.get(c.id!)!.amountMinor, 0)
  const totalSpent = budgeted.reduce((s, c) => s + (spentMap.get(c.id!) ?? 0), 0)
  const totalFrac = totalBudget > 0 ? totalSpent / totalBudget : 0
  const isCurrent = month === thisMonthKey()

  function openEditor(cat: Category) {
    const existing = budgetMap.get(cat.id!)
    setAmount(existing ? String(existing.amountMinor / 100) : '')
    setEditingCat(cat)
  }

  async function saveBudget() {
    if (!editingCat) return
    const minor = parseAmount(amount)
    const existing = budgetMap.get(editingCat.id!)
    if (minor === null || minor <= 0) {
      if (existing) await removeRow('budgets', existing.id!)
    } else if (existing) {
      await updateRow('budgets', existing.id!, { amountMinor: minor })
    } else {
      await createRow<Budget>('budgets', {
        categoryId: editingCat.id!,
        amountMinor: minor,
        ownerId: mine ? userId : undefined,
      })
    }
    setEditingCat(null)
  }

  return (
    <div>
      {/* Month + scope. Centred on a phone, a left-aligned control strip under a cursor. */}
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
          // Totals ride along in the toolbar on desktop instead of taking a card of their own.
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
      </Toolbar>

      {mine && (
        <p className="mb-3 text-center text-xs text-ink-3 md:mb-2 md:text-left">
          Personal budgets count only the spending you record yourself.
        </p>
      )}

      {budgeted.length === 0 ? (
        <Empty
          icon={Target}
          title={mine ? 'No personal budgets yet' : 'No budgets yet'}
          hint={
            mine
              ? 'Set a monthly amount below for spending you want to keep an eye on yourself — only you count towards it.'
              : "Set a monthly amount for each category below and Hearth will track how you're doing."
          }
        />
      ) : (
        <>
          {/* The phone keeps the summary as its own card; desktop has it in the toolbar. */}
          <Card className="mb-3 p-4 md:hidden">
            <div className="flex items-baseline justify-between">
              <p className="text-sm text-ink-3">Total budgeted</p>
              <p className="text-sm text-ink-2 tabular">
                <span className="font-semibold text-ink">{money(totalSpent)}</span> of {money(totalBudget, { hideDecimals: true })}
              </p>
            </div>
            <div className="mt-2">
              <Progress fraction={totalFrac} tone={totalFrac > 1 ? 'over' : totalFrac > 0.85 ? 'warn' : 'ok'} />
            </div>
          </Card>

          <div className={BUDGET_GRID}>
            {budgeted.map((c) => {
              const budget = budgetMap.get(c.id!)!.amountMinor
              const spent = spentMap.get(c.id!) ?? 0
              const frac = spent / budget
              const left = budget - spent
              return (
                <button
                  key={c.id}
                  onClick={() => openEditor(c)}
                  className={cx(
                    'rounded-2xl bg-surface p-3.5 text-left ring-1 ring-hairline transition',
                    'shadow-[0_1px_2px_rgba(0,0,0,0.04)] active:scale-[0.99]',
                    'md:rounded-xl desktop:p-2.5 md:shadow-none md:hover:ring-ink-3/40 md:active:scale-100',
                  )}
                >
                  <div className="flex items-center gap-2.5 md:gap-2">
                    <CategoryDot category={c} size={34} className="md:[--dot:24px]" />
                    <span className="min-w-0 flex-1 truncate font-medium md:text-sm">{c.name}</span>
                    <span
                      className={cx(
                        'shrink-0 text-sm font-semibold tabular md:text-xs',
                        left < 0 ? 'text-critical-text' : 'text-good-text',
                      )}
                    >
                      {left < 0 ? `${money(-left)} over` : `${money(left)} left`}
                    </span>
                  </div>
                  <div className="mt-2.5 md:mt-2">
                    <Progress fraction={frac} tone={frac > 1 ? 'over' : frac > 0.85 ? 'warn' : 'ok'} />
                  </div>
                  <p className="mt-1.5 text-sm text-ink-3 tabular md:mt-1 md:text-xs">
                    {money(spent)} of {money(budget, { hideDecimals: true })}
                  </p>
                </button>
              )
            })}
          </div>
        </>
      )}

      {unbudgeted.length > 0 && (
        <>
          <p className="mb-2 mt-6 px-1 text-sm font-semibold uppercase tracking-wide text-ink-3 md:mb-1.5 md:mt-5 md:text-xs">
            Not budgeted
          </p>
          {/* Same auto-filling track, so these pack into columns too rather than
              running one-per-row down a very wide screen. */}
          <div className={BUDGET_GRID}>
            {unbudgeted.map((c) => (
              <button
                key={c.id}
                onClick={() => openEditor(c)}
                className={cx(
                  'flex items-center gap-2.5 rounded-2xl bg-surface px-3.5 py-3 text-left ring-1 ring-hairline transition',
                  'md:gap-2 md:rounded-xl desktop:px-2.5 desktop:py-2 md:hover:ring-ink-3/40',
                )}
              >
                <CategoryDot category={c} size={30} className="md:[--dot:24px]" />
                <span className="min-w-0 flex-1 truncate font-medium md:text-sm">{c.name}</span>
                <span className="shrink-0 text-sm text-ink-3 tabular md:text-xs">
                  {money(spentMap.get(c.id!) ?? 0)} spent
                </span>
                <span className="flex shrink-0 items-center gap-0.5 text-sm font-medium text-accent md:text-xs">
                  <Plus size={13} /> Budget
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <Sheet
        open={editingCat !== null}
        onClose={() => setEditingCat(null)}
        title={`${mine ? 'My budget' : 'Budget'} for ${editingCat?.name ?? ''}`}
        footer={
          <Button size="lg" className="w-full" onClick={saveBudget}>
            Save
          </Button>
        }
      >
        <div className="space-y-4">
          <Field label={`Monthly amount (${currencySymbol(currency)})`} hint="Leave empty to remove this budget.">
            <TextInput
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="e.g. 400"
              autoFocus
            />
          </Field>
        </div>
      </Sheet>
    </div>
  )
}
