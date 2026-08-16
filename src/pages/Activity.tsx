import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Search, Upload, Receipt, ChevronDown, ChevronLeft, ChevronRight, Wallet, CalendarDays, Check, X, ArrowLeftRight, HandCoins, HelpCircle, Layers, Shapes, MoreHorizontal } from 'lucide-react'
import type { Category, Transaction } from '../lib/db'
import { useAccountMap, useAccounts, useAllTransactions, useBook, useBooks, useCategories, useCategoryMap, useGrantsByAccount, useMemberMap, useMyLevels } from '../lib/cache'
import { canAddTransactions, canEditTransaction, canSeeTransactionsAt, levelOn } from '../lib/accounts'
import { appScrollerTopInset, onAppScroll, scrollAppTo, scrollAppToElement } from '../lib/scroll'

import { update } from '../lib/data'
import {
  AccountEditor,
  AmountEditor,
  CategoryEditor,
  DateEditor,
  EditableCell,
  FIELD_ORDER,
  TextEditor,
  useDesktop,
  type CellRef,
} from '../components/InlineCell'
import { accountsInBook, showsInBook, isHouseholdPaid, BOOK_LABEL, type BookId, type BookMap } from '../lib/books'
import { applyContributor, learnContributors, suggestContributor, taggable } from '../lib/contributors'
import { askedOfMe, isAsking, looksLikeTransfer } from '../lib/unexplained'
import { fullName, isTopLevel, usableOn } from '../lib/categories'
import { useSticky, useStickyIds } from '../lib/sticky'
import { matchesDrill, narrows, readDrill } from '../lib/drill'
import { thisMonthKey, monthLabel, monthKey, fmtDay, fmtFullDate } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { AccountDot, Card, CategoryDot, CONTROL_H, Empty, FilterBar, FilterChip, Popover, TextInput, Toolbar, Button, table, ScrollTable, cx } from '../components/ui'
import { CategoryIcon } from '../components/CategoryIcon'
import { BookSwitcher } from '../components/BookSwitcher'
import { TransactionForm } from '../components/TransactionForm'
import { ImportWizard } from '../components/ImportWizard'
import { TransferReview } from '../components/TransferReview'
import { nameOf } from '../components/PersonDot'
import { toast } from '../components/toast'
import { useSyncState } from '../hooks/useSync'

/**
 * Activity is one continuous history, newest first.
 *
 * It used to be a month at a time behind a stepper, which made the commonest
 * question in the app — "when did we last pay for that?" — a series of taps
 * into months you already knew were empty. Now the list simply runs, broken by
 * month headings, and older rows arrive as you reach them. `Jump to` is there
 * for the case the scroll is genuinely wrong for: a specific month two years
 * back.
 *
 * Everything is filtered in memory from the whole cache. That is the position
 * `useAllTransactions` already takes for reports and the payee matcher — a
 * couple's history is a few thousand rows — and it is what makes the month
 * index, the per-month totals and the jump target all trivially available.
 * `limit` is about how many DOM rows exist, not about how much is loaded.
 */

/** Rows added each time the end of the list comes into view. */
const PAGE = 80

