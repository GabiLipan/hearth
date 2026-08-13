import { describe, it, expect } from 'vitest'
import { drillTo, matchesDrill, narrows, pathWithState, readDrill } from './drill'
import type { Category, Transaction } from './db'

const read = (query: string) => readDrill(new URLSearchParams(query))

describe('drillTo', () => {
  it('writes only what was asked for', () => {
    expect(drillTo({ month: '2026-07', book: 'household', category: 'c1' })).toBe(
      '/activity?book=household&month=2026-07&category=c1',
    )
  })

  it('is a plain path when there is nothing to say', () => {
    expect(drillTo({})).toBe('/activity')
  })

  it('survives a round trip', () => {
    const drill = {
      book: 'mine' as const,
      from: '2026-01-01',
      to: '2026-03-31',
      payee: 'Tesco Stores',
      backTo: '/reports?period=year',
      backLabel: 'Reports',
    }
    expect(read(drillTo(drill).split('?')[1])).toEqual(drill)
  })
})

describe('readDrill', () => {
  it('drops a book it does not recognise', () => {
    expect(read('book=theirs').book).toBeUndefined()
    expect(read('book=mine').book).toBe('mine')
  })

  it('drops a month that is not one', () => {
    expect(read('month=july').month).toBeUndefined()
    expect(read('month=2026-7').month).toBeUndefined()
    expect(read('month=2026-07').month).toBe('2026-07')
  })

  it('takes a range only when both ends are dates', () => {
    expect(read('from=2026-01-01').from).toBeUndefined()
    expect(read('from=2026-01-01&to=nonsense').from).toBeUndefined()
    expect(read('from=2026-01-01&to=2026-01-31')).toMatchObject({ from: '2026-01-01', to: '2026-01-31' })
  })

  it('refuses to send you off the site', () => {
    expect(read('backTo=https://example.com&backLabel=Reports').backTo).toBeUndefined()
    expect(read('backTo=//example.com').backTo).toBeUndefined()
    expect(read('backTo=/reports').backTo).toBe('/reports')
  })

  it('names the way back even when the sender did not', () => {
    expect(read('backTo=/reports').backLabel).toBe('where you were')
  })

  it('ignores empty params rather than filtering on nothing', () => {
    expect(read('category=&payee=&month=')).toEqual({})
  })
})

describe('narrows', () => {
  it('is false for a lens with no question in it', () => {
    expect(narrows({ book: 'household' })).toBe(false)
    expect(narrows({ backTo: '/reports', backLabel: 'Reports' })).toBe(false)
  })

  it('is true for anything that hides rows', () => {
    expect(narrows({ month: '2026-07' })).toBe(true)
    expect(narrows({ payee: 'Tesco' })).toBe(true)
    expect(narrows({ from: '2026-01-01', to: '2026-01-31' })).toBe(true)
  })
})

describe('pathWithState', () => {
  it('drops what is empty, so an unremarkable page is a plain path', () => {
    expect(pathWithState('/reports', { month: undefined, period: '' })).toBe('/reports')
  })

  it('carries what there is', () => {
    expect(pathWithState('/reports', { month: '2026-07', period: 'year' })).toBe('/reports?month=2026-07&period=year')
  })
})

describe('matchesDrill', () => {
  const cats = new Map<string, Category>([
    ['food', { id: 'food', name: 'Food', kind: 'expense', sortOrder: 1, updatedAt: '' }],
    ['pubs', { id: 'pubs', name: 'Pubs', kind: 'expense', sortOrder: 2, parentId: 'food', updatedAt: '' }],
    ['rent', { id: 'rent', name: 'Rent', kind: 'expense', sortOrder: 3, updatedAt: '' }],
  ])
  const txn = (over: Partial<Transaction> = {}): Transaction => ({
    id: 't1',
    date: '2026-07-14',
    payee: 'Tesco Stores 4471',
    amountMinor: -1200,
    accountId: 'a1',
    categoryId: 'food',
    createdAt: '2026-07-14T00:00:00Z',
    updatedAt: '2026-07-14T00:00:00Z',
    ...over,
  })

  it('takes everything when the drill narrows nothing', () => {
    expect(matchesDrill(txn(), {}, cats)).toBe(true)
    expect(matchesDrill(txn(), { book: 'household' }, cats)).toBe(true)
  })

  it('matches a month by the row‘s own date', () => {
    expect(matchesDrill(txn(), { month: '2026-07' }, cats)).toBe(true)
    expect(matchesDrill(txn(), { month: '2026-06' }, cats)).toBe(false)
  })

  it('matches a range inclusively at both ends', () => {
    const drill = { from: '2026-07-14', to: '2026-07-14' }
    expect(matchesDrill(txn(), drill, cats)).toBe(true)
    expect(matchesDrill(txn({ date: '2026-07-13' }), drill, cats)).toBe(false)
    expect(matchesDrill(txn({ date: '2026-07-15' }), drill, cats)).toBe(false)
  })

  // The rule budgets, the donut and the report slices all share: a
  // subcategory's spending belongs to its parent.
  it('counts a subcategory towards its parent', () => {
    expect(matchesDrill(txn({ categoryId: 'pubs' }), { category: 'food' }, cats)).toBe(true)
    expect(matchesDrill(txn({ categoryId: 'pubs' }), { category: 'pubs' }, cats)).toBe(true)
    expect(matchesDrill(txn({ categoryId: 'rent' }), { category: 'food' }, cats)).toBe(false)
  })

  it('excludes an uncategorised row from a category drill', () => {
    expect(matchesDrill(txn({ categoryId: undefined }), { category: 'food' }, cats)).toBe(false)
  })

  // The same fuzzy grouping `topPayees` shows, or the list would add up to less
  // than the row that was pressed.
  it('matches a payee the way the top-payee list groups them', () => {
    expect(matchesDrill(txn(), { payee: 'Tesco' }, cats)).toBe(true)
    expect(matchesDrill(txn({ payee: 'TESCO EXPRESS' }), { payee: 'Tesco Stores' }, cats)).toBe(true)
    expect(matchesDrill(txn({ payee: 'Sainsburys' }), { payee: 'Tesco' }, cats)).toBe(false)
  })

  it('matches an account exactly', () => {
    expect(matchesDrill(txn(), { account: 'a1' }, cats)).toBe(true)
    expect(matchesDrill(txn(), { account: 'a2' }, cats)).toBe(false)
  })

  it('is an AND of everything it was given', () => {
    const drill = { month: '2026-07', category: 'food', payee: 'Tesco' }
    expect(matchesDrill(txn(), drill, cats)).toBe(true)
    expect(matchesDrill(txn({ date: '2026-08-01' }), drill, cats)).toBe(false)
  })
})
