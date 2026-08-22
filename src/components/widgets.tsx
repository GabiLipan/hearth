import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, ChevronLeft, Eye, Flag } from 'lucide-react'
import { getDaysInMonth } from 'date-fns'
import type { Transaction, Category, Budget, Bill, Account, GrantLevel } from '../lib/db'
import { thisMonthKey, monthLabel, monthName, shiftMonth, fmtDay, daysUntil, fmtFullDate, todayISO } from '../lib/dates'
import { monthsEndingAt, monthsOfHistory, OTHER_SLICE_ID } from '../lib/stats'
import {
  accountsInBook,
  bookMonthlySpendByCategory,
  bookOpening,
  bookPosition,
  bookSeries,
  bookSlices,
  bookBridge,
  bookTotals,
  contributionSplit,
  savedInto,
  savingsAccounts,
  hasBreakdown,
  BOOK_WORDS,
  type BalanceGroup,
  type BookId,
  type BookMap,
  type Flow,
  type MonthRule,
} from '../lib/books'
import { spendFlow } from '../lib/sankey'
import { openDrill, type Drill } from '../lib/drill'
import { useMemberMap } from '../lib/cache'
import { TxnName } from './TxnName'
import { nameOf } from './PersonDot'
import { Sankey } from './Sankey'
import { settlement } from '../lib/reimbursements'
import { typicalRange } from '../lib/budgetHistory'
import { accountFace, balanceHistory, balanceOf, canAddTransactions, canSeeTransactionsAt, levelOn } from '../lib/accounts'
import { paintOf } from '../lib/palette'
import { transfer } from '../lib/goals'
import { parseAmount, currencySymbol } from '../lib/money'
import { syncNow } from '../lib/session'
import { useSyncState } from '../hooks/useSync'
import { useApp } from '../state/AppContext'
import { AccountDot, Button, Card, CardHeader, CardHeading, CategoryDot, Field, Fill, Progress, Select, Sheet, TextInput, cx, useInfoNote } from './ui'
import { BudgetBullet } from './BudgetBullet'
import { CategoryIcon } from './CategoryIcon'
import { CategoryBars, CategoryDonut, CategoryMosaic, Sparkline, SpendBars, type TrendShape } from './charts'
import { BooksBridge, PaidIn, type BridgeLine, type PaidInRow } from './insights'

export interface HomeData {
  /**
   * The book's ROW LIST — what a widget that merely lists or balances rows
   * wants. Narrowed by `showsInBook`, so the household book includes the one
   * row type that lives outside its accounts. See Dashboard.
   */
  txns: Transaction[]
  /**
   * Every transaction this device can see, NOT narrowed to the chosen book.
   *
   * **Everything that adds money up wants this**, and handing it `txns` instead
   * is the bug that made this page disagree with Reports. `bookTotals`,
   * `bookSlices`, `bookSeries`, `bookMonthlySpendByCategory` and
   * `contributionSplit` all take `book` and `books` and do their own account
   * selection — and `paid-for-household` is deliberately admitted from OUTSIDE
   * the household's accounts, which a pre-narrowed list makes impossible.
   * Reports passes the whole set to the same functions, which is what makes the
   * two pages agree.
   *
   * `ReimbursementWidget` wants it for a second reason: what it measures
   * genuinely straddles two books — what I paid out of mine and what the
   * household has paid back into it — so narrowing to either would show half
   * the sum.
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
   * friends, over `allTxns` rather than `txns`, because a contribution is not
   * income and not spending and only these know which.
   */
  book: BookId
  books: BookMap
  flows: Map<string, Flow>
  /** When this household's months start — see `MonthRule`. */
  rule: MonthRule
}

/**
 * What every widget on the home page is handed.
 *
 * `variant` and `controls` come from the page's stored arrangement — see
 * `lib/layout.ts`. A widget that offers no choice of shape simply ignores both,
 * which is most of them. The picker is passed in rather than rendered over the
 * card because the corner of a card is already spoken for on most of them: a
 * widget knows where its own heading is, and nothing else does.
 */
export interface WidgetProps {
  data: HomeData
  variant?: string
  /**
   * Everything the widget lets you decide beyond its shape, resolved from the
   * stored arrangement — how many categories, how many months, how far ahead.
   * Values are strings because that is what a stored choice is; a widget that
   * wants a number says `Number(options.count)` at the point of use rather than
   * the layout pretending to know what each option means.
   */
  options?: Record<string, string>
  controls?: ReactNode
}

const month = () => thisMonthKey()

/**
 * Out of a figure on the home page and into the rows behind it.
 *
 * The same vocabulary Reports uses — see `lib/drill.ts` — with one difference:
 * home has no period, no drill and no view to carry, so "back" is just the
 * page. Everything here is about the current month, so the month travels on
 * every drill rather than being left to the reader to infer.
 */
function useHomeDrill(book: BookId) {
  return (extra: Partial<Drill> = {}) =>
    openDrill({ book, month: month(), backTo: '/', backLabel: 'Home', ...extra })
}

/* ---------- Month summary hero ---------- */

/**
 * One figure in the desktop stat strip.
 *
 * `lead` is the card's focal point, and exactly one figure gets it. The strip
 * used to be five equal `text-lg` figures divided by hairlines, which made the
 * most important card on the page the flattest thing on it — while the phone
 * layout, six lines above, leads with a `text-3xl` headline and subordinates
 * everything else. Same hierarchy, both widths.
 *
 * There is no `tone` any more, and its absence is the point. Green and red on
 * `--panel-2` are a dark green and a dark red on a dark blue — the two figures
 * that most need to be read, made the hardest to. The panel says which state
 * the month is in with its own colour, and the words "left" and "over" say it
 * in text; both survive being colour-blind, which the green/red pair never did.
 */
function Stat({ label, value, lead }: { label: string; value: string; lead?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs" style={{ color: 'var(--panel-ink-2)' }}>{label}</p>
      <p className={cx('mt-0.5 truncate font-bold tracking-tight tabular', lead ? 'text-2xl' : 'text-lg')}>
        {value}
      </p>
    </div>
  )
}

