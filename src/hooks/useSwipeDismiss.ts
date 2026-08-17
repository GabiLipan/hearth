import { useEffect, useRef, useState, type RefObject } from 'react'
import { motionOk } from '../components/ui'

/** How far down before a release dismisses rather than springs back. */
const DISMISS_PX = 96
/** …or how fast, so a short flick counts. Pixels per millisecond. */
const DISMISS_VELOCITY = 0.55
/** Movement before the gesture commits to being a drag at all. */
const SLOP = 8
/** How long the panel takes to finish leaving once the finger has let go. */
const OUT_MS = 220

/**
 * Anything a downward drag inside must not be read as "close this".
 *
 * A component opts out by marking a subtree; nothing does yet, but a slider or
 * a vertically-draggable list would need it, and finding that out the hard way
 * means a control that silently dismisses the sheet it lives in.
 */
const OPT_OUT = '[data-no-swipe]'

/**
 * Whether a drag starting here would be stealing the gesture from a scroller.
 *
 * Walks up from whatever was touched to the panel itself, and refuses if
 * anything on the way is scrolled away from its top. That is the whole rule:
 * you can pull a sheet down only from a point where pulling down would
 * otherwise do nothing. Halfway down a long form the same gesture is a scroll,
 * and it stays one.
 *
 * Checked per gesture rather than once, because which scroller you are over
 * depends on where your finger landed — a sheet can hold a scrolling list
 * inside a scrolling body.
 */
function stealsFromScroller(target: Element | null, root: HTMLElement): boolean {
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue
    if (el.matches(OPT_OUT)) return true
    const overflowY = getComputedStyle(el).overflowY
    const scrolls = overflowY === 'auto' || overflowY === 'scroll'
    if (scrolls && el.scrollHeight > el.clientHeight && el.scrollTop > 0.5) return true
    if (el === root) break
  }
  return false
}

/**
 * Pull a panel down to dismiss it.
 *
 * Touch only, deliberately: this is `touchstart`/`touchmove` rather than
 * pointer events, and not because pointer events would not fire. It is that the
 * gesture has to be able to `preventDefault` the moment it commits, or iOS
 * rubber-bands the scroller underneath the finger while the panel is also
 * moving — two things travelling at once, one of which nobody asked for. A
 * passive listener cannot do that, and pointer events are passive by default on
 * touch. Which also gives "mobile only" for free: a mouse never gets here.
 *
 * The transform is written straight to the node rather than held in state.
 * A finger produces events faster than React will re-render, and the whole
 * point of a drag is that the panel is under the finger rather than a frame or
 * two behind it.
 *
 * Returns `dismissing`, which the caller MUST use to suppress its own exit
 * animation. A CSS animation beats an inline style for the properties it
 * animates, so a panel that keyframes its own `transform` on the way out would
 * snap back to the top and leave from there — the one jump this is meant to
 * remove.
 */
export function useSwipeDismiss({
  panel,
  enabled,
  onDismiss,
}: {
  panel: RefObject<HTMLElement | null>
  enabled: boolean
  onDismiss: () => void
}): { dismissing: boolean } {
  const [dismissing, setDismissing] = useState(false)
  // Held in a ref so the listeners below never need re-attaching mid-gesture.
  const fire = useRef(onDismiss)
  fire.current = onDismiss
  // Read inside the listeners rather than closed over, so committing to an
  // exit does not re-run the effect — whose cleanup would wipe the transform
  // the exit is animating.
  const going = useRef(false)

  useEffect(() => {
    if (!enabled) {
      going.current = false
      setDismissing(false)
    }
  }, [enabled])

  useEffect(() => {
    const el = panel.current
    if (!el || !enabled) return

    let startY = 0
    let startX = 0
    let lastY = 0
    let lastT = 0
    let velocity = 0
    let active = false
    let decided = false

    const move = (y: number) => {
      // Only reachable once the gesture has committed downward, so `y < 0` is
      // a finger that pulled the panel down and is now taking it back past
      // where it started. Resisted rather than blocked: the panel gives a
      // little, so it feels attached to something rather than jammed.
      el.style.transform = `translateY(${y < 0 ? y / 4 : y}px)`
    }

    const settle = () => {
      el.style.transition = ''
      if (!motionOk()) {
        el.style.transform = ''
        return
      }
      const back = el.animate(
        [{ transform: el.style.transform }, { transform: 'translateY(0px)' }],
        { duration: 260, easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)' },
      )
      el.style.transform = ''
      // The keyframes hold the old position for the duration; clearing the
      // inline style underneath them is what the animation lands on.
      back.addEventListener('cancel', () => { el.style.transform = '' })
    }

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || going.current) return
      const t = e.touches[0]
      if (stealsFromScroller(e.target as Element, el)) return
      startY = lastY = t.clientY
      startX = t.clientX
      lastT = e.timeStamp
      velocity = 0
      active = true
      decided = false
    }

    const onMove = (e: TouchEvent) => {
      if (!active) return
      const t = e.touches[0]
      const dy = t.clientY - startY
      const dx = t.clientX - startX

      if (!decided) {
        if (Math.abs(dy) < SLOP && Math.abs(dx) < SLOP) return
        // Predominantly vertical, or it is a sideways gesture — a chip row, a
        // wide table — and none of our business.
        //
        // And predominantly DOWNWARD. `stealsFromScroller` has already refused
        // a gesture that starts part-way down a scroller, so everything
        // reaching here starts at the top — where an upward drag is the whole
        // of how you read the rest of the page. Without this the gesture
        // committed to either direction and then `preventDefault`ed, so a swipe
        // up from the top of a sheet scrolled nothing and instead dragged the
        // panel a resisted quarter-inch: not a sheet that scrolled badly, a
        // sheet that could not be scrolled at all, since every scroll has to
        // start from the top once.
        if (dy <= 0 || Math.abs(dy) <= Math.abs(dx)) {
          active = false
          return
        }
        decided = true
      }

      // Committed. Stop the scroller underneath from also moving.
      if (e.cancelable) e.preventDefault()
      const dt = e.timeStamp - lastT
      if (dt > 0) velocity = (t.clientY - lastY) / dt
      lastY = t.clientY
      lastT = e.timeStamp
      move(dy)
    }

    const onEnd = () => {
      if (!active) return
      const travelled = lastY - startY
      active = false
      if (!decided) return
      if (travelled > DISMISS_PX || velocity > DISMISS_VELOCITY) {
        going.current = true
        setDismissing(true)
        // Carry on in the direction the finger was already going, from where it
        // let go, then hand over. The caller's own exit is suppressed for
        // exactly this reason — see the note above.
        if (motionOk()) {
          el.animate(
            [{ transform: `translateY(${travelled}px)` }, { transform: `translateY(${el.offsetHeight + 40}px)` }],
            { duration: OUT_MS, easing: 'cubic-bezier(0.4, 0, 0.9, 0.4)', fill: 'forwards' },
          )
        }
        fire.current()
        return
      }
      settle()
    }

    // The system taking the gesture away is not a drop — put it back.
    const onCancel = () => { active = false; settle() }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onCancel, { passive: true })

    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onCancel)
      el.style.transform = ''
      el.style.transition = ''
    }
  }, [panel, enabled])

  return { dismissing }
}
