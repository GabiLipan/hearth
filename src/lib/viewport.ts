/**
 * The arithmetic behind `useViewportInset`, kept apart from the hook so it can
 * be asserted against numbers rather than against a browser.
 *
 * Every value here is a correction: the distance between where a fixed element
 * has been put and where the person holding the phone can actually see. They
 * are all zero on a desktop browser, and all zero on a phone that is sitting
 * still with no keyboard up, which is why getting one wrong is invisible until
 * somebody is mid-gesture.
 */
export type Viewport = { height: number; offsetTop: number }

export type Inset = {
  height: number
  top: number
  /** What an open keyboard covers, measured from the bottom of the layout viewport. */
  keyboard: number
  /** The screen carrying on past the bottom of the layout viewport. Pushes down. */
  below: number
  /** The rubber band carrying the viewport away underneath a fixed element. Pulls up. */
  bounce: number
}

/**
 * A keyboard and a bounce move the visible area the same way and by the same
 * sign. The only thing that separates them is WHICH measurement moved: a
 * keyboard takes height from the visual viewport, a bounce leaves the height
 * alone and changes the offset.
 *
 * A pixel of tolerance because `height` is fractional on a scaled display, and
 * an exact comparison would read a rounding error as a keyboard — which is the
 * failure that matters, since it silently switches the correction off.
 */
const FULL_HEIGHT_TOLERANCE = 1

export function viewportInset(vv: Viewport, innerHeight: number): Inset {
  const drift = vv.height + vv.offsetTop - innerHeight
  const fullHeight = innerHeight - vv.height <= FULL_HEIGHT_TOLERANCE
  return {
    height: vv.height,
    top: vv.offsetTop,
    keyboard: Math.max(0, innerHeight - vv.height - vv.offsetTop),
    below: Math.max(0, drift),
    // Only ever negative, and never while the keyboard is up — without the
    // height test this is the keyboard's own height, and the tab bar climbs it.
    bounce: fullHeight ? Math.min(0, drift) : 0,
  }
}
