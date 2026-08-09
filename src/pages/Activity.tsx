import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, Upload, Receipt, ChevronDown, ChevronLeft, ChevronRight, Wallet, CalendarDays, Check, X, ArrowLeftRight, HelpCircle, Layers } from 'lucide-react'
import type { Transaction } from '../lib/db'
import { useAccountMap, useAccounts, useAllTransactions, useBook, useBooks, useCategories, useCategoryMap, useGrantsByAccount, useMemberMap, useMyLevels } from '../lib/cache'
import { canAddTransactions, canEditTransaction, canSeeTransactionsAt, levelOn } from '../lib/accounts'

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
import { accountsInBook, BOOK_LABEL, type BookId } from '../lib/books'
import { askedOfMe, isAsking, looksLikeTransfer } from '../lib/unexplained'
import { fullName, isTopLevel, usableOn } from '../lib/categories'
import { thisMonthKey, monthLabel, monthKey, fmtDay, fmtFullDate } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { AccountDot, Card, CategoryDot, CONTROL_H, Empty, TextInput, Toolbar, Button, table, ScrollTable, cx } from '../components/ui'
import { CategoryIcon } from '../components/CategoryIcon'
import { BookSwitcher } from '../components/BookSwitcher'
import { TransactionForm } from '../components/TransactionForm'
import { ImportWizard } from '../components/ImportWizard'
import { TransferReview } from '../components/TransferReview'
import { nameOf } from '../components/PersonDot'
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
/** Roughly the mobile header's height: what a jumped-to heading must clear. */
const SCROLL_OFFSET = 76

