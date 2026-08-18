import { differenceInCalendarDays, parseISO } from 'date-fns'
import type { Transaction } from './db'
import { payeeSimilar } from './rules'

/**
 * Cross-source duplicate detection. An exact `importHash` match catches
 * re-imports of the same statement; this catches the fuzzier case of a
 * manually-entered (or receipt-scanned) expense turning up later in a
 * statement: same amount, dates within a few days (statements post late),
 * and a recognisably similar payee.
 *
 * `payeeSimilar` moved to rules.ts once bulk recategorisation and transfer
 * pairing started asking the same question. Re-exported here because this is
 * where callers learned to look for it.
 */

export { payeeSimilar }

export function findLikelyDuplicate(
  cand: { date: string; payee: string; amountMinor: number },
  existing: Transaction[],
  usedIds?: Set<string>,
): Transaction | undefined {
  let best: Transaction | undefined
  let bestGap = Infinity
  for (const t of existing) {
    if (t.amountMinor !== cand.amountMinor) continue
    if (usedIds?.has(t.id)) continue
    const gap = Math.abs(differenceInCalendarDays(parseISO(t.date), parseISO(cand.date)))
    if (gap > 3) continue
    // A row added by hand may have no reference at all — nobody types
    // "SQ *THE GOOD FORK 3241" from memory, they type what it was. There is
    // nothing to compare, so the amount and the date carry the match on their
    // own. That is a weaker claim, which is why it is only ever OFFERED: the
    // import wizard unticks these and asks, and the transaction form asks too.
    if (t.payee.trim() && !payeeSimilar(t.payee, cand.payee)) continue
    if (gap < bestGap) {
      best = t
      bestGap = gap
    }
  }
  return best
}
