import { useMemo, useState } from 'react'
import { Table2, ChartPie, ChevronLeft } from 'lucide-react'
import { useAllTransactions, useBook, useBooks, useCategories, useCategoryMap, useFlows } from '../lib/cache'
import { thisMonthKey, monthLabel } from '../lib/dates'
import { OTHER_SLICE_ID } from '../lib/stats'
import { bookSeries, bookSlices, bookTotals, hasBreakdown, BOOK_WORDS, type BookId } from '../lib/books'
import { useApp } from '../state/AppContext'
import { Card, Segmented, Empty, Toolbar, MonthStepper, Button, table, ScrollTable, cx } from '../components/ui'
import { CategoryIcon } from '../components/CategoryIcon'
import { BookSwitcher } from '../components/BookSwitcher'
import { CategoryDonut, SpendBars, IncomeSpendBars, NetLine } from '../components/charts'

export default function Reports() {
  const { money } = useApp()
  const [month, setMonth] = useState(thisMonthKey())
  const [range, setRange] = useState<'6' | '12'>('6')
  const [view, setView] = useState<'charts' | 'table'>('charts')
  const [book, setBook] = useBook()
  /** The category being drilled into, or null for the top level. */
  const [drill, setDrill] = useState<string | null>(null)

  const txns = useAllTransactions()
  const categories = useCategories()
  const catMap = useCategoryMap()
  const books = useBooks()
  const flows = useFlows(txns, books)

  const slices = useMemo(
    () => bookSlices(txns ?? [], flows, categories, book, month, books, drill ?? undefined),
    [txns, flows, categories, book, month, books, drill],
  )
  const series = useMemo(
    () => bookSeries(txns ?? [], flows, book, Number(range), books, month),
    [txns, flows, book, range, books, month],
  )
  const totals = useMemo(
    () => bookTotals(txns ?? [], flows, book, month, books),
    [txns, flows, book, month, books],
  )

  const words = BOOK_WORDS[book]
  const drillName = drill ? (catMap.get(drill)?.name ?? 'Category') : null

  // Changing book or month while inside a category would leave the breadcrumb
  // pointing at a slice that is no longer on screen.
  const changeBook = (next: BookId) => {
    setDrill(null)
    setBook(next)
  }
  const changeMonth = (next: string) => {
    setDrill(null)
    setMonth(next)
  }

  const canDrill = (categoryId: string) =>
    categoryId !== OTHER_SLICE_ID &&
    hasBreakdown(categoryId, txns ?? [], flows, categories, book, month, books)

  if (txns && txns.length === 0) {
    return <Empty icon={ChartPie} title="Nothing to report yet" hint="Add or import some transactions and your charts will appear here." />
  }

  return (
    <div>
      <Toolbar>
        <BookSwitcher book={book} onChange={changeBook} className="w-full md:w-auto" />
        <Segmented
          value={view}
          onChange={setView}
          className="w-40"
          options={[
            { value: 'charts', label: <span className="flex items-center justify-center gap-1"><ChartPie size={14} /> Charts</span> },
            { value: 'table', label: <span className="flex items-center justify-center gap-1"><Table2 size={14} /> Table</span> },
          ]}
        />
        <Segmented
          value={range}
          onChange={setRange}
          className="w-36"
          options={[
            { value: '6', label: '6 mo' },
            { value: '12', label: '12 mo' },
          ]}
        />
        <MonthStepper month={month} onChange={changeMonth} label={monthLabel} canGoForward={month < thisMonthKey()} />
      </Toolbar>

      {/* The month in figures, in this book's own words. On the household book
          the contributions line is the one that does not exist anywhere else:
          it is the money we each put in, and it is visible to both of us even
          though neither can see the other's salary. */}
      <Card className="mb-3 p-4 md:mb-2.5 md:p-3">
        {/* A two-column grid on a phone and one divided row on a desktop.
            `flex-wrap` with `divide-x` was neither: the item that wrapped kept
            its left border, so the second line began with a divider attached to
            nothing and the figures no longer lined up under their headings. */}
        <div className="grid grid-cols-2 gap-x-5 gap-y-3 md:flex md:flex-nowrap md:items-start md:gap-0 md:divide-x md:divide-hairline">
          <Stat label={words.income} value={money(totals.income)} />
          {book === 'household' && totals.contributions > 0 && (
            <Stat label="of which we put in" value={money(totals.contributions)} muted />
          )}
          {book === 'mine' && totals.contributed > 0 && (
            <Stat label="Moved to household" value={money(totals.contributed)} muted />
          )}
          <Stat label={words.spend} value={money(totals.spend)} />
          <Stat
            label={words.net}
            value={money(totals.net, { sign: true })}
            tone={totals.net < 0 ? 'bad' : 'good'}
          />
        </div>
        <p className="mt-2 text-xs text-ink-3">{words.netHint}</p>
      </Card>

      <div className="grid gap-3 md:gap-2.5 xl:grid-cols-2">
        <Card className="p-5 md:p-4 xl:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 md:mb-2">
            <h3 className="flex items-center gap-1.5 font-semibold md:text-sm">
              {drill && (
                <button
                  onClick={() => setDrill(null)}
                  className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink"
                >
                  <ChevronLeft size={14} /> All
                </button>
              )}
              {drill ? drillName : `${words.spend}`} · {monthLabel(month)}
            </h3>
            {!drill && slices.length > 0 && (
              <span className="text-xs text-ink-3">Tap a category to see what is inside it</span>
            )}
          </div>
          {slices.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-3">
              No {book === 'mine' ? 'personal' : 'household'} spending recorded in {monthLabel(month)}.
            </p>
          ) : view === 'charts' ? (
            <>
              <CategoryDonut
                slices={slices}
                centerLabel={{
                  title: drill ? 'in here' : 'spent',
                  value: money(slices.reduce((s, x) => s + x.totalMinor, 0), { compact: true }),
                }}
              />
              {/* The donut is not clickable, so the drill-down lives in a row of
                  buttons under it — which also gives the categories a keyboard
                  path and a hit target big enough for a thumb. */}
              {!drill && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {slices.filter((s) => canDrill(s.categoryId)).map((s) => (
                    <Button key={s.categoryId} size="sm" variant="subtle" onClick={() => setDrill(s.categoryId)}>
                      <CategoryIcon icon={s.icon} size={13} /> {s.name}
                    </Button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <ScrollTable minWidth={360}>
              <thead>
                <tr className={table.head}>
                  <th className={cx(table.th, table.pinned)}>Category</th>
                  <th className={cx(table.th, 'text-right')}>Spent</th>
                  <th className={cx(table.th, 'text-right')}>Share</th>
                </tr>
              </thead>
              <tbody>
                {slices.map((s) => {
                  const drillable = !drill && canDrill(s.categoryId)
                  return (
                    <tr
                      key={s.categoryId}
                      className={cx(table.row, drillable && 'cursor-pointer')}
                      onClick={drillable ? () => setDrill(s.categoryId) : undefined}
                    >
                      <td className={cx(table.cell, table.pinned)}>
                        <span className="inline-flex items-center gap-2">
                          <span style={{ color: `var(--series-${s.slot})` }}>
                            <CategoryIcon icon={s.icon} size={15} />
                          </span>
                          {s.name}
                          {drillable && <span className="text-xs text-ink-3">›</span>}
                        </span>
                      </td>
                      <td className={cx(table.cell, 'text-right tabular')}>{money(s.totalMinor)}</td>
                      <td className={cx(table.cell, 'text-right text-ink-3 tabular')}>{Math.round(s.fraction * 100)}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </ScrollTable>
          )}
        </Card>

        {view === 'charts' ? (
          <>
            <Card className="p-5 md:p-4">
              <h3 className="mb-3 font-semibold md:mb-2 md:text-sm">{words.spend} each month</h3>
              <SpendBars data={series} />
            </Card>
            <Card className="p-5 md:p-4">
              <h3 className="mb-3 font-semibold md:mb-2 md:text-sm">
                {book === 'household' ? 'Paid in vs spent' : book === 'mine' ? 'Earned vs spent' : 'In vs out'}
              </h3>
              <IncomeSpendBars data={series} />
            </Card>
            <Card className="p-5 md:p-4 xl:col-span-2">
              <h3 className="mb-1 font-semibold md:text-sm">
                {book === 'household' ? 'What we saved each month' : `${words.net} each month`}
              </h3>
              <p className="mb-3 text-sm text-ink-3 md:mb-2 md:text-xs">{words.netHint}</p>
              <NetLine data={series} />
            </Card>
          </>
        ) : (
          <Card className="p-5 md:p-4 xl:col-span-2">
            <h3 className="mb-3 font-semibold md:mb-2 md:text-sm">Month by month</h3>
            <ScrollTable minWidth={560}>
              <thead>
                <tr className={table.head}>
                  <th className={cx(table.th, table.pinned)}>Month</th>
                  <th className={cx(table.th, 'text-right')}>{words.income}</th>
                  {book === 'mine' && <th className={cx(table.th, 'text-right')}>To household</th>}
                  <th className={cx(table.th, 'text-right')}>{words.spend}</th>
                  <th className={cx(table.th, 'text-right')}>{words.net}</th>
                </tr>
              </thead>
              <tbody>
                {[...series].reverse().map((p) => (
                  <tr key={p.key} className={table.row}>
                    <td className={cx(table.cell, table.pinned)}>{p.label}</td>
                    <td className={cx(table.cell, 'text-right tabular')}>{money(p.income)}</td>
                    {book === 'mine' && (
                      <td className={cx(table.cell, 'text-right tabular text-ink-3')}>{money(p.contributed)}</td>
                    )}
                    <td className={cx(table.cell, 'text-right tabular')}>{money(p.spend)}</td>
                    <td
                      className={cx(
                        table.cell,
                        'text-right font-medium tabular',
                        p.net < 0 ? 'text-critical-text' : 'text-good-text',
                      )}
                    >
                      {money(p.net, { sign: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          </Card>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
  muted,
}: {
  label: string
  value: string
  tone?: 'good' | 'bad'
  muted?: boolean
}) {
  return (
    <div className="min-w-0 md:flex-1 md:px-3 md:first:pl-0">
      <p className="text-xs text-ink-3">{label}</p>
      {/* Amounts stay on one line and shrink instead: "Household spending"
          against "−£3,141.42" is two long strings in half a phone's width, and
          a wrapped figure reads as two numbers. */}
      <p
        className={cx(
          'mt-0.5 truncate font-bold tracking-tight tabular',
          muted ? 'text-base text-ink-2 md:text-lg' : 'text-xl md:text-2xl',
          tone === 'bad' && 'text-critical-text',
          tone === 'good' && 'text-good-text',
        )}
      >
        {value}
      </p>
    </div>
  )
}
