import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { Sun, Moon, MonitorSmartphone, ArrowDownToLine, Download, Upload, Trash2, Sparkles, Plus, Cloud, CloudOff, RefreshCw, LogOut, Copy, Lock, Eye, EyeOff, Crown, Pencil, AlertTriangle, ChevronLeft, ChevronRight, ChevronDown, Wand2, ArrowLeftRight, Banknote, Undo2, Users, Wallet, Shapes, Palette, Database, type LucideIcon } from 'lucide-react'
import { db, type AccountGrant, type Category, type Account, type GrantLevel, type HouseholdMember } from '../lib/db'
import { create, update, remove as removeRow } from '../lib/data'
import {
  balanceOf,
  canAddTransactions,
  canAdministerAccount,
  canManageAccount,
  accountFace,
  canSeeAccount,
  canSeeTransactionsAt,
  deleteAccount as removeAccount,
  atLeast,
  levelOn,
  setAccountLevel,
  transactionsOn,
  LEVELS,
  LEVEL_LABEL,
  LEVEL_HINT,
} from '../lib/accounts'
import {
  useAccounts,
  useAllTransactions,
  useCategories,
  useDeadLetters,
  useGrantsByAccount,
  useGrantsFor,
  useIsAdmin,
  useMemberMap,
  useMembers,
  useMonthRule,
  useMyLevels,
  useBooks,
  useFlag,
  setFlag,
  OWED_FLAG,
  useRemoteBalances,
  useRules,
} from '../lib/cache'
import { styleOf, topLevel } from '../lib/categories'
import { checkForUpdate, installUpdate, useUpdateState } from '../lib/updates'
import { discardAllDeadLetters, discardDeadLetter, retryDeadLetter } from '../lib/outbox'
import { parseAmount, CURRENCIES, currencySymbol } from '../lib/money'
import { exportJSON, downloadJSON, importJSON, clearAllData } from '../lib/backup'
import { paintHex, paintOf, nextFreeSlot } from '../lib/palette'
import { seedDemoData } from '../lib/demo'
import {
  getTransferMode,
  knownRoutes,
  setTransferMode,
  TRANSFER_MODE_HINT,
  TRANSFER_MODE_LABEL,
  type TransferMode,
} from '../lib/transfers'
import { FREQ_WORD, type TransferRoute } from '../lib/routes'
import { AccountList } from '../components/AccountList'
import { signOut, joinHousehold, leaveHousehold, syncNow } from '../lib/session'
import { rpc } from '../lib/api'
import { fmtFullDate, fmtTime, monthLabel, shiftMonth, thisMonthKey } from '../lib/dates'
import { saveMonthRule } from '../lib/monthRule'
import type { MonthRule } from '../lib/books'
import { useSyncState } from '../hooks/useSync'
import { useApp } from '../state/AppContext'
import { alertAction, confirmAction } from '../components/confirm'
import { toast } from '../components/toast'
import { AccountDot, Card, CheckRow, Chip, SectionTitle, Segmented, Select, Button, Sheet, Field, TextInput, CategoryDot, useInfoNote, useWide, cx } from '../components/ui'
import {
  claimAccount,
  deletedAccounts,
  purgeAccount,
  restoreAccount,
  unownedAccounts,
  type DeletedAccount,
  type UnownedAccount,
} from '../lib/accounts'
import { CategoryTree } from '../components/CategoryTree'
import { ImportsSection } from '../components/ImportHistory'
import { IconPicker, InkPicker, SlotPicker } from '../components/IconPicker'
import { PersonDot, nameOf } from '../components/PersonDot'

/**
 * The household card. Signing in and choosing a household happen in Onboarding
 * now — by the time this renders, both have already happened.
 */
function HouseholdCard() {
  const sync = useSyncState()
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    }
    setBusy(false)
  }

  return (
    <Card className="space-y-3 p-4 md:p-3">
      {sync.joinCode && (
        <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-ink-3">Invite code — share it with anyone you want in this household</p>
            <p className="text-lg font-bold tracking-widest tabular">{sync.joinCode}</p>
          </div>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => {
              void navigator.clipboard.writeText(sync.joinCode!)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-critical-text">{error}</p>}

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-3 hover:text-ink-2">Join a different household</summary>
        <p className="mt-2 text-xs text-ink-3">
          Enter someone's invite code to share a household with them. Accounts you own come with you; anything you
          only had access to stays behind, and anything not yet saved is discarded.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <TextInput
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="Invite code"
            className="w-36 uppercase"
          />
          <Button
            variant="subtle"
            disabled={busy || joinCode.trim().length < 6}
            onClick={async () => {
              const ok = await confirmAction({
                title: 'Join that household?',
                body: 'Everything on this device is replaced by what is in that household.',
                confirmLabel: 'Join',
                tone: 'danger',
              })
              if (ok) void run(() => joinHousehold(joinCode))
            }}
          >
            Join
          </Button>
        </div>
      </details>

      {/* Syncing and signing out are about this DEVICE rather than about the
          household, so they live with the data — see `SyncAndAccount`. What is
          left here is the household itself: who can join it, and how to go. */}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const ok = await confirmAction({
              title: 'Leave this household?',
              body: 'Your data stays with the household. This device is disconnected from it.',
              confirmLabel: 'Leave',
              tone: 'danger',
            })
            if (ok) void run(leaveHousehold)
          }}
        >
          Leave household
        </Button>
      </div>
    </Card>
  )
}

/**
 * Writes the server refused for a reason retrying cannot fix. Shown here rather
 * than as a toast because the failure usually happens while offline, long after
 * the user has put the phone down \u2014 a change that could not be saved must not
 * disappear quietly.
 */
/** One column on a phone or laptop, two at xl, three on a wide monitor. */
/**
 * Accounts that can be got back: ones somebody deleted, and ones nobody owns.
 *
 * Both lists come from RPCs rather than the cache, because neither row is one
 * `accounts_select` will hand over — a deleted account is deliberately kept out
 * of the ordinary read path, and an ownerless one is invisible to everybody
 * precisely because it has no grant left to authorise it. Which is why this
 * section can render nothing at all for weeks and then matter enormously.
 *
 * Fetched on mount rather than watched. Neither list changes without somebody
 * on this device doing something, and polling for a bin nobody has put anything
 * in is a request per minute for nothing.
 *
 * The bin also has a bottom now. Without one it only ever fills up — every
 * account either of us has ever deleted, listed for ever — and it quietly
 * misrepresents what is stored, because "deleted" reads as gone while every
 * transaction is still in the table.
 */
function Recoverable() {
  const [bin, setBin] = useState<DeletedAccount[]>([])
  const [orphans, setOrphans] = useState<UnownedAccount[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  // Which row has had its destroy button pressed once. An inline second press
  // rather than a `confirm()`: this is the only irreversible thing in the app,
  // and a browser dialog is the kind of thing people dismiss without reading.
  const [arming, setArming] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [d, u] = await Promise.all([deletedAccounts(), unownedAccounts()])
      setBin(d)
      setOrphans(u)
    } catch {
      // Offline, or the migration has not been applied. Either way there is
      // nothing to show and nothing worth saying about it here.
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusy(id)
    try {
      await fn()
      await syncNow()
      await refresh()
    } catch (e) {
      await alertAction('That did not work', e instanceof Error ? e.message : undefined)
    } finally {
      setBusy(null)
      setArming(null)
    }
  }

  if (bin.length === 0 && orphans.length === 0) return null

  return (
    <section>
      <SectionTitle>Recoverable</SectionTitle>
      <Card className="divide-y divide-hairline">
        {bin.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-3 md:px-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium md:text-sm">{a.name}</p>
              {/* Once armed the line says what goes, not what comes back. The
                  same count, read the other way round, is the whole warning. */}
              <p className="truncate text-xs text-ink-3">
                {arming === a.id ? (
                  <span className="text-critical-text">
                    Destroy this and its {a.transactionCount} transaction
                    {a.transactionCount === 1 ? '' : 's'} for good? This cannot be undone.
                  </span>
                ) : (
                  <>
                    Deleted {fmtFullDate(a.deletedAt.slice(0, 10))}
                    {a.transactionCount > 0 &&
                      ` · ${a.transactionCount} transaction${a.transactionCount === 1 ? '' : 's'} would come back`}
                  </>
                )}
              </p>
            </div>
            {arming === a.id ? (
              <>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setArming(null)}>
                  Keep it
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() => void run(a.id, () => purgeAccount(a.id))}
                >
                  <Trash2 size={14} /> Destroy
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => setArming(a.id)}
                >
                  <Trash2 size={14} /> Delete for good
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={busy !== null}
                  onClick={() => void run(a.id, () => restoreAccount(a.id))}
                >
                  <Undo2 size={14} /> Restore
                </Button>
              </>
            )}
          </div>
        ))}

        {orphans.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-3 md:px-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium md:text-sm">{a.name}</p>
              {/* Said plainly, because taking an account is not nothing. */}
              <p className="truncate text-xs text-ink-3">Nobody owns this account any more</p>
            </div>
            <Button
              size="sm"
              variant="subtle"
              disabled={busy !== null}
              onClick={async () => {
                const ok = await confirmAction({
                  title: `Take ownership of “${a.name}”?`,
                  body: 'You will be able to see and change everything on it.',
                  confirmLabel: 'Take ownership',
                })
                if (ok) void run(a.id, () => claimAccount(a.id))
              }}
            >
              Take ownership
            </Button>
          </div>
        ))}
      </Card>
    </section>
  )
}

