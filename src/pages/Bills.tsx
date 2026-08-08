import { Fragment, useEffect, useMemo, useState } from 'react'
import { Plus, Check, SkipForward, Wand2, CalendarClock, Link2 } from 'lucide-react'
import type { Bill, BillFreq } from '../lib/db'
import { create, update, remove as removeRow } from '../lib/data'
import { useAccounts, useAllTransactions, useBills, useBook, useBooks, useCategories, useCategoryMap, useMyLevels } from '../lib/cache'
import { canAddTransactions, levelOn } from '../lib/accounts'
import { accountsInBook, BOOK_LABEL, type BookId, type BookMap } from '../lib/books'
import { syncNow } from '../lib/session'
import { daysUntil, fmtDay, fmtFullDate, FREQ_LABEL, monthlyEquivalent, todayISO } from '../lib/dates'
import {
  postBill,
  skipBill,
  detectBillSuggestions,
  detectBillPayments,
  dismissBillMatch,
  linkBillPayment,
  dueAfter,
  type BillMatch,
  type BillSuggestion,
} from '../lib/bills'
import { parseAmount, currencySymbol } from '../lib/money'
import { useApp } from '../state/AppContext'
import { Card, CategoryDot, Sheet, Button, Field, TextInput, Select, Empty, Toolbar, table, ScrollTable, cx } from '../components/ui'
import { CategoryIcon } from '../components/CategoryIcon'
import { BookSwitcher } from '../components/BookSwitcher'

/** Secondary bill lists fill the viewport in columns rather than stacking. */
const SIDE_GRID = 'grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,20rem),1fr))] md:gap-1.5'

function DueChip({ dateISO }: { dateISO: string }) {
  const days = daysUntil(dateISO)
  const label = days < 0 ? `${-days}d overdue` : days === 0 ? 'Due today' : days === 1 ? 'Tomorrow' : days <= 7 ? `In ${days} days` : fmtFullDate(dateISO)
  const tone =
    days < 0
      ? 'bg-critical/12 text-critical-text'
      : days <= 3
        ? 'bg-warning/20 text-ink'
        : 'bg-surface-2 text-ink-2'
  return (
    <span className={cx('inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium desktop:py-0.5', tone)}>
      {label}
    </span>
  )
}

/**
 * The bills cut into books, for the `Everything` view.
 *
 * Anything on an account in neither book — one somebody has shared with me —
 * gets its own section rather than being folded into either, for the same
 * reason `classifyAccounts` keeps `others` separate: it is not the household's
 * and it is not mine.
 *
 * A heading is only worth showing where there is something to tell apart, so a
 * lone section comes back unlabelled.
 */
function splitByBook(bills: Bill[], book: BookId, books: BookMap): { key: string; label?: string; bills: Bill[] }[] {
  if (book !== 'all') return [{ key: book, bills }]
  const parts = [
    { key: 'household', label: BOOK_LABEL.household, bills: bills.filter((b) => books.household.has(b.accountId)) },
    { key: 'mine', label: BOOK_LABEL.mine, bills: bills.filter((b) => books.mine.has(b.accountId)) },
    { key: 'others', label: 'Shared with me', bills: bills.filter((b) => books.others.has(b.accountId)) },
  ].filter((p) => p.bills.length > 0)
  return parts.length > 1 ? parts : parts.map((p) => ({ ...p, label: undefined }))
}

