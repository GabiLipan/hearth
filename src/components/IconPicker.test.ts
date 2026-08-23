import { describe, expect, it } from 'vitest'
import { customInkSeed, isCustomInk } from './IconPicker'
import { DARK_INK, LIGHT_INK } from '../lib/ink'

/**
 * The thirteenth swatch in `InkPicker` opens a disclosure, and the disclosure
 * is conditioned on the ink being a third answer rather than one of the two
 * swatches beside it. So the colour the button COMMITS when it opens has to be
 * one — seeded from the current ink, as it was, the button was dead on exactly
 * the accounts whose mark was already white or black.
 */
describe('isCustomInk', () => {
  it('is false for the two the swatches beside it already offer', () => {
    expect(isCustomInk(LIGHT_INK)).toBe(false)
    expect(isCustomInk(DARK_INK)).toBe(false)
  })

  it('is false for nothing at all, and for something unparseable', () => {
    expect(isCustomInk(undefined)).toBe(false)
    expect(isCustomInk('#7c6')).toBe(false)
    expect(isCustomInk('navy')).toBe(false)
  })

  it('is true for a colour of your own', () => {
    expect(isCustomInk('#0a2d5e')).toBe(true)
  })
})

describe('customInkSeed', () => {
  it('always hands back something the disclosure will show', () => {
    for (const draft of [undefined, '', LIGHT_INK, DARK_INK, '#7c6', '#0a2d5e']) {
      expect(isCustomInk(customInkSeed(draft))).toBe(true)
    }
  })

  it('keeps a custom draft rather than resetting it', () => {
    expect(customInkSeed('#0a2d5e')).toBe('#0a2d5e')
  })
})