/**
 * The month, as the page's one painted surface.
 *
 * Home is opened to learn one thing — how this month is going — and then either
 * closed or used to go looking. So this card stops being the first of nine
 * near-white rectangles and becomes the top of the page: a deep gradient, the
 * figure at `text-4xl`, and everything else on the page left exactly as quiet as
 * it was. The colour is spent once, here, deliberately; a second painted card
 * would leave the page with two focal points, which is none.
 *
 * Three things this has to keep being true, because they were all easy to get
 * wrong:
 *
 *   - **It is not always at the top.** Every card on this page can be dragged,
 *     resized to one column or switched off, so the panel has to read as itself
 *     in a masonry column halfway down. Nothing here assumes its position or its
 *     width — the phone layout stacks, the wide one strips, and both are the
 *     same panel.
 *   - **Every colour comes from `--panel-*`.** The gradient, the quiet ink, the
 *     divider and the bar's track are all tokens defined per theme, so a dark
 *     screen gets deeper stops rather than the light ones glowing on black. No
 *     `text-ink-3`, no `divide-hairline`, no `--accent-ink`: those are ink for a
 *     surface, and this is not one.
 *   - **The state is the panel's colour, not the figure's.** Over budget turns
 *     the whole card oxblood via `data-over`, which is why `Stat` has no tone
 *     and the phone layout's "over"/"left" is plain semibold white.
 */
/**
 * The shapes the month card can take, and why the third is a shape rather than
 * an option on the second.
 *
 * `variants` are supposed to be "what kind of picture" and `options` everything
 * else, and the rule that separates them is whether the choice COMPOSES — every
 * shape of the breakdown can show five categories or twenty, so the count is an
 * option. "Account types: together or separately" does not compose: it means
 * nothing at all to the flow card, and as an option it would sit in the picker
 * under every variant offering a choice that did nothing under one of them.
 *
 * They are also genuinely different pictures. One is a set of figures; the
 * other is a stack of subcards with a composition bar over it.
 */
export const HERO_SHAPES: { value: string; label: string }[] = [
  { value: 'month', label: 'The month' },
  { value: 'balances', label: 'Balances' },
  { value: 'kinds', label: 'By account type' },
]

export function HeroWidget({ data, variant, controls }: WidgetProps) {
  if (variant === 'balances' || variant === 'kinds') {
    return <BalancesHero data={data} byKind={variant === 'kinds'} controls={controls} />
  }
  return <MonthHero data={data} controls={controls} />
}

