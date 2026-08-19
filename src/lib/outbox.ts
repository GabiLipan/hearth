import { db, newId, rowKey, type OutboxEntry, type OutboxOp, type SyncedTable } from './db'
import { fromDb } from './mapping'
import { SyncError, fetchRow, insertRows, patchRow, rpc, softDeleteRow } from './api'

/**
 * The write queue.
 *
 * Every change the user makes is applied to the cache immediately and appended
 * here, then flushed to the server strictly in order. Ordering is not a nicety:
 * it is what guarantees a category exists before the transaction that
 * references it, without the client having to model the dependency graph.
 *
 * Three things this has to get right, each of which was a bug in the old sync:
 *
 *  - **Retrying must not duplicate.** Ids are generated on the client and
 *    inserts ignore conflicts, so a request whose response was lost replays
 *    harmlessly.
 *  - **A poisoned entry must not wedge the queue.** A write the server will
 *    never accept is dead-lettered and its dependants quarantined, and the rest
 *    of the queue keeps moving.
 *  - **A rejected write must not leave a phantom.** The optimistic row it put
 *    in the cache is rolled back, so the screen stops showing something that
 *    was never saved.
 */

const MAX_ATTEMPTS = 8
const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
const INSERT_BATCH = 400

let flushing = false
let flushQueued = false
const inFlight = new Set<number>()

/** Set by session.ts. Flushing before there is a session just burns retries. */
let canFlush: () => boolean = () => false
export function setCanFlush(fn: () => boolean) {
  canFlush = fn
}

let onChange: (() => void) | undefined
export function setOnOutboxChange(fn: () => void) {
  onChange = fn
}

/* ---------- enqueueing ---------- */

interface EnqueueInput {
  table: SyncedTable
  op: OutboxOp
  rowId: string
  payload?: Record<string, unknown>
  refs?: string[]
}

/**
 * Append a write, folding it into an earlier unsent one for the same row where
 * that is equivalent.
 *
 * Coalescing is not just an optimisation. Editing a transaction three times
 * while offline should reach the server as one write, not as an insert followed
 * by two updates whose payloads were captured at different moments; and a row
 * created and then deleted before ever reaching the server should produce no
 * requests at all rather than an insert the server accepts and a delete that
 * races it.
 */
export async function enqueue(input: EnqueueInput) {
  const key = rowKey(input.table, input.rowId)
  const payload = input.payload ?? {}

  await db.transaction('rw', db.outbox, async () => {
    const pending = await db.outbox.where('rowKey').equals(key).toArray()
    const mergeable = pending.filter((e) => e.seq !== undefined && !inFlight.has(e.seq))

    if (input.op === 'update') {
      const insert = mergeable.find((e) => e.op === 'insert')
      if (insert) {
        // Not yet sent: fold the edit into the row that will be created.
        insert.payload = { ...insert.payload, ...payload }
        await db.outbox.put(insert)
        return
      }
      const update = mergeable.find((e) => e.op === 'update')
      if (update) {
        update.payload = { ...update.payload, ...payload }
        await db.outbox.put(update)
        return
      }
    }

    if (input.op === 'delete' && mergeable.some((e) => e.op === 'insert')) {
      // Created and deleted before either reached the server: send nothing.
      await db.outbox.bulkDelete(mergeable.map((e) => e.seq!))
      return
    }

    if (input.op === 'delete') {
      // Pending edits to a row being deleted are pointless; drop them so the
      // delete is not queued behind updates the server would apply first.
      const stale = mergeable.filter((e) => e.op === 'update')
      if (stale.length) await db.outbox.bulkDelete(stale.map((e) => e.seq!))
    }

    const entry: OutboxEntry = {
      table: input.table,
      op: input.op,
      rowId: input.rowId,
      rowKey: key,
      payload,
      refs: input.refs ?? [],
      createdAt: Date.now(),
      attempts: 0,
      nextAttemptAt: 0,
      status: 'pending',
    }
    await db.outbox.add(entry)
  })

  onChange?.()
  void scheduleFlush()
}

