import { describe, it, expect } from 'vitest'
import { viewportInset } from './viewport'

/**
 * A phone, at rest: 844pt tall, nothing covering it, nothing overscrolled.
 * Every case below is this one with a single thing changed.
 */
const SCREEN = 844

describe('viewportInset', () => {
  it('corrects nothing when the viewport is the screen', () => {
    const i = viewportInset({ height: SCREEN, offsetTop: 0 }, SCREEN)
    expect(i).toMatchObject({ keyboard: 0, below: 0, bounce: 0 })
  })

  it('reports what an open keyboard covers', () => {
    // iOS does not shrink the layout viewport for the keyboard, so the visual
    // viewport loses 336pt of height and the page keeps painting behind it.
    const i = viewportInset({ height: SCREEN - 336, offsetTop: 0 }, SCREEN)
    expect(i.keyboard).toBe(336)
  })

  it('does not lift the fixed layer over an open keyboard', () => {
    // The whole point of the height test. The naive `Math.min(0, drift)` is
    // -336 here, and the tab bar climbs the keyboard.
    const i = viewportInset({ height: SCREEN - 336, offsetTop: 0 }, SCREEN)
    expect(i.bounce).toBe(0)
  })

  it('lifts the fixed layer by however far a bounce has carried the viewport', () => {
    // Rubber-banding past the end of a page: full height, shifted offset. The
    // bar is 40pt below the visible bottom, so it comes back up by 40.
    const i = viewportInset({ height: SCREEN, offsetTop: -40 }, SCREEN)
    expect(i.bounce).toBe(-40)
    expect(i.below).toBe(0)
    // `keyboard` reads 40 here, which is a keyboard that is not there. Harmless
    // only because its one consumer is `Sheet`, and an open sheet locks the
    // body's scroll — a page that cannot scroll cannot bounce. Asserted so that
    // stops being a thing somebody rediscovers.
    expect(i.keyboard).toBe(40)
  })

  it('pushes down when the screen carries on past the layout viewport', () => {
    // The opposite correction, and the one that shipped first: anything
    // anchored to `bottom: 0` floats above the bottom of the display.
    const i = viewportInset({ height: SCREEN, offsetTop: 24 }, SCREEN)
    expect(i.below).toBe(24)
    expect(i.bounce).toBe(0)
  })

  it('never applies both corrections at once', () => {
    for (const offsetTop of [-60, -1, 0, 1, 60]) {
      const { below, bounce } = viewportInset({ height: SCREEN, offsetTop }, SCREEN)
      expect(below === 0 || bounce === 0).toBe(true)
    }
  })

  it('reads a sub-pixel height as full height, not as a keyboard', () => {
    // `height` is fractional on a scaled display. An exact comparison switches
    // the bounce correction off for a rounding error — silently, and only on
    // the devices that have one.
    const i = viewportInset({ height: SCREEN - 0.5, offsetTop: -40 }, SCREEN)
    expect(i.bounce).toBeCloseTo(-40.5)
  })

  it('treats a keyboard one pixel past the tolerance as a keyboard', () => {
    const i = viewportInset({ height: SCREEN - 2, offsetTop: 0 }, SCREEN)
    expect(i.bounce).toBe(0)
  })
})
