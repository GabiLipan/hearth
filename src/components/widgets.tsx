import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeftRight, ArrowRight, ChevronLeft, Eye } from 'lucide-react'
import { getDaysInMonth } from 'date-fns'
import type { Transaction, Category, Budget, Bill, Account, GrantLevel } from '../lib/db'
import { thisMonthKey, monthLabel, fmtDay, daysUntil, fmtFullDate, todayISO } from '../lib/dates'
import { monthlySpendByCategory, monthsEndingAt, OTHER_SLICE_ID } from '../lib/stats'
import {
  accountsInBook,
  bookSeries,
  bookSlices,
  bookTotals,
  hasBreakdown,
  BOOK_WORDS,
  type BookId,
  type BookMap,
  type Flow,
} from '../lib/books'
import { settlement } from '../lib/reimbursements'
import { typicalRange } from '../lib/budgetHistory'
import { balanceOf, canAddTransactions, canSeeTransactionsAt, levelOn } from '../lib/accounts'
import { transfer } from '../lib/goals'
import { parseAmount, currencySymbol } from '../lib/money'
import { syncNow } from '../lib/session'
import { useApp } from '../state/AppContext'
import { Button, Card, CategoryDot, Field, Progress, Select, Sheet, TextInput, cx } from './ui'
import { BudgetBullet } from './BudgetBullet'
import { CategoryIcon } from './CategoryIcon'
import { CategoryDonut, SpendBars } from './charts'

export interface HomeData {
  txns: Transaction[]
  /**
   * Every transaction this device can see, NOT narrowed to the chosen book.
   *
   * Almost nothing should want this — `txns` is scoped for a reason, and a
   * widget adding up rows from outside the book on screen is the double-count
   * the book model exists to prevent. `ReimbursementWidget` wants it because
   * what it measures genuinely straddles two books: what I paid out of mine and
   * what the household has paid back into it. Narrowing to either one would
   * show half the sum.
   */
  allTxns: Transaction[]
  /** Likewise unscoped: paying yourself back moves money between two books. */
  allAccounts: Account[]
  categories: Category[]
  /** This month's budgets only — see Dashboard. Widgets must not assume history. */
  budgets: Budget[]
  bills: Bill[]
  accounts: Account[]
  /** Server-computed balances for accounts whose transactions we cannot read. */
  remoteBalances: Map<string, number>
  /** What I may do on each account — the mirror of `my_account_ids()`. */
  levels: Map<string, GrantLevel>
  userId?: string
  /**
   * Which book is on screen. Dashboard has already narrowed `txns`, `accounts`,
   * `bills` and `budgets` to it, so a widget that only lists rows needs to do
   * nothing — but anything that ADDS money up must go through `bookTotals` and
   * friends, because a contribution is not income and not spending and only
   * these know which.
   */
  book: BookId
  books: BookMap
  flows: Map<string, Flow>
}

const month = () => thisMonthKey()

/* ---------- Month summary hero ---------- */