/* ---------- flushing ---------- */

let flushTimer: ReturnType<typeof setTimeout> | undefined

export function scheduleFlush(delay = 250) {
  clearTimeout(flushTimer)
  flushTimer = setTimeout(() => void flush(), delay)
}

export async function flush(): Promise<void> {
  if (!canFlush()) return
  if (flushing) {
    flushQueued = true
    return
  }
  flushing = true
  try {
    for (;;) {
      const batch = await nextBatch()
      if (!batch.length) break
      const sent = await sendBatch(batch)
      if (!sent) break // backing off, or offline — stop and try again later
    }
  } finally {
    flushing = false
    inFlight.clear()
    onChange?.()
  }
  if (flushQueued) {
    flushQueued = false
    void flush()
  }
}

/**
 * The next contiguous run of work.
 *
 * Consecutive inserts into the same table are batched into one request — a CSV
 * import is hundreds of rows and would otherwise be hundreds of round trips.
 * Anything else is sent alone.
 *
 * If the head entry is still backing off, this returns nothing rather than
 * reaching past it. Skipping ahead would reorder writes, and the entry behind a
 * backing-off insert is very often an update to the row it creates.
 */
async function nextBatch(): Promise<OutboxEntry[]> {
  const now = Date.now()
  const pending = await db.outbox.orderBy('seq').filter((e) => e.status === 'pending').toArray()
  const head = pending[0]
  if (!head || head.nextAttemptAt > now) return []

  // RPC-backed tables are one call per row; only plain inserts batch.
  if (head.op !== 'insert' || head.table in RPC_WRITERS) return [head]

  const batch: OutboxEntry[] = []
  for (const entry of pending) {
    if (entry.op !== 'insert' || entry.table !== head.table) break
    if (entry.nextAttemptAt > now) break
    batch.push(entry)
    if (batch.length >= INSERT_BATCH) break
  }
  return batch
}

/** @returns false if the caller should stop flushing for now. */
async function sendBatch(batch: OutboxEntry[]): Promise<boolean> {
  for (const e of batch) if (e.seq !== undefined) inFlight.add(e.seq)
  try {
    await send(batch)
    await db.outbox.bulkDelete(batch.map((e) => e.seq!))
    onChange?.()
    return true
  } catch (raw) {
    const err = raw instanceof SyncError ? raw : new SyncError(String(raw), 'permanent')

    // A rejected batch does not say WHICH row was at fault. Re-send the rows
    // one at a time to find it, so one bad import line cannot dead-letter the
    // 399 good ones next to it.
    if (batch.length > 1 && err.kind === 'permanent') {
      for (const entry of batch) await sendBatch([entry])
      return true
    }

    const entry = batch[0]
    if (err.kind === 'transient' && entry.attempts + 1 < MAX_ATTEMPTS) {
      await backOff(entry, err)
      return false
    }
    await deadLetter(entry, err)
    return true
  } finally {
    for (const e of batch) if (e.seq !== undefined) inFlight.delete(e.seq)
  }
}

/**
 * Budgets and rules are written through RPCs because their uniqueness rule is a
 * partial or expression index, which `on_conflict` cannot name through
 * PostgREST. Sending them as plain inserts would fail with a duplicate-key
 * error the moment both devices learned the same payee — which, during a shared
 * CSV import, is routine rather than exotic.
 *
 * Both RPCs are idempotent, so a replay after a lost response is harmless.
 */
