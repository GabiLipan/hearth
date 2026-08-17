import { useCallback, useEffect, useSyncExternalStore } from 'react'

/**
 * What the phone's header says once a page has been scrolled into.
 *
 * The page title is a large heading at the top of the content now, and it
 * scrolls away — which is the whole reason the top edge can be two floating
 * discs rather than a bar. That leaves a gap on the one page long enough to get
 * lost in: Activity's month headings used to be `sticky top-0` with an opaque
 * fill, and they were legible because they butted into the underside of a solid
 * bar. With the bar gone they were a full-width band with square edges floating
 * in the middle of the rows, separating nothing from nothing.
 *
 * So the month moves up into the header, between the lens and the settings
 * disc, as a third floating capsule. A page publishes a line here and the
 * header shows it; nobody else has to know a page did.
 *
 * A module-level value with subscribers rather than a context, for the reason
 * `useBook` is one: the writer and the reader are on opposite sides of the
 * tree — Activity is inside `Layout`'s children, the header is `Layout`'s own
 * markup — and a context would mean threading a provider through purely to send
 * a string upwards.
 *
 * Deliberately a string and not a node. Anything richer invites a page to put a
 * control up here, and the header is a `pointer-events-none` layer with two
 * things in it on purpose.
 */
let value: string | null = null
const subs = new Set<() => void>()

/**
 * Say what the header should show, or `null` for nothing.
 *
 * Idempotent: setting the line it is already showing notifies nobody, which
 * matters because the caller is a scroll handler running every frame.
 */
export function setHeadline(next: string | null) {
  if (next === value) return
  value = next
  for (const fn of subs) fn()
}

/**
 * Publish a line for as long as this component is mounted.
 *
 * The cleanup is the load-bearing half: leaving a page has to take its headline
 * with it, or Budgets opens with "August 2026" still sitting in the header.
 */
export function useHeadline(line: string | null) {
  useEffect(() => {
    setHeadline(line)
    return () => setHeadline(null)
  }, [line])
}

/** What to show. Read by the header, and by nothing else. */
export function useHeadlineValue(): string | null {
  return useSyncExternalStore(
    useCallback((fn: () => void) => {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    }, []),
    () => value,
    () => null,
  )
}
