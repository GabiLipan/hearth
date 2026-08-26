import { format } from 'date-fns'
import { create, remove, update } from './data'
import { rpc } from './api'
import { fullPull } from './pull'
import { db, newId, type Account, type AccessLevel, type AccountGrant, type GrantLevel, type Transaction } from './db'

/**
 * The client's mirror of the server's permission model (supabase/07-permissions.sql).
 *
 * Every predicate here answers from ONE input: my level on the account. That is
 * deliberate — the server's `my_account_ids(min_level)` reads a grant and
 * nothing else, so anything the client consults beyond the level would be a
 * second, drifting definition of access. Being a household admin confers
 * nothing here, because it confers nothing there.
 *
 * These are advisory. They decide what the UI offers; RLS decides what actually
 * happens. Where the two disagree the server wins, and the write comes back as
 * a dead letter.
 */

/** Rank order must match the declaration order of `public.access_level`. */
const RANK: Record<GrantLevel, number> = {
  none: 0,
  balance: 1,
  view: 2,
  contribute: 3,
  manage: 4,
  owner: 5,
}

export const LEVEL_LABEL: Record<GrantLevel, string> = {
  owner: 'Owner',
  manage: 'Manage',
  contribute: 'Add entries',
  view: 'View only',
  balance: 'Balance only',
  none: 'No access',
}

export const LEVEL_HINT: Record<GrantLevel, string> = {
  owner: 'Full control, including who else can see it.',
  manage: 'Can add, change and remove anything on this account, but not change who can see it.',
  contribute: 'Can add transactions, and change or remove the ones they added.',
  view: 'Can see everything on this account, but change nothing.',
  balance: 'Sees what the account holds, but not what it was spent on.',
  none: 'Cannot see this account at all.',
}

/** Highest first, which is the order the level picker offers them in. */
export const LEVELS: GrantLevel[] = ['owner', 'manage', 'contribute', 'view', 'balance', 'none']

export const atLeast = (level: GrantLevel, min: GrantLevel) => RANK[level] >= RANK[min]

/** My level on an account. No grant means no access, which is the whole model. */
export const levelOn = (accountId: string, levels: Map<string, GrantLevel>): GrantLevel =>
  levels.get(accountId) ?? 'none'

/* Each of these names the policy it mirrors. */
export const canSeeAccount = (l: GrantLevel) => atLeast(l, 'balance') // accounts_select
export const canSeeTransactionsAt = (l: GrantLevel) => atLeast(l, 'view') // transactions_select
export const canAddTransactions = (l: GrantLevel) => atLeast(l, 'contribute') // transactions_insert
export const canManageAccount = (l: GrantLevel) => atLeast(l, 'manage') // accounts_update
export const canAdministerAccount = (l: GrantLevel) => atLeast(l, 'owner') // account_grants, delete_account

/**
 * `transactions_update`, exactly — including the `created_by` half.
 *
 * At `contribute` you may change what you added and nothing else. The server
 * pins `created_by` on update, so this is not a courtesy check: it is the same
 * condition, asked early enough to grey out a button.
 */
export function canEditTransaction(
  t: Pick<Transaction, 'createdBy'>,
  level: GrantLevel,
  myUserId?: string,
): boolean {
  if (atLeast(level, 'manage')) return true
  return atLeast(level, 'contribute') && !!myUserId && t.createdBy === myUserId
}

/** The same rule for a bill, which follows its account's ladder. */
export const canEditBill = canEditTransaction

/* ---------- what an account looks like ---------- */

/**
 * The face an account wears when nobody has chosen one.
 *
 * Derived from `kind` rather than left blank, so the Activity table is readable
 * the moment migration 17 lands — a household with eight accounts should not
 * have to visit eight forms before the account column stops being grey text.
 *
 * The colours are picked to sit apart from each other rather than to mean
 * anything: there is no convention that savings is green, and inventing one
 * would only be wrong for the person whose savings account is their overdraft.
 */
const KIND_FACE: Record<Account['kind'], { slot: number; icon: string }> = {
  current: { slot: 1, icon: 'bank' },
  savings: { slot: 9, icon: 'piggy' },
  credit: { slot: 8, icon: 'card' },
  cash: { slot: 3, icon: 'banknote' },
}