export default function Activity() {
  const { money } = useApp()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState<string | null>(null)
  /** null = every account in the current book; a set = just those. */
  const [accountFilter, setAccountFilter] = useState<Set<string> | null>(null)
  /**
   * One month only, or the whole history. Empty by default — the point of the
   * list is that it runs — and set by a drill-through from Reports, where the
   * question genuinely is "which rows make up that figure".
   */
  const [monthFilter, setMonthFilter] = useState<string | null>(null)
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
    const category = params.get('category')
    const month = params.get('month')
    const from = params.get('book')
    if (category) setCatFilter(category)
    if (month) setMonthFilter(month)
    if (from === 'household' || from === 'mine' || from === 'all') setBook(from as BookId)
    setParams({}, { replace: true })
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

  // An account filter written under one book means nothing under another.
  useEffect(() => setAccountFilter(null), [book])

  const parents = useMemo(() => categories.filter(isTopLevel), [categories])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const visible = new Set(accounts.map((a) => a.id))
    const list = (txns ?? []).filter((t) => {
      if (!visible.has(t.accountId)) return false
      if (accountFilter && !accountFilter.has(t.accountId)) return false
      if (monthFilter && monthKey(t.date) !== monthFilter) return false
      if (catFilter !== null) {
        // The chips are top-level, so a subcategory counts towards its parent —
        // the same rule budgets use, and the rule the report slices are built on.
        const cat = t.categoryId ? catMap.get(t.categoryId) : undefined
        if (!cat || (cat.id !== catFilter && cat.parentId !== catFilter)) return false
      }
      if (q && !(t.payee.toLowerCase().includes(q) || (t.note ?? '').toLowerCase().includes(q))) return false
      return true
    })
    return list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  }, [txns, catFilter, catMap, accountFilter, monthFilter, accounts, query])

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
  const filterKey = `${query}|${catFilter}|${monthFilter}|${book}|${accountFilter ? [...accountFilter].sort().join(',') : 'all'}`
  useEffect(() => {
    setLimit(PAGE)
    window.scrollTo({ top: 0 })
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
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET, behavior: 'smooth' })
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
      let current: string | null = null
      for (const head of heads) {
        if (head.getBoundingClientRect().top <= SCROLL_OFFSET + 24) current = head.dataset.month ?? null
        else break
      }
      setAtMonth(current ?? heads[0]?.dataset.month ?? null)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
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
      <Toolbar>
        {/* Same lens as Reports, Home and Budgets. Activity is a ledger rather
            than an account of what happened, so `all` is a perfectly ordinary
            answer here — but "show me the joint account's rows" is the question
            behind most trips to this page. */}
        <BookSwitcher book={book} onChange={setBook} className="w-full md:w-auto" />

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

        <AccountFilter accounts={accounts} value={accountFilter} onChange={setAccountFilter} />
        {/* Nowhere to jump to inside a single month. */}
        {!monthFilter && <MonthJump current={atMonth} months={months} onPick={jumpTo} />}

        <Button variant="subtle" onClick={() => setImportOpen(true)}>
          <Upload size={15} /> Import CSV
        </Button>
        {filtered.length > 0 && (
          <p className="ml-auto hidden text-sm text-ink-3 md:block">
            {filtered.length} transaction{filtered.length === 1 ? '' : 's'}
          </p>
        )}
      </Toolbar>

      {/* Above the list, so both legs of a proposed pair are visible while you
          decide. It renders nothing at all when there is nothing to ask. */}
      <TransferReview />

      {/* The other half of the same problem. TransferReview offers pairs this
          device can see both sides of; this one carries the questions about
          rows it cannot. */}
      <AskedOfMe txns={txns ?? []} onOpen={setEditing} />

      {/* What a drill-through narrowed the list to, and the way back out of it.
          A filter this strong has to be visible: without the banner the page
          simply looks like a history that stops. */}
      {monthFilter && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-accent/8 px-4 py-2.5 ring-1 ring-accent/20 md:mb-2.5 md:py-2">
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{monthLabel(monthFilter)} only</span>
            <span className="text-ink-3">
              {' · '}
              {catFilter ? (catMap.get(catFilter)?.name ?? 'one category') : 'every category'}
              {book !== 'all' && ` · ${BOOK_LABEL[book]}`}
            </span>
          </p>
          <button
            onClick={() => {
              setMonthFilter(null)
              setCatFilter(null)
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-ink-2 ring-1 ring-hairline transition hover:text-ink"
          >
            <X size={12} /> Show everything
          </button>
        </div>
      )}

      {/* Category filter chips — top-level only, matching the picker. */}
      <div className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 py-1 md:mx-0 md:mb-2 md:flex-wrap md:gap-1.5 md:overflow-visible md:px-0">
        <button
          onClick={() => setCatFilter(null)}
          className={cx(
            'shrink-0 rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition desktop:px-2.5 desktop:py-0.5 md:text-xs',
            catFilter === null ? 'bg-ink text-page ring-ink' : 'bg-surface text-ink-2 ring-hairline hover:ring-ink-3/40',
          )}
        >
          All
        </button>
        {parents.map((c) => (
          <button
            key={c.id}
            onClick={() => setCatFilter(catFilter === c.id ? null : c.id)}
            className={cx(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition',
              'md:gap-1 desktop:px-2.5 desktop:py-0.5 md:text-xs',
              catFilter === c.id ? 'bg-ink text-page ring-ink' : 'bg-surface text-ink-2 ring-hairline hover:ring-ink-3/40',
            )}
          >
            <CategoryIcon icon={c.icon} size={14} /> {c.name}
          </button>
        ))}
      </div>

      {/* Phone-only summary line — desktop shows it in the toolbar. */}
      {filtered.length > 0 && (
        <p className="mb-2 px-1 text-sm text-ink-3 md:hidden">
          {filtered.length} transaction{filtered.length === 1 ? '' : 's'}
        </p>
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
              : searching || catFilter || accountFilter || monthFilter
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
                      <Card>
                        <ul className="divide-y divide-hairline">
                          {list.map((t) => {
                            const cat = t.categoryId ? catMap.get(t.categoryId) : undefined
                            const transfer = !!t.transferId
                            return (
                              <li key={t.id}>
                                <button
                                  onClick={() => setEditing(t)}
                                  className={cx(
                                    'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
                                    transfer ? 'tint-transfer' : 'hover:bg-surface-2/50 active:bg-surface-2',
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
                                    <AccountDot
                                      account={accMap.get(t.accountId)}
                                      size={16}
                                      className="absolute -bottom-0.5 -right-0.5 ring-2 ring-surface"
                                    />
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate font-medium">{t.payee}</p>
                                    <p className="flex items-center gap-1 truncate text-sm text-ink-3">
                                      {!transfer && (looksLikeTransfer(t) || isAsking(t)) && <MaybeTransfer txn={t} />}
                                      <span className="truncate">
                                        {transfer
                                          ? transferLine(t, partnerLeg.get(t.id), accMap)
                                          : cat
                                            ? fullName(cat, catMap)
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
                      return (
                        <tr
                          key={t.id}
                          onClick={() => setEditing(t)}
                          className={cx(table.row, 'cursor-pointer transition-colors', transfer && 'tint-transfer')}
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
                              transfer && 'tint-transfer',
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
                              <AccountDot account={acc} size={22} />
                              <span className="truncate">{acc?.name ?? '—'}</span>
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
   * `--header-h` is measured by Layout rather than guessed: the bar is a fixed
   * row plus the safe-area inset, which is a different number on a notched
   * phone, a flat one, and a browser tab. Sticking to a hard-coded offset
   * leaves the heading either overlapping the bar or floating below it.
   *
   * Sticky works here despite `main` carrying `overflow-x: clip` on mobile:
   * `clip` is the one overflow value that does NOT force the other axis to
   * become a scroll container, so the vertical axis stays `visible` and the
   * nearest scroller is still the viewport. Any other value there — `hidden`,
   * `auto` — and this silently stops moving.
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
      style={sticky ? { top: 'var(--header-h, 0px)' } : undefined}
      className={cx(
        'flex items-baseline justify-between gap-3',
        dense ? '' : 'mb-2 px-1',
        // An opaque background, for the same reason `table.pinned` needs one:
        // the rows scrolling underneath are otherwise plainly readable through
        // it. The negative margin plus padding lets that background reach the
        // full width of the list rather than stopping at the text.
        sticky && 'sticky z-20 -mx-1 bg-page/95 px-2 py-1.5 backdrop-blur-sm',
      )}
    >
      <h2 className={cx('font-semibold', dense ? 'text-xs uppercase tracking-wide text-ink-2' : 'text-base')}>
        {monthLabel(month)}
      </h2>
      {stats && stats.spendMinor > 0 && (
        <p className="shrink-0 text-xs text-ink-3 tabular">{money(stats.spendMinor)} spent</p>
      )}
    </div>
  )
}

/* ---------- Toolbar controls ---------- */

/**
 * A button that opens a panel under itself.
 *
 * Deliberately not a `Sheet`: these two are filters you adjust and re-adjust
 * while reading the list behind them, and a full-screen sheet for "tick two
 * accounts" hides the thing you are filtering.
 */
function Popover({
  label,
  icon,
  width,
  children,
}: {
  label: ReactNode
  icon: ReactNode
  /** Tailwind width class for the panel. */
  width: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    // Capture, so a click that lands on another control still closes this.
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
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
      {open && (
        <div
          className={cx(
            'animate-fade absolute left-0 top-full z-30 mt-1.5 rounded-xl bg-surface p-2 shadow-xl ring-1 ring-hairline',
            width,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
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
}: {
  accounts: { id: string; name: string }[]
  value: Set<string> | null
  onChange: (next: Set<string> | null) => void
}) {
  const label =
    value === null
      ? 'All accounts'
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
    <Popover label={label} icon={<Wallet size={15} />} width="w-64">
      {() => (
        <div className="max-h-72 overflow-y-auto">
          <button
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
}: {
  current: string | null
  months: Map<string, { at: number }>
  onPick: (month: string) => void
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

  return (
    <Popover label={current ? monthLabel(current) : 'Jump to'} icon={<CalendarDays size={15} />} width="w-64">
      {(close) => (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <button
              onClick={() => setYear((y) => y - 1)}
              disabled={year <= firstYear}
              aria-label="Previous year"
              className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold tabular">{year}</span>
            <button
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
