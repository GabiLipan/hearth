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
  /** Checked, and this is the newest there is. */
  | 'current'
  /** No service worker here — a browser that cannot install, or the dev server. */
  | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  /** When the last completed check finished, so "up to date" can say as of when. */
  checkedAt?: number
  /** When this bundle was built. Not the same thing as the version on the server. */
  builtAt: string
}

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
  if (!registration) {
    if (manual) set({ status: 'unsupported' })
    return
  }
  // Already downloaded and waiting: there is nothing left to look for, and a
  // check that reported "up to date" over the top of it would be a lie.
  if (state.status === 'ready') return
  if (!manual && Date.now() - lastCheckAt < THROTTLE_MS) return

  lastCheckAt = Date.now()
  if (manual) set({ status: 'checking' })
  try {
    await registration.update()
    const found = registration.installing ?? registration.waiting
    if (!found) {
      set({ status: 'current', checkedAt: Date.now() })
      return
    }
    if (registration.waiting) {
      set({ status: 'ready', checkedAt: Date.now() })
      return
    }
    // Still downloading. `onNeedRefresh` will fire when it is installed, but
    // only for a worker workbox is watching; this covers the rest and keeps the
    // manual check from sitting on "checking" for ever.
    found.addEventListener('statechange', () => {
      if (found.state === 'installed') set({ status: 'ready', checkedAt: Date.now() })
      else if (found.state === 'redundant') set({ status: 'current', checkedAt: Date.now() })
    })
  } catch {
    // Offline, or the server is unreachable. Not an error worth a banner: the
    // app is working from its own cache, which is the point of it.
    set({ status: state.status === 'checking' ? 'idle' : state.status, checkedAt: Date.now() })
  }
}

/**
 * Take the new version, now.
 *
 * Reloads the page: the waiting worker is told to activate, and `registerSW`
 * reloads once it has taken control.
 */
export async function installUpdate(): Promise<void> {
  if (!applyUpdate) return
  await applyUpdate(true)
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
