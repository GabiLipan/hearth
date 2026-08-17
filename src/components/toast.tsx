import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, Undo2, X } from 'lucide-react'
import { cx, useViewportInset } from './ui'

/**
 * The app's one success channel.
 *
 * Every write goes through the outbox, so a save is instant locally and lands
 * on the server up to a minute later. That is the right architecture and it
 * left the UI with nothing to say: a bulk recategorisation reported "18
 * updated, 3 are Sam's" to nobody, an online-only RPC that failed said so in
 * one place out of four, and a delete simply removed a row and hoped you meant
 * it.
 *
 * Deliberately NOT where the sync banner lives. `SyncBanner` is a persistent
 * strip because a failed write is a standing condition that outlives the
 * moment — a toast that vanishes after three seconds is the wrong shape for
 * "you are offline and eleven changes are queued". This is the opposite: the
 * outcome of something you just did, which stops being interesting almost at
 * once. The two do not overlap and neither replaces the other.
 *
 * A module-level store rather than context, for the reason `useBook` gives:
 * these are raised from event handlers, from `lib/` and from inside sheets
 * three components deep, and threading a setter to all of them is ceremony
 * with a new place to forget it every time.
 */

export type ToastTone = 'info' | 'success' | 'error'

export type Toast = {
  id: number
  message: string
  tone: ToastTone
  /** Offered as an "Undo" button; the toast dismisses itself once it is taken. */
  undo?: () => void | Promise<void>
  /** Milliseconds on screen, before the exit animation. */
  duration: number
  /** Set while it animates out. See `EXIT_MS`. */
  leaving?: boolean
}

/**
 * Long enough to reach for, short enough not to sit over the tab bar.
 *
 * An undoable toast gets longer because it is the only one carrying an action:
 * the others are read, and this one has to be *reached*, which on a phone means
 * noticing it and travelling to it.
 */
const PLAIN_MS = 4500
const UNDO_MS = 8000
/** Must outlast the exit animation in `index.css` (`fade-out`, 180ms). */
const EXIT_MS = 200

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  // A new array identity every time: `useSyncExternalStore` compares with
  // `Object.is`, so mutating in place would publish nothing.
  toasts = [...toasts]
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = () => toasts
/** The server has no toasts, and neither does the first render on a cold cache. */
const serverSnapshot = () => EMPTY
const EMPTY: Toast[] = []

export function dismissToast(id: number) {
  const found = toasts.find((t) => t.id === id)
  if (!found || found.leaving) return
  found.leaving = true
  emit()
  // A TIMER, never the animation's own end event: a backgrounded tab runs no
  // transitions, so a toast removed by `transitionend` would still be sitting
  // over the page when the app came back. Same reasoning as `useSweep` and the
  // touch tooltip.
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id)
    emit()
  }, EXIT_MS)
}

/**
 * Say what just happened.
 *
 * ```ts
 * toast('Transaction deleted', { undo: () => restore(txn) })
 * toast('That didn’t save — you need a connection for this', { tone: 'error' })
 * ```
 */
export function toast(
  message: string,
  options: { tone?: ToastTone; undo?: () => void | Promise<void>; duration?: number } = {},
) {
  const id = nextId++
  const duration = options.duration ?? (options.undo ? UNDO_MS : PLAIN_MS)
  toasts = [...toasts, { id, message, tone: options.tone ?? 'info', undo: options.undo, duration }]
  // Three is where a stack stops being readable and starts being a wall. The
  // oldest goes, because the newest is the one describing what you just did.
  while (toasts.filter((t) => !t.leaving).length > 3) {
    const oldest = toasts.find((t) => !t.leaving)
    if (!oldest) break
    dismissToast(oldest.id)
  }
  emit()
  return id
}

export function useToasts() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

/**
 * Where toasts appear.
 *
 * Mounted once, at the top of the app rather than inside `Layout`, so the
 * sign-in screens can raise one too.
 *
 * `z-[60]` puts it above a `Sheet` (`z-50`) on purpose: the bulk-apply result
 * and the "that needs a connection" failures are both raised from inside a
 * sheet, and a toast the sheet covers is a toast nobody reads.
 */
export function Toaster() {
  const items = useToasts()
  // The same correction the FAB makes: iOS does not always hand a standalone
  // app a viewport that reaches the bottom of the screen.
  const { below } = useViewportInset()
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      // `polite` rather than `assertive`: these describe something the user
      // just did, so they can wait for a gap in whatever is being read. The
      // region is always present and always empty-or-not — a live region added
      // to the document at the same moment as its content is not announced.
      role="status"
      aria-live="polite"
      style={below ? { transform: `translateY(${below}px)` } : undefined}
      className={cx(
        'pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4',
        // Clear of the mobile tab bar and the FAB above it; an ordinary margin
        // on a wide screen, where neither exists. `--tabbar-h` is the dock's
        // measured height (bar plus the gap under it), so this tracks the bar
        // rather than restating its size and drifting from it — which is what
        // the hand-added `4.75rem + safe-area` here used to do.
        'bottom-[calc(var(--tabbar-h,4.75rem)_+_3.5rem)] md:bottom-4',
      )}
    >
      {items.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>,
    document.body,
  )
}

function ToastRow({ toast: t }: { toast: Toast }) {
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (t.leaving) return
    const timer = setTimeout(() => dismissToast(t.id), t.duration)
    return () => clearTimeout(timer)
  }, [t.id, t.duration, t.leaving])

  const undo = async () => {
    if (!t.undo || busy) return
    setBusy(true)
    try {
      await t.undo()
    } finally {
      dismissToast(t.id)
    }
  }

  return (
    <div
      className={cx(
        'pointer-events-auto flex w-full max-w-md items-center gap-2.5 rounded-xl px-3.5 py-2.5 shadow-lg ring-1',
        'bg-surface ring-hairline',
        t.leaving ? 'animate-fade-out' : 'animate-sheet',
      )}
    >
      {t.tone === 'error' ? (
        <AlertTriangle size={16} className="shrink-0 text-critical-text" />
      ) : t.tone === 'success' ? (
        <Check size={16} className="shrink-0 text-good-text" />
      ) : null}
      <p className="min-w-0 flex-1 text-sm text-ink">{t.message}</p>
      {t.undo && (
        <button
          type="button"
          onClick={() => void undo()}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-ink transition-colors hover:brightness-97 disabled:opacity-60 dark:hover:brightness-110"
        >
          <Undo2 size={13} /> Undo
        </button>
      )}
      <button
        type="button"
        onClick={() => dismissToast(t.id)}
        aria-label="Dismiss"
        className="grid size-6 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <X size={13} />
      </button>
    </div>
  )
}
