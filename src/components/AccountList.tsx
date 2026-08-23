import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'
import type { Account } from '../lib/db'
import { byOrder, keyboardTarget, move, writesFor } from '../lib/accountOrder'
import { update } from '../lib/data'
import { Card, cx } from './ui'
import { appScrollY, scrollAppBy } from '../lib/scroll'

/**
 * The accounts, rearranged by hand.
 *
 * The same gesture the category list has, and deliberately the same file shape:
 * all of the reasoning is in `lib/accountOrder.ts` and tested there, and this
 * is the drag and nothing else. What is different is that the list is flat —
 * there is no depth to drag sideways to, no family to travel with a parent and
 * no half of the list nothing may cross — so the insertion line only ever
 * answers "between which two rows", and there is no sideways travel at all.
 *
 * Why an insertion line rather than a live reorder is the note in
 * `CategoryTree`: rows are not a uniform height, and a list that reflows under
 * the finger has to hit-test against geometry the reflow has just invalidated.
 * The boxes are frozen at pick-up in the SCROLLER's coordinates, so an
 * auto-scroll moves the target under them without invalidating anything.
 *
 * ## Who may drag
 *
 * `sortOrder` is a column on the account row, so a reorder is an ordinary
 * `accounts_update` and needs `manage` — and because every account starts at 0
 * a move renumbers every row it passes rather than just the one that moved.
 * A list holding somebody else's account therefore cannot be renumbered at all
 * without queueing a write the server will refuse, minutes later, as a dead
 * letter. `canReorder` is that gate, decided by the caller, and when it is
 * false this is exactly the list it always was.
 */
