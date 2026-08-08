import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Table2, ChartPie, ChevronLeft, Receipt, Download } from 'lucide-react'
import {
  useAccounts,
  useAllTransactions,
  useBook,
  useBooks,
  useCategories,
  useCategoryMap,
  useFlows,
  useMemberMap,
  useMyLevels,
} from '../lib/cache'
import { canSeeTransactionsAt, levelOn } from '../lib/accounts'
import { csvAmount, downloadCSV, toCSV } from '../lib/csv'
import { unexplainedLegs, unexplainedTotals } from '../lib/unexplained'
import { useSyncState } from '../hooks/useSync'
import { nameOf } from '../components/PersonDot'
import { thisMonthKey, monthLabel } from '../lib/dates'
import { OTHER_SLICE_ID } from '../lib/stats'
import {
  bookBalances,
  bookSeries,
  bookSlices,
  bookTotals,
  contributionSplit,
  hasBreakdown,
  BOOK_WORDS,
  type BookId,
} from '../lib/books'
import { useApp } from '../state/AppContext'
import { Card, Segmented, Empty, Toolbar, MonthStepper, Button, table, ScrollTable, cx } from '../components/ui'
import { CategoryIcon } from '../components/CategoryIcon'
import { BookSwitcher } from '../components/BookSwitcher'
import { CategoryDonut, SpendBars, IncomeSpendBars, NetLine } from '../components/charts'
import {
  CategoryHeatmap,
  FixedVariableBars,
  PaceLine,
  SalaryStack,
  SavingsRateLine,
  TopPayees,
  Waterfall,
} from '../components/insights'
import {
  categoryDeltas,
  categoryHeatmap,
  fixedVsVariable,
  householdWaterfall,
  pace,
  salaryBars,
  savingsRate,
  topPayees,
} from '../lib/insights'