/** One figure in the desktop stat strip. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="min-w-0 px-4 first:pl-0 last:pr-0">
      <p className="text-xs text-ink-3">{label}</p>
      <p
        className={cx(
          'mt-0.5 truncate text-lg font-bold tracking-tight tabular',
          tone === 'good' && 'text-good-text',
          tone === 'bad' && 'text-critical-text',
        )}
      >
        {value}
      </p>
    </div>
  )
}

export function HeroWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const words = BOOK_WORDS[data.book]
  const totals = useMemo(
    () => bookTotals(data.txns, data.flows, data.book, month(), data.books),
    [data.txns, data.flows, data.book, data.books],
  )
  const budgetTotal = data.budgets.reduce((s, b) => s + b.amountMinor, 0)
  const frac = budgetTotal > 0 ? totals.spend / budgetTotal : 0
  const over = frac > 1
  const bar = budgetTotal > 0 && <Progress fraction={frac} tone={over ? 'over' : frac > 0.85 ? 'warn' : 'ok'} />

  return (
    <Card className="p-4 md:p-3">
      {/* Phone: one headline figure with the detail stacked underneath. */}
      <div className="flex flex-wrap items-end justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <p className="text-sm text-ink-3">{monthLabel(month())} · {words.spend.toLowerCase()}</p>
          <p className="mt-0.5 truncate text-3xl font-bold tracking-tight tabular">{money(totals.spend)}</p>
          {budgetTotal > 0 && (
            <p className="mt-0.5 text-sm text-ink-2">
              of {money(budgetTotal, { hideDecimals: true })}
              {over ? (
                <span className="font-medium text-critical-text"> · {money(totals.spend - budgetTotal)} over</span>
              ) : (
                <span className="font-medium text-good-text"> · {money(budgetTotal - totals.spend)} left</span>
              )}
            </p>
          )}
        </div>
        <div className="min-w-36 flex-1">
          <div className="mb-1.5 flex justify-between gap-2 text-xs text-ink-3">
            <span className="truncate">{words.income} {money(totals.income, { compact: true })}</span>
            <span className="truncate">{words.net} {money(totals.net, { sign: true, compact: true })}</span>
          </div>
          {bar}
        </div>
      </div>

      {/* Desktop: a strip of figures across the full width. */}
      <div className="hidden md:block">
        <p className="text-xs text-ink-3">{monthLabel(month())}</p>
        <div className="mt-1 flex flex-nowrap items-start divide-x divide-hairline">
          <Stat label={words.spend} value={money(totals.spend)} />
          <Stat label={words.income} value={money(totals.income)} />
          {data.book === 'mine' && totals.contributed > 0 && (
            <Stat label="To household" value={money(totals.contributed)} />
          )}
          <Stat
            label={words.net}
            value={money(totals.net, { sign: true })}
            tone={totals.net < 0 ? 'bad' : 'good'}
          />
          {budgetTotal > 0 && <Stat label="Budgeted" value={money(budgetTotal, { hideDecimals: true })} />}
        </div>
        {budgetTotal > 0 && <div className="mt-2">{bar}</div>}
      </div>
    </Card>
  )
}

