import { describe, expect, it } from 'vitest'
import {
  contrast,
  faceInk,
  inkOn,
  luminance,
  needsRing,
  DARK_INK,
  GRAPHIC_CONTRAST,
  LIGHT_INK,
  RING_BELOW,
} from './ink'
import { shade } from './shade'

/** The twelve slots, both themes, exactly as `index.css` defines them. */
const LIGHT = [
  '#3984e4', '#169f4b', '#a77d00', '#0093b3', '#8270df', '#d55550',
  '#c95492', '#c86600', '#019993', '#af5fc0', '#838d00', '#9d7e63',
]
const DARK = [
  '#529af9', '#3fb462', '#c19100', '#00abcf', '#9787f5', '#eb6d67',
  '#e06ca7', '#e27b21', '#02b1aa', '#c476d6', '#98a401', '#b39377',
]

describe('contrast', () => {
  it('is 21 for black on white and 1 for a colour on itself', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#2a78d6', '#2a78d6')).toBeCloseTo(1, 5)
  })

  it('is symmetric and accepts three-digit hex', () => {
    expect(contrast('#fff', '#000')).toBeCloseTo(contrast('#000', '#fff'), 10)
    expect(contrast('#fff', '#ffffff')).toBeCloseTo(1, 10)
  })

  it('treats an unreadable colour as no contrast rather than throwing', () => {
    expect(luminance('var(--series-1)')).toBeNull()
    expect(contrast('var(--series-1)', '#ffffff')).toBe(1)
  })
})

describe('inkOn', () => {
  it('picks the ink with more contrast, on every slot in both themes', () => {
    for (const fill of [...LIGHT, ...DARK]) {
      const { color } = inkOn(fill)
      const other = color === LIGHT_INK ? DARK_INK : LIGHT_INK
      expect(contrast(color, fill)).toBeGreaterThanOrEqual(contrast(other, fill))
    }
  })

  /**
   * The whole reason this is computed rather than written down: white is the
   * wrong answer far more often than not, and how often depends on the theme.
   */
  it('wants dark ink on every slot, in both themes', () => {
    expect(LIGHT.filter((f) => inkOn(f).dark)).toHaveLength(12)
    expect(DARK.filter((f) => inkOn(f).dark)).toHaveLength(12)
  })

  /**
   * Unanimity is the POINT of cutting the twelve at one lightness, and it is
   * also the fragile part: a slot re-tuned darker flips its label to white
   * while the eleven beside it stay black, and a row of tiles then reads as two
   * kinds of thing. The old palette split 8/12 one way and 11/12 the other,
   * which is why `inkOn` computes rather than looks up — that has not changed,
   * and a custom colour still arrives here as an arbitrary hex.
   */
  it('still answers per fill, for a colour that was never in the palette', () => {
    expect(inkOn('#0b0b0b').dark).toBe(false)
    expect(inkOn('#f4f4f4').dark).toBe(true)
  })

  /**
   * The claim `CategoryMosaic` rests on: a label may be written straight onto
   * any fill in the palette. If a slot is ever re-tuned, this is what says so.
   */
  it('clears AA on every fill in the palette, both themes', () => {
    for (const fill of [...LIGHT, ...DARK]) {
      expect(contrast(inkOn(fill).color, fill), fill).toBeGreaterThanOrEqual(4.5)
    }
  })

  /**
   * And on the shades `lib/shade.ts` invents to tell two categories on one slot
   * apart — which are the colours no palette review would ever look at.
   */
  it('clears AA on shaded variants too', () => {
    for (const fill of [...LIGHT, ...DARK]) {
      for (let n = 0; n < 4; n++) {
        const shaded = shade(fill, n)
        expect(contrast(inkOn(shaded).color, shaded), shaded).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('the mark on an account tile', () => {
  /**
   * The whole point of the solid tile, stated as the thing that used to fail.
   *
   * A bank's navy on the old recipe was the icon in that navy on a 16% mix of
   * it into the surface, which in the dark theme is a dark mark on a nearly
   * black tile. On a solid tile the same colour gets white, measured.
   */
  it('gives a dark brand colour a legible mark rather than itself', () => {
    const navy = '#0a2d5e'
    expect(faceInk(navy)).toBe(LIGHT_INK)
    expect(contrast(faceInk(navy), navy)).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST)

    // And the failure it replaces: the mark WAS the fill, so there was nothing
    // to measure and no contrast to have.
    expect(contrast(navy, navy)).toBeCloseTo(1, 5)
  })

  it('clears the graphic bar on every fill in the palette, both themes', () => {
    // The claim that makes "Auto" the default rather than a suggestion. AA for
    // a graphic is 3:1; the palette clears 4.5 already, so this is the floor
    // that matters for the twelve and it is nowhere near it.
    for (const fill of [...LIGHT, ...DARK]) {
      expect(contrast(faceInk(fill), fill), fill).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST)
    }
  })

  it('lets a deliberate choice through, legible or not', () => {
    // "Navy on white" is the case measurement cannot reach — it is a decision,
    // and the form measures it and says so rather than refusing it.
    const navy = '#0a2d5e'
    expect(faceInk('#ffffff')).toBe(DARK_INK)
    expect(faceInk('#ffffff', navy)).toBe(navy)

    // Faint, and still honoured.
    expect(faceInk('#0b1c33', navy)).toBe(navy)
    expect(contrast('#0b1c33', navy)).toBeLessThan(GRAPHIC_CONTRAST)
  })

  it('ignores an override that is not a colour', () => {
    // Belt and braces for a value that reached the cache before the check
    // constraint existed, or from a client that sent a token by mistake.
    expect(faceInk('#0a2d5e', 'var(--ink)')).toBe(LIGHT_INK)
    expect(faceInk('#0a2d5e', '')).toBe(LIGHT_INK)
  })

  /**
   * The one failure a free background introduces, and the only one: a tile the
   * colour of the card it sits on has no edge to see.
   */
  it('asks for a ring only where the tile has no edge of its own', () => {
    expect(needsRing('#ffffff', '#ffffff')).toBe(true)
    expect(needsRing('#fdfdfd', '#ffffff')).toBe(true)
    expect(needsRing('#0a2d5e', '#ffffff')).toBe(false)
    // From the other end, which is why this is measured rather than a test for
    // white: the dark theme's near-black has exactly the same problem.
    expect(needsRing('#111111', '#0e0e0e')).toBe(true)
    expect(needsRing('#ffffff', '#0e0e0e')).toBe(false)
    // A merely PALE tile keeps its edge and gets no ring — a ring on one of
    // those is visible as a ring, and these are meant to read as marks. The
    // threshold sits between this and `#e8e8e8`, which at 1.23:1 is faint
    // enough that a square with no outline reads as an icon floating in a row.
    expect(contrast('#d4d4d4', '#ffffff')).toBeGreaterThan(RING_BELOW)
    expect(needsRing('#d4d4d4', '#ffffff')).toBe(false)
    expect(needsRing('#e8e8e8', '#ffffff')).toBe(true)
  })
})
