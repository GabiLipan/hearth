import { db, clearCache, getSetting, setSetting, rowKey, SYNCED_TABLES, type SyncedTable } from './db'
import { fromDb, type DbRow } from './mapping'
import { fetchBalances, fetchChecksums, fetchHousehold, pullPage } from './api'
import { pendingKeys } from './outbox'
import { cacheMonthRule, ruleFromRemote } from './monthRule'

/**
 * Reading from the server into the cache.
 *
 * Two modes, and the choice between them is deliberate:
 *
 *  - **Full pull on cold start.** A couple's finances is a few thousand rows;
 *    fetching all of it once per launch costs less than the app's own precache
 *    and structurally removes every "did the cursor skip something?" question.
 *  - **Delta pull while running**, purely to keep foreground refreshes cheap.
 *
 * The delta path is the one that used to lose rows, so it is defended twice:
 * it rewinds its cursor by a safety window before reading, and a checksum probe
 * afterwards compares row counts with the server and orders a full re-pull of
 * any table that disagrees. A silently skipped row therefore heals in seconds
 * instead of being gone forever.
 */

const PAGE = 1000

/**
 * How far back a delta pull re-reads before its cursor.
 *
 * A row's `updated_at` is stamped when it is written, but the row only becomes
 * visible to other readers when its transaction COMMITS. A reader whose cursor
 * has already moved past that timestamp would never see it. Re-reading the last
 * minute covers any plausible gap between the two, and re-applying a row is
 * idempotent, so the only cost is a few redundant rows.
 */
const REWIND_MS = 60_000

const cursorKey = (table: SyncedTable) => `cursor:${table}`

interface Cursor {
  updatedAt: string
  id: string
}

async function readCursor(table: SyncedTable): Promise<Cursor | undefined> {
  const raw = await getSetting(cursorKey(table))
  if (!raw) return undefined
  const [updatedAt, id] = raw.split('|')
  return updatedAt && id ? { updatedAt, id } : undefined
}

/**
 * Cursors are stored as the RAW PostgREST timestamp. Never parse and re-format
 * one: PostgREST emits microseconds and JavaScript truncates to milliseconds, so
 * a round-tripped cursor can land fractionally *ahead* of a row it has not read.
 */
async function writeCursor(table: SyncedTable, cursor: Cursor) {
  await setSetting(cursorKey(table), `${cursor.updatedAt}|${cursor.id}`)
}

async function clearCursors() {
  for (const t of SYNCED_TABLES) await db.meta.delete(cursorKey(t))
}

/* ---------- applying rows ---------- */

/**
 * Write server rows into the cache, except where a local edit is still waiting
 * to be sent — that row is the user's, and the server has not heard about it
 * yet. Once the outbox drains, the next pull brings the merged result.
 */
async function applyRows(table: SyncedTable, rows: DbRow[], pending: Set<string>) {
  if (!rows.length) return
  const cache = db.table(table)
  const toPut: unknown[] = []
  const toDelete: string[] = []

  for (const row of rows) {
    if (pending.has(rowKey(table, row.id))) continue
    if (row.deleted_at) toDelete.push(row.id)
    else toPut.push(fromDb(row))
  }

  await db.transaction('rw', cache, async () => {
    if (toDelete.length) await cache.bulkDelete(toDelete)
    if (toPut.length) await cache.bulkPut(toPut)
  })
}

/* ---------- delta ---------- */

async function pullTableDelta(table: SyncedTable, pending: Set<string>): Promise<number> {
  const stored = await readCursor(table)
  if (!stored) return pullTableFull(table, pending)

  // Start inclusive, one window before the cursor.
  const rewound = new Date(Date.parse(stored.updatedAt) - REWIND_MS).toISOString()
  let cursor: { updatedAt: string; id?: string } = { updatedAt: rewound }
  let seen = 0

  for (;;) {
    const page = await pullPage(table, cursor, PAGE)
    if (!page.rows.length) break
    await applyRows(table, page.rows, pending)
    seen += page.rows.length
    if (page.lastUpdatedAt && page.lastId) {
      await writeCursor(table, { updatedAt: page.lastUpdatedAt, id: page.lastId })
      cursor = { updatedAt: page.lastUpdatedAt, id: page.lastId }
    }
    if (page.rows.length < PAGE) break
  }
  return seen
}

/* ---------- full ---------- */

/**
 * Replace a table's cache with everything the server currently has.
 *
 * Rows with unsent local changes are left alone; deleting them would throw away
 * work the user can see on screen and the server has not been told about yet.
 */
