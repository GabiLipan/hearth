import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A tooltip that a finger can open, hold, and let go of.
 *
 * A hover has an end — the pointer leaves and the panel goes with it. A tap
 * does not: nothing is "left", so a tooltip opened by a touch stays on screen
 * over the chart it was explaining until something else happens to close it,
 * which on a phone is usually another tap somewhere unrelated. Every chart in
 * the app had this, because every one of them was written against hover.
 *
 * So a touch is given the ending it does not have: while the finger is down the
 * panel stays — that is the whole gesture, press a thin band and read it — and
 * once it lifts the panel waits a few seconds, long enough to read at leisure,
 * then fades out.
 *
 * ## And a beginning, which it did not have either
 *
 * The panel used to open on `pointerdown`. Every chart in the app is inside a
 * scrolling page, so every flick that happened to START on a chart opened a
 * tooltip — you scroll past the ring and arrive somewhere else with a panel
 * sitting over a chart you are no longer looking at. Reported as "I get them
 * every time I tap on a visual and start a scroll", which is exactly what it
 * was.
 *
 * A touch is therefore not a tooltip until it has proved it is not a scroll,
 * and there are two ways to prove it:
 *
 *   - hold still for `HOLD_MS`, or
 *   - lift again without having travelled — an ordinary tap.
 *
 * Either arms the panel; moving more than `SLOP` first kills the gesture for
 * good, and so does the `pointercancel` the browser sends when it takes the
 * touch to scroll with. A mouse is armed from the start, because a hover has
 * never been ambiguous about what it wants.
 *
 * Two things this must NOT do, both of which this codebase has been caught by:
 *
 *   - Decide anything in an animation callback. The fade is CSS, but what makes
 *     the tooltip actually gone is a TIMER: a backgrounded tab never runs a
 *     rAF or a transition, and a panel that only disappears when its fade
 *     finishes would come back to the foreground stranded at half opacity,
 *     still covering the chart.
 *   - Touch a mouse. A pointer that leaves takes its tooltip immediately, as it
 *     always did; the linger is for pointers that cannot leave.
 */

/**
 * How long the panel stays after the finger lifts.
 *
 * Long enough to read a name and an amount, and no longer. It started at 3.6s,
 * which is a comfortable reading time and turns out to be the wrong thing to
 * optimise: the panel sits OVER the chart, so every extra second is a second
 * you cannot see the thing you just pressed, and the gesture is cheap to
 * repeat. Two seconds is short enough that the chart comes back before you have
 * decided you want it.
 */
export const TIP_LINGER_MS = 2000
/** And how long it takes to go. */
export const TIP_FADE_MS = 400
/**
 * How long a finger must hold still before the panel opens under it.
 *
 * A scroll declares itself almost immediately — the finger is travelling within
 * a frame or two — so this only has to outlast the moment of setting off. Short
 * enough that a deliberate press still feels like a press: at a second, which
 * is what a hold "should" be, pressing a band and getting nothing reads as the
 * chart being dead rather than as the app waiting.
 */
export const TIP_HOLD_MS = 400
/**
 * How far a finger may travel and still be a tap rather than a scroll.
 *
 * Generous, because a thumb on glass never holds perfectly still and the cost
 * of being wrong is asymmetric: a tap misread as a scroll shows nothing and can
 * be repeated, while a scroll misread as a tap is the fault being fixed.
 */
export const TIP_SLOP = 10

/** A touch in progress: where it began, and whether it has been ruled out. */
export interface TouchStart {
  x: number
  y: number
  dead: boolean
}

/**
 * Has this touch travelled far enough to be a scroll rather than a press?
 *
 * Pulled out of the hook so the rule can be tested: this repo has no DOM test
 * environment and every test in it is a pure function, so a rule left inside a
 * pointer handler is a rule nothing can check. The handlers are the thin part —
 * they record where a finger landed and ask this.
 */
export function scrolled(start: TouchStart, x: number, y: number): boolean {
  return Math.abs(x - start.x) > TIP_SLOP || Math.abs(y - start.y) > TIP_SLOP
}

/**
 * Does lifting the finger open the panel?
 *
 * Only if the touch was never ruled out — by travelling, or by the browser
 * taking it to scroll with. A gesture that has been killed stays killed for the
 * rest of its life, which is what stops the END of a flick opening a tooltip
 * over the chart you have just scrolled past.
 */
export function armsOnLift(start: TouchStart | null): boolean {
  return !!start && !start.dead
}

type Phase = 'shown' | 'fading' | 'gone'

