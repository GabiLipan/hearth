import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ScanLine } from 'lucide-react'
import { db, type Transaction } from '../lib/db'
import { useAccounts, useCategories, useMyLevels, useGrantsFor, useMemberMap } from '../lib/cache'
import { scanReceipt } from '../lib/receipt'
import { canAddTransactions, canEditTransaction, levelOn } from '../lib/accounts'
import { grouped, styleOf, usableOn } from '../lib/categories'
import { useSyncState } from '../hooks/useSync'
import { parseAmount, currencySymbol } from '../lib/money'
import { todayISO } from '../lib/dates'
import { learnRule, suggestCategory, prettyPayee } from '../lib/rules'
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
    if (kind === 'expense') void learnRule(payee, categoryId!)
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
      </fieldset>
    </Sheet>
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
