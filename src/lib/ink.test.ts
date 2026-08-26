import { describe, expect, it } from 'vitest'
import {
  bendToContrast,
  contrast,
  faceInk,
  inkOn,
  lineOn,
  luminance,
  needsRing,
  withLightness,
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

/**
 * The two grounds a line beside a balance is ever drawn on, exactly as
 * `index.css` defines `--surface`.
 */
const LIGHT_SURFACE = '#fcfcfb'
const DARK_SURFACE = '#1a1a19'

describe('withLightness', () => {
  it('keeps the hue and moves the lightness', () => {
    const lighter = withLightness('#3984e4', 0.85)!
    expect(luminance(lighter)!).toBeGreaterThan(luminance('#3984e4')!)
    // Still blue: the blue channel leads and the red trails, as before.
    const [r, , b] = [1, 3, 5].map((i) => parseInt(lighter.slice(i, i + 2), 16))
    expect(b).toBeGreaterThan(r)
  })

  it('is its own inverse to within a rounding step', () => {
    for (const hex of [...LIGHT, ...DARK, '#ffffff', '#1434cb']) {
      const there = withLightness(hex, 0.5)!
      const back = withLightness(there, luminanceOfOklch(hex))!
      expect(contrast(back, hex)).toBeLessThan(1.06)
    }
  })

  /** A saturated hue does not exist at every lightness; the chroma gives way. */
  it('stays inside sRGB at both ends', () => {
    for (const l of [0.02, 0.35, 0.98]) {
      const hex = withLightness('#c19100', l)!
      expect(hex).toMatch(/^#[0-9a-f]{6}$/)
      expect(luminance(hex)).not.toBeNull()
    }
  })

  it('has nothing to say about a colour it cannot read', () => {
    expect(withLightness('var(--series-1)', 0.5)).toBeNull()
  })
})

/** `withLightness` round-trips through OKLCh lightness, which is not luminance. */
function luminanceOfOklch(hex: string): number {
  // The lightness the colour already has, recovered by bisection rather than by
  // exporting the conversion: the test is about the pair of functions, not the
  // internals.
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (luminance(withLightness(hex, mid)!)! < luminance(hex)!) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

describe('bendToContrast', () => {
  it('leaves a colour that already clears the bar exactly as it was', () => {
    for (const fill of LIGHT) {
      expect(bendToContrast(fill, LIGHT_SURFACE, GRAPHIC_CONTRAST)).toBe(fill)
    }
  })

  it('rescues the two colours a bank card actually brings', () => {
    // A white card on a white row, and a navy one in the dark theme.
    for (const [hex, ground] of [
      ['#ffffff', LIGHT_SURFACE],
      ['#0a1f44', DARK_SURFACE],
    ]) {
      expect(contrast(hex, ground)).toBeLessThan(GRAPHIC_CONTRAST)
      const bent = bendToContrast(hex, ground, GRAPHIC_CONTRAST)
      expect(contrast(bent, ground)).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST)
    }
  })

  /**
   * The point of bending lightness rather than picking a legible colour: the
   * hue that says whose line it is survives.
   */
  it('keeps the hue it was given', () => {
    const bent = bendToContrast('#0a1f44', DARK_SURFACE, GRAPHIC_CONTRAST)
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(bent.slice(i, i + 2), 16))
    expect(b).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(r)
  })

  it('moves no further than it has to', () => {
    const min = bendToContrast('#0a1f44', DARK_SURFACE, GRAPHIC_CONTRAST)
    const more = bendToContrast('#0a1f44', DARK_SURFACE, 7)
    expect(luminance(min)!).toBeLessThan(luminance(more)!)
  })

  /** A mid-grey ground has nothing at 7:1 against it; the best there is beats none. */
  it('hands back its best attempt rather than nothing when the bar cannot be met', () => {
    const bent = bendToContrast('#808080', '#808080', 7)
    expect(luminance(bent)).not.toBeNull()
    expect(contrast(bent, '#808080')).toBeGreaterThan(1)
  })
})

describe('lineOn', () => {
  it('keeps the tile colour wherever the tile colour is legible, even where black beats it', () => {
    for (const [fills, ground] of [
      [LIGHT, LIGHT_SURFACE],
      [DARK, DARK_SURFACE],
    ] as const) {
      for (const fill of fills) {
        expect(lineOn(fill, faceInk(fill), ground)).toBe(fill)
      }
    }
  })

  it('takes the mark where the tile is the colour of the row', () => {
    // A white card in the light theme: the tile is invisible, the mark is not.
    expect(lineOn('#ffffff', faceInk('#ffffff'), LIGHT_SURFACE)).toBe(DARK_INK)
    // And the same from the other end, in the dark theme.
    expect(lineOn('#111111', faceInk('#111111'), DARK_SURFACE)).toBe(LIGHT_INK)
  })

  it('clears the bar for every palette slot and every ground, both themes', () => {
    for (const [fills, ground] of [
      [LIGHT, LIGHT_SURFACE],
      [DARK, DARK_SURFACE],
    ] as const) {
      for (const fill of fills) {
        expect(contrast(lineOn(fill, faceInk(fill), ground), ground)).toBeGreaterThanOrEqual(
          GRAPHIC_CONTRAST,
        )
      }
    }
  })

  /**
   * The case neither half of the pair can answer: a chosen ink as dim as the
   * tile it sits on, on a ground close to both.
   */
  it('bends when neither the tile nor its mark will do', () => {
    const fill = '#c2c2c2'
    const ink = '#b6b6b6'
    expect(contrast(fill, LIGHT_SURFACE)).toBeLessThan(GRAPHIC_CONTRAST)
    expect(contrast(ink, LIGHT_SURFACE)).toBeLessThan(GRAPHIC_CONTRAST)
    expect(contrast(lineOn(fill, ink, LIGHT_SURFACE), LIGHT_SURFACE)).toBeGreaterThanOrEqual(
      GRAPHIC_CONTRAST,
    )
  })
})
