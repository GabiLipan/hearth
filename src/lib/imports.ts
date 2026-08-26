import { db, type Transaction } from './db'
import { update, remove } from './data'
import { extractRows, guessMapping, importHash, mappingKey, parseCSV, readMapping, type ImportRow } from './csv'
import { getSetting } from './db'
import { findLikelyDuplicate } from './dedupe'
import { extractRowsFromPDF } from './pdfImport'

/**
 * An import, after the fact.
 *
 * Nothing records a batch when it happens — there is no column for it and
 * inventing one would be a migration for a fact the rows already carry. An
 * imported row has an `importHash`, a `createdAt`, and an account, and one
 * press of Import writes them all at once; so a batch is a run of imported
 * rows on one account whose stamps sit within a couple of minutes of each
 * other. Derived rather than stored, which is what makes it work on the import
 * somebody has already regretted.
 *
 * Two consequences worth knowing:
 *
 *  - **A batch can only be recovered while its rows are in the cache.** They
 *    are the same rows, so this is the same window as seeing them at all.
 *  - **A run of one row is not offered.** Completing a hand-typed entry from a
 *    statement writes an `importHash` onto a row that was never imported (see
 *    `ReviewRow.completes`), and its stamp is when it was TYPED — so it sits
 *    alone, looking exactly like an import of one. Undoing that would delete
 *    something nobody imported. A one-row statement is rare; a hand-typed row
 *    is not.
 */
export interface ImportBatch {
  key: string
  accountId: string
  /** When the rows were added — the earliest stamp in the run. */
  at: string
  ids: string[]
  count: number
  /** The span the statement itself covered. */
  from: string
  to: string
  totalMinor: number
}

/**
 * Which way round a statement was written, and therefore what each row's
 * position in it MEANS.
 *
 * A bank statement carries no time inside a day. Two rows dated the second of
 * January are told apart by one thing only: which came first in the file, which
 * is the bank's own answer. Half the banks in the country write the newest row
 * first and half write the oldest, so the raw index means the opposite thing in
 * the two cases — and this is the only place that can tell, because it is the
 * only place holding the whole file.
 *
 * So the index is normalised on the way in: what is stored counts UPWARDS WITH
 * TIME, 0 being the earliest row, whichever way the file ran. Everything
 * downstream can then treat it as "later", full stop, and `byLedger` sorts it
 * descending with the dates.
 *
 * The direction is read from the dates rather than assumed: each consecutive
 * pair that goes backwards in time is a vote for newest-first, each pair that
 * goes forwards is a vote for oldest-first, and the majority decides. Rows
 * sharing a date vote for neither, which is what makes a file of one day fall
 * through to "as written" rather than being reversed on the strength of
 * nothing. Blank dates — a row the parser could not read — are skipped rather
 * than counted as ties, or a file with a broken line would drag the vote.
 */
export function statementOrder(dates: readonly string[]): number[] {
  const dated = dates.filter((d) => d)
  let forwards = 0
  let backwards = 0
  for (let i = 1; i < dated.length; i++) {
    const step = dated[i].localeCompare(dated[i - 1])
    if (step > 0) forwards++
    else if (step < 0) backwards++
  }
  const newestFirst = backwards > forwards
  return dates.map((_, i) => (newestFirst ? dates.length - 1 - i : i))
}

/** Rows further apart than this were two presses of Import, not one. */
const GAP_MS = 2 * 60 * 1000
const MIN_ROWS = 2
const KEEP = 8
const MAX_AGE_DAYS = 60

