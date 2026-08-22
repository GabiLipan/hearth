import { describe, expect, it } from 'vitest'
import { SLOTS, SLOT_COUNT, SLOT_NAMES, SWATCH_ORDER, isHexColour, nextFreeSlot, paintHex, paintOf, slotVar, tokenHex } from './palette'

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

describe('resolving a paint to something measurable', () => {
  /**
   * `inkOn` measures contrast and so needs a colour it can parse, and
   * `slotVar` hands back `var(--series-3)` — which only the browser's style
   * resolution can read. These tests run in node, where there is no document,
   * so this is the "cannot measure" path: every caller needs a behaviour for
   * it, and for `Face` that is the tint it drew before any of this existed. A
   * face that is quieter than intended, never one that is invisible.
   */
  it('is undefined for a slot off the DOM, rather than a token nothing can read', () => {
    expect(paintHex(1, undefined, 'light')).toBeUndefined()
    expect(paintHex(undefined, undefined, 'light')).toBeUndefined()
    expect(tokenHex('--series-1', 'light')).toBeUndefined()
  })

  /**
   * A custom colour needs no resolving at all, which is the case that matters:
   * it is the one that could not be painted legibly before, and it is
   * measurable everywhere, document or not.
   */
  it('answers a custom colour without touching the document', () => {
    expect(paintHex(1, '#0A2D5E', 'light')).toBe('#0a2d5e')
    expect(paintHex(undefined, '#0a2d5e', 'dark')).toBe('#0a2d5e')
  })

  it('ignores a colour that is not one, and falls back to the slot', () => {
    // The same reasoning as `isHexColour`: a value that is not six hex digits
    // is a half-typed field or something that should never have reached here,
    // and painting with it would put an arbitrary string into `background:`.
    expect(paintHex(1, 'var(--series-1)', 'light')).toBeUndefined()
    expect(paintHex(1, '#7c6', 'light')).toBeUndefined()
  })
})
