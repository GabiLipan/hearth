import { useMemo, useState } from 'react'
import { PiggyBank, Plus, ArrowRight, Lock } from 'lucide-react'
import type { Goal } from '../lib/db'
import { create, update, remove } from '../lib/data'
import { goalProgress, transfer } from '../lib/goals'
import { syncNow } from '../lib/session'
import { useAccounts, useAllTransactions, useBook, useGoals, useMyLevels } from '../lib/cache'
import { canAddTransactions, levelOn } from '../lib/accounts'
import { fmtFullDate, todayISO } from '../lib/dates'
import { parseAmount, currencySymbol } from '../lib/money'
import { slotVar } from '../lib/palette'
import { useApp } from '../state/AppContext'
import { useSyncState } from '../hooks/useSync'
import {
  Card, Sheet, Button, Field, TextInput, Select, Empty, Progress, Toolbar, cx,
} from '../components/ui'
import { CategoryIcon, CATEGORY_ICON_KEYS } from '../components/CategoryIcon'
import { BookSwitcher } from '../components/BookSwitcher'

/**
 * Pots you are saving towards.
 *
 * Kept apart from Budgets because they answer a different question. A budget
 * asks "have we overspent this month?"; a goal asks "will we get there in
 * time?" — so the figure that matters here is what is left and what that means
 * per month from now, not what is left this month.
 */