export function importBatches(txns: Transaction[], now = Date.now()): ImportBatch[] {
  const byAccount = new Map<string, Transaction[]>()
  for (const t of txns) {
    if (!t.importHash || !t.createdAt || Number.isNaN(Date.parse(t.createdAt))) continue
    const list = byAccount.get(t.accountId)
    if (list) list.push(t)
    else byAccount.set(t.accountId, [t])
  }

  const batches: ImportBatch[] = []
  for (const [accountId, rows] of byAccount) {
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    let run: Transaction[] = []
    const flush = () => {
      if (run.length >= MIN_ROWS) batches.push(batchOf(accountId, run))
      run = []
    }
    for (const t of rows) {
      const last = run[run.length - 1]
      if (last && Date.parse(t.createdAt) - Date.parse(last.createdAt) > GAP_MS) flush()
      run.push(t)
    }
    flush()
  }

  const oldest = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  return batches
    .filter((b) => Date.parse(b.at) >= oldest)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, KEEP)
}

function batchOf(accountId: string, run: Transaction[]): ImportBatch {
  const dates = run.map((t) => t.date).sort()
  return {
    key: `${accountId}:${run[0].createdAt}`,
    accountId,
    at: run[0].createdAt,
    ids: run.map((t) => t.id),
    count: run.length,
    from: dates[0],
    to: dates[dates.length - 1],
    totalMinor: run.reduce((s, t) => s + t.amountMinor, 0),
  }
}

/**
 * Put an import on the account it should have gone to.
 *
 * An ordinary field-level update per row, so it queues, retries and syncs like
 * anything else — and unlike a delete it is reversible, which is why it is the
 * first thing offered for the mistake this file exists for.
 *
 * `canEdit` has no default on purpose: `transactions_update` is checked against
 * the row's account AND the one it is moving to, so a caller that cannot
 * answer both questions would be queuing writes the server will refuse minutes
 * later as dead letters. Same discipline as `applyCategory`.
 */
export async function moveImport(
  batch: ImportBatch,
  toAccountId: string,
  canEdit: (t: Transaction) => boolean,
): Promise<{ done: number; skipped: number }> {
  return each(batch, canEdit, async (t) => {
    await update('transactions', t.id, { accountId: toAccountId })
  })
}

/** Take an import back out. The rows are soft-deleted, one write each. */
export async function undoImport(
  batch: ImportBatch,
  canEdit: (t: Transaction) => boolean,
): Promise<{ done: number; skipped: number }> {
  return each(batch, canEdit, async (t) => {
    await remove('transactions', t.id)
  })
}

async function each(
  batch: ImportBatch,
  canEdit: (t: Transaction) => boolean,
  act: (t: Transaction) => Promise<void>,
) {
  const rows = await db.transactions.bulkGet(batch.ids)
  let done = 0
  let skipped = 0
  for (const t of rows) {
    if (!t) continue
    if (!canEdit(t)) {
      skipped++
      continue
    }
    await act(t)
    done++
  }
  return { done, skipped }
}

/* ---------- a statement read for its ORDER rather than its rows ---------- */

/**
 * Read a statement into rows, however it was exported.
 *
 * The import wizard's first two steps, without the wizard: a PDF goes to the
 * text extractor, a CSV to the parser and then to whichever column mapping this
 * bank's files have already taught the app — falling back to the guess the
 * wizard would have shown for confirmation.
 *
 * There is deliberately no mapping UI on the way to this. A mapping that is
 * wrong here does not import anything wrong, it simply matches nothing: the
 * count IS the confirmation, and "0 of 418 lines matched" sends you to the
 * ordinary import, which does have the controls. Guessing and reporting beats
 * asking four questions about columns to do a repair.
 */
export async function readStatement(file: File): Promise<ImportRow[]> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return extractRowsFromPDF(file)
  const parsed = parseCSV(await file.text())
  if (parsed.rows.length === 0) return []
  const mapping = readMapping(await getSetting(mappingKey(parsed.headers)), parsed) ?? guessMapping(parsed)
  return extractRows(parsed, mapping)
}

/** One row of the account, and where the statement says it sat. */
export interface StatementMatch {
  txn: Transaction
  /** The row's position in the file, counting up with time. See `statementOrder`. */
  seq: number
}