const RPC_WRITERS: Partial<Record<SyncedTable, (entry: OutboxEntry) => Promise<unknown>>> = {
  budgets: (e) =>
    rpc('upsert_budget', {
      p_id: e.rowId,
      p_category_id: e.payload.categoryId,
      p_personal: e.payload.ownerId != null,
      p_amount_minor: e.op === 'delete' ? null : e.payload.amountMinor,
      p_month: e.payload.month,
    }),
  rules: (e) =>
    e.op === 'delete'
      ? softDeleteRow('rules', e.rowId)
      : rpc('upsert_rule', {
          p_id: e.rowId,
          p_match: e.payload.match,
          // Both explicitly `?? null`: supabase-js DROPS an undefined argument,
          // and a dropped one changes PostgREST's overload resolution — the
          // call would fail with "could not find the function … in the schema
          // cache" rather than storing a rule that only files or only names.
          p_category_id: e.payload.categoryId ?? null,
          p_title: e.payload.title ?? null,
          // The conditions, same reasoning: each is a real argument on every
          // call, and `null` is the value that means "any".
          p_amount_min_minor: e.payload.amountMinMinor ?? null,
          p_amount_max_minor: e.payload.amountMaxMinor ?? null,
          p_account_id: e.payload.accountId ?? null,
        }),
  // A null amount releases the entry, which is how a delete is spelled for this
  // table — the same call, so there is no second path to keep in step. The RPC
  // needs every argument on every call because it re-tests the whole account
  // against its balance, including goals this device cannot see.
  goal_entries: (e) =>
    rpc('assign_to_goal', {
      p_id: e.rowId,
      p_goal_id: e.payload.goalId,
      p_amount_minor: e.op === 'delete' ? null : e.payload.amountMinor,
      p_on_date: e.payload.date ?? null,
      p_note: e.payload.note ?? null,
    }),
  // Revoking is the same call with 'none': the server tombstones rather than
  // deleting, so there is no separate delete path to keep in step.
  account_grants: (e) =>
    rpc('upsert_account_grant', {
      p_id: e.rowId,
      p_account_id: e.payload.accountId,
      p_user_id: e.payload.userId,
      p_level: e.op === 'delete' ? 'none' : e.payload.level,
    }),
}

async function send(batch: OutboxEntry[]) {
  const { table, op } = batch[0]

  const viaRpc = RPC_WRITERS[table]
  if (viaRpc) {
    for (const entry of batch) await viaRpc(entry)
    return
  }

  if (op === 'insert') {
    await insertRows(table, batch.map((e) => ({ id: e.rowId, ...e.payload })))
    return
  }
  const entry = batch[0]
  if (op === 'update') await patchRow(table, entry.rowId, entry.payload)
  else await softDeleteRow(table, entry.rowId)
}

async function backOff(entry: OutboxEntry, err: SyncError) {
  const attempts = entry.attempts + 1
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts)
  const jitter = delay * 0.25 * Math.random()
  await db.outbox.update(entry.seq!, {
    attempts,
    nextAttemptAt: Date.now() + delay + jitter,
    lastError: err.message,
  })
  onChange?.()
}

/* ---------- failure ---------- */

/**
 * Park a write the server will never accept, quarantine anything that depended
 * on it, and undo its optimistic effect on the cache.
 *
 * Without the quarantine step, the entries behind a failed insert would each
 * fail in turn against a row that does not exist, producing a cascade of
 * confusing errors for one root cause. Without the compensation step, the cache
 * would keep showing a row that was never saved.
 */
async function deadLetter(entry: OutboxEntry, err: SyncError) {
  await db.transaction('rw', [db.outbox, db.deadLetters], async () => {
    await db.deadLetters.add({
      id: newId(),
      table: entry.table,
      op: entry.op,
      rowId: entry.rowId,
      payload: entry.payload,
      summary: summarise(entry),
      code: err.code,
      message: err.message,
      failedAt: Date.now(),
    })
    await db.outbox.delete(entry.seq!)

    const dependants = await db.outbox
      .filter((e) => e.status === 'pending' && (e.rowKey === entry.rowKey || e.refs.includes(entry.rowKey)))
      .toArray()
    for (const d of dependants) {
      await db.outbox.update(d.seq!, { status: 'blocked', lastError: `Waiting on a change that failed: ${err.message}` })
    }
  })

  await compensate(entry)
  onChange?.()
}

