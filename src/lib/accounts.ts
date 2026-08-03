import { update } from './data'
import { rpc } from './api'
import { fullPull } from './pull'
import { db, type Account, type AccountVisibility, type Transaction } from './db'

export const VISIBILITY_LABEL: Record<AccountVisibility, string> = {
  shared: 'Shared with household',
  balance: 'Balance only',
  private: 'Private',
}

export const VISIBILITY_HINT: Record<AccountVisibility, string> = {
  shared: 'Both of you see this account and everything on it.',
  balance: 'They see the account and what it holds, but not what you spent it on.',
  private: 'They cannot see this account at all.',
}

/** Can this user record spending against the account? */
export function canUseAccount(a: Account, myUserId?: string) {
  return a.visibility === 'shared' || !a.ownerId || a.ownerId === myUserId
}

/** Can this user read the account's individual transactions? Mirrors the server's RLS. */
export function canSeeTransactions(a: Account, myUserId?: string) {
  return a.visibility === 'shared' || (!!myUserId && a.ownerId === myUserId)
}

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
 * For a partner's balance-only account we cannot see the line items at all, so
 * the figure comes from the server's `account_balances()` function, which sums
 * the rows RLS hides from us.
 *
 * There is deliberately no stored `balanceMinor` column any more. The old one
 * was recomputed and re-uploaded by both devices on every sync, so an account
 * neither person owned had its balance overwritten back and forth forever.
 */
export function balanceOf(
  account: Account,
  txns: Transaction[],
  remoteBalances: Map<string, number>,
  myUserId?: string,
): number {
  if (canSeeTransactions(account, myUserId)) return computeBalance(account, txns)
  return remoteBalances.get(account.id) ?? account.openingBalanceMinor
}

/**
 * Change an account's privacy.
 *
 * A plain field update now: the server bumps the household's visibility epoch,
 * and the partner's device responds by dropping its cache and re-pulling. The
 * old client had to emit a "purge" record by hand for the partner to act on,
 * which only covered the case it remembered to emit — not a transaction being
 * moved onto a private account, nor an ownership change, nor someone leaving.
 */
export async function setAccountVisibility(account: Account, visibility: AccountVisibility, myUserId?: string) {
  if (account.visibility === visibility) return
  await update('accounts', account.id, {
    visibility,
    // A non-shared account needs an owner: it is who it is private *to*.
    ownerId: account.ownerId ?? myUserId,
  })
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
 * that the account is shared or the caller's own — the sheet offering the button
 * is not what protects anything, since anyone can call the API directly.
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
  // The wipe touched several tables at once, and re-seeded a starter account if
  // that was the last one. Re-reading is simpler than replaying it locally.
  await fullPull()
  return removed
}
