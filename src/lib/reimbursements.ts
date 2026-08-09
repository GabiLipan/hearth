import type { Transaction } from './db'
import { accountsInBook, type BookMap, type Flow } from './books'

/**
 * What the household has not paid me back yet.
 *
 * Migration 13 gave one direction: I buy the weekly shop on my own card, tick
 * the box, and the row counts as household spending in their book and a
 * contribution out of mine. The household's grocery figure is right and my own
 * stops claiming I spent £90 on myself. What it did not give is the other
 * direction — the £90 is still mine, the household still has it, and nothing
 * said so.
 *
 * This is that figure, and it is a view rather than a column. Nothing new is
 * recorded and nothing is marked "settled": paying somebody back is a transfer
 * out of the joint account into their own, which the app has always been able
 * to record, and which the book model already counts as a withdrawal. So the
 * outstanding amount is simply
 *
 *     everything I have paid for the household   (flow `paid-for-household`)
 *   − everything the household has paid me       (flow `withdrawal`, my leg)
 *
 * and it goes to zero on its own the moment the repayment is recorded. A
 * "settled" flag would be a second source of truth for the same fact, and the
 * two would drift the first time somebody deleted a row.
 *
 * ## Two honest limits
 *
 * **It is one-sided.** My partner's flagged rows are in accounts I am not on,
 * so this is what the household owes ME, never a ledger of the two of us. There
 * is no way to make it two-sided without showing each of us the other's private
 * spending, which is the one thing the privacy model exists to prevent. The
 * screens say "you", not "we".
 *
 * **A repayment only counts once it is linked.** `withdrawal` is a flow of
 * transfers, so a repayment that arrived in two CSVs and has not been paired
 * reads as household spending on one side and personal income on the other, and
 * this will still say you are owed. That is the same rule the whole book model
 * runs on rather than a quirk of this file, and `TransferReview` is where it
 * gets fixed. Over-reporting a debt is also the safe direction to be wrong in:
 * it prompts somebody to look, where under-reporting would quietly write off
 * money.
 *
 * All-time, deliberately. A debt does not reset in January.
 */

export interface OutstandingItem {
  txn: Transaction
  /**
   * How much of this row is still owed. Less than the row's own amount when a
   * repayment landed part-way through it.
   */
  owedMinor: number
}

export interface Settlement {
  /** Everything I have ever paid for the household out of my own accounts. Positive. */
  paidMinor: number
  /** Everything the household has ever moved back into my accounts. Positive. */
  returnedMinor: number
  /**
   * `paid − returned`. Positive means the household owes me. Negative is
   * possible and means the opposite — money came back out of the joint account
   * that nothing here accounts for — and is reported rather than clamped,
   * because a figure that can only be one sign hides the case where it is wrong.
   */
  outstandingMinor: number
  /**
   * The rows still unpaid, newest first. Allocation runs oldest-first, so a
   * partial row is the oldest one in this list rather than the newest.
   */
  items: OutstandingItem[]
}

const EMPTY: Settlement = { paidMinor: 0, returnedMinor: 0, outstandingMinor: 0, items: [] }

export function settlement(
  txns: Transaction[],
  flows: Map<string, Flow>,
  books: BookMap,
): Settlement {
  const mine = accountsInBook('mine', books)
  if (mine.size === 0) return EMPTY

  const paid: Transaction[] = []
  let paidMinor = 0
  let returnedMinor = 0

  for (const t of txns) {
    const flow = flows.get(t.id)
    if (flow === 'paid-for-household') {
      // Always money out of a personal account — `classifyFlows` will not set
      // this flow on a credit — so the sign flip is safe.
      paid.push(t)
      paidMinor -= t.amountMinor
      continue
    }
    // Only MY leg of a withdrawal, and only the arriving half. The household
    // leg of the same transfer carries the same flow, and counting both would
    // halve the debt with every repayment; picking the leg in my own accounts
    // also sidesteps the unseen-partner case entirely, since a withdrawal into
    // an account I am not on is not a repayment to me.
    if (flow === 'withdrawal' && mine.has(t.accountId) && t.amountMinor > 0) {
      returnedMinor += t.amountMinor
    }
  }

  // Oldest first, so a repayment settles the debt it is most likely to have
  // been for. Ties broken by id: `date` is a day, several rows share one, and
  // an unstable order would make the partial row jump about between renders.
  paid.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  let left = returnedMinor
  const items: OutstandingItem[] = []
  for (const txn of paid) {
    const amount = -txn.amountMinor
    if (left >= amount) {
      left -= amount
      continue
    }
    items.push({ txn, owedMinor: amount - left })
    left = 0
  }
  items.reverse()

  return { paidMinor, returnedMinor, outstandingMinor: paidMinor - returnedMinor, items }
}
