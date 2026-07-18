import { db, type Bill, type Transaction } from './db'
import { advanceDue, todayISO } from './dates'
import { normalizePayee, prettyPayee } from './rules'
import { createRow, updateRow, notDeleted } from './data'
import { differenceInCalendarDays, parseISO } from 'date-fns'

/**
 * Post a bill occurrence as a transaction and advance its next-due date.
 * The transaction id is derived from bill + due date so that two devices
 * auto-posting the same occurrence converge on one row instead of duplicating.
 */
export async function postBill(bill: Bill, onDate?: string) {
  const date = onDate ?? bill.nextDue
  await createRow<Transaction>('transactions', {
    id: `autopost-${bill.id}-${bill.nextDue}`,
    date,
    payee: bill.payee || bill.name,
    note: bill.name,
    categoryId: bill.categoryId,
    accountId: bill.accountId,
    amountMinor: bill.amountMinor,
    billId: bill.id,
    createdAt: Date.now(),
  })
  await updateRow('bills', bill.id!, { nextDue: advanceDue(bill.nextDue, bill.freq) })
}

/** Skip an occurrence without recording a payment. */
export async function skipBill(bill: Bill) {
  await updateRow('bills', bill.id!, { nextDue: advanceDue(bill.nextDue, bill.freq) })
}

/**
 * Runs at startup: for auto-post bills, record every occurrence that has come
 * due. Caps at 24 iterations as a safety valve.
 */
export async function autoPostDueBills() {
  const today = todayISO()
  const due = await db.bills.where('nextDue').belowOrEqual(today).filter(notDeleted).toArray()
  for (const bill of due) {
    if (!bill.active || !bill.autoPost) continue
    let guard = 0
    let current = bill
    while (current.nextDue <= today && guard++ < 24) {
      await postBill(current)
      current = (await db.bills.get(bill.id!))!
    }
  }
}

export interface BillSuggestion {
  payee: string
  amountMinor: number
  freq: 'weekly' | 'monthly'
  categoryId: string
  lastDate: string
  count: number
}

/**
 * Scan transaction history for payees that recur at a steady weekly/monthly
 * cadence with similar amounts — candidates for tracked bills.
 */
export async function detectBillSuggestions(): Promise<BillSuggestion[]> {
  const [txns, bills] = await Promise.all([
    db.transactions.filter(notDeleted).toArray(),
    db.bills.filter(notDeleted).toArray(),
  ])
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
      lastDate: last.date,
      count: list.length,
    })
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 6)
}
