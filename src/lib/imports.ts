import { db, type Transaction } from './db'
import { update, remove } from './data'

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
