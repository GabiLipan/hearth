import { useCallback, useSyncExternalStore } from 'react'
import { registerSW } from 'virtual:pwa-register'

/**
 * Getting a new version of the app onto a phone that never reloads.
 *
 * The app is a service worker and a precached bundle, so "the latest version"
 * arrives in two steps: the browser has to notice a new service worker, and
 * something has to let it take over. In a browser tab both happen by
 * themselves, because a tab gets reloaded all the time.
 *
 * An installed app on iOS does not. Reopening it usually RESTORES the process
 * rather than launching it — same page, same JavaScript, no navigation — so
 * the update check that runs at registration never runs again, and the app can
 * sit several versions behind for days. Force-quitting it repeatedly is the
 * folk remedy, and it works by accident: eventually one of those launches is a
 * cold start.
 *
 * So this file does the two things the platform will not:
 *
 *   - **Checks when the app comes back to the front.** A restore fires
 *     `visibilitychange`, `focus` or `pageshow` even though nothing reloaded,
 *     which is exactly the moment a check is worth doing and the moment nothing
 *     else does one. All three are listened for, plus `online`, because no one
 *     of them fires on every platform and version; the throttle is what makes
 *     the overlap free, so glancing at the app twenty times an hour is not
 *     twenty requests.
 *   - **Never reports the outcome of a question it did not get an answer to.**
 *     A failed check says so, and — since it learned nothing — does not spend
 *     the throttle on the way out.
 *   - **Says what it found, and waits to be told.** A new version is announced
 *     rather than applied: applying it reloads the page, and doing that
 *     unasked can throw away a half-typed transaction. Nothing here is queued
 *     work — the outbox is in IndexedDB and survives a reload — so the only
 *     thing at risk is an open form.
 *
 * The store is module-level with subscribers, like `useBook`, because the
 * banner and the Settings row are two views of one fact and must not disagree.
 */

export type UpdateStatus =
  /** Nothing known yet, or nothing to say. */
  | 'idle'
  /** A check is in flight, asked for by hand. */
  | 'checking'
  /** A new version is downloaded and waiting to be let in. */
  | 'ready'
  /**
   * The server has a newer build, and this device's service worker has not
   * picked it up. Real, and the reason this state exists rather than being
   * folded into `ready`: `sw.js` goes through the same CDN as everything else,
   * so the worker can go on being told there is nothing new for as long as that
   * cache holds. Taking the update from here is a heavier operation — see
   * `installUpdate`.
   */
  | 'stale'
  /** Checked, and this is the newest there is. */
  | 'current'
  /** The check itself failed — offline, or the server did not answer. */
  | 'offline'
  /** No service worker here — a browser that cannot install, or the dev server. */
  | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  /** When the last completed check finished, so "up to date" can say as of when. */
  checkedAt?: number
  /** When this bundle was built. Not the same thing as the version on the server. */
  builtAt: string
}

/**
 * Where the server says which build it is serving.
 *
 * Relative to the document, which is what makes it work on a project site
 * served from a sub-path — the same reason `base` is './'.
 */
const STAMP_URL = 'version.json'
/** How long to give the service worker to notice, once the server is known to be ahead. */
const CATCH_UP_MS = 8000
/** How long between automatic checks — a foreground return sooner than this is ignored. */
const THROTTLE_MS = 60_000
/**
 * And how long after a check that could not reach the server.
 *
 * Deliberately far shorter than the throttle. The commonest failure is a resume
 * where the app is in front of you before the radio is back, and charging the
 * full minute for it means the next two or three chances to notice — the focus
 * event, a glance away and back — are all refused on the strength of a check
 * that never got an answer.
 */
const RETRY_MS = 8000
/** And a slow heartbeat for an app somebody leaves open all day. */
const HEARTBEAT_MS = 30 * 60_000
/**
 * How long the stamp fetch is given before it is abandoned.
 *
 * A `fetch` has no timeout of its own, and on iOS one issued as the app goes
 * into the background can simply never settle — not fail, never settle. That is
 * the difference between "this check failed" and "this check is still running",
 * and the second one used to be permanent: see `inFlight`.
 */
