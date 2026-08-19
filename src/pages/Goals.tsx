import { useEffect, useMemo, useRef, useState } from 'react'
import { PiggyBank, Plus, ArrowRight, Lock } from 'lucide-react'
import type { Goal } from '../lib/db'
import { create, update, remove } from '../lib/data'
import {
  accountAllocation,
  assignmentRow,
  goalProgress,
  settleGoals,
  shortfall,
  type AccountAllocation,
} from '../lib/goals'
import { syncNow } from '../lib/session'
import {
  useAccounts,
  useAllTransactions,
  useBook,
  useGoalEntries,
  useGoals,
  useMyLevels,
  useRemoteBalances,
  useCacheReady,
} from '../lib/cache'
import { balanceOf, canSeeTransactionsAt, levelOn } from '../lib/accounts'
import { fmtFullDate, todayISO } from '../lib/dates'
import { parseAmount, currencySymbol } from '../lib/money'
import { useApp } from '../state/AppContext'
import { useSyncState } from '../hooks/useSync'
import {
  Card, Sheet, Button, Face, Field, TextInput, Select, Empty, Progress, Segmented, Toolbar,
  useInfoNote, cx,
} from '../components/ui'
import { confirmAction } from '../components/confirm'
import { toast } from '../components/toast'
import { IconPicker, SlotPicker } from '../components/IconPicker'
import { nextFreeSlot, paintOf } from '../lib/palette'
import { BookSwitcher } from '../components/BookSwitcher'

/**
 * Everything this page has to say that is longer than a line, in one place.
 * All of it lives behind a ⓘ — see `useInfoNote`.
 */
