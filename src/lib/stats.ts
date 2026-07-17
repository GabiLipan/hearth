import type { Category, Transaction } from './db'
import { monthKey, shiftMonth, thisMonthKey, monthLabel } from './dates'

export interface CategorySlice {
  categoryId: number
  name: string
  emoji: string
  slot: number
  totalMinor: number // positive spend
  fraction: number
}

/** Spend per expense category for one month, largest first, small tail folded into "Other". */
export function spendByCategory(txns: Transaction[], categories: Category[], month: string, maxSlices = 7): CategorySlice[] {
  const catMap = new Map(categories.map((c) => [c.id!, c]))
  const totals = new Map<number, number>()
  for (const t of txns) {
    if (t.amountMinor >= 0 || monthKey(t.date) !== month) continue
    const cat = catMap.get(t.categoryId)
    if (!cat || cat.kind !== 'expense') continue
    totals.set(t.categoryId, (totals.get(t.categoryId) ?? 0) - t.amountMinor)
  }
  const grand = [...totals.values()].reduce((s, v) => s + v, 0)
  if (grand === 0) return []
  const slices: CategorySlice[] = [...totals.entries()]
    .map(([categoryId, totalMinor]) => {
      const c = catMap.get(categoryId)!
      return { categoryId, name: c.name, emoji: c.emoji, slot: c.slot, totalMinor, fraction: totalMinor / grand }
    })
    .sort((a, b) => b.totalMinor - a.totalMinor)
  if (slices.length <= maxSlices) return slices
  const head = slices.slice(0, maxSlices - 1)
  const tail = slices.slice(maxSlices - 1)
  const tailTotal = tail.reduce((s, v) => s + v.totalMinor, 0)
  head.push({ categoryId: -1, name: 'Other', emoji: '···', slot: 0, totalMinor: tailTotal, fraction: tailTotal / grand })
  return head
}

export interface MonthPoint {
  key: string
  label: string
  spend: number // positive minor units
  income: number
  net: number
}

/** Aggregate the last n months (oldest first). */
export function monthlySeries(txns: Transaction[], categories: Category[], n: number): MonthPoint[] {
  const kinds = new Map(categories.map((c) => [c.id!, c.kind]))
  const now = thisMonthKey()
  const keys: string[] = []
  for (let i = n - 1; i >= 0; i--) keys.push(shiftMonth(now, -i))
  const byKey = new Map(keys.map((k) => [k, { spend: 0, income: 0 }]))
  for (const t of txns) {
    const k = monthKey(t.date)
    const agg = byKey.get(k)
    if (!agg) continue
    if (t.amountMinor < 0) agg.spend -= t.amountMinor
    else if (kinds.get(t.categoryId) === 'income') agg.income += t.amountMinor
    else agg.income += t.amountMinor
  }
  return keys.map((key) => {
    const { spend, income } = byKey.get(key)!
    return { key, label: monthLabel(key, 'short'), spend, income, net: income - spend }
  })
}

/** Total spent / earned within a month. */
export function monthTotals(txns: Transaction[], month: string) {
  let spend = 0
  let income = 0
  for (const t of txns) {
    if (monthKey(t.date) !== month) continue
    if (t.amountMinor < 0) spend -= t.amountMinor
    else income += t.amountMinor
  }
  return { spend, income, net: income - spend }
}
