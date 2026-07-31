import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Search, Upload, Receipt } from 'lucide-react'
import { db, type Transaction } from '../lib/db'
import { useAccountMap, useCategories, useCategoryMap } from '../lib/cache'
import { thisMonthKey, monthLabel, monthKey, fmtDay, fmtFullDate } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { Card, CategoryDot, Empty, TextInput, Toolbar, MonthStepper, Button, table, cx } from '../components/ui'
import { CategoryIcon } from '../components/CategoryIcon'
import { TransactionForm } from '../components/TransactionForm'
import { ImportWizard } from '../components/ImportWizard'

export default function Activity() {
  const { money } = useApp()
  const [month, setMonth] = useState(thisMonthKey())
  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState<string | null>(null)
  const [editing, setEditing] = useState<Transaction | undefined>()
  const [importOpen, setImportOpen] = useState(false)

  const categories = useCategories()
  const catMap = useCategoryMap()
  const accMap = useAccountMap()
  const searching = query.trim().length > 0

  const txns = useLiveQuery(async () => {
    if (searching) {
      const q = query.trim().toLowerCase()
      return db.transactions
        .filter((t) => t.payee.toLowerCase().includes(q) || (t.note ?? '').toLowerCase().includes(q))
        .toArray()
    }
    return db.transactions.filter((t) => monthKey(t.date) === month).toArray()
  }, [month, query, searching])

  const filtered = useMemo(() => {
    const list = (txns ?? []).filter((t) => catFilter === null || t.categoryId === catFilter)
    return list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
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
      <Toolbar>
        <div className="relative min-w-0 flex-1 basis-52 md:max-w-72 md:flex-none">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all transactions"
            className="pl-9! md:pl-8!"
          />
        </div>
        {!searching && (
          <MonthStepper month={month} onChange={setMonth} label={monthLabel} canGoForward={month < thisMonthKey()} />
        )}
        <Button variant="subtle" onClick={() => setImportOpen(true)}>
          <Upload size={15} /> Import CSV
        </Button>
        {filtered.length > 0 && (
          <p className="ml-auto hidden text-sm text-ink-3 md:block">
            {filtered.length} transaction{filtered.length === 1 ? '' : 's'}
            {monthSpend > 0 && <> · {money(monthSpend)} spent</>}
          </p>
        )}
      </Toolbar>

      {/* Category filter chips */}
      <div className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 py-1 md:mx-0 md:mb-2 md:flex-wrap md:gap-1.5 md:overflow-visible md:px-0">
        <button
          onClick={() => setCatFilter(null)}
          className={cx(
            'shrink-0 rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition desktop:px-2.5 desktop:py-0.5 md:text-xs',
            catFilter === null ? 'bg-ink text-page ring-ink' : 'bg-surface text-ink-2 ring-hairline hover:ring-ink-3/40',
          )}
        >
          All
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => setCatFilter(catFilter === c.id ? null : c.id!)}
            className={cx(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition',
              'md:gap-1 desktop:px-2.5 desktop:py-0.5 md:text-xs',
              catFilter === c.id ? 'bg-ink text-page ring-ink' : 'bg-surface text-ink-2 ring-hairline hover:ring-ink-3/40',
            )}
          >
            <CategoryIcon icon={c.icon} size={14} /> {c.name}
          </button>
        ))}
      </div>

      {/* Phone-only summary line — desktop shows it in the toolbar. */}
      {filtered.length > 0 && (
        <p className="mb-2 px-1 text-sm text-ink-3 md:hidden">
          {filtered.length} transaction{filtered.length === 1 ? '' : 's'}
          {monthSpend > 0 && <> · {money(monthSpend)} spent</>}
        </p>
      )}

      {filtered.length === 0 ? (
        <Empty
          icon={Receipt}
          title={searching ? 'Nothing matches your search' : 'No transactions this month'}
          hint={searching ? undefined : 'Add one with the + button, or import a bank statement CSV.'}
        />
      ) : (
        <>
          {/* Phone: cards grouped under a day heading, thumb-sized rows. */}
          <div className="space-y-4 md:hidden">
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
                          <CategoryDot category={t.categoryId ? catMap.get(t.categoryId) : undefined} size={34} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{t.payee}</p>
                            <p className="truncate text-sm text-ink-3">
                              {(t.categoryId ? catMap.get(t.categoryId) : undefined)?.name ?? 'Uncategorised'}
                              {t.note ? ` · ${t.note}` : ''}
                            </p>
                          </div>
                          <span className={cx('font-semibold tabular', t.amountMinor > 0 && 'text-good-text')}>
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

          {/* Desktop: one scannable table. Date becomes a column instead of a
              heading, and the width freed up carries category, account and note. */}
          <Card className="hidden overflow-hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className={table.head}>
                  <th className={cx(table.th, 'w-28 pl-3')}>Date</th>
                  <th className={table.th}>Payee</th>
                  <th className={cx(table.th, 'w-44')}>Category</th>
                  <th className={cx(table.th, 'w-40')}>Account</th>
                  <th className={cx(table.th, 'w-32 pr-3 text-right')}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
                  const cat = t.categoryId ? catMap.get(t.categoryId) : undefined
                  return (
                    <tr
                      key={t.id}
                      onClick={() => setEditing(t)}
                      className={cx(table.row, 'cursor-pointer transition-colors')}
                    >
                      {/* A search spans every month, so it needs the year; a
                          month view doesn't, and the weekday is more useful. */}
                      <td className={cx(table.cell, 'pl-3 whitespace-nowrap text-ink-3 tabular')}>
                        {searching ? fmtFullDate(t.date) : fmtDay(t.date)}
                      </td>
                      {/* Note rides on the same line as the payee — a second
                          line would make row heights uneven and harder to scan. */}
                      <td className={cx(table.cell, 'max-w-0 truncate pr-3')}>
                        <span className="font-medium">{t.payee}</span>
                        {t.note && <span className="ml-2 text-ink-3">{t.note}</span>}
                      </td>
                      <td className={cx(table.cell, 'pr-3')}>
                        <span className="flex items-center gap-1.5 truncate text-ink-2">
                          <span className="shrink-0" style={{ color: cat ? `var(--series-${cat.slot})` : 'var(--ink-3)' }}>
                            <CategoryIcon icon={cat?.icon} size={14} />
                          </span>
                          <span className="truncate">{cat?.name ?? 'Uncategorised'}</span>
                        </span>
                      </td>
                      <td className={cx(table.cell, 'truncate pr-3 text-ink-3')}>
                        {t.accountId ? (accMap.get(t.accountId)?.name ?? '—') : '—'}
                      </td>
                      <td
                        className={cx(
                          table.cell,
                          'pr-3 text-right font-semibold tabular',
                          t.amountMinor > 0 && 'text-good-text',
                        )}
                      >
                        {money(t.amountMinor, { sign: t.amountMinor > 0 })}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}

      <TransactionForm open={editing !== undefined} onClose={() => setEditing(undefined)} editing={editing} />
      <ImportWizard open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}
