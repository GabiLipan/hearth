import { describe, expect, it } from 'vitest'
import type { Category } from './db'
import { blockLength, flatten, keyboardTarget, move, writesFor, type TreeRow } from './categoryTree'

/**
 * The rules being pinned here are the database's, restated on the client so a
 * drop the server would refuse is never offered. If one of these ever fails,
 * check `categories_hierarchy_guard` and `categories_top_level_has_style` in
 * migration 04 first — this file is the mirror, not the original.
 */

let n = 0
const cat = (over: Partial<Category> & { id: string }): Category => ({
  name: over.id,
  kind: 'expense',
  sortOrder: n++,
  updatedAt: '2026-01-01T00:00:00Z',
  ...(over.parentId ? {} : { icon: 'tag', slot: 1 }),
  ...over,
})

/** Food[Groceries, Takeaway] · Home[Rent] · Travel — plus income Salary[Bonus]. */
function tree(): Category[] {
  n = 0
  return [
    cat({ id: 'food', icon: 'cart', slot: 2 }),
    cat({ id: 'groceries', parentId: 'food' }),
    cat({ id: 'takeaway', parentId: 'food' }),
    cat({ id: 'home', icon: 'house', slot: 5 }),
    cat({ id: 'rent', parentId: 'home' }),
    cat({ id: 'travel', icon: 'car', slot: 8 }),
    cat({ id: 'salary', kind: 'income', icon: 'coins', slot: 4 }),
    cat({ id: 'bonus', kind: 'income', parentId: 'salary' }),
  ]
}

const shape = (rows: TreeRow[]) => rows.map((r) => `${'  '.repeat(r.depth)}${r.id}`).join('\n')

describe('flatten', () => {
  it('puts spending first, each parent followed by its own children', () => {
    expect(shape(flatten(tree()))).toBe(
      ['food', '  groceries', '  takeaway', 'home', '  rent', 'travel', 'salary', '  bonus'].join('\n'),
    )
  })

  it('reads the stored order, not the order rows arrive in', () => {
    const rows = tree().map((c) => (c.id === 'travel' ? { ...c, sortOrder: -1 } : c))
    expect(flatten(rows)[0].id).toBe('travel')
  })
})

describe('blockLength', () => {
  it('counts a parent and its children', () => {
    expect(blockLength(flatten(tree()), 0)).toBe(3)
  })
  it('is one for a subcategory', () => {
    expect(blockLength(flatten(tree()), 1)).toBe(1)
  })
})

describe('move', () => {
  const rows = () => flatten(tree())

  it('reorders subcategories within a parent', () => {
    expect(shape(move(rows(), 'takeaway', { index: 1, depth: 1 }))).toContain('  takeaway\n  groceries')
  })

  it('moves a subcategory to a different parent', () => {
    const next = move(rows(), 'groceries', { index: 5, depth: 1 })
    expect(shape(next)).toBe(
      ['food', '  takeaway', 'home', '  rent', '  groceries', 'travel', 'salary', '  bonus'].join('\n'),
    )
  })

  it('promotes a subcategory to top level', () => {
    const next = move(rows(), 'groceries', { index: 6, depth: 0 })
    expect(shape(next)).toBe(
      ['food', '  takeaway', 'home', '  rent', 'travel', 'groceries', 'salary', '  bonus'].join('\n'),
    )
  })

  it('demotes a childless top-level category', () => {
    const next = move(rows(), 'travel', { index: 3, depth: 1 })
    expect(shape(next)).toBe(
      ['food', '  groceries', '  takeaway', '  travel', 'home', '  rent', 'salary', '  bonus'].join('\n'),
    )
  })

  it('takes the children along when a parent moves', () => {
    const next = move(rows(), 'food', { index: 6, depth: 0 })
    expect(shape(next)).toBe(
      ['home', '  rent', 'travel', 'food', '  groceries', '  takeaway', 'salary', '  bonus'].join('\n'),
    )
  })

  it('refuses to make a parent with children into a subcategory', () => {
    // Dropped in the middle of Home's family, asking for depth 1.
    const next = move(rows(), 'food', { index: 5, depth: 1 })
    expect(next.find((r) => r.id === 'food')?.depth).toBe(0)
    expect(shape(next)).toContain('food\n  groceries\n  takeaway')
  })

  it('never separates a parent from its children', () => {
    // Travel, top level, aimed squarely between Groceries and Takeaway.
    const next = move(rows(), 'travel', { index: 2, depth: 0 })
    expect(shape(next)).toContain('food\n  groceries\n  takeaway')
  })

  it('clamps a spending category dragged into the income list', () => {
    const next = move(rows(), 'travel', { index: 8, depth: 0 })
    expect(shape(next)).toBe(
      ['food', '  groceries', '  takeaway', 'home', '  rent', 'travel', 'salary', '  bonus'].join('\n'),
    )
  })

  it('clamps an income subcategory dragged into the spending list, without promoting it', () => {
    const next = move(rows(), 'bonus', { index: 1, depth: 1 })
    expect(next.find((r) => r.id === 'bonus')?.kind).toBe('income')
    expect(shape(next)).toContain('salary\n  bonus')
  })

  it('never lets a drag change a category’s kind', () => {
    const start = rows()
    for (const id of start.map((r) => r.id)) {
      for (const index of [0, 3, 5, 8]) {
        for (const depth of [0, 1] as const) {
          const next = move(start, id, { index, depth })
          expect(next.map((r) => r.kind).join()).toBe(
            'expense,expense,expense,expense,expense,expense,income,income',
          )
        }
      }
    }
  })

  it('returns the same array when nothing would change', () => {
    const start = rows()
    expect(move(start, 'groceries', { index: 1, depth: 1 })).toBe(start)
  })

  it('is a no-op for an unknown id', () => {
    const start = rows()
    expect(move(start, 'nope', { index: 0, depth: 0 })).toBe(start)
  })
})