export interface StatementPlan {
  /** Every row the file speaks for. */
  matched: StatementMatch[]
  /** Those whose stored order the file disagrees with — the ones worth writing. */
  changed: StatementMatch[]
  /** Lines in the file with nothing on this account to match. */
  unmatchedLines: number
  /** Rows on this account the file did not mention. */
  unmatchedRows: Transaction[]
}

/**
 * Line up a statement against the rows already on an account.
 *
 * The point of this is a repair: a statement covering a period that has already
 * been imported carries one thing the rows here do not, which is the order the
 * bank put them in — and inside a day that is the only evidence there is about
 * which came first. So nothing here creates, deletes or edits a transaction. It
 * matches, and the caller writes `statementOrder` and nothing else.
 *
 * Matching is the duplicate check read the other way up. `importHash` — date,
 * amount, normalised payee — is the exact answer and is tried first, one line
 * to one row: a queue per hash, consumed as it goes, so two identical charges
 * on one day take two different rows rather than both taking the first.
 * `findLikelyDuplicate` is the fallback for a row typed by hand that the
 * statement is now the reference for, and it is the same weaker claim it always
 * was — amount and date, with the payee only where there is one.
 *
 * What it cannot do is tell two IDENTICAL charges apart (same shop, same
 * amount, same day). Those get consecutive positions in file order, which is
 * right in aggregate and may swap the pair; there is nothing in either the file
 * or the account that could do better.
 */
export function matchStatement(rows: ImportRow[], seqs: number[], onAccount: Transaction[]): StatementPlan {
  const byHash = new Map<string, Transaction[]>()
  for (const t of onAccount) {
    const key = t.importHash ?? importHash(t)
    const queue = byHash.get(key)
    if (queue) queue.push(t)
    else byHash.set(key, [t])
  }
  const used = new Set<string>()
  const matched: StatementMatch[] = []
  let unmatchedLines = 0

  rows.forEach((r, i) => {
    if (!r.valid) return
    let txn: Transaction | undefined
    const queue = byHash.get(importHash(r))
    while (queue && queue.length > 0 && txn === undefined) {
      const next = queue.shift()!
      if (!used.has(next.id)) txn = next
    }
    txn ??= findLikelyDuplicate(r, onAccount, used)
    if (!txn) {
      unmatchedLines++
      return
    }
    used.add(txn.id)
    matched.push({ txn, seq: seqs[i] })
  })

  return {
    matched,
    changed: matched.filter((m) => m.txn.statementOrder !== m.seq),
    unmatchedLines,
    unmatchedRows: onAccount.filter((t) => !used.has(t.id)),
  }
}

/**
 * Write the order, and hand back what it was.
 *
 * One field, one write per row, through the outbox like everything else. The
 * `canEdit` predicate has no default for the reason `applyCategory`'s does not:
 * at `contribute` you may change only what you added, writes fail late and
 * quietly, and a button that promises four hundred rows and delivers three
 * hundred should say so rather than leaving a pile of dead letters in Settings.
 *
 * `before` is captured as it goes, so the toast can put every row back exactly
 * as it was — including the rows that carried no order at all, where the way
 * back is `undefined` rather than a number. That is a real undo rather than an
 * offer of one: this is an UPDATE, not a delete, so nothing here is one-way.
 */
export async function applyStatementOrder(
  matches: StatementMatch[],
  canEdit: (t: Transaction) => boolean,
): Promise<{ updated: number; skipped: number; before: Map<string, number | undefined> }> {
  const before = new Map<string, number | undefined>()
  let updated = 0
  let skipped = 0
  for (const { txn, seq } of matches) {
    if (!canEdit(txn)) {
      skipped++
      continue
    }
    before.set(txn.id, txn.statementOrder)
    await update('transactions', txn.id, { statementOrder: seq })
    updated++
  }
  return { updated, skipped, before }
}
