import { newId, type Account, type Goal, type GoalEntry } from './db'
import { rpc } from './api'
import { differenceInCalendarDays, parseISO } from 'date-fns'

/**
 * Saving pots.
 *
 * A goal is not a budget. A budget is a ceiling that resets every month; a goal
 * accumulates towards a target and does not care about month boundaries.
 *
 * **A goal is a CLAIM on money that is already somewhere**, not a container the
 * money is inside. That is the whole model, and it replaces the old one: a pot
 * used to be filled by tagging the incoming leg of a transfer, so the only
 * money that could ever be in it was money Hearth itself had moved. The £3,000
 * already sitting in the savings account — an opening balance, an interest
 * credit, a salary that landed straight there — could not be pointed at a goal
 * at all, and the only workaround was to move it out and back in again.
 *
 * So the pot is the sum of a ledger (`GoalEntry`), each row a deliberate act:
 * put this much towards it, take that much back off. Moving money to savings is
 * an ordinary transfer between two accounts, which the app has always recorded
 * and which `savedInto` reports as saving; saying which part of the savings
 * account is the deposit is a separate question and this is where it is
 * answered.
 *
 * Two rules follow, and both live on the server as well because the client
 * cannot see far enough to enforce either — the other goals on an account may
 * be the other person's. See `supabase/24-goal-allocations.sql`.
 */

export interface GoalProgress {
  savedMinor: number
  remainingMinor: number
  fraction: number
  /** Days until the target date; negative once it has passed. Undefined if open-ended. */
  daysLeft?: number
  /** What you would need to put aside each month from now to arrive on time. */
  neededPerMonthMinor?: number
  /** True when the pace so far will not get there by the target date. */
  behind: boolean
  /**
   * How far through the saving *period* today is, 0–1 — the fraction of the
   * target the bar would be at if the money had arrived evenly.
   *
   * The period runs from the first money put into the pot to the target date.
   * The goal row has no start of its own — there is no `createdAt` on it — and
   * inventing one from today would make the mark meaningless, whereas the first
   * contribution is a real, recorded event and is what somebody would name if
   * asked when they started saving.
   *
   * Undefined until there is both a deadline and something in the pot, and once
   * the deadline has passed: past it the mark would sit off the end of the bar,
   * and the sentence beside it already says the date has gone.
   */
  elapsed?: number
}

export function goalProgress(goal: Goal, entries: GoalEntry[]): GoalProgress {
  let savedMinor = 0
  /** The first day something was put towards it, for the pace mark. */
  let firstFunded: string | undefined
  for (const e of entries) {
    if (e.goalId !== goal.id) continue
    savedMinor += e.amountMinor
    // Only a row that ADDED to the pot starts the clock. A release is not the
    // day somebody began saving, and on a pot whose first event was money
    // leaving the account it would put the start after the mark it is for.
    if (e.amountMinor > 0 && (!firstFunded || e.date < firstFunded)) firstFunded = e.date
  }
  const remainingMinor = Math.max(0, goal.targetMinor - savedMinor)
  const fraction = goal.targetMinor > 0 ? savedMinor / goal.targetMinor : 0

  if (!goal.targetDate) {
    return { savedMinor, remainingMinor, fraction, behind: false }
  }

  const daysLeft = differenceInCalendarDays(parseISO(goal.targetDate), new Date())
  const totalDays = firstFunded
    ? differenceInCalendarDays(parseISO(goal.targetDate), parseISO(firstFunded))
    : 0
  const elapsed =
    firstFunded && totalDays > 0 && daysLeft > 0 ? (totalDays - daysLeft) / totalDays : undefined
  // Round up: a month and a half left means you need the whole of the next
  // payment, not two thirds of it.
  const monthsLeft = Math.max(1, Math.ceil(daysLeft / 30))
  const neededPerMonthMinor = remainingMinor > 0 ? Math.ceil(remainingMinor / monthsLeft) : 0

  return {
    savedMinor,
    remainingMinor,
    fraction,
    daysLeft,
    neededPerMonthMinor,
    // Only meaningful once there is a deadline and something still to save.
    behind: remainingMinor > 0 && daysLeft < 0,
    elapsed,
  }
}

/**
 * Move money between accounts.
 *
 * Server-side and online-only, deliberately. The two legs have to appear
 * together or not at all — one leg landing while the other was rejected would
 * look exactly like money vanishing, which is the failure this whole data layer
 * exists to prevent. Both ids are generated here so a retry after a dropped
 * response is a no-op rather than a second transfer.
 */
export async function transfer(input: {
  fromAccountId: string
  toAccountId: string
  amountMinor: number
  date: string
  note?: string
  goalId?: string
}): Promise<string> {
  return rpc<string>('create_transfer', {
    p_out_id: newId(),
    p_in_id: newId(),
    p_from_account: input.fromAccountId,
    p_to_account: input.toAccountId,
    p_amount_minor: input.amountMinor,
    p_on_date: input.date,
    p_note: input.note ?? null,
    p_goal_id: input.goalId ?? null,
  })
}

