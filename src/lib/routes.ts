import { differenceInCalendarDays, parseISO } from 'date-fns'
import { advanceDue } from './dates'
import type { BillFreq, Transaction } from './db'

/**
 * The route money habitually travels, learned from the transfers you have
 * already confirmed.
 *
 * Payday is the case. We are both paid at the end of the month and we both move
 * a round sum into the joint account, so my one outgoing leg matches two
 * identical arrivals and `unambiguous` is false — for ever, every month, with
 * the same two rows and the same answer. `bookSafe` already rescues the half of
 * that which cannot go wrong (one leg out, several arrivals: whichever is
 * chosen, the leftover counts as outside income and the household's total is
 * the same). The mirror image is the one that still needs asking about, because
 * an outgoing leg left stranded reads as personal SPENDING, which is a
 * different number and a wrong one.
 *
 * A route resolves exactly that. It is not new information the user has to
 * supply — it is the same answer they have already given, several times:
 * "£2,000 leaves my private account for the joint one at the end of every
 * month". Once that is a habit rather than a coincidence, the arrival with two
 * possible partners has an obvious one.
 *
 * ## Derived, never stored
 *
 * There is no table and no migration here, and there should not be. A route is
 * a summary of `transactions` where `transfer_id` is set — rows that already
 * exist, on the server, replicated to both devices. Storing it would create a
 * second copy of a fact the first copy already answers, and the two would
 * disagree the moment somebody unlinked a transfer. Deleting a transfer un-
 * teaches the route, which is the behaviour you would want and would otherwise
 * have to build.
 *
 * ## What it deliberately does NOT do
 *
 * It never creates a transaction. A bill posts money that has not moved yet;
 * a route only recognises money that has. Predicting payday into the ledger
 * would be inventing rows the bank has not seen, and the whole reconciliation
 * story in this app exists because inventing rows is how you end up with two
 * of everything. `nextOn` is a date to say out loud, not a thing to post.
 */

export interface TransferRoute {
  fromAccountId: string
  toAccountId: string
  /** The median amount moved on this route, positive. */
  typicalMinor: number
  /** How many confirmed transfers taught it. */
  count: number
  /** The median gap between consecutive movements, in days. */
  cadenceDays: number
  freq: BillFreq
  /** The most recent movement. */
  lastOn: string
  /** One period after `lastOn`. A sentence to say, never a row to write. */
  nextOn: string
}

/** How to say a cadence in a sentence. Two screens need the same words. */
export const FREQ_WORD: Record<BillFreq, string> = {
  weekly: 'weekly',
  fortnightly: 'fortnightly',
  monthly: 'monthly',
  quarterly: 'quarterly',
  yearly: 'yearly',
}

/**
 * How many confirmed movements make a habit.
 *
 * Three, not two. Two payments a month apart is every pair of things that
 * happened twice; the third is what distinguishes a standing arrangement from a
 * coincidence, and this number is the only thing standing between "learned your
 * payday" and "linked two unrelated transfers because they were both £500".
 */
const MIN_SEEN = 3

/**
 * The gaps that count as a cadence, in days, and what to call each.
 *
 * Wider than a bill's windows because these are the gaps BETWEEN occurrences
 * rather than the drift of one occurrence from its due date, and a monthly
 * movement made on "the last working day" swings by several days on its own.
 * Nothing sits between the buckets by accident: a gap of 20 days is not a
 * cadence this app has a word for, and calling it monthly would put `nextOn` a
 * fortnight out.
 */
const CADENCES: { freq: BillFreq; min: number; max: number }[] = [
  { freq: 'weekly', min: 5, max: 9 },
  { freq: 'fortnightly', min: 12, max: 17 },
  { freq: 'monthly', min: 25, max: 36 },
  { freq: 'quarterly', min: 80, max: 100 },
  { freq: 'yearly', min: 350, max: 380 },
]

/**
 * How far a movement's amount may sit from the route's typical one and still be
 * that route.
 *
 * Generous, and deliberately so: a salary rises, a contribution gets adjusted
 * when the rent does, and a route is fundamentally a statement about which two
 * accounts money travels between rather than about the figure. The amount is
 * corroboration. The floor keeps small habitual movements from having a
 * meaninglessly tight window.
 */
