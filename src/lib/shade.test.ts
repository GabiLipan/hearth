import { describe, expect, it } from 'vitest'
import { distinctShades, hexToHsl, hslToHex, shade } from './shade'

/** Perceptual-enough distance for "these read as different colours". */
const lightnessOf = (hex: string) => hexToHsl(hex)!.l

describe('hex ↔ hsl', () => {
  it('round-trips the palette', () => {
    // Every colour the app actually ships, light theme and dark.
    const palette = [
      '#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948',
      '#e87ba4', '#eb6834', '#0b8ba3', '#a344c4', '#6b8a15', '#8a6244',
      '#3987e5', '#199e70', '#c98500', '#9085e9', '#e66767', '#d55181',
      '#d95926', '#29a8c4', '#b866d8', '#8fae2e', '#a8794f',
    ]
    for (const hex of palette) {
      const { h, s, l } = hexToHsl(hex)!
      const back = hslToHex(h, s, l)
      // Within one step per channel: the conversion is lossy at 8 bits.
      for (let i = 1; i < 7; i += 2) {
        const a = parseInt(hex.slice(i, i + 2), 16)
        const b = parseInt(back.slice(i, i + 2), 16)
        expect(Math.abs(a - b)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('handles short form and greys', () => {
    expect(hexToHsl('#fff')).toEqual({ h: 0, s: 0, l: 1 })
    expect(hexToHsl('#000')).toEqual({ h: 0, s: 0, l: 0 })
  })

  it('returns null for anything that is not a hex colour', () => {
    // `useChartColors` resolves the tokens before they get here, but a variable
    // that failed to resolve would arrive as an empty string, and guessing at
    // one would paint a slice black.
    expect(hexToHsl('')).toBeNull()
    expect(hexToHsl('var(--series-3)')).toBeNull()
    expect(hexToHsl('rgb(1,2,3)')).toBeNull()
  })
})

describe('shade', () => {
  const green = '#1baf7a'

  it('leaves the first user of a slot completely alone', () => {
    // The commonest case by far, and the one that must not change: a category's
    // colour is recognised across screens.
    expect(shade(green, 0)).toBe(green)
  })

  it('keeps the hue', () => {
    // Moving the hue would make a green look like another category's colour,
    // which is worse than two greens.
    const base = hexToHsl(green)!
    for (const n of [1, 2, 3, 4]) {
      expect(Math.abs(hexToHsl(shade(green, n))!.h - base.h)).toBeLessThan(2)
    }
  })

  it('fans out around the original rather than drifting from it', () => {
    const base = lightnessOf(green)
    expect(lightnessOf(shade(green, 1))).toBeGreaterThan(base)
    expect(lightnessOf(shade(green, 2))).toBeLessThan(base)
    expect(lightnessOf(shade(green, 3))).toBeGreaterThan(lightnessOf(shade(green, 1)))
  })

  it('is stable as more shades are asked for', () => {
    // `shade(hex, n)` must not depend on how many shades the caller will
    // eventually want, or a slice would change colour when an unrelated
    // category was added to the chart.
    const first = [0, 1, 2, 3, 4].map((n) => shade(green, n))
    const again = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => shade(green, n))
    expect(again.slice(0, 5)).toEqual(first)
  })

  it('keeps six shades of one colour apart', () => {
    const ls = [0, 1, 2, 3, 4, 5].map((n) => lightnessOf(shade(green, n)))
    for (let i = 0; i < ls.length; i++) {
      for (let j = i + 1; j < ls.length; j++) {
        expect(Math.abs(ls[i] - ls[j])).toBeGreaterThan(0.05)
      }
    }
  })

  it('stays legible against both surfaces, even from an extreme base', () => {
    // The ladder never leaves the range, so this holds by construction rather
    // than by clamping afterwards — which is the point: a clamp would keep the
    // colour legible and make two of them identical.
    for (const base of ['#008300', '#eda100', '#0b1b0f', '#f2fff6']) {
      for (const n of [1, 2, 3, 4, 5, 6]) {
        const l = lightnessOf(shade(base, n))
        expect(l).toBeGreaterThanOrEqual(0.21)
        expect(l).toBeLessThanOrEqual(0.81)
      }
    }
  })

  it('gives an extreme base distinct shades rather than piling them on an edge', () => {
    // The case that broke the first version of this: clamping, or reflecting,
    // hands out a lightness that has already been used the moment the fan
    // reaches an edge.
    for (const base of ['#0b1b0f', '#f2fff6', '#008300']) {
      const ls = [0, 1, 2, 3, 4, 5].map((n) => lightnessOf(shade(base, n)))
      expect(new Set(ls.map((l) => l.toFixed(3))).size).toBe(6)
    }
  })
})

describe('distinctShades', () => {
  const colourOf = (c: { colour: string }) => c.colour

  it('changes nothing when every colour is already different', () => {
    const items = [{ colour: '#2a78d6' }, { colour: '#1baf7a' }, { colour: '#eda100' }]
    expect(distinctShades(items, colourOf)).toEqual(['#2a78d6', '#1baf7a', '#eda100'])
  })

  it('leaves the first of a colliding pair untouched and moves the second', () => {
    // Order is the caller's, and the donut sorts biggest first — so the slice
    // the eye goes to keeps the colour it has everywhere else.
    const out = distinctShades([{ colour: '#1baf7a' }, { colour: '#1baf7a' }], colourOf)
    expect(out[0]).toBe('#1baf7a')
    expect(out[1]).not.toBe('#1baf7a')
  })

  it('tells four of the same colour apart', () => {
    const items = Array.from({ length: 4 }, () => ({ colour: '#1baf7a' }))
    expect(new Set(distinctShades(items, colourOf)).size).toBe(4)
  })

  it('counts each colour separately', () => {
    const items = [
      { colour: '#1baf7a' }, { colour: '#2a78d6' }, { colour: '#1baf7a' }, { colour: '#2a78d6' },
    ]
    const out = distinctShades(items, colourOf)
    expect(out[0]).toBe('#1baf7a')
    expect(out[1]).toBe('#2a78d6')
    expect(out[2]).not.toBe(out[0])
    expect(out[3]).not.toBe(out[1])
    expect(new Set(out).size).toBe(4)
  })

  it('is stable — the same input gives the same colours every render', () => {
    const items = [{ colour: '#1baf7a' }, { colour: '#1baf7a' }, { colour: '#eda100' }]
    expect(distinctShades(items, colourOf)).toEqual(distinctShades(items, colourOf))
  })
})
