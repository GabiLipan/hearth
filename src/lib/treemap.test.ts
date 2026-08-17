import { describe, expect, it } from 'vitest'
import { squarify, type Tile } from './treemap'

const area = (t: Tile) => t.w * t.h
const overlaps = (a: Tile, b: Tile) =>
  a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6

/** Every tile inside the box, none overlapping, and the whole box used up. */
function tilesBox(values: number[], w: number, h: number) {
  const tiles = squarify(values, w, h)
  const live = tiles.filter((t) => t.w > 0 && t.h > 0)
  for (const t of live) {
    expect(t.x).toBeGreaterThanOrEqual(-1e-6)
    expect(t.y).toBeGreaterThanOrEqual(-1e-6)
    expect(t.x + t.w).toBeLessThanOrEqual(w + 1e-6)
    expect(t.y + t.h).toBeLessThanOrEqual(h + 1e-6)
  }
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++)
      expect(overlaps(live[i], live[j]), `tiles ${i} and ${j} overlap`).toBe(false)
  expect(live.reduce((s, t) => s + area(t), 0)).toBeCloseTo(w * h, 4)
  return tiles
}

describe('squarify', () => {
  it('gives a single value the whole box', () => {
    expect(squarify([500], 200, 100)).toEqual([{ x: 0, y: 0, w: 200, h: 100 }])
  })

  it('fills the box exactly, without overlaps', () => {
    tilesBox([780, 412, 186, 142, 96, 68], 320, 200)
    tilesBox([1], 50, 400)
    tilesBox([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 300, 300)
  })

  it('makes area proportional to value', () => {
    const values = [780, 412, 186, 142, 96, 68]
    const total = values.reduce((s, v) => s + v, 0)
    const tiles = tilesBox(values, 320, 200)
    tiles.forEach((t, i) => {
      expect(area(t) / (320 * 200)).toBeCloseTo(values[i] / total, 6)
    })
  })

  /**
   * The reason this file exists rather than a proportional slice: the smallest
   * of six categories must still be something a finger can hit and a name can
   * sit in, and slicing a 320px box gives it a 13px column.
   */
  it('keeps the smallest tile from becoming a splinter', () => {
    const tiles = squarify([780, 412, 186, 142, 96, 68], 320, 200)
    for (const t of tiles) {
      expect(Math.min(t.w, t.h)).toBeGreaterThan(24)
      expect(Math.max(t.w, t.h) / Math.min(t.w, t.h)).toBeLessThan(6)
    }
  })

  it('returns tiles in the caller’s order, not biggest first', () => {
    const tiles = squarify([10, 90], 100, 100)
    expect(area(tiles[0])).toBeCloseTo(1000, 6)
    expect(area(tiles[1])).toBeCloseTo(9000, 6)
  })

  /**
   * A zero-size tile rather than a missing one: dropping it would shift every
   * index after it, and the caller zips this straight onto its own list.
   */
  it('gives nothing to values that are zero or negative, keeping alignment', () => {
    const tiles = squarify([100, 0, -5, 100], 100, 100)
    expect(tiles).toHaveLength(4)
    expect(area(tiles[1])).toBe(0)
    expect(area(tiles[2])).toBe(0)
    expect(area(tiles[0])).toBeCloseTo(5000, 6)
    expect(area(tiles[3])).toBeCloseTo(5000, 6)
  })

  it('survives an empty list and a box with no size', () => {
    expect(squarify([], 100, 100)).toEqual([])
    expect(squarify([1, 2], 0, 100)).toEqual([
      { x: 0, y: 0, w: 0, h: 0 },
      { x: 0, y: 0, w: 0, h: 0 },
    ])
    // The width a card has before it has been measured. Nothing may divide by it.
    expect(squarify([1, 2], 300, 0).every((t) => t.w === 0 && t.h === 0)).toBe(true)
    expect(squarify([0, 0], 100, 100).every((t) => t.w === 0 && t.h === 0)).toBe(true)
  })
})
