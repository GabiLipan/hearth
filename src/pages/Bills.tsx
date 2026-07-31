import { useEffect, useMemo, useState } from 'react'
import { Plus, Check, SkipForward, Wand2, CalendarClock } from 'lucide-react'
import type { Bill, BillFreq } from '../lib/db'
import { create, update, remove as removeRow } from '../lib/data'
import { useAccounts, useBills, useCategories, useCategoryMap } from '../lib/cache'
import { canUseAccount } from '../lib/accounts'
import { syncNow } from '../lib/session'
import { daysUntil, fmtFullDate, FREQ_LABEL, monthlyEquivalent, todayISO } from '../lib/dates'
import { postBill, skipBill, detectBillSuggestions, type BillSuggestion } from '../lib/bills'
import { parseAmount, currencySymbol } from '../lib/money'
import { useApp } from '../state/AppContext'
import { Card, CategoryDot, Sheet, Button, Field, TextInput, Select, Empty, table, cx } from '../components/ui'
import { CategoryIcon } from '../components/CategoryIcon'

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

export default function Bills() {
  const { money } = useApp()
  const bills = useBills()
  const catMap = useCategoryMap()
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
      <div className="mb-4 flex items-center justify-between md:mb-2.5">
        <div className="md:flex md:items-baseline md:gap-2">
          <p className="text-sm text-ink-3 md:order-2">Recurring bills · monthly equivalent</p>
          <p className="text-3xl font-bold tracking-tight tabular md:order-1 md:text-xl">
            {money(Math.round(monthlyTotal))}
          </p>
        </div>
        <Button onClick={() => setEditing('new')}>
          <Plus size={15} /> New bill
        </Button>
      </div>

      {active.length === 0 && paused.length === 0 ? (
        <Empty
          icon={CalendarClock}
          title="No recurring bills yet"
          hint="Add rent, utilities and subscriptions — Hearth tracks due dates and can record them automatically."
          action={
            <Button onClick={() => setEditing('new')}>
              <Plus size={16} /> Add your first bill
            </Button>
          }
        />
      ) : (
        <>
          {/* Phone: a stacked, thumb-friendly list. */}
          <Card className="md:hidden">
            <ul className="divide-y divide-hairline">
              {active.map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-4 py-3">
                  <button onClick={() => setEditing(b)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
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
                        onClick={() => void postBill(b, daysUntil(b.nextDue) < 0 ? b.nextDue : todayISO()).then(() => syncNow())}
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

          {/* Desktop: the same bills as a table — every attribute gets a column
              instead of being stacked into a two-line row. */}
          <Card className="hidden overflow-hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className={table.head}>
                  <th className={cx(table.th, 'pl-3')}>Bill</th>
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
                {active.map((b) => {
                  const cat = b.categoryId ? catMap.get(b.categoryId) : undefined
                  return (
                    <tr key={b.id} className={table.row}>
                      <td className={cx(table.cell, 'pl-3 pr-3')}>
                        <button onClick={() => setEditing(b)} className="block w-full truncate text-left font-medium hover:text-accent">
                          {b.name}
                        </button>
                      </td>
                      <td className={cx(table.cell, 'pr-3')}>
                        <span className="flex items-center gap-1.5 truncate text-ink-2">
                          <span className="shrink-0" style={{ color: cat ? `var(--series-${cat.slot})` : 'var(--ink-3)' }}>
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
                      <td className={cx(table.cell, 'pr-3 text-right font-semibold tabular')}>{money(b.amountMinor)}</td>
                      <td className={cx(table.cell, 'pr-3')}>
                        {!b.autoPost && (
                          <div className="flex justify-end gap-1">
                            <button
                              onClick={() => void postBill(b, daysUntil(b.nextDue) < 0 ? b.nextDue : todayISO()).then(() => syncNow())}
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
              </tbody>
            </table>
          </Card>
        </>
      )}

      {suggestions.length > 0 && (
        <>
          <p className="mb-2 mt-6 flex items-center gap-1.5 px-1 text-sm font-semibold uppercase tracking-wide text-ink-3 md:mb-1.5 md:mt-5 md:text-xs">
            <Wand2 size={14} /> Looks recurring
          </p>
          {/* Auto-filling track: these pack into columns on a wide screen
              instead of each taking a full row. */}
          <div className={SIDE_GRID}>
            {suggestions.map((s) => (
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
                    setEditing({
                      name: s.payee,
                      payee: s.payee,
                      amountMinor: s.amountMinor,
                      categoryId: s.categoryId,
                      accountId: s.accountId,
                      freq: s.freq,
                      nextDue: todayISO(),
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
                onClick={() => setEditing(b)}
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
  const categories = useCategories()
  const allAccounts = useAccounts()
  const accounts = useMemo(() => allAccounts.filter((a) => canUseAccount(a)), [allAccounts])
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