export default function Goals() {
  const { money } = useApp()
  const { userId } = useSyncState()
  const goals = useGoals()
  const txns = useAllTransactions() ?? []
  const [book, setBook] = useBook()
  const [editing, setEditing] = useState<Goal | 'new' | null>(null)
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
  const openForm = (what: Goal | 'new') => {
    setEditing(what)
    setOpened((n) => n + 1)
  }
  const [funding, setFunding] = useState<Goal | null>(null)

  /**
   * A goal is the household's or it is mine — `owner_id` already says which,
   * and the server already refuses to show me anybody else's — so the book is
   * read off the goal itself rather than off the account holding the money.
   *
   * That is deliberately not the rule bills and transactions use, where the
   * account decides. A saving pot is an intention, and where the money happens
   * to sit is a detail of it: our house deposit can perfectly well live in an
   * account only one of us is on, and it is still ours.
   */
  const inBook = useMemo(
    () => goals.filter((g) => (book === 'household' ? !g.ownerId : book === 'mine' ? g.ownerId === userId : true)),
    [goals, book, userId],
  )

  const rows = useMemo(
    () => inBook.map((goal) => ({ goal, progress: goalProgress(goal, txns) })),
    [inBook, txns],
  )

  return (
    <div>
      <Toolbar className="justify-between">
        <p className="min-w-0 flex-1 text-sm text-ink-3">
          Money set aside for something specific. Add to a pot by moving money into the account that holds it.
        </p>
        <Button className="shrink-0" onClick={() => openForm('new')}>
          <Plus size={15} /> New goal
        </Button>
      </Toolbar>

      <Toolbar>
        <BookSwitcher book={book} onChange={setBook} className="w-full md:w-auto" />
      </Toolbar>

      {rows.length === 0 ? (
        <Empty
          icon={PiggyBank}
          title={book === 'household' ? 'No shared goals yet' : book === 'mine' ? 'No goals of your own yet' : 'No goals yet'}
          hint={
            goals.length > 0
              ? book === 'household'
                ? 'The goals you have are your own — switch to Mine, or leave “Keep this to myself” unticked when you add one.'
                : 'The goals you have are the household’s — switch to Our household.'
              : 'A holiday, a new boiler, a rainy-day fund — set a target and watch it fill up.'
          }
          action={
            <Button onClick={() => openForm('new')}>
              <Plus size={16} /> Add your first goal
            </Button>
          }
        />
      ) : (
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]">
          {rows.map(({ goal, progress }) => (
            <Card key={goal.id} className="p-4 md:p-3.5">
              <div className="flex items-center gap-2.5">
                <span
                  className="grid size-9 shrink-0 place-items-center rounded-full"
                  style={{
                    background: `color-mix(in oklab, ${slotVar(goal.slot)} 16%, var(--surface-2))`,
                    color: slotVar(goal.slot),
                  }}
                >
                  <CategoryIcon icon={goal.icon} size={17} />
                </span>
                <button onClick={() => openForm(goal)} className="min-w-0 flex-1 text-left">
                  <p className="flex items-center gap-1.5 truncate font-medium">
                    {goal.name}
                    {goal.ownerId && <Lock size={12} className="shrink-0 text-ink-3" />}
                  </p>
                  <p className="truncate text-xs text-ink-3">
                    {goal.targetDate ? `by ${fmtFullDate(goal.targetDate)}` : 'no deadline'}
                  </p>
                </button>
                <span className="shrink-0 text-right">
                  <span className="block font-semibold tabular">{money(progress.savedMinor)}</span>
                  <span className="block text-xs text-ink-3 tabular">of {money(goal.targetMinor, { hideDecimals: true })}</span>
                </span>
              </div>

              <div className="mt-3">
                <Progress fraction={progress.fraction} tone={progress.behind ? 'over' : 'ok'} />
              </div>

              <div className="mt-2 flex items-center justify-between gap-2">
                <p className={cx('text-xs tabular', progress.behind ? 'text-critical-text' : 'text-ink-3')}>
                  {progress.remainingMinor === 0
                    ? 'Fully funded'
                    : progress.behind
                      ? `${money(progress.remainingMinor)} short, past its date`
                      : progress.neededPerMonthMinor
                        ? `${money(progress.neededPerMonthMinor)} a month to get there`
                        : `${money(progress.remainingMinor)} to go`}
                </p>
                <Button size="sm" variant="subtle" onClick={() => setFunding(goal)}>
                  Add money <ArrowRight size={13} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <GoalForm
        key={opened}
        goal={editing === 'new' ? undefined : (editing ?? undefined)}
        open={editing !== null}
        onClose={() => setEditing(null)}
        userId={userId}
        // A goal added while looking at Mine starts as mine. Nothing is
        // decided by it — the tick box is right there — but adding a personal
        // goal from the personal view and having it appear in neither list is
        // the sort of thing that reads as the feature being broken.
        defaultPersonal={book === 'mine'}
      />
      <FundGoal goal={funding} open={funding !== null} onClose={() => setFunding(null)} />
    </div>
  )
}

function GoalForm({
  goal, open, onClose, userId, defaultPersonal,
}: {
  goal?: Goal
  open: boolean
  onClose: () => void
  userId?: string
  /** What a NEW goal starts as. An existing one is whatever it already is. */
  defaultPersonal?: boolean
}) {
  const { currency } = useApp()
  // This picker was never filtered, which made it the one place a goal could be
  // pointed at an account you cannot record against. There is no call for the
  // compiler to have caught, so it is written out here deliberately.
  const allAccounts = useAccounts()
  const levels = useMyLevels()
  const accounts = useMemo(
    () => allAccounts.filter((a) => canAddTransactions(levelOn(a.id, levels))),
    [allAccounts, levels],
  )
  const [name, setName] = useState(goal?.name ?? '')
  const [icon, setIcon] = useState(goal?.icon ?? 'piggy')
  const [target, setTarget] = useState(goal ? String(goal.targetMinor / 100) : '')
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '')
  const [accountId, setAccountId] = useState<string | undefined>(goal?.accountId)
  const [personal, setPersonal] = useState(goal ? !!goal.ownerId : !!defaultPersonal)

  const minor = parseAmount(target)
  const canSave = name.trim().length > 0 && minor !== null && minor > 0

  async function save() {
    if (!canSave) return
    const data = {
      name: name.trim(),
      icon,
      targetMinor: minor!,
      targetDate: targetDate || undefined,
      accountId,
      ownerId: personal ? userId : undefined,
    }
    if (goal) await update('goals', goal.id, data)
    else await create('goals', { ...data, slot: 9, sortOrder: 0 })
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={goal ? 'Edit goal' : 'New goal'}
      footer={
        <div className="flex gap-2">
          {goal && (
            <Button
              variant="danger"
              size="lg"
              onClick={async () => {
                if (confirm(`Delete "${goal.name}"? The money and its transfers stay where they are.`)) {
                  await remove('goals', goal.id)
                  onClose()
                }
              }}
            >
              Delete
            </Button>
          )}
          <Button size="lg" className="flex-1" disabled={!canSave} onClick={save}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="What are you saving for?">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Holiday" autoFocus={!goal} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Target (${currencySymbol(currency)})`}>
            <TextInput value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder="2400" />
          </Field>
          <Field label="By when (optional)" hint="Used to work out the monthly pace.">
            <TextInput type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Where the money sits (optional)">
          <Select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || undefined)}>
            <option value="">Not linked to an account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Icon">
          <div className="flex flex-wrap gap-1.5">
            {CATEGORY_ICON_KEYS.slice(0, 24).map((key) => (
              <button
                key={key}
                onClick={() => setIcon(key)}
                aria-label={key}
                aria-pressed={icon === key}
                className={cx(
                  'grid size-9 place-items-center rounded-lg ring-1 transition',
                  icon === key ? 'bg-accent/10 ring-accent' : 'bg-surface-2 ring-transparent hover:ring-hairline',
                )}
              >
                <CategoryIcon icon={key} size={17} />
              </button>
            ))}
          </div>
        </Field>
        {userId && (
          <label className="flex items-start gap-3 rounded-xl bg-surface-2 px-4 py-3">
            <input
              type="checkbox"
              checked={personal}
              onChange={(e) => setPersonal(e.target.checked)}
              className="mt-0.5 size-4 accent-[var(--accent)]"
            />
            <span>
              <span className="block text-sm font-medium">Keep this to myself</span>
              <span className="block text-xs text-ink-3">Nobody else in the household sees this goal.</span>
            </span>
          </label>
        )}
      </div>
    </Sheet>
  )
}

/**
 * Moving money into a pot.
 *
 * This is a transfer, not a payment: the money leaves one account and arrives
 * in another, so it counts as neither spending nor income. Online-only, because
 * the two legs must land together or not at all.
 */
function FundGoal({ goal, open, onClose }: { goal: Goal | null; open: boolean; onClose: () => void }) {
  const { currency, money } = useApp()
  const { online } = useSyncState()
  const accounts = useAccounts()
  const levels = useMyLevels()
  const usable = useMemo(
    () => accounts.filter((a) => canAddTransactions(levelOn(a.id, levels))),
    [accounts, levels],
  )

  const [from, setFrom] = useState<string | undefined>()
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const to = goal?.accountId
  const minor = parseAmount(amount)
  const canSave = !!goal && !!from && !!to && from !== to && minor !== null && minor > 0 && online

  async function save() {
    if (!canSave) return
    setBusy(true)
    setError(undefined)
    try {
      await transfer({ fromAccountId: from!, toAccountId: to!, amountMinor: minor!, date, goalId: goal!.id })
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
      title={goal ? `Add to ${goal.name}` : 'Add money'}
      footer={
        <Button size="lg" className="w-full" disabled={!canSave || busy} onClick={save}>
          {busy ? 'Moving…' : 'Move money'}
        </Button>
      }
    >
      <div className="space-y-4">
        {!to && (
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-2">
            This goal isn't linked to an account yet. Edit it and choose where the money sits, so contributions have
            somewhere to go.
          </p>
        )}
        {!online && (
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-ink-2">
            Moving money needs a connection — both halves have to be recorded together, so this one can't be queued.
          </p>
        )}
        <Field label="From">
          <Select value={from ?? ''} onChange={(e) => setFrom(e.target.value || undefined)}>
            <option value="" disabled>
              Choose an account…
            </option>
            {usable
              .filter((a) => a.id !== to)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Amount (${currencySymbol(currency)})`}>
            <TextInput value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="200" autoFocus />
          </Field>
          <Field label="Date">
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        {goal && minor != null && minor > 0 && (
          <p className="text-sm text-ink-3">
            Leaves {money(minor)} in {goal.name}, and out of the account it came from.
          </p>
        )}
        {error && <p className="text-sm text-critical-text">{error}</p>}
      </div>
    </Sheet>
  )
}
