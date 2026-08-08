import { beforeEach, describe, expect, it } from 'vitest'
import { db, type Rule, type Transaction } from './db'
import { applyCategory, coverageOf, similarTo } from './rules'

let seq = 0
const rule = (match: string, categoryId: string): Rule => ({
  id: `r${++seq}`,
  match,
  categoryId,
  createdAt: 'x',
  updatedAt: 'x',
})

const txn = (over: Partial<Transaction> & { payee: string }): Transaction => ({
  id: `t${++seq}`,
  accountId: 'current',
  date: '2026-03-04',
  amountMinor: -1200,
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

describe('what a rule covers', () => {
  it('claims the transactions it is the winning match for', () => {
    const r = rule('tesco', 'groceries')
    const txns = [
      txn({ payee: 'TESCO STORES 3241', categoryId: 'other' }),
      txn({ payee: 'Tesco Express', categoryId: 'groceries' }),
      txn({ payee: 'Sainsburys', categoryId: 'other' }),
    ]

    const cov = coverageOf(r, txns, [r])

    expect(cov.all).toHaveLength(2)
    // Only the one that would actually move is offered.
    expect(cov.changed).toHaveLength(1)
    expect(cov.changed[0].payee).toBe('TESCO STORES 3241')
  })

  it('does not reach into what a more specific rule owns', () => {
    // Longest match wins, so bulk-applying "tesco" must not quietly undo
    // "tesco petrol". Testing the substring directly would get this wrong while
    // showing a confident count.
    const general = rule('tesco', 'groceries')
    const specific = rule('tesco petrol', 'transport')
    const rules = [general, specific]
    const petrol = txn({ payee: 'TESCO PETROL LEEDS', categoryId: 'transport' })
    const shop = txn({ payee: 'TESCO STORES 3241', categoryId: 'other' })

    expect(coverageOf(general, [petrol, shop], rules).all).toEqual([shop])
    expect(coverageOf(specific, [petrol, shop], rules).all).toEqual([petrol])
  })

  it('leaves income and transfers alone', () => {
    const r = rule('acme', 'salary')
    const txns = [
      txn({ payee: 'ACME LTD', amountMinor: 250000 }),
      txn({ payee: 'ACME LTD', amountMinor: -5000, transferId: 'tr' }),
      txn({ payee: 'ACME LTD', amountMinor: -5000, categoryId: 'other' }),
    ]

    expect(coverageOf(r, txns, [r]).all).toHaveLength(1)
  })
})

describe('transactions similar to the one being categorised', () => {
  it('finds the same merchant written several ways', () => {
    const txns = [
      txn({ id: 'self', payee: 'PETS AT HOME INS', categoryId: 'pets' }),
      txn({ payee: 'Pets At Home Insurance 8891', categoryId: 'other' }),
      txn({ payee: 'PETS AT HOME', categoryId: 'other' }),
      txn({ payee: 'Vets4Pets', categoryId: 'other' }),
    ]

    const found = similarTo('PETS AT HOME INS', 'pets', txns, 'self')

    expect(found).toHaveLength(2)
    expect(found.map((t) => t.payee)).not.toContain('Vets4Pets')
  })

  it('excludes the transaction being edited and anything already filed there', () => {
    const txns = [
      txn({ id: 'self', payee: 'Pets At Home', categoryId: 'pets' }),
      txn({ payee: 'Pets At Home', categoryId: 'pets' }),
    ]

    expect(similarTo('Pets At Home', 'pets', txns, 'self')).toHaveLength(0)
  })
})

describe('applying a category in bulk', () => {
  beforeEach(async () => {
    await db.open()
    await db.transactions.clear()
    await db.outbox.clear()
  })

  it('writes only what the caller may edit, and says what it left', async () => {
    // A bulk update is the easiest possible way to queue a dozen writes that
    // each dead-letter a minute later, so the permission predicate is not
    // optional and the count returned has to be the truth.
    const mine = txn({ payee: 'Pets At Home', categoryId: 'other', createdBy: 'me' })
    const theirs = txn({ payee: 'Pets At Home', categoryId: 'other', createdBy: 'them' })
    await db.transactions.bulkPut([mine, theirs])

    const res = await applyCategory([mine, theirs], 'pets', (t) => t.createdBy === 'me')

    expect(res).toEqual({ updated: 1, skipped: 1 })
    expect((await db.transactions.get(mine.id))?.categoryId).toBe('pets')
    expect((await db.transactions.get(theirs.id))?.categoryId).toBe('other')
  })

  it('queues every change it makes, so none of them silently never saves', async () => {
    const a = txn({ payee: 'Pets At Home', categoryId: 'other' })
    const b = txn({ payee: 'Pets At Home', categoryId: 'other' })
    await db.transactions.bulkPut([a, b])

    await applyCategory([a, b], 'pets', () => true)

    const queued = await db.outbox.toArray()
    expect(queued).toHaveLength(2)
    expect(queued.every((e) => e.table === 'transactions' && e.op === 'update')).toBe(true)
  })
})
