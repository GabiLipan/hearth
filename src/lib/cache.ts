import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { classifyAccounts, classifyFlows, type BookId, type BookMap, type Flow, type MonthRule } from './books'
import { MONTH_RULE_KEY, parseMonthRule } from './monthRule'
import { byOrder } from './accountOrder'
import {
  db,
  getSetting,
  setSetting,
  type Account,
  type AccountGrant,
  type Bill,
  type Budget,
  type Category,
  type Goal,
  type GoalEntry,
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

/**
 * Whether the cache has actually been read yet.
 *
 * Every hook below hands back `[]` while IndexedDB is still opening, which is
 * the right default for anything that COUNTS rows and the wrong one for
 * anything that draws a conclusion from their absence: for the first frames of
 * a cold start, Budgets said "No expense categories yet", Goals said "No goals
 * yet" and Rules said "Nothing learned yet" — to people with a full history.
 * The screens then flicked to the real content, which reads as a glitch at
 * best and, on Budgets, as data loss.
 *
 * `useAllTransactions` already had the answer for its own table — it returns
 * `undefined` until Dexie replies, and Activity and Reports both gate on it
 * with a comment saying why. This is that convention made available to the
 * other tables without changing thirty call sites to handle `undefined`: an
 * empty state asks this first, and everything that merely counts or lists
 * carries on treating "nothing yet" as nothing.
 *
 * One probe is enough. What is being waited for is the database opening, not
 * any particular table, and when it opens every query resolves together.
 *
 * Deliberately NOT "the first pull has landed". A device that has been offline
 * since yesterday has a perfectly good cache and must not be made to wait for
 * a sync that may never come; and a genuinely new household really does have
 * no categories, so its empty state is true as soon as it can be drawn.
 */
export function useCacheReady(): boolean {
  return useLiveQuery(async () => {
    await db.categories.limit(1).toArray()
    return true
  }, []) ?? false
}

/**
 * A device-local preference, kept in step across the app.
 *
 * `db.meta` never syncs — a preference is a property of this screen, like the
 * theme and the dashboard layout — and reading it through `useLiveQuery` is
 * what makes a switch in Settings reach a widget on another page without
 * either of them knowing about the other.
 *
 * Off is the default, and it is the same answer as "not read yet": a missing
 * row and a database that has not opened both come back `false`, so nothing
 * has to handle a third state. That means a preference somebody has turned ON
 * appears a frame after the page paints, which is the right way round — a
 * default that flashed on and then vanished would be worse.
 */
export function useFlag(key: string): boolean {
  return useLiveQuery(async () => (await db.meta.get(key))?.value === 'on', [key]) ?? false
}

export function setFlag(key: string, on: boolean): Promise<void> {
  return setSetting(key, on ? 'on' : 'off')
}

/**
 * Whether to show what the household owes you for things you bought it out of
 * your own pocket.
 *
 * Off by default. `paid_for_household` puts the spending in the right books all
 * by itself, and for a couple who simply share everything that is the end of
 * it — the debt is real but it is not something they want counted at them on
 * the home page. Turning it on is opting into a second, sharper reading of the
 * same rows. See `lib/reimbursements.ts`, which is untouched by the switch.
 */
export const OWED_FLAG = 'showOwed'

export function useCategories(): Category[] {
  return useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), [], []) ?? []
}

/**
 * Every account, in the order the app shows them.
 *
 * `sortOrder` is what a drag on the Settings list writes, and the name is the
 * tie-break — which until that first drag is the whole of it, since every
 * account is created at 0. Sorted in memory after the indexed read rather than
 * by the index alone: Dexie breaks a tie on primary key, and the primary key is
 * a client-generated uuid, so the list was in an arbitrary order that changed
 * if an account was deleted and made again. See `lib/accountOrder.ts`.
 */
