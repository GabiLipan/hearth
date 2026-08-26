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
 * What a rule is asked about.
 *
 * A rule used to be a question about a string, so `payee` was the whole
 * argument. Migration 21 lets one ALSO require an amount or an account, so the
 * question is now about a transaction — and the two extra fields are optional
 * because two callers genuinely do not have them: the "what will this be
 * called" preview in the transaction form runs while the amount box is still
 * empty, and a rule keyed on an amount must simply not match yet rather than
 * matching on the payee alone.
 */
export interface RuleTarget {
  payee: string
  amountMinor?: number
  accountId?: string
  /**
   * Which SORT of row this is — money out or money in.
   *
   * A rule may now carry an income category ("FPI SMITH J LTD" → Salary), and a
   * category may only ever file a row of its own kind: a Tesco rule must not
   * land on a Tesco refund, and a Salary rule must not land on a payment to the
   * same employer. This is what makes that answerable.
   *
   * It is stated rather than read off `amountMinor`, because the amount is a
   * MAGNITUDE here — the transaction form holds it unsigned and asks with the
   * sign in a control beside it, so inferring the sign from it would call every
   * salary an expense. Undefined means "not known", and then no rule is refused
   * on these grounds: the caller has said nothing, so nothing is concluded.
   */
  kind?: CategoryKind
}

/** Which sort a category files: spending is negative, everything else is in. */
export type CategoryKind = 'expense' | 'income'

/** What a row's own sign makes it. Transfers are neither and never asked. */
export const kindOfAmount = (amountMinor: number): CategoryKind =>
  amountMinor < 0 ? 'expense' : 'income'

/**
 * What kind a category is, asked of the caller.
 *
 * A rule stores a category id and nothing about it, so every question of the
 * form "may this rule file this row" needs the categories to hand. Passed in
 * rather than read from the cache, because the two screens that ask already
 * hold them and a second read would be a second answer.
 */
export type KindOf = (categoryId: string) => CategoryKind | undefined

/**
 * How many things beyond the payee this rule insists on.
 *
 * Specificity, and it beats the length of the match. "tesco petrol" is a longer
 * string than "tesco", but "tesco, exactly £8.99" is a narrower claim than
 * either — it describes one charge rather than a merchant — so a rule carrying
 * a condition wins over one that does not, and length decides between rules
 * carrying the same number.
 */
function conditionCount(r: Rule): number {
  return (
    (r.amountMinMinor !== undefined || r.amountMaxMinor !== undefined ? 1 : 0) +
    (r.accountId !== undefined ? 1 : 0)
  )
}

/**
 * Does this rule's conditions hold for this transaction?
 *
 * The payee test is `includes` on the normalised form, exactly as before. The
 * amounts are MAGNITUDES — `abs`, because spending is stored negative and
 * nobody thinks of a subscription as costing minus eight ninety-nine — and both
 * bounds are inclusive, so an exact amount is the two set equal.
 *
 * A rule with an amount condition asked about a target with no amount does not
 * match. That is the honest answer rather than a lenient one: the condition is
 * unsatisfied, not absent, and answering "probably" here would file a row on
 * the strength of a rule that has not been shown to apply to it.
 */
export function ruleMatches(rule: Rule, target: RuleTarget): boolean {
  if (!normalizePayee(target.payee).includes(rule.match)) return false
  if (rule.accountId !== undefined && rule.accountId !== target.accountId) return false
  if (rule.amountMinMinor !== undefined || rule.amountMaxMinor !== undefined) {
    if (target.amountMinor === undefined) return false
    const magnitude = Math.abs(target.amountMinor)
    if (rule.amountMinMinor !== undefined && magnitude < rule.amountMinMinor) return false
    if (rule.amountMaxMinor !== undefined && magnitude > rule.amountMaxMinor) return false
  }
  return true
}

