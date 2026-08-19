import { rpc } from './api'
import { setSetting } from './db'
import { DEFAULT_MONTH_RULE, type MonthRule } from './books'

/**
 * Where the household's month rule is kept, and how it gets here.
 *
 * The rule itself — what it means, why there are two of them, why 28 — lives
 * with `effectiveMonth` in `books.ts`. This file is only the plumbing, and it
 * is deliberately the same plumbing the currency already uses:
 *
 *   the household row is the truth  →  cached in `meta` on every pull
 *                                   →  read from the cache, so the app can
 *                                      count a month offline
 *                                   →  written by an RPC, because `households`
 *                                      is read-only to its members
 *
 * One key rather than two, holding JSON. `useMonthRule` is a single
 * `useLiveQuery`, and a half-applied change — the contribution day saved and
 * the income day not — cannot exist for a frame.
 */

export const MONTH_RULE_KEY = 'monthRule'

interface Stored {
  contributionDay?: number | null
  incomeDay?: number | null
}

/**
 * A stored string back into a rule, defaulting rather than throwing.
 *
 * A device that cannot parse this must still be able to count a month. The
 * fallback is `DEFAULT_MONTH_RULE`, which is what the household had before
 * anybody opened the setting — the wrong answer for a household that has
 * changed it, and never a broken screen.
 */
export function parseMonthRule(raw: string | undefined): MonthRule {
  if (!raw) return DEFAULT_MONTH_RULE
  try {
    const v = JSON.parse(raw) as Stored
    return { contributionDay: day(v.contributionDay), incomeDay: day(v.incomeDay) }
  } catch {
    return DEFAULT_MONTH_RULE
  }
}

/** A cutoff the app is prepared to act on: a whole number 1..28, or nothing. */
function day(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null
  return v >= 1 && v <= 28 ? v : null
}

/** What the server sends, in the shape the cache holds. */
export function ruleFromRemote(h: {
  contribution_cutoff_day?: number | null
  income_cutoff_day?: number | null
}): MonthRule {
  return { contributionDay: day(h.contribution_cutoff_day), incomeDay: day(h.income_cutoff_day) }
}

export const cacheMonthRule = (rule: MonthRule) => setSetting(MONTH_RULE_KEY, JSON.stringify(rule))

/**
 * Change it, for both of us.
 *
 * The cache is written first so the figures move under your finger, and the RPC
 * follows. Online-only, and deliberately not through the outbox: the outbox
 * carries row mutations for the synced tables and this is neither.
 *
 * A failed RPC is swallowed, and it is not silent — `checkEpoch` rewrites the
 * cached copy from the server on every pull, so a change the server never
 * received reverts on screen within the minute. That is worse than an error
 * message and much better than a control that claims to have saved.
 *
 * Both arguments are always sent, null included. supabase-js drops `undefined`
 * arguments, and an omitted one changes PostgREST's overload resolution rather
 * than passing null — see the note in CLAUDE.md.
 */
export async function saveMonthRule(rule: MonthRule) {
  await cacheMonthRule(rule)
  try {
    await rpc('set_month_rule', {
      p_contribution_day: rule.contributionDay,
      p_income_day: rule.incomeDay,
    })
  } catch {
    /* the next pull is authoritative — see above */
  }
}