describe('writesFor', () => {
  it('writes nothing when nothing moved', () => {
    const rows = tree()
    expect(writesFor(flatten(rows), rows)).toEqual([])
  })

  it('gives a promoted subcategory the style it was already drawing with', () => {
    const rows = tree()
    // Groceries inherits Food's cart/2; promoted, it must carry them itself or
    // categories_top_level_has_style rejects the row.
    const patches = writesFor(move(flatten(rows), 'groceries', { index: 6, depth: 0 }), rows)
    const groceries = patches.find((p) => p.id === 'groceries')!
    expect(groceries.patch.parentId).toBeUndefined()
    expect('parentId' in groceries.patch).toBe(true)
    expect(groceries.patch.icon).toBe('cart')
    expect(groceries.patch.slot).toBe(2)
  })

  it('clears a demoted category’s style so it inherits its new parent', () => {
    const rows = tree()
    const patches = writesFor(move(flatten(rows), 'travel', { index: 3, depth: 1 }), rows)
    const travel = patches.find((p) => p.id === 'travel')!
    expect(travel.patch.parentId).toBe('food')
    expect('icon' in travel.patch).toBe(true)
    expect(travel.patch.icon).toBeUndefined()
    expect(travel.patch.slot).toBeUndefined()
  })

  it('re-parents onto the category above, not the one it used to belong to', () => {
    const rows = tree()
    const patches = writesFor(move(flatten(rows), 'groceries', { index: 5, depth: 1 }), rows)
    expect(patches.find((p) => p.id === 'groceries')!.patch.parentId).toBe('home')
  })

  it('touches only the rows whose position actually changed', () => {
    const rows = tree()
    const patches = writesFor(move(flatten(rows), 'takeaway', { index: 1, depth: 1 }), rows)
    expect(patches.map((p) => p.id).sort()).toEqual(['groceries', 'takeaway'])
    expect(patches.every((p) => 'sortOrder' in p.patch)).toBe(true)
  })

  it('leaves no two rows claiming the same position', () => {
    const rows = tree()
    const next = move(flatten(rows), 'food', { index: 6, depth: 0 })
    const byId = new Map(rows.map((c) => [c.id, c.sortOrder]))
    for (const { id, patch } of writesFor(next, rows)) {
      if ('sortOrder' in patch) byId.set(id, patch.sortOrder as number)
    }
    const orders = [...byId.values()]
    expect(new Set(orders).size).toBe(orders.length)
  })
})

describe('keyboardTarget', () => {
  const rows = () => flatten(tree())

  it('steps a top-level category over the whole family above it', () => {
    const next = move(rows(), 'home', keyboardTarget(rows(), 'home', 'up')!)
    expect(shape(next)).toBe(
      ['home', '  rent', 'food', '  groceries', '  takeaway', 'travel', 'salary', '  bonus'].join('\n'),
    )
  })

  it('steps a top-level category down past the next whole family', () => {
    const next = move(rows(), 'food', keyboardTarget(rows(), 'food', 'down')!)
    expect(shape(next)).toBe(
      ['home', '  rent', 'food', '  groceries', '  takeaway', 'travel', 'salary', '  bonus'].join('\n'),
    )
  })

  it('swaps two siblings', () => {
    const next = move(rows(), 'takeaway', keyboardTarget(rows(), 'takeaway', 'up')!)
    expect(shape(next)).toContain('food\n  takeaway\n  groceries')
  })

  it('will not step a subcategory above its own parent', () => {
    expect(keyboardTarget(rows(), 'groceries', 'up')).toBeNull()
  })

  it('will not step a subcategory past the end of its family', () => {
    expect(keyboardTarget(rows(), 'takeaway', 'down')).toBeNull()
  })

  it('stops at the ends, and at the boundary between the two kinds', () => {
    expect(keyboardTarget(rows(), 'food', 'up')).toBeNull()
    expect(keyboardTarget(rows(), 'travel', 'down')).toBeNull()
    expect(keyboardTarget(rows(), 'salary', 'up')).toBeNull()
  })
})
