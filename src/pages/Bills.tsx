import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Plus, Check, SkipForward, Wand2 } from 'lucide-react'
import { db, type Bill, type BillFreq } from '../lib/db'
import { daysUntil, fmtFullDate, FREQ_LABEL, monthlyEquivalent, todayISO } from '../lib/dates'
import { postBill, skipBill, detectBillSuggestions, type BillSuggestion } from '../lib/bills'
import { parseAmount, currencySymbol } from '../lib/money'
import { useApp } from '../state/AppContext'
import { Card, CategoryDot, Sheet, Button, Field, TextInput, Select, Empty, cx } from '../components/ui'

function DueChip({ dateISO }: { dateISO: string }) {
  const days = daysUntil(dateISO)
  const label = days < 0 ? `${-days}d overdue` : days === 0 ? 'Due today' : days === 1 ? 'Tomorrow' : days <= 7 ? `In ${days} days` : fmtFullDate(dateISO)
  const tone =
    days < 0
      ? 'bg-critical/12 text-critical-text'
      : days <= 3
        ? 'bg-warning/20 text-ink'
        : 'bg-surface-2 text-ink-2'
  return <span className={cx('rounded-full px-2.5 py-1 text-xs font-medium', tone)}>{label}</span>
}

export default function Bills() {
  const { money } = useApp()
  const bills = useLiveQuery(() => db.bills.toArray(), []) ?? []
  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), []) ?? []
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id!, c])), [categories])
  const [editing, setEditing] = useState<Bill | 'new' | null>(null)
  const [suggestions, setSuggestions] = useState<BillSuggestion[]>([])

  useEffect(() => {
    void detectBillSuggestions().then(setSuggestions)
  }, [bills.length])

  const active = bills.filter((b) => b.active).sort((a, b) => a.nextDue.localeCompare(b.nextDue))
  const paused = bills.filter((b) => !b.active)
  const monthlyTotal = active.reduce((s, b) => s + monthlyEquivalent(-b.amountMinor, b.freq), 0)

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-sm text-ink-3">Recurring bills · monthly equivalent</p>
          <p className="text-3xl font-bold tracking-tight tabular">{money(Math.round(monthlyTotal))}</p>
        </div>
        <Button onClick={() => setEditing('new')}>
          <Plus size={16} /> New bill
        </Button>
      </div>

      {active.length === 0 && paused.length === 0 ? (
        <Empty
          emoji="📅"
          title="No recurring bills yet"
          hint="Add rent, utilities and subscriptions — Hearth tracks due dates and can record them automatically."
          action={
            <Button onClick={() => setEditing('new')}>
              <Plus size={16} /> Add your first bill
            </Button>
          }
        />
      ) : (
        <Card>
          <ul className="divide-y divide-hairline">
            {active.map((b) => (
              <li key={b.id} className="flex items-center gap-3 px-4 py-3">
                <button onClick={() => setEditing(b)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <CategoryDot category={catMap.get(b.categoryId)} />
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
                      onClick={() => void postBill(b, daysUntil(b.nextDue) < 0 ? b.nextDue : todayISO())}
                      title="Mark paid"
                      aria-label={`Mark ${b.name} paid`}
                      className="grid size-8 place-items-center rounded-full bg-good/12 text-good-text hover:bg-good/20"
                    >
                      <Check size={15} />
                    </button>
                    <button
                      onClick={() => void skipBill(b)}
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
      )}

      {suggestions.length > 0 && (
        <>
          <p className="mb-2 mt-6 flex items-center gap-1.5 px-1 text-sm font-semibold uppercase tracking-wide text-ink-3">
            <Wand2 size={14} /> Looks recurring
          </p>
          <Card>
            <ul className="divide-y divide-hairline">
              {suggestions.map((s) => (
                <li key={s.payee} className="flex items-center gap-3 px-4 py-3">
                  <CategoryDot category={catMap.get(s.categoryId)} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{s.payee}</p>
                    <p className="text-sm text-ink-3">
                      {s.count}× {s.freq} · about {money(s.amountMinor)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={() =>
                      setEditing({
                        name: s.payee,
                        payee: s.payee,
                        amountMinor: s.amountMinor,
                        categoryId: s.categoryId,
                        freq: s.freq,
                        nextDue: todayISO(),
                        active: 1,
                        autoPost: 0,
                      } as Bill)
                    }
                  >
                    Track as bill
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      {paused.length > 0 && (
        <>
          <p className="mb-2 mt-6 px-1 text-sm font-semibold uppercase tracking-wide text-ink-3">Paused</p>
          <Card>
            <ul className="divide-y divide-hairline">
              {paused.map((b) => (
                <li key={b.id}>
                  <button onClick={() => setEditing(b)} className="flex w-full items-center gap-3 px-4 py-3 text-left opacity-60 hover:opacity-100">
                    <CategoryDot category={catMap.get(b.categoryId)} size={32} />
                    <span className="flex-1 font-medium">{b.name}</span>
                    <span className="tabular text-sm">{money(b.amountMinor)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      <BillForm
        key={editing === 'new' ? 'new' : (editing?.id ?? editing?.name ?? 'closed')}
        bill={editing === 'new' ? undefined : (editing ?? undefined)}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
    </div>
  )
}

function BillForm({ bill, open, onClose }: { bill?: Bill; open: boolean; onClose: () => void }) {
  const { currency } = useApp()
  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), []) ?? []
  const expenseCats = categories.filter((c) => c.kind === 'expense')
  const [name, setName] = useState(bill?.name ?? '')
  const [payee, setPayee] = useState(bill?.payee ?? '')
  const [amount, setAmount] = useState(bill ? String(Math.abs(bill.amountMinor) / 100) : '')
  const [categoryId, setCategoryId] = useState<number | undefined>(bill?.categoryId)
  const [freq, setFreq] = useState<BillFreq>(bill?.freq ?? 'monthly')
  const [nextDue, setNextDue] = useState(bill?.nextDue ?? todayISO())
  const [autoPost, setAutoPost] = useState<boolean>(bill ? !!bill.autoPost : true)
  const [active, setActive] = useState<boolean>(bill ? !!bill.active : true)

  const minor = parseAmount(amount)
  const canSave = name.trim() && minor !== null && minor > 0 && categoryId !== undefined && nextDue

  async function save() {
    if (!canSave) return
    const data = {
      name: name.trim(),
      payee: payee.trim() || name.trim(),
      amountMinor: -Math.abs(minor!),
      categoryId: categoryId!,
      freq,
      nextDue,
      active: (active ? 1 : 0) as 1 | 0,
      autoPost: (autoPost ? 1 : 0) as 1 | 0,
    }
    if (bill?.id) await db.bills.update(bill.id, data)
    else await db.bills.add(data)
    onClose()
  }

  async function remove() {
    if (bill?.id && confirm(`Delete "${bill.name}"? Past transactions are kept.`)) {
      await db.bills.delete(bill.id)
      onClose()
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={bill?.id ? 'Edit bill' : 'New bill'}>
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
          <Select value={categoryId ?? ''} onChange={(e) => setCategoryId(Number(e.target.value))}>
            <option value="" disabled>
              Choose…
            </option>
            {expenseCats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.emoji} {c.name}
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
        <div className="flex gap-2">
          {bill?.id && (
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
          )}
          <Button size="lg" className="flex-1" disabled={!canSave} onClick={save}>
            {bill?.id ? 'Save changes' : 'Add bill'}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
