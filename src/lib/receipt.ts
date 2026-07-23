/**
 * Receipt scanning: OCR a photo with PaddleOCR's PP-OCRv5 models running
 * on-device via ONNX Runtime Web (loaded on demand — the models come over the
 * network on first use, then stay cached, and the photo never leaves the
 * device), then pull out merchant, total and date to prefill the expense form.
 *
 * The merchant line is still snapped to a known name — the user's own payee
 * history first, then common UK chains — so any OCR wobble ("SCREWEIX") lands
 * on the same canonical name every time.
 */

import type { PaddleOcrService as PaddleOcrServiceType } from 'ppu-paddle-ocr/web'

export interface ReceiptGuess {
  payee?: string
  amountMinor?: number
  date?: string
  rawText: string
}

const AMOUNT_RE = /(?:[£$€]\s?)?(\d{1,4}(?:,\d{3})*[.,]\d{2})\b/g
const TOTAL_HINT = /\b(total|amount due|to pay|balance due|grand total)\b/i
const AMOUNT_EXCLUDE = /\b(vat|net|gross|change|cashback|rate|tax|subtotal excl)\b/i
const NOISE =
  /\b(vat|tax|tel|phone|www|http|receipt|invoice|order|table|server|cashier|reg|till|store|unit|street|road|avenue|lane|park|centre|center|opening|hours|mon|tue|wed|thu|fri|sat|sun|am|pm|welcome|thank)\b|\b[a-z]{1,2}\d{1,2}[a-z]?\s*\d[a-z]{2}\b|^\d+$|^[\W\d\s]+$/i

const COMMON_MERCHANTS = [
  'Screwfix', 'Tesco', 'Sainsburys', 'Asda', 'Morrisons', 'Aldi', 'Lidl', 'Waitrose', 'Iceland', 'Co-op', 'Spar',
  'Marks & Spencer', 'Boots', 'Superdrug', 'B&Q', 'Wickes', 'Homebase', 'Ikea', 'Argos', 'Currys', 'John Lewis',
  'Next', 'Primark', 'TK Maxx', 'Home Bargains', 'B&M', 'Poundland', 'The Range', 'Dunelm', 'Costa Coffee',
  'Starbucks', 'Caffe Nero', 'Pret A Manger', 'Greggs', 'McDonalds', 'KFC', 'Burger King', 'Subway', 'Nandos',
  'Pizza Express', 'Pizza Hut', 'Dominos', 'Wagamama', 'Five Guys', 'Shell', 'BP', 'Esso', 'Texaco', 'Halfords',
  'Pets At Home', 'Decathlon', 'Sports Direct', 'JD Sports', 'H&M', 'Zara', 'Uniqlo', 'WH Smith', 'Waterstones',
  'Post Office', 'Deliveroo', 'Just Eat', 'Uber Eats', 'Toolstation', 'Selco', 'Travis Perkins', 'Jewson',
]

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9&]/g, '')

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = tmp
    }
  }
  return prev[b.length]
}

/** Edit-distance budget by name length: short brand names must match exactly. */
const tolerance = (len: number) => (len >= 8 ? 2 : len >= 5 ? 1 : 0)

/**
 * Score how well an OCR line matches a known merchant name (lower = better,
 * undefined = no match). Matches the whole line and individual words/word
 * pairs, so "SCREWEIX" ≈ Screwfix and "Screwfix Direct Ltd" both hit — but
 * "Spar" can no longer hide inside "Spiersbridge Business Park".
 */
function matchScore(line: string, cand: string): number | undefined {
  const c = alnum(cand)
  const target = alnum(line)
  if (c.length < 3 || target.length < 3) return undefined
  if (target === c) return 0
  const ratio = Math.min(target.length, c.length) / Math.max(target.length, c.length)
  if (c.length >= 5 && ratio >= 0.5 && (target.includes(c) || c.includes(target))) return 0.5
  if (ratio >= 0.6) {
    const d = levenshtein(target, c)
    if (d <= tolerance(Math.min(target.length, c.length))) return 1 + d
  }
  const words = line.toLowerCase().split(/[^a-z0-9&]+/).filter((w) => w.length >= 3)
  const units = [...words]
  for (let i = 0; i < words.length - 1; i++) units.push(words[i] + words[i + 1])
  for (const w of units) {
    if (w === c) return 0.6
    if (c.length >= 5) {
      const d = levenshtein(w, c)
      if (d <= tolerance(Math.min(w.length, c.length))) return 1.2 + d
    }
  }
  return undefined
}

/** Find the best known-merchant match anywhere on the receipt. */
function snapToKnown(lines: string[], known: string[]): string | undefined {
  for (const line of lines.slice(0, 40)) {
    let best: string | undefined
    let bestScore = Infinity
    for (const cand of known) {
      const score = matchScore(line, cand)
      if (score !== undefined && score < bestScore) {
        bestScore = score
        best = cand
      }
    }
    if (best) return best
  }
  return undefined
}

function toMinor(m: string): number {
  return Math.round(Number(m.replace(/,/g, '').replace(/(\d)[.,](\d{2})$/, '$1.$2')) * 100)
}