export default function Reports() {
  const { money } = useApp()
  const [month, setMonth] = useState(thisMonthKey())
  const [range, setRange] = useState<'6' | '12'>('6')
  const [view, setView] = useState<'charts' | 'table'>('charts')
  const [book, setBook] = useBook()
  /** The category being drilled into, or null for the top level. */
  const [drill, setDrill] = useState<string | null>(null)

  const txns = useAllTransactions()
  const accounts = useAccounts()
  const levels = useMyLevels()
  const categories = useCategories()
  const catMap = useCategoryMap()
  const books = useBooks()
  const flows = useFlows(txns, books)
  const { userId } = useSyncState()
  const memberMap = useMemberMap()

  /**
   * Who paid in what. Household book only — it is meaningless anywhere else,
   * and it is the one figure this whole model makes newly possible: neither of
   * us can see the other's salary, but every contribution ARRIVES in a joint
   * account, which we can both read.
   */
  const split = useMemo(
    () => contributionSplit(txns ?? [], flows, month, books),
    [txns, flows, month, books],
  )
  const partner = useMemo(() => {
    const others = [...memberMap.values()].filter((m) => m.userId !== userId)
    return others.length === 1 ? nameOf(others[0]) : null
  }, [memberMap, userId])

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

  /**
   * The months the range covers, shared by every series below so they all line
   * up along the same axis.
   */
  const monthKeys = useMemo(() => series.map((p) => p.key), [series])

  const waterfall = useMemo(
    () => householdWaterfall(txns ?? [], flows, books, accounts, month),
    [txns, flows, books, accounts, month],
  )
  const salary = useMemo(
    () => salaryBars(txns ?? [], flows, books, monthKeys),
    [txns, flows, books, monthKeys],
  )
  const committed = useMemo(
    () => fixedVsVariable(txns ?? [], flows, book, books, monthKeys),
    [txns, flows, book, books, monthKeys],
  )
  const kept = useMemo(
    () => savingsRate(txns ?? [], flows, book, books, monthKeys),
    [txns, flows, book, books, monthKeys],
  )
  const payees = useMemo(
    () => topPayees(txns ?? [], flows, categories, book, books, month),
    [txns, flows, categories, book, books, month],
  )
  const heatmap = useMemo(
    () => categoryHeatmap(txns ?? [], flows, categories, book, books, monthKeys),
    [txns, flows, categories, book, books, monthKeys],
  )
  const pacePoints = useMemo(
    () => pace(txns ?? [], flows, book, books, month),
    [txns, flows, book, books, month],
  )
  const deltas = useMemo(
    () => categoryDeltas(txns ?? [], flows, categories, book, books, monthKeys, month),
    [txns, flows, categories, book, books, monthKeys, month],
  )

  /**
   * What the book's accounts held on the 1st, and what they hold now.
   *
   * The figure a part-finished month actually needs. On the 8th, "Paid in
   * £0.57, spent £3,142, left over −£3,141" is arithmetically right and reads
   * like a disaster; the same month as "£4,200 at the start, £1,058 now" is
   * useful. Undefined when any account in the book is one this device may only
   * see the total of — see `bookBalances`.
   */
  const balances = useMemo(
    () =>
      bookBalances(accounts, txns ?? [], book, books, month, (id) =>
        canSeeTransactionsAt(levelOn(id, levels)),
      ),
    // `levels` is a fresh Map every render, so it is deliberately not a
    // dependency: the inputs that change the answer are the accounts and grants
    // it is derived from, and `accounts` is one of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, txns, book, books, month],
  )

  /**
   * Money that crossed between our books that only the other person can link.
   *
   * Household book only, because that is the only place a leg can have an
   * invisible partner. Nothing here changes a figure — it says which part of a
   * figure is standing in for something the app cannot see, which is the
   * honest version of a number it cannot get right on its own.
   */
  const unexplained = useMemo(
    () => unexplainedTotals(unexplainedLegs(txns ?? [], flows, books, month)),
    [txns, flows, books, month],
  )

  const words = BOOK_WORDS[book]
  const drillName = drill ? (catMap.get(drill)?.name ?? 'Category') : null
  /** The month we are in is a part-month, and every comparison has to say so. */
  const partial = month === thisMonthKey()

  /**
   * The table on screen, as a file.
   *
   * Two buttons rather than one "export the report": the page shows two
   * different tables, and a single CSV holding both would be two tables in one
   * file, which no spreadsheet can read as either.
   */
  const exportCategories = () => {
    const rows: (string | number)[][] = [['Category', 'Spent', 'Typical', 'vs typical', 'Share']]
    for (const s of slices) {
      const d = drill ? undefined : deltas.get(s.categoryId)
      rows.push([
        s.name,
        csvAmount(s.totalMinor),
        d && d.basis >= 3 ? csvAmount(d.typicalMinor) : '',
        d && d.basis >= 3 ? csvAmount(d.deltaMinor) : '',
        `${Math.round(s.fraction * 100)}%`,
      ])
    }
    downloadCSV(`hearth-${book}-${month}${drill ? `-${drillName}` : ''}`, toCSV(rows))
  }

  const exportMonths = () => {
    const head = ['Month', words.income]
    if (book === 'mine') head.push('To household')
    head.push(words.spend, words.net, 'Complete')
    const rows: (string | number)[][] = [head]
    for (const p of [...series].reverse()) {
      const row: (string | number)[] = [p.label, csvAmount(p.income)]
      if (book === 'mine') row.push(csvAmount(p.contributed))
      // The completeness column is not decoration: without it the current
      // month is a small number in a column of large ones and nothing in the
      // file says why.
      row.push(csvAmount(p.spend), csvAmount(p.net), p.partial ? 'so far' : 'yes')
      rows.push(row)
    }
    downloadCSV(`hearth-${book}-${series[0]?.key ?? month}-to-${month}`, toCSV(rows))
  }

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

  /**
   * Out of a figure and into the rows behind it.
   *
   * Every slice here is spending in one book, in one month, under one category,
   * and Activity can now say exactly that — so the answer to "what is that
   * £412?" is a navigation rather than a reconstruction by hand. "Other" is the
   * tail of small categories folded together and is not a category at all, so
   * it goes without one and lands on the whole month.
   */
  const navigate = useNavigate()
  const seeTransactions = (categoryId?: string) => {
    const q = new URLSearchParams({ month, book })
    if (categoryId && categoryId !== OTHER_SLICE_ID) q.set('category', categoryId)
    navigate(`/activity?${q}`)
  }

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

        {/* The balances, for the month that has not finished. Deliberately
            below the figures rather than beside them: it is the sentence that
            makes an alarming "left over" readable, not a fourth statistic. */}
        {partial && balances && (
          <p className="mt-1.5 text-xs text-ink-2">
            <span className="font-medium tabular">{money(balances.startMinor)}</span> at the start of{' '}
            {monthLabel(month)},{' '}
            <span className="font-medium tabular">{money(balances.nowMinor)}</span> now
            <span className="text-ink-3"> — the month is not over.</span>
          </p>
        )}
        {partial && !balances && (
          <p className="mt-1.5 text-xs text-ink-3">
            {monthLabel(month)} is not over, so these are part of a month.
          </p>
        )}

        {/* The blind spot in the model, said out loud. A leg whose partner is
            in an account this device is not on cannot be linked from here, so
            until they link it the figures above are counting a movement of
            money as spending or as income. */}
        {book === 'household' && (unexplained.outCount > 0 || unexplained.inCount > 0) && (
          <div className="mt-3 rounded-xl bg-warning/12 px-3 py-2.5">
            <p className="text-xs text-ink-2">
              {unexplained.outCount > 0 && (
                <>
                  <span className="font-medium tabular">{money(unexplained.outMinor)}</span> of that spending
                  looks like money moved to a private account rather than spent
                  {unexplained.inCount > 0 && ', and '}
                </>
              )}
              {unexplained.inCount > 0 && (
                <>
                  <span className="font-medium tabular">{money(unexplained.inMinor)}</span> of what came in
                  looks like a contribution nobody has linked
                </>
              )}
              .{' '}
              <span className="text-ink-3">
                {partner
                  ? `Only ${partner} can confirm the far side, from their own device.`
                  : 'Only the person whose account is on the other side can confirm it.'}
              </span>{' '}
              <button
                onClick={() => seeTransactions()}
                className="underline underline-offset-2 hover:text-ink"
              >
                See {unexplained.outCount + unexplained.inCount === 1 ? 'it' : 'them'}
              </button>
            </p>
          </div>
        )}

        {book === 'household' && totals.contributions > 0 && (
          <div className="mt-3 border-t border-hairline pt-3">
            <p className="mb-1.5 text-xs text-ink-3">Who paid in</p>
            <div className="flex h-2 overflow-hidden rounded-full bg-surface-2">
              {[
                { key: 'mine', value: split.mineMinor, color: 'var(--series-2)' },
                { key: 'theirs', value: split.theirsMinor, color: 'var(--series-5)' },
                { key: 'other', value: split.otherMinor, color: 'var(--ink-3)' },
              ]
                .filter((s) => s.value > 0)
                .map((s) => (
                  <span
                    key={s.key}
                    style={{ width: `${(s.value / Math.max(1, totals.income)) * 100}%`, background: s.color }}
                  />
                ))}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {split.mineMinor > 0 && <Legend color="var(--series-2)" label="You" value={money(split.mineMinor)} />}
              {split.theirsMinor > 0 && (
                <Legend color="var(--series-5)" label={partner ?? 'Someone else'} value={money(split.theirsMinor)} />
              )}
              {split.otherMinor > 0 && (
                <Legend
                  color="var(--ink-3)"
                  label="Not linked to anyone"
                  value={money(split.otherMinor)}
                  hint="Interest, refunds, and any transfer nobody has confirmed yet — an arrival on its own cannot say who sent it."
                />
              )}
            </div>
          </div>
        )}
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
            <div className="flex items-center gap-2">
              {!drill && slices.length > 0 && (
                <span className="hidden text-xs text-ink-3 sm:inline">Tap a category to see what is inside it</span>
              )}
              {slices.length > 0 && (
                <Button size="sm" variant="subtle" onClick={() => seeTransactions(drill ?? undefined)}>
                  <Receipt size={13} /> See transactions
                </Button>
              )}
              {slices.length > 0 && (
                <Button size="sm" variant="ghost" onClick={exportCategories} title="Download this table as CSV">
                  <Download size={13} /> CSV
                </Button>
              )}
            </div>
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
            <ScrollTable minWidth={460}>
              <thead>
                <tr className={table.head}>
                  <th className={cx(table.th, table.pinned)}>Category</th>
                  <th className={cx(table.th, 'text-right')}>Spent</th>
                  <th className={cx(table.th, 'text-right')}>vs typical</th>
                  <th className={cx(table.th, 'text-right')}>Share</th>
                  <th className={cx(table.th, 'w-9')}>
                    <span className="sr-only">Transactions</span>
                  </th>
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
                      {/* Only where there is enough history to mean anything.
                          Three past months is the floor: "£120 above typical"
                          on two months' evidence is a confident number about
                          nothing. Only the parent rows carry it, because that
                          is the level the median was taken at. */}
                      <td className={cx(table.cell, 'text-right tabular')}>
                        {(() => {
                          const d = drill ? undefined : deltas.get(s.categoryId)
                          if (!d || d.basis < 3) return <span className="text-ink-3">—</span>
                          // Within a tenth of typical is not news.
                          if (Math.abs(d.deltaMinor) < Math.max(d.typicalMinor * 0.1, 500)) {
                            return <span className="text-ink-3">typical</span>
                          }
                          return (
                            <span
                              className={d.deltaMinor > 0 ? 'text-critical-text' : 'text-good-text'}
                              title={`Usually about ${money(d.typicalMinor)} over ${d.basis} month${d.basis === 1 ? '' : 's'}`}
                            >
                              {money(d.deltaMinor, { sign: true })}
                            </span>
                          )
                        })()}
                      </td>
                      <td className={cx(table.cell, 'text-right text-ink-3 tabular')}>{Math.round(s.fraction * 100)}%</td>
                      {/* Its own control rather than the row's click, because
                          the row already means "drill into this" wherever there
                          is anything inside it. `stopPropagation` so the two do
                          not both fire on the categories that have both. */}
                      <td className={cx(table.cell, 'pl-2 text-right')}>
                        <button
                          aria-label={`See ${s.name} transactions`}
                          title={`See ${s.name} transactions in ${monthLabel(month)}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            seeTransactions(s.categoryId)
                          }}
                          className="grid size-7 place-items-center rounded-lg text-ink-3 transition hover:bg-surface-2 hover:text-ink"
                        >
                          <Receipt size={14} />
                        </button>
                      </td>
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

            {/* The household's month as one path, not three figures to subtract
                in your head. Household only: the steps ARE the household model,
                and "moved to savings" means nothing in a book with one account
                in it. */}
            {book === 'household' && waterfall.some((s) => s.deltaMinor !== 0) && (
              <Card className="p-5 md:p-4 xl:col-span-2">
                <h3 className="mb-1 font-semibold md:text-sm">Where it went · {monthLabel(month)}</h3>
                <p className="mb-3 text-sm text-ink-3 md:mb-2 md:text-xs">
                  Paid in, then out again, in the order it happened. The last bar is what is still sitting
                  in the current account.
                </p>
                <Waterfall steps={waterfall} />
              </Card>
            )}

            {/* The mirror of it, and the reason the personal book exists: the
                bar is the salary, and the question is what share of it went
                where. */}
            {book === 'mine' && salary.some((b) => b.earnedMinor > 0) && (
              <Card className="p-5 md:p-4 xl:col-span-2">
                <h3 className="mb-1 font-semibold md:text-sm">What each salary turned into</h3>
                <p className="mb-3 text-sm text-ink-3 md:mb-2 md:text-xs">
                  Each bar is one month's earnings, split into what went to the household, what you spent on
                  yourself, and what stayed put.
                </p>
                <SalaryStack data={salary} />
              </Card>
            )}

            {committed.some((m) => m.fixedMinor + m.variableMinor > 0) && (
              <Card className="p-5 md:p-4">
                <h3 className="mb-1 font-semibold md:text-sm">Committed vs chosen</h3>
                <p className="mb-3 text-sm text-ink-3 md:mb-2 md:text-xs">
                  How much of the spending is bills you track. Anything not tracked as a bill counts as
                  chosen, so this is only as good as your bill list.
                </p>
                <FixedVariableBars data={committed} />
              </Card>
            )}

            {kept.some((m) => m.rate !== null) && (
              <Card className="p-5 md:p-4">
                <h3 className="mb-1 font-semibold md:text-sm">Share kept</h3>
                <p className="mb-3 text-sm text-ink-3 md:mb-2 md:text-xs">
                  {book === 'mine'
                    ? 'What was left with you, as a share of what you earned. Money moved to the household is not spending, but it is not kept either.'
                    : 'What did not go out again, as a share of what came in. Below the line, more went out than in.'}
                </p>
                <SavingsRateLine data={kept} />
              </Card>
            )}

            {payees.length > 0 && (
              <Card className="p-5 md:p-4">
                <h3 className="mb-1 font-semibold md:text-sm">Top payees · {monthLabel(month)}</h3>
                <p className="mb-3 text-sm text-ink-3 md:mb-2 md:text-xs">
                  Under the category level. Shops the app treats as the same merchant are one line.
                </p>
                <TopPayees rows={payees} />
              </Card>
            )}

            {/* Deliberately the widest thing on the page. The point of it is
                reading ALONG a row for drift, which needs the months to be far
                enough apart to tell apart. */}
            {heatmap.rows.length > 0 && (
              <Card className="p-5 md:p-4 xl:col-span-2">
                <h3 className="mb-1 font-semibold md:text-sm">Category by month</h3>
                <p className="mb-3 text-sm text-ink-3 md:mb-2 md:text-xs">
                  Read along a row to see a category creeping up. Shading compares every cell against the
                  biggest one, so the rows are comparable with each other.
                </p>
                <CategoryHeatmap grid={heatmap} />
              </Card>
            )}

            {pacePoints.some((p) => p.thisMonthMinor || p.lastMonthMinor) && (
              <Card className="p-5 md:p-4 xl:col-span-2">
                <h3 className="mb-1 font-semibold md:text-sm">Pace</h3>
                <p className="mb-3 text-sm text-ink-3 md:mb-2 md:text-xs">
                  Spending so far against the same point the month before — the one comparison a
                  part-finished month can honestly make.
                </p>
                <PaceLine points={pacePoints} month={month} />
              </Card>
            )}
          </>
        ) : (
          <Card className="p-5 md:p-4 xl:col-span-2">
            <div className="mb-3 flex items-center justify-between gap-2 md:mb-2">
              <h3 className="font-semibold md:text-sm">Month by month</h3>
              <Button size="sm" variant="ghost" onClick={exportMonths} title="Download this table as CSV">
                <Download size={13} /> CSV
              </Button>
            </div>
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
                  <tr key={p.key} className={cx(table.row, p.partial && 'text-ink-2')}>
                    <td className={cx(table.cell, table.pinned)}>
                      {p.label}
                      {/* Not a footnote: this row is the reason the column
                          below it looks like a collapse. */}
                      {p.partial && <span className="ml-1.5 text-xs text-ink-3">so far</span>}
                    </td>
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

function Legend({ color, label, value, hint }: { color: string; label: string; value: string; hint?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={hint}>
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-ink-2">{label}</span>
      <span className="font-medium tabular">{value}</span>
    </span>
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
