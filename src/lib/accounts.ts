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

/** A household admin takes ownership of an account nobody owns. */
export const claimAccount = (accountId: string) =>
  rpc<string>('claim_account', { p_account_id: accountId })
