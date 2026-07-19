import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ScanLine } from 'lucide-react'
import { db, type Transaction } from '../lib/db'
import { scanReceipt } from '../lib/receipt'
import { canUseAccount } from '../lib/accounts'
import { useSyncState } from '../hooks/useSync'
import { parseAmount, currencySymbol } from '../lib/money'
import { todayISO } from '../lib/dates'
import { learnRule, suggestCategory, prettyPayee } from '../lib/rules'
import { findLikelyDuplicate } from '../lib/dedupe'
import { fmtFullDate } from '../lib/dates'
import { createRow, updateRow, removeRow, notDeleted } from '../lib/data'
import { useApp } from '../state/AppContext'
import { Sheet, Field, TextInput, Select, Segmented, Button, cx } from './ui'

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
  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').filter(notDeleted).toArray(), []) ?? []
  const allAccounts = useLiveQuery(() => db.accounts.filter(notDeleted).toArray(), []) ?? []
  const accounts = useMemo(() => allAccounts.filter((a) => canUseAccount(a, userId)), [allAccounts, userId])
  const payees = useLiveQuery(async () => {
    const txns = await db.transactions.orderBy('date').reverse().limit(400).filter(notDeleted).toArray()
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
      const guess = await scanReceipt(file, (pct) => setScanState(`Reading receipt… ${pct}%`))
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

  const visibleCategories = useMemo(() => categories.filter((c) => c.kind === kind), [categories, kind])
  const amountMinor = parseAmount(amount)
  const canSave = amountMinor !== null && amountMinor > 0 && payee.trim() && categoryId !== undefined

  async function save() {
    if (!canSave) return
    const signed = kind === 'expense' ? -Math.abs(amountMinor!) : Math.abs(amountMinor!)
    if (!editing) {
      // Same amount, similar payee, within a few days — probably the same purchase.
      const existing = await db.transactions.filter(notDeleted).toArray()
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
      await updateRow('transactions', editing.id!, {
        amountMinor: signed,
        payee: payee.trim(),
        categoryId: categoryId!,
        date,
        accountId,
        note: note.trim() || undefined,
      })
    } else {
      await createRow<Transaction>('transactions', {
        amountMinor: signed,
        payee: payee.trim(),
        categoryId: categoryId!,
        date,
        accountId,
        note: note.trim() || undefined,
        createdBy: userId,
        createdAt: Date.now(),
      })
    }
    // The quiet automation: every save teaches the categoriser.
    if (kind === 'expense') void learnRule(payee, categoryId!)
    onClose()
  }

  return (
    <Sheet open={open} onClose={onClose} title={editing ? 'Edit transaction' : 'Add transaction'}>
      <div className="space-y-4">
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
          <div className="flex flex-wrap gap-2">
            {visibleCategories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setCategoryId(c.id)
                  setSuggested(false)
                }}
                className={cx(
                  'flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium ring-1 transition',
                  categoryId === c.id
                    ? 'bg-accent text-accent-ink ring-accent'
                    : 'bg-surface-2 text-ink-2 ring-transparent hover:ring-hairline',
                )}
              >
                <span aria-hidden>{c.emoji}</span> {c.name}
              </button>
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

        <div className="flex gap-2">
          {editing && (
            <Button
              variant="danger"
              size="lg"
              onClick={async () => {
                if (confirm('Delete this transaction?')) {
                  await removeRow('transactions', editing.id!)
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
      </div>
    </Sheet>
  )
}