function UnsavedChanges() {
  const deadLetters = useDeadLetters()
  if (deadLetters.length === 0) return null
  return (
    <section>
      {/* A literal apostrophe: `\u2019` is an escape in a JS string but plain text in JSX. */}
      <SectionTitle
        action={
          <button
            type="button"
            onClick={async () => {
              const count = deadLetters.length
              const ok = await confirmAction({
                title: `Discard ${count} change${count === 1 ? '' : 's'}?`,
                body: 'They could not be saved and will be given up for good. What is already on the server is untouched.',
                confirmLabel: 'Discard',
                tone: 'danger',
              })
              if (ok) void discardAllDeadLetters()
            }}
            className="text-sm font-medium text-accent"
          >
            Discard all
          </button>
        }
      >
        Couldn’t be saved
      </SectionTitle>
      <Card className="space-y-3 p-4 md:p-3">
        <p className="flex items-start gap-2 text-sm text-ink-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
          These changes were rejected by the server. Usually it means the thing they referred to was deleted on another
          device. “Try again” re-sends the same change, so when the server objected to the change itself, discarding is
          the only way out.
        </p>
        <ul className="space-y-2">
          {deadLetters.map((d) => (
            <li key={d.id} className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
              <p className="font-medium">{d.summary}</p>
              {/* Selectable, unlike the rest of the app: this is the server's
                  own words about a write that failed, and it is the one string
                  here somebody has a reason to copy and send on. */}
              <p className="selectable text-xs text-ink-3">{d.message}</p>
              <div className="mt-1.5 flex gap-2">
                <Button size="sm" variant="subtle" onClick={() => void retryDeadLetter(d.id)}>
                  Try again
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void discardDeadLetter(d.id)}>
                  Discard
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  )
}

/**
 * How much this device volunteers to spot transfers between your accounts.
 *
 * Device-local and unsynced, like the theme — see `getTransferMode`. What it
 * decides is how much THIS screen does without asking, not a fact about the
 * household, so your phone doing it automatically is no reason for a laptop to.
 */
function TransferModeRow() {
  const [mode, setMode] = useState<TransferMode | null>(null)
  // What a transfer IS belongs behind the ⓘ; the line under the control says
  // what this device is currently doing about them, which is the thing that
  // changes and so cannot be learned once.
  const note = useInfoNote('Transfers between your accounts', TRANSFERS_INFO)

  useEffect(() => {
    void getTransferMode().then(setMode)
  }, [])

  async function choose(next: TransferMode) {
    setMode(next)
    await setTransferMode(next)
  }

  return (
    <div className="px-4 py-3 md:px-3 desktop:py-2.5">
      <div className="flex items-center gap-3 md:gap-2.5">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2 md:size-8">
          <ArrowLeftRight size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium md:text-sm">Transfers between your accounts</p>
        </div>
        {note.toggle}
      </div>
      {note.body && <div className="mt-2 pl-12 md:pl-[42px]">{note.body}</div>}
      {mode && (
        <div className="mt-2.5 pl-12 md:pl-[42px]">
          <Segmented
            value={mode}
            onChange={(m) => void choose(m)}
            options={(['auto', 'ask', 'manual'] as TransferMode[]).map((m) => ({
              value: m,
              label: TRANSFER_MODE_LABEL[m],
            }))}
          />
          <p className="mt-1.5 text-xs text-ink-3">{TRANSFER_MODE_HINT[mode]}</p>
          {mode !== 'manual' && <KnownRoutes />}
        </div>
      )}
    </div>
  )
}

const TRANSFERS_INFO = (
  <p>
    Money moved from one of your accounts to another is neither spending nor income, so both sides are left out
    of your totals.
  </p>
)

/** The distinction that matters, and the one a bill does not make. */
const ROUTES_INFO = (
  <p>
    Nothing is recorded from these. They only help Hearth tell which pair of rows belongs together when more than
    one reading fits.
  </p>
)

/**
 * The habits the app has picked up, said out loud.
 *
 * A route is the only thing in the transfer path that acts on something other
 * than the two rows in front of it, and it is what lets payday be linked
 * without being asked about. Automation nobody can see is automation people
 * turn off, so it is listed — read-only, because there is nothing to configure:
 * a route is a summary of transfers you have already confirmed, and the way to
 * change one is to unlink them.
 */
function KnownRoutes() {
  const { money } = useApp()
  const accounts = useAccounts()
  const [routes, setRoutes] = useState<TransferRoute[]>([])
  const note = useInfoNote('Movements it has learned', ROUTES_INFO)

  useEffect(() => {
    void knownRoutes().then(setRoutes)
  }, [])

  if (routes.length === 0) return null
  const nameOfAccount = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'an account'

  return (
    <div className="mt-3 rounded-xl bg-surface-2 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink-2">Movements it has learned</p>
        {note.toggle}
      </div>
      <ul className="mt-1 space-y-1">
        {routes.map((r) => (
          <li key={`${r.fromAccountId}>${r.toAccountId}`} className="text-xs text-ink-3">
            {money(r.typicalMinor)} from {nameOfAccount(r.fromAccountId)} to{' '}
            {nameOfAccount(r.toAccountId)}, {FREQ_WORD[r.freq]} · seen {r.count} times, next around{' '}
            {fmtFullDate(r.nextOn)}
          </li>
        ))}
      </ul>
      {note.body && <div className="mt-1.5">{note.body}</div>}
    </div>
  )
}


/* ---------- The sections, and how they are grouped ---------- */

function AppearanceSection() {
  const { themePref, setThemePref } = useApp()
  return (
    <section>
      <SectionTitle>Appearance</SectionTitle>
      <Card className="p-4 md:p-3">
        {/* Currency is not appearance — it is a property of the money, so it
            lives with the accounts the money is in. */}
        <Segmented
          value={themePref}
          onChange={setThemePref}
          options={THEME_OPTIONS}
        />
      </Card>
    </section>
  )
}

/** Shared by the phone's quick box and the wide screen's Appearance section. */
const THEME_OPTIONS = [
  { value: 'light' as const, label: <span className="flex items-center justify-center gap-1.5"><Sun size={15} /> Light</span> },
  { value: 'dark' as const, label: <span className="flex items-center justify-center gap-1.5"><Moon size={15} /> Dark</span> },
  { value: 'system' as const, label: <span className="flex items-center justify-center gap-1.5"><MonitorSmartphone size={15} /> Auto</span> },
]

/**
 * What every figure in the app is counted in.
 *
 * Filed with the accounts rather than with the theme: it is a fact about the
 * money, not about how this screen looks, and the question "what currency are
 * we in" is one you ask while looking at the accounts holding it.
 */
function CurrencySection() {
  const { currency, setCurrency } = useApp()
  return (
    <section>
      <SectionTitle>Currency</SectionTitle>
      <Card className="p-4 md:p-3">
        <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </Select>
        <p className="mt-2 text-xs text-ink-3">
          Every amount in the app is shown in this. It changes the symbol, not the numbers.
        </p>
      </Card>
    </section>
  )
}

/**
 * Whether to keep score of what the household owes you.
 *
 * Ticking "I paid for this, but it was the household's" on a row already files
 * the spending in the right books, and for a couple who share everything that
 * is the whole of it. The running total of what has not come back is a second,
 * sharper reading of the same rows — true, and not something everybody wants
 * counted at them on their home page — so it is off until it is asked for.
 *
 * Here rather than in the home page's own Customise row, because it is not a
 * question about the home page. It changes what the app is keeping track of,
 * and the answer belongs beside the accounts the money is being paid from.
 *
 * A device setting, like the theme and the layout: it is a property of this
 * screen and it is not somebody else's business what you are counting.
 */
function OwedSection() {
  const on = useFlag(OWED_FLAG)
  return (
    <section>
      <SectionTitle>Paying for the household yourself</SectionTitle>
      <Card className="p-4 md:p-3">
        <CheckRow
          tone="bare"
          checked={on}
          onChange={(next) => void setFlag(OWED_FLAG, next)}
          label="Keep track of what you are owed"
          info={
            <>
              <p>
                Adds an &ldquo;Owed to you&rdquo; card to the home page: what you have paid for the household
                out of your own accounts, what has come back, and a way to move the rest across.
              </p>
              <p>
                Off, a payment you mark as the household&rsquo;s still counts exactly the same — household
                spending, and money you put in. This only decides whether the app adds it up as a debt.
              </p>
            </>
          }
        />
      </Card>
    </section>
  )
}

/** 1st, 2nd, 3rd, 4th — for a day of the month, so 11th to 13th are not "11st". */
function ordinal(n: number) {
  const teen = n % 100 >= 11 && n % 100 <= 13
  const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${suffix}`
}

const MONTH_RULE_INFO = (
  <p>
    We are paid at the end of one month and spend it during the next, so money arriving late counts towards the
    month it funds rather than the month it landed in. Without that, a month reads as having spent thousands
    against nothing until payday turns up. Spending is never moved — it keeps the date it happened on, so
    statements still reconcile.
  </p>
)

/**
 * When this household's month starts, for money coming in.
 *
 * Filed with the household rather than with the theme, and for a stronger
 * reason than the currency: the household book is complete and IDENTICAL on
 * both our screens, and a cutoff kept per device would break that in the one
 * way nobody could see — the same contribution landing in July on one phone and
 * August on the other, with both screens confident.
 *
 * Two rows because they are two events. The salary arrives when the employer
 * says, and moves to the 23rd when the 25th is a Sunday; the contribution moves
 * when one of us gets round to it. Each row says what its rule DOES, with a
 * real date in it, because "cut-off day: 24" is a number and "a transfer on
 * 24th August counts towards September" is the thing you are actually deciding.
 */
function MonthRuleSection() {
  const rule = useMonthRule()
  const change = (next: MonthRule) => void saveMonthRule(next)

  return (
    <section>
      <SectionTitle>When a month's money arrives</SectionTitle>
      <Card className="divide-y divide-hairline">
        <CutoffRow
          icon={<ArrowLeftRight size={16} />}
          title="Money moved into the household"
          info={MONTH_RULE_INFO}
          noun="A transfer"
          day={rule.contributionDay}
          onChange={(d) => change({ ...rule, contributionDay: d })}
        />
        <CutoffRow
          icon={<Banknote size={16} />}
          title="Salary and other income"
          info={MONTH_RULE_INFO}
          noun="Pay"
          day={rule.incomeDay}
          onChange={(d) => change({ ...rule, incomeDay: d })}
        />
      </Card>
      <p className="mt-2 px-1 text-xs text-ink-3">
        One transaction can be counted somewhere else on its own — open it and use “Counts in”.
      </p>
    </section>
  )
}

/**
 * One cutoff: whether it applies at all, and from which day.
 *
 * The checkbox and the day are one decision presented as two controls, so the
 * common case — "yes, from the 24th" — is a tick and a number rather than a
 * scroll through twenty-eight sentences. Turning it off keeps the day it had,
 * so changing your mind twice does not lose it.
 *
 * 28 is the last day offered. A cutoff of 30 has no meaning in February, and a
 * rule that quietly does nothing for one month a year is worse than one you
 * cannot set.
 */
function CutoffRow({
  icon,
  title,
  info,
  noun,
  day,
  onChange,
}: {
  icon: ReactNode
  title: string
  info: ReactNode
  /** How the example sentence names this money: "A transfer", "Pay". */
  noun: string
  day: number | null
  onChange: (day: number | null) => void
}) {
  const note = useInfoNote(title, info)
  /** What the day box shows while the rule is off, so turning it on has an answer ready. */
  const [remembered, setRemembered] = useState(day ?? 25)

  const set = (d: number) => {
    setRemembered(d)
    onChange(d)
  }

  // A real date rather than an ordinal on its own, using the month we are in,
  // so the sentence is about a day you can picture. No year: it is noise in a
  // sentence about which month something lands in.
  const bare = (key: string) => monthLabel(key).replace(/ \d{4}$/, '')
  const example = `${ordinal(remembered)} ${bare(thisMonthKey())}`
  const lands = bare(shiftMonth(thisMonthKey(), 1))

  return (
    <div className="px-4 py-3 md:px-3 desktop:py-2.5">
      <div className="flex items-center gap-3 md:gap-2.5">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2 md:size-8">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium md:text-sm">{title}</p>
        </div>
        {note.toggle}
      </div>
      {note.body && <div className="mt-2 pl-12 md:pl-[42px]">{note.body}</div>}
      <div className="mt-2.5 pl-12 md:pl-[42px]">
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={day !== null}
            onChange={(e) => onChange(e.target.checked ? remembered : null)}
            className="size-5 shrink-0 accent-[var(--accent)]"
          />
          <span className="text-sm">Late in the month, count it towards the next one</span>
        </label>
        {day !== null && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-sm text-ink-2">From the</span>
            {/* The width goes on a wrapper: `Select` carries `w-full`, so one
                passed to it does nothing. */}
            <div className="w-24">
              <Select value={String(day)} onChange={(e) => set(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {ordinal(d)}
                  </option>
                ))}
              </Select>
            </div>
            <span className="text-sm text-ink-2">onwards</span>
          </div>
        )}
        <p className="mt-1.5 text-xs text-ink-3">
          {day === null
            ? `${noun} counts in the month it arrives, whenever that is.`
            : `${noun} on ${example} counts towards ${lands}.`}
        </p>
      </div>
    </div>
  )
}

function CategoriesSection() {
  const categories = useCategories()
  const [editing, setEditing] = useState<Category | 'new' | null>(null)
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
  const open = (what: Category | 'new') => {
    setEditing(what)
    setOpened((n) => n + 1)
  }

  return (
    <section>
      <SectionTitle
        action={
          <button type="button" onClick={() => open('new')} className="flex items-center gap-1 text-sm font-medium text-accent">
            <Plus size={14} /> Add
          </button>
        }
      >
        Categories
      </SectionTitle>
      <CategoryTree categories={categories} onOpen={open} />

      <CategoryForm
        key={opened}
        category={editing === 'new' ? undefined : (editing ?? undefined)}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
    </section>
  )
}

function AutomationSection() {
  const rules = useRules()
  return (
    <section>
      <SectionTitle>Automation</SectionTitle>
      <Card className="divide-y divide-hairline">
        {/* Rules moved to their own page. The list here could say what a rule
            was but never what it had done to your data, which is the only
            question worth asking of one. */}
        <Link
          to="/settings/rules"
          className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/50 md:gap-2.5 md:px-3 desktop:py-2.5"
        >
          <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2 md:size-8">
            <Wand2 size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium md:text-sm">Categorisation rules</p>
            <p className="truncate text-sm text-ink-3 md:text-xs">
              {rules.length === 0
                ? 'Nothing learned yet — categorise a payee and it is remembered'
                : `${rules.length} learned · apply them to transactions you have already recorded`}
            </p>
          </div>
          <ChevronRight size={16} className="shrink-0 text-ink-3" />
        </Link>
        <TransferModeRow />
      </Card>
    </section>
  )
}

function DataSection() {
  const wide = useWide()
  const [demoOpen, setDemoOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <section>
      <SectionTitle>Your data</SectionTitle>
      <Card className="space-y-3 p-4 md:p-3">
        <p className="text-sm text-ink-2">
          Data lives on this device (and syncs via your household when signed in). Backups are handy before big
          changes, or for moving data without sync.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="subtle" onClick={async () => downloadJSON(await exportJSON())}>
            <Download size={15} /> Export backup
          </Button>
          <Button variant="subtle" onClick={() => fileRef.current?.click()}>
            <Upload size={15} /> Import backup
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              // "Replaces" was never true — `importJSON` adds, and ids are
              // preserved so re-importing the same file is a no-op rather than
              // a second copy of everything.
              const ok = await confirmAction({
                title: 'Restore from this backup?',
                body: 'Its contents are ADDED to what is already here. Rows keep their ids, so restoring the same file twice is not a second copy of everything.',
                confirmLabel: 'Restore',
              })
              if (!ok) return
              try {
                const { added, skippedPrivate } = await importJSON(await f.text())
                if (skippedPrivate > 0) {
                  await alertAction(`Restored ${added} row${added === 1 ? '' : 's'}`, [
                    `${skippedPrivate} were somebody else’s private categories, budgets or goals, so they were left alone — the server would have refused them.`,
                  ])
                } else {
                  toast(`Restored ${added} row${added === 1 ? '' : 's'}`, { tone: 'success' })
                }
              } catch (err) {
                await alertAction('That file could not be imported', err instanceof Error ? err.message : undefined)
              }
            }}
          />
          <Button variant="subtle" onClick={() => setDemoOpen(true)}>
            <Sparkles size={15} /> Load demo data
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              /* Still asked twice. The second question is not ceremony: the
                 first describes a scope somebody has to read, and the whole
                 point of the second is that it is answered after reading it. */
              const scope = await confirmAction({
                title: 'Erase everything of yours?',
                body: [
                  'Every account you own goes, and everything recorded on it — along with your own budgets, goals and categories, and the household’s shared ones.',
                  'Accounts other people own are untouched, and so is anything private to them.',
                  'Export a backup first if you want a copy.',
                ],
                confirmLabel: 'Continue',
                tone: 'danger',
              })
              if (!scope) return
              const sure = await confirmAction({
                title: 'Really erase it all?',
                body: 'This cannot be undone.',
                confirmLabel: 'Erase everything',
                tone: 'danger',
              })
              if (sure) await clearAllData()
            }}
          >
            <Trash2 size={15} /> Erase everything
          </Button>
        </div>
      </Card>

      {/* Wide screens only: on a phone this is on the Settings index itself,
          in the same box as the link to this page, which is where it was asked
          for and where it is one tap rather than two. */}
      {wide && (
        <Card className="mt-3 md:mt-2.5">
          <SyncAndAccount />
        </Card>
      )}

      <DemoDataForm open={demoOpen} onClose={() => setDemoOpen(false)} />
    </section>
  )
}

/**
 * The settings worth having in your hand rather than behind a chevron.
 *
 * An index of six words was tidier than the flat list it replaced and hid the
 * two things people actually come here to do — flip the theme, and check who
 * they are signed in as. Both are one control, so both sit at the top, usable
 * where they are.
 *
 * Phone only. A wide screen already shows every section at once, and putting
 * the theme in two places there would be two controls for one setting.
 */
function QuickSettings() {
  const { themePref, setThemePref } = useApp()
  const { userId } = useSyncState()
  const members = useMembers()
  const me = members.find((m) => m.userId === userId)
  const others = Math.max(0, members.length - 1)

  return (
    <div className="mb-4 space-y-2">
      <Card className="p-4">
        <Segmented value={themePref} onChange={setThemePref} options={THEME_OPTIONS} />
      </Card>

      {/* This IS the household group's row — your face on it rather than an
          icon, because you are the first thing in it. There is no separate
          "Household & people" line below: the two were the same destination
          twice, which reads as two places until you have been to both. */}
      <Card>
        <Link
          to="/settings/household"
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/50 active:bg-surface-2"
        >
          <PersonDot member={me} size={38} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{me ? nameOf(me) : 'Your profile'}</p>
            <p className="truncate text-sm text-ink-3">
              {others === 0
                ? 'Your name and photo, and who you share with'
                : `Your name and photo · ${others} other ${others === 1 ? 'person' : 'people'}`}
            </p>
          </div>
          <ChevronRight size={16} className="shrink-0 text-ink-3" />
        </Link>
      </Card>
    </div>
  )
}

/**
 * Signing in, syncing, and getting out — folded away under the data it belongs
 * with.
 *
 * These used to be three buttons at the bottom of the household card, which is
 * where you would look for them only if you already knew. They are about this
 * DEVICE's connection rather than about the household, so they sit with the
 * backups: the group of things you do to the copy of the data in your hand.
 *
 * Expandable rather than a seventh row, because the state — synced or not, and
 * as whom — is the part that is worth reading at a glance, and it fits on the
 * closed row.
 */
function SyncAndAccount() {
  const sync = useSyncState()
  const [open, setOpen] = useState(false)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/50 active:bg-surface-2"
      >
        <div
          className={cx(
            'grid size-9 shrink-0 place-items-center rounded-xl',
            sync.online ? 'bg-good/10 text-good-text' : 'bg-surface-2 text-ink-2',
          )}
        >
          {sync.online ? <Cloud size={17} /> : <CloudOff size={17} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{sync.online ? 'Synced' : 'Offline'}</p>
          <p className="truncate text-sm text-ink-3">
            {sync.pending > 0
              ? `${sync.pending} change${sync.pending === 1 ? '' : 's'} waiting${sync.online ? '…' : ' for a connection'}`
              : (sync.email ?? 'Signed in')}
          </p>
        </div>
        <ChevronDown size={16} className={cx('shrink-0 text-ink-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        // `grid-template-rows` from `0fr` is the one way to open to a height
        // nobody has measured; the inner element must carry `min-h-0` and
        // `overflow: hidden` or the content refuses to be squashed.
        <div className="animate-drawer grid">
          <div className="min-h-0 overflow-hidden">
            <div className="flex flex-wrap gap-2 border-t border-hairline px-4 py-3">
              {sync.lastSyncAt && (
                <p className="basis-full text-xs text-ink-3">
                  Last updated {new Date(sync.lastSyncAt).toLocaleTimeString()}
                </p>
              )}
              {sync.error && <p className="basis-full text-xs text-critical-text">Last sync problem: {sync.error}</p>}
              <Button size="sm" variant="subtle" disabled={sync.syncing || !sync.online} onClick={() => void syncNow()}>
                <RefreshCw size={14} className={sync.syncing ? 'animate-spin' : undefined} /> Sync now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void signOut()}>
                <LogOut size={14} /> Sign out
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Settings, in six groups.
 *
 * It had grown to nine sections in one flat list, which a wide screen could
 * absorb — they flow into columns — and a phone could not: appearance sat
 * between the people who share your money and the accounts they share, and
 * "Erase everything" was a long scroll below things nobody visits twice.
 *
 * So the same six groups serve both, in the same order, and only the shape
 * differs. A phone gets an index and walks into one, the way Rules already
 * works — and the summary line under each is live, so the index answers "how
 * many accounts do we have" without being opened. A wide screen keeps that
 * index ON SCREEN, down the left, with one group open beside it: see
 * `SettingsShell`. It used to get every group at once, flowed into masonry
 * columns, which is what having the width suggests and is not what it wants —
 * nine cards of unrelated business in one scroll, with "Erase everything" two
 * inches under the theme picker.
 *
 * Two things deliberately sit outside the grouping. `UnsavedChanges` is an
 * alert rather than a place, so it is pinned above the index at both widths and
 * is never something you have to go and find. `Recoverable` is inside Accounts,
 * because a deleted account is an account.
 */
type Group = {
  slug: string
  title: string
  icon: LucideIcon
  /** The live line under the title on the phone index. */
  Summary: () => ReactNode
  Body: () => ReactNode
}

const GROUPS: Group[] = [
  {
    slug: 'household',
    title: 'Household & people',
    icon: Users,
    Summary: () => {
      const members = useMembers()
      const admins = members.filter((m) => m.role === 'admin').length
      return members.length === 0
        ? 'Who you share with, and what they can reach'
        : `${members.length} ${members.length === 1 ? 'person' : 'people'} · ${admins} ${admins === 1 ? 'admin' : 'admins'} · when a month starts`
    },
    Body: () => (
      <div className="space-y-6 md:space-y-5">
        <section>
          <SectionTitle>Household</SectionTitle>
          <HouseholdCard />
        </section>
        <section>
          <SectionTitle>People</SectionTitle>
          <MembersCard />
        </section>
        <MonthRuleSection />
      </div>
    ),
  },
  {
    slug: 'accounts',
    title: 'Accounts',
    icon: Wallet,
    Summary: () => {
      const accounts = useAccounts()
      return accounts.length === 0
        ? 'Add the accounts your money moves through'
        : `${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'} · who can see each one · currency`
    },
    Body: () => (
      <div className="space-y-6 md:space-y-5">
        <AccountsSection />
        {/* Beside the accounts an import lands in, and above the two other
            things on this screen that are about undoing something. */}
        <ImportsSection />
        <CurrencySection />
        <OwedSection />
        <Recoverable />
      </div>
    ),
  },
  {
    slug: 'categories',
    title: 'Categories',
    icon: Shapes,
    Summary: () => {
      const categories = useCategories()
      const parents = categories.filter((c) => !c.parentId).length
      const subs = categories.length - parents
      return subs === 0
        ? `${parents} ${parents === 1 ? 'category' : 'categories'}`
        : `${parents} ${parents === 1 ? 'category' : 'categories'} · ${subs} sub`
    },
    Body: () => <CategoriesSection />,
  },
  {
    slug: 'automation',
    title: 'Automation',
    icon: Wand2,
    Summary: () => {
      const rules = useRules()
      return rules.length === 0
        ? 'Categorisation rules, and spotting transfers'
        : `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'} learned · transfer detection`
    },
    Body: () => <AutomationSection />,
  },
  {
    slug: 'appearance',
    title: 'Appearance',
    icon: Palette,
    Summary: () => {
      const { themePref } = useApp()
      return themePref === 'system' ? 'Following your device' : themePref === 'dark' ? 'Dark' : 'Light'
    },
    Body: () => <AppearanceSection />,
  },
  {
    slug: 'data',
    title: 'Your data',
    icon: Database,
    Summary: () => 'Backups, demo data, erase everything',
    Body: () => <DataSection />,
  },
]

/**
 * What the header calls each group's own screen.
 *
 * Exported so `Layout`'s title map does not have to keep its own copy of these
 * six words and drift from them. The subpage renders no heading of its own for
 * the same reason: the top bar already says where you are.
 */
export const SETTINGS_GROUP_TITLES: Record<string, string> = Object.fromEntries(
  GROUPS.map(({ slug, title }) => [`/settings/${slug}`, title]),
)

/**
 * Which version this is, and how to get a newer one.
 *
 * An installed app on iOS is restored rather than launched, so it can sit
 * several deploys behind with nothing on screen admitting it — see
 * `lib/updates.ts`. The app checks by itself whenever it comes back to the
 * front; this is for the times you know something has shipped and want to ask
 * outright rather than force-quitting the app until it notices.
 */
function VersionCard() {
  const { status, checkedAt, builtAt } = useUpdateState()
  const [taking, setTaking] = useState(false)
  // Both mean "there is a newer version" — they differ only in how much work
  // taking it is, which is `installUpdate`'s problem rather than the reader's.
  const ready = status === 'ready' || status === 'stale'

  const built = `Built ${fmtFullDate(builtAt.slice(0, 10))} at ${fmtTime(Date.parse(builtAt))}`
  const line =
    status === 'checking'
      ? 'Looking for a new version\u2026'
      : status === 'ready'
        ? 'A new version is ready to install'
        : status === 'stale'
          ? 'A new version is on the server — tap to fetch it'
          : status === 'unsupported'
            ? `${built} · updates arrive when the app is reopened in this browser`
            : status === 'offline'
              ? 'Could not reach the server — check again when you are online'
              : status === 'current' && checkedAt
                ? `${built} · up to date as of ${fmtTime(checkedAt)}`
                : built

  // No margin of its own: it sits at the bottom of the phone's index, in a
  // spaced stack in the desktop's "This device" pane, and a top margin baked in
  // here would be a stray gap in one of the two.
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Version</p>
          <p className="text-xs text-ink-3">{line}</p>
        </div>
        {ready ? (
          <Button
            size="sm"
            disabled={taking}
            onClick={() => {
              setTaking(true)
              void installUpdate()
            }}
          >
            <ArrowDownToLine size={14} /> {taking ? 'Updating\u2026' : 'Update now'}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="subtle"
            disabled={status === 'checking' || status === 'unsupported'}
            onClick={() => void checkForUpdate({ manual: true })}
          >
            <RefreshCw size={14} className={cx(status === 'checking' && 'animate-spin')} /> Check for updates
          </Button>
        )}
      </div>
    </Card>
  )
}