async function pullTableFull(table: SyncedTable, pending: Set<string>): Promise<number> {
  const cache = db.table(table)
  const rows: DbRow[] = []
  let cursor: { updatedAt: string; id?: string } | undefined

  for (;;) {
    const page = await pullPage(table, cursor, PAGE)
    rows.push(...page.rows)
    if (page.rows.length < PAGE || !page.lastUpdatedAt || !page.lastId) {
      if (page.lastUpdatedAt && page.lastId) await writeCursor(table, { updatedAt: page.lastUpdatedAt, id: page.lastId })
      break
    }
    cursor = { updatedAt: page.lastUpdatedAt, id: page.lastId }
  }

  const live = rows.filter((r) => !r.deleted_at)
  const serverIds = new Set(live.map((r) => r.id))

  await db.transaction('rw', cache, async () => {
    const cachedIds = (await cache.toCollection().primaryKeys()) as string[]
    const stale = cachedIds.filter((id) => !serverIds.has(id) && !pending.has(rowKey(table, id)))
    if (stale.length) await cache.bulkDelete(stale)
    const keep = live.filter((r) => !pending.has(rowKey(table, r.id)))
    if (keep.length) await cache.bulkPut(keep.map((r) => fromDb(r)))
  })

  return live.length
}

export async function fullPull() {
  const pending = await pendingKeys()
  for (const table of SYNCED_TABLES) await pullTableFull(table, pending)
  await refreshBalances()
}

/* ---------- integrity ---------- */

/**
 * Compare cached row counts with the server's and fully re-pull anything that
 * disagrees. Cheap (one RPC, six counts) and it is the safety net that makes
 * the delta path survivable: any row a cursor managed to skip shows up here as
 * a count mismatch on the next sync.
 */
async function reconcile(pending: Set<string>): Promise<SyncedTable[]> {
  const checksums = await fetchChecksums()
  const repaired: SyncedTable[] = []

  for (const { table_name, live_rows } of checksums) {
    const table = table_name as SyncedTable
    if (!SYNCED_TABLES.includes(table)) continue
    const cached = await db.table(table).count()
    // Unsent inserts exist locally but not yet on the server, so they are not a
    // discrepancy — count them out before comparing.
    const unsent = [...pending].filter((k) => k.startsWith(`${table}:`)).length
    if (Math.abs(cached - unsent - Number(live_rows)) > 0) {
      await pullTableFull(table, pending)
      repaired.push(table)
    }
  }
  return repaired
}

/* ---------- balances ---------- */

/**
 * Balances for accounts whose transactions we are not allowed to read. For
 * everything else the balance is computed locally from cached transactions, so
 * an optimistic edit moves the number immediately.
 */
export async function refreshBalances() {
  const rows = await fetchBalances()
  const now = Date.now()
  await db.balances.bulkPut(
    rows.map((r) => ({ accountId: r.account_id, balanceMinor: Number(r.balance_minor), fetchedAt: now })),
  )
}

/* ---------- epoch ---------- */

/**
 * A row that stops being visible cannot announce itself — it emits no realtime
 * event and leaves no tombstone. So the server bumps the household's epoch on
 * any change to who-can-see-what, and a client that notices a new one throws
 * its cache away and starts again.
 *
 * The outbox is deliberately NOT cleared: those are the user's unsent changes,
 * and losing them would be exactly the "my edit disappeared" failure this whole
 * rewrite exists to remove.
 */
async function checkEpoch(): Promise<boolean> {
  const household = await fetchHousehold()
  if (!household) return false
  const known = await getSetting('visibilityEpoch')
  await setSetting('currency', household.currency)
  // Same reasoning as the currency: a fact about the household's money that
  // every screen needs before it can add anything up, cached so it survives
  // going offline. Written on every pull, not only on an epoch change — the
  // rule changing alters nobody's access, so it bumps no epoch and this is the
  // only thing that carries it to the other device.
  await cacheMonthRule(ruleFromRemote(household))
  if (known !== undefined && Number(known) === household.visibility_epoch) return false

  await setSetting('visibilityEpoch', String(household.visibility_epoch))
  if (known === undefined) return false // first run; the cold-start pull covers it

  await clearCache()
  await clearCursors()
  return true
}

/* ---------- entry point ---------- */

export interface SyncOutcome {
  rows: number
  repaired: SyncedTable[]
  rebuilt: boolean
}

export async function pull({ full = false }: { full?: boolean } = {}): Promise<SyncOutcome> {
  const rebuilt = await checkEpoch()
  const pending = await pendingKeys()

  if (full || rebuilt) {
    await fullPull()
    return { rows: 0, repaired: [], rebuilt }
  }

  let rows = 0
  for (const table of SYNCED_TABLES) rows += await pullTableDelta(table, pending)
  const repaired = await reconcile(pending)
  await refreshBalances()
  return { rows, repaired, rebuilt }
}
