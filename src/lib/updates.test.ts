import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeRegistration } from '../test/pwaRegister'

/**
 * The four ways "check for updates" used to be able to mislead.
 *
 * None of them was a crash, which is why they went unnoticed for so long: every
 * one of them ends with the app stating something on screen with confidence.
 */

/** The stamp `__BUILT_AT__` is defined as in `vitest.config.ts`. */
const RUNNING = '2026-01-01T00:00:00.000Z'
const NEWER = '2026-02-02T00:00:00.000Z'

/** The clock, frozen so a throttle window can be crossed on demand. */
let now = 1_770_000_000_000

function stampResponse(builtAt: string) {
  return { ok: true, json: async () => ({ builtAt }) } as unknown as Response
}

/** A fresh copy of the module — its state is module-level and deliberately so. */
async function load(registration?: FakeRegistration) {
  vi.resetModules()
  const harness = await import('../test/pwaRegister')
  harness.swHarness.registration = registration
  harness.swHarness.applied = 0
  const mod = await import('./updates')
  mod.initUpdates()
  return mod
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  // `initUpdates` wires listeners and asks whether service workers exist at all.
  // None of the listeners are fired by these tests: what they cover is what a
  // check DOES, not which events reach it.
  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: {} },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'document', {
    value: { addEventListener: () => {}, visibilityState: 'visible' },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'window', {
    value: { addEventListener: () => {} },
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkForUpdate', () => {
  it('answers from a waiting worker without asking the network', async () => {
    // The case that read as the feature being broken: offline, holding a
    // downloaded update, and saying "could not reach the server" about it.
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline')
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    // Nothing waiting at registration: this one turned up later, while the app
    // was in the background, so `onNeedRefresh` may never have been delivered.
    const reg: FakeRegistration = {}
    const mod = await load(reg)
    expect(mod.updateState().status).toBe('idle')
    reg.waiting = {}

    await mod.checkForUpdate({ manual: true })

    expect(mod.updateState().status).toBe('ready')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('says a check failed, and does not spend the throttle on it', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline')
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const mod = await load({})

    await mod.checkForUpdate()
    expect(mod.updateState().status).toBe('offline')
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Immediately after, an automatic check is still refused — a failure is not
    // licence to hammer the server.
    await mod.checkForUpdate()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // But seconds later it tries again, rather than being turned away for the
    // full minute a successful check earns.
    now += 9_000
    await mod.checkForUpdate()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('holds off for a full minute after a check that did get an answer', async () => {
    const fetchSpy = vi.fn(async () => stampResponse(RUNNING))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const mod = await load({})

    await mod.checkForUpdate()
    expect(mod.updateState().status).toBe('current')

    now += 9_000
    await mod.checkForUpdate()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    now += 60_000
    await mod.checkForUpdate()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('runs one check however many callers arrive at once', async () => {
    // An iOS resume can fire visibilitychange, focus and pageshow together.
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fetchSpy = vi.fn(async () => {
      await gate
      return stampResponse(RUNNING)
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const mod = await load({})

    const all = Promise.all([mod.checkForUpdate(), mod.checkForUpdate(), mod.checkForUpdate({ manual: true })])
    release()
    await all

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(mod.updateState().status).toBe('current')
  })

  /**
   * The fault this file was reopened for: "I keep pressing Check for updates
   * and nothing happens", surviving the app being closed and reopened.
   *
   * A `fetch` that never settles is an ordinary thing on iOS — a request issued
   * as the app goes into the background can hang rather than fail — and the
   * in-flight promise was joined by every later caller for ever after. Closing
   * the app did not clear it either: an installed app is restored, not
   * launched, so the same page and the same pending promise came back.
   */
  it('does not wait for ever on a check that hung', async () => {
    let calls = 0
    const fetchSpy = vi.fn(() => {
      calls++
      // The first check never answers. Nothing rejects; nothing resolves.
      return calls === 1 ? new Promise<Response>(() => {}) : Promise.resolve(stampResponse(RUNNING))
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const mod = await load({})

    void mod.checkForUpdate({ manual: true })
    expect(mod.updateState().status).toBe('checking')

    // While it might still be running, a second press joins it rather than
    // starting a race — the behaviour the in-flight promise is there for.
    void mod.checkForUpdate({ manual: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Past the point where it can plausibly still be running, it is abandoned
    // and a fresh check goes out.
    now += 30_000
    await mod.checkForUpdate({ manual: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(mod.updateState().status).toBe('current')
  })

  /**
   * And the reason abandoning one is safe: it may still answer, about a moment
   * that has passed.
   */
  it('ignores a straggler that answers after a newer check has spoken', async () => {
    let release: (r: Response) => void = () => {}
    let calls = 0
    globalThis.fetch = vi.fn(() => {
      calls++
      return calls === 1
        ? new Promise<Response>((r) => {
            release = r
          })
        : Promise.resolve(stampResponse(RUNNING))
    }) as unknown as typeof fetch
    const mod = await load({ update: async () => {} })

    void mod.checkForUpdate({ manual: true })
    now += 30_000
    await mod.checkForUpdate({ manual: true })
    expect(mod.updateState().status).toBe('current')

    // The first check finally comes back, claiming the server is ahead.
    release(stampResponse(NEWER))
    await Promise.resolve()
    await Promise.resolve()
    expect(mod.updateState().status).toBe('current')
  })

  it('waits for the worker to catch up before calling the build stale', async () => {
    globalThis.fetch = (async () => stampResponse(NEWER)) as unknown as typeof fetch
    const reg: FakeRegistration = {}
    // `update()` resolving means the registration job finished, not that its
    // side effects are readable yet: for a beat there is nothing installing and
    // nothing waiting. Read at that instant, a worker arriving perfectly
    // normally looked exactly like one that had been told there was nothing new.
    reg.update = async () => {
      setTimeout(() => {
        reg.installing = {}
      }, 100)
      setTimeout(() => {
        reg.waiting = {}
        reg.installing = undefined
      }, 300)
    }
    const mod = await load(reg)

    await mod.checkForUpdate({ manual: true })

    expect(mod.updateState().status).toBe('ready')
  })

  it('calls it stale when the worker is told there is nothing new', async () => {
    // The server is provably ahead and the worker disagrees, which is what a
    // cached `sw.js` looks like from here. `installUpdate` has a heavier path
    // for it, and the reader has to be told it exists.
    globalThis.fetch = (async () => stampResponse(NEWER)) as unknown as typeof fetch
    const mod = await load({ update: async () => {} })

    await mod.checkForUpdate({ manual: true })

    expect(mod.updateState().status).toBe('stale')
    expect(mod.updateState().checkedAt).toBe(now)
  })
})