/**
 * The line under the app, at the bottom of the Settings INDEX and nowhere else.
 *
 * It used to be at the bottom of every group screen as well, on the reasoning
 * that each of those is the bottom of a phone's navigation. Six copies of "which
 * version is this" is not six answers, though — it is one answer asked six
 * times, and a Check for updates button beside a list of categories reads as
 * something to do with categories. The index is one tap away from any of them.
 */
function Colophon() {
  return (
    <div className="mt-6 space-y-3">
      <VersionCard />
      <p className="px-1 text-xs text-ink-3">
        Hearth · a private family finance app. Install it from your browser's share / install menu for the full app
        experience.
      </p>
    </div>
  )
}

/**
 * The desktop shell: a list of compartments down the left, one of them open on
 * the right.
 *
 * A wide screen used to get every group at once, flowed into masonry columns —
 * on the reasoning that having the width, you may as well use it. What that
 * actually produced was nine cards of unrelated business in one scroll, where
 * "Erase everything" sat two inches under the theme picker and the only way to
 * find anything was to read all of it. The phone's index is the better shape
 * and always was; a wide screen can simply keep the index on screen while you
 * are inside a compartment, which is the one thing a phone cannot.
 *
 * The routes are unchanged — each group is still `/settings/<slug>`, still a
 * real page, still a valid deep link — so this is a second way of drawing the
 * same navigation rather than a second navigation.
 *
 * The list is sticky against the scroller's own top, which `#app-scroll`'s
 * padding has already cleared of the floating header: `top-0` is the line
 * content starts at, not the top of the window.
 */
