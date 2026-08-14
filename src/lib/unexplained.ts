import type { Transaction } from './db'
import { accountsInBook, effectiveMonth, type BookMap, type Flow } from './books'
import { rpc } from './api'

/**
 * Money that moved between our books, that only the other person can confirm.
 *
 * The book model is exactly right whenever a transfer is linked, and it has a
 * blind spot when one cannot be. My partner's contribution has its far leg in
 * an account I am not on: I see the arrival in the joint account and nothing
 * else. Until they link it from their side, the app has to call it something,
 * and what it calls it is wrong in a specific, load-bearing way:
 *
 *   - money IN with no link      → counted as the household earning it
 *   - money OUT with no link     → counted as the household SPENDING it
 *
 * The second is the one that does damage. It inflates household spending, and
 * household spending is what budgets measure and what the reports are mostly
 * about, so £1,800 moved back into a private account reads as £1,800 spent.
 *
 * Nothing here reclassifies anything. It cannot: a payee string is a guess, and
 * quietly moving money out of "spending" on the strength of the word "TFR"
 * would be a worse failure than the one it fixes — the figures would then be
 * wrong in a way nobody could see. This finds the rows worth saying a sentence
 * about, and the screens say the sentence.
 *
 * It also deliberately does not look at amounts. `findTransferCandidates`
 * already pairs anything with a visible partner, so by construction everything
 * here has no partner to match against; "a suspiciously round £2,000" is how
 * you end up flagging somebody's sofa.
 */

/**
 * What a bank calls moving money, as opposed to buying something.
 *
 * Matched against the RAW payee, not the normalised one: `normalizePayee`
 * strips exactly these words — `tfr`, `bp`, `payment` — because for merchant
 * identity they are noise. Here they are the entire signal.
 *
 * `fp` only counts followed by `to` or `from`. On its own two letters are far
 * too easy to hit inside a merchant code, and a false positive here marks an
 * ordinary purchase as something the household may not have spent — which is
 * the thing this file exists to avoid claiming.
 *
 * Checked against a spread of real UK statement text: `TRANSFERWISE LTD` does
 * not match (no word boundary after `transfer`), nor does `BGCO SUPPLIES`, and
 * neither do two dozen ordinary merchants.
 */
const TRANSFER_WORDS =
  /\b(transfer|tfr|trf|xfer|faster\s*payment|fps|fpi|fpo|bank\s*giro|bgc|standing\s*order|to\s+savings|from\s+savings|(payment|fp)\s+(to|from))\b/i

export interface UnexplainedLeg {
  txn: Transaction
  /** Into the household's accounts, or out of them. */
  direction: 'in' | 'out'
}

/**
 * Does this row read as a movement of money rather than a purchase?
 *
 * Exported for the badge in Activity, which asks about one row at a time.
 */
export function looksLikeTransfer(txn: Transaction): boolean {
  // Already explained: half of a transfer, recorded against a bill, or tagged
  // with whose contribution it is. The last is the answer for a row that can
  // never be paired at all, so a badge still asking about it would be asking a
  // question that has been answered as fully as it ever can be.
  if (txn.transferId || txn.billId || txn.contributorId) return false
  // Somebody has said what this is. A row filed under Groceries is not a
  // transfer, whatever the statement called it.
  if (txn.categoryId) return false
  return TRANSFER_WORDS.test(txn.payee)
}

/**
 * The rows in the household's accounts that look like transfers nobody here can
 * link. Optionally narrowed to one month, using the same effective-month rule
 * the totals use so the sentence and the figure it explains agree.
 */
export function unexplainedLegs(
  txns: Transaction[],
  flows: Map<string, Flow>,
  books: BookMap,
  month?: string,
): UnexplainedLeg[] {
  // Household only. A movement between two of MY accounts has both legs on this
  // device, so if it is unlinked that is a pairing job, not an unanswerable
  // question — and the review list already offers it.
  const ids = accountsInBook('household', books)
  const out: UnexplainedLeg[] = []

  for (const t of txns) {
    if (!ids.has(t.accountId) || t.amountMinor === 0) continue
    if (!looksLikeTransfer(t)) continue
    const flow = flows.get(t.id)
    // Only the two flows this is about. Anything already understood as a
    // contribution or a withdrawal has been linked and needs no explaining.
    if (flow !== 'external-income' && flow !== 'household-spend') continue
    if (month && effectiveMonth(t, flow) !== month) continue
    out.push({ txn: t, direction: t.amountMinor > 0 ? 'in' : 'out' })
  }

  return out.sort((a, b) => b.txn.date.localeCompare(a.txn.date))
}

export interface UnexplainedTotals {
  /** Counted as household income this month, and possibly a contribution. Positive. */
  inMinor: number
  /** Counted as household SPENDING this month, and possibly a withdrawal. Positive. */
  outMinor: number
  inCount: number
  outCount: number
}

/* ---------- asking the person who can see the other half ---------- */

/**
 * The half this file could not do on its own.
 *
 * Everything above finds rows worth a sentence. None of it can act, and neither
 * can the person reading it: the fix is linking the two legs, and
 * `link_transfer` refuses anybody who cannot write both. So the person who can
 * SEE the problem and the person who can SOLVE it are different people, and
 * until migration 16 nothing connected them.
 *
 * `request_explanation` is the connection. It needs only `view` on the account,
 * deliberately lower than the bar for changing the row — being able to see a
 * row is the whole qualification for being confused by it, and at `contribute`
 * you may not edit a row your partner imported.
 *
 * Online-only, and unapologetically: the entire purpose is to reach the other
 * device.
 */
export const requestExplanation = (txnId: string) =>
  rpc<string>('request_explanation', { p_transaction_id: txnId })

/**
 * Withdraw the question. Open to either person on purpose — the asker changes
 * their mind, or the person asked looks and says "no, we really did spend
 * that", which is a good answer that produces no link.
 */
export const clearExplanation = (txnId: string) =>
  rpc<null>('clear_explanation', { p_transaction_id: txnId })

/**
 * Is this row still asking a question?
 *
 * `transferId` first, always. Linking answers the question and deliberately
 * does NOT clear the mark — doing that would have meant a third
 * `create or replace` over `link_transfer`'s security-definer body, which is
 * exactly where a dropped check hides. A mark on a paired row is inert instead,
 * and this is the one place that knows it.
 */
export function isAsking(txn: Transaction): boolean {
  return !!txn.explainRequestedAt && !txn.transferId && !txn.billId
}

/**
 * Rows somebody ELSE has asked about, newest question first.
 *
 * Not my own asks: seeing my own question listed back at me as a job to do is
 * how a nudge becomes noise. Rows where `explainRequestedBy` is missing — an
 * older client, or a row whose asker has left the household — are shown, on the
 * grounds that an unattributed question is still a question.
 */
export function askedOfMe(txns: Transaction[], userId?: string): Transaction[] {
  return txns
    .filter((t) => isAsking(t) && t.explainRequestedBy !== userId)
    .sort((a, b) => (b.explainRequestedAt ?? '').localeCompare(a.explainRequestedAt ?? ''))
}

export function unexplainedTotals(legs: UnexplainedLeg[]): UnexplainedTotals {
  const t: UnexplainedTotals = { inMinor: 0, outMinor: 0, inCount: 0, outCount: 0 }
  for (const { txn, direction } of legs) {
    if (direction === 'in') {
      t.inMinor += txn.amountMinor
      t.inCount += 1
    } else {
      t.outMinor -= txn.amountMinor
      t.outCount += 1
    }
  }
  return t
}
