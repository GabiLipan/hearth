import { describe, expect, it } from 'vitest'
import type { Account } from './db'
import { byOrder, keyboardTarget, move, writesFor } from './accountOrder'

const acct = (id: string, sortOrder = 0, name = id): Account =>
  ({ id, name, kind: 'current', sortOrder, updatedAt: '2026-01-01T00:00:00Z' }) as Account

/** The state every household is in before anybody drags anything. */
const zeroed = ['current', 'joint', 'savings', 'card'].map((id) => acct(id))

describe('byOrder', () => {
  it('reads by stored position first', () => {
    const list = [acct('b', 2), acct('a', 1)]
    expect([...list].sort(byOrder).map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('breaks the all-zero tie by name rather than by id', () => {
    // Every account starts at 0, so this is what a list looks like until the
    // first drag. Alphabetical is arbitrary; uuid order is arbitrary AND
    // unstable across a delete and recreate.
    expect([...zeroed].sort(byOrder).map((a) => a.id)).toEqual(['card', 'current', 'joint', 'savings'])
  })
})

describe('move', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves a row down, the gap counted against the rows still on screen', () => {
    expect(move(ids, 'a', 3)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves a row up', () => {
    expect(move(ids, 'd', 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('takes a row to either end', () => {
    expect(move(ids, 'c', 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(move(ids, 'b', 4)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('returns the list unchanged for a drop that changes nothing', () => {
    // Identity, not equality: the caller decides whether to write by comparing
    // references, the same contract categoryTree's `move` has.
    expect(move(ids, 'b', 1)).toBe(ids)
    expect(move(ids, 'b', 2)).toBe(ids)
    expect(move(ids, 'nobody', 0)).toBe(ids)
  })
})

describe('writesFor', () => {
  it('numbers every row by its position in the whole list', () => {
    expect(writesFor(['savings', 'card', 'current', 'joint'], zeroed)).toEqual([
      { id: 'card', patch: { sortOrder: 1 } },
      { id: 'current', patch: { sortOrder: 2 } },
      { id: 'joint', patch: { sortOrder: 3 } },
    ])
  })

  it('leaves a row already sitting on its number alone', () => {
    const settled = ['a', 'b', 'c'].map((id, i) => acct(id, i))
    expect(writesFor(['a', 'c', 'b'], settled)).toEqual([
      { id: 'c', patch: { sortOrder: 1 } },
      { id: 'b', patch: { sortOrder: 2 } },
    ])
  })

  it('ignores an id with no account behind it', () => {
    expect(writesFor(['ghost'], zeroed)).toEqual([])
  })
})

describe('keyboardTarget', () => {
  const ids = ['a', 'b', 'c']

  it('steps up and down, and stops at the ends', () => {
    expect(keyboardTarget(ids, 'b', 'up')).toBe(0)
    expect(keyboardTarget(ids, 'b', 'down')).toBe(3)
    expect(keyboardTarget(ids, 'a', 'up')).toBeNull()
    expect(keyboardTarget(ids, 'c', 'down')).toBeNull()
  })

  it('agrees with `move` about what a press does', () => {
    const up = keyboardTarget(ids, 'c', 'up')
    expect(move(ids, 'c', up!)).toEqual(['a', 'c', 'b'])
    const down = keyboardTarget(ids, 'a', 'down')
    expect(move(ids, 'a', down!)).toEqual(['b', 'a', 'c'])
  })
})