export default function Bills() {
  const { money } = useApp()
  const bills = useBills()
  const catMap = useCategoryMap()
  const books = useBooks()
  const [book, setBook] = useBook()
  const [editing, setEditing] = useState<Bill | 'new' | null>(null)
  /**
   * Bumped every time the form is opened, and used as its key.
   *
   * The form loads its fields straight from the row it is given, so it has to
   * be a fresh component each time one is opened — but keying it on the row
   * meant it also remounted on *close*, which threw the sheet away before it
   * could animate out. A counter changes when a form opens and never when it
   * closes, which is exactly the distinction wanted.
   */
  const [opened, setOpened] = useState(0)
  const openForm = (what: Bill | 'new') => {
    setEditing(what)
    setOpened((n) => n + 1)
  }
  const [suggestions, setSuggestions] = useState<BillSuggestion[]>([])
  const txns = useAllTransactions()

  useEffect(() => {
    void detectBillSuggestions().then(setSuggestions)
  }, [bills.length, txns])

  /**
   * Payments already in the account that satisfy a bill nobody has recorded.
   *
   * Recomputed when the bills or the transactions change, which covers the case
   * this exists for: importing a statement, and every tracked bill in it going
   * from "overdue" to "here is the payment, is this it?".
   */
  const [matches, setMatches] = useState<BillMatch[]>([])
  useEffect(() => {
    void detectBillPayments().then(setMatches)
  }, [bills, txns])

  /**
   * Linking happens on the server, so the local transaction keeps `billId`
   * undefined until the next pull lands — and until then the match would still
   * be offered. Dropping it here is what makes the row disappear on the tap
   * rather than up to a minute later.
   */
  async function reconcile(m: BillMatch) {
    setMatches((list) => list.filter((x) => x.txn.id !== m.txn.id))
    try {
      await linkBillPayment(m.bill.id, m.txn.id, m.dueOn)
    } finally {
      await syncNow()
    }
  }

  async function reconcileAll(inView: BillMatch[]) {
    // Oldest first, which detectBillPayments already guarantees: each link walks
    // `next_due` forward from where the last one left it. Only what is on
    // screen: "Record all" under one book must not quietly settle bills in
    // another that this view never showed.
    const list = [...inView]
    const ids = new Set(list.map((m) => m.txn.id))
    setMatches((all) => all.filter((m) => !ids.has(m.txn.id)))
    for (const m of list) {
      try {
        await linkBillPayment(m.bill.id, m.txn.id, m.dueOn)
      } catch {
        // Usually the other device claimed the occurrence first. The next pull
        // settles it either way.
      }
    }
    await syncNow()
  }

  async function dismissMatch(m: BillMatch) {
    setMatches((list) => list.filter((x) => x.txn.id !== m.txn.id))
    await dismissBillMatch(m)
  }

  /**
   * Which book a bill belongs to is decided by the account it leaves — rent
   * from the joint account is the household's, a subscription from my own is
   * mine. Nothing to configure, and nothing that can disagree with the
   * permissions: the same bargain `classifyAccounts` makes.
   *
   * A book's bills are not a subset of "all the bills" in any useful sense. The
   * monthly total under `Our household` is what the household costs to run, and
   * folding my music subscription into it makes that figure answer nobody's
   * question.
   */
  const inBook = useMemo(() => accountsInBook(book, books), [book, books])
  const inThisBook = useMemo(() => bills.filter((b) => inBook.has(b.accountId)), [bills, inBook])

  const active = inThisBook.filter((b) => b.active).sort((a, b) => a.nextDue.localeCompare(b.nextDue))
  const paused = inThisBook.filter((b) => !b.active)
  const monthlyTotal = active.reduce((s, b) => s + monthlyEquivalent(-b.amountMinor, b.freq), 0)

  /**
   * Under one book the list is simply that book's bills. Under `Everything` it
   * is split, because a flat list of the lot is what this page did before —
   * rent and a music subscription in one column with one total under them,
   * which is two different questions added together.
   */
  const sections = useMemo(() => splitByBook(active, book, books), [active, book, books])

  /**
   * The two derived lists follow the same lens.
   *
   * "N of these look already paid" has to mean the bills actually on screen, or
   * the banner is pointing at rows that are not there — and a suggestion to
   * track a personal subscription does not belong under the household's costs.
   * Neither is hidden for good: `Everything` shows the lot.
   */
  const bookMatches = useMemo(() => matches.filter((m) => inBook.has(m.bill.accountId)), [matches, inBook])
  const bookSuggestions = useMemo(() => suggestions.filter((s) => inBook.has(s.accountId)), [suggestions, inBook])

  return (
    <div>
      <Toolbar className="justify-between">
        <div className="min-w-0 md:flex md:items-baseline md:gap-2">
          <p className="text-sm text-ink-3 md:order-2">
            {book === 'household'
              ? 'What the household costs · monthly equivalent'
              : book === 'mine'
                ? 'My own bills · monthly equivalent'
                : 'Recurring bills · monthly equivalent'}
          </p>
          <p className="text-3xl font-bold tracking-tight tabular md:order-1 md:text-xl">
            {money(Math.round(monthlyTotal))}
          </p>
        </div>
        <Button className="shrink-0" onClick={() => openForm('new')}>
          <Plus size={15} /> New bill
        </Button>
      </Toolbar>

      {/* A bill belongs to the account it leaves, so the lens that splits the
          reports splits these too. */}
      <Toolbar>
        <BookSwitcher book={book} onChange={setBook} className="w-full md:w-auto" />
      </Toolbar>

      {/* Placed above the bills, because it is the answer to the question the
          bills below are provoking: "why does this say overdue when I paid it?"
          Reading the explanation after the complaint is the wrong order. */}
      {bookMatches.length > 0 && (
        <Card className="mb-3 overflow-hidden md:mb-2.5">
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-good/8 px-4 py-2.5 md:px-3 md:py-2">
            <Check size={16} className="shrink-0 text-good-text" />
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-medium">
                {bookMatches.length === 1
                  ? 'One of these looks already paid'
                  : `${bookMatches.length} of these look already paid`}
              </span>
              <span className="text-ink-3">
                {' '}— payments already in your account, not yet recorded against the bill.
              </span>
            </p>
            {bookMatches.length > 1 && (
              <Button size="sm" variant="subtle" className="shrink-0" onClick={() => void reconcileAll(bookMatches)}>
                <Link2 size={14} /> Record all
              </Button>
            )}
          </div>
          <ul className="divide-y divide-hairline">
            {bookMatches.map((m) => (
              <li
                key={m.txn.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 md:px-3 desktop:py-2.5"
              >
                <CategoryDot
                  category={m.bill.categoryId ? catMap.get(m.bill.categoryId) : undefined}
                  size={32}
                  className="md:[--dot:26px]"
                />
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate font-medium md:text-sm">{m.bill.name}</p>
                  <p className="truncate text-sm text-ink-3 md:text-xs">
                    due {fmtFullDate(m.dueOn)} · paid {fmtDay(m.txn.date)} as “{m.txn.payee}”
                    {m.daysOff !== 0 && ` (${Math.abs(m.daysOff)}d ${m.daysOff < 0 ? 'early' : 'late'})`}
                  </p>
                </div>
                {/* The amount is shown whenever it differs, because "£142 not
                    £138" is exactly the case where the match might be wrong. */}
                <span className="shrink-0 text-sm font-semibold tabular">
                  {money(m.txn.amountMinor)}
                  {m.amountDeltaMinor !== 0 && (
                    <span className="ml-1.5 font-normal text-ink-3">
                      vs {money(m.bill.amountMinor)}
                    </span>
                  )}
                </span>
                <div className="flex shrink-0 gap-1.5">
                  <Button size="sm" variant="subtle" onClick={() => void reconcile(m)}>
                    That's it
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void dismissMatch(m)}>
                    No
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {active.length === 0 && paused.length === 0 ? (
        <Empty
          icon={CalendarClock}
          title={book === 'all' ? 'No recurring bills yet' : `Nothing in ${BOOK_LABEL[book].toLowerCase()} yet`}
          hint={
            book !== 'all' && bills.length > 0
              ? 'There are bills on other accounts — switch to Everything to see them.'
              : 'Add rent, utilities and subscriptions — Hearth tracks due dates and can record them automatically.'
          }
          action={
            <Button onClick={() => openForm('new')}>
              <Plus size={16} /> Add your first bill
            </Button>
          }
        />
      ) : (
        <>
          {/* Phone: a stacked, thumb-friendly list, one card per book. */}
          <div className="space-y-4 md:hidden">
            {sections.map((section) => (
              <div key={section.key}>
                {section.label && (
                  <p className="mb-1.5 px-1 text-sm font-semibold uppercase tracking-wide text-ink-3">{section.label}</p>
                )}
                <Card>
                  <ul className="divide-y divide-hairline">
                    {section.bills.map((b) => (
                      <li key={b.id} className="flex items-center gap-3 px-4 py-3">
                        <button onClick={() => openForm(b)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                          <CategoryDot category={b.categoryId ? catMap.get(b.categoryId) : undefined} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{b.name}</p>
                            <p className="text-sm text-ink-3">
                              {FREQ_LABEL[b.freq]}
                              {b.autoPost ? ' · auto-recorded' : ''}
                            </p>
                          </div>
                        </button>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          <span className="font-semibold tabular">{money(b.amountMinor)}</span>
                          <DueChip dateISO={b.nextDue} />
                        </div>
                        {!b.autoPost && (
                          <div className="flex shrink-0 flex-col gap-1.5">
                            <button
                              onClick={() =>
                                void postBill(b, daysUntil(b.nextDue) < 0 ? b.nextDue : todayISO()).then(() => syncNow())
                              }
                              title="Mark paid"
                              aria-label={`Mark ${b.name} paid`}
                              className="grid size-8 place-items-center rounded-full bg-good/12 text-good-text hover:bg-good/20"
                            >
                              <Check size={15} />
                            </button>
                            <button
                              onClick={() => void skipBill(b).then(() => syncNow())}
                              title="Skip this one"
                              aria-label={`Skip ${b.name}`}
                              className="grid size-8 place-items-center rounded-full bg-surface-2 text-ink-3 hover:text-ink"
                            >
                              <SkipForward size={15} />
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            ))}
          </div>

          {/* Desktop: the same bills as a table — every attribute gets a column
              instead of being stacked into a two-line row. */}
          <Card className="hidden overflow-hidden md:block">
            <ScrollTable minWidth={780}>
              <thead>
                <tr className={table.head}>
                  <th className={cx(table.th, 'min-w-40 pl-3', table.pinned)}>Bill</th>
                  <th className={cx(table.th, 'w-40')}>Category</th>
                  <th className={cx(table.th, 'w-32')}>Repeats</th>
                  <th className={cx(table.th, 'w-36')}>Next due</th>
                  <th className={cx(table.th, 'w-28 text-right')}>Amount</th>
                  <th className={cx(table.th, 'w-24 pr-3 text-right')}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sections.map((section) => (
                  <Fragment key={section.key}>
                    {/* One table rather than one per book: separate tables would
                        each work out their own column widths, and the names and
                        amounts would stop lining up down the page. */}
                    {section.label && (
                      <tr>
                        <td
                          colSpan={6}
                          className="border-b border-hairline bg-surface-2/40 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-2"
                        >
                          {section.label}
                        </td>
                      </tr>
                    )}
                    {section.bills.map((b) => {
                      const cat = b.categoryId ? catMap.get(b.categoryId) : undefined
                      return (
                        <tr key={b.id} className={table.row}>
                          <td className={cx(table.cell, 'pl-3 pr-3', table.pinned)}>
                            <button
                              onClick={() => openForm(b)}
                              className="block w-full truncate text-left font-medium hover:text-accent"
                            >
                              {b.name}
                            </button>
                          </td>
                          <td className={cx(table.cell, 'pr-3')}>
                            <span className="flex items-center gap-1.5 truncate text-ink-2">
                              <span
                                className="shrink-0"
                                style={{ color: cat ? `var(--series-${cat.slot})` : 'var(--ink-3)' }}
                              >
                                <CategoryIcon icon={cat?.icon} size={14} />
                              </span>
                              <span className="truncate">{cat?.name ?? '—'}</span>
                            </span>
                          </td>
                          <td className={cx(table.cell, 'whitespace-nowrap pr-3 text-ink-3')}>
                            {FREQ_LABEL[b.freq]}
                            {b.autoPost ? ' · auto' : ''}
                          </td>
                          <td className={cx(table.cell, 'pr-3')}>
                            <DueChip dateISO={b.nextDue} />
                          </td>
                          <td className={cx(table.cell, 'pr-3 text-right font-semibold tabular')}>
                            {money(b.amountMinor)}
                          </td>
                          <td className={cx(table.cell, 'pr-3')}>
                            {!b.autoPost && (
                              <div className="flex justify-end gap-1">
                                <button
                                  onClick={() =>
                                    void postBill(b, daysUntil(b.nextDue) < 0 ? b.nextDue : todayISO()).then(() =>
                                      syncNow(),
                                    )
                                  }
                                  title="Mark paid"
                                  aria-label={`Mark ${b.name} paid`}
                                  className="grid size-8 place-items-center rounded-full bg-good/12 text-good-text hover:bg-good/20 desktop:size-7"
                                >
                                  <Check size={14} />
                                </button>
                                <button
                                  onClick={() => void skipBill(b).then(() => syncNow())}
                                  title="Skip this one"
                                  aria-label={`Skip ${b.name}`}
                                  className="grid size-8 place-items-center rounded-full bg-surface-2 text-ink-3 hover:text-ink desktop:size-7"
                                >
                                  <SkipForward size={14} />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </ScrollTable>
          </Card>
        </>
      )}

      {bookSuggestions.length > 0 && (
        <>
          <p className="mb-2 mt-6 flex items-center gap-1.5 px-1 text-sm font-semibold uppercase tracking-wide text-ink-3 md:mb-1.5 md:mt-5 md:text-xs">
            <Wand2 size={14} /> Looks recurring
          </p>
          {/* Auto-filling track: these pack into columns on a wide screen
              instead of each taking a full row. */}
          <div className={SIDE_GRID}>
            {bookSuggestions.map((s) => (
              <div
                key={s.payee}
                className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3 ring-1 ring-hairline md:gap-2 md:rounded-xl desktop:px-2.5 desktop:py-2"
              >
                <CategoryDot category={s.categoryId ? catMap.get(s.categoryId) : undefined} size={32} className="md:[--dot:24px]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium md:text-sm">{s.payee}</p>
                  <p className="truncate text-sm text-ink-3 md:text-xs">
                    {s.count}× {s.freq} · about {money(s.amountMinor)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="subtle"
                  className="shrink-0"
                  onClick={() =>
                    openForm({
                      name: s.payee,
                      payee: s.payee,
                      amountMinor: s.amountMinor,
                      categoryId: s.categoryId,
                      accountId: s.accountId,
                      freq: s.freq,
                      // One period on from the payment we can see, not today.
                      // "Next due today" on a bill that went out on the 4th is
                      // both wrong and instantly overdue, so the first thing a
                      // brand new bill did was tell you off about itself.
                      nextDue: dueAfter(s.lastDate, s.freq),
                      active: true,
                      autoPost: false,
                    } as Bill)
                  }
                >
                  Track
                </Button>
              </div>
            ))}
          </div>
        </>
      )}

      {paused.length > 0 && (
        <>
          <p className="mb-2 mt-6 px-1 text-sm font-semibold uppercase tracking-wide text-ink-3 md:mb-1.5 md:mt-5 md:text-xs">
            Paused
          </p>
          <div className={SIDE_GRID}>
            {paused.map((b) => (
              <button
                key={b.id}
                onClick={() => openForm(b)}
                className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3 text-left opacity-60 ring-1 ring-hairline transition hover:opacity-100 md:gap-2 md:rounded-xl desktop:px-2.5 desktop:py-2"
              >
                <CategoryDot category={b.categoryId ? catMap.get(b.categoryId) : undefined} size={32} className="md:[--dot:24px]" />
                <span className="min-w-0 flex-1 truncate font-medium md:text-sm">{b.name}</span>
                <span className="shrink-0 text-sm tabular md:text-xs">{money(b.amountMinor)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <BillForm
        key={opened}
        bill={editing === 'new' ? undefined : (editing ?? undefined)}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
    </div>
  )
}

function BillForm({ bill, open, onClose }: { bill?: Bill; open: boolean; onClose: () => void }) {
  const { currency } = useApp()
  const categories = useCategories()
  const allAccounts = useAccounts()
  const levels = useMyLevels()
  // A bill writes transactions, so the bar is 'contribute' — the same one the
  // transaction form uses. Anything looser offers accounts whose bills the
  // server would refuse to post.
  const accounts = useMemo(
    () => allAccounts.filter((a) => canAddTransactions(levelOn(a.id, levels))),
    [allAccounts, levels],
  )
  const expenseCats = categories.filter((c) => c.kind === 'expense')
  const [name, setName] = useState(bill?.name ?? '')
  const [payee, setPayee] = useState(bill?.payee ?? '')
  const [amount, setAmount] = useState(bill ? String(Math.abs(bill.amountMinor) / 100) : '')
  const [categoryId, setCategoryId] = useState<string | undefined>(bill?.categoryId)
  const [freq, setFreq] = useState<BillFreq>(bill?.freq ?? 'monthly')
  const [nextDue, setNextDue] = useState(bill?.nextDue ?? todayISO())
  // A bill is paid from an account, and every transaction it posts needs one.
  const [accountId, setAccountId] = useState<string | undefined>(bill?.accountId)
  const [autoPost, setAutoPost] = useState<boolean>(bill ? !!bill.autoPost : true)
  const [active, setActive] = useState<boolean>(bill ? !!bill.active : true)

  useEffect(() => {
    if (!accountId && accounts.length) setAccountId(accounts[0].id)
  }, [accounts, accountId])

  const minor = parseAmount(amount)
  const canSave = name.trim() && minor !== null && minor > 0 && categoryId !== undefined && nextDue && accountId

  async function save() {
    if (!canSave) return
    const data = {
      name: name.trim(),
      payee: payee.trim() || name.trim(),
      amountMinor: -Math.abs(minor!),
      categoryId,
      accountId: accountId!,
      freq,
      nextDue,
      active,
      autoPost,
    }
    if (bill?.id) await update('bills', bill.id, data)
    else await create('bills', data)
    onClose()
  }

  async function deleteBill() {
    if (bill?.id && confirm(`Delete "${bill.name}"? Past transactions are kept.`)) {
      await removeRow('bills', bill.id)
      onClose()
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={bill?.id ? 'Edit bill' : 'New bill'}
      footer={
        <div className="flex gap-2">
          {bill?.id && (
            <Button variant="danger" size="lg" onClick={deleteBill}>
              Delete
            </Button>
          )}
          <Button size="lg" className="flex-1" disabled={!canSave} onClick={save}>
            {bill?.id ? 'Save changes' : 'Add bill'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rent" />
          </Field>
          <Field label={`Amount (${currencySymbol(currency)})`}>
            <TextInput value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" />
          </Field>
        </div>
        <Field label="Category">
          <Select value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value || undefined)}>
            <option value="" disabled>
              Choose…
            </option>
            {expenseCats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Paid from">
          <Select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || undefined)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Repeats">
            <Select value={freq} onChange={(e) => setFreq(e.target.value as BillFreq)}>
              {Object.entries(FREQ_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Next due">
            <TextInput type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
          </Field>
        </div>
        <Field label="Statement text (optional)" hint="Helps match imported transactions to this bill.">
          <TextInput value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="e.g. OCTOPUS ENERGY" />
        </Field>
        <label className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3">
          <div>
            <p className="text-sm font-medium">Record automatically</p>
            <p className="text-xs text-ink-3">Adds the transaction on the due date, no tapping needed</p>
          </div>
          <input type="checkbox" checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} className="size-5 accent-[var(--accent)]" />
        </label>
        {bill?.id && (
          <label className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3">
            <p className="text-sm font-medium">Active</p>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5 accent-[var(--accent)]" />
          </label>
        )}
      </div>
    </Sheet>
  )
}
