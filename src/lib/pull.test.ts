import { beforeEach, describe, expect, it, vi } from 'vitest'

const { pullPage, fetchChecksums, fetchBalances, fetchHousehold } = vi.hoisted(() => ({
  pullPage: vi.fn(),
  fetchChecksums: vi.fn(),
  fetchBalances: vi.fn(),
  fetchHousehold: vi.fn(),
}))

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, pullPage, fetchChecksums, fetchBalances, fetchHousehold }
})
vi.mock('./supabase', () => ({ supabase: {}, isConfigured: true }))

const { db, setSetting, getSetting } = await import('./db')
const { pull } = await import('./pull')

const emptyPage = { rows: [], lastUpdatedAt: undefined, lastId: undefined }

const serverRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  updated_at: '2026-03-01T10:00:00+00:00',
  deleted_at: null,
  account_id: 'acct-1',
  occurred_on: '2026-03-01',
  payee: 'Tesco',
  amount_minor: -1200,
  ...over,
})

/** Serve one page per table, then nothing. */
function servePages(byTable: Partial<Record<string, unknown[]>>) {
  const served = new Set<string>()
  pullPage.mockImplementation(async (table: string) => {
    if (served.has(table)) return emptyPage
    served.add(table)
    const rows = byTable[table] ?? []
    if (!rows.length) return emptyPage
    const last = rows[rows.length - 1] as { id: string; updated_at: string }
    return { rows, lastUpdatedAt: last.updated_at, lastId: last.id }
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  await db.delete()
  await db.open()
  fetchChecksums.mockResolvedValue([])
  fetchBalances.mockResolvedValue([])
  fetchHousehold.mockResolvedValue({
    id: 'h1',
    name: 'Home',
    join_code: 'ABC12345',
    currency: 'GBP',
    visibility_epoch: 1,
  })
  servePages({})
})

describe('applying server rows', () => {
  it('stores live rows and removes tombstoned ones', async () => {
    await db.transactions.put({ id: 'gone', accountId: 'a', date: '2026-01-01', payee: 'Old', amountMinor: -1, createdAt: 'x', updatedAt: 'x' })
    servePages({
      transactions: [serverRow('kept'), serverRow('gone', { deleted_at: '2026-03-02T00:00:00+00:00' })],
    })

    await pull({ full: true })

    expect(await db.transactions.get('kept')).toBeDefined()
    // A tombstone is how a deletion reaches this device; the cache holds live
    // rows only, so it is applied as a removal rather than stored.
    expect(await db.transactions.get('gone')).toBeUndefined()
  })

  it('never stores the tombstone column itself', async () => {
    servePages({ transactions: [serverRow('t1')] })
    await pull({ full: true })
    expect(await db.transactions.get('t1')).not.toHaveProperty('deletedAt')
  })
})

describe('unsent local work', () => {
  it('does not let a server row overwrite an edit still waiting to be sent', async () => {
    await db.transactions.put({ id: 't1', accountId: 'a', date: '2026-03-01', payee: 'My edit', amountMinor: -500, createdAt: 'x', updatedAt: 'x' })
    await db.outbox.add({
      table: 'transactions', op: 'update', rowId: 't1', rowKey: 'transactions:t1',
      payload: { payee: 'My edit' }, refs: [], createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, status: 'pending',
    })
    servePages({ transactions: [serverRow('t1', { payee: 'Server version' })] })

    await pull({ full: true })

    expect((await db.transactions.get('t1'))?.payee).toBe('My edit')
  })

  it('does not delete a locally created row the server has not heard of yet', async () => {
    await db.transactions.put({ id: 'new', accountId: 'a', date: '2026-03-01', payee: 'Just added', amountMinor: -500, createdAt: 'x', updatedAt: 'x' })
    await db.outbox.add({
      table: 'transactions', op: 'insert', rowId: 'new', rowKey: 'transactions:new',
      payload: {}, refs: [], createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, status: 'pending',
    })
    servePages({ transactions: [serverRow('other')] })

    // A full pull deletes anything the server does not have — except rows the
    // server has not been told about yet, which are the user's unsent work.
    await pull({ full: true })

    expect(await db.transactions.get('new')).toBeDefined()
    expect(await db.transactions.get('other')).toBeDefined()
  })
})

describe('visibility epoch', () => {
  it('throws the cache away but keeps the outbox when the epoch moves', async () => {
    await setSetting('visibilityEpoch', '1')
    await db.transactions.put({ id: 'stale', accountId: 'a', date: '2026-01-01', payee: 'Was visible', amountMinor: -1, createdAt: 'x', updatedAt: 'x' })
    await db.outbox.add({
      table: 'transactions', op: 'insert', rowId: 'mine', rowKey: 'transactions:mine',
      payload: {}, refs: [], createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, status: 'pending',
    })
    fetchHousehold.mockResolvedValue({ id: 'h1', name: 'Home', join_code: 'A', currency: 'GBP', visibility_epoch: 2 })
    servePages({})

    const outcome = await pull()

    expect(outcome.rebuilt).toBe(true)
    // A row that became invisible cannot announce itself — no tombstone, no
    // realtime event — so the whole cache is rebuilt.
    expect(await db.transactions.get('stale')).toBeUndefined()
    // But unsent changes are the user's, and dropping them would be exactly the
    // "my edit disappeared" failure this design exists to remove.
    expect(await db.outbox.count()).toBe(1)
    expect(await getSetting('visibilityEpoch')).toBe('2')
  })

  it('does not rebuild when the epoch is unchanged', async () => {
    await setSetting('visibilityEpoch', '1')
    const outcome = await pull()
    expect(outcome.rebuilt).toBe(false)
  })

  it('caches the household currency so amounts format offline', async () => {
    fetchHousehold.mockResolvedValue({ id: 'h1', name: 'Home', join_code: 'A', currency: 'EUR', visibility_epoch: 1 })
    await pull()
    expect(await getSetting('currency')).toBe('EUR')
  })
})

describe('integrity check', () => {
  it('re-pulls a table whose row count disagrees with the server', async () => {
    await setSetting('visibilityEpoch', '1')
    await setSetting('cursor:transactions', '2026-03-01T09:00:00+00:00|a')
    // The delta pull comes back empty — the rows it should have seen were
    // skipped past. Only the checksum reveals it, which is the safety net that
    // turns silent permanent loss into a self-heal.
    const rows = [serverRow('a'), serverRow('b')]
    // Only once the checksum has been taken do the rows become fetchable, so
    // the delta phase genuinely misses them.
    let reconciling = false
    fetchChecksums.mockImplementation(async () => {
      reconciling = true
      return [{ table_name: 'transactions', live_rows: 2, max_updated_at: null }]
    })
    let served = false
    pullPage.mockImplementation(async (table: string) => {
      if (table !== 'transactions' || !reconciling || served) return emptyPage
      served = true
      return { rows, lastUpdatedAt: rows[1].updated_at, lastId: rows[1].id }
    })

    const outcome = await pull()

    expect(outcome.repaired).toContain('transactions')
    expect(await db.transactions.count()).toBe(2)
  })

  it('does not count unsent inserts as a discrepancy', async () => {
    await setSetting('visibilityEpoch', '1')
    await setSetting('cursor:transactions', '2026-03-01T09:00:00+00:00|a')
    await db.transactions.put({ id: 'mine', accountId: 'a', date: '2026-03-01', payee: 'New', amountMinor: -1, createdAt: 'x', updatedAt: 'x' })
    await db.outbox.add({
      table: 'transactions', op: 'insert', rowId: 'mine', rowKey: 'transactions:mine',
      payload: {}, refs: [], createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, status: 'pending',
    })
    // The server has none yet — because ours has not been pushed, not because
    // anything was lost.
    fetchChecksums.mockResolvedValue([{ table_name: 'transactions', live_rows: 0, max_updated_at: null }])

    const outcome = await pull()

    expect(outcome.repaired).toEqual([])
  })
})

describe('balances', () => {
  it('caches server-computed balances for accounts we cannot see into', async () => {
    fetchBalances.mockResolvedValue([{ account_id: 'acct-1', balance_minor: -2000 }])
    await pull({ full: true })
    expect((await db.balances.get('acct-1'))?.balanceMinor).toBe(-2000)
  })
})
