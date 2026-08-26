import { describe, expect, it } from 'vitest'
import {
  armsOnLift,
  fromPanel,
  scrolled,
  TIP_ACTION_LINGER_MS,
  TIP_LINGER_MS,
  TIP_PANEL_ATTR,
  TIP_SLOP,
  type TouchStart,
} from './useTouchTooltip'

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

/**
 * Telling the panel from the chart, which is what decides whether a touch is a
 * new gesture or a press on the thing already open.
 *
 * The failure it exists for is not a near miss: a touch on the button bubbles
 * to the chart's own `onPointerDown`, that handler disarms, the panel unmounts
 * under the finger, and the browser has nothing left to fire a `click` at — so
 * the button could never be pressed at all, however carefully.
 */
describe('fromPanel', () => {
  /** A stand-in for a DOM node: this repo's tests run in node, with no DOM. */
  const node = (hit: boolean) => ({ closest: (sel: string) => (hit && sel === `[${TIP_PANEL_ATTR}]` ? {} : null) })

  it('is true for anything inside the panel', () => {
    expect(fromPanel(node(true))).toBe(true)
  })

  it('is false for the chart underneath it', () => {
    expect(fromPanel(node(false))).toBe(false)
  })

  it('is false rather than throwing for a target that is not an element', () => {
    expect(fromPanel(null)).toBe(false)
    expect(fromPanel(undefined)).toBe(false)
    expect(fromPanel({})).toBe(false)
    // The document itself is a real target for a pointer event and has no `closest`.
    expect(fromPanel({ nodeType: 9 })).toBe(false)
  })
})

/**
 * A panel with a button in it has to outlast NOTICING the button, which the
 * reading linger was never measured for.
 */
describe('the linger', () => {
  it('is longer where there is something to press', () => {
    expect(TIP_ACTION_LINGER_MS).toBeGreaterThan(TIP_LINGER_MS)
  })
})
