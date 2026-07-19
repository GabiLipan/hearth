/**
 * Receipt scanning: OCR a photo with tesseract.js (loaded on demand — the
 * engine + language data come over the network on first use, then stay
 * cached), then pull out merchant, total and date to prefill the expense form.
 */

export interface ReceiptGuess {
  payee?: string
  amountMinor?: number
  date?: string
  rawText: string
}

const AMOUNT_RE = /(?:[£$€]\s?)?(\d{1,4}(?:,\d{3})*[.,]\d{2})\b/g
const TOTAL_HINT = /\b(total|amount due|to pay|balance due|grand total|card|paid)\b/i
const NOISE = /\b(vat|tax|tel|phone|www|http|receipt|invoice|order|table|server|cashier|reg|till|store)\b|^\d+$|^[\W\d\s]+$/i

function toMinor(m: string): number {
  return Math.round(Number(m.replace(/,/g, '').replace(/(\d)[.,](\d{2})$/, '$1.$2')) * 100)
}

export function parseReceiptText(text: string): ReceiptGuess {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  // Total: prefer amounts on lines with a "total"-ish word; else the largest.
  let amountMinor: number | undefined
  const hinted: number[] = []
  const all: number[] = []
  for (const line of lines) {
    for (const m of line.matchAll(AMOUNT_RE)) {
      const v = toMinor(m[1])
      if (v <= 0 || v > 100000_00) continue
      all.push(v)
      if (TOTAL_HINT.test(line)) hinted.push(v)
    }
  }
  if (hinted.length) amountMinor = Math.max(...hinted)
  else if (all.length) amountMinor = Math.max(...all)

  // Date: first parseable date anywhere.
  let date: string | undefined
  const dateMatch = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/)
  if (dateMatch) {
    const [, d, mo, y] = dateMatch
    const year = y.length === 2 ? 2000 + Number(y) : Number(y)
    const dt = new Date(year, Number(mo) - 1, Number(d))
    if (!Number.isNaN(dt.getTime()) && dt <= new Date() && year > 2000) {
      date = `${year}-${String(Number(mo)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`
    }
  }

  // Merchant: first plausible text line near the top.
  let payee: string | undefined
  for (const line of lines.slice(0, 6)) {
    const letters = line.replace(/[^A-Za-z]/g, '')
    if (letters.length >= 3 && line.length <= 40 && !NOISE.test(line) && !AMOUNT_RE.test(line)) {
      payee = line.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim()
      break
    }
    AMOUNT_RE.lastIndex = 0
  }

  return { payee, amountMinor, date, rawText: text }
}

export async function scanReceipt(file: File, onProgress?: (pct: number) => void): Promise<ReceiptGuess> {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && onProgress) onProgress(Math.round(m.progress * 100))
    },
  })
  try {
    const { data } = await worker.recognize(file)
    return parseReceiptText(data.text)
  } finally {
    await worker.terminate()
  }
}