/** Undo a rejected write's optimistic effect by taking the server's word for it. */
async function compensate(entry: OutboxEntry) {
  const table = db.table(entry.table)
  if (entry.op === 'insert') {
    await table.delete(entry.rowId)
    return
  }
  try {
    const row = await fetchRow(entry.table, entry.rowId)
    if (!row || row.deleted_at) await table.delete(entry.rowId)
    else await table.put(fromDb(row))
  } catch {
    // Offline, or the row is no longer visible to us. Leaving the cached row
    // alone is the safer failure: the next full pull reconciles it, and
    // deleting something we merely cannot reach right now would look like data
    // loss to the user.
  }
}

/** Plain English for the "couldn't save" list — the user should not have to read a payload. */
function summarise(entry: OutboxEntry): string {
  const p = entry.payload as Record<string, unknown>
  const verb = entry.op === 'insert' ? 'Adding' : entry.op === 'update' ? 'Changing' : 'Deleting'
  const amount = typeof p.amountMinor === 'number' ? ` (${(p.amountMinor / 100).toFixed(2)})` : ''
  const label =
    (typeof p.payee === 'string' && p.payee) ||
    (typeof p.name === 'string' && p.name) ||
    (typeof p.match === 'string' && p.match) ||
    ''
  const noun = SINGULAR[entry.table]
  return label ? `${verb} ${noun} “${label}”${amount}` : `${verb} a ${noun}`
}

const SINGULAR: Record<SyncedTable, string> = {
  transactions: 'transaction',
  categories: 'category',
  accounts: 'account',
  account_grants: 'sharing setting',
  household_members: 'person',
  goals: 'goal',
  goal_entries: 'goal entry',
  budgets: 'budget',
  bills: 'bill',
  rules: 'rule',
}

/* ---------- dead letter management ---------- */

export async function retryDeadLetter(id: string) {
  const dl = await db.deadLetters.get(id)
  if (!dl) return
  await db.deadLetters.delete(id)
  await enqueue({ table: dl.table, op: dl.op, rowId: dl.rowId, payload: dl.payload })
  await unblockFor(rowKey(dl.table, dl.rowId))
}

export async function discardDeadLetter(id: string) {
  const dl = await db.deadLetters.get(id)
  if (!dl) return
  await db.deadLetters.delete(id)
  // Its dependants can never succeed either; drop them rather than leave the
  // user with a queue that silently never moves.
  const key = rowKey(dl.table, dl.rowId)
  const blocked = await db.outbox.filter((e) => e.status === 'blocked' && (e.rowKey === key || e.refs.includes(key))).toArray()
  await db.outbox.bulkDelete(blocked.map((e) => e.seq!))
  onChange?.()
}

/**
 * Clear the whole list at once.
 *
 * One bad operation usually dead-letters a whole batch — a demo-data load that
 * built eight malformed budgets produces eight identical entries — and
 * "Try again" is useless for every one of them, because a retry re-sends the
 * SAME stored payload. If that payload is what the server objected to, the entry
 * can never succeed and dismissing it one at a time is the only way out.
 */
export async function discardAllDeadLetters() {
  const all = await db.deadLetters.toArray()
  if (!all.length) return
  const keys = new Set(all.map((d) => rowKey(d.table, d.rowId)))
  await db.deadLetters.clear()
  const blocked = await db.outbox
    .filter((e) => e.status === 'blocked' && (keys.has(e.rowKey) || e.refs.some((r) => keys.has(r))))
    .toArray()
  await db.outbox.bulkDelete(blocked.map((e) => e.seq!))
  onChange?.()
}

async function unblockFor(key: string) {
  const blocked = await db.outbox.filter((e) => e.status === 'blocked' && (e.rowKey === key || e.refs.includes(key))).toArray()
  for (const e of blocked) await db.outbox.update(e.seq!, { status: 'pending', lastError: undefined })
  onChange?.()
  void scheduleFlush()
}

/** Pending writes for a row, newest last — used to keep a remote row from overwriting an unsent edit. */
export async function pendingKeys(): Promise<Set<string>> {
  const rows = await db.outbox.toArray()
  return new Set(rows.map((e) => e.rowKey))
}

export const countPending = () => db.outbox.count()
export const countDeadLetters = () => db.deadLetters.count()
