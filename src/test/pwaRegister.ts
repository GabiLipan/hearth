/**
 * Stands in for `virtual:pwa-register`, which only exists inside a Vite build.
 *
 * Aliased in `vitest.config.ts`, so `lib/updates.ts` can be imported by a test
 * at all. It also hands the module a registration to talk to: the real one
 * arrives through `onRegisteredSW`, so this is the only seam a test needs, and
 * `updates.ts` requires nothing added to it for the sake of being tested.
 */

/** As much of a `ServiceWorkerRegistration` as `updates.ts` actually touches. */
export interface FakeRegistration {
  waiting?: object
  installing?: object
  update?: () => Promise<unknown>
  unregister?: () => Promise<boolean>
}

export const swHarness: {
  /** What `onRegisteredSW` will be handed. `undefined` is "not registered yet". */
  registration?: FakeRegistration
  /** How many times the app asked the waiting worker to take over. */
  applied: number
  /** The callbacks `initUpdates` passed in, so a test can fire them. */
  options?: RegisterSWOptions
} = { applied: 0 }

interface RegisterSWOptions {
  immediate?: boolean
  onNeedRefresh?: () => void
  onRegisteredSW?: (url: string, r?: FakeRegistration) => void
  onRegisterError?: (err: unknown) => void
}

export function registerSW(options: RegisterSWOptions = {}) {
  swHarness.options = options
  options.onRegisteredSW?.('sw.js', swHarness.registration)
  return async (_reload?: boolean) => {
    swHarness.applied++
  }
}
