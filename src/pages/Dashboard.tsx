import { useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, Plus } from 'lucide-react'
import {
  useAccounts,
  useAllTransactions,
  useBills,
  useBook,
  useBooks,
  useBudgetsForMonth,
  useCategories,
  useFlows,
  useRemoteBalances,
  useMyLevels,
} from '../lib/cache'
import { accountsInBook } from '../lib/books'
import { BookSwitcher } from '../components/BookSwitcher'
import { thisMonthKey } from '../lib/dates'
import { defaultDemoAccount, seedDemoData } from '../lib/demo'
import { useSyncState } from '../hooks/useSync'
import { Arrange, useLayout } from '../components/Arrange'
import type { SectionDef } from '../lib/layout'
import { SLICE_SHAPES, TREND_SHAPES } from '../components/charts'
import { Button, Empty, Toolbar, useColumnCount } from '../components/ui'
import {
  HeroWidget,
  BudgetGlanceWidget,
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
  { id: 'hero', label: 'Month summary', component: HeroWidget, defaultSpan: 'full' },
  { id: 'budgets', label: 'Budgets at a glance', component: BudgetGlanceWidget, defaultSpan: 'full' },
  { id: 'bills', label: 'Coming up', component: BillsWidget },
  { id: 'donut', label: 'Where it went', component: DonutWidget, variants: SLICE_SHAPES },
  { id: 'trend', label: 'Spending trend', component: TrendWidget, variants: TREND_SHAPES },
  { id: 'accounts', label: 'Accounts', component: AccountsWidget },
  { id: 'owed', label: 'Owed to you', component: ReimbursementWidget },
  { id: 'recent', label: 'Recent activity', component: RecentWidget },
  // Wide and detailed, so it waits to be asked for rather than turning up on
  // everyone's home page on the strength of being new.
  { id: 'flow', label: 'Where it flowed', component: FlowWidget, defaultSpan: 'full', defaultOn: false },
]

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
  const [seeding, setSeeding] = useState(false)
  const columnCount = useColumnCount(COLUMN_STEPS)
  const { layout, setLayout, editing, setEditing } = useLayout('homeLayout', WIDGETS)

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
   * Everything on this page is narrowed to the chosen book once, here, rather
   * than in seven widgets. A widget that merely lists rows then needs no
   * changes at all; only the ones that add money up have to know about flows,
   * because a contribution is neither income nor spending.
   */
  const ids = accountsInBook(book, books)
  const scopedTxns = (txns ?? []).filter((t) => ids.has(t.accountId))
  const data: HomeData = {
    txns: scopedTxns,
    // Unscoped, for the one widget that straddles two books. See HomeData.
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
  }
  return (
    <div>
      {/* Wide screens only: on a phone the lens lives in the header, so this
          whole row would be an empty margin. */}
      <Toolbar className="hidden md:flex">
        <BookSwitcher book={book} onChange={setBook} className="hidden md:flex md:w-auto" />
      </Toolbar>

      {/* Masonry columns for the one-column widgets, so cards pack vertically
          instead of aligning to the tallest card in a grid row; rows for the
          wider ones, which cannot join a masonry column without breaking it.
          `Arrange` decides which is which — see `lib/layout.ts`. */}
      <Arrange
        catalogue={WIDGETS}
        layout={layout}
        onLayout={setLayout}
        columns={columnCount}
        editing={editing}
        onEditing={setEditing}
        render={({ def, variant, controls }) => {
          const Widget = (def as (typeof WIDGETS)[number]).component
          return <Widget data={data} variant={variant} controls={controls} />
        }}
      />
    </div>
  )
}