const amountTolerance = (typicalMinor: number) => Math.max(typicalMinor * 0.25, 500)

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

interface Movement {
  from: string
  to: string
  date: string
  /** Positive. */
  amountMinor: number
}

/**
 * The confirmed transfers, as movements between two accounts.
 *
 * A transfer with anything other than exactly one leg out and one leg in is
 * skipped rather than guessed at. That is not a defensive nicety: my partner's
 * contribution has its far leg in an account I am not on, so a one-legged
 * transfer is the normal state of half the transfers on this device — and the
 * account it came from, which is the entire point of a route, is precisely the
 * thing I cannot see.
 */
function movements(txns: Transaction[]): Movement[] {
  const byTransfer = new Map<string, Transaction[]>()
  for (const t of txns) {
    if (!t.transferId) continue
    const list = byTransfer.get(t.transferId)
    if (list) list.push(t)
    else byTransfer.set(t.transferId, [t])
  }

  const out: Movement[] = []
  for (const legs of byTransfer.values()) {
    if (legs.length !== 2) continue
    const from = legs.find((l) => l.amountMinor < 0)
    const to = legs.find((l) => l.amountMinor > 0)
    if (!from || !to || from.accountId === to.accountId) continue
    out.push({
      from: from.accountId,
      to: to.accountId,
      // The outgoing leg's date. It is the one the payer controls, and the
      // arrival can post a day late without moving the cadence.
      date: from.date,
      amountMinor: -from.amountMinor,
    })
  }
  return out
}

const routeKey = (from: string, to: string) => `${from}>${to}`

/**
 * Every route the confirmed transfers add up to.
 *
 * Directional. Joint → savings and savings → joint are two different habits
 * that happen to share two accounts, and collapsing them would let a withdrawal
 * teach the app about contributions.
 */
export function learnRoutes(txns: Transaction[]): TransferRoute[] {
  const groups = new Map<string, Movement[]>()
  for (const m of movements(txns)) {
    const key = routeKey(m.from, m.to)
    const list = groups.get(key)
    if (list) list.push(m)
    else groups.set(key, [m])
  }

  const routes: TransferRoute[] = []
  for (const list of groups.values()) {
    if (list.length < MIN_SEEN) continue
    list.sort((a, b) => a.date.localeCompare(b.date))

    const gaps: number[] = []
    for (let i = 1; i < list.length; i++) {
      gaps.push(differenceInCalendarDays(parseISO(list[i].date), parseISO(list[i - 1].date)))
    }

    const cadenceDays = median(gaps)
    const bucket = CADENCES.find((c) => cadenceDays >= c.min && cadenceDays <= c.max)
    if (!bucket) continue

    // Most of them, not all. A month where the transfer was made twice, or
    // skipped, should not un-teach a habit of two years — but a set of gaps
    // that only happens to average out to a month is not a cadence at all.
    const regular = gaps.filter((g) => g >= bucket.min && g <= bucket.max).length
    if (regular < Math.ceil(gaps.length * 0.7)) continue

    const last = list[list.length - 1]
    routes.push({
      fromAccountId: last.from,
      toAccountId: last.to,
      typicalMinor: median(list.map((m) => m.amountMinor)),
      count: list.length,
      cadenceDays,
      freq: bucket.freq,
      lastOn: last.date,
      nextOn: advanceDue(last.date, bucket.freq),
    })
  }

  // Most established first: where two routes could explain the same pair, the
  // one seen more often is the better answer.
  return routes.sort((a, b) => b.count - a.count || b.lastOn.localeCompare(a.lastOn))
}

/**
 * Does this movement look like one of these routes?
 *
 * The accounts must match exactly and in the right direction; the amount only
 * has to be close. Returns the route so a caller can say which habit it
 * recognised, because "linked automatically" with no reason given is the kind
 * of automation people turn off.
 */
export function routeFor(
  routes: TransferRoute[],
  fromAccountId: string,
  toAccountId: string,
  amountMinor: number,
): TransferRoute | undefined {
  const amount = Math.abs(amountMinor)
  return routes.find(
    (r) =>
      r.fromAccountId === fromAccountId &&
      r.toAccountId === toAccountId &&
      Math.abs(amount - r.typicalMinor) <= amountTolerance(r.typicalMinor),
  )
}
