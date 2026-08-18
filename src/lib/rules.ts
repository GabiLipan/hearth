import { db, type Rule, type Transaction } from './db'
import { create, update } from './data'

/** Normalise a bank-statement payee for matching: lowercase, strip refs/numbers. */
export function normalizePayee(raw: string) {
  return raw
    .toLowerCase()
    .replace(/\b(card|ref|reference|payment|direct debit|standing order|visa|contactless)\b/g, ' ')
    .replace(/\b(dd|deb|so|bp|fpi|fpo|tfr|cpt|csh|bgc|chg|pos|chq|atm)\b/g, ' ') // bank type codes
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

/**
 * Are these two the same merchant?
 *
 * Lives here rather than in dedupe.ts, which is where it started: it is a fact
 * about payees, and three separate features now ask it (duplicate detection,
 * bulk recategorisation, transfer pairing). Keeping one definition is what makes
 * "looks like a duplicate" and "looks similar" agree on screen.
 */
export function payeeSimilar(a: string, b: string): boolean {
  const na = normalizePayee(a)
  const nb = normalizePayee(b)
  if (na.length < 3 || nb.length < 3) return false
  if (na === nb || na.includes(nb) || nb.includes(na)) return true
  const ta = na.split(' ')[0]
  const tb = nb.split(' ')[0]
  return ta.length >= 5 && ta === tb
}

/**
 * The longest rule matching this payee that satisfies `wants`.
 *
 * Longest match wins — "tesco petrol" beats "tesco" — and the predicate is not
 * a convenience. A rule may carry a category, a name, or both (migration 20),
 * so "the rule that matches" is genuinely two questions: asking once and
 * reading both fields off the answer would let a title-only rule for "tesco
 * petrol" shadow the category rule for "tesco", and the fuel would quietly
 * stop being filed anywhere.
 */
function bestMatch(payee: string, rules: Rule[], wants: (r: Rule) => boolean): Rule | undefined {
  const hay = normalizePayee(payee)
  let best: Rule | undefined
  for (const r of rules) {
    if (!wants(r)) continue
    if (hay.includes(r.match) && (!best || r.match.length > best.match.length)) best = r
  }
  return best
}

/** The rule that says where a payee is filed. */
export function categoryRule(payee: string, rules: Rule[]): Rule | undefined {
  return bestMatch(payee, rules, (r) => r.categoryId !== undefined)
}

/** The rule that says what a payee is called. */
export function titleRule(payee: string, rules: Rule[]): Rule | undefined {
  return bestMatch(payee, rules, (r) => cleanTitle(r.title) !== undefined)
}

/**
 * A name, as it will be stored: one line, trimmed, and short enough to sit in a
 * table cell. `undefined` for anything that is not a name, which is what clears
 * the column rather than leaving a blank string to render as an empty row.
 *
 * The ceiling mirrors `transactions_title_sane`/`rules_title_sane` server-side.
 * Truncating here rather than refusing: a name arrives by typing, and a form
 * that silently dead-letters at 81 characters is the failure mode this data
 * layer is most prone to.
 */
export const TITLE_MAX = 80
export function cleanTitle(raw: string | undefined | null): string | undefined {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, TITLE_MAX) : undefined
}

/**
 * What to show for a transaction: the name somebody gave it, else what the bank
 * wrote. Every list in the app reads rows through this rather than `t.payee` —
 * the payee is still the identity, and is still what matching, pairing and
 * de-duplication compare.
 */
export function displayName(t: { payee: string; title?: string }): string {
  return cleanTitle(t.title) ?? t.payee
}

/**
 * Learn what we know about a payee: where it is filed, what it is called, or
 * both. The normalised payee is the match key, and an existing rule for the
 * same key is UPDATED rather than replaced — learning a name must not forget a
 * category somebody chose, and the other way round.
 *
 * A rule that would say nothing is not written.
 */
