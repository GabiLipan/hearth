import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { stickyGet, stickyReset, stickySet, stickySubscribe } from './sticky'

/**
 * A stand-in for `sessionStorage`, which node does not have.
 *
 * Deliberately a real object rather than a mock: the point of most of these
 * tests is what survives a reload, and that only means anything if something
 * is genuinely written and read back.
 */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage
}

/** Install a storage, replacing whatever the last test left behind. */
function useStorage(get: () => Storage) {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get })
}

beforeEach(() => {
  const storage = fakeStorage()
  useStorage(() => storage)
  stickyReset()
})

afterEach(() => {
  stickyReset()
})

describe('sticky values', () => {
  it('gives the fallback when nothing has been stored', () => {
    expect(stickyGet('filters', null)).toBe(null)
    expect(stickyGet('count', 7)).toBe(7)
  })

  it('remembers what was set', () => {
    stickySet('cats', ['a', 'b'])
    expect(stickyGet<string[] | null>('cats', null)).toEqual(['a', 'b'])
  })

  it('returns the SAME reference until it changes', () => {
    // `useSyncExternalStore` spins if the snapshot is a new object every read.
    stickySet('cats', ['a'])
    expect(stickyGet('cats', null)).toBe(stickyGet('cats', null))
  })

  it('survives the page being thrown away and rebuilt', () => {
    stickySet('cats', ['a', 'b'])
    const written = globalThis.sessionStorage.getItem('hearth.cats')

    // A reload: the module's in-memory cache is gone, the tab's storage is not.
    stickyReset()
    const reopened = fakeStorage()
    reopened.setItem('hearth.cats', written!)
    useStorage(() => reopened)

    expect(stickyGet<string[] | null>('cats', null)).toEqual(['a', 'b'])
  })

  it('tells its subscribers, and only about their own key', () => {
    let cats = 0
    let accounts = 0
    stickySubscribe('cats', () => (cats += 1))
    stickySubscribe('accounts', () => (accounts += 1))
    stickySet('cats', ['a'])
    expect(cats).toBe(1)
    expect(accounts).toBe(0)
  })

  it('says nothing when the value has not actually changed', () => {
    const same = ['a']
    stickySet('cats', same)
    let called = 0
    stickySubscribe('cats', () => (called += 1))
    stickySet('cats', same)
    expect(called).toBe(0)
  })

  it('stops telling a subscriber that has unsubscribed', () => {
    let called = 0
    const off = stickySubscribe('cats', () => (called += 1))
    off()
    stickySet('cats', ['a'])
    expect(called).toBe(0)
  })

  it('keeps working when there is no storage at all', () => {
    // Safari in private browsing throws on access. A filter is not worth a
    // white screen, so it degrades to remembering only within this page.
    useStorage(() => {
      throw new Error('denied')
    })
    expect(() => stickySet('cats', ['a'])).not.toThrow()
    expect(stickyGet<string[] | null>('cats', null)).toEqual(['a'])
  })

  it('starts from the fallback when the stored value is not readable', () => {
    globalThis.sessionStorage.setItem('hearth.cats', '{ not json')
    expect(stickyGet('cats', null)).toBe(null)
  })

  it('leaves other people’s keys alone when it clears', () => {
    globalThis.sessionStorage.setItem('someone-else', 'keep me')
    stickySet('cats', ['a'])
    stickyReset()
    expect(globalThis.sessionStorage.getItem('someone-else')).toBe('keep me')
    expect(globalThis.sessionStorage.getItem('hearth.cats')).toBe(null)
  })
})
