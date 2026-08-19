import { describe, expect, it } from 'vitest'
import { armsOnLift, scrolled, TIP_SLOP, type TouchStart } from './useTouchTooltip'

/**
 * The rule that decides whether a touch on a chart is a press or a scroll.
 *
 * Every chart in the app sits inside a scrolling page, and the panel used to
 * open on `pointerdown` — so a flick that happened to start on a chart left a
 * tooltip sitting over it while you scrolled somewhere else. These are the two
 * decisions that stopped it, tested here rather than in the hook because this
 * repo has no DOM test environment.
 */
const start = (over: Partial<TouchStart> = {}): TouchStart => ({ x: 100, y: 100, dead: false, ...over })

describe('is this touch a press or a scroll', () => {
  it('lets a finger wobble', () => {
    // A thumb on glass never holds perfectly still, and refusing a press
    // because it moved three pixels is a chart that cannot be read.
    expect(scrolled(start(), 103, 97)).toBe(false)
    expect(scrolled(start(), 100 + TIP_SLOP, 100 + TIP_SLOP)).toBe(false)
  })

  it('calls travel in either direction a scroll', () => {
    expect(scrolled(start(), 100, 100 + TIP_SLOP + 1)).toBe(true)
    expect(scrolled(start(), 100 + TIP_SLOP + 1, 100)).toBe(true)
    // Backwards too: a page can be flicked either way.
    expect(scrolled(start(), 100, 100 - TIP_SLOP - 1)).toBe(true)
  })
})

describe('does lifting the finger open the panel', () => {
  it('opens on an ordinary tap', () => {
    expect(armsOnLift(start())).toBe(true)
  })

  it('stays shut once the gesture has been ruled out', () => {
    // The half that matters: the END of a flick must not open a tooltip over
    // the chart you have just scrolled past. Once dead, always dead.
    expect(armsOnLift(start({ dead: true }))).toBe(false)
  })

  it('and there is nothing to open without a touch at all', () => {
    expect(armsOnLift(null)).toBe(false)
  })
})
