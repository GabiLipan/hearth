import { db, type Bill, type Transaction } from './db'
import { todayISO } from './dates'
import { normalizePayee, prettyPayee } from './rules'
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