/**
 * The most specific rule matching this transaction that satisfies `wants`.
 *
 * Most conditions first, then longest match — see `conditionCount`. The
 * predicate is not a convenience: a rule may carry a category, a name, or both
 * (migration 20), so "the rule that matches" is genuinely two questions.
 * Asking once and reading both fields off the answer would let a title-only
 * rule for "tesco petrol" shadow the category rule for "tesco", and the fuel
 * would quietly stop being filed anywhere.
 */
function bestMatch(target: RuleTarget, rules: Rule[], wants: (r: Rule) => boolean): Rule | undefined {
  let best: Rule | undefined
  for (const r of rules) {
    if (!wants(r) || !ruleMatches(r, target)) continue
    if (!best || moreSpecific(r, best)) best = r
  }
  return best
}

/** Strictly narrower than `b`: more conditions, or the same number and a longer match. */
function moreSpecific(a: Rule, b: Rule): boolean {
  const ca = conditionCount(a)
  const cb = conditionCount(b)
  return ca !== cb ? ca > cb : a.match.length > b.match.length
}

/**
 * The rule that says where a transaction is filed.
 *
 * `kindOf` is required rather than optional, and that is deliberate: since
 * rules may carry income categories, a caller that does not check the kind
 * files a refund under Groceries and a salary under whatever the employer's
 * name last matched. An omitted argument would make that the silent default —
 * the same reasoning `effectiveMonth` uses for taking the month rule.
 *
 * A rule whose category is the wrong sort for this row is SKIPPED rather than
 * ending the search, so a general rule of the right kind can still win: with
 * "amazon → Shopping" and "amazon → Refunds" both on file, each sign takes the
 * one that speaks for it.
 */
export function categoryRule(target: RuleTarget, rules: Rule[], kindOf: KindOf): Rule | undefined {
  return bestMatch(target, rules, (r) => {
    if (r.categoryId === undefined) return false
    // Nothing said about this row's sort, so nothing refused on it.
    if (target.kind === undefined) return true
    const kind = kindOf(r.categoryId)
    // A category this device cannot see is not evidence of anything, and
    // refusing on it would make a rule stop working while the cache filled.
    return kind === undefined || kind === target.kind
  })
}

/** The rule that says what a transaction is called. */
export function titleRule(target: RuleTarget, rules: Rule[]): Rule | undefined {
  return bestMatch(target, rules, (r) => cleanTitle(r.title) !== undefined)
}

/**
 * The conditions a rule carries, as a sentence.
 *
 * One phrasing, shared by the rules table, the phone's list and the preview
 * sheet, so a rule reads the same wherever it is shown — a rule the user cannot
 * read is a rule they cannot tell from the one beside it, which is the whole
 * problem two rules for one payee create.
 */
