import { describe, expect, it } from 'vitest'
import { contrast, inkOn, luminance, DARK_INK, LIGHT_INK } from './ink'
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
