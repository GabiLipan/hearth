import { useEffect, useState, type ComponentType } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Sparkles, SlidersHorizontal, Check, ChevronUp, ChevronDown, EyeOff, Plus } from 'lucide-react'
import { db, getSetting, setSetting } from '../lib/db'
import { notDeleted } from '../lib/data'
import { seedDemoData } from '../lib/demo'
import { useSyncState } from '../hooks/useSync'
import { Button, Empty, cx } from '../components/ui'
import {
  HeroWidget,
  BudgetGlanceWidget,
  AccountsWidget,
  DonutWidget,
  TrendWidget,
  BillsWidget,
  RecentWidget,
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
  { id: 'recent', label: 'Recent activity', component: RecentWidget },
]

interface LayoutItem {
  id: string
  on: boolean
}

const DEFAULT_LAYOUT: LayoutItem[] = WIDGETS.map((w) => ({ id: w.id, on: true }))

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
  const { userId } = useSyncState()
  const txns = useLiveQuery(() => db.transactions.filter(notDeleted).toArray(), [])
  const categories = useLiveQuery(() => db.categories.filter(notDeleted).toArray(), []) ?? []
  const budgets = useLiveQuery(() => db.budgets.filter(notDeleted).toArray(), []) ?? []
  const bills = useLiveQuery(() => db.bills.filter(notDeleted).toArray(), []) ?? []
  const accounts = useLiveQuery(() => db.accounts.filter(notDeleted).toArray(), []) ?? []
  const [layout, setLayout] = useState<LayoutItem[]>(DEFAULT_LAYOUT)
  const [editing, setEditing] = useState(false)
  const [seeding, setSeeding] = useState(false)

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
    return (
      <Empty
        emoji="👋"
        title="Welcome to Hearth"
        hint="Your shared home for budgets, bills and spending. Add your first transaction with the + button, import a bank statement from the Activity tab — or explore with demo data first."
        action={
          <Button
            disabled={seeding}
            onClick={async () => {
              setSeeding(true)
              await seedDemoData()
            }}
          >
            <Sparkles size={16} /> {seeding ? 'Loading…' : 'Load demo data'}
          </Button>
        }
      />
    )
  }

  const data: HomeData = { txns: txns ?? [], categories, budgets, bills, accounts, userId }
  const visible = layout.filter((l) => l.on)
  const hidden = layout.filter((l) => !l.on)
  const defOf = (id: string) => WIDGETS.find((w) => w.id === id)!

  return (
    <div>
      {/* Masonry columns on desktop: cards pack vertically instead of aligning
          to the tallest card in a grid row, so there's no dead space between
          cards of unequal height. Wide widgets span the full width. */}
      <div className="lg:columns-2 lg:gap-3">
        {visible.map((item) => {
          const def = defOf(item.id)
          const Widget = def.component
          return (
            <div
              key={item.id}
              className={cx('relative min-w-0 mb-3 break-inside-avoid', def.wide && 'lg:[column-span:all]')}
            >
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
        })}
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
