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

/** How long the panel stays after the finger lifts. Long enough to read a name and an amount. */
export const TIP_LINGER_MS = 3600
/** And how long it takes to go. */
export const TIP_FADE_MS = 400

type Phase = 'shown' | 'fading' | 'gone'

export interface TouchTooltip {
  /**
   * What a Recharts `<Tooltip active>` should be: `false` once the linger has
   * run out, `undefined` the rest of the time so Recharts goes on deciding for
   * itself. `false` hides the cursor as well as the panel, which is the half a
   * custom `content` cannot reach.
   */
  active: boolean | undefined
  /** True while the panel is on its way out, for whatever draws it. */
  fading: boolean
  /** Bind to the element the pointer lands on. */
  handlers: {
    onPointerDown: () => void
    onPointerMove: () => void
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
  /**
   * The phase again, readable synchronously: `keep` runs on every pointer move
   * over the chart, and a `setState` per move would re-run every `useMemo`
   * under it.
   */
  const at = useRef<Phase>('shown')
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
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
    active: phase === 'gone' ? false : undefined,
    fading: phase === 'fading',
    handlers: {
      onPointerDown: keep,
      onPointerMove: keep,
      onPointerUp: (e) => release(e.pointerType),
      onPointerCancel: (e) => release(e.pointerType),
    },
    keep,
  }
}