const STAMP_TIMEOUT_MS = 6_000
/**
 * And how long `registration.update()` is given, for the same reason.
 *
 * The stamp has already told the truth by this point, so nothing here depends
 * on the answer — the catch-up loop below watches the registration itself.
 */
const UPDATE_TIMEOUT_MS = 6_000
/**
 * How long a check may be in flight before another caller stops waiting for it.
 *
 * Comfortably longer than a legitimate one: a stamp fetch and then up to
 * `CATCH_UP_MS` of watching the worker install. Past it, a run is presumed hung
 * rather than slow.
 */
const STUCK_MS = STAMP_TIMEOUT_MS + CATCH_UP_MS + 6_000

let state: UpdateState = { status: 'idle', builtAt: __BUILT_AT__ }
const listeners = new Set<() => void>()

function set(patch: Partial<UpdateState>) {
  const next = { ...state, ...patch }
  if (
    next.status === state.status &&
    next.checkedAt === state.checkedAt &&
    next.builtAt === state.builtAt
  ) {
    return
  }
  state = next
  listeners.forEach((fn) => fn())
}

/** Let the waiting worker take over, and reload onto it. Set by `initUpdates`. */
let applyUpdate: ((reload?: boolean) => Promise<void>) | undefined
let registration: ServiceWorkerRegistration | undefined
/** The earliest an AUTOMATIC check may run again. Manual ones ignore it. */
let nextAutoCheckAt = 0
/**
 * The check currently running, if any.
 *
 * Every caller joins it rather than starting a second. Without this, the two
 * listeners that fire together on an iOS resume — `visibilitychange` and
 * `focus` — could both get past the throttle in the same millisecond, and two
 * runs would then interleave their `set` calls: one writing `current` while the
 * other is eight seconds into its catch-up loop and about to write `checking`
 * back over it. The screen would end up on whichever finished last.
 *
 * **It must never become a latch, and it was one.** Joining a run that is still
 * going is right; joining one that will never finish is the feature quietly
 * dying. A `fetch` that never settles — an ordinary thing on iOS, where a
 * request issued as the app goes into the background can hang for ever — left
 * this promise pending, and from then on every press of Check for updates
 * returned it and did nothing at all. Nothing recovered it either: an installed
 * app is RESTORED rather than launched, so the same page and the same pending
 * promise came back however many times the app was closed and reopened. That is
 * exactly what "I keep pressing it and nothing happens" looks like from here.
 *
 * So a run in flight is joined only while it is plausibly still running, and
 * `runToken` is what makes abandoning one safe: a run whose token is no longer
 * current writes nothing, so a straggler that finally answers cannot land its
 * verdict over a newer check's.
 */
let inFlight: Promise<void> | undefined
let inFlightSince = 0
let runToken = 0

/**
 * Register the service worker, and start watching for new versions.
 *
 * Called once from `main.tsx`. In dev there is no service worker unless
 * `devOptions` is on, so `registerSW` resolves to a no-op and the status stays
 * `unsupported` — which is the honest thing for the Settings row to say.
 */
export function initUpdates() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    set({ status: 'unsupported' })
    return
  }

  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      set({ status: 'ready' })
    },
    onRegisteredSW(_url, r) {
      registration = r
      // A version that arrived while the app was closed is already waiting by
      // the time anything here runs, and emits no event of its own.
      if (r?.waiting) set({ status: 'ready' })
    },
    onRegisterError() {
      // A failed registration is not worth a message: the app works, it just
      // will not update itself. The manual check will report the same thing.
      set({ status: 'unsupported' })
    },
  })

  // Four ways to hear "the app is in front of somebody again", because no one
  // of them fires on every platform and the throttle makes the overlap free.
  // `pageshow` is the one that matters most on iOS: a resumed PWA is often
  // restored from the page cache, which is a `pageshow` with `persisted` set
  // and — depending on version — no visibility change at all, because the page
  // was never marked hidden on the way out.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate()
  })
  window.addEventListener('focus', () => void checkForUpdate())
  window.addEventListener('pageshow', () => void checkForUpdate())
  // And when the network comes back, which is the other half of the commonest
  // failure: the check that ran on resume could not reach the server, and
  // nothing else was going to happen until the app was put away and reopened.
  window.addEventListener('online', () => void checkForUpdate())
  setInterval(() => {
    if (document.visibilityState === 'visible') void checkForUpdate()
  }, HEARTBEAT_MS)
}

