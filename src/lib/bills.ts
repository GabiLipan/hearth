import { db, getSetting, setSetting, type Bill, type BillFreq, type Transaction } from './db'
import { advanceDue, todayISO } from './dates'
import { normalizePayee, prettyPayee, payeeSimilar } from './rules'
import { rpc } from './api'
import { differenceInCalendarDays, parseISO } from 'date-fns'

/**
 * Recording a bill happens on the SERVER, not here.
 *
 * A bill occurrence is identified by (bill, due date), and `bill_postings` has
 * that as its primary key — so two devices catching up on the same overdue bill
 * produce one transaction, not two, and `next_due` advances exactly once. The
 * old client approximated this by deriving the transaction's id from the bill
 * and due date, which converged only after a sync had merged the duplicates.
 *
 * This makes bill posting online-only. That is a deliberate trade: it is a
 * background convenience, nothing is lost by deferring it, and it catches up on
 * reconnect — whereas queueing it offline would mean teaching the outbox to
 * replay RPCs, for no benefit the user would ever notice.
 */

/** Record this occurrence now. Returns the new transaction id, or null if the other device got there first. */
export async function postBill(bill: Bill, onDate?: string): Promise<string | null> {
  return rpc<string | null>('post_bill', { p_bill_id: bill.id, p_on_date: onDate ?? null })
}

/** Skip an occurrence without recording a payment. */
export async function skipBill(bill: Bill): Promise<void> {
  await rpc('skip_bill', { p_bill_id: bill.id })
}

/**
 * Catch up every auto-post bill that has come due, in one server-side
 * transaction. Runs after the first successful sync rather than at boot: a
 * device that has not yet pulled has no idea which occurrences already exist.
 */
export async function autoPostDueBills(): Promise<number> {
  return rpc<number>('post_due_bills', { p_until: todayISO() })
}

/* ---------- reconciling against money that already moved ---------- */
//
// Everything above RECORDS a bill by writing a transaction. That is the right
// shape for a bill you are paying now and exactly the wrong shape for one you
// have already paid — importing a year of statements left every tracked bill
// reading "overdue" until you pressed a button that added a second mortgage
// payment to an account that had already made it.
//
// So: find the transaction that already IS the payment, and say so. The server
// does the linking (`link_bill_payment`), because the occurrence has to be
// claimed exactly once across both devices and `bill_postings` is not a table
// the client can reach.

/** How far from its due date a payment can land and still be that occurrence. */
const WINDOW_DAYS: Record<BillFreq, number> = {
  // A weekly bill's occurrences are only seven days apart, so the window has to
  // stay under half of that or one payment could plausibly be either of two.
  weekly: 3,
  fortnightly: 5,
  // Direct debits move for weekends and bank holidays, and a statement can post
  // a day or two after the money left.
  monthly: 8,
  quarterly: 14,
  yearly: 21,
}

/**
 * How much a payment may differ from the tracked amount.
 *
 * A mortgage is exact; a utility bill is not, and "£142.03 when you said
 * £138.00" is still obviously the electricity. The floor matters for small
 * bills, where 15% of £4.99 is too tight to absorb a price rise.
 */
const amountTolerance = (billMinor: number) => Math.max(Math.abs(billMinor) * 0.15, 100)

export interface BillMatch {
  bill: Bill
  txn: Transaction
  /** The occurrence this payment satisfies — the date the posting is claimed under. */
  dueOn: string
  /** Signed: negative means it was paid early. */
  daysOff: number
  /** Signed, in minor units: what the payment differed from the tracked amount by. */
  amountDeltaMinor: number
}

/**
 * Every unpaid occurrence that a transaction already in the account can account for.
 *
 * Walks forward from each bill's `nextDue`, because that is by definition the
 * first occurrence nothing has claimed. Occurrences BEFORE it were either paid
 * or skipped, and re-examining them would offer to reconcile history that has
 * already been settled.
 *
 * A transaction is offered for at most one occurrence, and an occurrence takes
 * at most one transaction: twelve identical mortgage payments must map to twelve
 * separate months, not all pile onto January. Occurrences are visited oldest
 * first and each takes its closest remaining candidate, which is what makes that
 * come out right.
 */
/**
 * Matches the user has rejected, so "no, that was a one-off" sticks.
 *
 * Device-local: it is a note about a suggestion, not a fact about the money,
 * and the other device is free to reach its own conclusion.
 */
const DISMISSED_KEY = 'bill-match-dismissed'

const matchKey = (billId: string, txnId: string) => `${billId}:${txnId}`

async function dismissedMatches(): Promise<Set<string>> {
  const raw = await getSetting(DISMISSED_KEY)
  return new Set(raw ? (JSON.parse(raw) as string[]) : [])
}

export async function dismissBillMatch(m: BillMatch) {
  const set = await dismissedMatches()
  set.add(matchKey(m.bill.id, m.txn.id))
  await setSetting(DISMISSED_KEY, JSON.stringify([...set].slice(-500)))
}