export default function Activity() {
  const { money } = useApp()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  /**
   * Every filter on this page is sticky for the session — see `lib/sticky.ts`.
   *
   * They were `useState`, so walking to Reports and back threw them away and
   * the page opened on everything again. A filter is a question you are in the
   * middle of asking; having to ask it again every time you glance away is the
   * whole complaint. It dies with the tab, deliberately: a narrowing set last
   * Tuesday should not still be hiding rows this morning.
   */
  const [query, setQuery] = useSticky('activity.query', '')
  /**
   * null = every category; a set = just those, top-level, subcategories
   * included; an EMPTY set = none of them, which is a real state you can get
   * to by unticking "All categories".
   */
  const [catFilter, setCatFilter] = useStickyIds('activity.categories')
  /** null = every account in the current book; a set = just those. */
  const [accountFilter, setAccountFilter] = useStickyIds('activity.accounts')
  /**
   * One month only, or the whole history. Empty by default — the point of the
   * list is that it runs — and set by a drill-through from Reports, where the
   * question genuinely is "which rows make up that figure".
   */
  const [monthFilter, setMonthFilter] = useSticky<string | null>('activity.month', null)
  /**
   * A run of days, from a figure that was not a month: a year's category, a
   * custom range, a bar on a chart of weeks. Held as a pair rather than as two
   * filters, because half a range is not a narrower question.
   */
  const [rangeFilter, setRangeFilter] = useSticky<{ from: string; to: string } | null>('activity.range', null)
  /**
   * One merchant, as a report labelled it. Matched with `payeeSimilar` rather
   * than by equality — see the filter below.
   */
  const [payeeFilter, setPayeeFilter] = useSticky<string | null>('activity.payee', null)
  /**
   * Where the drill came from, so the page can offer the way back.
   *
   * Sticky rather than held in the URL, because the params are cleared the
   * moment they are read — and the way back has to outlive that, survive a
   * reload, and still die with the tab like every other filter here.
   */
  const [origin, setOrigin] = useSticky<{ label: string; path: string } | null>('activity.origin', null)
  const [limit, setLimit] = useState(PAGE)
  const [editing, setEditing] = useState<Transaction | undefined>()
  const [importOpen, setImportOpen] = useState(false)
  /**
   * The one cell being edited in place, on desktop. Null everywhere else — an
   * iPad is wide enough for the table and has no cursor, so it keeps the sheet.
   */
  const [cell, setCell] = useState<CellRef | null>(null)
  const desktop = useDesktop()

  const { userId } = useSyncState()
  const grantsByAccount = useGrantsByAccount()
  const categories = useCategories()
  const catMap = useCategoryMap()
  const accMap = useAccountMap()
  const allAccounts = useAccounts()
  const levels = useMyLevels()
  const txns = useAllTransactions()
  const books = useBooks()
  const memberMap = useMemberMap()
  const [book, setBook] = useBook()
  const searching = query.trim().length > 0

  /**
   * Arriving from a report slice: the same category, month and book that
   * produced the figure clicked on.
   *
   * Read once and cleared from the URL, so that a later change to any of these
   * filters is not silently undone by a param nobody can see. `book` goes
   * through the shared setting the switcher writes, which is what makes the
   * lens survive the navigation rather than being a fourth hidden filter.
   */
  useEffect(() => {
    if ([...params.keys()].length === 0) return
    const drill = readDrill(params)
    setParams({}, { replace: true })

    // A drill REPLACES the filters rather than narrowing what was already
    // there: arriving from a figure must show the rows behind that figure, and
    // a category filter left over from a question asked ten minutes ago would
    // silently show fewer of them than the chart claimed.
    if (narrows(drill)) {
      setCatFilter(drill.category ? new Set([drill.category]) : null)
      setAccountFilter(drill.account ? new Set([drill.account]) : null)
      setMonthFilter(drill.month ?? null)
      setRangeFilter(drill.from && drill.to ? { from: drill.from, to: drill.to } : null)
      setPayeeFilter(drill.payee ?? null)
      setQuery('')
    }
    if (drill.book) setBook(drill.book)
    setOrigin(drill.backTo ? { label: drill.backLabel ?? 'where you were', path: drill.backTo } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Only accounts whose transactions we are allowed to read, and only those in
  // the book being looked at. The rest have no rows to filter here, so offering
  // them would be offering an empty answer.
  const inBook = useMemo(() => accountsInBook(book, books), [book, books])
  const accounts = useMemo(
    () => allAccounts.filter((a) => inBook.has(a.id) && canSeeTransactionsAt(levelOn(a.id, levels))),
    [allAccounts, inBook, levels],
  )

  /**
   * An account filter written under one book means nothing under another.
   *
   * The previous book is remembered rather than the effect simply depending on
   * `book`, because a dependency fires on MOUNT too — which, now that the
   * filter outlives the page, would clear it every single time you opened
   * Activity. Only an actual change to the lens may reset it.
   */
  const lastBook = useRef(book)
  useEffect(() => {
    if (lastBook.current === book) return
    lastBook.current = book
    setAccountFilter(null)
  }, [book, setAccountFilter])

  const parents = useMemo(() => categories.filter(isTopLevel), [categories])

  /**
   * The drill-shaped part of this page's filters, in the shape `matchesDrill`
   * takes — so the list here and the sheet that opens over a chart answer the
   * same question the same way. The category and account filters stay out of
   * it: those are sets here (several categories at once) where a drill names
   * one, and folding a set into that shape would be a different question
   * wearing its name.
   */
  const asDrill = useMemo(
    () => ({
      month: monthFilter ?? undefined,
      from: rangeFilter?.from,
      to: rangeFilter?.to,
      payee: payeeFilter ?? undefined,
    }),
    [monthFilter, rangeFilter, payeeFilter],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const visible = new Set(accounts.map((a) => a.id))
    const list = (txns ?? []).filter((t) => {
      // Not `visible.has(...)`: a household expense paid from a personal
      // account is counted in the household's heading while living outside
      // every account in that book. See `showsInBook`.
      if (!showsInBook(t, book, books, visible)) return false
      // The account chips offer the accounts in the book, so such a row is
      // never one of the answers — narrowing to an account is a question about
      // that account, and this row is not on it.
      if (accountFilter && !accountFilter.has(t.accountId)) return false
      if (!matchesDrill(t, asDrill, catMap)) return false
      if (catFilter !== null) {
        // The list is top-level, so a subcategory counts towards its parent —
        // the same rule budgets use, and the rule the report slices are built on.
        const cat = t.categoryId ? catMap.get(t.categoryId) : undefined
        if (!cat || !(catFilter.has(cat.id) || (cat.parentId != null && catFilter.has(cat.parentId)))) return false
      }
      if (q && !(t.payee.toLowerCase().includes(q) || (t.note ?? '').toLowerCase().includes(q))) return false
      return true
    })
    return list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  }, [txns, catFilter, catMap, accountFilter, asDrill, accounts, query, book, books])

  /**
   * The other leg of each transfer, so a row can say where the money went.
   *
   * Built over the whole cache rather than the filtered list — the far leg is
   * routinely in an account the current filter excludes, and "Transfer" with no
   * destination is the answer this exists to improve on. It stays `undefined`
   * when the partner is in an account this device cannot see, which is a real
   * state (see `lib/unexplained.ts`) and not a lookup failure.
   */
  const partnerLeg = useMemo(() => {
    const byTransfer = new Map<string, Transaction[]>()
    for (const t of txns ?? []) {
      if (!t.transferId) continue
      const legs = byTransfer.get(t.transferId)
      if (legs) legs.push(t)
      else byTransfer.set(t.transferId, [t])
    }
    const out = new Map<string, Transaction>()
    for (const legs of byTransfer.values()) {
      for (const leg of legs) {
        const other = legs.find((l) => l.id !== leg.id)
        if (other) out.set(leg.id, other)
      }
    }
    return out
  }, [txns])

  /**
   * What a drill narrowed to, said in one line.
   *
   * Built from the filters in force rather than from the URL that set them:
   * the params are cleared on arrival, and a sentence describing a drill that
   * has since been widened by hand would be a caption disagreeing with the
   * list under it.
   */
  const drillLine = [
    monthFilter ? monthLabel(monthFilter) : null,
    rangeFilter ? `${fmtFullDate(rangeFilter.from)} – ${fmtFullDate(rangeFilter.to)}` : null,
    payeeFilter,
    catFilter ? catLabel(catFilter, catMap) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  /** A drill is on when something is narrowed, or when there is a way back to offer. */
  const drilled = Boolean(monthFilter || rangeFilter || payeeFilter || catFilter || origin)

  const clearDrill = () => {
    setMonthFilter(null)
    setRangeFilter(null)
    setPayeeFilter(null)
    setCatFilter(null)
    setAccountFilter(null)
    setQuery('')
    setOrigin(null)
  }

  /**
   * How a household-paid row is painted, which depends on the lens.
   *
   * Green under Our household, where the row is money that arrived and was
   * spent in the same breath; pink under Mine and Everything, where it is a
   * contribution leaving my account. See `.tint-household` in index.css — the
   * hue is the one claim the tint makes, and it is not the same claim in both
   * books.
   */
  const householdTint = book === 'household' ? 'tint-household' : 'tint-contribution'

  /**
   * Who paid a household expense out of their own pocket, or undefined for you.
   *
   * `createdBy` rather than an account owner, because on a published row the
   * account is not something this device holds — and it is the right answer
   * anyway: a personal card is imported by the person whose card it is.
   * `contributionSplit` deliberately does NOT use `created_by` for the mirror
   * question, but that one is about an arrival in a JOINT account, where
   * whoever imported the statement is not whose money it was.
   */
  const payerOf = (t: Transaction) =>
    t.createdBy && t.createdBy !== userId ? nameOf(memberMap.get(t.createdBy)) : undefined

  /** Where each month starts in `filtered`, and what it came to. */
  const months = useMemo(() => {
    const index = new Map<string, { at: number; count: number; spendMinor: number }>()
    filtered.forEach((t, i) => {
      const key = monthKey(t.date)
      const entry = index.get(key) ?? { at: i, count: 0, spendMinor: 0 }
      entry.count += 1
      if (t.amountMinor < 0 && !t.transferId) entry.spendMinor -= t.amountMinor
      index.set(key, entry)
    })
    return index
  }, [filtered])

  // A changed filter means a different list; keeping the old depth would leave
  // hundreds of rows rendered for a search that matches four.
  const filterKey = [
    query,
    catFilter ? [...catFilter].sort().join(',') : 'all',
    monthFilter,
    rangeFilter ? `${rangeFilter.from}..${rangeFilter.to}` : 'all',
    payeeFilter ?? 'all',
    book,
    accountFilter ? [...accountFilter].sort().join(',') : 'all',
  ].join('|')
  useEffect(() => {
    setLimit(PAGE)
    scrollAppTo({ top: 0 })
  }, [filterKey])

  const visible = filtered.slice(0, limit)
  const more = filtered.length > visible.length

  // Grow the list when its end comes into view. `more` is a dependency so the
  // observer is rebuilt around the sentinel's new position each time.
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || !more) return
    const io = new IntersectionObserver(
      (entries) => entries[0]?.isIntersecting && setLimit((n) => n + PAGE),
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [more, filtered.length])

  /**
   * Jumping to a month is two steps: render deep enough to contain it, then
   * scroll to it. The scroll has to wait for the render, so it is parked here
   * and taken in an effect once `limit` has actually grown.
   */
  const [pendingJump, setPendingJump] = useState<string | null>(null)
  function jumpTo(month: string) {
    const entry = months.get(month)
    if (!entry) return
    setLimit((n) => Math.max(n, entry.at + PAGE))
    setPendingJump(month)
  }
  useLayoutEffect(() => {
    if (!pendingJump) return
    const el = headingFor(pendingJump)
    setPendingJump(null)
    if (!el) return
    // The scroller's own top padding, which is where a `sticky top-0` heading
    // comes to rest — so a jumped-to month lands on exactly the line it would
    // have stuck to, rather than near it. See `appScrollerTopInset`.
    scrollAppToElement(el, appScrollerTopInset())
  }, [pendingJump, limit])

  /**
   * The month the top of the screen is currently in, so `Jump to` says where
   * you are as well as offering to move you. Read from live geometry on scroll
   * rather than from an observer: with headings this far apart a fast flick can
   * pass several without any of them crossing a threshold band.
   */
  const [atMonth, setAtMonth] = useState<string | null>(null)
  useEffect(() => {
    let frame = 0
    const read = () => {
      frame = 0
      const heads = headings()
      // The stuck line, plus a little: a heading resting under the bar counts
      // as the month you are in. Same inset as the jump, so "where am I" and
      // "take me there" cannot disagree about where the top of the list is.
      const line = appScrollerTopInset() + 24
      let current: string | null = null
      for (const head of heads) {
        if (head.getBoundingClientRect().top <= line) current = head.dataset.month ?? null
        else break
      }
      setAtMonth(current ?? heads[0]?.dataset.month ?? null)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    const off = onAppScroll(onScroll)
    return () => {
      off()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [visible.length])

  const rows = useMemo(() => {
    // The visible rows, cut into months. Every heading carries the whole
    // month's figures, not just the part rendered so far.
    const out: { month: string; items: Transaction[] }[] = []
    for (const t of visible) {
      const key = monthKey(t.date)
      if (out[out.length - 1]?.month !== key) out.push({ month: key, items: [] })
      out[out.length - 1].items.push(t)
    }
    return out
  }, [visible])

  /**
   * Save one cell, and decide where the cursor goes.
   *
   * `patch` null means nothing changed — a cell tabbed through, or an amount
   * that did not parse — and must still move on, or Tab would stick on the
   * first field a typist skipped.
   *
   * Writes go through `data.ts` like every other change, so this inherits the
   * outbox and its dead letters. Which matters here more than usual: inline
   * editing makes it very easy to change fifty rows quickly, and at
   * `contribute` you may only change what you added — hence `canEditCell`
   * below, which greys the cell out rather than letting the write fail
   * silently a minute later.
   */
  const commitCell = (t: Transaction, patch: Record<string, unknown> | null, then: 'close' | 'next' | 'prev' = 'close') => {
    if (patch) void update('transactions', t.id, patch)
    if (then === 'close') return setCell(null)
    const i = FIELD_ORDER.indexOf(cell?.field ?? 'payee')
    const next = FIELD_ORDER[i + (then === 'next' ? 1 : -1)]
    setCell(next ? { id: t.id, field: next } : null)
  }

  /**
   * Where a row could be moved to. `contribute` and above, matching
   * `transactions_insert` — offering an account the server would refuse turns a
   * pick into a dead letter a minute later.
   */
  const postable = useMemo(
    () => accounts.filter((a) => canAddTransactions(levelOn(a.id, levels))),
    [accounts, levels],
  )

  /** Mirrors `transactions_update`, including the `created_by` half. */
  const canEditCell = (t: Transaction) =>
    desktop && canEditTransaction(t, levelOn(t.accountId, levels), userId)

  return (
    <div>
      {/* Wide screens keep the toolbar: there is room for every control at
          full size, and each one is visible without being opened. */}
      <Toolbar className="hidden md:flex">
        {/* Same lens as Reports, Home and Budgets. Activity is a ledger rather
            than an account of what happened, so `all` is a perfectly ordinary
            answer here — but "show me the joint account's rows" is the question
            behind most trips to this page. */}
        <BookSwitcher book={book} onChange={setBook} className="hidden md:flex md:w-auto" />

        {/* Not "all transactions" any more: a search runs inside the book and
            the filters on screen, and saying otherwise would make an empty
            result look like a missing row rather than a narrow lens. */}
        <div className="relative min-w-0 flex-1 basis-52 md:max-w-72 md:flex-none">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transactions"
            className="pl-9! md:pl-8!"
          />
        </div>

        <CategoryFilter parents={parents} value={catFilter} onChange={setCatFilter} />
        <AccountFilter accounts={accounts} value={accountFilter} onChange={setAccountFilter} />
        {/* Nowhere to jump to inside a single month. */}
        {!monthFilter && !rangeFilter && <MonthJump current={atMonth} months={months} onPick={jumpTo} />}

        <Button variant="subtle" onClick={() => setImportOpen(true)}>
          <Upload size={15} /> Import CSV
        </Button>
        {filtered.length > 0 && (
          <p className="ml-auto hidden text-sm text-ink-3 md:block">
            {filtered.length} transaction{filtered.length === 1 ? '' : 's'}
          </p>
        )}
      </Toolbar>

      {/* Phones get one scrolling row instead. The lens is not in it — it lives
          in the header now, on every page at once. */}
      <FilterBar>
        <SearchChip value={query} onChange={setQuery} />
        <CategoryFilter parents={parents} value={catFilter} onChange={setCatFilter} variant="chip" />
        <AccountFilter accounts={accounts} value={accountFilter} onChange={setAccountFilter} variant="chip" />
        {!monthFilter && !rangeFilter && <MonthJump current={atMonth} months={months} onPick={jumpTo} variant="chip" />}
        <MoreChip onImport={() => setImportOpen(true)} />
      </FilterBar>

      {/* Above the list, so both legs of a proposed pair are visible while you
          decide. It renders nothing at all when there is nothing to ask. */}
      <TransferReview />

      {/* The other half of the same problem. TransferReview offers pairs this
          device can see both sides of; this one carries the questions about
          rows it cannot. */}
      <AskedOfMe txns={txns ?? []} onOpen={setEditing} />

      {/* And the third: arrivals whose far leg does not exist at all, because
          the person who sent them is not using the app. Nothing can pair these,
          so the only thing that can resolve one is somebody saying whose it
          was — and having said it twice, this offers the answer. */}
      <SuggestedContributions txns={txns ?? []} books={books} />

      {/* What a drill-through narrowed the list to, and both ways out of it.
          A filter this strong has to be visible: without the banner the page
          simply looks like a history that stops.

          Two exits, because they answer different questions. "Back to Reports"
          is for when the list has told you what you came for and you want the
          chart again — it returns to the chart you actually left, month and
          period and all, because the origin path carries that page's state.
          "Show everything" is for when the answer is somewhere else in the
          history, and drops the narrowing without leaving the page. */}
      {drilled && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-accent/8 px-4 py-2.5 ring-1 ring-accent/20 md:mb-2.5 md:py-2">
          {/* On a phone the sentence takes the whole first line and the two
              ways out share the second. Squeezed between them it wrapped into a
              three-word column with a button either side, which is the shape of
              a toolbar rather than of a sentence. */}
          {origin && (
            <button
              type="button"
              onClick={() => {
                clearDrill()
                navigate(origin.path)
              }}
              className="order-2 inline-flex shrink-0 items-center gap-0.5 rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-ink-2 ring-1 ring-hairline transition hover:text-ink md:order-1"
            >
              <ChevronLeft size={13} /> {origin.label}
            </button>
          )}
          <p className="order-1 min-w-0 basis-full text-sm md:order-2 md:basis-auto md:flex-1">
            <span className="font-medium">{drillLine}</span>
            {book !== 'all' && <span className="text-ink-3">{` · ${BOOK_LABEL[book]}`}</span>}
          </p>
          <button
            type="button"
            onClick={clearDrill}
            className="order-3 ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-ink-2 ring-1 ring-hairline transition hover:text-ink md:ml-0"
          >
            <X size={12} /> Show everything
          </button>
        </div>
      )}

      {/* `undefined` is the cache still opening, not an empty history — telling
          somebody they have no transactions for one frame is worse than a
          blank. */}
      {txns === undefined ? null : filtered.length === 0 ? (
        <Empty
          icon={Receipt}
          title={searching ? 'Nothing matches your search' : 'No transactions here'}
          hint={
            searching && book !== 'all'
              ? `This searched ${BOOK_LABEL[book].toLowerCase()} only.`
              : searching || catFilter || accountFilter || monthFilter || rangeFilter || payeeFilter
                ? 'Try widening the filters above.'
                : 'Add one with the + button, or import a bank statement CSV.'
          }
          /* A search that found nothing because of the lens is the one empty
             state with an obvious next move, and making somebody hunt for the
             switcher to make it is the whole complaint. */
          action={
            searching && book !== 'all' ? (
              <Button variant="subtle" onClick={() => setBook('all')}>
                <Layers size={15} /> Search everything instead
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Phone: cards grouped under a day heading, thumb-sized rows. */}
          <div className="space-y-5 md:hidden">
            {rows.map(({ month, items }) => (
              <div key={month}>
                <MonthHeading month={month} stats={months.get(month)} money={money} sticky />
                <div className="space-y-4">
                  {byDay(items).map(([date, list]) => (
                    <div key={date}>
                      <p className="mb-1.5 px-1 text-sm font-semibold text-ink-3">{fmtDay(date)}</p>
                      {/* `overflow-hidden` because a tinted row paints an
                          OPAQUE fill edge to edge — it has to, so the tint
                          survives being scrolled under the pinned column on
                          desktop — and an opaque fill does not know about the
                          card's rounded corners. Without this the first and
                          last rows square off the card. */}
                      <Card className="overflow-hidden">
                        <ul className="divide-y divide-hairline">
                          {list.map((t) => {
                            const cat = t.categoryId ? catMap.get(t.categoryId) : undefined
                            const transfer = !!t.transferId
                            const forHousehold = isHouseholdPaid(t, books)
                            return (
                              <li key={t.id}>
                                <button
                                  type="button"
                                  onClick={() => setEditing(t)}
                                  className={cx(
                                    'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
                                    transfer
                                      ? 'tint-transfer'
                                      : forHousehold
                                        ? householdTint
                                        : 'hover:bg-surface-2/50 active:bg-surface-2',
                                  )}
                                >
                                  {/* The account rides on the category badge
                                      rather than taking a line of its own: a
                                      phone row has room for two lines and both
                                      are spoken for, and "which card" is a
                                      glance question, not a reading one. */}
                                  <span className="relative shrink-0">
                                    {/* A transfer takes the category's place in
                                        the row rather than sitting beside it:
                                        linking strips the category off both
                                        legs, so what would otherwise be here is
                                        a grey "Uncategorised" tag — the least
                                        informative badge in the app standing in
                                        for one of the most. */}
                                    {transfer ? <TransferDot size={34} /> : <CategoryDot category={cat} size={34} />}
                                    {/* A published row has no account on this
                                        device to draw, so the corner carries
                                        the mark instead — which is the more
                                        useful of the two facts anyway. */}
                                    {forHousehold && !accMap.has(t.accountId) ? (
                                      <HouseholdMark
                                        icon
                                        book={book}
                                        payer={payerOf(t)}
                                        size={16}
                                        className="absolute -bottom-0.5 -right-0.5 ring-2 ring-surface"
                                      />
                                    ) : (
                                      <AccountDot
                                        account={accMap.get(t.accountId)}
                                        size={16}
                                        className="absolute -bottom-0.5 -right-0.5 ring-2 ring-surface"
                                      />
                                    )}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate font-medium">{t.payee}</p>
                                    <p className="flex items-center gap-1 truncate text-sm text-ink-3">
                                      {!transfer && (looksLikeTransfer(t) || isAsking(t)) && <MaybeTransfer txn={t} />}
                                      {forHousehold && <HouseholdMark book={book} payer={payerOf(t)} />}
                                      <span className="truncate">
                                        {/* A tagged arrival takes the place of
                                            "Uncategorised" and not of a real
                                            category: saying whose money it was
                                            is an answer to a different
                                            question, and hiding a category
                                            somebody chose to show it would be
                                            trading one fact for another. */}
                                        {transfer
                                          ? transferLine(t, partnerLeg.get(t.id), accMap)
                                          : cat
                                            ? fullName(cat, catMap)
                                            : t.contributorId
                                              ? `Paid in by ${nameOf(memberMap.get(t.contributorId))}`
                                              : 'Uncategorised'}
                                        {t.note ? ` · ${t.note}` : ''}
                                      </span>
                                    </p>
                                  </div>
                                  {/* Muted, not green. A transfer's arriving leg
                                      is not income, and painting it the colour
                                      income wears is the one reading the whole
                                      pairing mechanism exists to prevent. */}
                                  <span
                                    className={cx(
                                      'font-semibold tabular',
                                      transfer ? 'text-ink-3' : t.amountMinor > 0 && 'text-good-text',
                                    )}
                                  >
                                    {money(t.amountMinor, { sign: t.amountMinor > 0 })}
                                  </span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </Card>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop: one scannable table. Date becomes a column instead of a
              heading, and the width freed up carries category, account and note.
              The month heading is a row of its own so the table stays one
              table — a table per month would give each its own column widths. */}
          <Card className="hidden overflow-hidden md:block">
            <ScrollTable minWidth={880}>
              <thead>
                <tr className={table.head}>
                  <th className={cx(table.th, 'w-28 pl-3', table.pinned)}>Date</th>
                  <th className={table.th}>Payee</th>
                  <th className={cx(table.th, 'w-52')}>Category</th>
                  <th className={cx(table.th, 'w-40')}>Account</th>
                  <th className={cx(table.th, 'w-32 pr-3 text-right')}>Amount</th>
                  {/* Deliberately unlabelled and nearly nothing wide. Inline
                      editing takes over every other cell's click, so without a
                      way through, the sheet — and with it deletion, notes,
                      receipts and transfer linking — becomes unreachable on
                      the machine where it is easiest to need. */}
                  <th className={cx(table.th, 'w-9')} aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ month, items }) => (
                  <Fragment key={month}>
                    <tr>
                      <td colSpan={6} className="border-b border-hairline bg-surface-2/40 px-3 py-1.5">
                        <MonthHeading month={month} stats={months.get(month)} money={money} dense />
                      </td>
                    </tr>
                    {items.map((t) => {
                      const cat = t.categoryId ? catMap.get(t.categoryId) : undefined
                      const parent = cat?.parentId ? catMap.get(cat.parentId) : undefined
                      const acc = accMap.get(t.accountId)
                      const editable = canEditCell(t)
                      const open = cell?.id === t.id ? cell : null
                      const transfer = !!t.transferId
                      const forHousehold = isHouseholdPaid(t, books)
                      return (
                        <tr
                          key={t.id}
                          onClick={() => setEditing(t)}
                          className={cx(
                            table.row,
                            'cursor-pointer transition-colors',
                            transfer ? 'tint-transfer' : forHousehold && householdTint,
                          )}
                        >
                          {/* The list spans every month, so the year has to be
                              on the row — the heading is off screen by the time
                              you are reading the middle of a long month. */}
                          <EditableCell
                            className={cx(
                              table.cell,
                              'pl-3 whitespace-nowrap text-ink-3 tabular',
                              table.pinned,
                              // The pinned column paints its own opaque fill, so
                              // the row's tint cannot reach it — it has to be
                              // repeated here or the date cell stays plain.
                              transfer ? 'tint-transfer' : forHousehold && householdTint,
                            )}
                            editing={open?.field === 'date'}
                            editable={editable}
                            onStart={() => setCell({ id: t.id, field: 'date' })}
                            onCancel={() => setCell(null)}
                            editor={<DateEditor value={t.date} commit={(p, then) => commitCell(t, p, then)} />}
                          >
                            {fmtFullDate(t.date)}
                          </EditableCell>
                          {/* Note rides on the same line as the payee — a second
                              line would make row heights uneven and harder to scan. */}
                          <EditableCell
                            className={cx(table.cell, 'max-w-0 truncate pr-3')}
                            editing={open?.field === 'payee'}
                            editable={editable}
                            onStart={() => setCell({ id: t.id, field: 'payee' })}
                            onCancel={() => setCell(null)}
                            editor={
                              <TextEditor
                                value={t.payee}
                                commit={(p, then) => commitCell(t, p, then)}
                                parse={(raw) => (raw.trim() ? { payee: raw.trim() } : null)}
                              />
                            }
                          >
                            {transfer ? (
                              <span
                                title="One side of a transfer between accounts — it counts as neither spending nor income."
                                aria-label="Transfer"
                                className="mr-1.5 inline-flex shrink-0 items-center rounded-full bg-accent/15 px-1 py-0.5 align-middle text-accent"
                              >
                                <ArrowLeftRight size={11} />
                              </span>
                            ) : (
                              (looksLikeTransfer(t) || isAsking(t)) && <MaybeTransfer txn={t} />
                            )}
                            {forHousehold && (
                              <HouseholdMark book={book} payer={payerOf(t)} className="mr-1.5 align-middle" />
                            )}
                            <span className="font-medium">{t.payee}</span>
                            {t.note && <span className="ml-2 text-ink-3">{t.note}</span>}
                          </EditableCell>
                          {/* Both halves, with the parent dimmed: a row filed
                              under "Supermarket" is unreadable without knowing
                              it is groceries, and one filed under "Groceries"
                              exactly should not look like the same answer. */}
                          <EditableCell
                            className={cx(table.cell, 'pr-3')}
                            editing={open?.field === 'category'}
                            editable={editable}
                            onStart={() => setCell({ id: t.id, field: 'category' })}
                            onCancel={() => setCell(null)}
                            editor={
                              <CategoryEditor
                                categories={usableOn(categories, grantsByAccount.get(t.accountId) ?? [], userId)}
                                byId={catMap}
                                value={t.categoryId}
                                commit={(p, then) => commitCell(t, p, then)}
                              />
                            }
                          >
                            <span className="flex items-center gap-1.5 truncate">
                              {/* Linking strips the category off both legs, so
                                  for a transfer this column is where the far
                                  account belongs — "Uncategorised" is true and
                                  says nothing. A leg that somehow still carries
                                  a category keeps showing it. */}
                              {transfer && !cat ? (
                                <>
                                  <ArrowLeftRight size={14} className="shrink-0 text-accent" />
                                  <span className="truncate text-ink-2">
                                    {transferLine(t, partnerLeg.get(t.id), accMap)}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span
                                    className="shrink-0"
                                    style={{ color: cat ? `var(--series-${parent?.slot ?? cat.slot})` : 'var(--ink-3)' }}
                                  >
                                    <CategoryIcon icon={cat?.icon ?? parent?.icon} size={14} />
                                  </span>
                                  <span className="truncate">
                                    {parent && <span className="text-ink-3">{parent.name} · </span>}
                                    <span className="text-ink-2">{cat?.name ?? 'Uncategorised'}</span>
                                  </span>
                                </>
                              )}
                            </span>
                          </EditableCell>
                          {/* A badge, not grey text. This is the column you
                              scan to answer "which card was that on", and it
                              was the only one with nothing to catch the eye.
                              A rounded square where a category is a circle, so
                              the two read as different axes at a glance. */}
                          <EditableCell
                            className={cx(table.cell, 'pr-3 text-ink-2')}
                            editing={open?.field === 'account'}
                            editable={editable}
                            onStart={() => setCell({ id: t.id, field: 'account' })}
                            onCancel={() => setCell(null)}
                            editor={
                              <AccountEditor
                                accounts={postable}
                                value={t.accountId}
                                commit={(p, then) => commitCell(t, p, then)}
                              />
                            }
                          >
                            <span className="flex items-center gap-2 truncate">
                              {/* A published row is on an account this device
                                  does not hold, so there is no face and no name
                                  to draw. It says WHO rather than which card —
                                  the account's name is deliberately not part of
                                  what publishing exposes. */}
                              {acc ? (
                                <>
                                  <AccountDot account={acc} size={22} />
                                  <span className="truncate">{acc.name}</span>
                                </>
                              ) : forHousehold ? (
                                <>
                                  <HouseholdMark icon book={book} payer={payerOf(t)} />
                                  <span className="truncate text-ink-3">
                                    {payerOf(t) ? `${payerOf(t)}’s account` : 'A personal account'}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <AccountDot account={undefined} size={22} />
                                  <span className="truncate">—</span>
                                </>
                              )}
                            </span>
                          </EditableCell>
                          <EditableCell
                            className={cx(
                              table.cell,
                              'pr-3 text-right font-semibold tabular',
                              transfer ? 'text-ink-3' : t.amountMinor > 0 && 'text-good-text',
                            )}
                            editing={open?.field === 'amount'}
                            editable={editable}
                            onStart={() => setCell({ id: t.id, field: 'amount' })}
                            onCancel={() => setCell(null)}
                            editor={<AmountEditor amountMinor={t.amountMinor} commit={(p, then) => commitCell(t, p, then)} />}
                          >
                            {money(t.amountMinor, { sign: t.amountMinor > 0 })}
                          </EditableCell>
                          <td className={cx(table.cell, 'pr-2 text-right')}>
                            <button
                              type="button"
                              aria-label={`Open ${t.payee}`}
                              title="Open the full form"
                              onClick={(e) => {
                                e.stopPropagation()
                                setCell(null)
                                setEditing(t)
                              }}
                              className="rounded-md p-1 text-ink-3 opacity-0 transition hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                            >
                              <ChevronRight size={15} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </ScrollTable>
          </Card>

          {/* The end of what is rendered, not the end of the history. */}
          <div ref={sentinel} className="h-px" />
          {more && (
            <p className="py-6 text-center text-sm text-ink-3">
              Loading older transactions…
            </p>
          )}
        </>
      )}

      <TransactionForm open={editing !== undefined} onClose={() => setEditing(undefined)} editing={editing} />
      <ImportWizard open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}

/**
 * The month headings on screen, newest first.
 *
 * Both layouts render every heading — one is `md:hidden`, the other `hidden
 * md:block` — so the query has to drop whatever is not being shown. A hidden
 * element measures zero at the top of the document, which would put the phone's
 * headings above every desktop one and make "the month you are looking at"
 * always the newest.
 */
const headings = () =>
  [...document.querySelectorAll<HTMLElement>('[data-month]')].filter((el) => el.offsetParent !== null)

const headingFor = (month: string) => headings().find((el) => el.dataset.month === month)

/**
 * The badge a confirmed transfer wears where a category would be.
 *
 * Deliberately built like `CategoryDot` — same circle, same tinted fill, same
 * glyph proportion — because it stands in the same place and answers the same
 * question ("what is this row?"). Accent rather than a palette slot: it is not
 * one of the twelve, and must not read as whichever category happens to share
 * that colour this month.
 */
function TransferDot({ size = 34 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full size-[var(--dot)]"
      style={{
        ['--dot' as string]: `${size}px`,
        background: 'color-mix(in oklab, var(--accent) 16%, var(--surface-2))',
        color: 'var(--accent)',
      }}
      aria-hidden
    >
      <ArrowLeftRight size={Math.round(size * 0.5)} />
    </span>
  )
}

/**
 * The mark on a household expense somebody paid out of their own account.
 *
 * The one row in the app counted in two books at once — a contribution out of
 * the payer's and spending in the household's — so the tint alone is not
 * enough: a colour says "this row is different" and cannot say how. The glyph
 * and its title do.
 *
 * `--series-7` rather than the accent, matching `.tint-household` and, more to
 * the point, matching the Sankey's "Paid from a personal account" band, which
 * is the same money seen from further away.
 *
 * `inline` is the version that sits in a line of text beside a payee; the
 * default is the standalone badge that stands in for an account this device
 * does not hold.
 */
function HouseholdMark({
  book,
  payer,
  icon,
  size = 22,
  className,
}: {
  book: BookId
  /** Who paid it, already resolved to a name, or undefined when it was you. */
  payer?: string
  /** The glyph alone, for standing in where an account badge would go. */
  icon?: boolean
  size?: number
  className?: string
}) {
  const here = book === 'household'
  const label = here ? (payer ? `${payer} paid` : 'You paid') : 'For the household'
  /**
   * Words only where they are the answer to a question somebody is asking.
   *
   * Under Our household the row is the odd one out — it is not on any account
   * in this book, and "why is my partner's card in here" needs answering on the
   * row rather than in a tooltip nobody on a phone can open. Under Mine the row
   * is exactly where you would expect it and the tag is a footnote, so it stays
   * a glyph: three words there push the category off the end of the line, and
   * the category is what the line is for.
   */
  const words = here && !icon
  return (
    <span
      title={
        here
          ? `Bought for the household out of a personal account. It counts twice, and has to: as money ${payer ?? 'you'} put in, and as household spending — the same as moving it to the joint account and spending it from there.`
          : 'Counted as household spending, and as money you put in — not as personal spending.'
      }
      aria-label={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1',
        // A rounded SQUARE where it stands in for an account badge, because
        // that is the shape an account wears: the reader should not have to
        // work out which axis they are on when the badge changes what it says.
        icon
          ? 'rounded-md size-[var(--mark)]'
          : words
            ? 'rounded-full px-1.5 py-0.5 text-xs font-medium'
            : 'rounded-full px-1 py-0.5',
        className,
      )}
      style={{
        ['--mark' as string]: `${size}px`,
        ['--hue' as string]: here ? 'var(--series-4)' : 'var(--series-7)',
        background: 'color-mix(in oklab, var(--hue) 16%, var(--surface-2))',
        color: 'var(--hue)',
      }}
    >
      <HandCoins size={icon ? Math.round(size * 0.6) : 11} />
      {words && label}
    </span>
  )
}

/**
 * What a transfer row says instead of a category: which account the money went
 * to, or came from.
 *
 * `partner` is undefined when the far leg sits in an account this device is not
 * granted on. That is a real and ordinary state rather than a missing row — see
 * the privacy model — so it falls back to the bare word rather than inventing a
 * destination or admitting to a lookup that failed.
 */
function transferLine(
  txn: Transaction,
  partner: Transaction | undefined,
  accMap: Map<string, { name: string }>,
) {
  const other = partner && accMap.get(partner.accountId)?.name
  if (!other) return 'Transfer'
  return txn.amountMinor < 0 ? `Transfer to ${other}` : `Transfer from ${other}`
}

/**
 * A row the statement calls a movement of money, that nothing has paired.
 *
 * Deliberately a mark rather than a claim. `looksLikeTransfer` reads the words
 * the bank used and nothing else, so this says "worth a look", and the totals
 * go on counting the row exactly as they did — see `lib/unexplained.ts` for why
 * guessing here would be the worse failure. Categorising it, or pairing it with
 * its other half, both make the mark go away.
 */
function MaybeTransfer({ txn }: { txn: Transaction }) {
  // Somebody has actually asked about this one, which is a stronger statement
  // than "worth a look" and gets a stronger mark.
  if (isAsking(txn)) {
    return (
      <span
        title="Somebody has asked what this was. If its other side is in one of your accounts, open it and pair them."
        className="mr-1.5 inline-flex shrink-0 items-center rounded-full bg-warning/40 px-1 py-0.5 align-middle text-ink"
        aria-label="Somebody has asked about this"
      >
        <HelpCircle size={11} />
      </span>
    )
  }
  return (
    <span
      title="This reads like money moved between accounts, and nothing is paired with it. If the other side is in an account you cannot see, only the person who holds it can confirm it."
      className="mr-1.5 inline-flex shrink-0 items-center rounded-full bg-warning/20 px-1 py-0.5 align-middle text-ink-2"
      aria-label="Possibly a transfer"
    >
      <ArrowLeftRight size={11} />
    </span>
  )
}

/**
 * Questions the other person has left for me.
 *
 * The point of the whole mechanism, and the only screen where it is a job
 * rather than a mark: these are rows they could see and not explain, where the
 * missing half may be sitting in one of my accounts. Opening one goes to the
 * ordinary editor, where the transfer picker is already waiting.
 *
 * My own asks are not here — see `askedOfMe`. A nudge I wrote, listed back at
 * me as something to do, is how a nudge becomes noise.
 */
function AskedOfMe({ txns, onOpen }: { txns: Transaction[]; onOpen: (t: Transaction) => void }) {
  const { money } = useApp()
  const { userId } = useSyncState()
  const members = useMemberMap()
  const accMap = useAccountMap()
  const asked = useMemo(() => askedOfMe(txns, userId), [txns, userId])
  if (asked.length === 0) return null

  return (
    <Card className="mb-3 md:mb-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 px-4 py-3 pb-1 md:px-3">
        <h3 className="font-semibold md:text-sm">Asked about</h3>
        <p className="text-sm text-ink-3 md:text-xs">
          Rows the other side of which may be in one of your accounts.
        </p>
      </div>
      <ul className="divide-y divide-hairline">
        {asked.slice(0, 6).map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onOpen(t)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/50 md:px-3 md:py-2.5"
            >
              <HelpCircle size={16} className="shrink-0 text-ink-3" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium md:text-sm">{t.payee}</p>
                <p className="truncate text-xs text-ink-3">
                  {fmtFullDate(t.date)} · {accMap.get(t.accountId)?.name ?? 'an account'} ·{' '}
                  {t.explainRequestedBy ? nameOf(members.get(t.explainRequestedBy)) : 'Somebody'} asked
                </p>
              </div>
              <span className={cx('shrink-0 text-sm font-semibold tabular', t.amountMinor > 0 && 'text-good-text')}>
                {money(t.amountMinor, { sign: t.amountMinor > 0 })}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {asked.length > 6 && (
        <p className="px-4 pb-3 text-xs text-ink-3 md:px-3">and {asked.length - 6} more</p>
      )}
    </Card>
  )
}

/**
 * Arrivals this device could name, if somebody confirmed it.
 *
 * The third of the three cards above the list, and the one for the case neither
 * of the others can reach. `TransferReview` offers pairs both legs of which are
 * here; `AskedOfMe` carries questions about rows whose other half is on the
 * other person's device. This is for money whose other half is on NO device —
 * a household member who is not using the app — where the only thing that can
 * ever resolve the row is a person saying whose it was.
 *
 * It suggests and does not apply, which is the same posture as everything else
 * on this screen: accepting moves the money onto a name AND into the month it
 * was for, so a wrong guess applied quietly would be wrong in a way nobody
 * could see. See `lib/contributors.ts`.
 *
 * Rows this device may not edit are filtered out rather than offered and
 * refused — `transactions_update` would reject them, minutes later, as dead
 * letters in Settings.
 */
function SuggestedContributions({ txns, books }: { txns: Transaction[]; books: BookMap }) {
  const { money } = useApp()
  const { userId } = useSyncState()
  const members = useMemberMap()
  const accMap = useAccountMap()
  const levels = useMyLevels()
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const learned = useMemo(() => learnContributors(txns, books), [txns, books])
  const rows = useMemo(() => {
    if (learned.size === 0) return []
    return txns
      .filter(
        (t) =>
          !t.contributorId &&
          !dismissed.has(t.id) &&
          taggable(t, books) &&
          canEditTransaction(t, levelOn(t.accountId, levels), userId) &&
          suggestContributor(t.payee, learned) !== undefined,
      )
      .sort((a, b) => b.date.localeCompare(a.date))
    // `levels` is a fresh Map each render — the inputs that change the answer
    // are the rows and what has been learned from them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txns, books, learned, dismissed, userId])

  if (rows.length === 0) return null

  return (
    <Card className="mb-3 md:mb-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 px-4 py-3 pb-1 md:px-3">
        <h3 className="font-semibold md:text-sm">Paid in by</h3>
        <p className="text-sm text-ink-3 md:text-xs">
          These look like money one of you moved in. Confirming counts it towards the month it was for.
        </p>
      </div>
      <ul className="divide-y divide-hairline">
        {rows.slice(0, 6).map((t) => {
          const who = suggestContributor(t.payee, learned)!
          return (
            <li key={t.id} className="flex items-center gap-3 px-4 py-3 md:px-3 md:py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium md:text-sm">{t.payee}</p>
                <p className="truncate text-xs text-ink-3">
                  {fmtFullDate(t.date)} · {accMap.get(t.accountId)?.name ?? 'an account'} ·{' '}
                  <span className="tabular">{money(t.amountMinor, { sign: true })}</span>
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  void (async () => {
                    const previous = t.contributorId
                    await applyContributor([t], who, () => true)
                    toast(`Counted as ${nameOf(members.get(who))} putting money in`, {
                      undo: () => update('transactions', t.id, { contributorId: previous }),
                    })
                  })()
                }}
              >
                {members.get(who)?.userId === userId ? 'You' : nameOf(members.get(who))}
              </Button>
              {/* Session-only, and deliberately not stored. Declining says "not
                  this row", not "stop learning this payee" — the tagged rows
                  are the teaching, so silencing it for good means untagging
                  them. */}
              <button
                type="button"
                aria-label="Not that"
                title="Leave this one alone"
                onClick={() => setDismissed((s) => new Set(s).add(t.id))}
                className="shrink-0 rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <X size={16} />
              </button>
            </li>
          )
        })}
      </ul>
      {rows.length > 6 && (
        <p className="px-4 pb-3 text-xs text-ink-3 md:px-3">and {rows.length - 6} more</p>
      )}
    </Card>
  )
}

/** One month's rows, cut into days — the phone layout's second level. */
function byDay(items: Transaction[]): [string, Transaction[]][] {
  const map = new Map<string, Transaction[]>()
  for (const t of items) {
    const list = map.get(t.date)
    if (list) list.push(t)
    else map.set(t.date, [t])
  }
  return [...map.entries()]
}

/**
 * The heading a month's rows sit under, and the anchor `Jump to` scrolls at.
 * The figures are the whole month's, even where only part of it is rendered.
 */
function MonthHeading({
  month,
  stats,
  money,
  dense,
  sticky,
}: {
  month: string
  stats?: { count: number; spendMinor: number }
  money: (minor: number, opts?: { sign?: boolean }) => string
  dense?: boolean
  /**
   * Follow the scroll, under the mobile top bar.
   *
   * `top-0`, and it must NOT be `--header-h`. A sticky inset is measured from
   * the scroll container's CONTENT box, not its padding box — so the scroller's
   * own `pt-[var(--header-h)]`, which is what holds the first card clear of the
   * absolutely positioned bar, is already the whole of the clearance this needs.
   * Naming the header height here as well parks the heading at TWICE the bar's
   * height, floating in the middle of the rows it belongs to. That is what it
   * did when the bar was lifted out of the scroller: as `sticky top-0` inside
   * the scroller the bar had no padding under it and the offset was the only
   * thing holding the heading down, and both halves were true at once for
   * exactly one commit.
   *
   * So the clearance is stated in one place. If the bar's height ever stops
   * being the scroller's padding, this becomes wrong again — and visibly, which
   * is the right way round.
   *
   * Sticky works here despite `main` carrying `overflow-x: clip` on mobile:
   * `clip` is the one overflow value that does NOT force the other axis to
   * become a scroll container, so the vertical axis stays `visible` and the
   * nearest scroller is `#app-scroll` rather than something between. Any other
   * value there — `hidden`, `auto` — and this silently stops moving.
   *
   * Phone only. On desktop every row already carries its full date, so there
   * is nothing to lose track of, and the table's own sticky first column would
   * have to be reasoned about alongside it.
   */
  sticky?: boolean
}) {
  return (
    <div
      data-month={month}
      className={cx(
        'flex items-baseline justify-between gap-3',
        dense ? '' : 'mb-2 px-1',
        // An opaque background, for the same reason `table.pinned` needs one:
        // the rows scrolling underneath are otherwise plainly readable through
        // it. The negative margin plus padding lets that background reach the
        // full width of the list rather than stopping at the text.
        sticky && 'sticky top-0 z-20 -mx-1 bg-page/95 px-2 py-1.5 backdrop-blur-sm',
      )}
    >
      <h2 className={cx('font-semibold', dense ? 'text-xs uppercase tracking-wide text-ink-2' : 'text-base')}>
        {monthLabel(month)}
      </h2>
      {stats && (
        <p className="shrink-0 text-xs text-ink-3 tabular">
          {stats.spendMinor > 0 && `${money(stats.spendMinor)} spent`}
          {/* The row count used to be a line of its own above the list, saying
              the same thing about the whole filtered set. On a phone it belongs
              here, where the heading is already carrying the month's figures
              and is already stuck to the top of the screen. */}
          {sticky && (
            <span className={stats.spendMinor > 0 ? 'before:content-["_·_"]' : undefined}>
              {stats.count} row{stats.count === 1 ? '' : 's'}
            </span>
          )}
        </p>
      )}
    </div>
  )
}

/* ---------- Toolbar controls ---------- */
/*
 * Each of these renders as a `CONTROL_H` toolbar button on a wide screen and as
 * a chip in the phone's `FilterBar`. Same panel either way — what changes is
 * only what you press to open it, so the two form factors cannot drift apart in
 * behaviour, only in size.
 */
type Variant = 'control' | 'chip'

/** The wide-screen trigger: a `CONTROL_H` button matching the search box beside it. */
function ControlTrigger({
  label,
  icon,
  open,
  toggle,
}: {
  label: ReactNode
  icon: ReactNode
  open: boolean
  toggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      className={cx(
        CONTROL_H,
        'flex max-w-52 items-center gap-1.5 rounded-xl bg-surface-2 px-3 text-sm font-medium text-ink-2',
        'transition-colors hover:text-ink desktop:px-2.5 md:rounded-lg',
      )}
    >
      <span className="shrink-0 text-ink-3">{icon}</span>
      <span className="truncate">{label}</span>
      <ChevronDown size={14} className={cx('shrink-0 text-ink-3 transition-transform', open && 'rotate-180')} />
    </button>
  )
}

/**
 * Search, which is an icon until it is wanted.
 *
 * It expands inside the bar rather than replacing it: the other chips are still
 * there, scrolled off to the right, so a search never hides what is filtering
 * the results it returns. A chip bar that has to become a different bar to take
 * a query is two bars.
 *
 * A query keeps it open, because collapsing a field that is still narrowing the
 * list would hide the reason the list is short.
 */
function SearchChip({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const showing = open || value.length > 0

  if (!showing) {
    return (
      <FilterChip
        aria-label="Search transactions"
        chevron={false}
        icon={<Search size={16} />}
        onClick={() => {
          setOpen(true)
          // After the field exists. The focus is what puts the keyboard up, so
          // it has to happen from the same tap rather than on a later effect.
          setTimeout(() => input.current?.focus(), 30)
        }}
      />
    )
  }

  return (
    <div className="relative flex h-9 min-w-52 flex-1 shrink-0 items-center">
      <Search size={15} className="pointer-events-none absolute left-3 text-ink-3" />
      <input
        ref={input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search transactions"
        aria-label="Search transactions"
        className="h-9 w-full rounded-full bg-surface-2 pl-9 pr-9 text-sm text-ink outline-none ring-1 ring-transparent transition-shadow placeholder:text-ink-3 focus:ring-2 focus:ring-accent/60"
      />
      <button
        type="button"
        aria-label="Close search"
        onClick={() => {
          onChange('')
          setOpen(false)
        }}
        className="absolute right-2 grid size-6 place-items-center rounded-full text-ink-3 hover:text-ink"
      >
        <X size={14} />
      </button>
    </div>
  )
}

/**
 * How a set of chosen categories reads in a sentence or on a control.
 *
 * Naming one is worth far more than counting it — "Groceries" tells you why the
 * list is short, "1 category" tells you only that it is — so a single choice is
 * always spelled out and everything past that counts.
 */
function catLabel(value: Set<string> | null, byId: Map<string, Category>, empty = 'every category') {
  if (value === null) return empty
  // Not the same as `null`, and it must not read as it: an empty set is a
  // deliberate "none of them", reached by unticking "All categories". Labelling
  // that "All categories" over an empty list is the control disagreeing with
  // the screen.
  if (value.size === 0) return 'No categories'
  if (value.size === 1) {
    const only = [...value][0]
    return byId.get(only)?.name ?? 'one category'
  }
  return `${value.size} categories`
}

/**
 * Which categories the list is narrowed to.
 *
 * Several at once, because the questions people bring here are plural — "what
 * did the car and the house cost us this year" is one question, and it used to
 * be two passes over the same screen with the answer added up by hand.
 *
 * `null` rather than "every id ticked" is the resting state, the same as
 * `AccountFilter` and for the same reason: a category invented next week then
 * appears in the list instead of being silently excluded by a set written
 * before it existed.
 *
 * Top-level only, matching the picker and the way budgets count — choosing a
 * parent takes its subcategories with it.
 */
function CategoryFilter({
  parents,
  value,
  onChange,
  variant = 'control',
}: {
  parents: Category[]
  value: Set<string> | null
  onChange: (next: Set<string> | null) => void
  variant?: Variant
}) {
  const byId = useMemo(() => new Map(parents.map((c) => [c.id, c])), [parents])
  const label = catLabel(value, byId, variant === 'chip' ? 'Category' : 'All categories')
  const only = value?.size === 1 ? byId.get([...value][0]) : undefined
  const icon = only ? <CategoryIcon icon={only.icon} size={15} /> : <Shapes size={15} />

  function toggle(id: string) {
    const next = new Set(value ?? parents.map((c) => c.id))
    if (next.has(id)) next.delete(id)
    else next.add(id)
    // Everything ticked is `null` rather than a set of every id, so a category
    // invented next week is included instead of being silently excluded by a
    // set written before it existed. Nothing ticked is NOT folded back to
    // "all": it is a state you can mean, and the way to one category is to
    // clear them and pick it.
    onChange(next.size === parents.length ? null : next)
  }

  return (
    <Popover
      width="w-60"
      trigger={({ open, toggle: press }) =>
        variant === 'chip' ? (
          <FilterChip
            open={open}
            onClick={press}
            active={value !== null}
            onClear={value !== null ? () => onChange(null) : undefined}
            icon={icon}
            label={label}
          />
        ) : (
          <ControlTrigger label={label} icon={icon} open={open} toggle={press} />
        )
      }
    >
      {() => (
        // No `close` on a choice: picking several is the point, and a panel that
        // shut after the first one would make the second choice cost as much as
        // the first.
        <div className="max-h-72 overflow-y-auto">
          {/* A select-all that also deselects, which is the only way to reach
              ONE category without unticking eleven. Ticking a category from a
              standing start is one press; getting to a standing start used to
              be as many presses as you have categories. */}
          <button
            type="button"
            onClick={() => onChange(value === null ? new Set() : null)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
          >
            <Check size={15} className={cx('shrink-0', value === null ? 'text-accent' : 'opacity-0')} />
            <span className="font-medium">All categories</span>
            <span className="ml-auto shrink-0 text-xs text-ink-3">{value === null ? 'Clear' : 'Select all'}</span>
          </button>
          <div className="my-1 border-t border-hairline" />
          {parents.map((c) => {
            const on = value === null || value.has(c.id)
            return (
              <button
                type="button"
                key={c.id}
                onClick={() => toggle(c.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
              >
                <Check size={15} className={cx('shrink-0', on ? 'text-accent' : 'opacity-0')} />
                <span className="shrink-0" style={{ color: `var(--series-${c.slot})` }}>
                  <CategoryIcon icon={c.icon} size={15} />
                </span>
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </Popover>
  )
}

/**
 * Everything that is an action rather than a filter.
 *
 * One chip at the end of the bar, because importing a statement is something
 * you do twice a month and it was costing a full 44px row every other day.
 */
function MoreChip({ onImport }: { onImport: () => void }) {
  return (
    <Popover
      align="right"
      width="w-52"
      trigger={({ open, toggle }) => (
        <FilterChip aria-label="More" chevron={false} open={open} onClick={toggle} icon={<MoreHorizontal size={17} />} />
      )}
    >
      {(close) => (
        <button
          type="button"
          onClick={() => {
            onImport()
            close()
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
        >
          <Upload size={15} className="shrink-0 text-ink-3" /> Import CSV
        </button>
      )}
    </Popover>
  )
}

/**
 * One account, several, or all of them.
 *
 * `null` rather than "every id ticked" is the resting state on purpose: an
 * account added later, or one shared with you tomorrow, then appears in the
 * list instead of being silently excluded by a set written before it existed.
 */
function AccountFilter({
  accounts,
  value,
  onChange,
  variant = 'control',
}: {
  accounts: { id: string; name: string }[]
  value: Set<string> | null
  onChange: (next: Set<string> | null) => void
  variant?: Variant
}) {
  const label =
    value === null
      ? variant === 'chip'
        ? 'Accounts'
        : 'All accounts'
      : value.size === 1
        ? (accounts.find((a) => value.has(a.id))?.name ?? '1 account')
        : `${value.size} accounts`

  function toggle(id: string) {
    const next = new Set(value ?? accounts.map((a) => a.id))
    if (next.has(id)) next.delete(id)
    else next.add(id)
    // Back to "all" at both ends: everything ticked means the same thing, and
    // nothing ticked is a list of no transactions nobody asked for.
    onChange(next.size === 0 || next.size === accounts.length ? null : next)
  }

  return (
    <Popover
      width="w-64"
      trigger={({ open, toggle: press }) =>
        variant === 'chip' ? (
          <FilterChip
            open={open}
            onClick={press}
            active={value !== null}
            onClear={value !== null ? () => onChange(null) : undefined}
            icon={<Wallet size={15} />}
            label={label}
          />
        ) : (
          <ControlTrigger label={label} icon={<Wallet size={15} />} open={open} toggle={press} />
        )
      }
    >
      {() => (
        <div className="max-h-72 overflow-y-auto">
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
          >
            <Check size={15} className={cx('shrink-0', value === null ? 'text-accent' : 'opacity-0')} />
            <span className="font-medium">All accounts</span>
          </button>
          <div className="my-1 border-t border-hairline" />
          {accounts.map((a) => {
            const on = value === null || value.has(a.id)
            return (
              <button
                type="button"
                key={a.id}
                onClick={() => toggle(a.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
              >
                <Check size={15} className={cx('shrink-0', on ? 'text-accent' : 'opacity-0')} />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </Popover>
  )
}

/**
 * Where you are, and a way to be somewhere else.
 *
 * Only months that actually have rows under the current filters are pickable —
 * offering an empty month would scroll to a heading that is not rendered.
 */
function MonthJump({
  current,
  months,
  onPick,
  variant = 'control',
}: {
  current: string | null
  months: Map<string, { at: number }>
  onPick: (month: string) => void
  variant?: Variant
}) {
  const keys = useMemo(() => [...months.keys()].sort(), [months])
  const newest = keys[keys.length - 1] ?? thisMonthKey()
  const oldest = keys[0] ?? newest
  const [year, setYear] = useState(() => Number((current ?? newest).slice(0, 4)))

  // Follow the list when it is scrolled rather than driven — reopening the
  // panel after scrolling back two years should not start at this year.
  useEffect(() => {
    if (current) setYear(Number(current.slice(0, 4)))
  }, [current])

  const firstYear = Number(oldest.slice(0, 4))
  const lastYear = Number(newest.slice(0, 4))
  const label = current ? monthLabel(current) : 'Jump to'
  const icon = <CalendarDays size={15} />

  return (
    <Popover
      width="w-64"
      trigger={({ open, toggle }) =>
        variant === 'chip' ? (
          // Never "active": this moves you through the list rather than
          // narrowing it, so a dark fill would say something untrue about why
          // the list looks the way it does.
          <FilterChip open={open} onClick={toggle} icon={icon} label={label} />
        ) : (
          <ControlTrigger label={label} icon={icon} open={open} toggle={toggle} />
        )
      }
    >
      {(close) => (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setYear((y) => y - 1)}
              disabled={year <= firstYear}
              aria-label="Previous year"
              className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold tabular">{year}</span>
            <button
              type="button"
              onClick={() => setYear((y) => y + 1)}
              disabled={year >= lastYear}
              aria-label="Next year"
              className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {Array.from({ length: 12 }, (_, i) => {
              const key = `${year}-${String(i + 1).padStart(2, '0')}`
              const has = months.has(key)
              return (
                <button
                  type="button"
                  key={key}
                  disabled={!has}
                  onClick={() => {
                    onPick(key)
                    close()
                  }}
                  className={cx(
                    'rounded-lg py-1.5 text-sm font-medium transition-colors',
                    key === current
                      ? 'bg-accent text-accent-ink'
                      : has
                        ? 'text-ink-2 hover:bg-surface-2'
                        : 'text-ink-3/40',
                  )}
                >
                  {monthLabel(key, 'short').slice(0, 3)}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </Popover>
  )
}
