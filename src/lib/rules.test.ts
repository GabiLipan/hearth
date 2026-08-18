import { beforeEach, describe, expect, it } from 'vitest'
import { db, type Rule, type Transaction } from './db'
import {
  applyCategory,
  applyTitle,
  buildTitleMatcher,
  categoryRule,
  cleanTitle,
  coverageOf,
  displayName,
  learnRule,
  matchKey,
  reference,
  similarTo,
  titleRule,
  unnamedLike,
} from './rules'

let seq = 0
const rule = (match: string, categoryId?: string, title?: string): Rule => ({
  id: `r${++seq}`,
  match,
  categoryId,
  title,
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

describe('what a payee is called', () => {
  it('shows the name where there is one, and the bank’s words where there is not', () => {
    expect(displayName({ payee: 'SQ *THE GOOD FORK 3241', title: 'Dinner out' })).toBe('Dinner out')
    expect(displayName({ payee: 'SQ *THE GOOD FORK 3241' })).toBe('SQ *THE GOOD FORK 3241')
    // A blank is not a name — otherwise a row renders with nothing on it.
    expect(displayName({ payee: 'TESCO', title: '   ' })).toBe('TESCO')
  })

  it('shows the bank’s words after the name, and never instead of it twice', () => {
    // The pair every table and card renders: the name, then the reference.
    expect(reference({ payee: 'SQ *THE GOOD FORK 3241', title: 'Dinner out' })).toBe('SQ *THE GOOD FORK 3241')
    // Nothing to add — the payee IS the name on this row.
    expect(reference({ payee: 'Tesco' })).toBeUndefined()
    // Added by hand and never matched to a statement: there is no reference yet.
    expect(reference({ payee: '', title: 'Dinner out' })).toBeUndefined()
  })

  it('labels a row that has a name and no reference at all', () => {
    // Nobody types "SQ *THE GOOD FORK 3241" from memory, so a manual entry is
    // routinely all name and no reference until a statement is imported.
    expect(displayName({ payee: '', title: 'Dinner out' })).toBe('Dinner out')
    expect(displayName({ payee: '' })).toBe('No description')
  })

  it('keys a rule on the reference, falling back to the name', () => {
    expect(matchKey({ payee: 'SQ *THE GOOD FORK 3241', title: 'Dinner out' })).toBe('SQ *THE GOOD FORK 3241')
    expect(matchKey({ payee: '  ', title: 'Dinner out' })).toBe('Dinner out')
    expect(matchKey({})).toBe('')
  })

  it('stores a name as one trimmed line, or as nothing at all', () => {
    expect(cleanTitle('  Dinner   out \n')).toBe('Dinner out')
    expect(cleanTitle('')).toBeUndefined()
    expect(cleanTitle(undefined)).toBeUndefined()
    // The ceiling mirrors the server's check constraint, so a long name is
    // shortened here rather than dead-lettering a minute later.
    expect(cleanTitle('x'.repeat(200))).toHaveLength(80)
  })

  it('asks the category and the name as two separate questions', () => {
    // The trap this exists for: a title-only rule for the more specific payee
    // would otherwise win "the matching rule" outright and the fuel would
    // silently stop being categorised.
    const general = rule('tesco', 'groceries')
    const specific = rule('tesco petrol', undefined, 'Petrol')
    const rules = [general, specific]

    expect(categoryRule('TESCO PETROL LEEDS', rules)?.id).toBe(general.id)
    expect(titleRule('TESCO PETROL LEEDS', rules)?.id).toBe(specific.id)
    // And a rule that only files does not claim to name anything.
    expect(titleRule('TESCO STORES 3241', rules)).toBeUndefined()
  })

  it('gives a name-only rule no coverage, because applying one rewrites categories', () => {
    const r = rule('the good fork', undefined, 'Dinner out')
    const txns = [txn({ payee: 'SQ *THE GOOD FORK 3241', categoryId: 'other' })]

    expect(coverageOf(r, txns, [r])).toEqual({ all: [], changed: [] })
  })

  it('learns a name from history, on income as well as spending', () => {
    const matcher = buildTitleMatcher([
      txn({ payee: 'FPI SMITH J LTD REF 88213', amountMinor: 250000, title: 'Salary' }),
      txn({ payee: 'TESCO STORES 3241', categoryId: 'groceries' }),
    ])

    expect(matcher('FPI SMITH J LTD REF 90114')).toBe('Salary')
    expect(matcher('TESCO STORES 3241')).toBeUndefined()
  })

  it('offers the rows from this payee that are not called this already', () => {
    const txns = [
      txn({ id: 'self', payee: 'SQ *THE GOOD FORK 3241', title: 'Dinner out' }),
      txn({ payee: 'SQ *THE GOOD FORK 9902' }),
      txn({ payee: 'SQ *THE GOOD FORK 1120', title: 'Dinner out' }),
      // Income and transfer legs are included, unlike `similarTo`: a bank
      // string is at its least readable exactly there.
      txn({ payee: 'SQ *THE GOOD FORK 8891', amountMinor: 4520 }),
      txn({ payee: 'Pizza Express' }),
    ]

    const found = unnamedLike('SQ *THE GOOD FORK 3241', 'Dinner out', txns, 'self')

    expect(found.map((t) => t.payee)).toEqual(['SQ *THE GOOD FORK 9902', 'SQ *THE GOOD FORK 8891'])
  })
})

describe('learning and applying a name', () => {
  beforeEach(async () => {
    await db.open()
    await db.transactions.clear()
    await db.rules.clear()
    await db.outbox.clear()
  })

  it('learning a name does not forget a category, or the other way round', async () => {
    await learnRule('TESCO STORES 3241', { categoryId: 'groceries' })
    await learnRule('Tesco Stores', { title: 'Big shop' })

    const rules = await db.rules.toArray()
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ match: 'tesco stores', categoryId: 'groceries', title: 'Big shop' })
  })

  it('does not write a rule that says nothing', async () => {
    await learnRule('TESCO STORES 3241', {})
    await learnRule('TESCO STORES 3241', { title: '  ' })

    expect(await db.rules.count()).toBe(0)
  })

  it('renames only what the caller may edit, and queues every change', async () => {
    const mine = txn({ payee: 'SQ *THE GOOD FORK 3241', createdBy: 'me' })
    const theirs = txn({ payee: 'SQ *THE GOOD FORK 9902', createdBy: 'them' })
    await db.transactions.bulkPut([mine, theirs])

    const res = await applyTitle([mine, theirs], 'Dinner out', (t) => t.createdBy === 'me')

    expect(res).toEqual({ updated: 1, skipped: 1 })
    expect((await db.transactions.get(mine.id))?.title).toBe('Dinner out')
    expect((await db.transactions.get(theirs.id))?.title).toBeUndefined()
    expect(await db.outbox.count()).toBe(1)
  })
})
