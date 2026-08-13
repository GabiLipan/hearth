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
 *   - **Checks when the app comes back to the front.** `visibilitychange` fires
 *     on a restore even though nothing reloaded, which is exactly the moment a
 *     check is worth doing and the moment nothing else does one. Throttled, so
 *     glancing at the app twenty times an hour is not twenty requests.
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
/** And a slow heartbeat for an app somebody leaves open all day. */
const HEARTBEAT_MS = 30 * 60_000

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
let lastCheckAt = 0

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

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate()
  })
  // A restore does not always change visibility — a PWA resumed from the app
  // switcher can come back focused and visible throughout — so `focus` is the
  // second half of "the app is in front of somebody again".
  window.addEventListener('focus', () => void checkForUpdate())
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
 */
export async function checkForUpdate({ manual = false } = {}): Promise<void> {
  // Already downloaded and waiting: there is nothing left to look for, and a
  // check that reported "up to date" over the top of it would be a lie.
  if (state.status === 'ready') return
  if (!manual && Date.now() - lastCheckAt < THROTTLE_MS) return

  lastCheckAt = Date.now()
  if (manual) set({ status: 'checking' })

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
  let serverBuiltAt: string | undefined
  try {
    const res = await fetch(`${STAMP_URL}?t=${Date.now()}`, { cache: 'no-store' })
    if (res.ok) serverBuiltAt = ((await res.json()) as { builtAt?: string }).builtAt
  } catch {
    /* handled below, as "could not ask" rather than as "nothing there" */
  }

  if (!serverBuiltAt) {
    // A check that FAILED must never look like a check that succeeded. This
    // used to fall back to the previous status with a fresh timestamp, which
    // read on screen as "up to date, as of just now" — the app confidently
    // reporting the outcome of a question it never got an answer to.
    set({ status: 'offline', checkedAt: Date.now() })
    return
  }
  if (serverBuiltAt === state.builtAt) {
    set({ status: 'current', checkedAt: Date.now() })
    return
  }

  // The server is ahead. Whether this device can take the update the clean way
  // depends on the worker catching up, so ask it to, and give it a moment.
  set({ status: 'checking', checkedAt: Date.now() })
  if (!registration) {
    set({ status: 'stale', checkedAt: Date.now() })
    return
  }
  try {
    await registration.update()
  } catch {
    /* the stamp already told us the truth; the worker is the one struggling */
  }
  const until = Date.now() + CATCH_UP_MS
  while (Date.now() < until) {
    if (registration.waiting) {
      set({ status: 'ready', checkedAt: Date.now() })
      return
    }
    if (!registration.installing) {
      // Nothing downloading and nothing waiting: the worker has been told there
      // is no new script. It is wrong, and `installUpdate` knows how to get
      // past that.
      break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  set({ status: registration.waiting ? 'ready' : 'stale', checkedAt: Date.now() })
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
