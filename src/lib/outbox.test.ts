import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncError } from './api'

// vi.mock is hoisted above the imports, so the spies have to be too.
const { insertRows, patchRow, softDeleteRow, rpc, fetchRow } = vi.hoisted(() => ({
  insertRows: vi.fn(),
  patchRow: vi.fn(),
  softDeleteRow: vi.fn(),
  rpc: vi.fn(),
  fetchRow: vi.fn(),
}))

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, insertRows, patchRow, softDeleteRow, rpc, fetchRow }
})
vi.mock('./supabase', () => ({ supabase: {}, isConfigured: true }))

const { db } = await import('./db')
const { flush, setCanFlush } = await import('./outbox')
const { create, update, remove } = await import('./data')

/**
 * Flushing is gated rather than using fake timers: Dexie and fake-indexeddb
 * drive their events off real timers, so freezing the clock hangs every
 * database call. Keeping the gate shut except during an explicit flush stops
 * the debounced background flush from racing the assertions.
 */
async function flushNow() {
  setCanFlush(() => true)
  await flush()
  setCanFlush(() => false)
}

beforeEach(async () => {
  vi.clearAllMocks()
  setCanFlush(() => false)
  await db.outbox.clear()
  await db.deadLetters.clear()
  await db.transactions.clear()
  await db.categories.clear()
  await db.budgets.clear()
})

afterEach(() => {
  setCanFlush(() => false)
})

const aTransaction = (over: Record<string, unknown> = {}) => ({
  accountId: 'acct-1',
  categoryId: 'cat-1',
  date: '2026-03-01',
  payee: 'Tesco',
  amountMinor: -1200,
  createdAt: '2026-03-01T00:00:00Z',
  ...over,
})

describe('coalescing', () => {
  /**
   * Editing something three times on a train should reach the server as one
   * write, not as an insert plus two updates whose payloads were captured at
   * different moments and could be applied out of order.
   */
  it('folds an edit into the insert that has not been sent yet', async () => {
    const id = await create('transactions', aTransaction())
    await update('transactions', id, { payee: 'Co-op' })

    const queue = await db.outbox.toArray()
    expect(queue).toHaveLength(1)
    expect(queue[0].op).toBe('insert')
    expect(queue[0].payload.payee).toBe('Co-op')
  })

  it('sends nothing at all for a row created and deleted while offline', async () => {
    const id = await create('transactions', aTransaction())
    await remove('transactions', id)

    expect(await db.outbox.count()).toBe(0)
    await flushNow()
    expect(insertRows).not.toHaveBeenCalled()
    expect(softDeleteRow).not.toHaveBeenCalled()
  })

  it('merges consecutive edits to the same row into one patch', async () => {
    await db.transactions.put({ ...aTransaction(), id: 't1', updatedAt: 'x' } as never)
    await update('transactions', 't1', { payee: 'Co-op' })
    await update('transactions', 't1', { amountMinor: -900 })

    const queue = await db.outbox.toArray()
    expect(queue).toHaveLength(1)
    expect(queue[0].payload).toMatchObject({ payee: 'Co-op', amountMinor: -900 })
  })

  it('drops pending edits when the row is then deleted', async () => {
    await db.transactions.put({ ...aTransaction(), id: 't1', updatedAt: 'x' } as never)
    await update('transactions', 't1', { payee: 'Co-op' })
    await remove('transactions', 't1')

    const queue = await db.outbox.toArray()
    expect(queue).toHaveLength(1)
    expect(queue[0].op).toBe('delete')
  })

  it('batches consecutive inserts into one request', async () => {
    // A CSV import is hundreds of rows; one request each would be hundreds of
    // round trips on a free-tier project.
    for (let i = 0; i < 5; i++) await create('transactions', aTransaction({ payee: `Shop ${i}` }))
    await flushNow()

    expect(insertRows).toHaveBeenCalledTimes(1)
    expect(insertRows.mock.calls[0][1]).toHaveLength(5)
  })

  it('does not batch across tables', async () => {
    await create('categories', { name: 'Coffee', icon: 'coffee', slot: 1, kind: 'expense', sortOrder: 0 })
    await create('transactions', aTransaction())
    await flushNow()

    expect(insertRows).toHaveBeenCalledTimes(2)
    expect(insertRows.mock.calls[0][0]).toBe('categories')
    expect(insertRows.mock.calls[1][0]).toBe('transactions')
  })
})

describe('ordering', () => {
  it('creates a category before the transaction that references it', async () => {
    const catId = await create('categories', { name: 'Coffee', icon: 'coffee', slot: 1, kind: 'expense', sortOrder: 0 })
    await create('transactions', aTransaction({ categoryId: catId }))
    await flushNow()

    const order = insertRows.mock.calls.map((c) => c[0])
    expect(order).toEqual(['categories', 'transactions'])
  })
})

