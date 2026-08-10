import { useCallback, useMemo, useSyncExternalStore } from 'react'

/**
 * A value that survives leaving a page, and dies with the tab.
 *
 * The filters on Activity were `useState`, so walking to Reports and back
 * threw them away and the page opened on everything again. That is wrong for
 * the same reason `useBook` is a module-level value rather than a hook-local
 * one: what is on screen is a LENS, and a lens you have to set again every time
 * you glance away is not a lens, it is a chore.
 *
 * Three deliberate choices about how long "sticky" lasts:
 *
 *   - **Not component state**, because that is exactly the bug.
 *   - **Not `settings` in Dexie**, where the theme and the page arrangements
 *     live. Those are preferences; a filter is a question you are in the middle
 *     of asking, and one asked last Tuesday should not still be narrowing the
 *     list this morning with nothing to say why.
 *   - **`sessionStorage`**, so it lasts exactly as long as the tab does — a
 *     reload keeps your place, closing the app forgets it. That is what "for
 *     this session" means, and it is per-tab, so two windows can be looking at
 *     two different things.
 *
 * The module-level cache in front of it is not an optimisation: `useSyncExternal
 * Store` requires a snapshot that is referentially stable between changes, and
 * parsing the JSON afresh on every render would return a new object every time
 * and spin.
 */

const PREFIX = 'hearth.'

/** The live value for each key, and what to call when one changes. */
const values = new Map<string, unknown>()
const subscribers = new Map<string, Set<() => void>>()

/**
 * Storage that is allowed to be missing.
 *
 * Safari in private browsing throws on access rather than returning null, and
 * a filter is not worth a white screen. Everything still works from the
 * in-memory map; it just forgets on reload.
 */
function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function stickyGet<T>(key: string, fallback: T): T {
  if (values.has(key)) return values.get(key) as T
  let value = fallback
  try {
    const raw = store()?.getItem(PREFIX + key)
    if (raw != null) value = JSON.parse(raw) as T
  } catch {
    /* unreadable or not ours — start from the fallback */
  }
  values.set(key, value)
  return value
}

export function stickySet<T>(key: string, next: T): void {
  if (Object.is(values.get(key), next)) return
  values.set(key, next)
  try {
    store()?.setItem(PREFIX + key, JSON.stringify(next))
  } catch {
    /* quota, private mode — the value still holds for this page */
  }
  subscribers.get(key)?.forEach((fn) => fn())
}

export function stickySubscribe(key: string, fn: () => void): () => void {
  let set = subscribers.get(key)
  if (!set) {
    set = new Set()
    subscribers.set(key, set)
  }
  set.add(fn)
  return () => set.delete(fn)
}

/** Test seam: forget everything, as though the tab had just been opened. */
export function stickyReset(): void {
  values.clear()
  try {
    const s = store()
    if (!s) return
    // Collected before removing any: the index shifts as keys go.
    const ours: string[] = []
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i)
      if (key?.startsWith(PREFIX)) ours.push(key)
    }
    for (const key of ours) s.removeItem(key)
  } catch {
    /* nothing to clear */
  }
}

/** One sticky value, read and written like `useState`. */
export function useSticky<T>(key: string, fallback: T): [T, (next: T) => void] {
  const value = useSyncExternalStore(
    useCallback((fn: () => void) => stickySubscribe(key, fn), [key]),
    () => stickyGet(key, fallback),
    () => fallback,
  )
  const set = useCallback((next: T) => stickySet(key, next), [key])
  return [value, set]
}

/**
 * A sticky set of ids — every "all of them, or just these" filter in the app.
 *
 * `null` is the resting state and means every one, including any added later;
 * see `AccountFilter`. Stored as an array because a `Set` does not survive
 * `JSON.stringify`, and rebuilt with a `useMemo` keyed on the stored array,
 * whose identity is stable because the module holds it — a fresh `Set` each
 * render would invalidate every filter memo downstream on every keystroke.
 */
export function useStickyIds(key: string): [Set<string> | null, (next: Set<string> | null) => void] {
  const [ids, setIds] = useSticky<string[] | null>(key, null)
  const value = useMemo(() => (ids === null ? null : new Set(ids)), [ids])
  const set = useCallback((next: Set<string> | null) => setIds(next === null ? null : [...next]), [setIds])
  return [value, set]
}
