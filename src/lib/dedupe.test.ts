import { describe, expect, it } from 'vitest'
import type { Transaction } from './db'
import { findLikelyDuplicate, flagRepeats, unaccountedFor } from './dedupe'

let seq = 0
const txn = (over: Partial<Transaction> & { payee: string }): Transaction => ({
  id: `t${++seq}`,
  accountId: 'current',
  date: '2026-03-04',
  amountMinor: -4520,
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

describe('finding the entry a statement line is a second copy of', () => {
  it('matches a manual entry with no reference on the amount and the date alone', () => {
    // The whole point of the completion flow: somebody typed "Dinner out" the
    // evening it happened, with no idea what the card machine would call it.
    // There is nothing to compare but the money and the day.
    const manual = txn({ payee: '', title: 'Dinner out', date: '2026-03-02' })

    const found = findLikelyDuplicate(
      { date: '2026-03-04', payee: 'SQ *THE GOOD FORK 3241', amountMinor: -4520 },
      [manual],
    )

    expect(found?.id).toBe(manual.id)
  })

  it('still requires a similar payee where the existing row has one', () => {
    // Loosening the payee test for referenceless rows must not loosen it for
    // everything else, or two £45.20 payments in one week become one.
    const other = txn({ payee: 'PIZZA EXPRESS', date: '2026-03-02' })

    expect(
      findLikelyDuplicate({ date: '2026-03-04', payee: 'SQ *THE GOOD FORK 3241', amountMinor: -4520 }, [other]),
    ).toBeUndefined()
  })

  it('will not reach past the date window, however little it has to go on', () => {
    const manual = txn({ payee: '', title: 'Dinner out', date: '2026-02-20' })

    expect(
      findLikelyDuplicate({ date: '2026-03-04', payee: 'SQ *THE GOOD FORK 3241', amountMinor: -4520 }, [manual]),
    ).toBeUndefined()
  })

  it('never matches a different amount', () => {
    const manual = txn({ payee: '', title: 'Dinner out', amountMinor: -4500 })

    expect(
      findLikelyDuplicate({ date: '2026-03-04', payee: 'SQ *THE GOOD FORK 3241', amountMinor: -4520 }, [manual]),
    ).toBeUndefined()
  })
})

describe('telling a re-import from the same purchase twice', () => {
  const line = (payee: string, amountMinor: number, date = '2026-03-04') => ({ date, payee, amountMinor })
  const coffee = line('COFFEE HOUSE', -320)

  /**
   * The case that lost money. A statement listing two identical coffees is the
   * bank saying it happened twice; the old check saw the fingerprint a second
   * time and called it "already imported".
   */
  it('brings in both of two identical lines when neither is here', () => {
    const flags = flagRepeats([coffee, coffee], [])
    expect(flags.map((f) => f.duplicate)).toEqual([false, false])
    // And says so on BOTH of them, because it is a fact about the pair.
    expect(flags.map((f) => f.sameInFile)).toEqual([2, 2])
  })

  it('claims one row per line, so two lines against one held row leave one new', () => {
    const held = [txn({ payee: 'COFFEE HOUSE', amountMinor: -320, date: '2026-03-04' })]
    expect(flagRepeats([coffee, coffee], held).map((f) => f.duplicate)).toEqual([true, false])
  })

  it('calls both duplicates when both are already here', () => {
    const held = [
      txn({ payee: 'COFFEE HOUSE', amountMinor: -320, date: '2026-03-04' }),
      txn({ payee: 'COFFEE HOUSE', amountMinor: -320, date: '2026-03-04' }),
    ]
    expect(flagRepeats([coffee, coffee], held).map((f) => f.duplicate)).toEqual([true, true])
  })

  it('re-importing the same file changes nothing', () => {
    const held = [txn({ payee: 'TESCO STORES', amountMinor: -1200, date: '2026-03-04' })]
    const flags = flagRepeats([line('TESCO STORES', -1200)], held)
    expect(flags[0]).toEqual({ duplicate: true, sameInFile: undefined })
  })

  it('leaves an ordinary line alone', () => {
    const flags = flagRepeats([line('BOOTS', -650), line('TESCO STORES', -1200)], [])
    expect(flags).toEqual([
      { duplicate: false, sameInFile: undefined },
      { duplicate: false, sameInFile: undefined },
    ])
  })

  /**
   * The row already here carries the hash it was imported with; a row typed by
   * hand carries none and is fingerprinted on the spot, which is what lets a
   * statement recognise its own earlier import either way.
   */
  it('reads the stored fingerprint where there is one', () => {
    const held = [txn({ payee: 'anything at all', amountMinor: -1, importHash: '2026-03-04|-1200|tesco stores' })]
    expect(flagRepeats([line('TESCO STORES', -1200)], held)[0].duplicate).toBe(true)
  })
})

describe('what the statement does not account for', () => {
  const line = (payee: string, amountMinor: number, date: string) => ({ date, payee, amountMinor })
  const file = [line('TESCO STORES', -1200, '2026-03-01'), line('BOOTS', -650, '2026-03-10')]

  it('finds a row the file never mentions', () => {
    const here = [
      txn({ payee: 'TESCO STORES', amountMinor: -1200, date: '2026-03-01' }),
      txn({ id: 'ghost', payee: 'GHOST', amountMinor: -999, date: '2026-03-05' }),
      txn({ payee: 'BOOTS', amountMinor: -650, date: '2026-03-10' }),
    ]
    expect(unaccountedFor(file, here).map((t) => t.id)).toEqual(['ghost'])
  })

  /**
   * The case that started this: a row imported twice. Counting is what catches
   * it — asking "is this shape in the file?" answers yes for both copies.
   */
  it('finds the extra copy when the app holds more than the file says', () => {
    const here = [
      txn({ id: 'one', payee: 'TESCO STORES', amountMinor: -1200, date: '2026-03-01' }),
      txn({ id: 'two', payee: 'TESCO STORES', amountMinor: -1200, date: '2026-03-01' }),
    ]
    expect(unaccountedFor(file, here).map((t) => t.id)).toEqual(['two'])
  })

  /**
   * Outside the file's own span it says nothing, and silence is not absence —
   * without this, importing one month would offer to delete every other month.
   */
  it('says nothing about rows outside the period the file covers', () => {
    const here = [
      txn({ id: 'before', payee: 'OLD', amountMinor: -100, date: '2026-02-20' }),
      txn({ id: 'after', payee: 'NEW', amountMinor: -100, date: '2026-04-02' }),
    ]
    expect(unaccountedFor(file, here)).toHaveLength(0)
  })

  it('leaves a row the caller has already paired with a line', () => {
    // The wizard's fuzzy match: typed as "Dinner out", called
    // "SQ *THE GOOD FORK 3241" by the bank. Same purchase, different strings.
    const typed = txn({ id: 'typed', payee: '', title: 'Dinner out', amountMinor: -4250, date: '2026-03-04' })
    const withDinner = [...file, line('SQ *THE GOOD FORK 3241', -4250, '2026-03-04')]
    expect(unaccountedFor(withDinner, [typed])).toHaveLength(1)
    expect(unaccountedFor(withDinner, [typed], new Set(['typed']))).toHaveLength(0)
  })

  it('says nothing at all about a file with no readable dates', () => {
    expect(unaccountedFor([], [txn({ payee: 'ANYTHING', amountMinor: -1 })])).toEqual([])
  })
})
