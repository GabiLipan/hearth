import { useEffect, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, SlidersHorizontal, Check, ChevronUp, ChevronDown, EyeOff, Plus } from 'lucide-react'
import { getSetting, setSetting } from '../lib/db'
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
import { Button, Columns, Empty, Toolbar, useColumnCount, cx } from '../components/ui'
import {
  HeroWidget,
  BudgetGlanceWidget,
  AccountsWidget,
  DonutWidget,
  TrendWidget,
  BillsWidget,
  RecentWidget,
  ReimbursementWidget,
  type HomeData,
} from '../components/widgets'

interface WidgetDef {
  id: string
  label: string
  component: ComponentType<{ data: HomeData }>
  /** wide widgets span both columns on desktop */
  wide?: boolean
}

const WIDGETS: WidgetDef[] = [
  { id: 'hero', label: 'Month summary', component: HeroWidget, wide: true },
  { id: 'budgets', label: 'Budgets at a glance', component: BudgetGlanceWidget, wide: true },
  { id: 'bills', label: 'Coming up', component: BillsWidget },
  { id: 'donut', label: 'Where it went', component: DonutWidget },
  { id: 'trend', label: 'Spending trend', component: TrendWidget },
  { id: 'accounts', label: 'Accounts', component: AccountsWidget },
  { id: 'owed', label: 'Owed to you', component: ReimbursementWidget },
  { id: 'recent', label: 'Recent activity', component: RecentWidget },
]

interface LayoutItem {
  id: string
  on: boolean
}

const DEFAULT_LAYOUT: LayoutItem[] = WIDGETS.map((w) => ({ id: w.id, on: true }))

/** Two columns on a laptop, three on a wide monitor, four on a very wide one. */
const COLUMN_STEPS: [number, number][] = [[768, 2], [1536, 3], [2200, 4]]

/** Merge a stored layout with the widget catalogue (new widgets append, on). */
function normaliseLayout(stored: LayoutItem[] | null): LayoutItem[] {
  const known = new Set(WIDGETS.map((w) => w.id))
  const seen = new Set<string>()
  const out: LayoutItem[] = []
  for (const item of stored ?? []) {
    if (known.has(item.id) && !seen.has(item.id)) {
      out.push(item)
      seen.add(item.id)
    }
  }
  for (const w of WIDGETS) if (!seen.has(w.id)) out.push({ id: w.id, on: true })
  return out.length ? out : DEFAULT_LAYOUT
}

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
  const [layout, setLayout] = useState<LayoutItem[]>(DEFAULT_LAYOUT)
  const [editing, setEditing] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const columnCount = useColumnCount(COLUMN_STEPS)

  useEffect(() => {
    void getSetting('homeLayout').then((raw) => {
      if (raw) {
        try {
          setLayout(normaliseLayout(JSON.parse(raw)))
        } catch {
          /* keep default */
        }
      }
    })
  }, [])

  function saveLayout(next: LayoutItem[]) {
    setLayout(next)
    void setSetting('homeLayout', JSON.stringify(next))
  }

  function move(id: string, dir: -1 | 1) {
    const i = layout.findIndex((l) => l.id === id)
    const j = i + dir
    if (j < 0 || j >= layout.length) return
    const next = [...layout]
    ;[next[i], next[j]] = [next[j], next[i]]
    saveLayout(next)
  }

  function toggle(id: string) {
    saveLayout(layout.map((l) => (l.id === id ? { ...l, on: !l.on } : l)))
  }

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
  const visible = layout.filter((l) => l.on)
  const hidden = layout.filter((l) => !l.on)
  const defOf = (id: string) => WIDGETS.find((w) => w.id === id)!

  /** Consecutive narrow widgets share a set of columns; a wide one stands alone. */
  const bands: { wide: boolean; items: LayoutItem[] }[] = []
  for (const item of visible) {
    const wide = !!defOf(item.id).wide
    const last = bands[bands.length - 1]
    if (!wide && last && !last.wide) last.items.push(item)
    else bands.push({ wide, items: [item] })
  }

  const renderWidget = (item: LayoutItem) => {
    const def = defOf(item.id)
    const Widget = def.component
    return (
      <div key={item.id} className="relative min-w-0">
        {editing && (
          <div className="absolute right-2 top-2 z-10 flex gap-1 rounded-full bg-surface p-1 shadow-md ring-1 ring-hairline">
            <button onClick={() => move(item.id, -1)} aria-label={`Move ${def.label} up`} className="grid size-7 place-items-center rounded-full hover:bg-surface-2">
              <ChevronUp size={14} />
            </button>
            <button onClick={() => move(item.id, 1)} aria-label={`Move ${def.label} down`} className="grid size-7 place-items-center rounded-full hover:bg-surface-2">
              <ChevronDown size={14} />
            </button>
            <button onClick={() => toggle(item.id)} aria-label={`Hide ${def.label}`} className="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-surface-2">
              <EyeOff size={14} />
            </button>
          </div>
        )}
        <div className={cx(editing && 'rounded-2xl ring-2 ring-dashed ring-accent/40')}>
          <Widget data={data} />
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Wide screens only: on a phone the lens lives in the header, so this
          whole row would be an empty margin. */}
      <Toolbar className="hidden md:flex">
        <BookSwitcher book={book} onChange={setBook} className="hidden md:flex md:w-auto" />
      </Toolbar>

      {/* Masonry columns on desktop: cards pack vertically instead of aligning
          to the tallest card in a grid row, so there's no dead space between
          cards of unequal height. The column count follows the viewport — two
          on a laptop, three or four on a wide monitor.

          A wide widget is full width, which splits the run into bands: the
          narrow widgets before it get their own set of columns, and so do the
          ones after. That is what `column-span: all` used to do, before CSS
          columns had to go — see `Columns`. */}
      <div className="flex flex-col gap-3 md:gap-2.5">
        {bands.map((band, i) =>
          band.wide ? (
            <div key={band.items[0].id}>{renderWidget(band.items[0])}</div>
          ) : (
            <Columns key={`band-${i}`} count={columnCount} gap="gap-3 md:gap-2.5">
              {band.items.map(renderWidget)}
            </Columns>
          ),
        )}
      </div>

      {editing && hidden.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 px-1 text-sm font-semibold uppercase tracking-wide text-ink-3">Hidden widgets</p>
          <div className="flex flex-wrap gap-2">
            {hidden.map((item) => (
              <button
                key={item.id}
                onClick={() => toggle(item.id)}
                className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3.5 py-2 text-sm font-medium text-ink-2 hover:text-ink"
              >
                <Plus size={14} /> {defOf(item.id).label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 flex justify-center">
        <button
          onClick={() => setEditing(!editing)}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition',
            editing ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-ink-3 hover:text-ink',
          )}
        >
          {editing ? (
            <>
              <Check size={15} /> Done
            </>
          ) : (
            <>
              <SlidersHorizontal size={15} /> Customise
            </>
          )}
        </button>
      </div>
    </div>
  )
}
