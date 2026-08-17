import type { Location } from 'react-router-dom'

/** The routes presented as a modal over the page, rather than instead of it. */
const MODAL_ROOT = '/settings'

const inModal = (location: Location) =>
  location.pathname === MODAL_ROOT || location.pathname.startsWith(`${MODAL_ROOT}/`)

/**
 * The page a modal route was opened over, if there is one.
 *
 * `state` is whatever was pushed, from anywhere, including a version of the app
 * still sitting in somebody's history. So it is checked rather than cast: a
 * shape that is not a location reads as no background at all, and the route
 * falls back to being an ordinary page. That fallback is the whole safety story
 * — every caller has to cope without a background anyway, because a cold load
 * straight onto `/settings` has none.
 */
function fromState(location: Location): Location | undefined {
  const state = location.state as { background?: unknown } | null
  const bg = state?.background
  if (!bg || typeof bg !== 'object') return undefined
  return typeof (bg as Location).pathname === 'string' ? (bg as Location) : undefined
}

/**
 * The background is held for the whole `/settings` subtree, not just the entry
 * that carried it.
 *
 * Settings' group screens are ordinary routes reached by ordinary links —
 * `<Link to="/settings/data">` — and a link cannot know it is being pressed
 * inside a modal. Reading the background from `location.state` alone, the first
 * tap on a group would land on an entry with no state, the modal would decide
 * it was never open, and Settings would drop into the page slot mid-gesture.
 * Threading state through every link in that file would work and would break
 * the first time somebody adds a link without it.
 *
 * So: remember it while the path stays under `/settings`, forget it the moment
 * it leaves. Module scope rather than a ref because two components need the
 * same answer in the same render pass — `App`, which decides what the page
 * shows, and `Layout`, which decides what the header shows — and a ref in one
 * is invisible to the other.
 *
 * Called during render, which is safe here only because it is idempotent:
 * the answer is a pure function of the location plus a value that location
 * itself put there, so calling it twice (as StrictMode does) cannot drift.
 */
let held: Location | undefined

export function resolveBackground(location: Location): Location | undefined {
  if (!inModal(location)) {
    held = undefined
    return undefined
  }
  const pushed = fromState(location)
  if (pushed) held = pushed
  return held
}

/** Where a modal route sends you when you close it. */
export function backgroundHref(background: Location): string {
  return `${background.pathname}${background.search}${background.hash}`
}
