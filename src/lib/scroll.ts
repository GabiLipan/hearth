/**
 * The element the app scrolls, and the reason it is not the document.
 *
 * Scrolling past the end of a page on iOS rubber-bands the whole layout
 * viewport, and `position: fixed` resolves against that viewport — so the
 * bottom tab bar left the bottom of the screen on every bounce and came back
 * when the band settled. It was not positioned wrongly; the thing it was
 * positioned against moved. Two cheap fixes were tried and reverted: killing
 * the bounce (`overscroll-behavior-y: none` on the root — it works, and no
 * bounce is worse than a moving bar) and correcting the bar in JS from
 * `visualViewport` (the band is compositor-driven and the correction is a
 * main-thread event, so the bar chases it a frame behind and reads as shaking).
 *
 * So the document no longer scrolls. `Layout` is a frame exactly one viewport
 * tall that never scrolls at all, with one scrolling column inside it. That
 * column rubber-bands natively — real bounce, real momentum, on flicks as well
 * as drags, because it is iOS doing it and not an imitation — while the bars
 * sit OUTSIDE it and cannot move, because nothing they are positioned against
 * ever moves.
 *
 * The price is this module. Anything that used to read or write the document's
 * scroll has to come through here, because `window.scrollY` is now permanently
 * 0 and `window.scrollTo` is a no-op — and both fail silently, which is the
 * trap: a call left behind still compiles, still runs, and simply does nothing.
 */

/** Also used as the CSS hook, so the frame and the lock cannot disagree. */
export const APP_SCROLLER_ID = 'app-scroll'

/**
 * Null before `Layout` has mounted, and in tests, where there is no document.
 * Callers treat that as "nothing to scroll" rather than falling back to the
 * window: a silent fallback would put the old behaviour back on exactly the
 * paths this module exists to move.
 */
export function appScroller(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById(APP_SCROLLER_ID)
}

/** How far the app has scrolled. The replacement for `window.scrollY`. */
export function appScrollY(): number {
  return appScroller()?.scrollTop ?? 0
}

/** And sideways, for the drag geometry that freezes boxes in scroller coordinates. */
export function appScrollX(): number {
  return appScroller()?.scrollLeft ?? 0
}

export function scrollAppTo(options: ScrollToOptions) {
  appScroller()?.scrollTo(options)
}

/**
 * Bring an element to `offset` below the top of the scroller.
 *
 * The arithmetic lives here because it is the one place the change of scroller
 * is not a rename: `rect.top + window.scrollY` was a document coordinate, and
 * the equivalent has to subtract the scroller's own position on screen before
 * adding its scroll. It happens to be 0 in this layout, at every width, which
 * is exactly why it is worth measuring rather than assuming — a frame that
 * grows a banner above the scroller would break it silently and only in the
 * jump, which is the kind of thing nobody notices for a month.
 */
export function scrollAppToElement(el: Element, offset = 0, behavior: ScrollBehavior = 'smooth') {
  const scroller = appScroller()
  if (!scroller) return
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - offset
  scroller.scrollTo({ top, behavior })
}

/** Used by the drag auto-scroll, which nudges by a delta every frame. */
export function scrollAppBy(x: number, y: number) {
  appScroller()?.scrollBy(x, y)
}

/**
 * Subscribe to the app's scroll. Returns its own cleanup.
 *
 * A scroll event does not bubble, so this has to be bound to the scroller
 * itself — `window` would never hear it. (`Popover` is the exception that still
 * listens on `window`: it uses the CAPTURE phase, which does reach a scroll on
 * any descendant, and it wants sideways scrolls of the filter bar too.)
 */
export function onAppScroll(fn: () => void): () => void {
  const el = appScroller()
  if (!el) return () => {}
  el.addEventListener('scroll', fn, { passive: true })
  return () => el.removeEventListener('scroll', fn)
}
