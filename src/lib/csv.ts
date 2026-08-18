import Papa from 'papaparse'
import { parse as parseDate, isValid, format } from 'date-fns'
import { normalizePayee } from './rules'

export interface ParsedCSV {
  headers: string[]
  rows: string[][]
}

/**
 * How a statement lays its amounts out. Two shapes, and banks are split
 * roughly evenly between them:
 *
 *   `signed` — one column, negative for money out
 *   `split`  — two columns, "Money out" and "Money in", and in most exports
 *              BOTH hold positive numbers with the direction implied by which
 *              column the value is in
 */
export type AmountLayout = 'signed' | 'split'

export interface ColumnMapping {
  date: number
  payee: number
  /** The signed amount column, or money OUT under a `split` layout. */
  amount: number
  /** Money in. Read only under `split`; -1 when unknown. */
  moneyIn: number
  layout: AmountLayout
  /**
   * Which sign in the amount column means money OUT. Read only under `signed`,
   * where the column carries the direction and nothing else does; under `split`
   * the SIDE decides, so it is forced false there the way `moneyIn` is -1.
   *
   * False is a bank account: negative for money out. True is a card statement —
   * Amex and most credit cards — where a purchase is a plus and the payment
   * that clears the card is a minus. The same shape of file, meaning the
   * opposite thing.
   */
  invert: boolean
  dateFormat: string
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

/**
 * A money cell, in minor units. Handles a currency symbol, thousands
 * separators, and accountants' parentheses for a negative.
 *
 * Declared above the mapping guesser because that reads the DATA to decide the
 * layout, not just the headings.
 */
function parseMoney(s: string): number | null {
  if (!s) return null
  const cleaned = s.replace(/[£$€₪,\s]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned.replace(/[()]/g, ''))
  if (!Number.isFinite(n)) return null
  const sign = /^\(.*\)$/.test(s.trim()) ? -1 : 1
  return Math.round(n * 100) * sign
}

function findHeader(headers: string[], candidates: string[]): number {
  const lower = headers.map((h) => h.toLowerCase())
  for (const c of candidates) {
    const i = lower.findIndex((h) => h.includes(c))
    if (i >= 0) return i
  }
  return -1
}

/**
 * Header patterns for the two halves of a split layout.
 *
 * Anchored on word boundaries, not `includes`. "in" as a substring appears in
 * "Running Balance" and "Beginning Balance", and matching those as the
 * money-in column turns a running balance into income on every row — which is
 * the kind of failure that looks like the app inventing money.
 *
 * Order matters: the explicit two-word forms are tried before `debit`/`credit`,
 * so a file carrying both "Paid out" and "Debit amount" picks the one a person
 * would.
 */
const OUT_HEADERS = /\b(money|paid|amount|value|payments?)?\s*out\b|\bdebits?\b|\bwithdrawals?\b|\bspent\b/
const IN_HEADERS = /\b(money|paid|amount|value|payments?)?\s*in\b|\bcredits?\b|\bdeposits?\b|\breceipts?\b|\breceived\b/

const matching = (headers: string[], re: RegExp): number =>
  headers.findIndex((h) => re.test(h.toLowerCase()))

/** How much of a column parses as money — the evidence a header cannot give. */
function numericShare(rows: string[][], col: number): number {
  if (col < 0) return 0
  let filled = 0
  let numeric = 0
  for (const r of rows) {
    const cell = (r[col] ?? '').trim()
    if (!cell) continue
    filled++
    if (parseMoney(cell) !== null) numeric++
  }
  return filled === 0 ? 0 : numeric / filled
}

/**
 * Do these two columns behave like an out/in pair?
 *
 * The decisive evidence is not in the headers, it is in the shape of the data:
 * a row is money out or money in, never both, so in a genuine split file the
 * two columns are almost perfectly complementary. An "Amount" beside a
 * "Balance" is filled on every row in both, and that is what tells them apart.
 *
 * "Almost", because a real export does contain the occasional row with a value
 * in both — a fee taken out of a credit, an adjustment — so this asks for a
 * clear majority rather than perfection.
 */
function looksComplementary(rows: string[][], a: number, b: number): boolean {
  if (a < 0 || b < 0 || a === b) return false
  let both = 0
  let either = 0
  for (const r of rows) {
    const x = parseMoney((r[a] ?? '').trim())
    const y = parseMoney((r[b] ?? '').trim())
    const hasX = x !== null && x !== 0
    const hasY = y !== null && y !== 0
    if (hasX || hasY) either++
    if (hasX && hasY) both++
  }
  return either > 0 && both / either < 0.2
}

/**
 * Does this signed column write money OUT as a positive?
 *
 * The headers cannot answer it — a card export and a bank export both call the
 * column "Amount" — so this is decided entirely by the shape of the data, and
 * the shape is unambiguous: a statement is mostly spending. On a bank account
 * that means mostly negatives with the occasional salary; on a card it means
 * mostly positives with the occasional payment clearing the balance.
 *
 * Both halves of the test are load-bearing. The clear majority is what stops a
 * quiet month on a current account flipping it, and requiring at least one
 * NEGATIVE is what keeps it off a file that is genuinely all inflows — a column
 * with no negative at all is step 4's case, not this one, which is why this
 * runs after it.
 *
 * It can still be wrong, and it is the one setting in the import that can
 * invert every figure in a statement, so the wizard always shows it as a
 * control with the preview underneath rather than only applying it.
 */
function looksInverted(rows: string[][], col: number): boolean {
  if (col < 0) return false
  let positive = 0
  let negative = 0
  for (const r of rows) {
    const v = parseMoney((r[col] ?? '').trim())
    if (v === null || v === 0) continue
    if (v > 0) positive++
    else negative++
  }
  const signed = positive + negative
  return negative > 0 && signed > 0 && positive / signed >= 0.7
}

/** Every column that is mostly numbers, in order. Used when the headers say nothing. */
function numericColumns(rows: string[][], width: number, skip: number[]): number[] {
  const out: number[] = []
  for (let c = 0; c < width; c++) {
    if (skip.includes(c)) continue
    if (numericShare(rows, c) > 0.8) out.push(c)
  }
  return out
}

/**
 * Guess which columns hold date / payee / amount, and which of the two amount
 * layouts the file uses.
 *
 * Headers are the first evidence and the data is the second, in that order but
 * with the data holding a veto. That matters because header matching alone got
 * two common exports wrong:
 *
 *   - "Debit Amount" / "Credit Amount" — the generic search for `amount` hit
 *     the DEBIT column and read it as a signed one, so every expense in the
 *     file imported as income;
 *   - anything with a "Running balance" column, where a substring search for
 *     `in` matched the balance and imported it as money received.
 *
 * Both now have to survive `looksComplementary`, which asks the rows rather
 * than the headings.
 */
export function guessMapping(csv: ParsedCSV): ColumnMapping {
  const { headers, rows } = csv
  const sample = rows.slice(0, 200)
  const width = Math.max(headers.length, ...rows.map((r) => r.length), 1)

  let date = findHeader(headers, ['date'])
  let payee = findHeader(headers, [
    'description', 'narrative', 'merchant', 'name', 'details', 'memo', 'payee', 'reference',
  ])
  if (date < 0) date = 0
  if (payee < 0) payee = Math.min(1, width - 1)

  // 1. A named out/in pair, confirmed against the rows.
  let out = matching(headers, OUT_HEADERS)
  let moneyIn = matching(headers, IN_HEADERS)
  let layout: AmountLayout = looksComplementary(sample, out, moneyIn) ? 'split' : 'signed'

  // 2. Failing that, a single signed column.
  if (layout === 'signed') {
    const named = findHeader(headers, ['amount', 'value'])
    out = named >= 0 && numericShare(sample, named) > 0.8 ? named : -1
    moneyIn = -1
  }

  // 3. Failing that, the data on its own — headerless exports, and files whose
  //    columns are named in a language nobody thought of.
  if (out < 0) {
    const numeric = numericColumns(sample, width, [date, payee])
    if (numeric.length >= 2 && looksComplementary(sample, numeric[0], numeric[1])) {
      layout = 'split'
      out = numeric[0]
      moneyIn = numeric[1]
    } else {
      out = numeric[numeric.length - 1] ?? width - 1
    }
  }

  // 4. A signed column with nothing negative in it is not a signed column. Some
  //    exports drop the minus and leave the direction to a column we have not
  //    matched, so rather than import a statement of pure income, look again
  //    for a partner column by shape alone.
  if (layout === 'signed' && out >= 0) {
    const anyNegative = sample.some((r) => {
      const v = parseMoney((r[out] ?? '').trim())
      return v !== null && v < 0
    })
    if (!anyNegative) {
      const partner = numericColumns(sample, width, [date, payee, out]).find((c) =>
        looksComplementary(sample, out, c),
      )
      if (partner !== undefined) {
        layout = 'split'
        moneyIn = partner
      }
    }
  }

  // 5. And which sign in that column means money out. A card statement is the
  //    same file as a bank statement with every sign the other way round, so
  //    this is asked of the rows once the column is settled — never before, and
  //    never under `split`, where the column a value is in has already said.
  const invert = layout === 'signed' && looksInverted(sample, out)

  return {
    date,
    payee,
    amount: out,
    moneyIn: layout === 'split' ? moneyIn : -1,
    layout,
    invert,
    dateFormat: guessDateFormat(sample.slice(0, 20).map((r) => r[date] ?? '')),
  }
}

export interface ImportRow {
  date: string // yyyy-MM-dd
  payee: string
  amountMinor: number
  valid: boolean
}

export function extractRows(csv: ParsedCSV, m: ColumnMapping): ImportRow[] {
  return csv.rows.map((r) => {
    const rawDate = (r[m.date] ?? '').trim()
    const d = parseDate(rawDate, m.dateFormat, new Date())
    const dateOK = isValid(d) && d.getFullYear() > 1990 && d.getFullYear() < 2100
    const payee = (r[m.payee] ?? '').trim()

    let amountMinor: number | null = null
    const out = parseMoney(r[m.amount] ?? '')

    if (m.layout === 'split') {
      const inn = m.moneyIn >= 0 ? parseMoney(r[m.moneyIn] ?? '') : null
      // The SIDE decides the sign, not the value. Most banks write both columns
      // positive, a few write the out column negative, and one file in ten
      // manages both — so whatever is in the money-out column becomes an
      // outflow and whatever is in money-in becomes an inflow.
      if (out !== null && out !== 0) amountMinor = -Math.abs(out)
      else if (inn !== null && inn !== 0) amountMinor = Math.abs(inn)
    } else {
      // The column carries the direction, and `invert` says which way round it
      // is written. Applied AFTER parsing, so parentheses still mean a negative
      // number and then get flipped like any other.
      amountMinor = out === null ? null : m.invert ? -out : out
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

/* ---------- writing it back out ---------- */

/**
 * A table as CSV text.
 *
 * Quoting is unconditional rather than "only where needed". Category names in
 * this app routinely contain a comma ("Home & utilities, shared") and payees
 * imported from a statement contain anything at all, so the interesting
 * question is never whether to quote but whether the escaping is right — and
 * one rule that is always applied is far easier to be sure of than two.
 *
 * CRLF, and a UTF-8 BOM on the download: Excel reads a plain UTF-8 CSV as
 * Latin-1 and turns every £ into Â£, which on a finance export is the first
 * thing anybody notices.
 */
export function toCSV(rows: (string | number)[][]): string {
  return rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n')
}

export function downloadCSV(filename: string, csv: string) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/** Minor units as a plain decimal — a spreadsheet wants 1234.56, not "£1,234.56". */
export const csvAmount = (minor: number) => (minor / 100).toFixed(2)

/* ---------- remembering a layout ---------- */

/**
 * A statement's shape, as a key.
 *
 * The HEADERS, not the account. One bank exports one format, and keying on the
 * format means the answer carries across accounts at the same bank and does not
 * carry across two banks that happen to share an account — which is the right
 * way round. It also means an export that changes its columns falls back to
 * guessing rather than silently reusing a mapping that no longer fits.
 */
export const mappingKey = (headers: string[]) =>
  `import-map:${headers.map((h) => h.trim().toLowerCase()).join('|')}`

/**
 * A remembered mapping, checked against the file in front of us.
 *
 * Validated rather than trusted: the column count has to match and every index
 * has to be in range. A stored mapping is device-local state that can outlive
 * the thing it describes, and applying a stale one would point "money in" at a
 * column that is now something else.
 */
export function readMapping(raw: string | undefined, csv: ParsedCSV): ColumnMapping | undefined {
  if (!raw) return undefined
  try {
    const m = JSON.parse(raw) as Partial<ColumnMapping> & { columns?: number }
    const width = csv.headers.length
    const inRange = (i: unknown) => typeof i === 'number' && i >= 0 && i < width
    if (m.columns !== width) return undefined
    if (!inRange(m.date) || !inRange(m.payee) || !inRange(m.amount)) return undefined
    if (m.layout !== 'signed' && m.layout !== 'split') return undefined
    if (m.layout === 'split' && !inRange(m.moneyIn)) return undefined
    if (typeof m.dateFormat !== 'string' || !m.dateFormat) return undefined
    return {
      date: m.date!,
      payee: m.payee!,
      amount: m.amount!,
      moneyIn: m.layout === 'split' ? m.moneyIn! : -1,
      layout: m.layout,
      // Defaulted rather than required: a mapping stored before this field
      // existed describes its columns perfectly well, and rejecting it would
      // send every bank the app has already learned back to guessing.
      invert: m.layout === 'signed' && m.invert === true,
      dateFormat: m.dateFormat,
    }
  } catch {
    return undefined
  }
}

export const writeMapping = (m: ColumnMapping, csv: ParsedCSV) =>
  JSON.stringify({ ...m, columns: csv.headers.length })