const ASSIGN_INFO = (
  <>
    <p>
      A goal is a claim on money that is already in an account, not a pot the money is moved into. Nothing here
      writes a transaction, and the account&rsquo;s balance does not change.
    </p>
    <p>
      Transferring money to savings is an ordinary transfer between two accounts, and Reports counts it as saving.
      Saying which part of the savings is the deposit is this, and the two are separate on purpose.
    </p>
    <p>
      The goals on one account can never claim more than it holds. If money leaves, it comes off whatever is
      unassigned first, and then off the largest pot.
    </p>
  </>
)

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
  const ready = useCacheReady()
  const txns = useAllTransactions() ?? []
  const entries = useGoalEntries()
  const accounts = useAccounts()
  const levels = useMyLevels()
  const remoteBalances = useRemoteBalances()
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
  const [assigning, setAssigning] = useState<Goal | null>(null)

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
    () => inBook.map((goal) => ({ goal, progress: goalProgress(goal, entries) })),
    [inBook, entries],
  )

  /**
   * Every account that has a goal on it, with what it holds and what its goals
   * have claimed.
   *
   * Keyed by account rather than computed per goal, because the interesting
   * figure — what is still unassigned — is a property of the ACCOUNT and is
   * shared by every pot sitting on it. `goals` here is the unfiltered list on
   * purpose: a personal goal of mine still claims money out of the joint
   * savings account, and leaving it out under Our household would offer the
   * same money twice.
   */
  const allocations = useMemo(() => {
    const out = new Map<string, AccountAllocation>()
    for (const account of accounts) {
      if (!goals.some((g) => g.accountId === account.id)) continue
      const level = levelOn(account.id, levels)
      if (!canSeeTransactionsAt(level)) continue
      out.set(
        account.id,
        accountAllocation(account.id, goals, entries, balanceOf(account, txns, remoteBalances, level)),
      )
    }
    return out
  }, [accounts, goals, entries, txns, remoteBalances, levels])

  /**
   * Where the pots on an account claim more than it now holds.
   *
   * Money has left since the claims were made. The server settles it — writing
   * the subtractions as ordinary ledger rows, largest pot first — and this is
   * the same arithmetic run here so the screen can SAY so rather than a figure
   * silently changing under somebody the next time they sync.
   */
  const shortfalls = useMemo(() => {
    const out = new Map<string, number>()
    for (const alloc of allocations.values()) {
      for (const [goalId, take] of shortfall(alloc)) out.set(goalId, take)
    }
    return out
  }, [allocations])

  const accountOf = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])

  /**
   * Settle any account whose pots claim more than it holds.
   *
   * Server-side, because the shortfall has to be worked out where every goal on
   * the account is visible — including the other person's, which is invisible
   * here. Idempotent, so an account that is already in step costs one call that
   * returns 0 and writes nothing.
   *
   * The ref is what stops it looping: the RPC's rows only reach this device on
   * the next pull, so until then the shortfall is still on screen and an effect
   * keyed on it alone would fire again on every render.
   */
  const settled = useRef(new Set<string>())
  useEffect(() => {
    const owed = [...allocations.values()].filter((a) => a.unassignedMinor < 0)
    const todo = owed.filter((a) => !settled.current.has(`${a.accountId}:${a.unassignedMinor}`))
    if (todo.length === 0) return
    for (const a of todo) settled.current.add(`${a.accountId}:${a.unassignedMinor}`)
    void (async () => {
      let wrote = 0
      for (const a of todo) {
        // One account's failure must not stop the others: an account somebody
        // has since lost access to would otherwise block every pot on the page.
        try {
          wrote += await settleGoals(a.accountId)
        } catch {
          /* Reported by the next attempt, or by the dead letter it becomes. */
        }
      }
      if (wrote > 0) void syncNow()
    })()
  }, [allocations])

  return (
    <div>
      <Toolbar spread>
        <p className="min-w-0 flex-1 text-sm text-ink-3">
          Money set aside for something specific, out of what an account already holds.
        </p>
        <Button className="shrink-0" onClick={() => openForm('new')}>
          <Plus size={15} /> New goal
        </Button>
      </Toolbar>

      {/* Wide screens only: on a phone the lens lives in the header, so this
          whole row would be an empty margin. */}
      <Toolbar className="max-md:hidden">
        <BookSwitcher book={book} onChange={setBook} className="hidden md:flex md:w-auto" />
      </Toolbar>

      {/* `[]` from a cache that has not opened yet is not the same claim as
          `[]` from one that has. See `useCacheReady`. */}
      {rows.length === 0 ? (
        !ready ? null : (
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
        )
      ) : (
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]">
          {rows.map(({ goal, progress }) => (
            <Card key={goal.id} className="p-4 md:p-3.5">
              <div className="flex items-center gap-2.5">
                {/* The same badge a category and an account wear, rather than a
                    fourth hand-rolled copy of the recipe — this one had already
                    drifted to its own size and its own icon scale. */}
                <Face slot={goal.slot} color={goal.color} icon={goal.icon} size={36} />
                <button type="button" onClick={() => openForm(goal)} className="min-w-0 flex-1 text-left">
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
                {/* The tick is where the bar would be if the money had arrived
                    evenly between the first contribution and the deadline. Until
                    now "behind" was a colour and a sentence and nothing on the
                    bar itself, so a goal that was quietly drifting looked
                    identical to one comfortably ahead. */}
                <Progress
                  fraction={progress.fraction}
                  tone={progress.behind ? 'over' : 'ok'}
                  marker={progress.elapsed}
                  markerLabel="Where an even pace would have you by now"
                />
              </div>

              {/* Where the account no longer holds what its pots claim. The
                  server settles it on the next sync — largest pot first — so
                  this says what is about to happen rather than letting the
                  figure change under somebody with nothing to explain it. */}
              {shortfalls.has(goal.id) && (
                <p className="mt-2 rounded-lg bg-warning/12 px-2.5 py-1.5 text-xs text-ink-2">
                  <span className="font-medium tabular">{money(shortfalls.get(goal.id)!)}</span> of this is no longer
                  in {accountOf.get(goal.accountId ?? '')?.name ?? 'the account'} — it will come off this pot.
                </p>
              )}

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
                <Button size="sm" variant="subtle" onClick={() => setAssigning(goal)}>
                  {progress.savedMinor > 0 ? 'Adjust' : 'Put money in'} <ArrowRight size={13} />
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
      <AssignToGoal
        goal={assigning}
        allocation={assigning?.accountId ? allocations.get(assigning.accountId) : undefined}
        open={assigning !== null}
        onClose={() => setAssigning(null)}
      />
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
  /** Only so a new pot takes a colour the others have not, the way a new category does. */
  const existingGoals = useGoals()
  const accounts = useMemo(
    // `view` rather than `contribute`. Saying that £3,000 of the savings is the
    // deposit records an intention about money already there and writes no
    // transaction, so asking for the right to record one would be asking for a
    // permission the act does not use — and it is what `assign_to_goal` checks.
    () => allAccounts.filter((a) => canSeeTransactionsAt(levelOn(a.id, levels))),
    [allAccounts, levels],
  )
  const [name, setName] = useState(goal?.name ?? '')
  const [icon, setIcon] = useState(goal?.icon ?? 'piggy')
  /**
   * A goal has always had a `slot` — `Face` paints it and the cards on this
   * page have been showing it all along — and nothing could ever choose it. A
   * new pot was hard-coded to 9 at the point of saving, so every goal in a
   * household was the same colour and the badge said nothing at all.
   */
  const [slot, setSlot] = useState(
    () => goal?.slot ?? nextFreeSlot(existingGoals.map((g) => g.slot)),
  )
  /** A colour of its own, overriding the slot. Undefined is the normal case. */
  const [color, setColor] = useState(goal?.color)
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
      slot,
      color,
      targetMinor: minor!,
      targetDate: targetDate || undefined,
      accountId,
      ownerId: personal ? userId : undefined,
    }
    if (goal) await update('goals', goal.id, data)
    else await create('goals', { ...data, sortOrder: 0 })
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={goal ? 'Edit goal' : 'New goal'}
      onSubmit={() => void save()}
      footer={
        <div className="flex gap-2">
          {goal && (
            <Button
              variant="danger"
              size="lg"
              onClick={async () => {
                const ok = await confirmAction({
                  title: `Delete “${goal.name}”?`,
                  body: 'The money and the transfers that funded it stay exactly where they are — only the pot goes.',
                  confirmLabel: 'Delete goal',
                  tone: 'danger',
                })
                if (!ok) return
                await remove('goals', goal.id)
                toast(`“${goal.name}” deleted`)
                onClose()
              }}
            >
              Delete
            </Button>
          )}
          <Button type="submit" size="lg" className="flex-1" disabled={!canSave}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* The badge beside the name rather than above the picker, which is
            how the category form reads: what you are choosing is the face this
            pot wears in the list, and the list puts it left of the name. */}
        <div className="flex items-center gap-3">
          <Face slot={slot} color={color} icon={icon} size={44} />
          <div className="min-w-0 flex-1">
            <Field label="What are you saving for?">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Holiday" autoFocus={!goal} />
            </Field>
          </div>
        </div>
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
        {/* The same two controls a category and an account get, rather than a
            third hand-rolled strip. This one offered the first twenty-four keys
            of the registry and no colour at all, so a goal could not be a
            holiday or a car unless the icon for it happened to fall in the
            first two rows — and after the set grew to two hundred those
            twenty-four were simply the Money and Home groups. */}
        <SlotPicker value={slot} onChange={setSlot} color={color} onColorChange={setColor} />
        <IconPicker value={icon} onChange={setIcon} colour={paintOf(slot, color)} />
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
 * Putting money that is already there towards a pot — and taking it back off.
 *
 * Not a transfer. Nothing moves, no transaction is written, and the account's
 * balance is exactly what it was: this records a CLAIM on money already sitting
 * in the account the goal names. That is the whole change — see `lib/goals.ts`.
 *
 * Two consequences for this sheet. It works offline, because there is no pair
 * of legs that have to land together; and the amount is capped at what is
 * unassigned, which the screen can only estimate — the other person's personal
 * goal on the same account is invisible here, so the server's refusal is
 * reported rather than treated as impossible.
 */
function AssignToGoal({
  goal,
  allocation,
  open,
  onClose,
}: {
  goal: Goal | null
  allocation?: AccountAllocation
  open: boolean
  onClose: () => void
}) {
  const { currency, money } = useApp()
  const [mode, setMode] = useState<'add' | 'release'>('add')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const held = allocation?.goals.find((r) => r.goal.id === goal?.id)?.heldMinor ?? 0
  const spare = Math.max(0, allocation?.unassignedMinor ?? 0)
  const minor = parseAmount(amount)
  const ceiling = mode === 'add' ? spare : held
  const tooMuch = minor != null && minor > ceiling
  const canSave = !!goal && !!goal.accountId && minor !== null && minor > 0 && !tooMuch

  const note = useInfoNote('How a goal is filled', ASSIGN_INFO)

  async function save() {
    if (!canSave) return
    setBusy(true)
    setError(undefined)
    try {
      await create('goal_entries', assignmentRow(goal!.id, mode === 'add' ? minor! : -minor!, date))
      void syncNow()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={goal ? goal.name : 'Put money towards a goal'}
      onSubmit={() => void save()}
      footer={
        <Button type="submit" size="lg" className="w-full" disabled={!canSave || busy}>
          {mode === 'add' ? 'Put it towards this' : 'Take it back off'}
        </Button>
      }
    >
      <div className="space-y-4">
        {!goal?.accountId ? (
          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 text-sm text-ink-2">This goal does not say which account the money is in.</p>
              {note.toggle}
            </div>
            {note.body}
          </div>
        ) : (
          <>
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'add' as const, label: 'Put towards' },
                { value: 'release' as const, label: 'Take back' },
              ]}
            />

            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 text-sm text-ink-2">
                {mode === 'add' ? (
                  <>
                    <span className="font-semibold tabular">{money(spare)}</span> unassigned in this account
                  </>
                ) : (
                  <>
                    <span className="font-semibold tabular">{money(held)}</span> in this pot
                  </>
                )}
              </p>
              {note.toggle}
            </div>
            {note.body}

            <div className="grid grid-cols-2 gap-3">
              <Field label={`Amount (${currencySymbol(currency)})`}>
                <TextInput
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="200"
                  autoFocus
                />
              </Field>
              <Field label="Date">
                <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            </div>

            {tooMuch && (
              <p className="text-sm text-critical-text">
                {mode === 'add'
                  ? `Only ${money(spare)} of that account is unassigned.`
                  : `There is only ${money(held)} in this pot.`}
              </p>
            )}
            {error && <p className="text-sm text-critical-text">{error}</p>}
          </>
        )}
      </div>
    </Sheet>
  )
}