export interface TouchTooltip {
  /**
   * Whether the last pointer to arrive was a finger.
   *
   * What it decides is where a chart's way THROUGH to the rows behind it
   * lives. On a mouse a click is free — hover already shows the tooltip — so
   * clicking the bar opens the transactions. A tap is not free: it is the
   * gesture that opens the tooltip, and making it also navigate would mean the
   * panel could never be read. So on touch the way through is a button inside
   * the panel, which the linger keeps on screen long enough to press.
   */
  coarse: boolean
  /**
   * What a Recharts `<Tooltip active>` should be: `false` once the linger has
   * run out, `undefined` the rest of the time so Recharts goes on deciding for
   * itself. `false` hides the cursor as well as the panel, which is the half a
   * custom `content` cannot reach.
   */
  active: boolean | undefined
  /** True while the panel is on its way out, for whatever draws it. */
  fading: boolean
  /**
   * Whether the gesture has earned a tooltip.
   *
   * Always true for a mouse. On a finger it is false from the moment of touch
   * until the press has held still or lifted without travelling — so a chart
   * that tracks what is under the pointer itself, rather than letting Recharts
   * do it, must draw nothing until this is true. `Sankey` is the one that does.
   */
  armed: boolean
  /** Bind to the element the pointer lands on. */
  handlers: {
    onPointerDown: (e: { pointerType: string; clientX?: number; clientY?: number }) => void
    onPointerMove: (e: { pointerType?: string; clientX?: number; clientY?: number }) => void
    onPointerUp: (e: { pointerType: string }) => void
    onPointerCancel: (e: { pointerType: string }) => void
  }
  /** The pointer is still here — cancel any pending fade. */
  keep: () => void
}

/**
 * @param onGone Called once the panel is finished, for a chart that draws its
 *   own and has to clear the state behind it.
 */
export function useTouchTooltip(onGone?: () => void): TouchTooltip {
  const [phase, setPhase] = useState<Phase>('shown')
  const [coarse, setCoarse] = useState(false)
  /** Whether this gesture has earned a panel. A mouse starts armed. */
  const [armed, setArmed] = useState(true)
  /**
   * The phase again, readable synchronously: `keep` runs on every pointer move
   * over the chart, and a `setState` per move would re-run every `useMemo`
   * under it.
   */
  const at = useRef<Phase>('shown')
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  /**
   * The touch in progress: where it started, and whether it has already been
   * ruled out. A ref rather than state because it is written on every move and
   * nothing renders from it.
   */
  const touch = useRef<TouchStart | null>(null)
  /** Read at fire time, so a changing callback never re-arms a running fade. */
  const done = useRef(onGone)
  done.current = onGone

  const clear = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }
  const to = (next: Phase) => {
    if (at.current === next) return
    at.current = next
    setPhase(next)
  }

  const keep = useCallback(() => {
    if (timers.current.length > 0) clear()
    to('shown')
  }, [])

  /** Which kind of pointer we are dealing with, remembered from the last one. */
  const saw = useCallback((pointerType: string) => {
    setCoarse((was) => {
      const next = pointerType !== 'mouse'
      return was === next ? was : next
    })
  }, [])

  const release = useCallback((pointerType: string) => {
    // A mouse ends its own tooltip by leaving, and a pen behaves like a finger:
    // it lifts off and there is nothing left hovering.
    if (pointerType === 'mouse') return
    clear()
    timers.current.push(
      setTimeout(() => to('fading'), TIP_LINGER_MS),
      setTimeout(() => {
        to('gone')
        done.current?.()
      }, TIP_LINGER_MS + TIP_FADE_MS),
    )
  }, [])

  useEffect(() => clear, [])

  return {
    // Unarmed is `false` rather than `undefined`: `false` hides the CURSOR as
    // well as the panel, which is the half a custom `content` cannot reach — so
    // a scroll that starts on a bar chart leaves no highlight behind it either.
    active: phase === 'gone' || !armed ? false : undefined,
    fading: phase === 'fading',
    coarse,
    armed,
    handlers: {
      onPointerDown: (e) => {
        saw(e.pointerType)
        clear()
        if (e.pointerType === 'mouse') {
          touch.current = null
          setArmed(true)
          to('shown')
          return
        }
        // A finger has proved nothing yet. Nothing is shown, and a timer is
        // started that will arm it if the finger stays put.
        touch.current = { x: e.clientX ?? 0, y: e.clientY ?? 0, dead: false }
        setArmed(false)
        to('shown')
        timers.current.push(
          setTimeout(() => {
            if (touch.current && !touch.current.dead) setArmed(true)
          }, TIP_HOLD_MS),
        )
      },
      onPointerMove: (e) => {
        const start = touch.current
        if (!start) {
          // A mouse arriving after a touch gesture was killed. On a laptop with
          // a touchscreen that is a real sequence — flick the page with a
          // finger, then hover with the trackpad — and without this the chart
          // stays mute until something is clicked.
          if (e.pointerType === 'mouse') setArmed(true)
          keep()
          return
        }
        if (start.dead) return
        // Travelled: this is a scroll, and no part of the rest of the gesture
        // may open a panel — including the lift at the end of it.
        if (scrolled(start, e.clientX ?? 0, e.clientY ?? 0)) {
          start.dead = true
          clear()
          setArmed(false)
          return
        }
        keep()
      },
      onPointerUp: (e) => {
        const start = touch.current
        touch.current = null
        if (e.pointerType !== 'mouse') {
          // A tap: down and up again without travelling. Nothing was shown
          // while the finger was down, so this is where it opens.
          if (armsOnLift(start)) setArmed(true)
          else return
        }
        release(e.pointerType)
      },
      onPointerCancel: (e) => {
        // The browser taking the touch to scroll with. The most reliable signal
        // there is that this was never a tap.
        if (touch.current) touch.current.dead = true
        touch.current = null
        clear()
        setArmed(false)
        release(e.pointerType)
      },
    },
    keep,
  }
}
