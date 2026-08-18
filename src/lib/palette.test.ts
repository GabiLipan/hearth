import { describe, expect, it } from 'vitest'
import { SLOTS, SLOT_COUNT, SLOT_NAMES, SWATCH_ORDER, isHexColour, nextFreeSlot, paintOf, slotVar } from './palette'

describe('SWATCH_ORDER', () => {
  /**
   * The order the picker OFFERS the twelve in, which is not the order they are
   * stored in. A slot missing from here is a colour that exists on rows in the
   * database and cannot be chosen, and a repeated one is the same colour
   * offered twice — both look like a rendering fault rather than a wrong list,
   * so nothing else in the app would report them.
   */
  it('is every slot exactly once', () => {
    expect([...SWATCH_ORDER].sort((a, b) => a - b)).toEqual(SLOTS)
    expect(new Set(SWATCH_ORDER).size).toBe(SLOT_COUNT)
  })

  it('names every slot it offers', () => {
    for (const s of SWATCH_ORDER) expect(SLOT_NAMES[s]).toBeTruthy()
  })
})

describe('paintOf', () => {
  it('resolves a slot to its token', () => {
    expect(paintOf(3)).toBe(slotVar(3))
  })

  it('prefers a colour of its own', () => {
    expect(paintOf(3, '#7c6cf0')).toBe('#7c6cf0')
  })

  /**
   * An account nobody has styled reaches this with no slot at all — the caller
   * is meant to have gone through `accountFace`, and a bare `undefined` must
   * still paint something rather than `var(--series-undefined)`, which resolves
   * to nothing and renders the badge invisible.
   */
  it('falls back to the first slot rather than an invalid token', () => {
    expect(paintOf(undefined)).toBe(slotVar(1))
  })
})

describe('isHexColour', () => {
  it('accepts six digits in either case, with the hash', () => {
    expect(isHexColour('#7c6cf0')).toBe(true)
    expect(isHexColour('#7C6CF0')).toBe(true)
    expect(isHexColour('  #7c6cf0  ')).toBe(true)
  })

  /**
   * The value is written straight into `background:` and stored in a column
   * whose check constraint says exactly this, so anything else is either a
   * half-typed field or something that should never have got as far as the
   * outbox. Three-digit shorthand is refused rather than expanded: the server
   * would reject it, and a value arriving short means it skipped this path.
   */
  it('refuses everything else', () => {
    expect(isHexColour('7c6cf0')).toBe(false)
    expect(isHexColour('#7c6')).toBe(false)
    expect(isHexColour('#7c6cf')).toBe(false)
    expect(isHexColour('rebeccapurple')).toBe(false)
    expect(isHexColour('var(--series-1)')).toBe(false)
    expect(isHexColour('#7c6cf0; background: url(x)')).toBe(false)
  })
})

describe('nextFreeSlot', () => {
  it('gives the least-used slot', () => {
    expect(nextFreeSlot([])).toBe(1)
    expect(nextFreeSlot(SLOTS.filter((s) => s !== 5))).toBe(5)
  })
})
