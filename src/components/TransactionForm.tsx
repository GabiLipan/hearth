import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { ScanLine, ArrowLeftRight, CalendarClock } from 'lucide-react'
import { db, type Transaction } from '../lib/db'
import { useAccounts, useAccountMap, useBills, useCategories, useMyLevels, useGrantsFor, useMemberMap } from '../lib/cache'
import { findTransferCandidates, linkTransfer, unlinkTransfer } from '../lib/transfers'
import { unlinkBillPayment } from '../lib/bills'
import { syncNow } from '../lib/session'
import { scanReceipt } from '../lib/receipt'
import { canAddTransactions, canEditTransaction, levelOn } from '../lib/accounts'
import { grouped, styleOf, usableOn } from '../lib/categories'
import { useSyncState } from '../hooks/useSync'
import { parseAmount, currencySymbol } from '../lib/money'
import { todayISO } from '../lib/dates'
import { learnRule, suggestCategory, prettyPayee, similarTo, applyCategory } from '../lib/rules'
import { findLikelyDuplicate } from '../lib/dedupe'
import { fmtFullDate } from '../lib/dates'
import { create, update, remove } from '../lib/data'
import { useApp } from '../state/AppContext'
import { Sheet, Field, TextInput, Select, Segmented, Button, cx } from './ui'
import { CategoryIcon } from './CategoryIcon'