export function useAccounts(): Account[] {
  return useLiveQuery(async () => (await db.accounts.orderBy('sortOrder').toArray()).sort(byOrder), [], []) ?? []
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

/**
 * Every grant this device holds, grouped by account.
 *
 * The bulk form of `useGrantsFor`, because a list cannot call a hook once per
 * row. It carries the same caveat, and it matters more here: `account_grants_select`
 * shows you other people's grants only on accounts you MANAGE, so below that
 * level the array you get back is your own grant and nothing else — it is not a
 * short sharing list, it is an unanswerable question. Callers must gate on
 * `canManageAccount` before reading it as "who can see this".
 */
export function useGrantsByAccount(): Map<string, AccountGrant[]> {
  const grants = useLiveQuery(() => db.account_grants.toArray(), [], [] as AccountGrant[])
  return useMemo(() => {
    const byAccount = new Map<string, AccountGrant[]>()
    for (const g of grants ?? []) {
      const list = byAccount.get(g.accountId)
      if (list) list.push(g)
      else byAccount.set(g.accountId, [g])
    }
    return byAccount
  }, [grants])
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

/**
 * Every goal's ledger. Small enough to hold whole — a household accumulates a
 * few rows a month, not a few a day — and every screen that shows a pot needs
 * all of them anyway, since the pot IS the sum.
 */
export function useGoalEntries(): GoalEntry[] {
  return useLiveQuery(() => db.goal_entries.toArray(), [], []) ?? []
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

/* ---------- books ---------- */

/**
 * Which book each account belongs to, derived from the grants already there.
 *
 * Nothing to configure and nothing that can disagree with the permissions —
 * see `classifyAccounts`. Note it reads `useGrantsByAccount`, which below
 * `manage` returns only your own grant; that is exactly why "mine" requires
 * ownership rather than "only one grant".
 */
export function useBooks(): BookMap {
  const { userId } = useSyncState()
  const accounts = useAccounts()
  const grants = useGrantsByAccount()
  return useMemo(() => classifyAccounts(accounts, grants, userId), [accounts, grants, userId])
}

/** What each transaction means, given the books. Recomputed when either changes. */
export function useFlows(txns: Transaction[] | undefined, books: BookMap): Map<string, Flow> {
  return useMemo(() => classifyFlows(txns ?? [], books), [txns, books])
}

/**
 * When this household's months start, for anything that adds one up.
 *
 * A `useLiveQuery` over the cached copy rather than a module-level store,
 * because unlike `useBook` this is not a lens: it belongs to the household, it
 * arrives from the server on every pull, and the pull is what has to be able to
 * change it under a screen that is already on. Dexie's liveness gives that for
 * free — the other person moves payday on their phone and this one re-counts
 * within the minute.
 *
 * It is never undefined. A screen that had to wait for the rule before it could
 * add anything up would flash empty on every load, and the default is the
 * behaviour the app had before the setting existed.
 */
export function useMonthRule(): MonthRule {
  const raw = useLiveQuery(async () => (await db.meta.get(MONTH_RULE_KEY))?.value ?? '', [], undefined)
  return useMemo(() => parseMonthRule(raw), [raw])
}

const BOOK_KEY = 'book'

/**
 * The book being looked at.
 *
 * Device-local and unsynced, like the theme and the sidebar: it is which lens
 * this screen is using, not a fact about the household. Read synchronously
 * enough that the page does not paint the household's figures and then flip to
 * yours, which would be alarming on a page full of money.
 */
/**
 * One value for the whole app, not one per component.
 *
 * This used to be `useState` inside the hook, which was fine while the switcher
 * and the page that read it were the same screen. They are not any more: on a
 * phone the lens lives in the header and the figures live in the page below it,
 * so two `useState`s would have meant changing the lens and watching nothing
 * happen. A module-level value with subscribers keeps every reader on the same
 * answer, and `useSyncExternalStore` is the supported way to read one.
 *
 * The stored value still arrives asynchronously, and an explicit choice still
 * wins over the one being loaded — but both facts are now single, rather than
 * one copy per mounted component.
 */
let bookValue: BookId = 'household'
let bookChosen = false
let bookLoading = false
const bookSubs = new Set<() => void>()

const emitBook = () => bookSubs.forEach((fn) => fn())

function loadBookOnce() {
  if (bookLoading) return
  bookLoading = true
  void getSetting(BOOK_KEY).then((raw) => {
    if (bookChosen) return
    if (raw === 'household' || raw === 'mine' || raw === 'all') {
      bookValue = raw
      emitBook()
    }
  })
}

export function useBook(): [BookId, (next: BookId) => void] {
  const book = useSyncExternalStore(
    useCallback((fn: () => void) => {
      bookSubs.add(fn)
      return () => {
        bookSubs.delete(fn)
      }
    }, []),
    () => bookValue,
  )
  useEffect(loadBookOnce, [])

  const choose = useCallback((next: BookId) => {
    bookChosen = true
    bookValue = next
    void setSetting(BOOK_KEY, next)
    emitBook()
  }, [])

  return [book, choose]
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
