import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Button, Sheet } from './ui'

/**
 * "Are you sure?", in the app's own voice.
 *
 * There were fourteen `confirm()`s and eight `alert()`s carrying the most
 * consequential moments in Hearth — deleting a transaction, erasing everything,
 * reducing your own access to an account you can then never get back. A native
 * dialog renders in the system font, ignores the theme, and in an installed PWA
 * is captioned with the origin ("hearth.example says"), which is the one piece
 * of chrome in the whole app that says "web page" rather than "app". It also
 * cannot lay anything out: `Settings` was passing two paragraphs separated by
 * `\n\n` into a control that has no paragraphs.
 *
 * ## Why a promise rather than a hook
 *
 * The call sites are `async` handlers that read
 *
 * ```ts
 * if (!(await confirmAction({ … }))) return
 * ```
 *
 * which is the same shape the code already had. A hook would mean hoisting
 * state into every one of twelve components and threading a callback back down
 * — for a control that is modal, one-at-a-time, and global by nature.
 *
 * ## Why not named `confirm`
 *
 * Deliberately not, and not `Confirm` either. A module-scoped `confirm` would
 * shadow the global one, so any call site left behind — or added later from
 * habit — would go on compiling as `if (confirm(…))`, where the value is now a
 * *Promise* and therefore always truthy. Every confirmation in the app would
 * silently answer yes. A distinct name makes the leftovers fail loudly and
 * makes them greppable.
 */

export type ConfirmOptions = {
  title: string
  /** Paragraphs of explanation. A plain string is one paragraph. */
  body?: string | string[]
  /** The label on the button that goes ahead. Defaults to "Continue". */
  confirmLabel?: string
  /** `false` leaves only the action — see `alertAction`, which has nothing to decline. */
  cancelLabel?: string | false
  /**
   * `danger` paints the action as destructive AND withholds focus from it —
   * see the note on focus below.
   */
  tone?: 'default' | 'danger'
}

type Request = ConfirmOptions & { id: number; resolve: (ok: boolean) => void }

let queue: Request[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  queue = [...queue]
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const EMPTY: Request[] = []
const snapshot = () => queue
const serverSnapshot = () => EMPTY

/** Ask, and resolve to what they said. Rejects nothing and throws nothing. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...options, id: nextId++, resolve }]
    emit()
  })
}

function answer(id: number, ok: boolean) {
  const found = queue.find((r) => r.id === id)
  if (!found) return
  queue = queue.filter((r) => r.id !== id)
  emit()
  found.resolve(ok)
}

/**
 * Mounted once, at the top of the app.
 *
 * One at a time: a second request raised while the first is open waits its
 * turn rather than stacking, which keeps the answer unambiguous — and in
 * practice only happens when a confirmation is asked for from inside a sheet
 * that is itself closing.
 */
export function ConfirmHost() {
  const requests = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const current = requests[0]

  /**
   * What the sheet shows while it animates out.
   *
   * `Sheet` already freezes its own contents for the exit, but the *props* here
   * come from a queue that has already dropped the answered request — so
   * without this the tone and the labels would fall back to their defaults for
   * the 280ms the sheet spends leaving. Same reasoning as `Sheet`'s `held`.
   */
  const held = useRef<Request | undefined>(undefined)
  if (current) held.current = current
  const view = current ?? held.current

  const go = useRef<HTMLButtonElement>(null)
  /**
   * An ordinary confirmation focuses its own action, so Enter or Space answers
   * it. A destructive one deliberately does not: focus stays on the sheet's
   * frame, where neither key does anything, and the button has to be reached
   * for. That asymmetry is the whole point of asking about a delete — the
   * keystroke that dismisses a dialog must not also be the keystroke that
   * carries it out.
   *
   * This runs after `Sheet`'s own focus effect: a parent's effects fire after
   * its children's, so the frame takes focus first and this moves it on.
   */
  useEffect(() => {
    if (current && current.tone !== 'danger') go.current?.focus({ preventScroll: true })
  }, [current])

  if (!view) return null
  const paragraphs = typeof view.body === 'string' ? [view.body] : (view.body ?? [])

  return (
    <Sheet
      open={!!current}
      onClose={() => current && answer(current.id, false)}
      title={view.title}
      footer={
        <div className="flex gap-2">
          {view.cancelLabel !== false && (
            <Button
              variant="subtle"
              size="lg"
              className="flex-1"
              onClick={() => current && answer(current.id, false)}
            >
              {view.cancelLabel ?? 'Cancel'}
            </Button>
          )}
          <Button
            ref={go}
            variant={view.tone === 'danger' ? 'danger' : 'primary'}
            size="lg"
            className="flex-1"
            onClick={() => current && answer(current.id, true)}
          >
            {view.confirmLabel ?? 'Continue'}
          </Button>
        </div>
      }
    >
      <div className="space-y-2 pt-1">
        {paragraphs.map((p, i) => (
          <p key={i} className="text-sm text-ink-2">
            {p}
          </p>
        ))}
      </div>
    </Sheet>
  )
}

/**
 * What `alert()` was doing: something went wrong, and there is nothing to
 * decide about it.
 *
 * A confirmation with one button rather than a toast, because every one of
 * these is a *failure of the thing you just asked for* — an import that read no
 * rows, a delete the server refused — and a message that fades after four
 * seconds is the wrong shape for "that did not happen". Failures with a next
 * step keep their own inline explanation; this is for the ones whose next step
 * is "read this and try something else".
 */
export function alertAction(title: string, body?: string | string[]): Promise<void> {
  return confirmAction({ title, body, confirmLabel: 'OK', cancelLabel: false }).then(() => undefined)
}