function SettingsShell({ active, children }: { active: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-5">
      <nav aria-label="Settings sections" className="sticky top-0 w-52 shrink-0 xl:w-56">
        <Card className="p-1.5">
          <ul className="space-y-0.5">
            {[OVERVIEW, ...GROUPS].map(({ slug, title, icon: Icon }) => {
              const on = active === slug
              return (
                <li key={slug}>
                  <Link
                    to={slug === OVERVIEW.slug ? '/settings' : `/settings/${slug}`}
                    aria-current={on ? 'page' : undefined}
                    className={cx(
                      // The rail's row, restated: a capsule that fills with the
                      // accent at 12% when it is the one you are on. Two lists
                      // of places at two depths of the same app should not need
                      // reading twice.
                      'flex items-center gap-2.5 rounded-full px-2.5 py-2 text-sm font-medium transition-colors',
                      on ? 'bg-accent/12 text-accent' : 'text-ink-2 hover:bg-surface-2/60 hover:text-ink',
                    )}
                  >
                    <Icon size={17} className="shrink-0" />
                    <span className="truncate">{title}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </Card>
      </nav>
      {/* `min-w-0`, or a card holding a wide table grows this flex item to fit
          it and the page ends up wider than the window. */}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * The one compartment that is not a group: this device, and this app.
 *
 * Everything in it — whether the writes have landed, who is signed in, which
 * build this is — is about the copy of Hearth in front of you rather than about
 * the household's data, which is why none of it belongs inside one of the six.
 * On a phone the same three things sit at the bottom of the index, where the
 * bottom of a single screen is a place; on a desktop the index never ends, so
 * they need a room.
 */
const OVERVIEW = { slug: 'overview', title: 'This device', icon: Cloud }

function OverviewBody() {
  return (
    <div className="space-y-4">
      <Card>
        <SyncAndAccount />
      </Card>
      <VersionCard />
      <p className="px-1 text-xs text-ink-3">
        Hearth · a private family finance app. Install it from your browser's share / install menu for the full app
        experience.
      </p>
    </div>
  )
}

export default function SettingsPage() {
  const wide = useWide()

  // On a wide screen the index is the shell with nothing opened in it yet, and
  // "this device" is what the pane opens on. Deliberately NOT the first group:
  // an index that silently shows one compartment reads as that compartment
  // being where you landed, and the list beside it as somewhere else to go.
  if (wide) {
    return (
      <div>
        {/* `empty:hidden` so the gap goes with it: UnsavedChanges renders
            nothing at all when there is nothing that failed to save, and a
            wrapper carrying a margin around nothing is a stray gap. */}
        <div className="mb-5 empty:hidden">
          <UnsavedChanges />
        </div>
        <SettingsShell active={OVERVIEW.slug}>
          <OverviewBody />
        </SettingsShell>
      </div>
    )
  }

  // Two of the six are already above the list: the theme is inlined in the quick
  // box, and the household is the row with your face on it. Listing either again
  // would be a second door to the same room.
  const rows = GROUPS.filter((g) => !['appearance', 'household', 'data'].includes(g.slug))
  const data = GROUPS.find((g) => g.slug === 'data')!

  return (
    <div>
      <div className="mb-4 empty:hidden">
        <UnsavedChanges />
      </div>

      <QuickSettings />

      <Card>
        <ul className="divide-y divide-hairline">
          {rows.map(({ slug, title, icon: Icon, Summary }) => (
            <li key={slug}>
              <Link
                to={`/settings/${slug}`}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/50 active:bg-surface-2"
              >
                <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2">
                  <Icon size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{title}</p>
                  <p className="truncate text-sm text-ink-3">
                    <Summary />
                  </p>
                </div>
                <ChevronRight size={16} className="shrink-0 text-ink-3" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      {/* This device's copy of the data, and this device's connection to the
          household that holds it — the same subject from two sides. */}
      <Card className="mt-4">
        <div className="divide-y divide-hairline">
          <Link
            to={`/settings/${data.slug}`}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/50 active:bg-surface-2"
          >
            <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2">
              <data.icon size={17} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{data.title}</p>
              <p className="truncate text-sm text-ink-3">
                <data.Summary />
              </p>
            </div>
            <ChevronRight size={16} className="shrink-0 text-ink-3" />
          </Link>
          <SyncAndAccount />
        </div>
      </Card>

      <Colophon />
    </div>
  )
}

/**
 * One group, on its own screen.
 *
 * Reached from the phone index, and a perfectly valid page at any width — the
 * back link is the only thing that assumes where you came from, and it is true
 * wherever you came from. An unknown slug goes back to the index rather than
 * rendering an empty page: these come from typed URLs and old bookmarks, and
 * "nothing here" is a worse answer than the list of what there is.
 */
export function SettingsGroupPage() {
  const { group } = useParams()
  const wide = useWide()
  const found = GROUPS.find((g) => g.slug === group)
  if (!found) return <Navigate to="/settings" replace />
  const { Body } = found

  // On a wide screen the list of compartments is still on screen beside this
  // one, so there is nothing to go back to and no back link. Nor a heading:
  // `Layout` already titles the page with this group's name, and a second copy
  // of the word directly under the first is how the phone's index used to read
  // before the top bar stopped repeating it.
  if (wide) {
    return (
      <SettingsShell active={found.slug}>
        <Body />
      </SettingsShell>
    )
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Link to="/settings" className="flex shrink-0 items-center gap-1 text-sm font-medium text-ink-3 hover:text-ink">
          <ChevronLeft size={16} /> Settings
        </Link>
      </div>
      <Body />
    </div>
  )
}


/**
 * Everyone in the household, and what an admin may do about them.
 *
 * An admin manages PEOPLE and nothing else — they gain no access to any account
 * they were not granted, which is why nothing here touches an account directly.
 * The one exception is removal, and that is spelled out on its own screen
 * before it happens.
 */
function MembersCard() {
  const { userId } = useSyncState()
  const members = useMembers()
  const isAdmin = useIsAdmin()
  // The open member is held as an ID and looked up live, never copied into
  // state. Changing a role bumps the visibility epoch, which drops the whole
  // cache and re-pulls; a captured object would survive that as a stale render
  // showing the value you had just changed away from.
  const [openId, setOpenId] = useState<string | null>(null)
  const open = members.find((m) => m.userId === openId)

  const me = members.find((m) => m.userId === userId)

  return (
    <>
      {me && <YouCard me={me} />}
      {members.length === 0 ? (
        <Card className="p-4 md:p-3">
          <p className="text-sm text-ink-3">
            Your household list has not synced yet. It will appear once you are back online.
          </p>
        </Card>
      ) : (
      <Card>
        <ul className="divide-y divide-hairline">
          {members.map((m) => (
            <li key={m.userId}>
              <button
                type="button"
                onClick={() => setOpenId(m.userId)}
                className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-2/50 md:px-3 desktop:py-2"
              >
                <PersonDot member={m} size={32} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {nameOf(m)}
                  {m.userId === userId && <span className="ml-1.5 text-sm font-normal text-ink-3">you</span>}
                </span>
                {m.role === 'admin' && <Chip tone="accent">Admin</Chip>}
                <ChevronRight size={16} className="shrink-0 text-ink-3" />
              </button>
            </li>
          ))}
        </ul>
      </Card>
      )}
      {members.length === 1 && (
        <p className="mt-2 px-1 text-xs text-ink-3">
          Share your invite code above to bring somebody in. Nothing of yours becomes visible to them until you
          share an account with them.
        </p>
      )}
      {/* Kept mounted across a cache rebuild: the sheet reads whichever row is
          current, so a role change updates it in place instead of closing and
          flashing back with the old value. */}
      {open && (
        <MemberSheet
          key={open.userId}
          member={open}
          isAdmin={isAdmin}
          isMe={open.userId === userId}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  )
}


/**
 * Your own name and picture.
 *
 * Both are optional in the sense that Hearth works without them, but a
 * household where everybody is "Someone" makes every permissions screen
 * useless, so the name is always set to *something* — the server backfills it
 * from your email address, and this is where you change it to what you would
 * rather be called.
 *
 * The picture is downscaled here, in the browser, and stored on the row rather
 * than in a bucket. At the size it is ever displayed that is a few kilobytes,
 * which is cheaper than the infrastructure and its extra failure mode.
 */
function YouCard({ me }: { me: HouseholdMember }) {
  const [name, setName] = useState(nameOf(me))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const fileRef = useRef<HTMLInputElement>(null)

  async function save(patch: { name?: string; avatar?: string }) {
    setBusy(true)
    setError(undefined)
    try {
      await rpc('set_profile', { p_name: patch.name ?? null, p_avatar: patch.avatar ?? null })
      await syncNow()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That could not be saved')
    }
    setBusy(false)
  }

  async function pickPhoto(file: File) {
    try {
      const dataUrl = await downscaleImage(file, 96)
      await save({ avatar: dataUrl })
    } catch {
      setError('That image could not be read')
    }
  }

  return (
    <Card className="mb-3 space-y-3 p-4 md:mb-2.5 md:p-3">
      <div className="flex items-center gap-3">
        <PersonDot member={me} size={48} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink-3">This is how you appear to everyone else</p>
          <TextInput
            className="mt-1"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const trimmed = name.trim()
              if (!trimmed) {
                setName(nameOf(me))
                return
              }
              if (trimmed !== nameOf(me)) void save({ name: trimmed })
            }}
            placeholder="Your name"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void pickPhoto(file)
            e.target.value = ''
          }}
        />
        <Button size="sm" variant="subtle" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> {me.avatarUrl ? 'Change photo' : 'Add a photo'}
        </Button>
        {me.avatarUrl && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save({ avatar: '' })}>
            Remove photo
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-critical-text">{error}</p>}
    </Card>
  )
}

/**
 * Square-crop and shrink an image to `size` px, as a JPEG data URL.
 *
 * Done here rather than server-side because the alternative is uploading a
 * 4MB phone photo to store 4KB of it.
 */
async function downscaleImage(file: File, size: number): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas')
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  )
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.82)
}

interface DeparturePreviewRow {
  account_id: string
  account_name: string
  outcome: 'leaves_with_them' | 'stays_with_others' | 'loses_access'
}

function MemberSheet({
  member,
  isAdmin,
  isMe,
  onClose,
}: {
  member: HouseholdMember
  isAdmin: boolean
  isMe: boolean
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [preview, setPreview] = useState<DeparturePreviewRow[] | null>(null)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      await syncNow()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work')
    }
    setBusy(false)
  }

  const name = nameOf(member)

  return (
    <Sheet open onClose={onClose} title={nameOf(member)}>
      <div className="space-y-4">
        {isAdmin && !isMe && (
          <Field
            label="Role"
            info={
              <p>
                Admins can invite and remove people, and reset the invite code. It gives them no access to any
                account.
              </p>
            }
          >
            <Segmented
              value={member.role}
              onChange={(role) => void run(() => rpc('set_member_role', { p_user_id: member.userId, p_role: role }))}
              options={[
                { value: 'member', label: 'Member' },
                { value: 'admin', label: 'Admin' },
              ]}
            />
          </Field>
        )}

        {error && <p className="text-sm text-critical-text">{error}</p>}

        {isAdmin && !isMe && !preview && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                // Ask the server what would happen rather than guessing from
                // this device's cache, which cannot see accounts it holds no
                // grant on — exactly the accounts most affected.
                const rows = await rpc<DeparturePreviewRow[]>('preview_departure', { p_user_id: member.userId })
                setPreview(rows ?? [])
              })
            }
          >
            <Trash2 size={15} /> Remove from the household
          </Button>
        )}

        {preview && (
          <div className="space-y-3">
            <p className="text-sm font-medium">If you remove {name}:</p>
            <DepartureGroup
              title={`${name} takes these with them`}
              hint="They are the only owner, so it disappears from your list."
              rows={preview.filter((r) => r.outcome === 'leaves_with_them')}
            />
            <DepartureGroup
              title="These stay with you"
              hint={`Somebody else owns them too, so ${name} simply loses access.`}
              rows={preview.filter((r) => r.outcome === 'stays_with_others')}
            />
            <DepartureGroup
              title={`${name} loses access to these`}
              hint="They were never an owner of them."
              rows={preview.filter((r) => r.outcome === 'loses_access')}
            />
            <p className="text-xs text-ink-3">
              Anything {name} recorded on an account that stays here stays here too, under their name. They keep a
              copy of the category names so their own history still reads properly.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await rpc('remove_member', { p_user_id: member.userId })
                    onClose()
                  })
                }
              >
                {busy ? 'Removing…' : `Remove ${name}`}
              </Button>
            </div>
          </div>
        )}

        {!isAdmin && (
          <p className="text-sm text-ink-3">
            Only an admin can change roles or remove somebody from the household.
          </p>
        )}
      </div>
    </Sheet>
  )
}

