import { differenceInCalendarDays, parseISO } from 'date-fns'
import type { Transaction } from './db'
import { normalizePayee } from './rules'

/**
 * Cross-source duplicate detection. An exact `importHash` match catches
 * re-imports of the same statement; this catches the fuzzier case of a
 * manually-entered (or receipt-scanned) expense turning up later in a
 * statement: same amount, dates within a few days (statements post late),
 * and a recognisably similar payee.
 */

export function payeeSimilar(a: string, b: string): boolean {
  const na = normalizePayee(a)
  const nb = normalizePayee(b)
  if (na.length < 3 || nb.length < 3) return false
  if (na === nb || na.includes(nb) || nb.includes(na)) return true
  const ta = na.split(' ')[0]
  const tb = nb.split(' ')[0]
  return ta.length >= 5 && ta === tb
}

export function findLikelyDuplicate(
  cand: { date: string; payee: string; amountMinor: number },
  existing: Transaction[],
  usedIds?: Set<string>,
): Transaction | undefined {
  let best: Transaction | undefined
  let bestGap = Infinity
  for (const t of existing) {
    if (t.deleted || t.amountMinor !== cand.amountMinor) continue
    if (usedIds?.has(t.id!)) continue
    const gap = Math.abs(differenceInCalendarDays(parseISO(t.date), parseISO(cand.date)))
    if (gap > 3) continue
    if (!payeeSimilar(t.payee, cand.payee)) continue
    if (gap < bestGap) {
      best = t
      bestGap = gap
    }
  }
  return best
}
