import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
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
import { paintOf } from '../lib/palette'
import { csvAmount, downloadCSV, toCSV } from '../lib/csv'
import { unexplainedLegs, unexplainedTotals } from '../lib/unexplained'
import { useSyncState } from '../hooks/useSync'
import { nameOf } from '../components/PersonDot'
import { thisMonthKey, monthLabel, shiftMonth, todayISO, fmtFullDate } from '../lib/dates'
import { OTHER_SLICE_ID } from '../lib/stats'
import {
  bookBalances,
  bookBridge,
  bookSeries,
  bookSlices,
  bookSplitByCategory,
  bookTotals,
  bookTotalsInRange,
  rangeSlices,
  savedInto,
  savedIntoRange,
  savingsAccounts,
  sumBookTotals,
  contributionSplit,
  contributionSplitInRange,
  sumContributionSplits,
  hasBreakdown,
  BOOK_WORDS,
  type BookId,
} from '../lib/books'
import { useApp } from '../state/AppContext'
import { Card, CardHeading, useInfoNote, Fill, Progress, Segmented, Empty, FilterBar, FilterChip, Popover, Toolbar, MonthStepper, Button, TextInput, table, ScrollTable, useColumnCount, cx } from '../components/ui'
import { CategoryIcon } from '../components/CategoryIcon'
import { BookSwitcher } from '../components/BookSwitcher'
import { Arrange, useLayout } from '../components/Arrange'
import { currentVariant, optionValue, setVariant, type SectionDef } from '../lib/layout'
import { openDrill, pathWithState, type Drill } from '../lib/drill'
import { Sankey, sankeyHeight } from '../components/Sankey'
import { booksFlow, spendFlow } from '../lib/sankey'
import { monthsOfHistory } from '../lib/stats'
import {
  CategoryBars,
  CategoryDonut,
  CategoryMosaic,
  SpendBars,
  IncomeSpendBars,
  NetLine,
  IN_OUT_SHAPES,
  NET_SHAPES,
  SLICE_SHAPES,
  TREND_SHAPES,
  rowCount,
  sliceCount,
  type InOutShape,
  type TrendShape,
} from '../components/charts'
import {
  BooksBridge,
  BRIDGE_SHAPES,
  CategoryHeatmap,
  CategorySplitBars,
  FixedVariableBars,
  PaidIn,
  PAID_IN_SHAPES,
  type BridgeLine,
  type PaidInRow,
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
/** The month list is a table by default; these are the ways out of it. */
const MONTHS_SHAPES: { value: 'table' | 'bars' | 'lines'; label: string }[] = [
  { value: 'table', label: 'Table' },
  { value: 'bars', label: 'Bars' },
  { value: 'lines', label: 'Lines' },
]

/**
 * The breakdown's shapes, plus one this page alone can offer.
 *
 * `SLICE_SHAPES` is shared with the home page's donut, which is drawn inside a
 * single book and has nothing to split. "By book" is only ever meaningful under
 * Everything, so it is added here rather than to the shared list, and the card
 * falls back to bars in the other two books — a control that appears to do
 * nothing is worse than one that is not offered.
 */
const CATEGORY_SHAPES = [...SLICE_SHAPES, { value: 'books', label: 'By book' }]

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
  {
    id: 'categories',
    label: 'Where it went',
    defaultSpan: 'full',
    variants: CATEGORY_SHAPES,
    options: [sliceCount('8')],
  },
  { id: 'spend', label: 'Spending each month', variants: TREND_SHAPES },
  { id: 'inout', label: 'In vs out', variants: IN_OUT_SHAPES },
  { id: 'net', label: 'Kept each month', defaultSpan: 'full', variants: NET_SHAPES },
  { id: 'flow', label: 'The whole flow', defaultSpan: 'full', options: [sliceCount('8')] },
  // Household only, and the one figure this whole model makes newly possible:
  // neither of us can see the other's salary, but every contribution ARRIVES in
  // a joint account, which we can both read.
  { id: 'paidin', label: 'Who paid in', variants: PAID_IN_SHAPES },
  // Everything only. These two are what that book is FOR, now that it has
  // stopped being the other two poured into one pool.
  { id: 'bridge', label: 'How the books add up', defaultSpan: 'full', variants: BRIDGE_SHAPES },
  // Five rather than eight: this diagram stacks BOTH books' categories in one
  // column, so the count is paid for twice. See `MAX_HEIGHT` in Sankey.tsx.
  { id: 'crossings', label: 'Between our books', defaultSpan: 'full', options: [sliceCount('5')] },
  { id: 'waterfall', label: 'Step by step', defaultSpan: 'full' },
  { id: 'salary', label: 'What each salary turned into', defaultSpan: 'full' },
  { id: 'committed', label: 'Committed vs chosen' },
  { id: 'kept', label: 'Share kept' },
  { id: 'payees', label: 'Top payees', options: [rowCount('10')] },
  {
    id: 'heatmap',
    label: 'Category by month',
    defaultSpan: 'full',
    options: [
      rowCount('10', 'Categories shown'),
      {
        id: 'figures',
        label: 'In each cell',
        choices: [
          { value: 'amounts', label: 'Amounts' },
          { value: 'colour', label: 'Colour only' },
        ],
      },
    ],
  },
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
            type="button"
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
  /** How the table view's month list is drawn. Session state, like the view. */
  const [monthsShape, setMonthsShape] = useState<'table' | 'bars' | 'lines'>('table')
  const [book, setBook] = useBook()
  /** The category being drilled into, or null for the top level. */
  const [drill, setDrill] = useState<string | null>(null)

  /**
   * The arrangement, read up here rather than beside the grid it draws.
   *
   * Most of what a section decides about itself is presentation and can be
   * answered inside `renderSection` from the `options` it is handed. Three
   * choices are not: how many categories are worth naming, how many payees and
   * how many heatmap rows all change what is COMPUTED, and the aggregates are
   * page-level memos shared with the table view. So the page asks the layout
   * for those three itself.
   */
  const { layout, setLayout, editing, setEditing } = useLayout('reportsLayout', SECTIONS)
  const sectionOption = (sectionId: string, optionId: string, fallback: string) =>
    optionValue(
      SECTIONS.find((s) => s.id === sectionId),
      layout.find((i) => i.id === sectionId),
      optionId,
    ) ?? fallback
  const sliceLimit = Number(sectionOption('categories', 'count', '8'))
  const flowLimit = Number(sectionOption('flow', 'count', '8'))
  const crossingLimit = Number(sectionOption('crossings', 'count', '5'))
  const payeeLimit = Number(sectionOption('payees', 'rows', '10'))
  const heatmapRows = Number(sectionOption('heatmap', 'rows', '10'))

  /**
   * The state a breadcrumb sent us back with.
   *
   * Read once and cleared, exactly as Activity reads a drill: a param nobody
   * can see must not go on quietly overriding a control somebody then uses.
   * Anything unrecognised is ignored rather than trusted — this is a URL.
   */
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    if ([...params.keys()].length === 0) return
    const asked = {
      month: params.get('month'),
      period: params.get('period'),
      range: params.get('range'),
      view: params.get('view'),
      drill: params.get('drill'),
    }
    setParams({}, { replace: true })
    if (asked.month && /^\d{4}-\d{2}$/.test(asked.month)) setMonth(asked.month)
    if (asked.period === 'month' || asked.period === 'year' || asked.period === 'custom') setPeriod(asked.period)
    if (asked.range === '6' || asked.range === '12') setRange(asked.range)
    if (asked.view === 'charts' || asked.view === 'table') setView(asked.view)
    if (asked.drill) setDrill(asked.drill)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const txns = useAllTransactions()
  const accounts = useAccounts()
  const levels = useMyLevels()
  const categories = useCategories()
  const catMap = useCategoryMap()
  const books = useBooks()
  const flows = useFlows(txns, books)
  const { userId } = useSyncState()
  const memberMap = useMemberMap()

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

  /**
   * Who paid in what. Household book only — it is meaningless anywhere else,
   * and it is the one figure this whole model makes newly possible: neither of
   * us can see the other's salary, but every contribution ARRIVES in a joint
   * account, which we can both read.
   *
   * Scoped to the PERIOD, exactly as `totals` below is. It used to be asked for
   * the selected month whatever the period was, so under Year the person bands
   * showed one month's contributions against a year's income — and because
   * `spendFlow` fills the gap with "Put in — not sure by whom", eleven months of
   * perfectly well attributed money quietly turned into money with no name on
   * it. Declared after `inView` for that reason: the period is what decides it.
   */
  const split = useMemo(
    () =>
      period === 'custom'
        ? contributionSplitInRange(txns ?? [], flows, books, from, to, userId)
        : sumContributionSplits(
            inView.map((m) => contributionSplit(txns ?? [], flows, m, books, userId)),
          ),
    [txns, flows, inView, books, userId, period, from, to],
  )

  const slices = useMemo(
    () =>
      period === 'custom'
        ? rangeSlices(txns ?? [], flows, categories, book, books, from, to, drill ?? undefined, sliceLimit)
        : bookSlices(txns ?? [], flows, categories, book, inView, books, drill ?? undefined, sliceLimit),
    [txns, flows, categories, book, inView, books, drill, period, from, to, sliceLimit],
  )
  /**
   * The same breakdown, never drilled into — what the flow diagram is built
   * from. It carries the diagram's own count rather than the breakdown card's:
   * the two are different pictures with different room in them, and a ribbon
   * per category is a stricter limit than a row per category.
   */
  const topSlices = useMemo(
    () =>
      period === 'custom'
        ? rangeSlices(txns ?? [], flows, categories, book, books, from, to, undefined, flowLimit)
        : bookSlices(txns ?? [], flows, categories, book, inView, books, undefined, flowLimit),
    [txns, flows, categories, book, inView, books, period, from, to, flowLimit],
  )
  /** The same breakdown, split into each book's share. Everything only. */
  const splitSlices = useMemo(
    () =>
      book !== 'all' || period === 'custom'
        ? []
        : bookSplitByCategory(txns ?? [], flows, categories, books, inView, sliceLimit),
    [book, period, txns, flows, categories, books, inView, sliceLimit],
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
    () => topPayees(txns ?? [], flows, categories, book, books, month, payeeLimit),
    [txns, flows, categories, book, books, month, payeeLimit],
  )
  const heatmap = useMemo(
    () => categoryHeatmap(txns ?? [], flows, categories, book, books, monthKeys, heatmapRows),
    [txns, flows, categories, book, books, monthKeys, heatmapRows],
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
  /**
   * Of what is left over, how much went into a savings account inside the book.
   *
   * A transfer between two accounts of one book is not income and not spending,
   * which is right for "what did we earn and spend" and useless for the one
   * question anybody asks of a savings account. It changes no total — the money
   * is still the book's — so the diagram simply draws what is left split into
   * the part that was put by and the part that stayed.
   */
  const savedMinor = useMemo(() => {
    const ids = savingsAccounts(accounts, book, books)
    if (ids.size === 0) return 0
    return period === 'custom'
      ? savedIntoRange(txns ?? [], flows, book, books, ids, from, to)
      : savedInto(txns ?? [], flows, book, books, ids, inView)
  }, [txns, flows, book, books, accounts, inView, period, from, to])

  /**
   * Who paid in, as rows — the two halves of each person's contribution kept
   * apart, which is the whole reason the card exists.
   *
   * The unattributed band is a person-shaped absence rather than a person, so
   * it is muted: an unattributed figure must not wear somebody's colour. Outside
   * income is not a contribution at all and is listed last, quietly, because
   * leaving it out would make the shares add up to something other than what
   * came in.
   */
  const paidIn = useMemo<PaidInRow[]>(() => {
    const rows: PaidInRow[] = [
      {
        key: 'mine',
        name: 'You',
        movedMinor: Math.max(0, split.mineMinor - split.minePaidMinor),
        boughtMinor: split.minePaidMinor,
        count: split.mineCount,
        slot: 2,
      },
      {
        key: 'theirs',
        name: partner ?? 'Someone else',
        movedMinor: Math.max(0, split.theirsMinor - split.theirsPaidMinor),
        boughtMinor: split.theirsPaidMinor,
        count: split.theirsCount,
        slot: 5,
      },
      {
        key: 'unnamed',
        name: 'Paid in — not sure by whom',
        movedMinor: split.unattributedMinor,
        boughtMinor: 0,
        count: 0,
        slot: 0,
        muted: true,
      },
      {
        key: 'external',
        name: 'Other income',
        movedMinor: split.externalMinor,
        boughtMinor: 0,
        count: 0,
        slot: 0,
        muted: true,
      },
    ]
    return rows.filter((r) => r.movedMinor + r.boughtMinor > 0)
  }, [split, partner])

  /** How much of the household's spending never passed through a joint account. */
  const boughtDirect = split.minePaidMinor + split.theirsPaidMinor

  const bridge = useMemo(
    () =>
      bookBridge(txns ?? [], flows, books, period === 'custom' ? inView : inView),
    [txns, flows, books, inView, period],
  )

  /**
   * The bridge, as lines.
   *
   * Two of the three identities are exact and one is not, and all three are
   * printed rather than the difference being rounded away — see `bookBridge`.
   * The two correction lines are shown only when they are non-zero, because a
   * row of dashes explaining an adjustment that did not happen is noise.
   */
  const bridgeLines = useMemo<BridgeLine[]>(() => {
    const lines: BridgeLine[] = [
      {
        key: 'outside',
        label: 'From outside',
        household: bridge.household.externalIncome,
        mine: bridge.mine.externalIncome + bridge.mine.returned,
        all: bridge.all.externalIncome,
      },
    ]
    if (bridge.crossingMinor > 0) {
      lines.push({
        key: 'between',
        label: 'Put in between us',
        household: bridge.household.contributions,
        mine: bridge.crossingMinor,
        all: undefined,
        negative: false,
      })
    }
    lines.push({
      key: 'spent',
      label: 'Spent',
      household: bridge.household.spend,
      mine: bridge.mine.spend,
      all: bridge.all.spend,
    })
    if (bridge.unheldSpendMinor > 0) {
      lines.push({
        key: 'unheld',
        label: 'Bought for us from an account you cannot see',
        household: bridge.unheldSpendMinor,
        mine: undefined,
        all: undefined,
        negative: true,
      })
    }
    lines.push({
      key: 'left',
      label: 'Left',
      household: bridge.household.net,
      mine: bridge.mine.net,
      all: bridge.all.net,
      total: true,
    })
    return lines
  }, [bridge])

  /** The two books' spending, kept apart, for the four-column diagram. */
  const crossingGraph = useMemo(() => {
    if (book !== 'all') return { nodes: [], links: [], totalMinor: 0 }
    return booksFlow({
      bridge,
      split,
      householdSlices: bookSlices(txns ?? [], flows, categories, 'household', inView, books, undefined, crossingLimit),
      mineSlices: bookSlices(txns ?? [], flows, categories, 'mine', inView, books, undefined, crossingLimit),
      partner: partner ?? undefined,
    })
  }, [book, bridge, split, txns, flows, categories, inView, books, crossingLimit, partner])

  const flowGraph = useMemo(
    () =>
      spendFlow({
        book,
        totals,
        savedMinor,
        // The top level always, even while a category is drilled into. A flow
        // diagram of one category's children is a picture of a drill-down, not
        // of a period — and handing it the children would leave the rest of the
        // spending to arrive on the right as "not categorised", which is a
        // sentence about the data rather than about the drill.
        slices: topSlices,
        split,
        partner: partner ?? undefined,
      }),
    [book, totals, topSlices, split, partner, savedMinor],
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
  /**
   * What the figures on this card mean, and the one way a hand-drawn range
   * behaves differently. Both are worth saying and neither is worth saying
   * every time the page opens.
   */
  const summaryNote = useInfoNote(
    `${periodLabel} in figures`,
    <>
      <p>{words.netHint}</p>
      {period === 'custom' && (
        <p>
          A range counts money on the day it moved. Contributions are not shifted into the month they fund, the
          way they are under Month and Year.
        </p>
      )}
    </>,
  )
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

  /**
   * The breakdown's shape picker, for the table view.
   *
   * `Arrange` builds this for every section it lays out, and the table view is
   * the one place a card is rendered OUTSIDE it — so the one view that contains
   * a table was the one view with no way to switch away from a table. Built by
   * hand here from the same layout the grid reads.
   */
  const tableControls = (
    <Segmented
      value={currentVariant(SECTIONS[0], layout.find((i) => i.id === 'categories')) ?? 'donut'}
      onChange={(v) => setLayout(setVariant(layout, 'categories', v))}
      className="w-44"
      options={CATEGORY_SHAPES}
    />
  )

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
   * Every figure on this page is a claim about a set of transactions — spending
   * in one book, over one period, under one category, to one payee — and
   * Activity can say exactly that, so the answer to "what is that £412?" is a
   * navigation rather than a reconstruction by hand. See `lib/drill.ts` for why
   * it is a page rather than a modal.
   *
   * The period travels as whatever it actually is: one month as a month, a year
   * or a hand-drawn range as its two end dates. A year used to travel as
   * nothing at all, which landed you in the whole history with a category
   * filter and a figure that no longer matched anything on screen.
   */
  const periodDrill = (): Pick<Drill, 'month' | 'from' | 'to'> =>
    period === 'month'
      ? { month }
      : period === 'year'
        ? { from: `${year}-01-01`, to: `${year}-12-31` }
        : { from, to }

  /**
   * Where "back" goes, with this page's own state in it.
   *
   * A bare `/reports` is a different page that happens to share an address: it
   * opens on this month, as charts, at the top level. The breadcrumb has to
   * return you to the chart you left — March, as a year, in the table view,
   * inside Groceries — so the state travels with the link and is read back on
   * arrival.
   */
  const backHere = () =>
    pathWithState('/reports', { month, period, range, view, drill: drill ?? undefined })

  const seeTransactions = (extra: Partial<Drill> = {}) =>
    openDrill({ book, ...periodDrill(), backTo: backHere(), backLabel: 'Reports', ...extra })

  /** The same, for a figure that names its own month — a heatmap cell, a bar. */
  const seeMonth = (monthKey: string, extra: Partial<Drill> = {}) =>
    openDrill({
      book,
      month: monthKey,
      from: undefined,
      to: undefined,
      backTo: backHere(),
      backLabel: 'Reports',
      ...extra,
    })

  /** "Other" is the tail of small categories folded together, not a category. */
  const categoryDrill = (categoryId?: string) =>
    categoryId && categoryId !== OTHER_SLICE_ID ? { category: categoryId } : {}

  if (txns && txns.length === 0) {
    return <Empty icon={ChartPie} title="Nothing to report yet" hint="Add or import some transactions and your charts will appear here." />
  }

  /**
   * One stepper, stepping whichever unit is being shown. A year is held as its
   * January, so everything downstream still receives a month key and nothing
   * else has to know which mode this is.
   *
   * Written once and asked for by each bar, so the two form factors cannot
   * disagree about what "Range" means — but the phone's copy is a pill, because
   * it stands in a row of pills. Same control, same behaviour, one size.
   */
  const stepper = (variant: 'toolbar' | 'chip') =>
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
      <MonthStepper
        variant={variant}
        month={month}
        onChange={changeMonth}
        label={monthLabel}
        canGoForward={month < thisMonthKey()}
      />
    ) : (
      <MonthStepper
        variant={variant}
        month={month}
        onChange={changeMonth}
        label={(k) => k.slice(0, 4)}
        step={12}
        canGoForward={year < thisMonthKey().slice(0, 4)}
      />
    )

  /**
   * What pressing a category means, in one place.
   *
   * The same rule the table's rows have always had: a press goes INTO a
   * category while there is anything inside it, and shows the transactions when
   * there is not. So the gesture keeps meaning "more detail" all the way down,
   * and the bottom of the drill is the list of rows rather than a dead end.
   */
  const pickSlice = (slice: { categoryId: string }) => {
    if (!drill && canDrill(slice.categoryId)) return setDrill(slice.categoryId)
    seeTransactions(categoryDrill(slice.categoryId))
  }

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
              type="button"
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
            <Button size="sm" variant="subtle" onClick={() => seeTransactions(categoryDrill(drill ?? undefined))}>
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
          {shape === 'books' && splitSlices.length > 0 ? (
            <CategorySplitBars slices={splitSlices} partner={partner ?? undefined} onPick={pickSlice} />
          ) : shape === 'bars' || shape === 'books' ? (
            <CategoryBars slices={slices} onPick={pickSlice} />
          ) : shape === 'mosaic' ? (
            /* Taller than the home widget's, because this is a full-width panel
               on its own: the blocks squarify against the box, so a long thin
               one would give every category a letterbox. */
            <Fill min={300}>
              {(height) => <CategoryMosaic slices={slices} height={height} onPick={pickSlice} />}
            </Fill>
          ) : (
            <Fill min={240}>
              {(height) => (
                <CategoryDonut
                  slices={slices}
                  height={height}
                  onPick={pickSlice}
                  // What a press does depends on whether THIS category has
                  // anything left inside it, so the label is asked per slice — on a
                  // phone it is the only wording the gesture gets, and a button
                  // saying "Look inside" that opens a list of rows instead is worse
                  // than no label at all.
                  pickLabel={(s) => (!drill && canDrill(s.categoryId) ? 'Look inside' : 'See transactions')}
                  centerLabel={{
                    title: drill ? 'in here' : 'spent',
                    value: money(slices.reduce((s, x) => s + x.totalMinor, 0), { compact: true }),
                  }}
                />
              )}
            </Fill>
          )}
          {/* The buttons stay even though the chart is now clickable: they are
              the keyboard path, and a hit target big enough for a thumb on the
              categories too thin to press in the ring. The blocks need neither
              — each is a real button, and the ones too small to label carry
              their own chip. */}
          {!drill && shape !== 'mosaic' && (
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
                      <span style={{ color: paintOf(s.slot, s.color) }}>
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
                      type="button"
                      aria-label={`See ${s.name} transactions`}
                      title={`See ${s.name} transactions in ${monthLabel(month)}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        seeTransactions(categoryDrill(s.categoryId))
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

  /**
   * A card's heading, with room for the chart-shape picker on the end of it.
   *
   * The third argument used to be a `hint` that rendered as a permanently
   * visible paragraph. Eleven cards each carried two sentences of it, which is
   * three lines above every chart on a phone and the rule in CLAUDE.md broken
   * eleven times over. It is an `info` now — same words, behind the ⓘ, read
   * once rather than re-read on every visit.
   */
  const heading = (title: string, controls: ReactNode, info?: ReactNode, hint?: ReactNode) => (
    <CardHeading title={title} controls={controls} info={info} hint={hint} />
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
  const renderSection = (
    id: string,
    variant: string | undefined,
    options: Record<string, string>,
    controls: ReactNode,
  ): ReactNode => {
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
            {/* Only the category bands lead anywhere: the left-hand side is
                income and contributions, which are not a category filter, and
                "Not categorised" is the absence of one. */}
            <Fill min={sankeyHeight(flowGraph)}>
              {(height) => (
                <Sankey
                  graph={flowGraph}
                  height={height}
                  canPick={(n) => n.id.startsWith('cat:')}
                  onPick={(n) => seeTransactions({ category: n.id.slice(4) })}
                />
              )}
            </Fill>
          </Card>
        )

      /* Household only. Neither of us can see the other's salary, but every
         contribution ARRIVES in a joint account and joint accounts are readable
         by both — so this is one figure that is complete and identical on both
         screens, and the only place it can be. */
      case 'paidin':
        return book !== 'household' || paidIn.length === 0 ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              `Who paid in · ${periodLabel}`,
              controls,
              <>
                <p>
                  Money reaches the household two ways: it is moved into a joint account, or something is bought
                  for us straight off somebody&rsquo;s own card. Both are putting money in, and only the first is
                  a decision you make once a month.
                </p>
                <p>
                  A contribution nobody has linked cannot be put on a name — an arrival on its own cannot say who
                  sent it — so it sits under &ldquo;not sure by whom&rdquo; until somebody says.
                </p>
              </>,
            )}
            <PaidIn
              rows={paidIn}
              totalMinor={totals.income}
              shape={variant}
              // Every band leads to the same list: a contribution is not a
              // category filter, and "not sure by whom" is the absence of one.
              onPick={() => seeTransactions()}
            />
            {boughtDirect > 0 && (
              <p className="mt-3 text-sm text-ink-2 md:text-xs">
                <span className="font-semibold tabular">{money(boughtDirect)}</span> of this period&rsquo;s household
                spending was bought straight from personal cards.
              </p>
            )}
          </Card>
        )

      /* Everything only, and the reason that book exists at all now: it stops
         being a fourth filter over the same rows and becomes the view that
         explains the other two. */
      case 'bridge':
        return book !== 'all' || bridge.all.income + bridge.all.spend === 0 ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              `How the books add up · ${periodLabel}`,
              controls,
              <>
                <p>
                  Money moved between our books is counted once in each book and in neither under Everything — the
                  two legs are the same event, so counting either would be counting it twice. That is why
                  Everything&rsquo;s income is not the two figures above it added together.
                </p>
                <p>
                  What is left always adds up exactly, whatever the crossings did and whoever paid for what.
                </p>
                {bridge.unheldSpendMinor > 0 && (
                  <p>
                    Household shopping bought on a card this device cannot see belongs to the household book and to
                    no account here, so Everything is short by it. That is a fact about who can see what, not a
                    rounding error.
                  </p>
                )}
                {bridge.unbookedCount > 0 && (
                  <p>
                    {bridge.unbookedCount} {bridge.unbookedCount === 1 ? 'row is' : 'rows are'} in an account that is
                    in neither book — one somebody shared with you. Those are yours to read and not yours to count,
                    so they are in no figure here, including Everything&rsquo;s.
                  </p>
                )}
              </>,
            )}
            <BooksBridge
              lines={bridgeLines}
              shape={variant}
              partner={partner ?? undefined}
              onPick={() => seeTransactions()}
            />
          </Card>
        )

      case 'crossings':
        return book !== 'all' || crossingGraph.totalMinor === 0 ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              `Between our books · ${periodLabel}`,
              controls,
              <p>
                Where the money came from, whose it became, and what it turned into. The two columns in the middle
                are the crossing: everything one of us put into the household, moved across or bought straight off
                a card, and anything taken back out again.
              </p>,
            )}
            <Fill min={sankeyHeight(crossingGraph)}>
              {(height) => (
                <Sankey
                  graph={crossingGraph}
                  height={height}
                  caption="Left to right: where it came from, whose it became, and what it turned into."
                  canPick={(n) => n.id.includes(':cat:')}
                  onPick={(n) => seeTransactions({ category: n.id.split(':cat:')[1] })}
                />
              )}
            </Fill>
          </Card>
        )

      case 'spend':
        return !monthly ? null : (
          <Card className="p-5 md:p-4">
            {/* A one-liner about what is on screen right now stays on screen:
                nobody opens a ⓘ to find out that a chart scrolls. */}
            {heading(`${words.spend} each month`, controls, undefined, scrollHint)}
            <Fill min={220}>
              {(height) => (
                <SpendBars
                  data={longSeries}
                  height={height}
                  visible={monthsShown}
                  shape={(variant as TrendShape) ?? 'bars'}
                  onPickMonth={(m) => seeMonth(m)}
                />
              )}
            </Fill>
          </Card>
        )

      case 'inout':
        return !monthly ? null : (
          <Card className="p-5 md:p-4">
            {heading(
              book === 'household' ? 'Paid in vs spent' : book === 'mine' ? 'Earned vs spent' : 'In vs out',
              controls,
            )}
            <Fill min={240}>
              {(height) => (
                <IncomeSpendBars
                  data={longSeries}
                  height={height}
                  visible={monthsShown}
                  shape={(variant as InOutShape) ?? 'bars'}
                  onPickMonth={(m) => seeMonth(m)}
                />
              )}
            </Fill>
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
            <Fill min={220}>
              {(height) => (
                <NetLine
                  data={longSeries}
                  height={height}
                  visible={monthsShown}
                  shape={(variant as TrendShape) ?? 'line'}
                  onPickMonth={(m) => seeMonth(m)}
                />
              )}
            </Fill>
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
            <Fill min={260}>{(height) => <Waterfall steps={waterfall} height={height} />}</Fill>
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
            <Fill min={240}>{(height) => <SalaryStack data={salary} height={height} />}</Fill>
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
            <Fill min={240}>{(height) => <FixedVariableBars data={committed} height={height} />}</Fill>
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
            <Fill min={220}>{(height) => <SavingsRateLine data={kept} height={height} />}</Fill>
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
            {/* The month the list was computed from, not the period label:
                `topPayees` takes one month, so a drill carrying anything else
                would open a list that does not add up to the row pressed. */}
            <TopPayees rows={payees} onPick={(payee) => seeMonth(month, { payee })} />
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
            <CategoryHeatmap
              grid={heatmap}
              figures={options.figures !== 'colour'}
              onPick={(categoryId, cellMonth) => seeMonth(cellMonth, { category: categoryId })}
            />
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
            <Fill min={220}>{(height) => <PaceLine points={pacePoints} month={month} height={height} />}</Fill>
          </Card>
        )

      default:
        return null
    }
  }

  return (
    <div>
      {/* Wide screens keep every control visible at once. */}
      <Toolbar className="max-md:hidden">
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
        {stepper('toolbar')}
      </Toolbar>

      {/* A phone gets the same four decisions in one scrolling row. Three
          segmented controls stacked to about 250px before a single chart, which
          on this page is most of what there was room for. */}
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
        {stepper('chip')}
      </FilterBar>

      {/* The month in figures, in this book's own words. On the household book
          the contributions line is the one that does not exist anywhere else:
          it is the money we each put in, and it is visible to both of us even
          though neither can see the other's salary. */}
      {/*
        The period, as the page's one painted surface.

        It was three grey figures in a tall white box: the same weight each, so
        nothing led; a bare "Money in / Money out / Net" with no sense of one
        becoming the other; and no colour anywhere on the page's first screen.
        Home solves this already — `.panel-month` is the app's own answer to
        "this is the card you opened the page for" — and Reports had simply
        never been given it. Same panel, same tokens, same over-budget state.

        The hierarchy is the point rather than the paint: one figure leads, the
        two that make it up sit under a rule, and the bar underneath is what
        came in against what went out, so the relationship between them is a
        shape rather than a subtraction the reader has to do.
      */}
      {/* No `panel-over`. On Home the alarm state means "past the budget you
          set", which is a fact you can act on; here the only candidate is a
          negative net, and a part-month that has not had its salary yet is
          negative every time — an alarm that fires monthly is one nobody
          reads. The figure says it, and the sentence under it says why. */}
      <Card className="panel-month mb-3 p-4 md:mb-2.5 md:p-3.5">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-sm" style={{ color: 'var(--panel-ink-2)' }}>
            {periodLabel} · {words.spend.toLowerCase()}
          </p>
          {summaryNote.toggle}
        </div>
        <p className="mt-0.5 text-4xl font-bold tracking-tight tabular md:text-3xl">{money(totals.spend)}</p>

        {/* What came in against what went out, as one bar. A month that spent
            more than it took in fills it and says so — which is the same fact
            as the negative net below, in the form you can read without
            subtracting. */}
        {totals.income > 0 && (
          <div className="mt-3">
            <Progress
              fraction={totals.spend / totals.income}
              tone={totals.spend > totals.income ? 'over' : totals.spend / totals.income > 0.85 ? 'warn' : 'ok'}
              on="panel"
            />
          </div>
        )}

        <dl
          className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 border-t pt-3 md:grid-cols-4"
          style={{ borderColor: 'var(--panel-line)' }}
        >
          {[
            { label: words.income, value: totals.income, sign: false },
            ...(book === 'household' && totals.contributions > 0
              ? [{ label: 'Of that, we put in', value: totals.contributions, sign: false }]
              : []),
            ...(book === 'mine' && totals.contributed > 0
              ? [{ label: 'To our household', value: totals.contributed, sign: false }]
              : []),
            ...(savedMinor > 0 ? [{ label: 'To savings', value: savedMinor, sign: false }] : []),
            { label: words.net, value: totals.net, sign: true },
          ].map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className="text-xs" style={{ color: 'var(--panel-ink-2)' }}>{f.label}</dt>
              {/* No tone on the figure: green and red on this panel are a dark
                  green and a dark red on a dark blue, which are the two figures
                  that most need reading made hardest to read. The panel's own
                  colour says which state the period is in. */}
              <dd className="mt-0.5 text-xl font-bold tracking-tight tabular md:text-lg">
                {money(f.value, { sign: f.sign })}
              </dd>
            </div>
          ))}
        </dl>


        {/* The balances, for the month that has not finished. Deliberately
            below the figures rather than beside them: it is the sentence that
            makes an alarming "left over" readable, not a fourth statistic. */}
        {partial && balances && (
          <p className="mt-2.5 text-xs" style={{ color: 'var(--panel-ink-2)' }}>
            <span className="font-medium tabular">{money(balances.startMinor)}</span> at the start of{' '}
            {periodLabel},{' '}
            <span className="font-medium tabular">{money(balances.nowMinor)}</span> now
            {' '}— the {period === 'year' ? 'year' : period === 'custom' ? 'range runs to today, so it' : 'month'}{' '}
            is not over.
          </p>
        )}
        {summaryNote.body}
        {partial && !balances && (
          <p className="mt-2.5 text-xs" style={{ color: 'var(--panel-ink-2)' }}>
            {periodLabel} runs to today, so these figures are still moving.
          </p>
        )}

        {/* Only where there is a real figure behind it. A tenth either way is
            not a change worth a sentence, and saying so anyway trains people to
            ignore the line. */}
        {period !== 'custom' && lastYear && Math.abs(lastYear.deltaMinor) >= Math.max(lastYear.spendMinor * 0.1, 1000) && (
          <p className="mt-2.5 text-xs" style={{ color: 'var(--panel-ink-2)' }}>
            <span className="font-semibold" style={{ color: 'var(--panel-ink)' }}>
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
          <div className="mt-3 rounded-xl px-3 py-2.5" style={{ background: 'var(--panel-track)' }}>
            <p className="text-xs" style={{ color: 'var(--panel-ink-2)' }}>
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
              {/* Two different sentences, because there are now two different
                  situations and only one of them is out of your hands. If the
                  far side is on somebody's device, they have to confirm it and
                  you can only ask. If they are not using the app at all, there
                  is no far side to wait for and saying whose it was is the
                  whole of the fix — which is a thing you can do yourself. */}
              <span>
                {unexplained.inCount > 0 && partner
                  ? `Pair it from ${partner}'s device, or — if the account it came from is not in Hearth — say it was theirs and it will count towards the month it was for.`
                  : partner
                    ? `Only ${partner} can confirm the far side, from their own device.`
                    : 'Only the person whose account is on the other side can confirm it.'}
              </span>{' '}
              <button
                type="button"
                onClick={() => seeTransactions()}
                className="underline underline-offset-2"
                style={{ color: 'var(--panel-ink)' }}
              >
                See {unexplained.outCount + unexplained.inCount === 1 ? 'it' : 'them'}
              </button>
            </p>
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
          {/* The picker travels into the table view too. The section's variant
              decides which DRAWING; hiding the control here meant the one view
              with a table in it was the one where you could not switch away
              from it. */}
          <div className="xl:col-span-2">{categoriesCard(tableControls)}</div>
          <Card className="p-5 md:p-4 xl:col-span-2">
            <div className="mb-3 flex items-center justify-between gap-2 md:mb-2">
              <h3 className="font-semibold md:text-sm">Month by month</h3>
              <div className="flex items-center gap-2">
                {/* The one table on this page with no chart beside it. The
                    figures ARE the point of the table view, so it stays the
                    default — but a column of twelve numbers is a shape you
                    cannot see, and this is the way to see it. */}
                <Segmented
                  value={monthsShape}
                  onChange={setMonthsShape}
                  className="w-44"
                  options={MONTHS_SHAPES}
                />
                <Button size="sm" variant="ghost" onClick={exportMonths} title="Download this table as CSV">
                  <Download size={13} /> CSV
                </Button>
              </div>
            </div>
            {monthsShape !== 'table' ? (
              <Fill min={240}>
                {(height) => (
                  <IncomeSpendBars
                    data={longSeries}
                    height={height}
                    visible={monthsShown}
                    shape={monthsShape === 'lines' ? 'lines' : 'bars'}
                    onPickMonth={(m) => seeMonth(m)}
                  />
                )}
              </Fill>
            ) : (
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
            )}
          </Card>
        </div>
      ) : (
        <>
          {period === 'custom' && (
            /* A range has no months in it, so every monthly chart is a question
               it cannot answer. Said once, here, rather than leaving eight empty
               cards or — worse — eight cards quietly showing the wrong period. */
            <Card className="mb-3 p-5 md:mb-2.5 md:p-4">
              <CardHeading
                className="mb-0"
                title="The monthly charts are hidden for a custom range"
                info={
                  <p>
                    A waterfall, a trend and a pace line are all questions about months, and this period is not made
                    of them. Switch to Month or Year for those.
                  </p>
                }
              />
            </Card>
          )}
          <Arrange
            catalogue={SECTIONS}
            layout={layout}
            onLayout={setLayout}
            columns={columnCount}
            editing={editing}
            onEditing={setEditing}
            render={({ def, variant, options, controls }) => renderSection(def.id, variant, options, controls)}
          />
        </>
      )}
    </div>
  )
}