function DepartureGroup({ title, hint, rows }: { title: string; hint: string; rows: DeparturePreviewRow[] }) {
  if (rows.length === 0) return null
  return (
    <div className="rounded-xl bg-surface-2 px-4 py-3">
      <p className="text-sm font-medium">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <li key={r.account_id} className="text-sm text-ink-2">
            {r.account_name}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-ink-3">{hint}</p>
    </div>
  )
}

/**
 * A level, as one glyph.
 *
 * This is the whole icon vocabulary for access in this file — the balance-only
 * marker beside an account name reads out of the same table — so an eye with a
 * line through it means "no line items" wherever it appears, and never anything
 * else. A glyph rather than a colour because six levels is more hues than
 * anyone can hold, and colour alone carries nothing to a reader who cannot
 * separate them.
 */
const LEVEL_ICON: Record<GrantLevel, LucideIcon> = {
  owner: Crown,
  manage: Pencil,
  contribute: Plus,
  view: Eye,
  balance: EyeOff,
  none: Lock,
}

/**
 * Who can see an account, small enough to sit in a list row.
 *
 * A face on its own answers "who" and leaves "at what level" to be guessed, so
 * each one carries its level as a badge.
 *
 * The caller must have checked `canManageAccount` first. `account_grants_select`
 * hands over other people's grants on accounts you manage and nowhere else, so
 * rendered any lower this would confidently show "only you" on an account three
 * people are reading.
 */
