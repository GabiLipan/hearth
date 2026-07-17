import { db, type Rule, type Transaction } from './db'

/** Normalise a bank-statement payee for matching: lowercase, strip refs/numbers. */
export function normalizePayee(raw: string) {
  return raw
    .toLowerCase()
    .replace(/\b(card|ref|reference|payment|direct debit|dd|so|standing order|visa|contactless)\b/g, ' ')
    .replace(/[*#]/g, ' ')
    .replace(/\d{4,}/g, ' ') // long numbers are refs, not identity
    .replace(/\s+/g, ' ')
    .trim()
}

/** Tidy a payee for display: title-case the normalised form. */
export function prettyPayee(raw: string) {
  const n = normalizePayee(raw)
  if (!n) return raw.trim()
  return n.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function matchRule(payee: string, rules: Rule[]): Rule | undefined {
  const hay = normalizePayee(payee)
  // Longest match wins — "tesco petrol" beats "tesco".
  let best: Rule | undefined
  for (const r of rules) {
    if (hay.includes(r.match) && (!best || r.match.length > best.match.length)) best = r
  }
  return best
}

/**
 * Learn a rule from a manual categorisation. Uses the normalised payee as the
 * match key; replaces any existing rule with the same key.
 */
export async function learnRule(payee: string, categoryId: number) {
  const match = normalizePayee(payee)
  if (match.length < 3) return
  const existing = await db.rules.filter((r) => r.match === match).first()
  if (existing) {
    await db.rules.update(existing.id!, { categoryId })
  } else {
    await db.rules.add({ match, categoryId, createdAt: Date.now() })
  }
}

/**
 * Builds a fuzzy payee→category matcher from transaction history. Matches when
 * either normalised name contains the other ("tesco" ⊂ "tesco stores london"),
 * preferring the longest known name; recent categorisations win ties.
 */
export function buildHistoryMatcher(txns: Transaction[]): (payee: string) => number | undefined {
  const entries = new Map<string, number>()
  const sorted = [...txns].sort((a, b) => a.createdAt - b.createdAt)
  for (const t of sorted) {
    if (t.amountMinor >= 0) continue
    const n = normalizePayee(t.payee)
    if (n.length >= 4) entries.set(n, t.categoryId)
  }
  const known = [...entries.keys()].sort((a, b) => b.length - a.length)
  // Leading token is usually the brand ("sainsburys local" → "sainsburys");
  // require ≥5 chars so generic short words don't cause false matches.
  const byFirstToken = new Map<string, number>()
  for (const n of known) {
    const tok = n.split(' ')[0]
    if (tok.length >= 5 && !byFirstToken.has(tok)) byFirstToken.set(tok, entries.get(n)!)
  }
  return (payee: string) => {
    const hay = normalizePayee(payee)
    if (hay.length < 4) return undefined
    if (entries.has(hay)) return entries.get(hay)
    for (const n of known) {
      if (hay.includes(n) || n.includes(hay)) return entries.get(n)
    }
    return byFirstToken.get(hay.split(' ')[0])
  }
}

/** Suggest a category for a payee from rules, else fuzzily from past transactions. */
export async function suggestCategory(payee: string): Promise<number | undefined> {
  const rules = await db.rules.toArray()
  const rule = matchRule(payee, rules)
  if (rule) return rule.categoryId
  const txns = await db.transactions.toArray()
  return buildHistoryMatcher(txns)(payee)
}