function MonthHero({ data, controls }: { data: HomeData; controls?: ReactNode }) {
  const { money } = useApp()
  const words = BOOK_WORDS[data.book]
  const totals = useMemo(
    () => bookTotals(data.allTxns, data.flows, data.rule, data.book, month(), data.books),
    [data.allTxns, data.flows, data.rule, data.book, data.books],
  )
  const savedMinor = useMemo(() => {
    const ids = savingsAccounts(data.allAccounts, data.book, data.books)
    return ids.size === 0 ? 0 : savedInto(data.allTxns, data.flows, data.book, data.books, ids, month())
  }, [data.allAccounts, data.allTxns, data.flows, data.rule, data.book, data.books])
  const split = useMemo(
    () => contributionSplit(data.allTxns, data.flows, data.rule, month(), data.books, data.userId),
    [data.allTxns, data.flows, data.rule, data.books, data.userId],
  )
  const boughtDirect = split.minePaidMinor + split.theirsPaidMinor
  /**
   * What was left when the month began, and why the card needs it.
   *
   * A salary that lands on the 23rd is next month's money, and everything
   * bought with it before the month turns is this month's spending — see
   * `bookOpening`. Without the leftover carried in, the card is credited with a
   * whole salary that has already been partly spent, and "left over" matches
   * the bank in neither month.
   *
   * `undefined` on a book holding an account we may only see the total of, and
   * the card silently goes back to printing the month on its own. It is a
   * figure that reconciles or is absent; there is no approximate version.
   */
  const opening = useMemo(
    () =>
      bookOpening(data.allAccounts, data.allTxns, data.flows, data.rule, data.book, data.books, month(), (id) =>
        canSeeTransactionsAt(levelOn(id, data.levels)),
      ),
    // `levels` is a fresh Map every render — the same reason Reports gives for
    // leaving it out: the inputs that change the answer are the accounts and
    // grants it is derived from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.allAccounts, data.allTxns, data.flows, data.rule, data.book, data.books],
  )
  const budgetTotal = data.budgets.reduce((s, b) => s + b.amountMinor, 0)
  const frac = budgetTotal > 0 ? totals.spend / budgetTotal : 0
  const over = frac > 1
  const bar = budgetTotal > 0 && (
    <Progress fraction={frac} tone={over ? 'over' : frac > 0.85 ? 'warn' : 'ok'} on="panel" />
  )
  const quiet = { color: 'var(--panel-ink-2)' }

  /**
   * What this card is about, in order.
   *
   * `lead` is the one figure the page is opened for; `second` is a figure that
   * is not a detail of it and must not be printed as one — on the personal book
   * that is the money moved to the household, which is routinely an order of
   * magnitude larger than what was spent on oneself. Everything else is `rest`,
   * and every one of them gets a cell it fits in.
   */
  const lead = { label: words.spend, value: totals.spend }
  const second =
    data.book === 'mine' && totals.contributed > 0
      ? { label: 'To our household', value: totals.contributed }
      : data.book === 'household' && boughtDirect > 0
        ? { label: 'Of that, bought on personal cards', value: boughtDirect }
        : null
  /**
   * The leftover line, and what it does to the one under it.
   *
   * `words.net` becomes the RUNNING figure — what was left when the month began
   * plus what the month has done since — rather than the month on its own. That
   * is the number the card is read for: it is what the book's accounts hold,
   * less anything already in them for next month. The month-only figure has not
   * been dropped, it has moved into the ⓘ, where it is the arithmetic rather
   * than the answer.
   *
   * With no leftover to be had, both lines fall back to exactly what the card
   * printed before — the same figure, under the same word.
   */
  const carryMinor = opening?.openingMinor ?? 0
  const rest: { label: string; value: number; sign?: boolean }[] = [
    { label: words.income, value: totals.income },
    ...(opening
      ? [{ label: `Left from ${monthName(shiftMonth(month(), -1))}`, value: carryMinor, sign: true }]
      : []),
    ...(savedMinor > 0 ? [{ label: 'To savings', value: savedMinor }] : []),
    { label: words.net, value: carryMinor + totals.net, sign: true },
  ]

  /**
   * Where the running figure comes from, said once.
   *
   * Behind a ⓘ because it is four sentences and the rule is a heading and one
   * line — and because it is the sort of thing you read once, when the word
   * "left" first fails to mean what you assumed, and never again.
   */
  const note = useInfoNote(
    words.net,
    opening ? (
      <>
        <p>
          {money(carryMinor, { sign: true })} was left when {monthLabel(month())} began, and the month has{' '}
          {totals.net < 0 ? 'taken' : 'added'} {money(Math.abs(totals.net))} since — so {words.net.toLowerCase()} is{' '}
          {money(carryMinor + totals.net, { sign: true })}.
        </p>
        <p>
          Money that arrives near the end of a month is counted towards the month it pays for, and spending always
          keeps its own date. Carrying the leftover forward is what stops a salary looking unspent on the day it
          arrives, and it is why this figure matches what the accounts actually hold.
        </p>
        {opening.laterMinor > 0 && (
          <p>
            {money(opening.laterMinor)} of what is in the accounts is already{' '}
            {monthName(shiftMonth(month(), 1))}'s, and is not counted here.
          </p>
        )}
      </>
    ) : undefined,
    'panel',
  )

  return (
    <Card className={cx('panel-month p-4 md:p-3.5', over && 'panel-over')}>
      {/*
        Phone: a headline, then the rest in a grid that cannot truncate.

        It used to be a flex row — the big figure on the left, and on the right
        a `min-w-36` box holding "Money in" and "Net" as two truncating spans
        above the bar. At 390px those two had about 70px each, so the page
        shipped reading "Money in £1,50…" and "Net −£3,135…": two figures
        rendered as ellipsis, which is worse than not printing them.

        A figure is either worth the room to be read or it is not on the card.
        So each one gets a cell of its own, and the grid wraps rather than
        shrinking anything.
      */}
      <div className="md:hidden">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-sm" style={quiet}>
            {monthLabel(month())} · {lead.label.toLowerCase()}
          </p>
          {note.toggle}
          {controls}
        </div>
        <p className="mt-0.5 text-4xl font-bold tracking-tight tabular">{money(lead.value)}</p>

        {/*
          On the personal book the second figure is not a detail of the first.
          £156 spent on myself beside £2,909 moved to the household is a card
          whose headline is the smaller number by a factor of nineteen, and the
          bigger one was a grey sub-line under it. It gets its own figure, at a
          size that says so.
        */}
        {second && (
          <div className="mt-2.5 border-t pt-2.5" style={{ borderColor: 'var(--panel-line)' }}>
            <p className="text-sm" style={quiet}>{second.label}</p>
            <p className="mt-0.5 text-2xl font-bold tracking-tight tabular">{money(second.value)}</p>
          </div>
        )}

        {budgetTotal > 0 && (
          <>
            <p className="mt-2 text-sm" style={quiet}>
              of {money(budgetTotal, { hideDecimals: true })}
              <span className="font-semibold" style={{ color: 'var(--panel-ink)' }}>
                {' · '}
                {over
                  ? `${money(totals.spend - budgetTotal)} over`
                  : `${money(budgetTotal - totals.spend)} left`}
              </span>
            </p>
            <div className="mt-2">{bar}</div>
          </>
        )}

        {rest.length > 0 && (
          <dl
            className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t pt-3"
            style={{ borderColor: 'var(--panel-line)' }}
          >
            {rest.map((f) => (
              <div key={f.label} className="min-w-0">
                <dt className="text-xs" style={quiet}>{f.label}</dt>
                <dd className="mt-0.5 text-lg font-semibold tracking-tight tabular">
                  {money(f.value, { sign: f.sign })}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {/* Desktop: a strip of figures across the full width. */}
      <div className="hidden md:block">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xs" style={quiet}>{monthLabel(month())}</p>
          {note.toggle}
          {controls}
        </div>
        {/*
          A wrapping grid, not a row of figures divided by hairlines.

          It was `flex flex-nowrap` with a `border-l` between each, which is a
          better-looking strip and only while every figure fits. This card can
          carry seven — spending, income, to the household, to savings, the
          leftover, what is left, the budget — and every one of them is
          `truncate`, so at one column on a laptop the panel shipped reading
          "£4,0…" and "+£10,…". That is the same fault the phone layout has a
          paragraph about: a figure is either worth the room to be read or it is
          not on the card.

          The rules go rather than the figures, because a `border-l` cannot
          survive wrapping — the first cell of the second row wears a divider
          with nothing to its left. Whitespace separates them instead, which is
          what the phone layout has always done.
        */}
        <div className="mt-1 grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] items-start gap-x-5 gap-y-3">
          <Stat label={words.spend} value={money(totals.spend)} lead />
          <Stat label={words.income} value={money(totals.income)} />
          {data.book === 'mine' && totals.contributed > 0 && (
            <Stat label="To household" value={money(totals.contributed)} />
          )}
          {savedMinor > 0 && <Stat label="To savings" value={money(savedMinor)} />}
          {/* Before the figure it feeds, so the strip reads left to right as
              the sum it is: what was left, what came in, what went out, what is
              left now. */}
          {opening && (
            <Stat
              label={`From ${monthName(shiftMonth(month(), -1))}`}
              value={money(carryMinor, { sign: true })}
            />
          )}
          <Stat label={words.net} value={money(carryMinor + totals.net, { sign: true })} />
          {budgetTotal > 0 && <Stat label="Budgeted" value={money(budgetTotal, { hideDecimals: true })} />}
        </div>
        {budgetTotal > 0 && <div className="mt-2.5">{bar}</div>}
      </div>

      {/* Once, at the foot of the card, rather than inside either width. Both
          layouts are rendered and one is hidden — see the `FilterBar`/`Toolbar`
          note in CLAUDE.md — so a body in each would put the same `id` in the
          document twice and break the `aria-controls` pointing at it. The
          toggle is duplicated safely; `display: none` keeps the hidden one out
          of the accessibility tree. */}
      {note.body && <div className="mt-3">{note.body}</div>}
    </Card>
  )
}

/* ---------- The month as a set of balances ---------- */

/**
 * One figure in the flow strip: an icon, a word, an amount.
 *
 * A subcard on `--panel-track` rather than a bare column of text, because four
 * figures in a row on a painted surface need something to sit ON or they read
 * as a caption that happens to have numbers in it. The track is the panel's own
 * translucent wash — the same fill `Progress` uses for its trough — so the
 * gradient still shows through and the card stays one object rather than five.
 */
function FlowTile({
  icon,
  label,
  value,
  wide,
}: { icon: ReactNode; label: string; value: string; wide?: boolean }) {
  return (
    <div
      className={cx('min-w-0 rounded-xl px-3 py-2.5', wide && 'col-span-2 md:col-span-1')}
      style={{ background: 'var(--panel-track)' }}
    >
      <div className="flex items-center gap-1.5" style={{ color: 'var(--panel-ink-2)' }}>
        {icon}
        <p className="min-w-0 truncate text-xs">{label}</p>
      </div>
      <p className="mt-1 truncate text-lg font-bold tracking-tight tabular">{value}</p>
    </div>
  )
}

/**
 * How the money divides across the kinds of account, as one bar.
 *
 * Segments are white at four strengths rather than four palette colours, and
 * that is the panel's rule rather than a shortage of ideas: `--series-1` is a
 * blue, the panel is a blue gradient, and a legend of surface colours on a
 * painted card is the one thing `.panel-month` says not to do. Strength carries
 * the order instead — the largest holding is the brightest — and the legend
 * under it repeats the same four values, so the bar is readable without colour
 * vision at all.
 *
 * ONLY the groups holding something positive. A credit card in debt is not a
 * share of what you hold, and folding a negative into a proportion bar produces
 * either a segment of negative width or a total nobody can reconcile against
 * the figures beside it. It keeps its subcard and its real figure; the ⓘ says
 * it is not in the bar.
 */
function CompositionBar({ parts }: { parts: { label: string; value: number }[] }) {
  // Sorted, because the strength ramp is the only thing carrying the order and
  // a bright sliver beside a faint half is a legend nobody can use.
  const shown = parts.filter((p) => p.value > 0).sort((a, b) => b.value - a.value)
  const total = shown.reduce((s, p) => s + p.value, 0)
  if (total <= 0 || shown.length < 2) return null
  // Far enough apart to be told apart on the panel's own gradient. The first
  // pair was 1 and 0.66, which at a 69/30 split read as one bar that changed
  // shade half way rather than as two holdings.
  const strength = [1, 0.52, 0.3, 0.18]
  return (
    <div>
      <div
        className="flex h-3 w-full gap-1 overflow-hidden rounded-full md:h-2.5"
        style={{ background: 'var(--panel-track)' }}
      >
        {shown.map((p, i) => (
          <div
            key={p.label}
            className="h-full rounded-full transition-[width] duration-500"
            style={{
              width: `${(p.value / total) * 100}%`,
              background: `rgba(255, 255, 255, ${strength[i] ?? 0.2})`,
            }}
          />
        ))}
      </div>
      {/* The share in words as well as in width. Four strengths of white on a
          gradient can be told apart and cannot be MEASURED by eye, and the
          smallest holding is routinely a segment too thin to see at all — a
          legend that only names it leaves that entry explaining nothing. */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {shown.map((p, i) => {
          const pct = (p.value / total) * 100
          return (
            <span key={p.label} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--panel-ink-2)' }}>
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: `rgba(255, 255, 255, ${strength[i] ?? 0.18})` }}
              />
              {p.label}
              <span className="font-semibold tabular" style={{ color: 'var(--panel-ink)' }}>
                {pct < 1 ? '<1%' : `${Math.round(pct)}%`}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** One account type, as a subcard: what it holds, and what the month did to it. */
function KindCard({ group, money }: { group: BalanceGroup; money: (m: number, o?: { sign?: boolean }) => string }) {
  const line = [
    { label: 'On the 1st', value: group.openingMinor, sign: true },
    ...(group.inMinor > 0 ? [{ label: 'In', value: group.inMinor, sign: false }] : []),
    ...(group.outMinor > 0 ? [{ label: 'Out', value: group.outMinor, sign: false }] : []),
    ...(group.movedMinor !== 0 ? [{ label: 'Moved', value: group.movedMinor, sign: true }] : []),
  ]
  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--panel-track)' }}>
      <div className="flex items-baseline gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {/* The same icon `accountFace` derives from `kind`, so a subcard is
              headed by the picture on every badge inside it. */}
          <CategoryIcon icon={group.icon} size={16} />
          <span className="min-w-0 truncate text-sm font-semibold">{group.label}</span>
          <span className="shrink-0 text-xs" style={{ color: 'var(--panel-ink-2)' }}>
            {group.accountCount}
          </span>
        </span>
        <span className="shrink-0 text-lg font-bold tracking-tight tabular">{money(group.nowMinor)}</span>
      </div>
      {/* `dt`/`dd` must be children of the `dl` or of a `div` inside it —
          wrapping each pair in a span is invalid and drops the association. */}
      <dl className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs" style={{ color: 'var(--panel-ink-2)' }}>
        {line.map((f) => (
          <div key={f.label} className="whitespace-nowrap">
            <dt className="inline">{f.label} </dt>
            <dd className="ml-0 inline font-medium tabular" style={{ color: 'var(--panel-ink)' }}>
              {money(f.value, { sign: f.sign })}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * The month as a set of BALANCES rather than as a set of flows.
 *
 * The default hero answers "how is the month going" — what was earned, what was
 * spent, what is left over. This answers the other question people open a
 * finance app for, which is "where is my money", and the two need different
 * arithmetic rather than a different arrangement of the same figures. See
 * `bookPosition` for what is counted where, and for the identity that lets the
 * account types be added up:
 *
 *     on the 1st + in − out + moved + next month's === what is held now
 *
 * The starting figure EXCLUDES money that arrived this month, including a
 * salary that landed before the month turned — which is the whole reason it is
 * `bookOpening`'s arithmetic and not the bank's own 1st-of-the-month balance.
 * Printing the literal one beside this month's income would count that salary
 * twice, and the card would disagree with the banking app by exactly it.
 *
 * Undefined on a book holding an account this device may only see the total of.
 * There is no approximate version — the figures either reconcile or they are
 * not worth printing — so the card says why and stops.
 */
function BalancesHero({ data, byKind, controls }: { data: HomeData; byKind: boolean; controls?: ReactNode }) {
  const { money } = useApp()
  const pos = useMemo(
    () =>
      bookPosition(data.allAccounts, data.allTxns, data.flows, data.rule, data.book, data.books, month(), (id) =>
        canSeeTransactionsAt(levelOn(id, data.levels)),
      ),
    // `levels` is a fresh Map every render — see `HeroWidget`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.allAccounts, data.allTxns, data.flows, data.rule, data.book, data.books],
  )

  const savings = pos?.byKind.find((g) => g.key === 'savings')
  const total = pos?.total
  const quiet = { color: 'var(--panel-ink-2)' }

  /**
   * The month as three or four movements.
   *
   * "Moved" appears only where money actually went somewhere else, because a
   * permanent "Moved £0" is a cell spent saying nothing happened — and on the
   * household book the commonest case is exactly that, since a transfer to the
   * joint savings account nets to nothing across the book it is inside.
   */
  const tiles = total
    ? [
        { icon: <Flag size={13} />, label: 'On the 1st', value: money(total.openingMinor, { sign: true }) },
        { icon: <ArrowDownLeft size={13} />, label: 'In', value: money(total.inMinor) },
        { icon: <ArrowUpRight size={13} />, label: 'Out', value: money(total.outMinor) },
        ...(total.movedMinor !== 0
          ? [{ icon: <ArrowLeftRight size={13} />, label: 'Moved', value: money(total.movedMinor, { sign: true }) }]
          : []),
      ]
    : []

  const note = useInfoNote(
    'Balances',
    total ? (
      <>
        <p>
          {money(total.openingMinor, { sign: true })} on the 1st, {money(total.inMinor)} in and{' '}
          {money(total.outMinor)} out
          {total.movedMinor !== 0 && <>, {money(Math.abs(total.movedMinor))} moved {total.movedMinor < 0 ? 'out to' : 'in from'} accounts elsewhere</>}
          {' '}— which is {money(total.nowMinor)} now.
        </p>
        <p>
          The starting figure leaves out money that arrived FOR this month, including a salary that landed before the
          month turned. That is what makes it add up: counting it in both would credit the same money twice.
        </p>
        {total.laterMinor > 0 && (
          <p>
            {money(total.laterMinor)} of what is in the accounts is already{' '}
            {monthName(shiftMonth(month(), 1))}&apos;s, so it is in the balance and not in these figures.
          </p>
        )}
        {byKind && (
          <p>
            The bar shows only what is being held. An account in debt keeps its own figure below and is not a share of
            anything.
          </p>
        )}
      </>
    ) : undefined,
    'panel',
  )

  return (
    <Card className="panel-month p-4 md:p-3.5">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm md:text-xs" style={quiet}>
          {monthLabel(month())} · in {data.book === 'mine' ? 'my accounts' : 'the accounts'}
        </p>
        {note.toggle}
        {controls}
      </div>

      {!total ? (
        /* The same refusal `bookBalances` makes, and for the same reason: a
           `balance`-level account gives today's total and no line items, so
           there is no winding it back to the 1st — and leaving it out would
           make "now" and "the 1st" measure different sets of accounts. */
        <p className="mt-2 text-sm" style={quiet}>
          One account here is one you can only see the total of, so there is no way to say what these accounts held on
          the 1st. The month summary works without it.
        </p>
      ) : (
        <>
          <p className="mt-0.5 text-4xl font-bold tracking-tight tabular md:text-3xl">{money(total.nowMinor)}</p>

          {byKind ? (
            <div className="mt-3">
              <CompositionBar parts={pos.byKind.map((g) => ({ label: g.label, value: g.nowMinor }))} />
            </div>
          ) : (
            savings &&
            savings.nowMinor > 0 &&
            total.nowMinor > 0 && (
              <div className="mt-3">
                <Progress fraction={savings.nowMinor / total.nowMinor} tone="ok" on="panel" />
                <p className="mt-2 text-xs" style={quiet}>
                  <span className="font-semibold" style={{ color: 'var(--panel-ink)' }}>
                    {money(savings.nowMinor)}
                  </span>{' '}
                  of it in savings
                </p>
              </div>
            )
          )}

          {/*
            The figures the card exists for, in the order they happen.

            Two per row on a phone, whatever the count. Three across 390px is
            three truncated figures — "On the…" over "+£8,…" — which is the
            fault the strip on the other variant has a paragraph about, and a
            tile is narrower than a stat because it carries padding of its own.
            An odd one out takes the full row rather than leaving a hole beside
            it; above `md` there is room for the lot in one line.
          */}
          <div className={cx('mt-3 grid grid-cols-2 gap-2', tiles.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-4')}>
            {tiles.map((t, i) => (
              <FlowTile
                key={t.label}
                icon={t.icon}
                label={t.label}
                value={t.value}
                wide={tiles.length % 2 === 1 && i === tiles.length - 1}
              />
            ))}
          </div>

          {/* Said out loud rather than left in the ⓘ. The four tiles do not add
              up to the figure above them by exactly this much, and a reader who
              tries the arithmetic and fails will trust neither. */}
          {total.laterMinor > 0 && (
            <p className="mt-2 text-xs" style={quiet}>
              <span className="font-semibold" style={{ color: 'var(--panel-ink)' }}>
                {money(total.laterMinor)}
              </span>{' '}
              of that is {monthName(shiftMonth(month(), 1))}&apos;s money, already in the account
            </p>
          )}

          {byKind && (
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {pos.byKind.map((g) => (
                <KindCard key={g.key} group={g} money={money} />
              ))}
            </div>
          )}
        </>
      )}

      {note.body && <div className="mt-3">{note.body}</div>}
    </Card>
  )
}

/* ---------- Budgets at a glance ---------- */
export function BudgetGlanceWidget({ data }: WidgetProps) {
  const { money } = useApp()
  const now = new Date()
  const paceFrac = now.getDate() / getDaysInMonth(now)
  // Six months, so the bullet can say what "normal" looks like for a category.
  // This also aligns the widget with the Budgets page, which rolls subcategory
  // spending up to the parent and excludes transfers — the hand-rolled loop
  // that used to live here did neither, so the two pages disagreed.
  const months = useMemo(() => monthsEndingAt(month(), 6), [])
  // `bookMonthlySpendByCategory`, not `monthlySpendByCategory`: the latter is
  // flow-blind, so on the household book it missed the shopping bought off a
  // personal card that the figure above this card has already counted, and on
  // the personal book it counted that same row as spending when the book files
  // it as a contribution. Same selection rule as the Budgets page.
  const history = useMemo(
    () => bookMonthlySpendByCategory(data.allTxns, data.flows, data.rule, data.categories, data.book, data.books, months),
    [data.allTxns, data.flows, data.rule, data.categories, data.book, data.books, months],
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
      <CardHeader
        title="Budgets"
        action={
          <p className="shrink-0 text-sm text-ink-2 tabular">
            <span className="font-semibold text-ink">{money(totalSpent, { compact: true })}</span> of{' '}
            {money(totalBudget, { compact: true, hideDecimals: true })}
          </p>
        }
      />
      {/* This widget spans the full page width, so on a wide screen the rows
          split into columns — a bar 1,000px long is harder to read, not easier. */}
      <ul className="grid gap-2.5 md:gap-x-6 md:gap-y-1.5 lg:grid-cols-2 min-[1800px]:grid-cols-3">
        {rows.map(({ cat, budget, spent: catSpent, typical }) => {
          const over = catSpent > budget
          return (
            <li key={cat.id} className="flex items-center gap-2.5 md:gap-2">
              <span className="grid w-5 shrink-0 place-items-center" style={{ color: paintOf(cat.slot, cat.color) }} aria-hidden>
                <CategoryIcon icon={cat.icon} size={15} />
              </span>
              <span className="w-24 truncate text-sm text-ink-2 sm:w-32">{cat.name}</span>
              <BudgetBullet
                className="flex-1"
                spent={catSpent}
                budget={budget}
                typical={typical}
                pace={paceFrac}
                color={paintOf(cat.slot, cat.color)}
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
/** How much history the sparkline beside each balance covers. */
const SPARK_DAYS = 30

/**
 * The column every account's line is drawn in.
 *
 * Stated once because an account with nothing to draw has to hold the same
 * column open — a row that simply omitted it ended its balance where the other
 * rows ended their lines.
 */
const SPARK_BOX = 'h-5 w-12 shrink-0 sm:w-14'

export function AccountsWidget({ data }: WidgetProps) {
  const { money } = useApp()
  const balance = (a: Account) => balanceOf(a, data.txns, data.remoteBalances, levelOn(a.id, data.levels))
  const total = data.accounts.reduce((s, a) => s + balance(a), 0)
  if (data.accounts.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <CardHeader title="Accounts" action={<span className="text-sm font-semibold tabular">{money(total)}</span>} />
      <ul className="divide-y divide-hairline">
        {data.accounts.map((a) => {
          const level = levelOn(a.id, data.levels)
          const bal = balance(a)
          const face = accountFace(a)
          // No line at `balance` level: there are no rows to draw one from, and
          // a flat line would be a claim about a month nobody here can see.
          const spark = canSeeTransactionsAt(level)
            ? balanceHistory(a.id, data.txns, bal, SPARK_DAYS)
            : undefined
          return (
            <li key={a.id} className="flex items-center gap-2.5 py-2 md:gap-2 md:py-1.5">
              {/* The account's own colour and icon — `accountFace`, so an
                  account nobody has styled still gets the one its kind
                  implies. A rounded square, where a category is a circle. */}
              <AccountDot account={a} size={30} className="md:[--dot:26px]" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {a.name}
                {/* The eye means "you can see what is in it, not what it was
                    spent on" — the one tier where the total on the right comes
                    from the server rather than from rows this device holds. */}
                {!canSeeTransactionsAt(level) && <Eye size={12} className="ml-1.5 inline text-ink-3" />}
              </span>
              {/* Figure first, line last, and the line is the only thing at
                  the end of the row — which is what makes both of them line up
                  down the card. Between the name and the balance the line's
                  left edge was wherever that row's balance happened to start,
                  so £28 and £3,769.53 put their sparklines an inch apart and
                  the shapes could not be read against each other. Right-aligned
                  against a fixed column, the figures end on one line and the
                  lines all start and end on two more. */}
              <span className={cx('shrink-0 text-right text-sm font-semibold tabular', bal < 0 && 'text-critical-text')}>
                {money(bal)}
              </span>
              {/* An account seen at `balance` level has no line to draw, and an
                  absent one must not pull that row's figure out to the edge —
                  so the column is held open either way. */}
              {spark ? (
                <Sparkline
                  values={spark}
                  color={paintOf(face.slot, face.color)}
                  className={cx(SPARK_BOX, 'opacity-70')}
                  label={`${a.name}: the last ${SPARK_DAYS} days`}
                />
              ) : (
                <span aria-hidden className={SPARK_BOX} />
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ---------- Where it went ---------- */
export function DonutWidget({ data, variant, options, controls }: WidgetProps) {
  const { money } = useApp()
  /** The category being looked inside, or null for the top level. */
  const [drill, setDrill] = useState<string | null>(null)

  const count = Number(options?.count ?? 6)
  const slices = useMemo(
    () => bookSlices(data.allTxns, data.flows, data.rule, data.categories, data.book, month(), data.books, drill ?? undefined, count),
    [data.allTxns, data.flows, data.rule, data.categories, data.book, data.books, drill, count],
  )
  // Changing book empties the breadcrumb: it would otherwise point at a
  // category that is no longer on this screen.
  useEffect(() => setDrill(null), [data.book])

  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const canDrill = (categoryId: string) =>
    categoryId !== OTHER_SLICE_ID &&
    hasBreakdown(categoryId, data.allTxns, data.flows, data.rule, data.categories, data.book, month(), data.books)

  /**
   * Deeper while there is a deeper, and the transactions when there is not —
   * the same rule Reports gives the same gesture.
   */
  const openRows = useHomeDrill(data.book)
  const pickSlice = (slice: { categoryId: string }) => {
    if (!drill && canDrill(slice.categoryId)) return setDrill(slice.categoryId)
    if (slice.categoryId === OTHER_SLICE_ID) return openRows()
    openRows({ category: slice.categoryId })
  }

  const spent = slices.reduce((s, x) => s + x.totalMinor, 0)
  if (slices.length === 0 && !drill) return null

  return (
    <Card className="p-4 md:p-3">
      <div className="mb-2 flex items-center gap-1 md:mb-1.5">
        <h3 className="flex min-w-0 flex-1 items-center gap-1 font-semibold md:text-sm">
          {drill && (
            <button
              type="button"
              onClick={() => setDrill(null)}
              className="flex items-center gap-0.5 rounded-full px-1 py-0.5 text-ink-3 transition hover:bg-surface-2 hover:text-ink"
            >
              <ChevronLeft size={14} /> All
            </button>
          )}
          <span className="truncate">{drill ? (catMap.get(drill)?.name ?? 'Category') : 'Where it went'}</span>
        </h3>
        {controls}
      </div>
      {variant === 'bars' || variant === 'mosaic' ? (
        <>
          <p className="mb-2 text-sm text-ink-2">
            <span className="font-semibold tabular">{money(spent)}</span>{' '}
            <span className="text-ink-3">{drill ? 'in here' : 'spent'}</span>
          </p>
          {variant === 'mosaic' ? (
            /* A little taller than the ring's 180: the blocks are the full
               width of the card, so height is what decides how many of them can
               carry a legible name rather than falling back to a chip. */
            <Fill min={190}>
              {(height) => <CategoryMosaic slices={slices} height={height} onPick={pickSlice} />}
            </Fill>
          ) : (
            <CategoryBars slices={slices} onPick={pickSlice} />
          )}
        </>
      ) : (
        <Fill min={180}>
          {(height) => (
            <CategoryDonut
              slices={slices}
              height={height}
              onPick={pickSlice}
              pickLabel={(s) => (!drill && canDrill(s.categoryId) ? 'Look inside' : 'See transactions')}
              centerLabel={{ title: drill ? 'in here' : 'spent', value: money(spent, { compact: true }) }}
            />
          )}
        </Fill>
      )}
      {/* The donut itself is not clickable, so the way in is a row of buttons
          under it — the same arrangement Reports uses, and the same reasons:
          a keyboard path, and a target big enough for a thumb. The blocks need
          neither: each one is a real button, in reading order, and the ones too
          small to press carry their own chip. */}
      {!drill && variant !== 'mosaic' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {slices.filter((s) => canDrill(s.categoryId)).map((s) => (
            <button
              type="button"
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

export function TrendWidget({ data, variant, options, controls }: WidgetProps) {
  // The window is what the card was asked for; the series is everything there
  // is, so the chart has something to scroll back to. A household three months
  // old gets three bars rather than three bars and thirty-three empty ones.
  // Not named `window`: a local of that name shadows the global for the whole
  // function, which is the same trap `CategoryIcon` aliases `Map` around.
  const across = Number(options?.months ?? 6)
  const openRows = useHomeDrill(data.book)
  const months = useMemo(() => monthsOfHistory(data.txns), [data.txns])
  const series = useMemo(
    () => bookSeries(data.allTxns, data.flows, data.rule, data.book, months, data.books),
    [data.allTxns, data.flows, data.rule, data.book, months, data.books],
  )
  return (
    <Card className="p-4 md:p-3">
      <div className="mb-2 flex items-center gap-1 md:mb-1.5">
        <h3 className="min-w-0 flex-1 truncate font-semibold md:text-sm">
          Spending, last {Math.min(across, months)} months
        </h3>
        {controls}
      </div>
      <Fill min={170}>
        {(height) => (
          <SpendBars
            data={series}
            height={height}
            visible={across}
            shape={(variant as TrendShape) ?? 'bars'}
            onPickMonth={(m) => openRows({ month: m })}
          />
        )}
      </Fill>
      {months > across && (
        <p className="mt-1 text-xs text-ink-3">Scroll the chart back for earlier months.</p>
      )}
    </Card>
  )
}

/* ---------- The month as one path ---------- */

/**
 * Where the money came from and what it became, in one picture.
 *
 * Off by default. It is the widest thing on the page and it says something the
 * hero and the donut between them already say in figures — so it earns its
 * place by being asked for, rather than by turning up on everyone's home page
 * on the strength of being new.
 */
export function FlowWidget({ data, options, controls }: WidgetProps) {
  const memberMap = useMemberMap()
  // `allTxns` throughout, and `split` below already used it: with the totals
  // taken from a list narrowed by account, `spendFlow` clamped the "You put in"
  // band against a contributions figure that was missing everything bought off
  // a personal card, and said nothing about having done so.
  const totals = useMemo(
    () => bookTotals(data.allTxns, data.flows, data.rule, data.book, month(), data.books),
    [data.allTxns, data.flows, data.rule, data.book, data.books],
  )
  const count = Number(options?.count ?? 8)
  const slices = useMemo(
    () => bookSlices(data.allTxns, data.flows, data.rule, data.categories, data.book, month(), data.books, undefined, count),
    [data.allTxns, data.flows, data.rule, data.categories, data.book, data.books, count],
  )
  const split = useMemo(
    () => contributionSplit(data.allTxns, data.flows, data.rule, month(), data.books, data.userId),
    [data.allTxns, data.flows, data.rule, data.books, data.userId],
  )
  const partner = useMemo(() => {
    const others = [...memberMap.values()].filter((m) => m.userId !== data.userId)
    return others.length === 1 ? nameOf(others[0]) : undefined
  }, [memberMap, data.userId])

  // Of what is left over, how much was put by rather than merely left. See
  // `savedInto`: it changes no total, it splits the band that was already there.
  const savedMinor = useMemo(() => {
    const ids = savingsAccounts(data.allAccounts, data.book, data.books)
    return ids.size === 0 ? 0 : savedInto(data.allTxns, data.flows, data.book, data.books, ids, month())
  }, [data.allAccounts, data.allTxns, data.flows, data.rule, data.book, data.books])

  const graph = useMemo(
    () => spendFlow({ book: data.book, totals, slices, split, partner, savedMinor }),
    [data.book, totals, slices, split, partner, savedMinor],
  )
  const openRows = useHomeDrill(data.book)
  if (graph.totalMinor === 0) return null

  return (
    <Card className="p-4 md:p-3">
      <div className="mb-2 flex items-center gap-1 md:mb-1.5">
        <h3 className="min-w-0 flex-1 truncate font-semibold md:text-sm">{monthLabel(month())} · where it flowed</h3>
        {controls}
      </div>
      {/* Only the category bands lead anywhere — the left-hand side is income
          and contributions, which are not a category filter. */}
      <Sankey
        graph={graph}
        canPick={(n) => n.id.startsWith('cat:')}
        onPick={(n) => openRows({ category: n.id.slice(4) })}
      />
    </Card>
  )
}

/* ---------- Upcoming bills ---------- */
export function BillsWidget({ data, options }: WidgetProps) {
  const { money } = useApp()
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const ahead = Number(options?.ahead ?? 14)
  const upcoming = data.bills
    .filter((b) => b.active && daysUntil(b.nextDue) <= ahead)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
    // Still capped: "the next two months" is a horizon, not an instruction to
    // fill the home page with thirty rows.
    .slice(0, ahead > 30 ? 10 : 5)
  if (upcoming.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <CardHeader
        title="Coming up"
        action={
          <Link to="/bills" className="flex shrink-0 items-center gap-1 text-sm font-medium text-accent">
            All bills <ArrowRight size={13} />
          </Link>
        }
      />
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
export function ReimbursementWidget({ data }: WidgetProps) {
  const { money } = useApp()
  const [paying, setPaying] = useState(false)
  const s = useMemo(
    () => settlement(data.allTxns, data.flows, data.books),
    [data.allTxns, data.flows, data.rule, data.books],
  )

  if (s.paidMinor === 0) return null

  const owed = s.outstandingMinor
  return (
    <>
      <Card className="p-4 md:p-3">
        <CardHeader
          title="Owed to you"
          action={
            <Link to="/activity" className="flex shrink-0 items-center gap-1 text-sm font-medium text-accent">
              Activity <ArrowRight size={13} />
            </Link>
          }
        />

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
                  <p className="flex min-w-0 text-sm font-medium">
                    <TxnName txn={txn} />
                  </p>
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
      </Card>

      {/* Outside the Card on purpose, the way Goals renders FundGoal. A Sheet
          is `position: fixed`, and burying one inside a widget puts it under
          every ancestor that could ever become a containing block for it — a
          transform on a card, the clip on `main`. Nothing does today, and
          nothing should have to keep not doing it.

          Nothing is "marked settled" here: the repayment is an ordinary
          transfer, and the figure above goes to zero because the sum changed. */}
      <PayBack
        open={paying}
        amountMinor={Math.max(owed, 0)}
        data={data}
        onClose={() => setPaying(false)}
      />
    </>
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
  const { online } = useSyncState()
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
  // `online` is part of it, as in Goals: `create_transfer` writes two legs and
  // they must land together or not at all, so there is nothing sensible for the
  // outbox to queue. Said up front rather than as a failure after the press.
  const canSave = !!fromId && !!toId && fromId !== toId && minor !== null && minor > 0 && online

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
        {!online && (
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-2">
            Moving money needs a connection — both halves have to be recorded together, so this one
            can't be queued.
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

export function RecentWidget({ data, options }: WidgetProps) {
  const { money } = useApp()
  const catMap = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const rows = Number(options?.rows ?? 5)
  const recent = useMemo(
    () => [...data.txns].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, rows),
    [data.txns, rows],
  )
  if (recent.length === 0) return null
  return (
    <Card className="p-4 md:p-3">
      <CardHeader
        title="Recent"
        action={
          <Link to="/activity" className="flex shrink-0 items-center gap-1 text-sm font-medium text-accent">
            All activity <ArrowRight size={13} />
          </Link>
        }
      />
      <ul className="divide-y divide-hairline">
        {recent.map((t) => (
          <li key={t.id} className="flex items-center gap-2.5 py-2 md:gap-2 md:py-1">
            <CategoryDot category={t.categoryId ? catMap.get(t.categoryId) : undefined} size={30} className="md:[--dot:24px]" />
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 text-sm font-medium">
                <TxnName txn={t} />
              </p>
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

/* ---------- Who paid in ---------- */

/**
 * What each of us put into the household this month, and how.
 *
 * Household book only. It is meaningless anywhere else, and it is the one
 * figure this whole model makes newly possible: neither of us can see the
 * other's salary, but every contribution ARRIVES in a joint account and joint
 * accounts are readable by both.
 *
 * The same card Reports carries, over the same `contributionSplit`, so the two
 * pages cannot come to different answers about who paid what.
 */
export function PaidInWidget({ data, variant, controls }: WidgetProps) {
  const { money } = useApp()
  const memberMap = useMemberMap()
  const openRows = useHomeDrill(data.book)
  const split = useMemo(
    () => contributionSplit(data.allTxns, data.flows, data.rule, month(), data.books, data.userId),
    [data.allTxns, data.flows, data.rule, data.books, data.userId],
  )
  const totals = useMemo(
    () => bookTotals(data.allTxns, data.flows, data.rule, data.book, month(), data.books),
    [data.allTxns, data.flows, data.rule, data.book, data.books],
  )
  const partner = useMemo(() => {
    const others = [...memberMap.values()].filter((m) => m.userId !== data.userId)
    return others.length === 1 ? nameOf(others[0]) : undefined
  }, [memberMap, data.userId])

  const rows = useMemo<PaidInRow[]>(
    () =>
      [
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
          name: 'Not sure by whom',
          movedMinor: split.unattributedMinor,
          boughtMinor: 0,
          count: 0,
          slot: 0,
          muted: true,
        },
        { key: 'external', name: 'Other income', movedMinor: split.externalMinor, boughtMinor: 0, count: 0, slot: 0, muted: true },
      ].filter((r) => r.movedMinor + r.boughtMinor > 0),
    [split, partner],
  )

  const boughtDirect = split.minePaidMinor + split.theirsPaidMinor
  if (data.book !== 'household' || rows.length === 0) return null

  return (
    <Card className="p-4 md:p-3">
      <CardHeading
        title="Who paid in"
        controls={controls}
        info={
          <>
            <p>
              Money reaches the household two ways: it is moved into a joint account, or something is bought for us
              straight off somebody&rsquo;s own card. Both are putting money in.
            </p>
            <p>
              An arrival nobody has linked cannot be put on a name — a credit on its own cannot say who sent it — so
              it waits under &ldquo;not sure by whom&rdquo; until somebody says.
            </p>
          </>
        }
      />
      <PaidIn rows={rows} totalMinor={totals.income} shape={variant} onPick={() => openRows()} />
      {boughtDirect > 0 && (
        <p className="mt-2.5 text-xs text-ink-2">
          <span className="font-semibold tabular">{money(boughtDirect)}</span> of this month&rsquo;s household spending
          was bought straight from personal cards.
        </p>
      )}
    </Card>
  )
}

/* ---------- How the books add up ---------- */

/**
 * The three sets of books, and the lines that reconcile them.
 *
 * Everything only. That book used to be the other two poured into one pool,
 * answering nothing they do not answer better while printing an income figure
 * that is deliberately not their sum — with nothing anywhere to say why. This
 * is the why, as arithmetic rather than as a claim.
 */
export function BridgeWidget({ data, variant, controls }: WidgetProps) {
  const bridge = useMemo(
    () => bookBridge(data.allTxns, data.flows, data.rule, data.books, month()),
    [data.allTxns, data.flows, data.rule, data.books],
  )
  const lines = useMemo<BridgeLine[]>(() => {
    const out: BridgeLine[] = [
      {
        key: 'outside',
        label: 'From outside',
        household: bridge.household.externalIncome,
        mine: bridge.mine.externalIncome + bridge.mine.returned,
        all: bridge.all.externalIncome,
      },
    ]
    if (bridge.crossingMinor > 0) {
      out.push({
        key: 'between',
        label: 'Put in between us',
        household: bridge.household.contributions,
        mine: bridge.crossingMinor,
      })
    }
    out.push({
      key: 'spent',
      label: 'Spent',
      household: bridge.household.spend,
      mine: bridge.mine.spend,
      all: bridge.all.spend,
    })
    if (bridge.unheldSpendMinor > 0) {
      out.push({
        key: 'unheld',
        label: 'Bought for us from an account you cannot see',
        household: bridge.unheldSpendMinor,
        negative: true,
      })
    }
    out.push({
      key: 'left',
      label: 'Left',
      household: bridge.household.net,
      mine: bridge.mine.net,
      all: bridge.all.net,
      total: true,
    })
    return out
  }, [bridge])

  const openRows = useHomeDrill(data.book)
  if (data.book !== 'all' || bridge.all.income + bridge.all.spend === 0) return null

  return (
    <Card className="p-4 md:p-3">
      <CardHeading
        title="How the books add up"
        controls={controls}
        info={
          <>
            <p>
              Money moved between our books is counted once in each book and in neither under Everything — the two
              legs are the same event, so counting either would be counting it twice. That is why
              Everything&rsquo;s income is not the two figures above it added together.
            </p>
            <p>What is left always adds up exactly, whatever the crossings did and whoever paid for what.</p>
          </>
        }
      />
      <BooksBridge lines={lines} shape={variant} onPick={() => openRows()} />
    </Card>
  )
}
