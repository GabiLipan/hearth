import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Table2, ChartPie, ChevronLeft, Check, Receipt, Download } from 'lucide-react'
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
import { thisMonthKey, monthLabel, shiftMonth, todayISO, fmtFullDate } from '../lib/dates'
import { OTHER_SLICE_ID } from '../lib/stats'
import {
  bookBalances,
  bookSeries,
  bookSlices,
  bookTotals,
  bookTotalsInRange,
  rangeSlices,
  sumBookTotals,
  contributionSplit,
  hasBreakdown,
  BOOK_WORDS,
  type BookId,
} from '../lib/books'
import { useApp } from '../state/AppContext'
import { Card, Segmented, Empty, FilterBar, FilterChip, Popover, Toolbar, MonthStepper, Button, TextInput, table, ScrollTable, useColumnCount, cx } from '../components/ui'
import { CategoryIcon } from '../components/CategoryIcon'
import { BookSwitcher } from '../components/BookSwitcher'
import { Arrange, useLayout } from '../components/Arrange'
import type { SectionDef } from '../lib/layout'
import { Sankey } from '../components/Sankey'
import { spendFlow } from '../lib/sankey'
import { monthsOfHistory } from '../lib/stats'
import {
  CategoryBars,
  CategoryDonut,
  SpendBars,
  IncomeSpendBars,
  NetLine,
  NET_SHAPES,
  SLICE_SHAPES,
  TREND_SHAPES,
  type TrendShape,
} from '../components/charts'
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

/* ---------- The four decisions this page offers ---------- */
/*
 * Written once and shared by both bars. A wide screen shows them as segmented
 * controls, all options visible; a phone shows the same lists behind chips.
 * Keeping the options here is what stops the two drifting into offering
 * different answers to the same question.
 */
type ReportView = 'charts' | 'table'
type ReportRange = '6' | '12'
type ReportPeriod = 'month' | 'year' | 'custom'

const VIEW_OPTIONS: { value: ReportView; label: ReactNode }[] = [
  { value: 'charts', label: <span className="flex items-center justify-center gap-1"><ChartPie size={14} /> Charts</span> },
  { value: 'table', label: <span className="flex items-center justify-center gap-1"><Table2 size={14} /> Table</span> },
]
const RANGE_OPTIONS: { value: ReportRange; label: string }[] = [
  { value: '6', label: '6 mo' },
  { value: '12', label: '12 mo' },
]
const PERIOD_OPTIONS: { value: ReportPeriod; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'custom', label: 'Range' },
]

/**
 * What this page can show, in the order it shows it by default.
 *
 * Every one of these can be moved, resized or put away — a household that only
 * ever looks at the heatmap should be able to have the heatmap at the top, full
 * width, and nothing else. Sections that have nothing to say for the book or
 * period in view render nothing and are hidden; they are still in the list, so
 * they come back when the data does rather than disappearing from the
 * arrangement altogether.
 */
const SECTIONS: SectionDef[] = [
  { id: 'categories', label: 'Where it went', defaultSpan: 'full', variants: SLICE_SHAPES },
  { id: 'spend', label: 'Spending each month', variants: TREND_SHAPES },
  { id: 'inout', label: 'In vs out' },
  { id: 'net', label: 'Kept each month', defaultSpan: 'full', variants: NET_SHAPES },
  { id: 'flow', label: 'The whole flow', defaultSpan: 'full' },
  { id: 'waterfall', label: 'Step by step', defaultSpan: 'full' },
  { id: 'salary', label: 'What each salary turned into', defaultSpan: 'full' },
  { id: 'committed', label: 'Committed vs chosen' },
  { id: 'kept', label: 'Share kept' },
  { id: 'payees', label: 'Top payees' },
  { id: 'heatmap', label: 'Category by month', defaultSpan: 'full' },
  { id: 'pace', label: 'Pace', defaultSpan: 'full' },
]

/** Two columns on a laptop, three on a wide monitor. */
const COLUMN_STEPS: [number, number][] = [[1024, 2], [1900, 3]]