function AccessFaces({ grants, meId }: { grants: AccountGrant[]; meId?: string }) {
  const memberMap = useMemberMap()

  // Strongest access first, and yourself first among equals — the owner is the
  // useful thing to find, and your own face is the one you scan for.
  const ordered = useMemo(
    () =>
      [...grants].sort(
        (a, b) =>
          LEVELS.indexOf(a.level as GrantLevel) - LEVELS.indexOf(b.level as GrantLevel) ||
          Number(b.userId === meId) - Number(a.userId === meId) ||
          nameOf(memberMap.get(a.userId)).localeCompare(nameOf(memberMap.get(b.userId))),
      ),
    [grants, meId, memberMap],
  )

  const describe = (g: AccountGrant) =>
    `${g.userId === meId ? 'You' : nameOf(memberMap.get(g.userId))} — ${LEVEL_LABEL[g.level as GrantLevel]}`

  if (!ordered.length) return null

  return (
    <span
      className="flex shrink-0 items-center gap-1.5"
      role="img"
      aria-label={`Shared with ${ordered.map(describe).join(', ')}`}
    >
      {ordered.map((g) => {
        const Icon = LEVEL_ICON[g.level as GrantLevel]
        return (
          <span key={g.id} className="relative" title={describe(g)}>
            <PersonDot member={memberMap.get(g.userId)} size={26} />
            <span className="absolute -bottom-px -right-px grid size-3.5 place-items-center rounded-full bg-surface text-ink-2 ring-1 ring-hairline">
              <Icon size={9} strokeWidth={2.5} />
            </span>
          </span>
        )
      })}
    </span>
  )
}

function AccountsSection() {
  const { money } = useApp()
  const { userId } = useSyncState()
  const accounts = useAccounts()
  const txns = useAllTransactions() ?? []
  const remoteBalances = useRemoteBalances()
  const levels = useMyLevels()
  const grantsByAccount = useGrantsByAccount()
  const [editing, setEditing] = useState<Account | 'new' | null>(null)
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
  const openForm = (what: Account | 'new') => {
    setEditing(what)
    setOpened((n) => n + 1)
  }

  /**
   * Whether the list can be dragged into an order.
   *
   * All of them or none of them: every account sits at `sortOrder` 0 until
   * somebody drags one, so there is no spare numbering to slot into and a move
   * renumbers every row it passes. One account you may not write is therefore
   * enough to make the whole list unwritable — and a write refused by
   * `accounts_update` would come back minutes later as a dead letter rather
   * than as a refusal on screen.
   */
  const canReorder = accounts.length > 1 && accounts.every((a) => canManageAccount(levelOn(a.id, levels)))

  return (
    <section>
      <SectionTitle
        action={
          <button type="button" onClick={() => openForm('new')} className="flex items-center gap-1 text-sm font-medium text-accent">
            <Plus size={14} /> Add
          </button>
        }
      >
        Accounts
      </SectionTitle>
      <AccountList
        accounts={accounts}
        canReorder={canReorder}
        renderRow={(a) => {
          const level = levelOn(a.id, levels)
          // Opening the edit sheet needs `manage`, the same bar as the
          // accounts_update policy. Below that there is nothing to edit, so
          // the row is a read-only line rather than a dead button.
          const editable = canManageAccount(level)
          // The same bar governs whether the sharing list is knowable at all;
          // see useGrantsByAccount. Below it, the row's own level chip is the
          // only honest thing to say about access.
          const grants = editable ? (grantsByAccount.get(a.id) ?? []) : []
          const shared = grants.some((g) => g.userId !== userId)
          return (
            <button
              type="button"
              onClick={() => (editable ? openForm(a) : undefined)}
              className={cx(
                'flex w-full items-center gap-3 px-4 py-3 text-left md:px-3 desktop:py-2',
                editable ? 'hover:bg-surface-2/50' : 'cursor-default',
              )}
            >
              {/* The account's own face, the same badge the Activity table
                  and the home widget draw — this list was the one place
                  accounts were named without being shown, so the row you
                  come here to recolour was the row that never showed the
                  colour. `AccountDot` goes through `accountFace`, so an
                  account nobody has styled wears the one its kind implies
                  rather than a grey hole. */}
              <AccountDot account={a} size={32} className="desktop:[--dot:28px]" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 font-medium">
                  <span className="truncate">{a.name}</span>
                  {/* A struck-through eye means the total is all you get: no
                      line items, so no Activity, no reports, no budget
                      contribution. Same glyph as the `balance` badge. */}
                  {!canSeeTransactionsAt(level) && <EyeOff size={13} className="shrink-0 text-ink-3" />}
                </p>
                <p className="flex items-center gap-1.5 text-sm text-ink-3">
                  {a.kind}
                  {level !== 'owner' && <Chip>{LEVEL_LABEL[level]}</Chip>}
                </p>
              </div>
              {editable &&
                (shared ? (
                  <AccessFaces grants={grants} meId={userId} />
                ) : (
                  /* Nobody else has a grant. Said out loud, because a row
                     with no faces on it is otherwise indistinguishable from
                     one whose faces have not loaded. */
                  <span className="shrink-0 text-ink-3" title="Only you" role="img" aria-label="Only you">
                    <Lock size={13} />
                  </span>
                ))}
              <span className={cx('font-semibold tabular', balanceOf(a, txns, remoteBalances, level) < 0 && 'text-critical-text')}>
                {money(balanceOf(a, txns, remoteBalances, level))}
              </span>
            </button>
          )
        }}
      />
      {/* Said rather than left as a missing handle. Ordering is a column on the
          account row, so it is `accounts_update` like any other edit — and
          because a move renumbers the whole list it takes all of them, not just
          the one that moved. */}
      {!canReorder && accounts.length > 1 && (
        <p className="mt-2 px-1 text-xs text-ink-3">
          The order is fixed while the list holds an account somebody else manages — moving one renumbers them
          all.
        </p>
      )}
      <AccountForm
        key={opened}
        account={editing === 'new' ? undefined : (editing ?? undefined)}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
    </section>
  )
}

/**
 * Who can see one account, and at what level.
 *
 * A `Select` per person rather than the stack of radio cards the old
 * three-way visibility picker used: six levels times however many people is an
 * enormous scroll on a phone, and the explanation belongs behind a disclosure
 * rather than repeated on every row.
 *
 * Only an owner may change anything here — `upsert_account_grant` refuses
 * otherwise — so for everybody else this is a read-only summary.
 */