/* ---------- what an account's goals have claimed ---------- */

export interface Allocation {
  goal: Goal
  /** What the ledger says is in the pot. Never negative in practice. */
  heldMinor: number
  /** How many entries are behind it, so the history can say. */
  entryCount: number
}

export interface AccountAllocation {
  accountId: string
  /** What the account actually holds. */
  balanceMinor: number
  /** The goals sitting on it, largest first. */
  goals: Allocation[]
  /** Claimed by those goals. */
  assignedMinor: number
  /**
   * What is left to claim. NEGATIVE where money has left the account since the
   * claims were made, which is the state `settle_goals` exists to clear — and
   * it is shown rather than clamped, because a figure that can only be one sign
   * hides the case where it is wrong.
   */
  unassignedMinor: number
}

/**
 * Every goal on one account, and what is left over.
 *
 * The screen's half of the cap: the server refuses an over-assignment, and this
 * is what stops the form offering one in the first place. It cannot be the only
 * check — the other person's personal goal on a shared account is invisible
 * here, so `unassignedMinor` can read higher than the server will allow, and a
 * refusal has to be reported rather than treated as impossible.
 */
export function accountAllocation(
  accountId: string,
  goals: Goal[],
  entries: GoalEntry[],
  balanceMinor: number,
): AccountAllocation {
  const held = new Map<string, { total: number; count: number }>()
  for (const e of entries) {
    const at = held.get(e.goalId) ?? { total: 0, count: 0 }
    at.total += e.amountMinor
    at.count += 1
    held.set(e.goalId, at)
  }

  const rows: Allocation[] = goals
    .filter((g) => g.accountId === accountId)
    .map((g) => ({
      goal: g,
      heldMinor: held.get(g.id)?.total ?? 0,
      entryCount: held.get(g.id)?.count ?? 0,
    }))
    // Largest first, ties by id — the same order `settle_goals` takes from, so
    // the list reads top-down as the order money would come off it.
    .sort((a, b) => b.heldMinor - a.heldMinor || a.goal.id.localeCompare(b.goal.id))

  const assignedMinor = rows.reduce((sum, r) => sum + r.heldMinor, 0)
  return { accountId, balanceMinor, goals: rows, assignedMinor, unassignedMinor: balanceMinor - assignedMinor }
}

/**
 * What a withdrawal would take from each pot, worked out here so the screen can
 * say so BEFORE the server does it.
 *
 * The rule, in one sentence: what leaves the account comes off what is spare,
 * and then off the biggest pot. `settle_goals` writes exactly this, and the two
 * have to agree or the warning on screen is about a different arithmetic from
 * the one that runs.
 *
 * Returns an empty map where nothing is over-claimed, which is the ordinary
 * case and the one worth being cheap.
 */
export function shortfall(allocation: AccountAllocation): Map<string, number> {
  const out = new Map<string, number>()
  let over = -allocation.unassignedMinor
  if (over <= 0) return out

  // Largest first, all of it if that is what it takes, then the next largest.
  // The list is already in that order.
  for (const row of allocation.goals) {
    if (over <= 0) break
    if (row.heldMinor <= 0) continue
    const take = Math.min(over, row.heldMinor)
    out.set(row.goal.id, take)
    over -= take
  }
  return out
}

/**
 * Put money towards a goal, or take some back off it.
 *
 * Goes through the ordinary outbox — `goal_entries` is an RPC-backed table, so
 * the queued payload is the whole row and `assign_to_goal` re-tests it against
 * the account every time it is sent. That matters offline: two assignments made
 * on a plane are both tested when they finally reach the server, and the second
 * is refused there rather than being quietly accepted because the first had not
 * arrived yet when the screen did its own sum.
 */
export function assignmentRow(goalId: string, amountMinor: number, date: string, note?: string) {
  return { id: newId(), goalId, amountMinor, date, note }
}

/**
 * Make the ledger agree with the account again.
 *
 * Idempotent, and the server is the only thing that can do it: the pots on an
 * account may include one this device cannot see, so the shortfall has to be
 * worked out where all of them are visible. Returns how many subtractions it
 * wrote, which is 0 on the ordinary case of nothing having changed — which is
 * what makes it safe to call whenever a screen notices.
 */
export async function settleGoals(accountId: string): Promise<number> {
  return rpc<number>('settle_goals', { p_account_id: accountId })
}

/**
 * The accounts a goal may be put on.
 *
 * Any account whose rows this device can read, which is what the server asks
 * for too — `assign_to_goal` needs `view` and no more. Saying that £3,000 of
 * the savings is the deposit is a note about money that is already there; it
 * writes no transaction, so requiring the right to record one would be asking
 * for a permission the act does not use.
 */
export function goalAccounts(accounts: Account[], canSeeRows: (accountId: string) => boolean): Account[] {
  return accounts.filter((a) => canSeeRows(a.id))
}
