import { db, type Account, type AccountVisibility, type Purge, type Transaction } from './db'
import { createRow, updateRow, notDeleted } from './data'

export const VISIBILITY_LABEL: Record<AccountVisibility, string> = {
  shared: 'Shared with household',
  balance: 'Balance only',
  private: 'Private',
}

/** Can this device's user record spending against the account? */
export function canUseAccount(a: Account, myUserId?: string) {
  const vis = a.visibility ?? 'shared'
  return vis === 'shared' || !a.ownerId || a.ownerId === myUserId
}

/** Live balance from local data — correct on the owner's device. */
export function computeBalance(account: Account, txns: Transaction[]) {
  const sum = txns.reduce(
    (s, t) => (t.accountId === account.id && !t.deleted ? s + t.amountMinor : s),
    0,
  )
  return (account.openingBalanceMinor ?? 0) + sum
}

/**
 * Persist balances for accounts this user owns (or unowned household accounts)
 * so partners with balance-only visibility see an up-to-date figure. Called
 * before every sync push; only writes when the number actually changed.
 */
export async function recomputeOwnedBalances(myUserId?: string) {
  const [accounts, txns] = await Promise.all([
    db.accounts.filter(notDeleted).toArray(),
    db.transactions.filter(notDeleted).toArray(),
  ])
  for (const a of accounts) {
    if (a.ownerId && a.ownerId !== myUserId) continue
    const balance = computeBalance(a, txns)
    if (balance !== (a.balanceMinor ?? null)) {
      await updateRow('accounts', a.id!, { balanceMinor: balance })
    }
  }
}

/**
 * Apply a visibility change with its sync side-effects:
 * - more private: emit a purge so partner devices drop the transactions
 * - any change: re-push the account's transactions so the server's `private`
 *   flag matches the new visibility
 */
export async function setAccountVisibility(account: Account, visibility: AccountVisibility, myUserId?: string) {
  const before = account.visibility ?? 'shared'
  if (before === visibility) return
  await updateRow('accounts', account.id!, { visibility, ownerId: account.ownerId ?? myUserId })
  await db.transactions.where('accountId').equals(account.id!).modify((t) => {
    t.dirty = 1
  })
  const rank: Record<AccountVisibility, number> = { shared: 0, balance: 1, private: 2 }
  if (rank[visibility] > rank[before] && myUserId) {
    await createRow<Purge>('purges', { accountId: account.id!, ownerId: myUserId, createdAt: Date.now() })
  }
}
