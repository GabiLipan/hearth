import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import {
  db,
  type Account,
  type AccountGrant,
  type Bill,
  type Budget,
  type Category,
  type Goal,
  type GrantLevel,
  type HouseholdMember,
  type Rule,
  type Transaction,
} from './db'
import { monthKey } from './dates'
import { useSyncState } from '../hooks/useSync'

/**
 * How pages read data.
 *
 * Dexie's `useLiveQuery` stays — it is the right primitive for a reactive
 * mirror. A background pull or a realtime event writes to IndexedDB and every
 * subscribed component re-renders, with no store to keep in step by hand.
 *
 * What changed is that the cache now holds LIVE ROWS ONLY. Deleted rows are
 * gone rather than flagged, so none of these queries filters on a `deleted`
 * bit, and the Dexie indexes are usable again — the old
 * `orderBy('sortOrder').filter(notDeleted)` silently degraded into a full scan
 * of every category on every render.
 *
 * These hooks exist so that invariant lives in one file instead of being
 * repeated at thirty call sites.
 */

export function useCategories(): Category[] {
  return useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), [], []) ?? []
}

export function useAccounts(): Account[] {
  return useLiveQuery(() => db.accounts.orderBy('sortOrder').toArray(), [], []) ?? []
}

/** Everyone in the household, including you. */
export function useMembers(): HouseholdMember[] {
  return useLiveQuery(() => db.household_members.toArray(), [], []) ?? []
}

export function useMemberMap(): Map<string, HouseholdMember> {
  const members = useMembers()
  return useMemo(() => new Map(members.map((m) => [m.userId, m])), [members])
}

/**
 * Am I this household's admin?
 *
 * Membership only — it decides who may invite, remove and promote people. It
 * confers nothing on any account, which is why no permission predicate in
 * accounts.ts takes it as an argument.
 */
export function useIsAdmin(): boolean {
  const { userId } = useSyncState()
  const members = useMembers()
  return !!userId && members.some((m) => m.userId === userId && m.role === 'admin')
}

/**
 * What I may do on each account — the client mirror of `my_account_ids()`.
 *
 * Keyed by account id, and absent means no access, exactly as on the server.
 * Every permission decision in the UI starts here; nothing else should be
 * reading `account_grants` directly.
 */
export function useMyLevels(): Map<string, GrantLevel> {
  const { userId } = useSyncState()
  const accounts = useAccounts()
  const grants = useLiveQuery(
    () =>
      userId
        ? db.account_grants.where('userId').equals(userId).toArray()
        : Promise.resolve([] as AccountGrant[]),
    [userId],
    [] as AccountGrant[],
  )
  return useMemo(() => {
    const levels = new Map((grants ?? []).map((g) => [g.accountId, g.level as GrantLevel]))
    // An account you just created, whose owner grant has not come back yet.
    //
    // The grant is written by an AFTER INSERT trigger on the server, so between
    // queueing the account and the next pull there is a window where you hold
    // the row and no grant — and without this you would briefly be unable to
    // edit or delete an account you had only just made. This mirrors the second
    // disjunct of `accounts_select`, which admits exactly the same case: a row
    // you created that nobody holds a grant on.
    //
    // It cannot mask a real revocation. Losing a grant bumps the visibility
    // epoch, which drops this cache entirely, so an account still sitting here
    // with no grant is one whose grant has yet to arrive.
    for (const a of accounts) {
      if (!levels.has(a.id) && !!userId && a.createdBy === userId) levels.set(a.id, 'owner')
    }
    return levels
  }, [grants, accounts, userId])
}

/** Everyone's access to one account. Only populated for accounts you manage. */
export function useGrantsFor(accountId?: string): AccountGrant[] {
  return (
    useLiveQuery(
      () =>
        accountId
          ? db.account_grants.where('accountId').equals(accountId).toArray()
          : Promise.resolve([] as AccountGrant[]),
      [accountId],
      [] as AccountGrant[],
    ) ?? []
  )
}

/** Every budget, all months. Used for history and the sparklines. */
export function useBudgets(): Budget[] {
  return useLiveQuery(() => db.budgets.toArray(), [], []) ?? []
}

/** The budgets that apply to one month. `month` is a yyyy-MM key. */
export function useBudgetsForMonth(month: string): Budget[] {
  return useLiveQuery(() => db.budgets.where('month').equals(`${month}-01`).toArray(), [month], []) ?? []
}

export function useGoals(): Goal[] {
  return useLiveQuery(() => db.goals.orderBy('sortOrder').toArray(), [], []) ?? []
}

export function useBills(): Bill[] {
  return useLiveQuery(() => db.bills.toArray(), [], []) ?? []
}

export function useRules(): Rule[] {
  return useLiveQuery(async () => (await db.rules.toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [], []) ?? []
}

/**
 * Every transaction. Several screens genuinely need the lot (trends, reports,
 * the fuzzy payee matcher), and for a couple's history that is a few thousand
 * rows — small enough that paging it would cost more in complexity than it
 * saves.
 */
export function useAllTransactions(): Transaction[] | undefined {
  return useLiveQuery(() => db.transactions.toArray(), [])
}

export function useTransactionsInMonth(month: string): Transaction[] {
  return useLiveQuery(() => db.transactions.filter((t) => monthKey(t.date) === month).toArray(), [month], []) ?? []
}

export function useRecentTransactions(limit: number): Transaction[] {
  return useLiveQuery(() => db.transactions.orderBy('date').reverse().limit(limit).toArray(), [limit], []) ?? []
}

/** A lookup by id. Callers must tolerate a miss: see `useCategoryMap`. */
export function useCategoryMap(): Map<string, Category> {
  const categories = useCategories()
  return useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
}

export function useAccountMap(): Map<string, Account> {
  const accounts = useAccounts()
  return useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
}

/**
 * Balances the server computed for us — only populated for accounts whose
 * transactions this device is not allowed to read. See `balanceOf` in
 * accounts.ts, which prefers a locally computed figure whenever it can, so
 * optimistic edits move the number straight away.
 */
export function useRemoteBalances(): Map<string, number> {
  const rows = useLiveQuery(() => db.balances.toArray(), [], []) ?? []
  return useMemo(() => new Map(rows.map((b) => [b.accountId, b.balanceMinor])), [rows])
}

/** Writes the server refused. Surfaced in Settings so a failure is never silent. */
export function useDeadLetters() {
  return useLiveQuery(() => db.deadLetters.orderBy('failedAt').reverse().toArray(), [], []) ?? []
}

/**
 * A category that no longer exists — deleted by the other person, or simply not
 * pulled yet, since the cache deliberately does not enforce foreign keys.
 * Rendering this instead of crashing on a missing lookup is the whole point.
 */
export const UNCATEGORISED: Pick<Category, 'name' | 'icon' | 'slot'> = {
  name: 'Uncategorised',
  icon: 'tag',
  slot: 1,
}