/** A chip that opens a short list and reports which of it is chosen. */
function ChoiceChip<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
}) {
  return (
    <Popover
      width="w-40"
      trigger={({ open, toggle }) => (
        <FilterChip open={open} onClick={toggle} label={options.find((o) => o.value === value)?.label ?? ''} />
      )}
    >
      {(close) =>
        options.map((o) => (
          <button
            key={o.value}
            onClick={() => {
              onChange(o.value)
              close()
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
          >
            <Check size={15} className={cx('shrink-0', o.value === value ? 'text-accent' : 'opacity-0')} />
            {o.label}
          </button>
        ))
      }
    </Popover>
  )
}

export default function Reports() {
  const { money } = useApp()
  const [month, setMonth] = useState(thisMonthKey())
  const [range, setRange] = useState<ReportRange>('6')
  /**
   * A month at a time, or a whole year.
   *
   * The year view asks the same questions of twelve months at once — which is
   * why the aggregates take a set of months rather than gaining a second code
   * path. The only figure that is genuinely different is the total, and
   * `sumBookTotals` recomputes `income` and `net` from the parts rather than
   * adding them, since both are derived and adding them would count the same
   * money twice.
   */
  const [period, setPeriod] = useState<ReportPeriod>('month')
  /**
   * A range drawn by hand. Held as two dates rather than derived, and defaulted
   * to the month in view so switching to it starts somewhere recognisable
   * rather than on an empty pair of inputs.
   */
  const [from, setFrom] = useState(() => `${thisMonthKey()}-01`)
  const [to, setTo] = useState(() => todayISO())
  const [view, setView] = useState<ReportView>('charts')
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

  /**
   * The months in view. One under `month`; under `year`, that year up to
   * December — or up to the month we are in, because the rest has not happened
   * and a year total that silently includes nothing for it is not a year total,
   * it is this year so far pretending otherwise.
   */
  const year = month.slice(0, 4)
  const inView = useMemo(() => {
    if (period === 'month') return [month]
    const last = year === thisMonthKey().slice(0, 4) ? Number(thisMonthKey().slice(5, 7)) : 12
    return Array.from({ length: last }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
  }, [period, month, year])

  const slices = useMemo(
    () =>
      period === 'custom'
        ? rangeSlices(txns ?? [], flows, categories, book, books, from, to, drill ?? undefined)
        : bookSlices(txns ?? [], flows, categories, book, inView, books, drill ?? undefined),
    [txns, flows, categories, book, inView, books, drill, period, from, to],
  )
  /** The same breakdown, never drilled into — what the flow diagram is built from. */
  const topSlices = useMemo(
    () =>
      !drill
        ? slices
        : period === 'custom'
          ? rangeSlices(txns ?? [], flows, categories, book, books, from, to)
          : bookSlices(txns ?? [], flows, categories, book, inView, books),
    [drill, slices, txns, flows, categories, book, inView, books, period, from, to],
  )
  const series = useMemo(
    () => bookSeries(txns ?? [], flows, book, Number(range), books, month),
    [txns, flows, book, range, books, month],
  )
  /**
   * The same series, but as far back as there is anything to show.
   *
   * The 6/12 toggle decides how many months are on SCREEN, and the charts that
   * take this scroll to the rest. Two series rather than one because the toggle
   * is doing two jobs: it is the window for the monthly charts, and it is the
   * period for everything derived from `monthKeys` — a heatmap of thirty-six
   * columns is not a heatmap, and a "share kept" line three years long is not
   * the question the card is asking.
   */
  const history = useMemo(() => monthsOfHistory(txns ?? [], month), [txns, month])
  const longSeries = useMemo(
    () => bookSeries(txns ?? [], flows, book, Math.max(history, Number(range)), books, month),
    [txns, flows, book, history, range, books, month],
  )
  const totals = useMemo(
    () =>
      period === 'custom'
        ? bookTotalsInRange(txns ?? [], flows, book, books, from, to)
        : sumBookTotals(inView.map((m) => bookTotals(txns ?? [], flows, book, m, books))),
    [txns, flows, book, inView, books, period, from, to],
  )

  /**
   * The same period a year earlier.
   *
   * The comparison a month-on-month figure cannot make: December always costs
   * more than November, and knowing that this December cost more than LAST
   * December is the version of that which means something. Undefined where
   * there was no spending to compare against, so a household with six months
   * of history is told nothing rather than that everything has doubled.
   */
  const lastYear = useMemo(() => {
    const before = sumBookTotals(
      inView.map((m) => bookTotals(txns ?? [], flows, book, shiftMonth(m, -12), books)),
    )
    if (before.spend === 0) return undefined
    return { spendMinor: before.spend, deltaMinor: totals.spend - before.spend }
  }, [txns, flows, book, inView, books, totals.spend])

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
   * The period as one path, from where the money came in to what it became.
   *
   * Built from the figures already on this page — the same totals as the card
   * at the top, the same slices as the breakdown — so the diagram cannot
   * disagree with the numbers beside it. See `lib/sankey.ts` for what it does
   * with a month that spent more than it took in.
   */
  const flowGraph = useMemo(
    () =>
      spendFlow({
        book,
        totals,
        // The top level always, even while a category is drilled into. A flow
        // diagram of one category's children is a picture of a drill-down, not
        // of a period — and handing it the children would leave the rest of the
        // spending to arrive on the right as "not categorised", which is a
        // sentence about the data rather than about the drill.
        slices: topSlices,
        split,
        partner: partner ?? undefined,
      }),
    [book, totals, topSlices, split, partner],
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
      // The start of the PERIOD, which under a year view is its January.
      bookBalances(accounts, txns ?? [], book, books, period === 'custom' ? from.slice(0, 7) : inView[0], (id) =>
        canSeeTransactionsAt(levelOn(id, levels)),
      ),
    // `levels` is a fresh Map every render, so it is deliberately not a
    // dependency: the inputs that change the answer are the accounts and grants
    // it is derived from, and `accounts` is one of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, txns, book, books, inView, period, from],
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
    () => unexplainedTotals(inView.flatMap((m) => unexplainedLegs(txns ?? [], flows, books, m))),
    [txns, flows, books, inView],
  )

  /** What the figures on this page cover, in words. */
  const periodLabel =
    period === 'year' ? year : period === 'custom' ? `${fmtFullDate(from)} – ${fmtFullDate(to)}` : monthLabel(month)
  const words = BOOK_WORDS[book]
  const drillName = drill ? (catMap.get(drill)?.name ?? 'Category') : null
  /**
   * The period we are in has not finished — a part-month, or a year still
   * running. Both need saying for the same reason.
   */
  const partial = period === 'custom' ? to >= todayISO() : inView.includes(thisMonthKey())

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
      const d = drill || period !== 'month' ? undefined : deltas.get(s.categoryId)
      rows.push([
        s.name,
        csvAmount(s.totalMinor),
        d && d.basis >= 3 ? csvAmount(d.typicalMinor) : '',
        d && d.basis >= 3 ? csvAmount(d.deltaMinor) : '',
        `${Math.round(s.fraction * 100)}%`,
      ])
    }
    const stamp = period === 'custom' ? `${from}-to-${to}` : period === 'year' ? year : month
    downloadCSV(`hearth-${book}-${stamp}${drill ? `-${drillName}` : ''}`, toCSV(rows))
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

  const columnCount = useColumnCount(COLUMN_STEPS)
  const { layout, setLayout, editing, setEditing } = useLayout('reportsLayout', SECTIONS)

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
    hasBreakdown(categoryId, txns ?? [], flows, categories, book, inView, books)

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
    // Activity filters by a single month, so a year view sends the category and
    // the book and leaves the list running — which is what you want from a
    // year's figure anyway.
    const q = new URLSearchParams(period === 'month' ? { month, book } : { book })
    if (categoryId && categoryId !== OTHER_SLICE_ID) q.set('category', categoryId)
    navigate(`/activity?${q}`)
  }

  if (txns && txns.length === 0) {
    return <Empty icon={ChartPie} title="Nothing to report yet" hint="Add or import some transactions and your charts will appear here." />
  }

  /**
   * One stepper, stepping whichever unit is being shown. A year is held as its
   * January, so everything downstream still receives a month key and nothing
   * else has to know which mode this is.
   *
   * Built once and rendered into both bars, so the two form factors cannot
   * disagree about what "Range" means.
   */
  const stepper =
    period === 'custom' ? (
      <div className="flex shrink-0 items-center gap-1.5">
        <TextInput
          type="date"
          value={from}
          max={to}
          aria-label="From"
          onChange={(e) => setFrom(e.target.value)}
          className="w-40"
        />
        <span className="text-sm text-ink-3">to</span>
        <TextInput
          type="date"
          value={to}
          min={from}
          max={todayISO()}
          aria-label="To"
          onChange={(e) => setTo(e.target.value)}
          className="w-40"
        />
      </div>
    ) : period === 'month' ? (
      <div className="shrink-0">
        <MonthStepper month={month} onChange={changeMonth} label={monthLabel} canGoForward={month < thisMonthKey()} />
      </div>
    ) : (
      <div className="shrink-0">
        <MonthStepper
          month={month}
          onChange={changeMonth}
          label={(k) => k.slice(0, 4)}
          step={12}
          canGoForward={year < thisMonthKey().slice(0, 4)}
        />
      </div>
    )

  /**
   * The breakdown, in whichever form the page is in.
   *
   * One function rather than two copies, because it appears in both views: as
   * an arrangeable section under Charts, and pinned above the month table under
   * Table. The Charts/Table toggle decides whether it draws or tabulates; the
   * section's own variant decides which drawing.
   */
  const categoriesCard = (controls: ReactNode, shape?: string) => (
    <Card className="p-5 md:p-4">
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
          {drill ? drillName : `${words.spend}`} · {periodLabel}
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
          {controls}
        </div>
      </div>
      {slices.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-3">
          No {book === 'mine' ? 'personal' : 'household'} spending recorded in {periodLabel}.
        </p>
      ) : view === 'charts' ? (
        <>
          {shape === 'bars' ? (
            <CategoryBars slices={slices} />
          ) : (
            <CategoryDonut
              slices={slices}
              centerLabel={{
                title: drill ? 'in here' : 'spent',
                value: money(slices.reduce((s, x) => s + x.totalMinor, 0), { compact: true }),
              }}
            />
          )}
          {/* Neither chart is clickable, so the drill-down lives in a row of
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
                      const d = drill || period !== 'month' ? undefined : deltas.get(s.categoryId)
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
  )

  /** A card's heading, with room for the chart-shape picker on the end of it. */
  const heading = (title: string, controls: ReactNode, hint?: string) => (
    <div className="mb-3 md:mb-2">
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 font-semibold md:text-sm">{title}</h3>
        {controls}
      </div>
      {hint && <p className="mt-1 text-sm text-ink-3 md:text-xs">{hint}</p>}
    </div>
  )

  /**
   * How many months are on screen at once. The toggle picks it; anything
   * earlier is still there and is reached by scrolling the chart.
   */
  const monthsShown = Number(range)
  const scrollHint =
    longSeries.length > monthsShown
      ? `Showing the last ${monthsShown} months — scroll the chart back for earlier ones.`
      : undefined

  /**
   * One section of the charts view.
   *
   * Returning null is how a section says it has nothing to show — a personal
   * book has no waterfall, a custom range has no months — and `Arrange` hides
   * the card rather than leaving an empty one in the arrangement. The section
   * stays in the layout, so it comes back the moment the data does.
   */
  const renderSection = (id: string, variant: string | undefined, controls: ReactNode): ReactNode => {
    // A range is not made of months, so every monthly series is a question it
    // cannot answer. The flow diagram and the breakdown are not: both are
    // totals over whatever period is in view.
    const monthly = period !== 'custom'

    switch (id) {
      case 'categories':
        return categoriesCard(controls, variant)

      case 'flow':
        return flowGraph.totalMinor === 0 ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              `Where it came from, where it went · ${periodLabel}`,
              controls,
              'Every ribbon is as wide as the money it carries, and the two sides balance: what is on the right is what the money on the left turned into.',
            )}
            <Sankey graph={flowGraph} />
          </Card>
        )

      case 'spend':
        return !monthly ? null : (
          <Card className="p-5 md:p-4">
            {heading(`${words.spend} each month`, controls, scrollHint)}
            <SpendBars data={longSeries} visible={monthsShown} shape={(variant as TrendShape) ?? 'bars'} />
          </Card>
        )

      case 'inout':
        return !monthly ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              book === 'household' ? 'Paid in vs spent' : book === 'mine' ? 'Earned vs spent' : 'In vs out',
              controls,
            )}
            <IncomeSpendBars data={longSeries} visible={monthsShown} />
          </Card>
        )

      case 'net':
        return !monthly ? null : (
          <Card className="p-5 md:p-4">
            {/* Not "what we saved": the series contains months that went the
                other way, and a title asserting saving over a line that dips
                below zero is the chart claiming credit for a bad month. */}
            {heading(
              book === 'household' ? 'Kept each month' : `${words.net} each month`,
              controls,
              words.netHint,
            )}
            <NetLine data={longSeries} visible={monthsShown} shape={(variant as TrendShape) ?? 'line'} />
          </Card>
        )

      /* The household's month as one path, not three figures to subtract in
         your head. Household only: the steps ARE the household model, and
         "moved to savings" means nothing in a book with one account in it. */
      case 'waterfall':
        return !monthly || book !== 'household' || !waterfall.some((s) => s.deltaMinor !== 0) ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              `Where it went · ${periodLabel}`,
              controls,
              'Paid in, then out again, in the order it happened. The last bar is what is still sitting in the current account.',
            )}
            <Waterfall steps={waterfall} />
          </Card>
        )

      /* The mirror of it, and the reason the personal book exists: the bar is
         the salary, and the question is what share of it went where. */
      case 'salary':
        return !monthly || book !== 'mine' || !salary.some((b) => b.earnedMinor > 0) ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              'What each salary turned into',
              controls,
              "Each bar is one month's earnings, split into what went to the household, what you spent on yourself, and what stayed put.",
            )}
            <SalaryStack data={salary} />
          </Card>
        )

      case 'committed':
        return !monthly || !committed.some((m) => m.fixedMinor + m.variableMinor > 0) ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              'Committed vs chosen',
              controls,
              'How much of the spending is bills you track. Anything not tracked as a bill counts as chosen, so this is only as good as your bill list.',
            )}
            <FixedVariableBars data={committed} />
          </Card>
        )

      case 'kept':
        return !monthly || !kept.some((m) => m.rate !== null) ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              'Share kept',
              controls,
              book === 'mine'
                ? 'What was left with you, as a share of what you earned. Money moved to the household is not spending, but it is not kept either.'
                : 'What did not go out again, as a share of what came in. Below the line, more went out than in.',
            )}
            <SavingsRateLine data={kept} />
          </Card>
        )

      case 'payees':
        return !monthly || payees.length === 0 ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              `Top payees · ${periodLabel}`,
              controls,
              'Under the category level. Shops the app treats as the same merchant are one line.',
            )}
            <TopPayees rows={payees} />
          </Card>
        )

      /* Deliberately the widest thing on the page by default. The point of it
         is reading ALONG a row for drift, which needs the months to be far
         enough apart to tell apart. */
      case 'heatmap':
        return !monthly || heatmap.rows.length === 0 ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              'Category by month',
              controls,
              'Read along a row to see a category creeping up. Shading compares every cell against the biggest one, so the rows are comparable with each other.',
            )}
            <CategoryHeatmap grid={heatmap} />
          </Card>
        )

      case 'pace':
        return period !== 'month' || !pacePoints.some((p) => p.thisMonthMinor || p.lastMonthMinor) ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              'Pace',
              controls,
              'Spending so far against the same point the month before — the one comparison a part-finished month can honestly make.',
            )}
            <PaceLine points={pacePoints} month={month} />
          </Card>
        )

      default:
        return null
    }
  }

  return (
    <div>
      {/* Wide screens keep every control visible at once. */}
      <Toolbar className="hidden md:flex">
        <BookSwitcher book={book} onChange={changeBook} className="hidden md:flex md:w-auto" />
        <Segmented
          value={view}
          onChange={setView}
          className="w-40"
          options={VIEW_OPTIONS}
        />
        <Segmented value={range} onChange={setRange} className="w-36" options={RANGE_OPTIONS} />
        <Segmented
          value={period}
          onChange={(p) => {
            setDrill(null)
            setPeriod(p)
          }}
          className="w-52"
          options={PERIOD_OPTIONS}
        />
        {stepper}
      </Toolbar>

      {/* A phone gets the same four decisions in one scrolling row. Three
          segmented controls stacked to about 250px before a single chart, which
          on this page is most of what there was room for. The stepper stays at
          full height inside the bar: it is the one control here that is pressed
          repeatedly rather than set once. */}
      <FilterBar>
        {/* Two states, so a toggle rather than a menu — it shows where you are
            and one tap is the whole interaction. */}
        <FilterChip
          chevron={false}
          aria-pressed={view === 'table'}
          title="Switch between charts and the table"
          onClick={() => setView(view === 'charts' ? 'table' : 'charts')}
          icon={view === 'charts' ? <ChartPie size={15} /> : <Table2 size={15} />}
          label={view === 'charts' ? 'Charts' : 'Table'}
        />
        <ChoiceChip
          value={period}
          options={PERIOD_OPTIONS}
          onChange={(p) => {
            setDrill(null)
            setPeriod(p)
          }}
        />
        <ChoiceChip value={range} options={RANGE_OPTIONS} onChange={setRange} />
        {stepper}
      </FilterBar>

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
            {periodLabel},{' '}
            <span className="font-medium tabular">{money(balances.nowMinor)}</span> now
            <span className="text-ink-3">
              {' '}— the {period === 'year' ? 'year' : period === 'custom' ? 'range runs to today, so it' : 'month'}{' '}
              is not over.
            </span>
          </p>
        )}
        {partial && !balances && (
          <p className="mt-1.5 text-xs text-ink-3">
            {periodLabel} runs to today, so these figures are still moving.
          </p>
        )}

        {/* Only where there is a real figure behind it. A tenth either way is
            not a change worth a sentence, and saying so anyway trains people to
            ignore the line. */}
        {period === 'custom' && (
          /* The one place a range behaves differently, so it is stated rather
             than left to be discovered. See `bookTotalsInRange`. */
          <p className="mt-1.5 text-xs text-ink-3">
            A range counts money on the day it moved. Contributions are not shifted into the month they fund,
            the way they are under Month and Year.
          </p>
        )}

        {period !== 'custom' && lastYear && Math.abs(lastYear.deltaMinor) >= Math.max(lastYear.spendMinor * 0.1, 1000) && (
          <p className="mt-1.5 text-xs text-ink-2">
            <span className={lastYear.deltaMinor > 0 ? 'font-medium text-critical-text' : 'font-medium text-good-text'}>
              {money(Math.abs(lastYear.deltaMinor))} {lastYear.deltaMinor > 0 ? 'more' : 'less'}
            </span>{' '}
            than {period === 'year' ? Number(year) - 1 : monthLabel(shiftMonth(month, -12))}, when{' '}
            {book === 'mine' ? 'you spent' : 'the household spent'} {money(lastYear.spendMinor)}.
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

      {/* Every chart below is a card somebody can move, resize or put away.
          `Arrange` does the laying out — masonry for the one-column cards,
          packed rows for the wider ones — and each section returns null where
          it has nothing to say, which hides its card rather than leaving an
          empty one in the arrangement. See `lib/layout.ts`.

          Widths are load-bearing here, not decoration: a card holding a table
          with `min-width: 460px` — or the heatmap, at 34rem — would grow its
          column to fit it if anything in the chain forgot `min-w-0`, and the
          `overflow-x-auto` inside would never get the chance to scroll. On a
          phone that card is then wider than the screen, and because `main`
          carries `overflow-x: clip` the excess is silently cut off. */}
      {view === 'table' ? (
        <div className="grid gap-3 md:gap-2.5 xl:grid-cols-2 [&>*]:min-w-0">
          <div className="xl:col-span-2">{categoriesCard(null)}</div>
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
        </div>
      ) : (
        <>
          {period === 'custom' && (
            /* A range has no months in it, so every monthly chart is a question
               it cannot answer. Said once, here, rather than leaving eight empty
               cards or — worse — eight cards quietly showing the wrong period. */
            <Card className="mb-3 p-5 md:mb-2.5 md:p-4">
              <p className="text-sm text-ink-3">
                The monthly charts are hidden for a custom range: a waterfall, a trend and a pace line are all
                questions about months, and this period is not made of them. Switch to Month or Year for those.
              </p>
            </Card>
          )}
          <Arrange
            catalogue={SECTIONS}
            layout={layout}
            onLayout={setLayout}
            columns={columnCount}
            editing={editing}
            onEditing={setEditing}
            render={({ def, variant, controls }) => renderSection(def.id, variant, controls)}
          />
        </>
      )}
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
