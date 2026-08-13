import { describe, it, expect } from 'vitest'
import { drillTo, narrows, pathWithState, readDrill } from './drill'

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
