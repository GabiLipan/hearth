import { describe, expect, it } from 'vitest'
import { contrast, inkOn, luminance, DARK_INK, LIGHT_INK } from './ink'
import { shade } from './shade'

/** The twelve slots, both themes, exactly as `index.css` defines them. */
const LIGHT = [
  '#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948',
  '#e87ba4', '#eb6834', '#0b8ba3', '#a344c4', '#6b8a15', '#8a6244',
]
const DARK = [
  '#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767',
  '#d55181', '#d95926', '#29a8c4', '#b866d8', '#8fae2e', '#a8794f',
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
  it('finds that most of the palette wants dark ink, and how many differs by theme', () => {
    expect(LIGHT.filter((f) => inkOn(f).dark)).toHaveLength(8)
    expect(DARK.filter((f) => inkOn(f).dark)).toHaveLength(11)
    // The one that flips: forest green takes white on a light screen and black
    // on a dark one. A written-down table would have to carry both.
    expect(inkOn('#4a3aa7').dark).toBe(false)
    expect(inkOn('#3987e5').dark).toBe(true)
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