export async function learnRule(payee: string, what: { categoryId?: string; title?: string }) {
  const match = normalizePayee(payee)
  if (match.length < 3) return
  const title = cleanTitle(what.title)
  const patch: { categoryId?: string; title?: string } = {}
  if (what.categoryId !== undefined) patch.categoryId = what.categoryId
  if (title !== undefined) patch.title = title
  if (patch.categoryId === undefined && patch.title === undefined) return

  const existing = await db.rules.where('match').equals(match).first()
  if (existing) {
    await update('rules', existing.id, patch)
  } else {
    // Written server-side by `upsert_rule`, so two devices learning the same
    // payee during a shared import converge on one rule rather than colliding
    // on the unique index. See RPC_WRITERS in outbox.ts.
    await create('rules', { match, ...patch, createdAt: new Date().toISOString() })
  }
}

/**
 * Builds a fuzzy payee→category matcher from transaction history. Matches when
 * either normalised name contains the other ("tesco" ⊂ "tesco stores london"),
 * preferring the longest known name; recent categorisations win ties.
 */
export function buildHistoryMatcher(txns: Transaction[]): (payee: string) => string | undefined {
  const entries = new Map<string, string>()
  const sorted = [...txns].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const t of sorted) {
    if (t.amountMinor >= 0 || !t.categoryId) continue
    const n = normalizePayee(t.payee)
    if (n.length >= 4) entries.set(n, t.categoryId)
  }
  const known = [...entries.keys()].sort((a, b) => b.length - a.length)
  // Leading token is usually the brand ("sainsburys local" → "sainsburys");
  // require ≥5 chars so generic short words don't cause false matches.
  const byFirstToken = new Map<string, string>()
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

/**
 * The same matcher, for names: what have past transactions from this payee been
 * called? Built from every row that carries one, whatever its sign — a name is
 * worth learning on income and on spending alike, which is the one place this
 * differs from `buildHistoryMatcher`.
 */
export function buildTitleMatcher(txns: Transaction[]): (payee: string) => string | undefined {
  const entries = new Map<string, string>()
  const sorted = [...txns].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const t of sorted) {
    const title = cleanTitle(t.title)
    if (!title) continue
    const n = normalizePayee(t.payee)
    if (n.length >= 4) entries.set(n, title)
  }
  const known = [...entries.keys()].sort((a, b) => b.length - a.length)
  const byFirstToken = new Map<string, string>()
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
export async function suggestCategory(payee: string): Promise<string | undefined> {
  const rules = await db.rules.toArray()
  const rule = categoryRule(payee, rules)
  if (rule?.categoryId) return rule.categoryId
  const txns = await db.transactions.toArray()
  return buildHistoryMatcher(txns)(payee)
}

/** Suggest a name for a payee from rules, else fuzzily from what past rows were called. */
export async function suggestTitle(payee: string): Promise<string | undefined> {
  const rules = await db.rules.toArray()
  const rule = titleRule(payee, rules)
  if (rule) return cleanTitle(rule.title)
  const txns = await db.transactions.toArray()
  return buildTitleMatcher(txns)(payee)
}

/* ---------- applying a rule to history ---------- */
//
// A rule learned from one transaction only ever affected the NEXT one. Everything
// already in the account kept whatever category it was imported with, so
// categorising one "PETS AT HOME INS" left eleven months of them sitting under
// "Other" with no way to fix them but one at a time.
//
// Two things are needed for that, and they are deliberately different questions:
//
//   coverageOf  — which transactions does this rule speak for? Asked of an
//                 existing rule, on the rules page.
//   similarTo   — which transactions look like the one I just categorised?
//                 Asked at the moment of categorising, when the rule has only
//                 just been learned and the payee is all we have.

/** A transaction is eligible to be recategorised in bulk. */
function recategorisable(t: Transaction): boolean {
  // Income is not what rules are learned from (see learnRule's callers), and a
  // transfer is neither spending nor income — giving either a category from a
  // payee rule would be wrong rather than merely unhelpful.
  return t.amountMinor < 0 && t.transferId == null
}

export interface RuleCoverage {
  /** Every transaction this rule is the winning match for. */
  all: Transaction[]
  /** Those it would actually change — currently a different category, or none. */
  changed: Transaction[]
}