describe('failure handling', () => {
  it('keeps retrying a transient failure without dead-lettering', async () => {
    insertRows.mockRejectedValueOnce(new SyncError('offline', 'transient'))
    await create('transactions', aTransaction())
    await flushNow()

    expect(await db.deadLetters.count()).toBe(0)
    const queue = await db.outbox.toArray()
    expect(queue).toHaveLength(1)
    expect(queue[0].attempts).toBe(1)
    expect(queue[0].nextAttemptAt).toBeGreaterThan(Date.now())
  })

  it('dead-letters a permanent failure and rolls back the row it invented', async () => {
    insertRows.mockRejectedValue(new SyncError('violates foreign key', 'permanent', '23503'))
    const id = await create('transactions', aTransaction())
    await flushNow()

    const dead = await db.deadLetters.toArray()
    expect(dead).toHaveLength(1)
    expect(dead[0].code).toBe('23503')
    expect(dead[0].summary).toContain('Tesco')
    // The optimistic row must go, or the screen keeps showing something that
    // was never saved.
    expect(await db.transactions.get(id)).toBeUndefined()
    expect(await db.outbox.count()).toBe(0)
  })

  it('quarantines the writes that depended on the failed one', async () => {
    insertRows.mockImplementation(async (table: string) => {
      if (table === 'categories') throw new SyncError('nope', 'permanent', '23505')
    })
    const catId = await create('categories', { name: 'Coffee', icon: 'coffee', slot: 1, kind: 'expense', sortOrder: 0 })
    await create('transactions', aTransaction({ categoryId: catId }))
    await flushNow()

    // The transaction references a category that will never exist. It is parked
    // rather than left to fail on its own and produce a second, confusing error.
    const queue = await db.outbox.toArray()
    expect(queue).toHaveLength(1)
    expect(queue[0].table).toBe('transactions')
    expect(queue[0].status).toBe('blocked')
    expect(await db.deadLetters.count()).toBe(1)
  })

  it('isolates one bad row instead of dead-lettering the whole batch', async () => {
    let call = 0
    insertRows.mockImplementation(async (_table: string, rows: unknown[]) => {
      call++
      // The batched call fails; the per-row retries then reveal which row it was.
      if (call === 1) throw new SyncError('duplicate key', 'permanent', '23505')
      if ((rows[0] as { payee: string }).payee === 'Bad') throw new SyncError('duplicate key', 'permanent', '23505')
    })

    await create('transactions', aTransaction({ payee: 'Good 1' }))
    await create('transactions', aTransaction({ payee: 'Bad' }))
    await create('transactions', aTransaction({ payee: 'Good 2' }))
    await flushNow()

    const dead = await db.deadLetters.toArray()
    expect(dead).toHaveLength(1)
    expect(dead[0].summary).toContain('Bad')
    expect(await db.outbox.count()).toBe(0)
  })

  it('treats an update that matched no rows as a real failure', async () => {
    // PostgREST answers an UPDATE matching nothing with 204 and error: null.
    // api.patchRow turns that into a permanent SyncError; without it the change
    // would be reported as saved and silently lost.
    patchRow.mockRejectedValue(new SyncError('matched no rows', 'permanent', 'NO_ROWS'))
    fetchRow.mockResolvedValue(undefined)
    await db.transactions.put({ ...aTransaction(), id: 't1', updatedAt: 'x' } as never)
    await update('transactions', 't1', { payee: 'Co-op' })
    await flushNow()

    expect(await db.deadLetters.count()).toBe(1)
    // The server says the row is gone, so the cache stops pretending otherwise.
    expect(await db.transactions.get('t1')).toBeUndefined()
  })

  it('leaves the cached row alone when compensation cannot reach the server', async () => {
    patchRow.mockRejectedValue(new SyncError('matched no rows', 'permanent', 'NO_ROWS'))
    fetchRow.mockRejectedValue(new SyncError('offline', 'transient'))
    await db.transactions.put({ ...aTransaction(), id: 't1', updatedAt: 'x' } as never)
    await update('transactions', 't1', { payee: 'Co-op' })
    await flushNow()

    // Deleting something we merely cannot reach would look like data loss; the
    // next full pull reconciles it instead.
    expect(await db.transactions.get('t1')).toBeDefined()
  })
})

describe('rpc-backed tables', () => {
  it('writes budgets through upsert_budget rather than a plain insert', async () => {
    // budgets and rules have partial/expression unique indexes that PostgREST's
    // `on_conflict` cannot name, so a plain insert would fail the moment both
    // devices set the same budget.
    await create('budgets', { categoryId: 'cat-1', amountMinor: 5000, ownerId: undefined })
    await flushNow()

    expect(insertRows).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('upsert_budget', {
      p_id: expect.any(String),
      p_category_id: 'cat-1',
      p_personal: false,
      p_amount_minor: 5000,
    })
  })

  it('removes a budget by upserting a null amount', async () => {
    const id = await create('budgets', { categoryId: 'cat-1', amountMinor: 5000, ownerId: undefined })
    await flushNow()
    vi.clearAllMocks()
    await remove('budgets', id)
    await flushNow()

    expect(rpc).toHaveBeenCalledWith('upsert_budget', expect.objectContaining({ p_amount_minor: null, p_category_id: 'cat-1' }))
  })

  it('marks a personal budget as personal', async () => {
    await create('budgets', { categoryId: 'cat-1', amountMinor: 5000, ownerId: 'user-1' })
    await flushNow()
    expect(rpc).toHaveBeenCalledWith('upsert_budget', expect.objectContaining({ p_personal: true }))
  })
})
