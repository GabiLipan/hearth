import { describe, expect, it } from 'vitest'
import type { Transaction } from './db'
import { matchStatement, statementOrder, importBatches } from './imports'

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

describe('lining a statement up against what is already here', () => {
  const line = (date: string, payee: string, amountMinor: number) => ({ date, payee, amountMinor, valid: true })

  it('matches on the same fingerprint the duplicate check uses, and writes nothing else', () => {
    const rows = [line('2026-01-02', 'TESCO STORES 3241', -1200), line('2026-01-02', 'AMAZON.CO.UK', -949)]
    const here = [
      txn({ id: 'a', date: '2026-01-02', payee: 'AMAZON.CO.UK', amountMinor: -949 }),
      txn({ id: 'b', date: '2026-01-02', payee: 'TESCO STORES 3241', amountMinor: -1200 }),
    ]

    const plan = matchStatement(rows, statementOrder(rows.map((r) => r.date)), here)

    expect(plan.matched.map((m) => [m.txn.id, m.seq])).toEqual([
      ['b', 0],
      ['a', 1],
    ])
    expect(plan.unmatchedLines).toBe(0)
    expect(plan.unmatchedRows).toHaveLength(0)
  })

  /**
   * Two identical charges on one day are the case nothing can resolve — same
   * shop, same amount, same date, and no clock anywhere. What matters is that
   * they take two DIFFERENT rows rather than both taking the first, so the day
   * still has the right number of positions in it.
   */
  it('gives two identical charges two different rows', () => {
    const rows = [line('2026-01-02', 'COFFEE', -320), line('2026-01-02', 'COFFEE', -320)]
    const here = [
      txn({ id: 'x', date: '2026-01-02', payee: 'COFFEE', amountMinor: -320 }),
      txn({ id: 'y', date: '2026-01-02', payee: 'COFFEE', amountMinor: -320 }),
    ]

    const plan = matchStatement(rows, statementOrder(rows.map((r) => r.date)), here)

    expect(new Set(plan.matched.map((m) => m.txn.id)).size).toBe(2)
    expect(plan.matched.map((m) => m.seq).sort()).toEqual([0, 1])
  })

  it('says what it could not place, in both directions', () => {
    const rows = [line('2026-01-02', 'TESCO', -1200), line('2026-01-03', 'A SHOP NOT IMPORTED', -500)]
    const here = [
      txn({ id: 'a', date: '2026-01-02', payee: 'TESCO', amountMinor: -1200 }),
      txn({ id: 'typed', date: '2026-01-09', payee: 'Dinner out', amountMinor: -3000 }),
    ]

    const plan = matchStatement(rows, statementOrder(rows.map((r) => r.date)), here)

    expect(plan.matched).toHaveLength(1)
    // A line the account has never seen: not an error, just not a repair.
    expect(plan.unmatchedLines).toBe(1)
    // And a row the statement never mentioned keeps whatever order it had.
    expect(plan.unmatchedRows.map((t) => t.id)).toEqual(['typed'])
  })

  it('offers only the rows whose order would actually change', () => {
    const rows = [line('2026-01-02', 'TESCO', -1200), line('2026-01-03', 'BOOTS', -500)]
    const here = [
      { ...txn({ id: 'a', date: '2026-01-02', payee: 'TESCO', amountMinor: -1200 }), statementOrder: 0 },
      txn({ id: 'b', date: '2026-01-03', payee: 'BOOTS', amountMinor: -500 }),
    ]

    const plan = matchStatement(rows, statementOrder(rows.map((r) => r.date)), here)

    expect(plan.matched).toHaveLength(2)
    // `a` already sits where the file says; only `b` is a write.
    expect(plan.changed.map((m) => m.txn.id)).toEqual(['b'])
  })

  it('matches a row typed by hand, which has no reference to compare', () => {
    // The weaker claim `findLikelyDuplicate` makes: nobody types
    // "SQ *THE GOOD FORK 3241", so amount and date carry it alone.
    const rows = [line('2026-01-02', 'SQ *THE GOOD FORK 3241', -4250)]
    const here = [txn({ id: 'typed', date: '2026-01-02', payee: '', title: 'Dinner', amountMinor: -4250 })]

    const plan = matchStatement(rows, statementOrder(rows.map((r) => r.date)), here)

    expect(plan.matched.map((m) => m.txn.id)).toEqual(['typed'])
  })
})