/**
 * Ask the server whether there is a newer version.
 *
 * `manual` skips the throttle and shows the check happening; the automatic
 * callers stay silent, because a check nobody asked for should not make the
 * screen flicker between "checking" and "up to date" every time the app is
 * glanced at.
 *
 * This is the gate — what can be answered without asking anybody, and whether
 * asking is allowed yet. `run` is the check itself.
 */
export function checkForUpdate({ manual = false } = {}): Promise<void> {
  // A worker sitting in `waiting` is the strongest evidence there is, and it
  // needs no network to read. Answering from it FIRST fixes the case that looked
  // most like the feature being broken: offline, with a new version already
  // downloaded, `run`'s fetch fails and the app says "could not reach the
  // server" over the top of an update it is holding in its hand. It also covers
  // a worker that became `waiting` while the page was in the background, where
  // `onNeedRefresh` may never have been delivered.
  if (registration?.waiting) {
    set({ status: 'ready', checkedAt: Date.now() })
    return Promise.resolve()
  }
  // Nothing left to look for, and a check reporting "up to date" over the top of
  // this would be a lie.
  if (state.status === 'ready') return Promise.resolve()
  if (!manual && Date.now() < nextAutoCheckAt) return Promise.resolve()
  if (inFlight && Date.now() - inFlightSince < STUCK_MS) return inFlight

  // Anything still running is disowned rather than waited for: it may answer
  // later, and if it does, `token` is what stops it saying so. Its `checking`
  // is disowned with it, which matters — the button is disabled while that is
  // on screen, so a status left behind by a hung run is a control nobody can
  // press.
  const token = ++runToken
  inFlightSince = Date.now()
  if (manual) set({ status: 'checking' })
  inFlight = run(token).finally(() => {
    if (token === runToken) inFlight = undefined
  })
  return inFlight
}

/** A promise that settles, whatever the network does. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const bell = setTimeout(() => resolve(undefined), ms)
    work.then(
      (v) => {
        clearTimeout(bell)
        resolve(v)
      },
      () => {
        clearTimeout(bell)
        resolve(undefined)
      },
    )
  })
}

/**
 * What the server says it is serving, or undefined if it could not be asked.
 *
 * Aborted rather than merely raced, so a hung request is released instead of
 * being left holding a connection for the rest of the session.
 */
async function fetchStamp(): Promise<string | undefined> {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : undefined
  const bell = setTimeout(() => ctrl?.abort(), STAMP_TIMEOUT_MS)
  try {
    const res = await withTimeout(
      fetch(`${STAMP_URL}?t=${Date.now()}`, { cache: 'no-store', signal: ctrl?.signal }),
      STAMP_TIMEOUT_MS,
    )
    if (!res?.ok) return undefined
    return ((await res.json()) as { builtAt?: string }).builtAt
  } catch {
    /* handled by the caller, as "could not ask" rather than as "nothing there" */
    return undefined
  } finally {
    clearTimeout(bell)
  }
}

/**
 * One check, start to finish. Never called directly — see `checkForUpdate`.
 *
 * `token` is this run's claim on the screen. Every write goes through `commit`,
 * which drops it if a later check has since started: a run abandoned for taking
 * too long may still answer, and its answer is about a moment that has passed.
 */
