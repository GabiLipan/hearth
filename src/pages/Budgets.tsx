import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { db, type Category, type Budget } from '../lib/db'
import { createRow, updateRow, removeRow, notDeleted } from '../lib/data'
import { thisMonthKey, shiftMonth, monthLabel, monthKey } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { useSyncState } from '../hooks/useSync'
import { parseAmount, currencySymbol } from '../lib/money'
import { Card, CategoryDot, Progress, Sheet, Button, TextInput, Field, Empty, Segmented } from '../components/ui'

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
      {/* Household / personal switcher (personal budgets need sign-in) */}
      {userId && (
        <Segmented
          value={scope}
          onChange={setScope}
          className="mx-auto mb-3 max-w-xs"
          options={[
            { value: 'household', label: 'Household' },
            { value: 'mine', label: 'Just mine' },
          ]}
        />
      )}
      {mine && (
        <p className="mb-3 text-center text-xs text-ink-3">
          Personal budgets count only the spending you record yourself.
        </p>
      )}

      {/* Month picker */}
      <div className="mb-4 flex items-center justify-center gap-1">
        <button className="grid size-9 place-items-center rounded-full text-ink-2 hover:bg-surface-2" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
          <ChevronLeft size={18} />
        </button>
        <span className="w-40 text-center font-semibold">{monthLabel(month)}</span>
        <button
          className="grid size-9 place-items-center rounded-full text-ink-2 hover:bg-surface-2 disabled:opacity-30"
          aria-label="Next month"
          disabled={isCurrent}
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {budgeted.length === 0 ? (
        <Empty
          emoji="🎯"
          title={mine ? 'No personal budgets yet' : 'No budgets yet'}
          hint={
            mine
              ? 'Set a monthly amount below for spending you want to keep an eye on yourself — only you count towards it.'
              : "Set a monthly amount for each category below and Hearth will track how you're doing."
          }
        />
      ) : (
        <>
          <Card className="mb-4 p-5">
            <div className="flex items-baseline justify-between">
              <p className="text-sm text-ink-3">Total budgeted</p>
              <p className="text-sm text-ink-2 tabular">
                <span className="font-semibold text-ink">{money(totalSpent)}</span> of {money(totalBudget, { hideDecimals: true })}
              </p>
            </div>
            <div className="mt-2">
              <Progress
                fraction={totalBudget > 0 ? totalSpent / totalBudget : 0}
                tone={totalSpent > totalBudget ? 'over' : totalSpent > totalBudget * 0.85 ? 'warn' : 'ok'}
              />
            </div>
          </Card>

          <div className="grid gap-3 md:grid-cols-2">
            {budgeted.map((c) => {
              const budget = budgetMap.get(c.id!)!.amountMinor
              const spent = spentMap.get(c.id!) ?? 0
              const frac = spent / budget
              const left = budget - spent
              return (
                <Card key={c.id} className="p-4" onClick={() => openEditor(c)}>
                  <div className="flex items-center gap-3">
                    <CategoryDot category={c} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{c.name}</p>
                      <p className="text-sm text-ink-3 tabular">
                        {money(spent)} of {money(budget, { hideDecimals: true })}
                      </p>
                    </div>
                    <span className={`text-sm font-semibold tabular ${left < 0 ? 'text-critical-text' : 'text-good-text'}`}>
                      {left < 0 ? `${money(-left)} over` : `${money(left)} left`}
                    </span>
                  </div>
                  <div className="mt-3">
                    <Progress fraction={frac} tone={frac > 1 ? 'over' : frac > 0.85 ? 'warn' : 'ok'} />
                  </div>
                </Card>
              )
            })}
          </div>
        </>
      )}

      {unbudgeted.length > 0 && (
        <>
          <p className="mb-2 mt-6 px-1 text-sm font-semibold uppercase tracking-wide text-ink-3">Not budgeted</p>
          <Card>
            <ul className="divide-y divide-hairline">
              {unbudgeted.map((c) => (
                <li key={c.id}>
                  <button onClick={() => openEditor(c)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/50">
                    <CategoryDot category={c} size={32} />
                    <span className="flex-1 font-medium">{c.name}</span>
                    <span className="text-sm text-ink-3 tabular">{money(spentMap.get(c.id!) ?? 0)} spent</span>
                    <span className="text-sm font-medium text-accent">Set budget</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      <Sheet
        open={editingCat !== null}
        onClose={() => setEditingCat(null)}
        title={`${mine ? 'My budget' : 'Budget'} for ${editingCat?.name ?? ''}`}
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
          <Button size="lg" className="w-full" onClick={saveBudget}>
            Save
          </Button>
        </div>
      </Sheet>
    </div>
  )
}
