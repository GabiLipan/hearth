import { useMemo, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, Plus } from 'lucide-react'
import {
  useAccounts,
  useAllTransactions,
  useBills,
  useFlag,
  useBook,
  useBooks,
  useBudgetsForMonth,
  useCategories,
  useFlows,
  useMonthRule,
  useRemoteBalances,
  useMyLevels,
  OWED_FLAG,
} from '../lib/cache'
import { accountsInBook, showsInBook } from '../lib/books'
import { BookSwitcher } from '../components/BookSwitcher'
import { thisMonthKey } from '../lib/dates'
import { defaultDemoAccount, seedDemoData } from '../lib/demo'
import { useSyncState } from '../hooks/useSync'
import { Arrange, useLayout } from '../components/Arrange'
import type { SectionDef } from '../lib/layout'
import { SLICE_SHAPES, TREND_SHAPES, monthWindow, rowCount, sliceCount } from '../components/charts'
import { Button, Empty, Toolbar, useColumnCount } from '../components/ui'
import { BRIDGE_SHAPES, PAID_IN_SHAPES } from '../components/insights'
import {
  HeroWidget,
  HERO_SHAPES,
  BridgeWidget,
  BudgetGlanceWidget,
  PaidInWidget,
  AccountsWidget,
  DonutWidget,
  FlowWidget,
  TrendWidget,
  BillsWidget,
  RecentWidget,
  ReimbursementWidget,
  type HomeData,
  type WidgetProps,
} from '../components/widgets'

/**
 * What the home page can show, and what each one is called when it is being
 * arranged or is sitting in the row of things that are not shown.
 *
 * The widths here are only DEFAULTS. Everything on this page can be one column,
 * two, or the full width, and which it is is somebody's decision rather than
 * the widget's — a household that lives out of its budgets wants those full
 * width and the accounts in a corner, and the app has no way of knowing that.
 */
const WIDGETS: (SectionDef & { component: ComponentType<WidgetProps> })[] = [
  { id: 'hero', label: 'Month summary', component: HeroWidget, defaultSpan: 'full', ground: 'panel', variants: HERO_SHAPES },
  { id: 'budgets', label: 'Budgets at a glance', component: BudgetGlanceWidget, defaultSpan: 'full' },
  {
    id: 'bills',
    label: 'Coming up',
    component: BillsWidget,
    options: [
      {
        id: 'ahead',
        label: 'Looking ahead',
        defaultValue: '14',
        choices: [
          { value: '7', label: 'A week' },
          { value: '14', label: 'A fortnight' },
          { value: '30', label: 'A month' },
          { value: '60', label: 'Two months' },
        ],
      },
    ],
  },
  {
    id: 'donut',
    label: 'Where it went',
    component: DonutWidget,
    variants: SLICE_SHAPES,
    options: [sliceCount('6')],
  },
  {
    id: 'trend',
    label: 'Spending trend',
    component: TrendWidget,
    variants: TREND_SHAPES,
    options: [monthWindow('6')],
  },
  // Each of these belongs to ONE book and renders nothing in the others, which
  // is what lets all three sit in one catalogue: the card is hidden rather than
  // empty, and comes back when the lens does.
  { id: 'paidin', label: 'Who paid in', component: PaidInWidget, variants: PAID_IN_SHAPES },
  { id: 'bridge', label: 'How the books add up', component: BridgeWidget, defaultSpan: 'full', variants: BRIDGE_SHAPES },
  { id: 'accounts', label: 'Accounts', component: AccountsWidget },
  { id: 'recent', label: 'Recent activity', component: RecentWidget, options: [rowCount('5', 'Rows')] },
  // Wide and detailed, so it waits to be asked for rather than turning up on
  // everyone's home page on the strength of being new.
  {
    id: 'flow',
    label: 'Where it flowed',
    component: FlowWidget,
    defaultSpan: 'full',
    defaultOn: false,
    options: [sliceCount('8')],
  },
]

/**
 * The one widget that is not in the catalogue above.
 *
 * Being owed for something you bought the household is a real fact and a
 * SHARPER reading of the same rows than the books need — `paid_for_household`
 * files the spending correctly whether or not anybody is keeping score, and for
 * a couple who simply share everything, a running total of what the other owes
 * on the home page is an answer to a question they were not asking.
 *
 * So it is off unless asked for, in Settings › Accounts, and off means ABSENT
 * rather than hidden: a section that is merely switched off still sits in
 * Customise mode's row of things you could add, which is the same offer made
 * more quietly. Nothing about `lib/reimbursements.ts` changes — the arithmetic
 * is still there, still tested, and the switch is the only thing between it and
 * the screen.
 *
 * The cost of absence, stated because it is real: `normaliseLayout` drops a
 * stored item whose section is not in the catalogue, so rearranging the page
 * while this is off forgets where the card used to be. Turning it back on puts
 * it at the end rather than where it was. That is the right way round — losing
 * a position is recoverable in one drag, and the alternative is carrying a
 * ghost entry nobody can see.
 */
const OWED_WIDGET: SectionDef & { component: ComponentType<WidgetProps> } = {
  id: 'owed',
  label: 'Owed to you',
  component: ReimbursementWidget,
}

