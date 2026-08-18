import { describe, expect, it } from 'vitest'
import type { Transaction } from './db'
import { importBatches } from './imports'

const NOW = Date.parse('2026-08-18T12:00:00.000Z')

let seq = 0
const txn = (over: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  accountId: 'current',
  date: '2026-08-01',
  payee: 'TESCO',
  amountMinor: -1200,
  importHash: `h${seq}`,
  createdAt: '2026-08-18T11:00:00.000Z',
  updatedAt: 'x',
  ...over,
})

describe('finding an import after the fact', () => {
  it('groups the rows one press of Import wrote', () => {
    const rows = [
      txn({ createdAt: '2026-08-18T11:00:00.000Z', date: '2026-08-03' }),
      // A large statement leaves the outbox as several requests, so the server
      // stamps them a few seconds apart. Still one import.
      txn({ createdAt: '2026-08-18T11:00:04.100Z', date: '2026-08-01' }),
      txn({ createdAt: '2026-08-18T11:00:09.000Z', date: '2026-08-07' }),
    ]

    const [batch, ...rest] = importBatches(rows, NOW)

    expect(rest).toHaveLength(0)
    expect(batch.count).toBe(3)
    expect(batch.accountId).toBe('current')
    expect(batch.from).toBe('2026-08-01')
    expect(batch.to).toBe('2026-08-07')
    expect(batch.totalMinor).toBe(-3600)
  })

  it('keeps two imports of the same account apart, newest first', () => {
    const rows = [
      txn({ createdAt: '2026-08-10T09:00:00.000Z' }),
      txn({ createdAt: '2026-08-10T09:00:01.000Z' }),
      txn({ createdAt: '2026-08-18T11:00:00.000Z' }),
      txn({ createdAt: '2026-08-18T11:00:01.000Z' }),
    ]

    expect(importBatches(rows, NOW).map((b) => b.at)).toEqual([
      '2026-08-18T11:00:00.000Z',
      '2026-08-10T09:00:00.000Z',
    ])
  })

  it('never mixes two accounts into one batch', () => {
    const rows = [
      txn({ accountId: 'a', createdAt: '2026-08-18T11:00:00.000Z' }),
      txn({ accountId: 'a', createdAt: '2026-08-18T11:00:01.000Z' }),
      txn({ accountId: 'b', createdAt: '2026-08-18T11:00:00.500Z' }),
      txn({ accountId: 'b', createdAt: '2026-08-18T11:00:01.500Z' }),
    ]

    const batches = importBatches(rows, NOW)
    expect(batches).toHaveLength(2)
    expect(new Set(batches.map((b) => b.accountId))).toEqual(new Set(['a', 'b']))
  })

  it('ignores rows nobody imported', () => {
    // Typed by hand: no hash at all, and one that was given a hash later by the
    // statement it completed — which sits alone, and must not be offered as an
    // import of one to be undone.
    const rows = [
      txn({ importHash: undefined, createdAt: '2026-08-18T11:00:00.000Z' }),
      txn({ importHash: undefined, createdAt: '2026-08-18T11:00:01.000Z' }),
      txn({ createdAt: '2026-08-12T18:22:00.000Z' }),
    ]

    expect(importBatches(rows, NOW)).toEqual([])
  })

  it('forgets imports old enough that undoing one would be a surprise', () => {
    const rows = [
      txn({ createdAt: '2026-01-04T09:00:00.000Z' }),
      txn({ createdAt: '2026-01-04T09:00:01.000Z' }),
    ]

    expect(importBatches(rows, NOW)).toEqual([])
  })
})
