import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Transaction } from '../lib/db'
import { parseAmount, currencySymbol } from '../lib/money'
import { todayISO } from '../lib/dates'
import { learnRule, suggestCategory, prettyPayee } from '../lib/rules'
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
  const { currency } = useApp()
  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), []) ?? []
  const accounts = useLiveQuery(() => db.accounts.toArray(), []) ?? []
  const payees = useLiveQuery(async () => {
    const txns = await db.transactions.orderBy('date').reverse().limit(400).toArray()
    return [...new Set(txns.map((t) => prettyPayee(t.payee)))].slice(0, 60)
  }, []) ?? []

  const [kind, setKind] = useState<'expense' | 'income'>('expense')
  const [amount, setAmount] = useState('')
  const [payee, setPayee] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>()
  const [date, setDate] = useState(todayISO())
  const [accountId, setAccountId] = useState<number | undefined>()
  const [note, setNote] = useState('')
  const [suggested, setSuggested] = useState(false)
  const amountRef = useRef<HTMLInputElement>(null)

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
    if (editing) {
      await db.transactions.update(editing.id!, {
        amountMinor: signed,
        payee: payee.trim(),
        categoryId: categoryId!,
        date,
        accountId,
        note: note.trim() || undefined,
      })
    } else {
      await db.transactions.add({
        amountMinor: signed,
        payee: payee.trim(),
        categoryId: categoryId!,
        date,
        accountId,
        note: note.trim() || undefined,
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
            <Select value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value) || undefined)}>
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
                  await db.transactions.delete(editing.id!)
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