/**
 * An account's colour slot and icon key, chosen or derived.
 *
 * Every screen goes through this rather than reading `account.slot` — a raw
 * read gives `undefined` on the common case and paints the row grey, which is
 * the state this feature exists to remove.
 */
export function accountFace(account: Pick<Account, 'kind' | 'slot' | 'icon' | 'color' | 'ink'>): {
  slot: number
  icon: string
  /** A colour of its own, overriding the slot. Never derived from `kind`. */
  color?: string
  /**
   * The mark on the tile, where somebody has overridden the measured one.
   * Never derived from `kind` either: the derived faces are palette slots, and
   * the palette is the one thing whose ink can always be measured.
   */
  ink?: string
} {
  const base = KIND_FACE[account.kind] ?? KIND_FACE.current
  return {
    slot: account.slot ?? base.slot,
    icon: account.icon ?? base.icon,
    color: account.color,
    ink: account.ink,
  }
}

/* ---------- balances ---------- */

/** Balance from the transactions we hold locally. */
export function computeBalance(account: Account, txns: Transaction[]) {
  const sum = txns.reduce((s, t) => (t.accountId === account.id ? s + t.amountMinor : s), 0)
  return account.openingBalanceMinor + sum
}

/**
 * An account's balance.
 *
 * Computed locally whenever this device can see the underlying transactions, so
 * that adding one moves the number immediately rather than after a round trip.
 * At `balance` level we cannot see the line items at all, so the figure comes
 * from the server's `account_balances()` function, which sums the rows RLS
 * hides from us.
 *
 * There is deliberately no stored `balanceMinor` column any more. The old one
 * was recomputed and re-uploaded by both devices on every sync, so an account
 * neither person owned had its balance overwritten back and forth forever.
 */
export function balanceOf(
  account: Account,
  txns: Transaction[],
  remoteBalances: Map<string, number>,
  level: GrantLevel,
): number {
  if (canSeeTransactionsAt(level)) return computeBalance(account, txns)
  return remoteBalances.get(account.id) ?? account.openingBalanceMinor
}

/**
 * The order a ledger is listed in: newest first.
 *
 * One function because two things have to agree about it EXACTLY, and when
 * they did not the Balance column was nonsense: Activity sorted by date and
 * `createdAt` descending and left ties in whatever order Dexie returned them,
 * while `runningBalances` sorted ascending and broke ties on the id. Those are
 * only reverses of each other while no two rows tie — and an import ties every
 * row it writes, because the rows go in inside one transaction and `now()` is
 * the TRANSACTION's clock, so a statement of forty rows carries one identical
 * stamp. Dexie then hands them back in primary-key order, which is id
 * ascending, so the page listed a day's rows in the same order the balance
 * counted them: the column stepped DOWN the page instead of up, and a day's
 * first purchase read as though it had happened last. £3,597.93 less £8.70 on
 * the row at the TOP of the second of January.
 *
 * So: one comparator, and the balance is it walked backwards. The tie-break on
 * the id is arbitrary — nothing in a statement says which of two rows stamped
 * the same second came first — but it is STABLE and it is shared, which is all
 * the column needs to be true.
 *
 * `createdAt` is missing on a row this device has only just written — the
 * server stamps it and the next pull brings it back — so a missing one stands
 * in as the furthest-off stamp there is, which puts a row created a moment ago
 * at the top of its day rather than the bottom. Empty string would do the
 * opposite, silently.
 *
 * ## Where the statement's own order comes in
 *
 * `statementOrder` (migration 27) sits ABOVE both, under the date, because it
 * is the only key here that is EVIDENCE rather than a tie-break: it is the
 * bank's own answer to which of two rows dated the second of January came
 * first, and a stamp written by whichever device happened to run the import is
 * not an answer to that at all. Every row of a statement carries the same
 * `created_at` anyway — one insert, one transaction clock — so without this the
 * whole day fell through to the id, which is a random uuid.
 *
 * It is only compared where BOTH rows have one. A number means "later in its
 * own file", so it says nothing about a row typed by hand, nothing about a row
 * imported before 27, and strictly speaking nothing about a row from a
 * different file — two imports each having a fifth line is not a contradiction.
 * Two files rarely overlap inside one day (the duplicate check is what stops
 * them), and where they do the answer is arbitrary either way; what matters is
 * that it stays STABLE, which it does.
 */
