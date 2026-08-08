import { differenceInCalendarDays, parseISO } from 'date-fns'
import { db, getSetting, setSetting, type Transaction } from './db'
import { rpc } from './api'
import { normalizePayee } from './rules'

/**
 * Spotting money you moved between your own accounts.
 *
 * Import a statement for the joint account and one for your own, and the £500
 * you moved between them appears twice: once as £500 of spending and once as
 * £500 of income. Neither is true. `transferId` has always existed to say so,
 * and both legs are already excluded from every total — but the only thing that
 * ever set it was `create_transfer`, which INSERTS two rows. Two rows that
 * already exist could never become a transfer at all.
 *
 * So this file is the detector, and `link_transfer` (migration 09) is the thing
 * that acts on it. The detector is deliberately conservative and the server is
 * deliberately strict: this module proposes pairs fuzzily, and what it finally
 * asserts is exact, because a wrong guess here does not add a row you can
 * delete — it erases two real amounts from every figure in the app.
 */

/* ---------- how much of this happens without being asked ---------- */

export type TransferMode = 'auto' | 'ask' | 'manual'

export const TRANSFER_MODE_LABEL: Record<TransferMode, string> = {
  auto: 'Automatically',
  ask: 'Ask me first',
  manual: 'Never',
}

export const TRANSFER_MODE_HINT: Record<TransferMode, string> = {
  auto: 'Obvious pairs are linked as they arrive. Anything ambiguous still waits for you.',
  ask: 'New pairs are collected for you to confirm or dismiss.',
  manual: 'Hearth will not look. Link transfers yourself from a transaction.',
}

const MODE_KEY = 'transfer-mode'

/**
 * Device-local, and unsynced — the same reasoning as the theme and the sidebar.
 *
 * It looks like a household setting because it changes shared data, but what it
 * actually decides is how much THIS device volunteers to do without asking.
 * Your phone auto-linking is no reason for your partner's laptop to; and a
 * synced version would need a migration, a policy and a conflict story to buy
 * nothing anyone would notice.
 */
export async function getTransferMode(): Promise<TransferMode> {
  const raw = await getSetting(MODE_KEY)
  return raw === 'auto' || raw === 'manual' ? raw : 'ask'
}

export const setTransferMode = (mode: TransferMode) => setSetting(MODE_KEY, mode)

/* ---------- detection ---------- */

/** Dismissed pairs, so a rejected suggestion does not come back every render. */
const DISMISSED_KEY = 'transfer-dismissed'

const pairKey = (outId: string, inId: string) => `${outId}>${inId}`

async function dismissedPairs(): Promise<Set<string>> {
  const raw = await getSetting(DISMISSED_KEY)
  return new Set(raw ? (JSON.parse(raw) as string[]) : [])
}

export async function dismissTransfer(cand: TransferCandidate) {
  const set = await dismissedPairs()
  set.add(pairKey(cand.out.id, cand.in.id))
  // Capped: this is a hint, not a record, and an unbounded list in a settings
  // row would grow for the life of the household.
  await setSetting(DISMISSED_KEY, JSON.stringify([...set].slice(-500)))
}

export interface TransferCandidate {
  out: Transaction
  in: Transaction
  /** How many days apart the two legs are. Same day is the common case. */
  daysApart: number
  /**
   * Whether this pair is the ONLY reading of the two transactions involved.
   *
   * Two £500 payments out on the same day and one £500 in is not one transfer
   * and one coincidence — it is a question, and the app has no way to know the
   * answer. Ambiguous pairs are still offered, but never linked automatically.
   */
  unambiguous: boolean
  /** The payee text names the other account, or says "transfer" outright. */
  namedTransfer: boolean
}

/** Words a bank writes on a leg of a transfer. Weak evidence on their own. */
const TRANSFER_WORDS = /\b(transfer|tfr|xfer|to savings|from savings|own account)\b/

/** Legs are usually same-day; a slow bank posts the far side a day or two later. */
const MAX_DAYS_APART = 4

function eligible(t: Transaction): boolean {
  // Already a transfer, or already a bill payment — either way it is spoken for,
  // and `link_transfer` would refuse it.
  return t.transferId == null && t.billId == null && t.amountMinor !== 0
}

