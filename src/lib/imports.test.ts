import { describe, expect, it } from 'vitest'
import type { Transaction } from './db'
import { statementOrder, importBatches } from './imports'

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

describe('the statement\'s own order', () => {
  /**
   * The whole point: inside a day a statement has no clock, so its own order is
   * the bank's only answer to which row came first — and half the banks in the
   * country write it one way round and half the other.
   */
  it('counts up with time from a file written oldest first', () => {
    expect(statementOrder(['2026-01-02', '2026-01-02', '2026-01-07'])).toEqual([0, 1, 2])
  })

  it('and reverses one written newest first', () => {
    expect(statementOrder(['2026-01-07', '2026-01-02', '2026-01-02'])).toEqual([2, 1, 0])
  })

  /**
   * A file that is all one day votes neither way, so it is left as written —
   * the alternative is reversing it on the strength of no evidence at all.
   */
  it('leaves a single day as the file had it', () => {
    expect(statementOrder(['2026-01-02', '2026-01-02', '2026-01-02'])).toEqual([0, 1, 2])
  })

  it('takes the majority, so one row out of place does not flip the file', () => {
    // Banks do post a row out of order now and then; one backwards step among
    // five forward ones is not a newest-first statement.
    expect(statementOrder(['2026-01-01', '2026-01-03', '2026-01-02', '2026-01-04', '2026-01-05'])).toEqual([
      0, 1, 2, 3, 4,
    ])
  })

  /**
   * A line the parser could not read has no date, and counting it as a tie
   * would let a broken row drag the vote. It still gets a position — every row
   * in the file does — it simply does not get a say in which way round the file
   * runs.
   */
  it('ignores an unreadable row when deciding, but still numbers it', () => {
    expect(statementOrder(['2026-01-07', '', '2026-01-02'])).toEqual([2, 1, 0])
  })

  it('says nothing about an empty file', () => {
    expect(statementOrder([])).toEqual([])
  })
})