const NEWEST = '9999-12-31T23:59:59Z'

export function byLedger(a: Transaction, b: Transaction): number {
  if (a.date !== b.date) return b.date.localeCompare(a.date)
  if (a.statementOrder !== undefined && b.statementOrder !== undefined && a.statementOrder !== b.statementOrder) {
    return b.statementOrder - a.statementOrder
  }
  return (
    (b.createdAt ?? NEWEST).localeCompare(a.createdAt ?? NEWEST) ||
    b.id.localeCompare(a.id)
  )
}

/**
 * What each account held immediately after each of its transactions.
 *
 * The statement column: a row's amount says what moved, and this says where
 * that left the account — which is the one figure a bank statement has that
 * this app did not, and the only way to reconcile a list against one.
 *
 * Three things it is careful about.
 *
 * It counts FORWARDS from the opening balance rather than backwards from
 * today's figure, unlike `balanceHistory` — which walks back precisely so the
 * line ends on the number printed beside it. Here every row needs a figure, so
 * the walk has to visit them all anyway, and starting from the opening balance
 * means the arithmetic is the account's own from end to end. The last row still
 * lands exactly on `computeBalance`, which is what the two have to agree about.
 *
 * It is computed over EVERY transaction the device holds, never the filtered
 * list on screen. A running balance of a search for "tesco" is a column of
 * numbers that look like balances and are not — the sum of one shop's spending
 * and nothing else. Filtering the page must not change what these say.
 *
 * And it is silent about an account this device does not hold. A published
 * household row is readable without its account being — no balance, no other
 * rows on it, nothing to add up — so it is absent from the map rather than
 * given a figure derived from the one row we happen to have. The caller draws
 * nothing there.
 *
 * The order is `byLedger`, walked backwards, and it MUST be exactly that — see
 * the note there. Anything else and the column stops being a running balance.
 */
export function runningBalances(accounts: Account[], txns: Transaction[]): Map<string, number> {
  const running = new Map(accounts.map((a) => [a.id, a.openingBalanceMinor]))
  const ordered = txns.filter((t) => running.has(t.accountId)).sort((a, b) => -byLedger(a, b))
  const out = new Map<string, number>()
  for (const t of ordered) {
    const next = (running.get(t.accountId) ?? 0) + t.amountMinor
    running.set(t.accountId, next)
    out.set(t.id, next)
  }
  return out
}

/**
 * The last `days` days of an account's balance, one point per day, ending at
 * today's figure.
 *
 * Worked BACKWARDS from the balance we already have rather than forwards from
 * the opening balance, for two reasons: `balanceOf` is the number on screen
 * beside the line, so the line has to end exactly on it or the two disagree by
 * whatever the cache is missing; and at `balance` level there are no rows to
 * add up at all — the caller checks `canSeeTransactionsAt` and simply doesn't
 * ask for a line it cannot draw.
 *
 * Returns `days + 1` points, oldest first. A day with no transactions repeats
 * the previous figure, so the line is flat there rather than absent — a gap in
 * a sparkline reads as missing data rather than as a quiet week.
 */
export function balanceHistory(
  accountId: string,
  txns: Transaction[],
  endBalanceMinor: number,
  days = 30,
): number[] {
  const byDay = new Map<string, number>()
  for (const t of txns) {
    if (t.accountId !== accountId) continue
    byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.amountMinor)
  }
  const out: number[] = new Array(days + 1)
  let running = endBalanceMinor
  const day = new Date()
  for (let i = days; i >= 0; i--) {
    out[i] = running
    // Step off the day just recorded: the point at i-1 is the balance BEFORE
    // this day's movements, which is where the previous day ended.
    //
    // `format`, not `toISOString().slice(0, 10)` — the latter is UTC, so west
    // of Greenwich every evening's transactions would be looked up against
    // tomorrow's key and the line would lag the figure it ends on by a day.
    running -= byDay.get(format(day, 'yyyy-MM-dd')) ?? 0
    day.setDate(day.getDate() - 1)
  }
  return out
}