export function AccountList({
  accounts,
  canReorder,
  renderRow,
}: {
  accounts: Account[]
  /** Whether every account here is one you may write. See the note above. */
  canReorder: boolean
  renderRow: (account: Account) => React.ReactNode
}) {
  const ordered = useMemo(() => [...accounts].sort(byOrder), [accounts])
  const ids = useMemo(() => ordered.map((a) => a.id), [ordered])

  const list = useRef<HTMLDivElement>(null)
  /** Every row's box, in the scroller's coordinates, frozen when the drag begins. */
  const boxes = useRef<{ top: number; bottom: number }[]>([])
  /** The live pointer, in client coordinates, so an auto-scroll can re-ask. */
  const pointer = useRef({ x: 0, y: 0 })
  /**
   * Whether a drag is running, in a ref as well as in state: the first
   * `pointermove` can arrive before React has re-rendered from the
   * `pointerdown`, and a handler that asks the state variable throws that move
   * away — the row lifts and then refuses to follow the finger for a frame.
   */
  const dragging = useRef(false)
  const startX = useRef(0)
  const startY = useRef(0)
  const [drag, setDrag] = useState<{ id: string; from: number; x: number; y: number } | null>(null)
  const [gap, setGap] = useState<number | null>(null)

  /** Where the dragged row will actually land, as a gap in the displayed rows. */
  const landing = useMemo(() => {
    if (!drag || gap === null) return null
    const next = move(ids, drag.id, gap)
    if (next === ids) return null
    const j = next.indexOf(drag.id)
    return { next, gap: j <= drag.from ? j : j + 1 }
  }, [ids, drag, gap])

  /** Re-read the drop target from the last known pointer and the frozen boxes. */
  const reread = useCallback(() => {
    const d = boxes.current
    if (d.length === 0) return
    const y = pointer.current.y + appScrollY()
    let index = d.length
    for (let i = 0; i < d.length; i++) {
      if (y < (d[i].top + d[i].bottom) / 2) {
        index = i
        break
      }
    }
    setDrag((was) => (was ? { ...was, x: pointer.current.x, y: pointer.current.y } : was))
    setGap((was) => (was === index ? was : index))
  }, [])

  function begin(e: React.PointerEvent, id: string) {
    const el = list.current
    if (!el) return
    e.preventDefault()
    // Capture keeps the move and up events coming once the finger has left the
    // handle, which is most of the drag. It throws if the pointer is no longer
    // active, and losing the whole drag to that is worse than running without
    // it — the listeners are on the handle either way.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* carry on uncaptured */
    }
    boxes.current = [...el.querySelectorAll('[data-row]')].map((node) => {
      const r = node.getBoundingClientRect()
      return { top: r.top + appScrollY(), bottom: r.bottom + appScrollY() }
    })
    const from = ids.indexOf(id)
    startX.current = e.clientX
    startY.current = e.clientY
    pointer.current = { x: e.clientX, y: e.clientY }
    dragging.current = true
    setDrag({ id, from, x: e.clientX, y: e.clientY })
    setGap(from)
  }

  function track(e: React.PointerEvent) {
    if (!dragging.current) return
    pointer.current = { x: e.clientX, y: e.clientY }
    reread()
  }

  /** Let go: take the landing spot if there is one. A tap on the handle has none. */
  function finish() {
    const target = landing
    if (!stop()) return
    if (target) void apply(target.next)
  }

  /**
   * Put it back.
   *
   * `pointercancel` is the system taking the gesture away — an edge swipe, a
   * call arriving, the browser deciding it was a scroll after all — so it must
   * NOT commit, or an interrupted drag silently refiles an account wherever the
   * finger happened to be.
   */
  function stop() {
    if (!dragging.current) return false
    dragging.current = false
    setDrag(null)
    setGap(null)
    boxes.current = []
    return true
  }

  const apply = useCallback(
    async (next: string[]) => {
      for (const { id, patch } of writesFor(next, ordered)) await update('accounts', id, patch)
    },
    [ordered],
  )

  // Escape abandons a drag, like every other reversible gesture in the app.
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stop()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // Follow the finger past the edge of the screen. The boxes are in the
  // SCROLLER's coordinates, so scrolling moves the target under them without
  // any of this having to be re-measured.
  useEffect(() => {
    if (!drag) return
    let frame = requestAnimationFrame(function tick() {
      const { y } = pointer.current
      const over = y - EDGE
      const under = window.innerHeight - y - EDGE
      const by = over < 0 ? Math.max(-16, over / 4) : under < 0 ? Math.min(16, -under / 4) : 0
      if (by !== 0) {
        scrollAppBy(0, by)
        reread()
      }
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [drag, reread])

  function onKey(e: React.KeyboardEvent, id: string) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    const target = keyboardTarget(ids, id, e.key === 'ArrowUp' ? 'up' : 'down')
    if (target === null) return
    e.preventDefault()
    const next = move(ids, id, target)
    if (next !== ids) void apply(next)
  }

  return (
    <>
      <Card className={cx('overflow-hidden', drag && 'select-none')}>
        <div ref={list} className="relative divide-y divide-hairline">
          {ordered.map((account, i) => {
            const lifted = drag?.id === account.id
            return (
              <div key={account.id}>
                {landing?.gap === i && <Line />}
                {/* The outer element keeps the row's space in the list while
                    the inner one is transformed out of it, so the gap left
                    behind is visibly where the row came FROM — and the frozen
                    geometry stays true, because the box that was measured is
                    the one that is still here. */}
                <div className={cx('relative', lifted && 'bg-surface-2/60')}>
                  <div
                    data-row={account.id}
                    className={cx(
                      'relative flex items-center transition-colors',
                      lifted && 'z-20 rounded-xl bg-surface/95 shadow-lg ring-1 ring-accent/40 backdrop-blur-sm',
                    )}
                    style={
                      lifted
                        ? {
                            transform: `translate(${clamp(drag.x - startX.current, -40, 40)}px, ${drag.y - startY.current}px)`,
                          }
                        : undefined
                    }
                  >
                    <div className="min-w-0 flex-1">{renderRow(account)}</div>
                    {canReorder && (
                      /* On the trailing edge, where a list you can reorder puts
                         it on both phone platforms, and where the category list
                         already has it. */
                      <button
                        type="button"
                        aria-label={`Move ${account.name}`}
                        // `touch-action: none` only here: the browser must not
                        // treat a drag off the handle as a scroll, but the rest
                        // of the list has to keep scrolling normally.
                        className="mr-2 grid size-9 shrink-0 cursor-grab touch-none place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink-2 active:cursor-grabbing md:mr-1"
                        onPointerDown={(e) => begin(e, account.id)}
                        onPointerMove={track}
                        onPointerUp={finish}
                        onPointerCancel={stop}
                        onKeyDown={(e) => onKey(e, account.id)}
                      >
                        <GripVertical size={16} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        {/* Outside the divided list: `divide-y` would give a landing line at
            the very end a hairline of its own to sit under. */}
        {landing?.gap === ordered.length && <Line />}
      </Card>

      {canReorder && ordered.length > 1 && (
        <p className="mt-2 px-1 text-xs text-ink-3">
          Drag the handle to reorder. With it focused, the arrow keys do the same.
        </p>
      )}
    </>
  )
}

/** How close to the edge of the screen starts an auto-scroll. */
const EDGE = 84

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

/** Where the row will land. */
function Line() {
  return (
    // Above the lifted row (z-20), which would otherwise pass straight over the
    // one thing the drag is being aimed at.
    <div className="pointer-events-none relative z-30 ml-3 h-0" aria-hidden>
      <div className="absolute inset-x-0 -top-px h-0.5 rounded-full bg-accent">
        <span className="absolute -left-1 -top-[3px] size-2 rounded-full bg-accent" />
      </div>
    </div>
  )
}
