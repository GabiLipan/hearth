/**
 * Taking the boot splash off, once the app is actually behind it.
 *
 * The splash itself — markup, keyframes and a backstop timeout — lives in
 * `index.html`, because anything shipped inside the bundle paints after the
 * blank page it exists to cover. This is only the dismissal, which is the half
 * that has to know when React has something on screen.
 *
 * ## It waits for a paint, never for the network
 *
 * `dismissSplash` is called from a passive effect in `App`, which runs after
 * the first commit has painted. That is the whole condition. It is emphatically
 * NOT `SyncState.ready`: a returning user's `ready` comes from the local cache
 * before the network is consulted (see `session.ts`), but a first sign-in waits
 * on `onAuthStateChange`, and an offline launch of a device that has never
 * finished one would sit on the fireplace indefinitely — on precisely the
 * launches the offline cache exists to serve. Whatever the app decides to show
 * first, including the sign-in screen and `Onboarding`'s own "Opening…", is a
 * painted app and the splash's job is done.
 *
 * ## And it has a floor as well as a ceiling
 *
 * On a warm start React paints in well under 100ms, and an animation cut off
 * three frames in reads as a glitch — a flicker of something orange rather than
 * a fire being lit. So the splash lives long enough to be seen moving, measured
 * from when the DOCUMENT started rather than from when this module ran: the
 * interesting case is a cold start, where the difference between the two is most
 * of the wait. `performance.now()` is time since navigation start, which is
 * exactly that clock and needs nothing stamped anywhere to read it.
 *
 * The number is the 420ms entrance plus enough of the first breath for the
 * ripple to reach the end of the word. It is a floor and nothing more: the
 * animation itself loops, so there is no point at which it is "finished" and
 * this must never be read as one.
 *
 * The ceiling is in `index.html` instead, for the case this function is never
 * reached at all.
 */

/** The least time the splash is worth showing for. See above. */
const MIN_VISIBLE_MS = 1080

/** The fade, which must match `#boot.leaving`'s animation duration. */
const EXIT_MS = 220

let dismissed = false

export function dismissSplash() {
  if (dismissed) return
  dismissed = true

  const el = document.getElementById('boot')
  if (!el) return

  const wait = Math.max(0, MIN_VISIBLE_MS - performance.now())
  setTimeout(() => {
    el.classList.add('leaving')
    // A timer rather than `animationend`, for the reason the toast and the
    // donut's sweep both use one: a backgrounded tab runs no animations and
    // delivers no finish event, so an element removed by its own `animationend`
    // is still sitting over the app when you come back to it.
    setTimeout(() => el.remove(), EXIT_MS)
  }, wait)
}