/**
 * What a rule covers.
 *
 * Note that this asks `matchRule` rather than testing `match` on its own, so it
 * inherits longest-match-wins: applying the "tesco" rule does not reach into
 * the transactions the "tesco petrol" rule owns. Testing the substring directly
 * would make bulk-applying a general rule quietly undo a specific one — and the
 * preview would have shown you the right count while doing it.
 */
export function coverageOf(rule: Rule, txns: Transaction[], rules: Rule[]): RuleCoverage {
  // A rule that only says what to call a payee covers nothing here: applying a
  // rule rewrites `category_id` and nothing else. Naming past rows is
  // `applyTitle`, and it is asked separately because it answers a different
  // question about a different set of rows.
  if (!rule.categoryId) return { all: [], changed: [] }
  const all = txns.filter((t) => recategorisable(t) && categoryRule(t.payee, rules)?.id === rule.id)
  return { all, changed: all.filter((t) => t.categoryId !== rule.categoryId) }
}

/**
 * Transactions that look like this one, by payee.
 *
 * Used the instant a category is chosen by hand, to offer "and the other nine".
 * `payeeSimilar` rather than an exact normalised match, because a statement
 * writes the same merchant a dozen ways — it is the same comparison the
 * duplicate check uses, so the two screens agree about what "similar" means.
 */
export function similarTo(
  payee: string,
  categoryId: string,
  txns: Transaction[],
  exceptId?: string,
): Transaction[] {
  return txns.filter(
    (t) =>
      t.id !== exceptId &&
      recategorisable(t) &&
      t.categoryId !== categoryId &&
      payeeSimilar(t.payee, payee),
  )
}

/**
 * Recategorise transactions, skipping any the server would refuse.
 *
 * `canEdit` is not optional and has no default. At `contribute` you may change
 * only what you added, and a bulk update is the easiest possible way to queue
 * fifty writes that each dead-letter a minute later in Settings — the failure
 * mode this data layer is most prone to, since writes fail late and quietly.
 * Callers build the predicate from `canEditTransaction`, so this mirrors
 * `transactions_update` rather than guessing.
 *
 * Returns what it actually changed and what it had to leave, so the UI can say
 * "18 updated, 3 are Sam's" instead of silently doing less than it claimed.
 */
export async function applyCategory(
  txns: Transaction[],
  categoryId: string,
  canEdit: (t: Transaction) => boolean,
): Promise<{ updated: number; skipped: number }> {
  let updated = 0
  let skipped = 0
  for (const t of txns) {
    if (!canEdit(t)) {
      skipped++
      continue
    }
    await update('transactions', t.id, { categoryId })
    updated++
  }
  return { updated, skipped }
}

/* ---------- the same two questions, for a name ---------- */

/**
 * Transactions from this payee that are not called this already.
 *
 * The twin of `similarTo`, and deliberately the same matcher, so "and the other
 * nine" means the same set of rows whichever of the two offers it. Unlike
 * `similarTo` it does NOT filter to spending: a name is worth having on income
 * and on a transfer leg too, which is exactly where a bank string is least
 * readable ("FPI SMITH J LTD REF 88213").
 */
export function unnamedLike(
  payee: string,
  title: string,
  txns: Transaction[],
  exceptId?: string,
): Transaction[] {
  const want = cleanTitle(title)
  if (!want) return []
  return txns.filter(
    (t) => t.id !== exceptId && cleanTitle(t.title) !== want && payeeSimilar(t.payee, payee),
  )
}

/**
 * Give transactions a name, skipping any the server would refuse.
 *
 * `canEdit` is not optional and has no default, for the reason `applyCategory`
 * gives: at `contribute` you may change only what you added, and writes fail
 * late and quietly. Returns what it changed and what it left, so the screen can
 * say so rather than silently doing less than the button promised.
 */
export async function applyTitle(
  txns: Transaction[],
  title: string,
  canEdit: (t: Transaction) => boolean,
): Promise<{ updated: number; skipped: number }> {
  const clean = cleanTitle(title)
  if (!clean) return { updated: 0, skipped: 0 }
  let updated = 0
  let skipped = 0
  for (const t of txns) {
    if (!canEdit(t)) {
      skipped++
      continue
    }
    await update('transactions', t.id, { title: clean })
    updated++
  }
  return { updated, skipped }
}
