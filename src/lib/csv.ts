import Papa from 'papaparse'
import { parse as parseDate, isValid, format } from 'date-fns'
import { normalizePayee } from './rules'

export interface ParsedCSV {
  headers: string[]
  rows: string[][]
}

export interface ColumnMapping {
  date: number
  payee: number
  amount: number // single signed column, or money-out when moneyIn >= 0
  moneyIn: number // -1 when unused
  dateFormat: string
  /** true when the amount column holds positive "money out" values */
  outIsPositive: boolean
}

export function parseCSV(text: string): ParsedCSV {
  const res = Papa.parse<string[]>(text.trim(), { skipEmptyLines: 'greedy' })
  const data = res.data.filter((r) => r.length > 1)
  if (data.length === 0) return { headers: [], rows: [] }
  return { headers: data[0].map((h) => h.trim()), rows: data.slice(1) }
}

const DATE_FORMATS = ['dd/MM/yyyy', 'yyyy-MM-dd', 'MM/dd/yyyy', 'dd-MM-yyyy', 'dd MMM yyyy', 'd/M/yyyy', 'yyyy/MM/dd', 'dd.MM.yyyy']

export function guessDateFormat(samples: string[]): string {
  let best = DATE_FORMATS[0]
  let bestScore = -1
  for (const fmt of DATE_FORMATS) {
    let ok = 0
    for (const s of samples) {
      if (!s) continue
      const d = parseDate(s.trim(), fmt, new Date())
      if (isValid(d) && d.getFullYear() > 1990 && d.getFullYear() < 2100) ok++
    }
    if (ok > bestScore) {
      bestScore = ok
      best = fmt
    }
  }
  return best
}

function findHeader(headers: string[], candidates: string[]): number {
  const lower = headers.map((h) => h.toLowerCase())
  for (const c of candidates) {
    const i = lower.findIndex((h) => h.includes(c))
    if (i >= 0) return i
  }
  return -1
}

/** Guess which columns hold date / payee / amount from common bank headers. */
export function guessMapping(csv: ParsedCSV): ColumnMapping {
  const { headers, rows } = csv
  let date = findHeader(headers, ['date'])
  let payee = findHeader(headers, ['description', 'narrative', 'merchant', 'name', 'details', 'memo', 'payee', 'reference'])
  const moneyOut = findHeader(headers, ['money out', 'paid out', 'debit', 'withdrawal', 'out'])
  const moneyIn = findHeader(headers, ['money in', 'paid in', 'credit', 'deposit', 'in'])
  let amount = findHeader(headers, ['amount', 'value'])
  const outIsPositive = amount < 0 && moneyOut >= 0
  if (amount < 0) amount = moneyOut
  // Fallbacks for headerless or odd files: first parseable-date column, etc.
  if (date < 0) date = 0
  if (payee < 0) payee = Math.min(1, headers.length - 1)
  if (amount < 0) amount = headers.length - 1
  const samples = rows.slice(0, 20).map((r) => r[date] ?? '')
  return {
    date,
    payee,
    amount,
    moneyIn: outIsPositive ? moneyIn : -1,
    dateFormat: guessDateFormat(samples),
    outIsPositive,
  }
}

export interface ImportRow {
  date: string // yyyy-MM-dd
  payee: string
  amountMinor: number
  valid: boolean
}

function parseMoney(s: string): number | null {
  if (!s) return null
  const cleaned = s.replace(/[£$€₪,\s]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned.replace(/[()]/g, ''))
  if (!Number.isFinite(n)) return null
  const sign = /^\(.*\)$/.test(s.trim()) ? -1 : 1
  return Math.round(n * 100) * sign
}

export function extractRows(csv: ParsedCSV, m: ColumnMapping): ImportRow[] {
  return csv.rows.map((r) => {
    const rawDate = (r[m.date] ?? '').trim()
    const d = parseDate(rawDate, m.dateFormat, new Date())
    const dateOK = isValid(d) && d.getFullYear() > 1990 && d.getFullYear() < 2100
    const payee = (r[m.payee] ?? '').trim()
    let amountMinor: number | null = null
    const out = parseMoney(r[m.amount] ?? '')
    if (m.outIsPositive) {
      const inn = m.moneyIn >= 0 ? parseMoney(r[m.moneyIn] ?? '') : null
      if (out !== null && out !== 0) amountMinor = -Math.abs(out)
      else if (inn !== null && inn !== 0) amountMinor = Math.abs(inn)
    } else {
      amountMinor = out
    }
    return {
      date: dateOK ? format(d, 'yyyy-MM-dd') : '',
      payee,
      amountMinor: amountMinor ?? 0,
      valid: dateOK && payee.length > 0 && amountMinor !== null && amountMinor !== 0,
    }
  })
}

/**
 * Stable hash for duplicate detection across re-imports. Uses the normalised
 * payee so the raw statement text and the prettified stored payee agree.
 */
export function importHash(row: { date: string; payee: string; amountMinor: number }) {
  return `${row.date}|${row.amountMinor}|${normalizePayee(row.payee)}`
}