/** Two columns on a laptop, three on a wide monitor, four on a very wide one. */
const COLUMN_STEPS: [number, number][] = [[768, 2], [1536, 3], [2200, 4]]

export default function Dashboard() {
  const navigate = useNavigate()
  const { userId } = useSyncState()
  const txns = useAllTransactions()
  const categories = useCategories()
  // This month's only. Budgets are per-month rows, so handing the widgets every
  // month would show each category once per month it was ever budgeted.
  const budgets = useBudgetsForMonth(thisMonthKey())
  const bills = useBills()
  const accounts = useAccounts()
  const remoteBalances = useRemoteBalances()
  const levels = useMyLevels()
  const [book, setBook] = useBook()
  const books = useBooks()
  const flows = useFlows(txns, books)
  const rule = useMonthRule()
  const [seeding, setSeeding] = useState(false)
  const columnCount = useColumnCount(COLUMN_STEPS)
  const showOwed = useFlag(OWED_FLAG)
  const catalogue = useMemo(() => (showOwed ? [...WIDGETS, OWED_WIDGET] : WIDGETS), [showOwed])
  const { layout, setLayout, editing, setEditing } = useLayout('homeLayout', catalogue)

  if (txns && txns.length === 0) {
    // Nothing creates an account for you any more, so the first thing somebody
    // needs is one. Without this the only action here was "Load demo data",
    // which is disabled until an account exists — a dead end on a fresh
    // household, and after erasing everything.
    const target = defaultDemoAccount(accounts, levels)
    return (
      <Empty
        icon={Sparkles}
        title="Welcome to Hearth"
        hint={
          target
            ? 'Your shared home for budgets, bills and spending. Add your first transaction with the + button, import a bank statement from the Activity tab — or explore with demo data first.'
            : 'Your shared home for budgets, bills and spending. Start with an account — a current account, a credit card, whatever you actually use — and everything else hangs off that.'
        }
        action={
          target ? (
            <Button
              disabled={seeding}
              onClick={async () => {
                setSeeding(true)
                try {
                  await seedDemoData(target.id)
                } finally {
                  // Without this the button stays on "Loading…" forever when
                  // seeding fails, with nothing to say what went wrong.
                  setSeeding(false)
                }
              }}
            >
              <Sparkles size={16} /> {seeding ? 'Loading…' : 'Load demo data'}
            </Button>
          ) : (
            <Button onClick={() => navigate('/settings')}>
              <Plus size={16} /> Add an account
            </Button>
          )
        }
      />
    )
  }

  /**
   * The book's ROW LIST, narrowed once here rather than in seven widgets.
   *
   * `showsInBook`, not `ids.has(t.accountId)`, and the difference is the whole
   * of a bug that made this page disagree with Reports. One row can leave its
   * account: household shopping paid off a personal card is spending in the
   * household's book while living in an account outside it. Selecting by
   * account alone dropped those rows before the widgets ever saw them — so Our
   * household's spending on this page was short by exactly them, and Recent
   * activity omitted your own shopping from a list whose heading had already
   * counted it.
   *
   * Anything that ADDS MONEY UP takes `allTxns` instead. Those functions —
   * `bookTotals`, `bookSlices`, `bookSeries`, `contributionSplit` — do their own
   * account selection, and one of them deliberately reaches outside the book to
   * do it. Handing them a list that has already been narrowed silently disables
   * that. Reports passes them the whole set, which is why the two pages agree
   * again.
   */
  const ids = accountsInBook(book, books)
  const scopedTxns = (txns ?? []).filter((t) => showsInBook(t, book, books, ids))
  const data: HomeData = {
    txns: scopedTxns,
    allTxns: txns ?? [],
    allAccounts: accounts,
    categories,
    // Household budgets belong to the household book, personal ones to mine.
    // Under Everything, show the lot rather than an arbitrary half.
    budgets: budgets.filter((b) =>
      book === 'household' ? !b.ownerId : book === 'mine' ? b.ownerId === userId : true,
    ),
    bills: bills.filter((b) => ids.has(b.accountId)),
    accounts: accounts.filter((a) => ids.has(a.id)),
    remoteBalances,
    levels,
    userId,
    book,
    books,
    flows,
    rule,
  }
  return (
    <div>
      {/* Wide screens only: on a phone the lens lives in the header, so this
          whole row would be an empty margin. */}
      <Toolbar className="max-md:hidden">
        <BookSwitcher book={book} onChange={setBook} className="hidden md:flex md:w-auto" />
      </Toolbar>

      {/* Masonry columns for the one-column widgets, so cards pack vertically
          instead of aligning to the tallest card in a grid row; rows for the
          wider ones, which cannot join a masonry column without breaking it.
          `Arrange` decides which is which — see `lib/layout.ts`. */}
      <Arrange
        catalogue={catalogue}
        layout={layout}
        onLayout={setLayout}
        columns={columnCount}
        editing={editing}
        onEditing={setEditing}
        render={({ def, variant, options, controls }) => {
          const Widget = (def as (typeof WIDGETS)[number]).component
          return <Widget data={data} variant={variant} options={options} controls={controls} />
        }}
      />
    </div>
  )
}
