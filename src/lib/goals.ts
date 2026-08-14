import { newId, type Goal, type Transaction } from './db'
import { rpc } from './api'
import { differenceInCalendarDays, parseISO } from 'date-fns'

/**
 * Saving pots.
 *
 * A goal is not a budget. A budget is a ceiling that resets every month; a goal
 * accumulates towards a target and does not care about month boundaries. Money
 * arrives in a goal by transferring it into an account and tagging the incoming
 * leg, so the progress figure is always backed by money that actually moved.
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

export function goalProgress(goal: Goal, txns: Transaction[]): GoalProgress {
  let savedMinor = 0
  /** The first day money went in, for the pace mark. */
  let firstFunded: string | undefined
  for (const t of txns) {
    if (t.goalId !== goal.id) continue
    savedMinor += t.amountMinor
    if (!firstFunded || t.date < firstFunded) firstFunded = t.date
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