/**
 * Pairs of transactions that look like one movement of money.
 *
 * The equality is EXACT — `out.amountMinor === -in.amountMinor` — even though
 * every other matcher in this app works to a tolerance. A tolerance here would
 * mean quietly deciding that the £4 difference between two amounts is nothing,
 * and then removing both from every total so nobody could ever find it. The
 * server enforces the same equality, so a fuzzy suggestion could not be acted
 * on anyway.
 *
 * Pure, and takes its rows as arguments, so the pairing logic is testable
 * without a database.
 */
export function findTransferCandidates(
  txns: Transaction[],
  opts: { dismissed?: Set<string>; maxDaysApart?: number } = {},
): TransferCandidate[] {
  const dismissed = opts.dismissed ?? new Set<string>()
  const maxDays = opts.maxDaysApart ?? MAX_DAYS_APART

  const outs = txns.filter((t) => eligible(t) && t.amountMinor < 0)
  const ins = txns.filter((t) => eligible(t) && t.amountMinor > 0)

  // Bucketed by magnitude: without this, a couple of thousand transactions is a
  // few million comparisons on every render of the Activity page.
  const insByAmount = new Map<number, Transaction[]>()
  for (const t of ins) {
    const list = insByAmount.get(t.amountMinor)
    if (list) list.push(t)
    else insByAmount.set(t.amountMinor, [t])
  }

  // Every plausible reading first, so ambiguity can be measured before anything
  // is chosen. Deciding greedily as we go is what would let a coincidence look
  // like a certainty.
  const links: TransferCandidate[] = []
  const outDegree = new Map<string, number>()
  const inDegree = new Map<string, number>()

  for (const out of outs) {
    for (const inc of insByAmount.get(-out.amountMinor) ?? []) {
      // A movement between two accounts. Same account is a refund.
      if (inc.accountId === out.accountId) continue
      const daysApart = Math.abs(differenceInCalendarDays(parseISO(inc.date), parseISO(out.date)))
      if (daysApart > maxDays) continue
      if (dismissed.has(pairKey(out.id, inc.id))) continue

      const text = `${normalizePayee(out.payee)} ${normalizePayee(inc.payee)}`
      links.push({
        out,
        in: inc,
        daysApart,
        unambiguous: true, // provisional; resolved below
        namedTransfer: TRANSFER_WORDS.test(text),
      })
      outDegree.set(out.id, (outDegree.get(out.id) ?? 0) + 1)
      inDegree.set(inc.id, (inDegree.get(inc.id) ?? 0) + 1)
    }
  }

  return links
    .map((c) => ({
      ...c,
      unambiguous: outDegree.get(c.out.id) === 1 && inDegree.get(c.in.id) === 1,
    }))
    .sort(
      (a, b) =>
        b.out.date.localeCompare(a.out.date) ||
        a.daysApart - b.daysApart ||
        a.out.id.localeCompare(b.out.id),
    )
}

/** The same, read from the cache and with dismissals applied. */
export async function detectTransfers(): Promise<TransferCandidate[]> {
  const mode = await getTransferMode()
  if (mode === 'manual') return []
  const [txns, dismissed] = await Promise.all([db.transactions.toArray(), dismissedPairs()])
  return findTransferCandidates(txns, { dismissed })
}

/* ---------- acting on it ---------- */

/**
 * Join two existing transactions into one transfer. Online-only, like the rest
 * of the transfer path: both legs have to change together or neither does, and
 * the outbox has no way to express that.
 */
export async function linkTransfer(outId: string, inId: string) {
  return rpc<string>('link_transfer', { p_out_id: outId, p_in_id: inId })
}

/** Split one back into two ordinary transactions. Both are left uncategorised. */
export async function unlinkTransfer(transferId: string) {
  return rpc<number>('unlink_transfer', { p_transfer_id: transferId })
}

/**
 * Link every pair there is only one reading of. Used by `auto` mode.
 *
 * Ambiguous pairs are deliberately left behind for the review list rather than
 * resolved by picking the nearest date — being asked once is a small cost, and
 * silently choosing wrong is money going missing from two totals at once.
 *
 * A failure is swallowed per pair rather than aborting the run: the usual cause
 * is the other device having linked the same pair a moment earlier, which is
 * not an error worth showing anybody.
 */
export async function autoLinkTransfers(
  candidates: TransferCandidate[],
): Promise<{ linked: number; left: number }> {
  const clear = candidates.filter((c) => c.unambiguous)
  let linked = 0
  for (const c of clear) {
    try {
      await linkTransfer(c.out.id, c.in.id)
      linked++
    } catch {
      // Already linked, or not ours to link. Either way it stays in the list.
    }
  }
  return { linked, left: candidates.length - linked }
}