/**
 * Give somebody a level on an account, or take it away.
 *
 * Queued through the outbox rather than called directly: a grant is idempotent
 * and additive, so replaying one after a lost response is harmless, and the row
 * appearing immediately is worth having. The server refuses if the caller is
 * not an owner, and that arrives as a dead letter.
 *
 * `none` removes it. The existing grant row is reused when there is one, so the
 * server's `(account_id, user_id)` unique index is never fought with.
 */
export async function setAccountLevel(
  accountId: string,
  userId: string,
  level: GrantLevel,
  existing?: AccountGrant,
) {
  if (level === 'none') {
    if (existing) await remove('account_grants', existing.id)
    return
  }
  if (existing) {
    await update('account_grants', existing.id, { level })
    return
  }
  await create('account_grants', { id: newId(), accountId, userId, level: level as AccessLevel })
}

/** How many transactions this device knows about on an account — what the confirmation says. */
export const transactionsOn = (accountId: string) =>
  db.transactions.where('accountId').equals(accountId).count()

/**
 * Delete one account, and everything recorded on it.
 *
 * Server-side rather than through the outbox, for two reasons.
 *
 * An account and its transactions have to go in one operation. Tombstoning the
 * account alone is the worst of both: `account_balances()` stops returning it,
 * but every total on the client sums transactions with no reference to an
 * account, so the money would keep counting against budgets and reports from an
 * account that is no longer on screen to explain it.
 *
 * And the server is the only place that can refuse. `delete_account()` re-checks
 * that the caller owns it — the sheet offering the button is not what protects
 * anything, since anyone can call the API directly.
 *
 * The cost is that it needs a connection. That is the right trade for a rare,
 * deliberate, irreversible action; the alternative is queueing a destructive
 * write whose permission check happens minutes later with nobody watching.
 *
 * @returns how many transactions went with it.
 */
export async function deleteAccount(accountId: string, withTransactions: boolean): Promise<number> {
  const removed = await rpc<number>('delete_account', {
    p_account_id: accountId,
    p_with_transactions: withTransactions,
  })
  // Several tables moved at once. Re-reading is simpler than replaying it locally.
  await fullPull()
  return removed
}

/* ---------- getting one back ---------- */

export interface DeletedAccount {
  id: string
  name: string
  kind: string
  deletedAt: string
  transactionCount: number
}

export interface UnownedAccount {
  id: string
  name: string
  kind: string
  createdAt: string
}

/**
 * The bin, and the orphans. Both are RPCs rather than reads of the cache,
 * because neither row is something `accounts_select` will hand over: a deleted
 * account is filtered out of the ordinary read path on purpose (the cache holds
 * live rows only), and an ownerless one is invisible to everybody precisely
 * because it has no grant left to authorise it.
 *
 * Online-only in consequence, which is right — restoring an account is not
 * something to queue and hope about.
 */
export async function deletedAccounts(): Promise<DeletedAccount[]> {
  const rows = await rpc<
    { id: string; name: string; kind: string; deleted_at: string; transaction_count: number }[]
  >('deleted_accounts', {})
  return (rows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    deletedAt: r.deleted_at,
    transactionCount: Number(r.transaction_count),
  }))
}

export async function unownedAccounts(): Promise<UnownedAccount[]> {
  const rows = await rpc<{ id: string; name: string; kind: string; created_at: string }[]>(
    'unowned_accounts',
    {},
  )
  return (rows ?? []).map((r) => ({ id: r.id, name: r.name, kind: r.kind, createdAt: r.created_at }))
}

/** Undo a delete. Returns how many transactions came back with the account. */
export const restoreAccount = (accountId: string) =>
  rpc<number>('restore_account', { p_account_id: accountId })

/**
 * Destroy a deleted account and everything on it. Returns how many transactions
 * went with it.
 *
 * The one call in the app that removes rows rather than tombstoning them, and
 * the only one that cannot be undone — the bin is the whole safety net, so the
 * server refuses this on an account that is not already in it. Owner only, like
 * restoring.
 */
export const purgeAccount = (accountId: string) =>
  rpc<number>('purge_account', { p_account_id: accountId })

/** A household admin takes ownership of an account nobody owns. */
export const claimAccount = (accountId: string) =>
  rpc<string>('claim_account', { p_account_id: accountId })
