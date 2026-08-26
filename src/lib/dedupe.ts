import { differenceInCalendarDays, parseISO } from 'date-fns'
import type { Transaction } from './db'
import { importHash } from './csv'
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

/** What the exact check says about one line of a statement. */
export interface RepeatFlags {
  /** This device already holds a row of this shape that no earlier line claimed. */
  duplicate: boolean
  /** How many lines in THIS file share the shape, where that is more than one. */
  sameInFile?: number
}

/**
 * Which lines of a statement are re-imports, and which are simply the same
 * purchase twice.
 *
 * Two different questions that were one, and conflating them lost money. The
 * check was a Set — "have I seen this fingerprint?" — which answers yes to the
 * second identical line whether the account holds one of them or both, and yes
 * whether the repeat came from an earlier import or from the very file being
 * read. So a statement listing two £3.20 coffees imported one of them, called
 * the other "already imported", and left it unticked.
 *
 * Counting separates them:
 *
 *  - **Already here.** Each line claims one row of its shape from what this
 *    device holds, and the next line of that shape has to find its own. Two
 *    coffees against an account holding one gives one duplicate and one new
 *    row, which is the arithmetic anybody would do by hand.
 *  - **Repeated in the file.** That the statement says it twice is the bank
 *    telling you it happened twice. It is not a duplicate at all; it is
 *    reported on every line of the set, because "two identical lines" is a fact
 *    about the pair and marking one of them reads as an accusation against that
 *    one.
 *
 * Order matters and is the file's own: the FIRST line of a shape is the one
 * matched against history, so in a statement running oldest-first the earliest
 * purchase is the one recognised as already imported.
 */
export function flagRepeats(
  rows: readonly { date: string; payee: string; amountMinor: number }[],
  existing: readonly Transaction[],
): RepeatFlags[] {
  const held = new Map<string, number>()
  for (const t of existing) {
    const key = t.importHash ?? importHash(t)
    held.set(key, (held.get(key) ?? 0) + 1)
  }
  const inFile = new Map<string, number>()
  for (const r of rows) {
    const key = importHash(r)
    inFile.set(key, (inFile.get(key) ?? 0) + 1)
  }
  return rows.map((r) => {
    const key = importHash(r)
    const remaining = held.get(key) ?? 0
    const duplicate = remaining > 0
    if (duplicate) held.set(key, remaining - 1)
    const n = inFile.get(key) ?? 1
    return { duplicate, sameInFile: n > 1 ? n : undefined }
  })
}
