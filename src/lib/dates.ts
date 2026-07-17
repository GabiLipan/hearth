import {
  format,
  parseISO,
  startOfMonth,
  endOfMonth,
  addMonths,
  addWeeks,
  addYears,
  differenceInCalendarDays,
  isToday,
  isYesterday,
} from 'date-fns'
import type { BillFreq } from './db'

export const todayISO = () => format(new Date(), 'yyyy-MM-dd')

export const monthKey = (dateISO: string) => dateISO.slice(0, 7) // yyyy-MM

export const thisMonthKey = () => format(new Date(), 'yyyy-MM')

export function monthRange(key: string) {
  const start = parseISO(key + '-01')
  return { start: format(startOfMonth(start), 'yyyy-MM-dd'), end: format(endOfMonth(start), 'yyyy-MM-dd') }
}

export function shiftMonth(key: string, delta: number) {
  return format(addMonths(parseISO(key + '-01'), delta), 'yyyy-MM')
}

export function monthLabel(key: string, style: 'long' | 'short' = 'long') {
  return format(parseISO(key + '-01'), style === 'long' ? 'MMMM yyyy' : 'MMM yy')
}

export function fmtDay(dateISO: string) {
  const d = parseISO(dateISO)
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'EEE d MMM')
}

export function fmtFullDate(dateISO: string) {
  return format(parseISO(dateISO), 'd MMM yyyy')
}

export function daysUntil(dateISO: string) {
  return differenceInCalendarDays(parseISO(dateISO), new Date())
}

export function advanceDue(dateISO: string, freq: BillFreq): string {
  const d = parseISO(dateISO)
  switch (freq) {
    case 'weekly':
      return format(addWeeks(d, 1), 'yyyy-MM-dd')
    case 'fortnightly':
      return format(addWeeks(d, 2), 'yyyy-MM-dd')
    case 'monthly':
      return format(addMonths(d, 1), 'yyyy-MM-dd')
    case 'quarterly':
      return format(addMonths(d, 3), 'yyyy-MM-dd')
    case 'yearly':
      return format(addYears(d, 1), 'yyyy-MM-dd')
  }
}

export const FREQ_LABEL: Record<BillFreq, string> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
}

/** Approximate monthly cost of a bill, for totals. */
export function monthlyEquivalent(amountMinor: number, freq: BillFreq) {
  switch (freq) {
    case 'weekly':
      return (amountMinor * 52) / 12
    case 'fortnightly':
      return (amountMinor * 26) / 12
    case 'monthly':
      return amountMinor
    case 'quarterly':
      return amountMinor / 3
    case 'yearly':
      return amountMinor / 12
  }
}