export function conditionWords(
  rule: Rule,
  money: (minor: number) => string,
  accountName?: (id: string) => string | undefined,
): string[] {
  const words: string[] = []
  const { amountMinMinor: lo, amountMaxMinor: hi } = rule
  if (lo !== undefined && hi !== undefined) {
    words.push(lo === hi ? `exactly ${money(lo)}` : `${money(lo)} to ${money(hi)}`)
  } else if (lo !== undefined) {
    words.push(`${money(lo)} or more`)
  } else if (hi !== undefined) {
    words.push(`up to ${money(hi)}`)
  }
  if (rule.accountId) words.push(`on ${accountName?.(rule.accountId) ?? 'one account'}`)
  return words
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
 *
 * A row added by hand may have no payee at all — nobody types "SQ *THE GOOD
 * FORK 3241" from memory, and the reference arrives later, when a statement is
 * imported and matched against it. So the fallback has a fallback.
 */
export function displayName(t: { payee: string; title?: string }): string {
  return cleanTitle(t.title) ?? (t.payee.trim() || 'No description')
}

/**
 * The bank's own words, where they are not already what is on screen.
 *
 * `undefined` on a row nobody has named (the payee IS the name there, and
 * printing it twice is noise) and on one with no reference yet. Everything that
 * shows a transaction shows `displayName` and then this, muted — see
 * `components/TxnName.tsx`, which is how the two stay in step.
 */
export function reference(t: { payee: string; title?: string }): string | undefined {
  if (!cleanTitle(t.title)) return undefined
  return t.payee.trim() || undefined
}

/**
 * The string a rule is keyed on for this row.
 *
 * The payee, because that is what a statement will say next month — but a row
 * added by hand may not have one, and there the name is the only identity
 * there is. Learning "Dinner out → Eating out" off a manual entry is worth
 * having; it simply cannot match an imported bank string, which is correct.
 */
export function matchKey(t: { payee?: string; title?: string }): string {
  return (t.payee ?? '').trim() || cleanTitle(t.title) || ''
}

/**
 * Learn what we know about a transaction: where it is filed, what it is called,
 * or both. The normalised payee is the match key, and an existing rule for the
 * same key is UPDATED rather than replaced — learning a name must not forget a
 * category somebody chose, and the other way round.
 *
 * ## Which rule, now that a payee can have several
 *
 * Since migration 21 one payee may be covered by more than one rule — "vendor
 * a" and "vendor a, exactly £8.99" — so "the rule for this payee" is no longer
 * a lookup on `match` alone. Categorising the £8.99 charge has to teach the
 * rule that actually speaks for it, or the specific rule would go on saying
 * something nobody agrees with while the general one was quietly corrected.
 *
 * So: among the rules keyed on exactly this payee, take the most specific one
 * whose conditions this transaction satisfies, and update that. If none does,
 * write a new rule with no conditions — the general case, which is what
 * learning from a row has always meant.
 *
 * A rule that would say nothing is not written.
 */
export async function learnRule(target: RuleTarget | string, what: { categoryId?: string; title?: string }) {
  // A bare payee is still accepted: three callers learn from a row whose amount
  // is not the point, and a target with no amount matches only unconditional
  // rules, which is exactly the old behaviour.
  const t: RuleTarget = typeof target === 'string' ? { payee: target } : target
  const match = normalizePayee(t.payee)
  if (match.length < 3) return
  const title = cleanTitle(what.title)
  const patch: { categoryId?: string; title?: string } = {}
  if (what.categoryId !== undefined) patch.categoryId = what.categoryId
  if (title !== undefined) patch.title = title
  if (patch.categoryId === undefined && patch.title === undefined) return

  const sameKey = await db.rules.where('match').equals(match).toArray()
  let existing: Rule | undefined
  for (const r of sameKey) {
    if (!ruleMatches(r, t)) continue
    if (!existing || moreSpecific(r, existing)) existing = r
  }

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
 *
 * Built from one KIND of row at a time, because the answer differs by sign: the
 * same payee can pay you and be paid, and a matcher built from both would hand
 * a salary the category its employer's expense rows were filed under. It used
 * to read spending only and there was no argument — which is the same bug
 * stated as a default.
 */
export function buildHistoryMatcher(
  txns: Transaction[],
  kind: CategoryKind = 'expense',
): (payee: string) => string | undefined {
  const entries = new Map<string, string>()
  const sorted = [...txns].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const t of sorted) {
    if (kindOfAmount(t.amountMinor) !== kind || t.transferId != null || !t.categoryId) continue
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

/**
 * Suggest a category from rules, else fuzzily from past transactions.
 *
 * The fuzzy fallback is deliberately still payee-only. It is a guess drawn from
 * what this merchant has been filed as before, and narrowing a guess by an
 * amount would make it right less often rather than more — the whole reason
 * conditions exist is that they are a claim somebody made on purpose.
 */
export async function suggestCategory(target: RuleTarget | string): Promise<string | undefined> {
  const t: RuleTarget = typeof target === 'string' ? { payee: target } : target
  const [rules, categories] = await Promise.all([db.rules.toArray(), db.categories.toArray()])
  const kinds = new Map(categories.map((c) => [c.id, c.kind]))
  const rule = categoryRule(t, rules, (id) => kinds.get(id))
  if (rule?.categoryId) return rule.categoryId
  const txns = await db.transactions.toArray()
  return buildHistoryMatcher(txns, t.kind ?? 'expense')(t.payee)
}

/** Suggest a name from rules, else fuzzily from what past rows were called. */
export async function suggestTitle(target: RuleTarget | string): Promise<string | undefined> {
  const t: RuleTarget = typeof target === 'string' ? { payee: target } : target
  const rules = await db.rules.toArray()
  const rule = titleRule(t, rules)
  if (rule) return cleanTitle(rule.title)
  const txns = await db.transactions.toArray()
  return buildTitleMatcher(txns)(t.payee)
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

/**
 * A transaction a category of this kind may be applied to in bulk.
 *
 * A transfer is neither spending nor income, so no payee rule may file one —
 * linking is what decides those, and a category from a merchant's name would be
 * wrong rather than merely unhelpful. Everything else is eligible for a
 * category of its OWN sort and no other: this used to read `amountMinor < 0`
 * with no kind at all, which is the same rule with income left out.
 */
function filable(t: Transaction, kind: CategoryKind | undefined): boolean {
  return t.transferId == null && kind !== undefined && kindOfAmount(t.amountMinor) === kind
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
export function coverageOf(rule: Rule, txns: Transaction[], rules: Rule[], kindOf: KindOf): RuleCoverage {
  // A rule that only says what to call a payee covers nothing here: applying a
  // rule rewrites `category_id` and nothing else. Naming past rows is
  // `applyTitle`, and it is asked separately because it answers a different
  // question about a different set of rows.
  if (!rule.categoryId) return { all: [], changed: [] }
  const kind = kindOf(rule.categoryId)
  const all = txns.filter(
    (t) =>
      filable(t, kind) &&
      categoryRule({ ...t, kind: kindOfAmount(t.amountMinor) }, rules, kindOf)?.id === rule.id,
  )
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
  /** The chosen category's own kind: only rows of that sort can be offered. */
  kind: CategoryKind | undefined,
  txns: Transaction[],
  exceptId?: string,
): Transaction[] {
  return txns.filter(
    (t) =>
      t.id !== exceptId &&
      filable(t, kind) &&
      t.categoryId !== categoryId &&
      payeeSimilar(t.payee, payee),
  )
}

/* ---------- choosing which of them ---------- */

/**
 * The catch-all a household starts with.
 *
 * `create_household` seeds "Other" and "Other income" (migration 03), and an
 * import with nothing to go on lands rows there — so "already has a category"
 * is not the same question as "has been filed". Both screens that apply a rule
 * offer one press that takes the properly-filed rows out of the selection, and
 * this is what that press means: touch the ones nobody has decided about, and
 * leave a category somebody chose alone.
 *
 * Matched by NAME, deliberately. There is no flag on the row and inventing one
 * would be a migration for a fact the seed already states; a household that
 * renames the category has said it is no longer the bin, which is the right
 * answer for the same reason.
 */
export const isCatchAll = (name: string | undefined): boolean => /^other(\s+income)?$/i.test((name ?? '').trim())

/**
 * Whether this row has already been filed somewhere that means something.
 *
 * No category at all, a deleted one, or the catch-all all count as "not filed".
 * `nameOf` rather than the category row, so a caller with a name map does not
 * have to build a second one.
 */
export function alreadyFiled(t: Transaction, nameOf: (id: string) => string | undefined): boolean {
  if (!t.categoryId) return false
  const name = nameOf(t.categoryId)
  return name !== undefined && !isCatchAll(name)
}

/**
 * A group of ids added to or removed from a selection, as a new set.
 *
 * Pure, and shared by the two screens, so "select the already-filed ones" means
 * exactly the same thing in the settings list and in the transaction sheet.
 */
export function withGroup(selected: Iterable<string>, group: Iterable<string>, on: boolean): Set<string> {
  const next = new Set(selected)
  for (const id of group) {
    if (on) next.add(id)
    else next.delete(id)
  }
  return next
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