/* ---------- Budgets at a glance ---------- */
export function BudgetGlanceWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const now = new Date()
  const paceFrac = now.getDate() / getDaysInMonth(now)
  // Six months, so the bullet can say what "normal" looks like for a category.
  // This also aligns the widget with the Budgets page, which rolls subcategory
  // spending up to the parent and excludes transfers — the hand-rolled loop
  // that used to live here did neither, so the two pages disagreed.
  const months = useMemo(() => monthsEndingAt(month(), 6), [])
  const history = useMemo(
    () => monthlySpendByCategory(data.txns, data.categories, months),
    [data.txns, data.categories, months],
  )
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  // Budgets follow the book: the household's shared ones under "Our household",
  // my own under "Mine". Spending is already narrowed to the book's accounts by
  // Dashboard, so a household budget stops counting my private card.
  const rows = data.budgets
    .filter((b) => catMap.has(b.categoryId))
    .map((b) => {
      const series = history.get(b.categoryId) ?? months.map(() => 0)
      return {
        cat: catMap.get(b.categoryId)!,
        budget: b.amountMinor,
        spent: series[series.length - 1],
        typical: typicalRange(series.slice(0, -1)),
      }
    })
    .sort((a, b) => b.spent / b.budget - a.spent / a.budget)
  if (rows.length === 0) {
    return (
      <Card className="p-4 md:p-3">
        <p className="text-sm text-ink-3">
          No budgets yet — set some in the <Link to="/budgets" className="text-accent">Budgets</Link> tab and they'll
          appear here.
        </p>
      </Card>
    )
  }
  const totalBudget = rows.reduce((s, r) => s + r.budget, 0)
  const totalSpent = rows.reduce((s, r) => s + r.spent, 0)
  return (
    <Card className="p-4 md:p-3">
      <div className="mb-3 flex items-baseline justify-between gap-2 md:mb-2">
        <h3 className="font-semibold md:text-sm">Budgets</h3>
        <p className="text-sm text-ink-2 tabular">
          <span className="font-semibold text-ink">{money(totalSpent, { compact: true })}</span> of{' '}
          {money(totalBudget, { compact: true, hideDecimals: true })}
        </p>
      </div>
      {/* This widget spans the full page width, so on a wide screen the rows
          split into columns — a bar 1,000px long is harder to read, not easier. */}
      <ul className="grid gap-2.5 md:gap-x-6 md:gap-y-1.5 lg:grid-cols-2 min-[1800px]:grid-cols-3">
        {rows.map(({ cat, budget, spent: catSpent, typical }) => {
          const over = catSpent > budget
          return (
            <li key={cat.id} className="flex items-center gap-2.5 md:gap-2">
              <span className="grid w-5 shrink-0 place-items-center" style={{ color: `var(--series-${cat.slot})` }} aria-hidden>
                <CategoryIcon icon={cat.icon} size={15} />
              </span>
              <span className="w-24 truncate text-sm text-ink-2 sm:w-32">{cat.name}</span>
              <BudgetBullet
                className="flex-1"
                spent={catSpent}
                budget={budget}
                typical={typical}
                pace={paceFrac}
                color={`var(--series-${cat.slot})`}
                label={`${cat.name}: ${money(catSpent)} spent of a ${money(budget)} budget`}
              />
              <span className={cx('w-16 shrink-0 text-right text-xs font-medium tabular', over ? 'text-critical-text' : 'text-ink-2')}>
                {over ? `+${money(catSpent - budget, { compact: true })}` : money(budget - catSpent, { compact: true })}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-xs text-ink-3 md:mt-2">
        Bar = spent · dark tick = budget · pale block = what this category normally costs · right column = left (or over)
      </p>
    </Card>
  )
}

/* ---------- Accounts ---------- */
export function AccountsWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  if (data.accounts.length === 0) return null
  const balance = (a: Account) => balanceOf(a, data.txns, data.remoteBalances, levelOn(a.id, data.levels))
  const total = data.accounts.reduce((s, a) => s + balance(a), 0)
  return (
    <Card className="p-4 md:p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-semibold md:text-sm">Accounts</h3>
        <span className="text-sm font-semibold tabular">{money(total)}</span>
      </div>
      <ul className="divide-y divide-hairline">
        {data.accounts.map((a) => {
          const level = levelOn(a.id, data.levels)
          const bal = balance(a)
          return (
            <li key={a.id} className="flex items-center gap-2 py-2 md:py-1">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {a.name}
                {/* The eye means "you can see what is in it, not what it was
                    spent on" — the one tier where the total on the right comes
                    from the server rather than from rows this device holds. */}
                {!canSeeTransactionsAt(level) && <Eye size={12} className="ml-1.5 inline text-ink-3" />}
              </span>
              <span className={cx('text-sm font-semibold tabular', bal < 0 && 'text-critical-text')}>{money(bal)}</span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ---------- Where it went ---------- */
export function DonutWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  /** The category being looked inside, or null for the top level. */
  const [drill, setDrill] = useState<string | null>(null)

  const slices = useMemo(
    () => bookSlices(data.txns, data.flows, data.categories, data.book, month(), data.books, drill ?? undefined, 6),
    [data.txns, data.flows, data.categories, data.book, data.books, drill],
  )
  // Changing book empties the breadcrumb: it would otherwise point at a
  // category that is no longer on this screen.
  useEffect(() => setDrill(null), [data.book])

  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const canDrill = (categoryId: string) =>
    categoryId !== OTHER_SLICE_ID &&
    hasBreakdown(categoryId, data.txns, data.flows, data.categories, data.book, month(), data.books)

  const spent = slices.reduce((s, x) => s + x.totalMinor, 0)
  if (slices.length === 0 && !drill) return null

  return (
    <Card className="p-4 md:p-3">
      <h3 className="mb-2 flex items-center gap-1 font-semibold md:mb-1.5 md:text-sm">
        {drill && (
          <button
            onClick={() => setDrill(null)}
            className="flex items-center gap-0.5 rounded-full px-1 py-0.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink"
          >
            <ChevronLeft size={14} /> All
          </button>
        )}
        {drill ? (catMap.get(drill)?.name ?? 'Category') : 'Where it went'}
      </h3>
      <CategoryDonut
        slices={slices}
        height={180}
        centerLabel={{ title: drill ? 'in here' : 'spent', value: money(spent, { compact: true }) }}
      />
      {/* The donut itself is not clickable, so the way in is a row of buttons
          under it — the same arrangement Reports uses, and the same reasons:
          a keyboard path, and a target big enough for a thumb. */}
      {!drill && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {slices.filter((s) => canDrill(s.categoryId)).map((s) => (
            <button
              key={s.categoryId}
              onClick={() => setDrill(s.categoryId)}
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-xs font-medium text-ink-2 transition hover:text-ink"
            >
              <CategoryIcon icon={s.icon} size={12} /> {s.name}
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}

/* ---------- Trend ---------- */
export function TrendWidget({ data }: { data: HomeData }) {
  const series = useMemo(
    () => bookSeries(data.txns, data.flows, data.book, 6, data.books),
    [data.txns, data.flows, data.book, data.books],
  )
  return (
    <Card className="p-4 md:p-3">
      <h3 className="mb-2 font-semibold md:mb-1.5 md:text-sm">Spending, last 6 months</h3>
      <SpendBars data={series} height={170} />
    </Card>
  )
}

/* ---------- Upcoming bills ---------- */
export function BillsWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const upcoming = data.bills
    .filter((b) => b.active && daysUntil(b.nextDue) <= 14)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
    .slice(0, 5)
  if (upcoming.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="font-semibold md:text-sm">Coming up</h3>
        <Link to="/bills" className="flex items-center gap-1 text-sm font-medium text-accent">
          All bills <ArrowRight size={13} />
        </Link>
      </div>
      <ul className="divide-y divide-hairline">
        {upcoming.map((b) => {
          const days = daysUntil(b.nextDue)
          return (
            <li key={b.id} className="flex items-center gap-2.5 py-2 md:gap-2 md:py-1">
              <CategoryDot category={b.categoryId ? catMap.get(b.categoryId) : undefined} size={30} className="md:[--dot:24px]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{b.name}</p>
                <p className="text-xs text-ink-3">
                  {days < 0 ? `Overdue — ${fmtFullDate(b.nextDue)}` : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : fmtDay(b.nextDue)}
                </p>
              </div>
              <span className="text-sm font-semibold tabular">{money(b.amountMinor)}</span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ---------- Recent activity ---------- */
/* ---------- What the household owes me ---------- */

/**
 * The other half of migration 13.
 *
 * Ticking "paid for the household" on a row already puts the spending in the
 * right book. This is the consequence nobody was told about: the money is still
 * mine, the household still has it, and until now nothing in the app said so.
 *
 * Deliberately one-sided, and worded that way. My partner's flagged rows are in
 * accounts I am not on, so this can never be a ledger of the two of us without
 * showing each of us the other's private spending — see `reimbursements.ts`.
 * "You" throughout; never "we".
 *
 * Hidden entirely until the mechanism has been used, so a household that never
 * pays for anything out of its own pockets never sees it.
 */
export function ReimbursementWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const [paying, setPaying] = useState(false)
  const s = useMemo(
    () => settlement(data.allTxns, data.flows, data.books),
    [data.allTxns, data.flows, data.books],
  )

  if (s.paidMinor === 0) return null

  const owed = s.outstandingMinor
  return (
    <Card className="p-4 md:p-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="font-semibold md:text-sm">Owed to you</h3>
        <Link to="/activity" className="flex items-center gap-1 text-sm font-medium text-accent">
          Activity <ArrowRight size={13} />
        </Link>
      </div>

      <p className={cx('text-2xl font-bold tracking-tight tabular', owed > 0 && 'text-good-text')}>
        {money(Math.abs(owed))}
      </p>
      <p className="mt-0.5 text-xs text-ink-3">
        {owed > 0
          ? `You have paid ${money(s.paidMinor)} for the household and had ${money(s.returnedMinor)} back.`
          : owed === 0
            ? `Square — all ${money(s.paidMinor)} of it has come back.`
            : /* Reported rather than hidden: it usually means a withdrawal from
                 the joint account was something other than paying you back. */
              'The household has paid you back more than you put in.'}
      </p>

      {s.items.length > 0 && (
        <ul className="mt-2 divide-y divide-hairline">
          {s.items.slice(0, 4).map(({ txn, owedMinor }) => (
            <li key={txn.id} className="flex items-center gap-2 py-2 md:py-1">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{txn.payee}</p>
                <p className="text-xs text-ink-3">{fmtDay(txn.date)}</p>
              </div>
              <span className="text-sm font-semibold tabular">{money(owedMinor)}</span>
            </li>
          ))}
        </ul>
      )}
      {s.items.length > 4 && (
        <p className="mt-1 text-xs text-ink-3">and {s.items.length - 4} more</p>
      )}

      {owed > 0 && (
        <Button size="sm" variant="subtle" className="mt-3 w-full" onClick={() => setPaying(true)}>
          <ArrowLeftRight size={14} /> Pay it back
        </Button>
      )}

      {/* Nothing is "marked settled" — the repayment is an ordinary transfer,
          and the figure above goes to zero because the sum changed. */}
      <PayBack
        open={paying}
        amountMinor={Math.max(owed, 0)}
        data={data}
        onClose={() => setPaying(false)}
      />
    </Card>
  )
}

/**
 * Moving the money back: joint account → one of mine.
 *
 * The same shape as funding a goal, and the same reason for being online-only —
 * `create_transfer` writes two rows and they must land together or not at all.
 * Prefilled with the whole outstanding amount, because paying back all of it is
 * what usually happens; it is an ordinary editable field for when it is not.
 */
function PayBack({
  open,
  amountMinor,
  data,
  onClose,
}: {
  open: boolean
  amountMinor: number
  data: HomeData
  onClose: () => void
}) {
  const { currency, money } = useApp()
  const household = accountsInBook('household', data.books)
  const mine = accountsInBook('mine', data.books)

  const payable = data.allAccounts.filter(
    (a) => household.has(a.id) && canAddTransactions(levelOn(a.id, data.levels)),
  )
  const receivable = data.allAccounts.filter(
    (a) => mine.has(a.id) && canAddTransactions(levelOn(a.id, data.levels)),
  )

  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  // Reset on each opening rather than on mount: the sheet outlives `open` by
  // its exit animation, so it is still rendered when the next open happens.
  useEffect(() => {
    if (!open) return
    setFromId(payable.length === 1 ? payable[0].id : '')
    setToId(receivable.length === 1 ? receivable[0].id : '')
    setAmount(amountMinor ? (amountMinor / 100).toFixed(2) : '')
    setDate(todayISO())
    setError(undefined)
    // `open` alone, on purpose. The account lists are rebuilt every render, so
    // depending on them would wipe what the user has just chosen; `amountMinor`
    // changes the moment a repayment syncs, which would clear the field
    // mid-edit.
  }, [open])

  const minor = parseAmount(amount)
  const canSave = !!fromId && !!toId && fromId !== toId && minor !== null && minor > 0

  async function save() {
    if (!canSave) return
    setBusy(true)
    setError(undefined)
    try {
      await transfer({ fromAccountId: fromId, toAccountId: toId, amountMinor: minor!, date })
      await syncNow()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move the money')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Pay it back"
      footer={
        <Button size="lg" className="w-full" disabled={!canSave || busy} onClick={save}>
          {busy ? 'Moving…' : 'Move money'}
        </Button>
      }
    >
      <div className="space-y-4">
        {(payable.length === 0 || receivable.length === 0) && (
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-2">
            This needs a household account you can post to and one of your own to receive it.
          </p>
        )}
        <Field label="From">
          <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
            <option value="" disabled>
              Choose an account…
            </option>
            {payable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To">
          <Select value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="" disabled>
              Choose an account…
            </option>
            {receivable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Amount (${currencySymbol(currency)})`}>
            <TextInput value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Date">
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        {minor != null && minor > 0 && (
          <p className="text-sm text-ink-3">
            Counts as a withdrawal from the household and takes {money(minor)} off what you are owed.
          </p>
        )}
        {error && <p className="text-sm text-critical-text">{error}</p>}
      </div>
    </Sheet>
  )
}

export function RecentWidget({ data }: { data: HomeData }) {
  const { money } = useApp()
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const recent = useMemo(
    () => [...data.txns].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, 5),
    [data.txns],
  )
  if (recent.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="font-semibold md:text-sm">Recent</h3>
        <Link to="/activity" className="flex items-center gap-1 text-sm font-medium text-accent">
          All activity <ArrowRight size={13} />
        </Link>
      </div>
      <ul className="divide-y divide-hairline">
        {recent.map((t) => (
          <li key={t.id} className="flex items-center gap-2.5 py-2 md:gap-2 md:py-1">
            <CategoryDot category={t.categoryId ? catMap.get(t.categoryId) : undefined} size={30} className="md:[--dot:24px]" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{t.payee}</p>
              <p className="text-xs text-ink-3">{fmtDay(t.date)}</p>
            </div>
            <span className={cx('text-sm font-semibold tabular', t.amountMinor > 0 && 'text-good-text')}>
              {money(t.amountMinor, { sign: t.amountMinor > 0 })}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
