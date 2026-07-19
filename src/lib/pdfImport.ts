import { parse as parseDate, isValid, format, subYears } from 'date-fns'
import type { ImportRow } from './csv'

/**
 * Extract transactions from a text-based bank-statement PDF.
 * Approach: pull positioned text via pdf.js, rebuild visual lines by
 * y-coordinate, then treat every line that starts with a date as a
 * transaction: date · description · trailing amount(s). When a trailing
 * balance column exists, consecutive balance deltas give reliable signs.
 * (Scanned/image PDFs have no text layer — those need the receipt scanner.)
 */
export async function extractRowsFromPDF(file: File): Promise<ImportRow[]> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  const lines: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const byY = new Map<number, { x: number; str: string }[]>()
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const y = Math.round(item.transform[5] / 3) * 3 // cluster near-equal baselines
      if (!byY.has(y)) byY.set(y, [])
      byY.get(y)!.push({ x: item.transform[4], str: item.str })
    }
    const ys = [...byY.keys()].sort((a, b) => b - a) // top of page first
    for (const y of ys) {
      const parts = byY.get(y)!.sort((a, b) => a.x - b.x)
      lines.push(parts.map((s) => s.str).join('  ').replace(/\s+/g, ' ').trim())
    }
  }
  await doc.cleanup()
  return parseStatementLines(lines)
}

const AMOUNT_RE = /(?:[£$€]\s?)?[-+]?\(?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?:\s?(?:CR|DR))?/gi
const DATE_FORMATS = ['dd/MM/yyyy', 'dd/MM/yy', 'dd-MM-yyyy', 'dd.MM.yyyy', 'yyyy-MM-dd', 'dd MMM yyyy', 'd MMM yyyy', 'dd MMM yy', 'd MMM yy', 'dd MMMM yyyy', 'd MMMM yyyy']
/** Bank transaction-type column codes that leak into descriptions. */
const TYPE_CODES = /\b(DD|DEB|SO|BP|FPI|FPO|TFR|CPT|CSH|BGC|CHG|POS|CHQ|ATM)\b/g

interface Parsed {
  date: string
  payee: string
  amounts: number[] // trailing numeric columns, sign as printed
  credit: boolean // explicit CR / + marker
}

function parseLeadingDate(line: string): { date: string; rest: string } | null {
  // Full dates first — crucially including 2-digit years ("01 Jul 26"), which
  // must win over the no-year form so the year isn't swallowed into the payee.
  const token = line.match(/^(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2} [A-Za-z]{3,9} \d{2,4})\b/)
  if (token) {
    for (const f of DATE_FORMATS) {
      const d = parseDate(token[1], f, new Date())
      if (isValid(d) && d.getFullYear() > 1990 && d.getFullYear() < 2100) {
        return { date: format(d, 'yyyy-MM-dd'), rest: line.slice(token[0].length).trim() }
      }
    }
  }
  // "12 Mar" without any year (also common on UK statements)
  const noYear = line.match(/^(\d{1,2} [A-Za-z]{3})\b/)
  if (noYear) {
    const now = new Date()
    let d = parseDate(`${noYear[1]} ${now.getFullYear()}`, 'd MMM yyyy', now)
    if (isValid(d)) {
      if (d > now) d = subYears(d, 1) // statement dates are in the past
      return { date: format(d, 'yyyy-MM-dd'), rest: line.slice(noYear[0].length).trim() }
    }
  }
  return null
}

function parseMoneyToken(tok: string): number {
  const negative = /^\(|-|\bDR\b/i.test(tok)
  const n = Number(tok.replace(/[£$€,()\s]|CR|DR|\+|-/gi, ''))
  return Math.round(n * 100) * (negative ? -1 : 1)
}

export function parseStatementLines(lines: string[]): ImportRow[] {
  const parsed: Parsed[] = []
  for (const line of lines) {
    const lead = parseLeadingDate(line)
    if (!lead) continue
    const matches = [...lead.rest.matchAll(AMOUNT_RE)].filter((m) => m[0].trim())
    if (matches.length === 0) continue
    // Amounts must sit at the end of the line to be column values.
    const tail = matches.slice(-2)
    const firstTail = tail[0]
    // Strip type-column codes and keep only tokens with real content, which
    // drops the stray dots and rules that table layouts leave behind.
    const payee = lead.rest
      .slice(0, firstTail.index)
      .replace(TYPE_CODES, ' ')
      .replace(/[|·•]+/g, ' ')
      .split(/\s+/)
      .filter((tok) => /[A-Za-z0-9]/.test(tok))
      .join(' ')
      .trim()
    if (payee.length < 2) continue
    parsed.push({
      date: lead.date,
      payee,
      amounts: tail.map((m) => parseMoneyToken(m[0])),
      credit: /\bCR\b|\+/.test(tail[0][0]),
    })
  }
  if (parsed.length === 0) return []

  // If most lines carry two trailing numbers, the last is a running balance:
  // its delta between consecutive lines fixes each transaction's sign.
  const withBalance = parsed.filter((p) => p.amounts.length === 2).length
  const useBalance = withBalance >= parsed.length * 0.7 && parsed.length > 1
  const anyExplicitSign = parsed.some((p) => p.amounts[0] < 0 || p.credit)

  return parsed.map((p, i) => {
    const amount = p.amounts[0]
    let signed = amount
    if (useBalance && i > 0 && p.amounts.length === 2 && parsed[i - 1].amounts.length === 2) {
      const delta = p.amounts[1] - parsed[i - 1].amounts[1]
      if (Math.abs(Math.abs(delta) - Math.abs(amount)) <= 2) signed = Math.abs(amount) * Math.sign(delta || 1)
      else signed = p.credit ? Math.abs(amount) : -Math.abs(amount)
    } else if (amount < 0) {
      signed = amount
    } else if (p.credit) {
      signed = Math.abs(amount)
    } else if (!anyExplicitSign) {
      // No sign information anywhere: statements list spending as positive.
      signed = -Math.abs(amount)
    }
    return { date: p.date, payee: p.payee, amountMinor: signed, valid: signed !== 0 }
  })
}