function AccountAccessSheet({ account, open, onClose }: { account: Account; open: boolean; onClose: () => void }) {
  const { userId } = useSyncState()
  const members = useMembers()
  const memberMap = useMemberMap()
  const grants = useGrantsFor(account.id)
  const levels = useMyLevels()
  const mayShare = canAdministerAccount(levelOn(account.id, levels))
  const [error, setError] = useState<{ userId: string; message: string } | null>(null)

  /**
   * Deny by default, with one exception: your OWN row falls back to
   * `useMyLevels`, which is also what every permission decision in the app
   * reads. On a just-created account the owner grant has not arrived yet, and
   * without this the person who made it is listed as having no access to it.
   * Everybody else stays at `none` — a missing grant genuinely is no access.
   */
  const levelFor = (uid: string): GrantLevel =>
    (grants.find((g) => g.userId === uid)?.level as GrantLevel | undefined) ??
    (uid === userId ? levelOn(account.id, levels) : 'none')

  const owners = grants.filter((g) => g.level === 'owner')

  async function change(uid: string, next: GrantLevel) {
    setError(null)
    // The server refuses to leave an account with no owner. Saying so here,
    // against the row that caused it, beats an alert that has lost the context.
    if (next !== 'owner' && levelFor(uid) === 'owner' && owners.length <= 1) {
      setError({ userId: uid, message: 'An account must always have an owner. Make somebody else an owner first.' })
      return
    }
    /**
     * Taking access away from YOURSELF.
     *
     * Legal, and the server allows it whenever somebody else still owns the
     * account — but the consequence is not what the row you just changed looks
     * like it does. The account, its balance and every transaction on it leave
     * this app immediately, and you cannot put them back: reading the sharing
     * list needs a grant, so there is nothing left to click. Only the remaining
     * owner can undo it.
     *
     * So it asks, and it names who will still have it, because "are you sure"
     * on its own does not tell you whether you are about to strand the account
     * with your partner or with nobody you can reach.
     */
    if (uid === userId && !atLeast(next, levelFor(uid))) {
      const others = owners
        .filter((g) => g.userId !== userId)
        .map((g) => nameOf(memberMap.get(g.userId)))
      const willVanish = next === 'none' || !canSeeAccount(next)
      /* Two paragraphs, which is why this could never be a `confirm()`: it was
         passing `\n\n` to a control that has no paragraphs, so the warning and
         the way out of it ran together into one wall of text. */
      const ok = await confirmAction(
        willVanish
          ? {
              title: `Remove your own access to “${account.name}”?`,
              body: [
                'It disappears from your app straight away, along with its balance and everything recorded on it.',
                others.length
                  ? `${others.join(' and ')} will still own it and can give it back.`
                  : 'Nobody else owns it, so nobody will be able to give it back to you.',
              ],
              confirmLabel: 'Remove my access',
              tone: 'danger',
            }
          : {
              title: `Reduce your own access to ${LEVEL_LABEL[next].toLowerCase()}?`,
              body: [
                `You will not be able to undo this yourself on “${account.name}”.`,
                others.length ? `${others.join(' and ')} can restore it.` : 'Nobody else owns it, so nobody can restore it.',
              ],
              confirmLabel: 'Reduce my access',
              tone: 'danger',
            },
      )
      if (!ok) return
    }
    await setAccountLevel(account.id, uid, next, grants.find((g) => g.userId === uid))
  }

  return (
    <Sheet open={open} onClose={onClose} title={`Who can see ${account.name}`}>
      <div className="space-y-4">
        {!mayShare && (
          <p className="text-sm text-ink-3">
            Only an owner of this account can change who sees it.
          </p>
        )}
        <ul className="divide-y divide-hairline">
          {members.map((m) => {
            const level = levelFor(m.userId)
            return (
              <li key={m.userId} className="py-2.5">
                <div className="flex items-center gap-3">
                  <PersonDot member={m} size={28} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {nameOf(m)}
                    {m.userId === userId && <span className="ml-1.5 text-xs font-normal text-ink-3">you</span>}
                  </span>
                  {mayShare ? (
                    /* The width goes on a wrapper, not on the Select. Select
                       carries `w-full`, and Tailwind emits `.w-full` after
                       `.w-40`, so it wins however the classes are ordered in
                       the attribute — the control filled the row and squeezed
                       the name beside it to nothing. */
                    <span className="w-36 shrink-0 sm:w-44">
                      <Select
                        value={level}
                        onChange={(e) => void change(m.userId, e.target.value as GrantLevel)}
                      >
                        {LEVELS.map((l) => (
                          <option key={l} value={l}>
                            {LEVEL_LABEL[l]}
                          </option>
                        ))}
                      </Select>
                    </span>
                  ) : (
                    <Chip>{LEVEL_LABEL[level]}</Chip>
                  )}
                </div>
                {error?.userId === m.userId && (
                  <p className="mt-1.5 text-xs text-critical-text">{error.message}</p>
                )}
              </li>
            )
          })}
        </ul>

        {members.length === 1 && (
          <p className="text-sm text-ink-3">
            Nobody else is in your household yet. Invite someone from the People section and they will appear here.
          </p>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer text-ink-3 hover:text-ink-2">What these mean</summary>
          <dl className="mt-2 space-y-2">
            {LEVELS.map((l) => (
              <div key={l}>
                <dt className="text-sm font-medium">{LEVEL_LABEL[l]}</dt>
                <dd className="text-xs text-ink-3">{LEVEL_HINT[l]}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </Sheet>
  )
}

/**
 * Where should six months of fake spending go?
 *
 * Asking is the whole point. This used to pick `db.accounts.toArray()[0]` —
 * whichever row Dexie happened to return first, which is primary-key order over
 * random uuids. In a household with a private account that meant demo data
 * landing in someone's personal account, unpredictably and with no way to say
 * otherwise. Only accounts you can actually record against are offered, matching
 * every other account picker in the app.
 */
function DemoDataForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const allAccounts = useAccounts()
  const levels = useMyLevels()
  const accounts = useMemo(
    () => allAccounts.filter((a) => canAddTransactions(levelOn(a.id, levels))),
    [allAccounts, levels],
  )
  // Default to one you own outright: demo data is for having a look around, and
  // an account you control is the least surprising place for it to appear.
  const preferred = accounts.find((a) => levelOn(a.id, levels) === 'owner') ?? accounts[0]
  const [accountId, setAccountId] = useState<string | undefined>(preferred?.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const chosen = accountId ?? preferred?.id

  async function load() {
    if (!chosen) return
    setBusy(true)
    setError(undefined)
    try {
      await seedDemoData(chosen)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Demo data could not be loaded.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Load demo data"
      footer={
        <Button size="lg" className="flex-1" disabled={!chosen || busy} onClick={load}>
          {busy ? 'Loading…' : 'Load demo data'}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-2">
          Adds six months of example transactions, bills and budgets so you can see how Hearth looks with data in it.
          It is added to the account you pick, and syncs to your household like anything else.
        </p>
        <Field label="Add it to" hint="Only accounts you can record against are listed.">
          <Select value={chosen ?? ''} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {levelOn(a.id, levels) !== 'owner' ? ` · ${LEVEL_LABEL[levelOn(a.id, levels)].toLowerCase()}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        {accounts.length === 0 && (
          <p className="text-sm text-critical-text">You need an account before demo data has somewhere to go.</p>
        )}
        {error && <p className="text-sm text-critical-text">{error}</p>}
      </div>
    </Sheet>
  )
}

function AccountForm({ account, open, onClose }: { account?: Account; open: boolean; onClose: () => void }) {
  const { currency, resolvedTheme } = useApp()
  const { userId } = useSyncState()
  const [name, setName] = useState(account?.name ?? '')
  const [kind, setKind] = useState<Account['kind']>(account?.kind ?? 'current')
  /** '' means derive from who is on the account, which is the normal case. */
  const [book, setBook] = useState<'' | 'household' | 'mine'>(account?.bookOverride ?? '')
  /**
   * Seeded from what the account currently SHOWS, not from what it stores.
   *
   * An account nobody has styled stores neither, and starting the pickers blank
   * would offer to change something away from a face the user can see on every
   * other screen. `accountFace` is that face; opening the form and saving
   * without touching anything writes down what was already true.
   */
  const stored = { slot: account?.slot, icon: account?.icon }
  const [slot, setSlot] = useState(() => accountFace({ kind: account?.kind ?? 'current', ...stored }).slot)
  const [icon, setIcon] = useState(() => accountFace({ kind: account?.kind ?? 'current', ...stored }).icon)
  /** A colour of its own, overriding the slot. Undefined is the normal case. */
  const [color, setColor] = useState(account?.color)
  /**
   * The mark on the tile, where measuring it is not the answer. Undefined is
   * the normal case and means "measure it" — see `InkPicker`.
   */
  const [ink, setInk] = useState(account?.ink)
  /**
   * The tile as a measurable hex, for the two controls that preview it.
   * Undefined off the DOM, where both fall back to the tint — see `paintHex`.
   */
  const fill = paintHex(slot, color, resolvedTheme)
  /**
   * Whether the face is still the one `kind` implies.
   *
   * Until somebody picks, changing the type moves the colour and icon with it —
   * switching Current to Savings and being left with a bank icon looks like the
   * form ignored you. Once they have picked, `kind` stops touching it, because
   * their choice is the newer answer.
   */
  const [facePicked, setFacePicked] = useState(
    account?.slot != null || account?.icon != null || account?.color != null || account?.ink != null,
  )
  useEffect(() => {
    if (facePicked) return
    const next = accountFace({ kind })
    setSlot(next.slot)
    setIcon(next.icon)
  }, [kind, facePicked])
  const [sharing, setSharing] = useState(false)
  /**
   * Whether rows on this account marked as the household's are readable by the
   * household.
   *
   * The consent behind `paidForHousehold`, and the ONLY thing in the app that
   * lets a transaction out of the account it lives on. It publishes the marked
   * rows and nothing else — not the balance, not the account's name, not a row
   * that has not been marked — which is why it is a switch here and not a
   * `balance` grant in the sharing sheet next to it.
   */
  const [publishes, setPublishes] = useState(!!account?.publishesHouseholdRows)
  const [opening, setOpening] = useState(
    account?.openingBalanceMinor ? String(account.openingBalanceMinor / 100) : '',
  )
  const [deleting, setDeleting] = useState(false)
  const levels = useMyLevels()
  const grants = useGrantsFor(account?.id)
  const members = useMembers()
  const books = useBooks()
  const myLevel = account ? levelOn(account.id, levels) : 'none'
  const canDelete = canAdministerAccount(myLevel)
  const canSave = name.trim().length > 0

  /**
   * Whether publishing is even a question here.
   *
   * Not on a brand new account (there is nothing on it to publish), not below
   * `manage` (changing it is an ordinary write to the account row, so
   * `accounts_update` decides), not in a household of one, and not on an
   * account already in the household book — money leaving a joint account is
   * already the household's, so the flag would publish rows both people can
   * read anyway.
   */
  const offerPublishing =
    !!account && canManageAccount(myLevel) && members.length > 1 && !books.household.has(account.id)

  // Everyone with any access, so the row can say "3 people" without opening it.
  //
  // Floored at yourself. An account you have only just made has no cached grant
  // — the server writes the owner one on an AFTER INSERT trigger — and "0
  // people" is a worse lie than "Only you", who is in fact exactly who can see
  // it at that moment.
  const sharedWith = Math.max(grants.length, canSeeAccount(myLevel) ? 1 : 0)

  async function save() {
    if (!canSave) return
    const openingMinor = parseAmount(opening) ?? 0
    if (account?.id) {
      /**
       * Withdrawing consent is the one change on this form that takes
       * something away from somebody else, and it is asked about here rather
       * than at the switch so that changing your mind twice costs nothing.
       *
       * Two things it says that are not obvious from the switch: every row
       * already published goes at once, and none of them can be un-read. The
       * epoch bump behind the first is why it is instant rather than gradual —
       * see migration 19.
       */
      if (!!account.publishesHouseholdRows && !publishes) {
        const ok = await confirmAction({
          title: `Stop publishing household expenses from “${account.name}”?`,
          body: [
            'Every row you have marked as the household’s disappears from everybody else’s app, and stops counting towards the household’s spending on their screen.',
            'It does not un-send anything. Whatever has already reached their device has already been read.',
          ],
          confirmLabel: 'Stop publishing',
          tone: 'danger',
        })
        if (!ok) return
      }
      await update('accounts', account.id, {
        name: name.trim(),
        kind,
        openingBalanceMinor: openingMinor,
        bookOverride: book || undefined,
        slot,
        icon,
        color,
        ink,
        publishesHouseholdRows: publishes,
      })
    } else {
      // Nothing about sharing is decided here. Creating an account makes you
      // its owner (a server trigger writes the grant), and who else can see it
      // is a separate, deliberate step.
      //
      // `createdBy` is stamped locally as well, and it is load-bearing rather
      // than cosmetic. The owner grant is written server-side by an AFTER
      // INSERT trigger, so between this call and the next pull there is no
      // grant on this device — and `useMyLevels` bridges that window by reading
      // exactly this field. Without it a newly created account is one you
      // cannot edit, share or delete until a background pull happens to land.
      // `stripLocal` drops it from the queued payload, so the server still
      // stamps its own via `stamp_ownership`; this only fills the gap.
      await create('accounts', {
        name: name.trim(),
        kind,
        openingBalanceMinor: openingMinor,
        // The end of the list, the way a new category gets the end of its own.
        // Every account used to be created at 0, so the list fell back to
        // primary-key order over uuids — see `lib/accountOrder.ts`.
        sortOrder: await db.accounts.count(),
        slot,
        icon,
        color,
        ink,
        createdBy: userId,
      })
    }
    onClose()
  }

  /**
   * Deleting one account, rather than the all-or-nothing "erase everything".
   *
   * The count comes from this device's cache, so it is what to WARN with, never
   * what to act on: the server counts again and refuses if it disagrees, which is
   * the case where a partner has recorded something this device has not pulled yet.
   */
  async function deleteAccount() {
    if (!account?.id) return
    const used = await transactionsOn(account.id)
    const ok = await confirmAction({
      title: `Delete “${account.name}”?`,
      body:
        used > 0
          ? [
              `The ${used} transaction${used === 1 ? '' : 's'} on it go too, and disappear from your reports and budgets.`,
              'It can be brought back from the bin in Settings until somebody deletes it for good.',
            ]
          : 'It can be brought back from the bin in Settings until somebody deletes it for good.',
      confirmLabel: 'Delete account',
      tone: 'danger',
    })
    if (!ok) return

    setDeleting(true)
    try {
      await removeAccount(account.id, used > 0)
      onClose()
    } catch (e) {
      await alertAction('That account could not be deleted', e instanceof Error ? e.message : undefined)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={account ? 'Edit account' : 'New account'}
      onSubmit={() => void save()}
      footer={
        <div className="flex gap-2">
          {canDelete && (
            <Button variant="danger" size="lg" disabled={deleting} onClick={deleteAccount}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          )}
          <Button type="submit" size="lg" className="flex-1" disabled={!canSave || deleting}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My current account" autoFocus={!account} />
          </Field>
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value as Account['kind'])}>
              <option value="current">Current</option>
              <option value="credit">Credit card</option>
              <option value="savings">Savings</option>
              <option value="cash">Cash</option>
            </Select>
          </Field>
        </div>
        <Field label={`Opening balance (${currencySymbol(currency)}, optional)`} hint="The balance before the first transaction recorded in Hearth.">
          <TextInput value={opening} onChange={(e) => setOpening(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </Field>
        <SlotPicker
          value={slot}
          onChange={(next) => {
            setFacePicked(true)
            setSlot(next)
          }}
          color={color}
          onColorChange={(next) => {
            setFacePicked(true)
            setColor(next)
          }}
          hint={facePicked ? undefined : 'from the type'}
        />
        <IconPicker
          value={icon}
          onChange={(next) => {
            setFacePicked(true)
            setIcon(next)
          }}
          colour={paintOf(slot, color)}
          fill={fill}
          ink={ink}
          hint={facePicked ? undefined : 'from the type'}
        />
        {/* Under the two it depends on, because it is the one control here
            whose default is computed from what they say. Moving either of them
            changes what "Auto" resolves to, and the preview beside it is where
            you see that happen. */}
        <InkPicker
          slot={slot}
          color={color}
          value={ink}
          onChange={(next) => {
            setFacePicked(true)
            setInk(next)
          }}
          icon={icon}
        />
        {/* Only when editing. A brand new account has no grants yet, so there is
            nothing to derive from and nothing to override. */}
        {account && (
          <Field
            label="Which book"
            info={
              <p>
                Normally worked out from who is on the account. Change it where that is wrong — an account only
                you can see that is really the household&rsquo;s float, say.
              </p>
            }
          >
            <Select value={book} onChange={(e) => setBook(e.target.value as '' | 'household' | 'mine')}>
              <option value="">Work it out from who is on it</option>
              <option value="household">Our household</option>
              <option value="mine">Mine</option>
            </Select>
          </Field>
        )}
        {/* Deliberately next to "Who can see it?" and deliberately not part of
            it. The sharing sheet hands somebody an ACCOUNT; this hands them a
            handful of rows and nothing else, and folding the two together would
            make one look like a quieter version of the other. */}
        {offerPublishing && (
          <CheckRow
            checked={publishes}
            onChange={setPublishes}
            label="Publish household expenses paid from here"
            info={
              <>
                <p>
                  When you mark a payment as the household&rsquo;s, everyone in the household can read that
                  row — payee, amount, category and note. The balance, the name of this account and every row
                  you have not marked stay yours alone.
                </p>
                {publishes && (
                  <p>
                    Turning it off hides them again everywhere, but nobody can un-read what they have already
                    seen.
                  </p>
                )}
              </>
            }
          />
        )}
        {account && (
          <button
            type="button"
            onClick={() => setSharing(true)}
            className="flex w-full items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-left transition-colors hover:bg-surface-2/70"
          >
            <span className="flex-1 text-sm font-medium text-ink-2">Who can see it?</span>
            <span className="text-sm text-ink-3">
              {sharedWith === 1 ? 'Only you' : `${sharedWith} people`}
            </span>
            <ChevronRight size={16} className="text-ink-3" />
          </button>
        )}
        {!account && (
          <p className="text-sm text-ink-3">
            It starts as yours alone. Once it exists you can choose who else sees it, and how much.
          </p>
        )}
      </div>
      {account && (
        <AccountAccessSheet account={account} open={sharing} onClose={() => setSharing(false)} />
      )}
    </Sheet>
  )
}

function CategoryForm({ category, open, onClose }: { category?: Category; open: boolean; onClose: () => void }) {
  const existing = useCategories()
  const { userId } = useSyncState()
  const catMap = useMemo(() => new Map(existing.map((c) => [c.id, c])), [existing])
  const [name, setName] = useState(category?.name ?? '')
  const [icon, setIcon] = useState<string | undefined>(category?.icon)
  const [kind, setKind] = useState<'expense' | 'income'>(category?.kind ?? 'expense')
  const [slot, setSlot] = useState<number | null>(category?.slot ?? null)
  /** A colour of its own, overriding the slot. Inherited from a parent when null. */
  const [color, setColor] = useState<string | undefined>(category?.color)
  const [parentId, setParentId] = useState<string | undefined>(category?.parentId)
  const [personal, setPersonal] = useState(!!category?.ownerId)
  const canSave = name.trim().length > 0

  // Only a top-level category of the same kind can be a parent, and a category
  // that already has children of its own cannot become one. The `category?.id`
  // guard matters: a new category has no id, and every top-level category has
  // `parentId === undefined`, so without it this was true for everyone and the
  // parent picker never appeared on a new category.
  const hasChildren = !!category?.id && existing.some((c) => c.parentId === category.id)
  const parentOptions = topLevel(existing).filter((c) => c.kind === kind && c.id !== category?.id)
  const parent = parentId ? catMap.get(parentId) : undefined

  // A new top-level category defaults to whichever colour is least used, so it
  // is visually distinct from what is already there. A subcategory instead
  // shows its parent's, and stores nothing — which is what keeps the two in
  // step when the parent changes later.
  const autoSlot = nextFreeSlot(existing.map((c) => c.slot).filter((n): n is number => n != null))
  const inherited = parent ? styleOf(parent, catMap) : undefined
  const effectiveSlot = slot ?? inherited?.slot ?? autoSlot
  const effectiveIcon = icon ?? inherited?.icon ?? 'tag'
  const effectiveColor = color ?? (slot == null ? inherited?.color : undefined)
  const overriding = parentId != null && (icon != null || slot != null || color != null)

  async function save() {
    if (!canSave) return
    // Null icon and slot mean "inherit"; only send values when this is a
    // top-level category or the user has deliberately overridden them.
    // Null icon, slot and colour all mean "inherit". A custom colour is stored
    // BESIDE the slot rather than instead of it: `categories_top_level_has_style`
    // demands a slot on every top-level row, and a client that has not learned
    // about `color` yet still has something to paint with.
    const style =
      parentId && !overriding
        ? { icon: undefined, slot: undefined, color: undefined }
        : { icon: effectiveIcon, slot: effectiveSlot, color: effectiveColor }
    if (category?.id) {
      await update('categories', category.id, {
        name: name.trim(),
        parentId,
        ownerId: personal ? userId : undefined,
        ...style,
      })
    } else {
      const count = await db.categories.count()
      await create('categories', {
        name: name.trim(),
        kind,
        sortOrder: count,
        parentId,
        ownerId: personal ? userId : undefined,
        ...style,
      })
    }
    onClose()
  }

  async function deleteCategory() {
    if (!category?.id) return
    const used = await db.transactions.where('categoryId').equals(category.id).count()
    if (used > 0) {
      await alertAction(`“${category.name}” is still in use`, [
        `${used} transaction${used === 1 ? ' is' : 's are'} filed under it, so it cannot be deleted.`,
        'Recategorise them first — Activity can do the lot in one go from the payee filter.',
      ])
      return
    }
    const ok = await confirmAction({
      title: `Delete “${category.name}”?`,
      body: 'Nothing is filed under it, so nothing else changes. Any budget set for it goes too.',
      confirmLabel: 'Delete category',
      tone: 'danger',
    })
    if (!ok) return
    const budgets = await db.budgets.where('categoryId').equals(category.id).toArray()
    for (const b of budgets) await removeRow('budgets', b.id)
    await removeRow('categories', category.id)
    toast(`“${category.name}” deleted`)
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={category ? 'Edit category' : 'New category'}
      onSubmit={() => void save()}
      footer={
        <div className="flex gap-2">
          {category?.id && (
            <Button variant="danger" size="lg" onClick={deleteCategory}>
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
        {/* Live preview — the icon and colour the category will actually wear. */}
        <div className="flex items-center gap-3">
          <CategoryDot category={{ icon: effectiveIcon, slot: effectiveSlot } as Category} size={44} />
          <div className="min-w-0 flex-1">
            <Field label="Name">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pets" autoFocus />
            </Field>
          </div>
        </div>

        {!hasChildren && (
          <Field
            label="Part of"
            hint={parentId ? "It takes its parent's colour and icon, and its spending counts towards their budget." : undefined}
          >
            <Select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || undefined)}>
              <option value="">Nothing — this is a top-level category</option>
              {parentOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {userId && (
          <CheckRow
            checked={personal}
            onChange={setPersonal}
            label="Keep this to myself"
            info={<p>Nobody else sees it, and it can only be used on an account nobody else shares.</p>}
          />
        )}

        <SlotPicker
          value={effectiveSlot}
          onChange={setSlot}
          color={effectiveColor}
          onColorChange={setColor}
          hint={parentId && !overriding ? 'inherited' : undefined}
        />

        <IconPicker
          value={icon}
          onChange={setIcon}
          colour={paintOf(effectiveSlot, effectiveColor)}
          hint={parentId && !overriding ? 'inherited' : undefined}
        />

        {!category && (
          <Segmented
            value={kind}
            onChange={(next) => {
              setKind(next)
              // A parent chosen under the old kind is no longer offered, so
              // drop it rather than saving a cross-kind parent invisibly.
              if (parent && parent.kind !== next) setParentId(undefined)
            }}
            options={[
              { value: 'expense', label: 'Expense' },
              { value: 'income', label: 'Income' },
            ]}
          />
        )}
      </div>
    </Sheet>
  )
}