export function parseReceiptText(text: string, knownPayees: string[] = []): ReceiptGuess {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  // --- Total ---
  // Preference order: amounts on "total"-ish lines; then the amount that
  // repeats most often (totals reappear in payment/card sections); then max.
  const hinted: number[] = []
  const freq = new Map<number, number>()
  for (const line of lines) {
    if (AMOUNT_EXCLUDE.test(line) && !TOTAL_HINT.test(line)) continue
    for (const m of line.matchAll(AMOUNT_RE)) {
      const v = toMinor(m[1])
      if (v <= 0 || v > 100000_00) continue
      freq.set(v, (freq.get(v) ?? 0) + 1)
      if (TOTAL_HINT.test(line)) hinted.push(v)
    }
  }
  let amountMinor: number | undefined
  if (hinted.length) {
    amountMinor = Math.max(...hinted)
  } else if (freq.size) {
    const maxFreq = Math.max(...freq.values())
    const pool = [...freq.entries()].filter(([, n]) => n === maxFreq).map(([v]) => v)
    amountMinor = Math.max(...pool)
  }

  // --- Date ---
  let date: string | undefined
  const dateMatch = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/)
  if (dateMatch) {
    const [, d, mo, y] = dateMatch
    const year = y.length === 2 ? 2000 + Number(y) : Number(y)
    const dt = new Date(year, Number(mo) - 1, Number(d))
    if (!Number.isNaN(dt.getTime()) && dt <= new Date() && year > 2000 && Number(mo) <= 12 && Number(d) <= 31) {
      date = `${year}-${String(Number(mo)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`
    }
  }

  // --- Merchant ---
  // Try snapping to a known name first (user history, then common chains);
  // only if nothing snaps anywhere, fall back to the first plausible line.
  const known = [...knownPayees, ...COMMON_MERCHANTS]
  let payee = snapToKnown(lines, known)
  if (!payee) {
    for (const line of lines.slice(0, 6)) {
      AMOUNT_RE.lastIndex = 0
      const letters = line.replace(/[^A-Za-z]/g, '')
      if (letters.length >= 3 && line.length <= 40 && !NOISE.test(line) && !AMOUNT_RE.test(line)) {
        payee = line.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim()
        break
      }
    }
  }

  return { payee, amountMinor, date, rawText: text }
}

/* ---------- OCR engine (PaddleOCR PP-OCRv5, on-device via ONNX Runtime) ---------- */

// The English PP-OCRv5 models, served from our own origin (see public/models).
// They download once (~12 MB), then the service worker keeps them cached so
// scanning works offline afterwards.
const MODEL_URLS = {
  detection: `${import.meta.env.BASE_URL}models/PP-OCRv5_mobile_det_infer.ort`,
  recognition: `${import.meta.env.BASE_URL}models/en_PP-OCRv5_mobile_rec_infer.ort`,
  charactersDictionary: `${import.meta.env.BASE_URL}models/ppocrv5_en_dict.txt`,
}
// Rough combined size of the two model files, for the first-run progress bar.
const MODEL_BYTES = 12.3 * 1024 * 1024

let servicePromise: Promise<PaddleOcrServiceType> | null = null

/** Fetch a URL to an ArrayBuffer, reporting each chunk of bytes as it streams in. */
async function fetchBuffer(url: string, onChunk: (delta: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`)
  if (!res.body) return res.arrayBuffer()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onChunk(value.length)
  }
  const out = new Uint8Array(received)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out.buffer
}

/** Build the OCR service once, streaming the models in with progress on first use. */
function getService(onProgress?: (pct: number) => void): Promise<PaddleOcrServiceType> {
  if (!servicePromise) {
    servicePromise = (async () => {
      const { PaddleOcrService } = await import('ppu-paddle-ocr/web')
      let received = 0
      const onChunk = (delta: number) => {
        received += delta
        onProgress?.(Math.min(85, Math.round((received / MODEL_BYTES) * 85)))
      }
      const [detection, recognition] = await Promise.all([
        fetchBuffer(MODEL_URLS.detection, onChunk),
        fetchBuffer(MODEL_URLS.recognition, onChunk),
      ])
      const service = new PaddleOcrService({
        model: { detection, recognition, charactersDictionary: MODEL_URLS.charactersDictionary },
      })
      await service.initialize()
      return service
    })()
    // A failed download (e.g. first use while offline) shouldn't poison the
    // singleton — clear it so the next attempt can retry.
    servicePromise.catch(() => {
      servicePromise = null
    })
  }
  return servicePromise
}

/** Orientation-fix and size a photo into a colour canvas for the detector. */
async function fileToCanvas(file: File, maxSide = 1600): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return canvas
}

export async function scanReceipt(
  file: File,
  onProgress?: (pct: number) => void,
  knownPayees: string[] = [],
): Promise<ReceiptGuess> {
  const [service, canvas] = await Promise.all([getService(onProgress), fileToCanvas(file)])
  onProgress?.(90)
  const result = await service.recognize(canvas)
  onProgress?.(100)
  return parseReceiptText(result.text, knownPayees)
}
