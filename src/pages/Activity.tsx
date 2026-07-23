import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Search, Upload, ChevronLeft, ChevronRight } from 'lucide-react'
import { db, type Transaction } from '../lib/db'
import { notDeleted } from '../lib/data'
import { thisMonthKey, shiftMonth, monthLabel, monthKey, fmtDay } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { Card, CategoryDot, Empty, TextInput, cx } from '../components/ui'
import { TransactionForm } from '../components/TransactionForm'
import { ImportWizard } from '../components/ImportWizard'

export default function Activity() {
  const { money } = useApp()
  const [month, setMonth] = useState(thisMonthKey())
  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState<string | null>(null)
  const [editing, setEditing] = useState<Transaction | undefined>()
  const [importOpen, setImportOpen] = useState(false)

  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').filter(notDeleted).toArray(), []) ?? []
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id!, c])), [categories])
  const searching = query.trim().length > 0

  const txns = useLiveQuery(async () => {
    if (searching) {
      const q = query.trim().toLowerCase()
      return db.transactions
        .filter((t) => !t.deleted && (t.payee.toLowerCase().includes(q) || (t.note ?? '').toLowerCase().includes(q)))
        .toArray()
    }
    return db.transactions.filter((t) => !t.deleted && monthKey(t.date) === month).toArray()
  }, [month, query, searching])

  const filtered = useMemo(() => {
    const list = (txns ?? []).filter((t) => catFilter === null || t.categoryId === catFilter)
    return list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
  }, [txns, catFilter])

  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>()
    for (const t of filtered) {
      if (!map.has(t.date)) map.set(t.date, [])
      map.get(t.date)!.push(t)
    }
    return [...map.entries()]
  }, [filtered])

  const monthSpend = filtered.reduce((s, t) => (t.amountMinor < 0 ? s - t.amountMinor : s), 0)

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-52">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all transactions"
            className="pl-9"
          />
        </div>
        {!searching && (
          <div className="flex h-11 items-center rounded-xl bg-surface-2">
            <button className="px-2.5 text-ink-2 hover:text-ink" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
              <ChevronLeft size={18} />
            </button>
            <span className="w-32 text-center text-sm font-semibold">{monthLabel(month)}</span>
            <button
              className="px-2.5 text-ink-2 hover:text-ink disabled:opacity-30"
              aria-label="Next month"
              disabled={month >= thisMonthKey()}
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        )}
        <button
          onClick={() => setImportOpen(true)}
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-surface-2 px-4 text-sm font-medium text-ink hover:brightness-97 dark:hover:brightness-110"
        >
          <Upload size={16} /> Import CSV
        </button>
      </div>

      {/* Category filter chips */}
      <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 py-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
        <button
          onClick={() => setCatFilter(null)}
          className={cx(
            'shrink-0 rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition',
            catFilter === null ? 'bg-ink text-page ring-ink' : 'bg-surface text-ink-2 ring-hairline',
          )}
        >
          All
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => setCatFilter(catFilter === c.id ? null : c.id!)}
            className={cx(
              'shrink-0 rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition',
              catFilter === c.id ? 'bg-ink text-page ring-ink' : 'bg-surface text-ink-2 ring-hairline',
            )}
          >
            {c.emoji} {c.name}
          </button>
        ))}
      </div>

      {/* Summary line */}
      {filtered.length > 0 && (
        <p className="mt-3 px-1 text-sm text-ink-3">
          {filtered.length} transaction{filtered.length === 1 ? '' : 's'}
          {monthSpend > 0 && <> · {money(monthSpend)} spent</>}
        </p>
      )}

      {/* Grouped list */}
      {filtered.length === 0 ? (
        <Empty
          emoji="🧾"
          title={searching ? 'Nothing matches your search' : 'No transactions this month'}
          hint={searching ? undefined : 'Add one with the + button, or import a bank statement CSV.'}
        />
      ) : (
        <div className="mt-2 space-y-4">
          {groups.map(([date, list]) => (
            <div key={date}>
              <p className="mb-1.5 px-1 text-sm font-semibold text-ink-3">{fmtDay(date)}</p>
              <Card>
                <ul className="divide-y divide-hairline">
                  {list.map((t) => (
                    <li key={t.id}>
                      <button
                        onClick={() => setEditing(t)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/50"
                      >
                        <CategoryDot category={catMap.get(t.categoryId)} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{t.payee}</p>
                          <p className="truncate text-sm text-ink-3">
                            {catMap.get(t.categoryId)?.name ?? 'Uncategorised'}
                            {t.note ? ` · ${t.note}` : ''}
                          </p>
                        </div>
                        <span className={`font-semibold tabular ${t.amountMinor > 0 ? 'text-good-text' : ''}`}>
                          {money(t.amountMinor, { sign: t.amountMinor > 0 })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ))}
        </div>
      )}

      <TransactionForm open={editing !== undefined} onClose={() => setEditing(undefined)} editing={editing} />
      <ImportWizard open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}