export function TransactionForm({
  open,
  onClose,
  editing,
}: {
  open: boolean
  onClose: () => void
  editing?: Transaction
}) {
  const { currency, money } = useApp()
  const { userId } = useSyncState()
  const categories = useCategories()
  const allAccounts = useAccounts()
  const levels = useMyLevels()
  const memberMap = useMemberMap()
  const accounts = useMemo(
    () => allAccounts.filter((a) => canAddTransactions(levelOn(a.id, levels))),
    [allAccounts, levels],
  )
  const payees = useLiveQuery(async () => {
    const txns = await db.transactions.orderBy('date').reverse().limit(400).toArray()
    return [...new Set(txns.map((t) => prettyPayee(t.payee)))].slice(0, 60)
  }, []) ?? []

  const [kind, setKind] = useState<'expense' | 'income'>('expense')
  const [amount, setAmount] = useState('')
  const [payee, setPayee] = useState('')
  const [categoryId, setCategoryId] = useState<string | undefined>()
  const [date, setDate] = useState(todayISO())
  const [accountId, setAccountId] = useState<string | undefined>()
  const [note, setNote] = useState('')
  const [suggested, setSuggested] = useState(false)
  const [applySimilar, setApplySimilar] = useState(false)
  const [scanState, setScanState] = useState<string | null>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const receiptRef = useRef<HTMLInputElement>(null)

  async function onReceiptPhoto(file: File) {
    setScanState('Reading receipt…')
    try {
      const guess = await scanReceipt(file, (pct) => setScanState(`Reading receipt… ${pct}%`), payees)
      if (guess.amountMinor) setAmount((guess.amountMinor / 100).toFixed(2))
      if (guess.payee) setPayee(guess.payee)
      if (guess.date) setDate(guess.date)
      setScanState(guess.amountMinor || guess.payee ? null : 'Could not read that photo — try a clearer shot.')
    } catch {
      setScanState('Scanning needs an internet connection the first time — try again online.')
    }
  }

  useEffect(() => {
    if (!open) return
    if (editing) {
      setKind(editing.amountMinor < 0 ? 'expense' : 'income')
      setAmount((Math.abs(editing.amountMinor) / 100).toFixed(2).replace(/\.00$/, ''))
      setPayee(editing.payee)
      setCategoryId(editing.categoryId)
      setDate(editing.date)
      setAccountId(editing.accountId)
      setNote(editing.note ?? '')
    } else {
      setKind('expense')
      setAmount('')
      setPayee('')
      setCategoryId(undefined)
      setDate(todayISO())
      setAccountId(accounts[0]?.id)
      setNote('')
      setTimeout(() => amountRef.current?.focus(), 60)
    }
    setSuggested(false)
    setApplySimilar(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing])

  // Auto-suggest a category as soon as we recognise the payee
  useEffect(() => {
    if (!open || editing || payee.trim().length < 3) return
    let cancelled = false
    const t = setTimeout(async () => {
      const id = await suggestCategory(payee)
      if (!cancelled && id && (categoryId === undefined || suggested)) {
        setCategoryId(id)
        setSuggested(true)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payee, open])

  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  /**
   * Whether this row is mine to change.
   *
   * At `contribute` you may edit what you added and nothing else, which is the
   * `transactions_update` policy exactly. The row stays open rather than being
   * hidden: hiding it would contradict the policy, which does let you READ it,
   * and a row that cannot be tapped reads as a bug rather than as a rule.
   */
  const editable = !editing || canEditTransaction(editing, levelOn(editing.accountId, levels), userId)
  const author = editing && !editable ? memberMap.get(editing.createdBy ?? '')?.displayName : undefined

  /**
   * What can be chosen here: the right kind, and — for a personal category —
   * only when recording against your own non-shared account, which is the rule
   * the database enforces. Offering one the server would reject would just be a
   * confusing failure at save time.
   */
  const accountGrants = useGrantsFor(accountId)
  const visibleGroups = useMemo(
    () => grouped(usableOn(categories, accountGrants, userId).filter((c) => c.kind === kind)),
    [categories, accountGrants, userId, kind],
  )

  // If the account changes to one where the chosen category is not allowed,
  // clear it rather than letting the save fail.
  useEffect(() => {
    if (!categoryId) return
    const stillAllowed = visibleGroups.some(
      (g) => g.parent.id === categoryId || g.children.some((c) => c.id === categoryId),
    )
    if (!stillAllowed) setCategoryId(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])
  /**
   * Other transactions from this payee that are filed somewhere else.
   *
   * Offered here, in the form, rather than as a "we noticed…" prompt after
   * saving. Categorising one pet insurance payment and being told about the
   * other eleven is useful; being told after the sheet has already closed, in a
   * second dialog, is an interruption — and the answer is much easier to give
   * while the category you just chose is still on screen.
   *
   * Filtered to what this device may actually change, so the number offered is
   * the number that will move. At `contribute` you may only edit what you
   * added, and a bulk update is the easiest possible way to queue a dozen
   * writes that dead-letter quietly a minute later.
   */
  const similar =
    useLiveQuery(async () => {
      if (!open || !categoryId || kind !== 'expense' || payee.trim().length < 3) return []
      const all = await db.transactions.toArray()
      return similarTo(payee, categoryId, all, editing?.id).filter((t) =>
        canEditTransaction(t, levelOn(t.accountId, levels), userId),
      )
      // `levels` is a fresh Map each render, so it is deliberately not a
      // dependency — the query re-runs on the inputs that change the answer.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, payee, categoryId, kind, editing?.id, userId]) ?? []

  const amountMinor = parseAmount(amount)
  const canSave = amountMinor !== null && amountMinor > 0 && payee.trim() && categoryId !== undefined && accountId !== undefined

  async function save() {
    if (!canSave) return
    const signed = kind === 'expense' ? -Math.abs(amountMinor!) : Math.abs(amountMinor!)
    if (!editing) {
      // Same amount, similar payee, within a few days — probably the same purchase.
      const existing = await db.transactions.toArray()
      const dup = findLikelyDuplicate({ date, payee: payee.trim(), amountMinor: signed }, existing)
      if (
        dup &&
        !confirm(
          `This looks like a duplicate of “${dup.payee}” (${money(dup.amountMinor)}) on ${fmtFullDate(dup.date)}. Add it anyway?`,
        )
      ) {
        return
      }
    }
    if (editing) {
      await update('transactions', editing.id, {
        amountMinor: signed,
        payee: payee.trim(),
        categoryId,
        date,
        accountId: accountId!,
        // Explicitly undefined rather than omitted: that is what clears the note
        // rather than leaving the old one in place (see mapping.ts).
        note: note.trim() || undefined,
      })
    } else {
      await create('transactions', {
        amountMinor: signed,
        payee: payee.trim(),
        categoryId,
        date,
        accountId: accountId!,
        note: note.trim() || undefined,
        createdBy: userId,
        createdAt: new Date().toISOString(),
      })
    }
    // The quiet automation: every save teaches the categoriser.
    if (kind === 'expense') {
      await learnRule(payee, categoryId!)
      // …and, if asked, applies what it just learned backwards. `similar` is
      // already filtered to what this device may change, so the predicate here
      // passes everything through.
      if (applySimilar && similar.length > 0) await applyCategory(similar, categoryId!, () => true)
    }
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit transaction' : 'Add transaction'}
      footer={
        !editable ? (
          <p className="text-sm text-ink-3">
            {author
              ? `Added by ${author}. Only ${author}, or someone who manages this account, can change it.`
              : 'Added by someone who has left the household. Only someone who manages this account can change it.'}
          </p>
        ) : (
        <div className="flex gap-2">
          {editing && (
            <Button
              variant="danger"
              size="lg"
              onClick={async () => {
                if (confirm('Delete this transaction?')) {
                  await remove('transactions', editing.id)
                  onClose()
                }
              }}
            >
              Delete
            </Button>
          )}
          <Button size="lg" className="flex-1" disabled={!canSave} onClick={save}>
            {editing ? 'Save changes' : 'Add transaction'}
          </Button>
        </div>
        )
      }
    >
      <fieldset disabled={!editable} className="space-y-4 disabled:opacity-60">
        <Segmented
          value={kind}
          onChange={(k) => {
            setKind(k)
            setCategoryId(undefined)
          }}
          options={[
            { value: 'expense', label: 'Expense' },
            { value: 'income', label: 'Income' },
          ]}
        />

        <div className="flex items-center justify-center gap-1 py-2">
          <span className="text-3xl font-semibold text-ink-3">{currencySymbol(currency)}</span>
          <input
            ref={amountRef}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            aria-label="Amount"
            className="w-44 bg-transparent text-center text-5xl font-bold tracking-tight outline-none placeholder:text-ink-3/40 tabular"
          />
        </div>

        {kind === 'expense' && !editing && (
          <div className="flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => receiptRef.current?.click()}
              disabled={scanState?.startsWith('Reading')}
              className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3.5 py-1.5 text-sm font-medium text-ink-2 transition hover:text-ink disabled:opacity-60"
            >
              <ScanLine size={15} /> {scanState?.startsWith('Reading') ? scanState : 'Scan a receipt'}
            </button>
            {scanState && !scanState.startsWith('Reading') && <p className="text-xs text-ink-3">{scanState}</p>}
            <input
              ref={receiptRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void onReceiptPhoto(f)
              }}
            />
          </div>
        )}

        <Field label={kind === 'expense' ? 'Where did you spend?' : 'Where from?'}>
          <TextInput
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            placeholder={kind === 'expense' ? 'e.g. Tesco' : 'e.g. Salary'}
            list="payee-suggestions"
            autoComplete="off"
          />
          <datalist id="payee-suggestions">
            {payees.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Field>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-2">
            Category
            {suggested && <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">auto-suggested</span>}
          </span>
          {/* Groups flow and wrap rather than taking a line each — a category
              with no children is a small chip, and a column of them down the
              left is mostly empty sheet. The wider gap between groups is what
              keeps a parent and its children reading as one thing. */}
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            {visibleGroups.map(({ parent, children }) => (
              <div key={parent.id} className="flex flex-wrap items-center gap-1.5">
                <CategoryChip
                  category={parent}
                  style={styleOf(parent, catMap)}
                  selected={categoryId === parent.id}
                  onSelect={() => {
                    setCategoryId(parent.id)
                    setSuggested(false)
                  }}
                />
                {/* Children sit on the same line as their parent, so picking the
                    more specific one is a nudge rather than a separate step. */}
                {children.map((child) => (
                  <CategoryChip
                    key={child.id}
                    category={child}
                    style={styleOf(child, catMap)}
                    child
                    selected={categoryId === child.id}
                    onSelect={() => {
                      setCategoryId(child.id)
                      setSuggested(false)
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        {similar.length > 0 && (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-accent/8 px-4 py-3 ring-1 ring-accent/20">
            <input
              type="checkbox"
              checked={applySimilar}
              onChange={(e) => setApplySimilar(e.target.checked)}
              className="mt-0.5 size-5 shrink-0 accent-[var(--accent)]"
            />
            <span className="min-w-0 text-sm">
              <span className="font-medium">
                Move {similar.length} other {similar.length === 1 ? 'transaction' : 'transactions'} here too
              </span>
              <span className="mt-0.5 block text-xs text-ink-3">
                {similar.length === 1 ? 'One is' : `${similar.length} are`} from “{prettyPayee(payee)}” and filed
                somewhere else. There is more in{' '}
                <Link to="/settings/rules" className="underline underline-offset-2">
                  Settings › Rules
                </Link>
                .
              </span>
            </span>
          </label>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Account">
            <Select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || undefined)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Note (optional)">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to remember" />
        </Field>

        {editing && editable && <Linkage txn={editing} onDone={onClose} />}
      </fieldset>
    </Sheet>
  )
}

/**
 * What else this transaction is part of, and how to change your mind.
 *
 * Three states, and only ever one of them at a time — the server refuses to let
 * a row be both a bill payment and a transfer:
 *
 *   - recorded against a bill  → release it, freeing that occurrence
 *   - one leg of a transfer    → split it back into two ordinary transactions
 *   - neither                  → pair it with its other half by hand
 *
 * The manual pairing is what makes "Never" a usable answer to the transfer
 * setting rather than just switching the feature off. It searches a wider date
 * window than the automatic detector and ignores dismissals: you have asked, so
 * the app should stop being cautious on your behalf.
 */
function Linkage({ txn, onDone }: { txn: Transaction; onDone: () => void }) {
  const { money } = useApp()
  const { userId } = useSyncState()
  const levels = useMyLevels()
  const accMap = useAccountMap()
  const bills = useBills()
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)

  const partners =
    useLiveQuery(async () => {
      if (!picking) return []
      const all = await db.transactions.toArray()
      return findTransferCandidates(all, { maxDaysApart: 10 })
        .filter((c) => c.out.id === txn.id || c.in.id === txn.id)
        .filter(
          (c) =>
            canEditTransaction(c.out, levelOn(c.out.accountId, levels), userId) &&
            canEditTransaction(c.in, levelOn(c.in.accountId, levels), userId),
        )
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [picking, txn.id, userId]) ?? []

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
      await syncNow()
      onDone()
    }
  }

  if (txn.billId) {
    const bill = bills.find((b) => b.id === txn.billId)
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-4 py-3">
        <CalendarClock size={16} className="shrink-0 text-ink-3" />
        <p className="min-w-0 flex-1 text-sm">
          Recorded as a payment of <span className="font-medium">{bill?.name ?? 'a bill'}</span>.
        </p>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void run(() => unlinkBillPayment(txn.id))}
        >
          Not that bill
        </Button>
      </div>
    )
  }

  if (txn.transferId) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-4 py-3">
        <ArrowLeftRight size={16} className="shrink-0 text-ink-3" />
        <p className="min-w-0 flex-1 text-sm">
          One side of a transfer between your accounts, so it counts as neither spending nor income.
        </p>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void run(() => unlinkTransfer(txn.transferId!))}
        >
          Not a transfer
        </Button>
      </div>
    )
  }

  if (!picking) {
    return (
      <button
        type="button"
        onClick={() => setPicking(true)}
        className="flex w-full items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-left text-sm text-ink-2 transition hover:text-ink"
      >
        <ArrowLeftRight size={16} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">This was a transfer between my accounts</span>
      </button>
    )
  }

  return (
    <div className="space-y-2 rounded-xl bg-surface-2 px-4 py-3">
      <p className="text-sm text-ink-2">
        {partners.length === 0
          ? 'No matching payment found in another account. The other side has to be the exact same amount, within ten days, and not already spoken for.'
          : 'Pick the other side. Both will drop out of your spending and income totals.'}
      </p>
      {partners.map((c) => {
        const other = c.out.id === txn.id ? c.in : c.out
        return (
          <button
            key={other.id}
            type="button"
            disabled={busy}
            onClick={() => void run(() => linkTransfer(c.out.id, c.in.id))}
            className="flex w-full items-center gap-2.5 rounded-lg bg-surface px-3 py-2 text-left ring-1 ring-hairline transition hover:ring-accent/50 disabled:opacity-60"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {accMap.get(other.accountId)?.name ?? 'Unknown account'}
              </span>
              <span className="block truncate text-xs text-ink-3">
                {other.payee} · {fmtFullDate(other.date)}
              </span>
            </span>
            <span className="shrink-0 text-sm font-semibold tabular">{money(other.amountMinor, { sign: true })}</span>
          </button>
        )
      })}
      <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>
        Cancel
      </Button>
    </div>
  )
}

function CategoryChip({
  category, style, selected, child, onSelect,
}: {
  category: { id: string; name: string }
  style: { icon: string; slot: number }
  selected: boolean
  child?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cx(
        'flex items-center gap-1.5 rounded-full font-medium ring-1 transition',
        child ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm',
        selected
          ? 'bg-accent text-accent-ink ring-accent'
          : 'bg-surface-2 text-ink-2 ring-transparent hover:ring-hairline',
      )}
    >
      <CategoryIcon icon={style.icon} size={child ? 14 : 16} /> {category.name}
    </button>
  )
}