export async function detectBillPayments(): Promise<BillMatch[]> {
  const [txns, bills, dismissed] = await Promise.all([
    db.transactions.toArray(),
    db.bills.toArray(),
    dismissedMatches(),
  ])
  const today = todayISO()
  const out: BillMatch[] = []
  const claimed = new Set<string>()

  for (const bill of bills) {
    if (!bill.active) continue
    const window = WINDOW_DAYS[bill.freq]
    const tolerance = amountTolerance(bill.amountMinor)
    const target = bill.payee || bill.name

    const candidates = txns.filter(
      (t) =>
        t.accountId === bill.accountId &&
        t.amountMinor < 0 &&
        // Already accounted for: as this bill's payment, as another bill's, or
        // as one leg of a transfer, which is not spending at all.
        t.billId == null &&
        t.transferId == null &&
        Math.abs(Math.abs(t.amountMinor) - Math.abs(bill.amountMinor)) <= tolerance &&
        payeeSimilar(t.payee, target) &&
        !dismissed.has(matchKey(bill.id, t.id)),
    )
    if (candidates.length === 0) continue

    // Only occurrences that have actually come due. Reconciling a future one
    // would mean claiming a payment for a month that has not happened yet.
    let due = bill.nextDue
    for (let i = 0; i < 60 && due <= today; i++) {
      let best: Transaction | undefined
      let bestGap = Infinity
      for (const t of candidates) {
        if (claimed.has(t.id)) continue
        const gap = differenceInCalendarDays(parseISO(t.date), parseISO(due))
        if (Math.abs(gap) > window) continue
        if (Math.abs(gap) < Math.abs(bestGap)) {
          best = t
          bestGap = gap
        }
      }
      if (best) {
        claimed.add(best.id)
        out.push({
          bill,
          txn: best,
          dueOn: due,
          daysOff: bestGap,
          amountDeltaMinor: best.amountMinor - bill.amountMinor,
        })
      }
      due = advanceDue(due, bill.freq)
    }
  }
  // Oldest first: reconciling in order is what lets `next_due` walk forward
  // once rather than jumping and being wound back.
  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn))
}

/**
 * "This transaction is that bill's payment." Returns the bill's new next due
 * date, or null if the other device claimed the occurrence first.
 *
 * Online-only, like the rest of the bill path and for the same reason: the
 * occurrence must be claimed exactly once, which is a server-side uniqueness
 * question the outbox has no way to answer.
 */
export async function linkBillPayment(billId: string, txnId: string, dueOn: string) {
  return rpc<string | null>('link_bill_payment', {
    p_bill_id: billId,
    p_txn_id: txnId,
    p_due_on: dueOn,
  })
}

/** "No it isn't." Frees the occurrence and winds the bill back to it. The transaction stays. */
export async function unlinkBillPayment(txnId: string) {
  return rpc<string | null>('unlink_bill_payment', { p_txn_id: txnId })
}

/**
 * Where a bill tracked from a suggestion should say it is next due.
 *
 * One period on from the last payment we can see — not today, which is what the
 * Bills screen used to use. If a mortgage goes out on the 4th and you start
 * tracking it on the 22nd, "next due today" is both wrong and immediately
 * overdue, and the first thing the app does with a brand new bill is tell you
 * off about it.
 */
export function dueAfter(lastDate: string, freq: BillFreq): string {
  let due = advanceDue(lastDate, freq)
  // A long gap in the statement (or a suggestion built from old history) can
  // leave that still in the past. Walk it up to the first one not yet due.
  const today = todayISO()
  for (let i = 0; i < 60 && due < today; i++) due = advanceDue(due, freq)
  return due
}

export interface BillSuggestion {
  payee: string
  amountMinor: number
  freq: 'weekly' | 'monthly'
  categoryId?: string
  accountId: string
  lastDate: string
  count: number
}

/**
 * Scan transaction history for payees that recur at a steady weekly/monthly
 * cadence with similar amounts — candidates for tracked bills.
 */
export async function detectBillSuggestions(): Promise<BillSuggestion[]> {
  const [txns, bills] = await Promise.all([db.transactions.toArray(), db.bills.toArray()])
  const existing = new Set(bills.map((b) => normalizePayee(b.payee || b.name)))
  const groups = new Map<string, Transaction[]>()
  for (const t of txns) {
    if (t.amountMinor >= 0 || t.billId) continue
    const key = normalizePayee(t.payee)
    if (key.length < 3) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
  }
  const out: BillSuggestion[] = []
  for (const [key, list] of groups) {
    if (existing.has(key) || list.length < 3) continue
    list.sort((a, b) => a.date.localeCompare(b.date))
    const gaps: number[] = []
    for (let i = 1; i < list.length; i++) {
      gaps.push(differenceInCalendarDays(parseISO(list[i].date), parseISO(list[i - 1].date)))
    }
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length
    const steady = gaps.every((g) => Math.abs(g - avg) <= Math.max(4, avg * 0.25))
    if (!steady) continue
    let freq: 'weekly' | 'monthly'
    if (avg >= 5 && avg <= 9) freq = 'weekly'
    else if (avg >= 26 && avg <= 35) freq = 'monthly'
    else continue
    const amounts = list.map((t) => Math.abs(t.amountMinor))
    const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length
    if (!amounts.every((a) => Math.abs(a - mean) <= mean * 0.2)) continue
    const last = list[list.length - 1]
    out.push({
      payee: prettyPayee(key),
      amountMinor: -Math.round(mean),
      freq,
      categoryId: last.categoryId,
      accountId: last.accountId,
      lastDate: last.date,
      count: list.length,
    })
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 6)
}
