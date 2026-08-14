import type { Transaction } from './db'
import { update } from './data'
import { normalizePayee, payeeSimilar } from './rules'
import type { BookMap } from './books'

/**
 * Recognising a contribution from somebody who is not using the app.
 *
 * `contributorId` is the answer to "whose money was that", and somebody has to
 * give it. Giving it once a month for ever is not an answer anybody keeps up,
 * so this is the part that remembers: her salary arrives under the same payee
 * every month, and once you have said twice that the payee is hers, the third
 * one can say so itself.
 *
 * **Learned, never stored.** There is no table and there must not be, for the
 * reason `routes.ts` gives about routes: this is a second reading of rows that
 * already exist. Untagging the rows un-teaches it, which is the behaviour you
 * would otherwise have to build — and there is no schema, no policy and no
 * sync story to get wrong.
 *
 * **It suggests and never applies.** Accepting is one tap and declining is
 * doing nothing. That is the same posture `findTransferCandidates` takes with an
 * ambiguous pair, and for the same reason: accepting moves money between months
 * as well as onto a name, so a wrong guess applied quietly is wrong in a way
 * nobody can see. `unexplained.ts` makes the argument at length.
 */

/**
 * How many times a payee must have been tagged before it is worth suggesting.
 *
 * One is an accident or a one-off gift. `routes.ts` wants three before it will
 * call something a habit, but it is making a stronger claim — that money moves
 * between two accounts on a cadence — where this only says "payments from this
 * name have been hers before". Two is the floor at which that stops being a
 * coincidence.
 */
export const CONFIRMATIONS_NEEDED = 2

/** payee (normalised) → the person whose contributions arrive under it. */
export type LearnedContributors = Map<string, string>

/**
 * What the rows already tagged have to say about who pays in under which name.
 *
 * Household accounts only, matching where `contributorId` can mean anything at
 * all. A payee tagged to two different people is dropped rather than resolved:
 * a joint payee is exactly the case where a suggestion would be a coin toss, and
 * the person is right there to ask.
 */
export function learnContributors(txns: Transaction[], books: BookMap): LearnedContributors {
  const seen = new Map<string, Map<string, number>>()

  for (const t of txns) {
    if (!t.contributorId || t.amountMinor <= 0) continue
    if (!books.household.has(t.accountId)) continue
    const key = normalizePayee(t.payee)
    // Same floor as `learnRule`: below three characters a normalised payee
    // matches half the statement.
    if (key.length < 3) continue
    const counts = seen.get(key) ?? new Map<string, number>()
    counts.set(t.contributorId, (counts.get(t.contributorId) ?? 0) + 1)
    seen.set(key, counts)
  }

  const out: LearnedContributors = new Map()
  for (const [key, counts] of seen) {
    if (counts.size !== 1) continue
    const [userId, n] = [...counts][0]
    if (n >= CONFIRMATIONS_NEEDED) out.set(key, userId)
  }
  return out
}

/**
 * Who this arrival is probably from, or undefined.
 *
 * Matched with `payeeSimilar` rather than on equality, so "A KAMINSKA" and
 * "A KAMINSKA 27JUL26" are the same person — statement text carries a reference
 * that changes every month, and an exact match would learn nothing that was ever
 * asked again. Longest known payee wins, which is what stops a short name
 * swallowing a longer one that contains it.
 */
export function suggestContributor(payee: string, learned: LearnedContributors): string | undefined {
  const key = normalizePayee(payee)
  if (key.length < 3) return undefined
  const exact = learned.get(key)
  if (exact) return exact

  let best: string | undefined
  let bestLen = 0
  for (const [known, userId] of learned) {
    if (known.length <= bestLen || !payeeSimilar(known, key)) continue
    best = userId
    bestLen = known.length
  }
  return best
}

/**
 * Is this a row the question can even be asked about?
 *
 * Money in, to a household account, not already half of a transfer. The three
 * conditions `classifyFlows` reads the tag under, in one place so the form, the
 * row action and the report banner cannot drift into offering it in different
 * places. The account test is the caller's, since only it knows the books.
 */
export function taggable(txn: Transaction, books: BookMap): boolean {
  return txn.amountMinor > 0 && !txn.transferId && books.household.has(txn.accountId)
}

/**
 * Tag several arrivals at once, skipping any the server would refuse.
 *
 * `canEdit` is not optional and has no default, for the reason spelled out on
 * `applyCategory`: at `contribute` you may change only what you added, writes
 * fail late and quietly, and a bulk update is the easiest way in this codebase
 * to queue fifty dead letters that surface in Settings a minute later.
 *
 * Returns what it actually changed and what it left, so the screen can say
 * "3 tagged, 2 are Sam's" rather than silently doing less than it offered.
 */
export async function applyContributor(
  txns: Transaction[],
  contributorId: string | undefined,
  canEdit: (t: Transaction) => boolean,
): Promise<{ updated: number; skipped: number }> {
  let updated = 0
  let skipped = 0
  for (const t of txns) {
    if (!canEdit(t)) {
      skipped++
      continue
    }
    // Explicitly `undefined` rather than omitted when clearing: an absent key
    // means "leave alone", a present one set to undefined means "clear it".
    // See `mapping.ts`.
    await update('transactions', t.id, { contributorId })
    updated++
  }
  return { updated, skipped }
}

/**
 * Other arrivals that look like they came from the same person.
 *
 * The twin of `similarTo` in rules.ts, and deliberately the same matcher, so
 * "similar" means one thing across the app. Excludes rows already tagged to that
 * person — offering to do what is already done makes the count a lie.
 */
export function similarArrivals(
  payee: string,
  contributorId: string,
  txns: Transaction[],
  books: BookMap,
  exceptId?: string,
): Transaction[] {
  return txns.filter(
    (t) =>
      t.id !== exceptId &&
      t.contributorId !== contributorId &&
      taggable(t, books) &&
      payeeSimilar(t.payee, payee),
  )
}