async function run(token: number): Promise<void> {
  const commit = (patch: Partial<UpdateState>) => {
    if (token === runToken) set(patch)
  }
  /**
   * Ask the SERVER, not the service worker.
   *
   * This is the whole fix for "check for updates finds nothing when there is
   * something". `registration.update()` fetches `sw.js`, which on GitHub Pages
   * goes through a CDN with its own TTL and, on iOS, a browser cache that is
   * keener still — so the worker gets handed yesterday's script, concludes
   * nothing has changed, and the app faithfully reports it. A stamp fetched
   * with `no-store` AND a cache-busting query cannot be answered from a cache
   * by anything in that chain.
   */
  const serverBuiltAt = await fetchStamp()

  if (!serverBuiltAt) {
    // A check that FAILED must never look like a check that succeeded. This
    // used to fall back to the previous status with a fresh timestamp, which
    // read on screen as "up to date, as of just now" — the app confidently
    // reporting the outcome of a question it never got an answer to.
    //
    // And it must not spend the throttle either: a question that got no answer
    // is one still worth asking, so the next resume tries again in seconds
    // rather than being turned away for a minute on the strength of it.
    if (token === runToken) nextAutoCheckAt = Date.now() + RETRY_MS
    commit({ status: 'offline', checkedAt: Date.now() })
    return
  }
  if (token === runToken) nextAutoCheckAt = Date.now() + THROTTLE_MS
  if (serverBuiltAt === state.builtAt) {
    commit({ status: 'current', checkedAt: Date.now() })
    return
  }

  // The server is ahead. Whether this device can take the update the clean way
  // depends on the worker catching up, so ask it to, and give it a moment.
  commit({ status: 'checking', checkedAt: Date.now() })
  if (!registration) {
    commit({ status: 'stale', checkedAt: Date.now() })
    return
  }
  // Bounded, like the stamp: `update()` fetches `sw.js`, so it is a network
  // call with all the same ways of never coming back — and the stamp has
  // already told us the truth, so there is nothing here worth waiting for.
  await withTimeout(Promise.resolve(registration.update()), UPDATE_TIMEOUT_MS)
  const until = Date.now() + CATCH_UP_MS
  while (Date.now() < until) {
    // A tick BEFORE the first verdict, deliberately. `update()` resolving means
    // the registration job finished, not that its side effects are readable, so
    // asking straight away can find neither `installing` nor `waiting` set for a
    // worker that is in fact half way through installing — and this loop would
    // then give up on an update that was arriving normally, and send the reader
    // to the heavy path for no reason.
    await new Promise((r) => setTimeout(r, 250))
    if (token !== runToken) return
    if (registration.waiting) {
      commit({ status: 'ready', checkedAt: Date.now() })
      return
    }
    if (!registration.installing) {
      // Nothing downloading and nothing waiting: the worker has been told there
      // is no new script. It is wrong, and `installUpdate` knows how to get
      // past that.
      break
    }
  }
  commit({ status: registration.waiting ? 'ready' : 'stale', checkedAt: Date.now() })
}

/**
 * Take the new version, now.
 *
 * The clean path is the first one: a worker is waiting, it is told to activate,
 * and `registerSW` reloads once it has taken control.
 *
 * The second path is for `stale` — the server is provably ahead and the worker
 * has not seen it. Unregistering removes the only thing that can serve the old
 * bundle, so the reload that follows goes to the network and comes back with
 * the new one, which registers a fresh worker on the way in. It costs the
 * precache, which is rebuilt on that load, and nothing else: every byte of
 * household data lives in IndexedDB and the outbox, neither of which a service
 * worker owns.
 */
export async function installUpdate(): Promise<void> {
  if (registration?.waiting && applyUpdate) {
    await applyUpdate(true)
    return
  }
  try {
    await registration?.unregister()
  } catch {
    /* if it will not go, the reload below is still worth trying */
  }
  // `reload()` alone can be served from the back/forward cache on iOS; a fresh
  // navigation to the same URL cannot.
  window.location.replace(window.location.href)
}

/**
 * The state, read outside React.
 *
 * The store is module-level, so this is the same value the hook below serves —
 * it is not a second copy and cannot disagree with what is on screen.
 */
export function updateState(): UpdateState {
  return state
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    useCallback((fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }, []),
    () => state,
    () => state,
  )
}
