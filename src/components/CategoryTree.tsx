import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, Lock } from 'lucide-react'
import type { Category } from '../lib/db'
import { styleOf } from '../lib/categories'
import { blockLength, flatten, keyboardTarget, move, writesFor, type Depth, type Drop, type TreeRow } from '../lib/categoryTree'
import { useBudgets } from '../lib/cache'
import { update } from '../lib/data'
import { Card, CategoryDot, cx } from './ui'
import { appScrollY, scrollAppBy } from '../lib/scroll'

/**
 * Categories, rearranged by hand.
 *
 * The list was read-only, so the only way to change the shape of it was to
 * delete a category and make it again somewhere else — which takes its history
 * with it. Everything a couple's filing needs is a rearrangement: two
 * categories that should have been one parent and two children, a subcategory
 * that outgrew its parent, an order that matches how you think rather than the
 * order you happened to invent them in.
 *
 * ## What the drag does, and what it refuses
 *
 * All of the reasoning is in `lib/categoryTree.ts` and tested there; this file
 * is the gesture and nothing else. The two rules worth knowing while reading
 * it: a parent travels with its children, and nothing crosses between spending
 * and income. Both are the database's rules, mirrored so that a drop it would
 * reject is never offered — writes fail late and quietly here.
 *
 * ## Why an insertion line rather than a live reorder
 *
 * A list that reflows under the finger has to hit-test against geometry that
 * the reflow has just invalidated, and rows here are not a uniform height. The
 * line is measured once at the start of the drag, in the SCROLLER's coordinates
 * so that auto-scrolling does not invalidate it either, and it shows the real
 * landing spot: the position is taken from `move`'s own answer, so when a drop
 * is clamped — dragged into the middle of somebody else's children, or out of
 * its own half of the list — the line goes where the row will actually end up
 * rather than where the finger is.
 */

/**
 * How far sideways you drag to change a row's level.
 *
 * Short, because the handle is on the trailing edge: there are only about 38px
 * between it and the side of a 375px screen, so a threshold much past this is
 * one a thumb cannot reach without lifting off. It does not need to be long —
 * the level defaults to whatever the row above implies, so the gesture is only
 * for the cases where that guess is wrong.
 */
const INDENT_PX = 18
/** How close to the edge of the screen starts an auto-scroll. */
const EDGE = 84

export function CategoryTree({
  categories,
  onOpen,
}: {
  categories: Category[]
  onOpen: (category: Category) => void
}) {
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const rows = useMemo(() => flatten(categories), [categories])

  const list = useRef<HTMLDivElement>(null)
  /** Every row's box, in the scroller's coordinates, frozen when the drag begins. */
  const boxes = useRef<{ top: number; bottom: number }[]>([])
  /** The live pointer, in client coordinates, so an auto-scroll can re-ask. */
  const pointer = useRef({ x: 0, y: 0 })

  /**
   * Whether a drag is running, in a ref as well as in state.
   *
   * The first `pointermove` can arrive before React has re-rendered from the
   * `pointerdown`, so a handler that asks the state variable sees `null` and
   * throws the move away — the row lifts and then refuses to follow the finger
   * for the first frame or two. The ref is true the instant the press happens.
   */
  const dragging = useRef(false)
  const [drag, setDrag] = useState<{ id: string; from: number; n: number; x: number; y: number } | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [note, setNote] = useState<string | null>(null)

  /**
   * Where the dragged row will actually land.
   *
   * `move` is asked rather than guessed at, and the answer is mapped back to a
   * gap in the DISPLAYED rows — which still contain the block being dragged,
   * because nothing has reflowed.
   */
  const landing = useMemo(() => {
    if (!drag || !drop) return null
    const next = move(rows, drag.id, drop)
    if (next === rows) return null
    const j = next.findIndex((r) => r.id === drag.id)
    return { next, gap: j <= drag.from ? j : j + drag.n, depth: next[j].depth }
  }, [rows, drag, drop])

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
    setDrop((was) => {
      const dx = pointer.current.x - startX.current
      // The row above sets the default: under a subcategory you become its
      // sibling, under a parent you stay top level. Dragging sideways overrides
      // it, which is the whole vocabulary of the gesture.
      const above = index > 0 ? rows[index - 1] : undefined
      const natural: Depth = above ? above.depth : 0
      const depth: Depth = dx > INDENT_PX ? 1 : dx < -INDENT_PX ? 0 : natural
      return was?.index === index && was.depth === depth ? was : { index, depth }
    })
  }, [rows])

  const startX = useRef(0)
  const startY = useRef(0)

  function begin(e: React.PointerEvent, id: string) {
    const el = list.current
    if (!el) return
    e.preventDefault()
    // Capture keeps the move and up events coming to the handle once the finger
    // has left it, which is most of the drag. It throws if the pointer is no
    // longer active — the OS taking it back for a system gesture, a synthetic
    // event — and losing the whole drag to that is worse than running without
    // it, since the listeners are on the handle either way.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* carry on uncaptured */
    }
    boxes.current = [...el.querySelectorAll('[data-row]')].map((node) => {
      const r = node.getBoundingClientRect()
      return { top: r.top + appScrollY(), bottom: r.bottom + appScrollY() }
    })
    const from = rows.findIndex((r) => r.id === id)
    startX.current = e.clientX
    startY.current = e.clientY
    pointer.current = { x: e.clientX, y: e.clientY }
    setNote(null)
    dragging.current = true
    setDrag({ id, from, n: blockLength(rows, from), x: e.clientX, y: e.clientY })
    setDrop({ index: from, depth: rows[from].depth })
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
   * NOT commit. Treating it as a drop meant an interrupted drag silently
   * refiled a category wherever the finger happened to be.
   */
  function stop() {
    if (!dragging.current) return false
    dragging.current = false
    setDrag(null)
    setDrop(null)
    boxes.current = []
    return true
  }

  const budgeted = useBudgets()
  const apply = useCallback(
    async (next: TreeRow[]) => {
      const patches = writesFor(next, categories)
      if (patches.length === 0) return
      // A budget lives on a top-level category, so demoting one leaves its
      // budget in place but no longer counting. Recoverable — moving it back
      // out restores it — but silent, which is the part worth saying out loud.
      const orphaned = patches
        .filter((p) => p.patch.parentId !== undefined && budgeted.some((b) => b.categoryId === p.id))
        .map((p) => byId.get(p.id)?.name)
        .filter(Boolean)
      setNote(
        orphaned.length > 0
          ? `${orphaned.join(' and ')} had a budget. Budgets apply to top-level categories only, so it has stopped counting — move it back out to restore it.`
          : null,
      )
      for (const { id, patch } of patches) await update('categories', id, patch)
    },
    [categories, byId, budgeted],
  )

  // Escape abandons a drag, like every other reversible gesture in the app.
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stop()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // Follow the finger past the edge of the screen. The boxes are in the
  // SCROLLER's coordinates, so scrolling moves the target under them without any
  // of this having to be re-measured. Pointer and boxes are converted the same
  // way, so the scroller's own offset on screen cancels and never appears here.
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
    const at = rows.findIndex((r) => r.id === id)
    if (at < 0) return
    const target: Drop | null =
      e.key === 'ArrowUp' || e.key === 'ArrowDown'
        ? keyboardTarget(rows, id, e.key === 'ArrowUp' ? 'up' : 'down')
        : e.key === 'ArrowRight'
          ? { index: at, depth: 1 }
          : e.key === 'ArrowLeft'
            ? { index: at, depth: 0 }
            : null
    if (!target) return
    e.preventDefault()
    const next = move(rows, id, target)
    if (next !== rows) void apply(next)
  }

  if (rows.length === 0) return null

  let seenIncome = false
  return (
    <>
      <Card className={cx('overflow-hidden', drag && 'select-none')}>
        <div ref={list} className="relative py-1">
          {rows.map((row, i) => {
            const category = byId.get(row.id)
            if (!category) return null
            const style = styleOf(category, byId)
            const heading = row.kind === 'income' && !seenIncome ? ((seenIncome = true), true) : false
            const lifted = drag?.id === row.id
            // Children of a lifted parent travel with it, so they dim too.
            const travelling = !!drag && i > drag.from && i < drag.from + drag.n

            return (
              <div key={row.id}>
                {i === 0 && <Divider>Spending</Divider>}
                {heading && <Divider>Income</Divider>}
                {landing?.gap === i && <Line depth={landing.depth} />}
                {/* The outer element keeps the row's space in the list while the
                    inner one is transformed out of it, so the gap left behind
                    is visibly where the row came FROM rather than an unexplained
                    hole — and the frozen geometry stays true, because the box
                    that was measured is the one that is still here. */}
                <div className={cx('relative', lifted && 'rounded-xl bg-surface-2/60')}>
                <div
                  data-row={row.id}
                  className={cx(
                    'relative flex items-center gap-2 pr-1 transition-colors',
                    // The indent is now the padding alone, the handle having
                    // moved out of the left edge — 24px between the two levels,
                    // the same step as before.
                    row.depth === 1 ? 'pl-9' : 'pl-3',
                    lifted && 'z-20 rounded-xl bg-surface/95 shadow-lg ring-1 ring-accent/40 backdrop-blur-sm',
                    travelling && 'opacity-40',
                  )}
                  style={
                    lifted
                      ? {
                          transform: `translate(${clamp(drag.x - startX.current, -40, 40)}px, ${drag.y - startY.current}px)`,
                        }
                      : undefined
                  }
                >
                  <button
                    type="button"
                    onClick={() => onOpen(category)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-2.5 text-left desktop:py-1.5"
                  >
                    <CategoryDot
                      category={{ ...category, ...style }}
                      size={row.depth === 0 ? 30 : 24}
                      className="md:[--dot:24px]"
                    />
                    <span
                      className={cx(
                        'min-w-0 flex-1 truncate md:text-sm',
                        row.depth === 0 ? 'font-medium' : 'text-ink-2',
                      )}
                    >
                      {category.name}
                    </span>
                    {category.ownerId && <Lock size={12} className="shrink-0 text-ink-3" />}
                  </button>
                  {/* On the trailing edge, where a list you can reorder puts it
                      on both phone platforms — and where it does not push the
                      badges out of the column they share with every other list
                      in the app. */}
                  <button
                    type="button"
                    aria-label={`Move ${category.name}`}
                    // `touch-action: none` only here: the browser must not treat
                    // a drag off the handle as a scroll, but the rest of the
                    // list has to keep scrolling normally.
                    className="grid size-9 shrink-0 cursor-grab touch-none place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink-2 active:cursor-grabbing"
                    onPointerDown={(e) => begin(e, row.id)}
                    onPointerMove={track}
                    onPointerUp={finish}
                    onPointerCancel={stop}
                    onKeyDown={(e) => onKey(e, row.id)}
                  >
                    <GripVertical size={16} />
                  </button>
                </div>
                </div>
              </div>
            )
          })}
          {landing?.gap === rows.length && <Line depth={landing.depth} />}
        </div>
      </Card>

      <p className="mt-2 px-1 text-xs text-ink-3">
        Drag the handle to reorder. Drag right to file one under the category above it, left to bring it back
        out. With the handle focused, the arrow keys do the same.
      </p>
      {note && <p className="mt-1.5 px-1 text-xs text-ink-2">{note}</p>}
    </>
  )
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

function Divider({ children }: { children: string }) {
  return (
    <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-3 first:pt-1">{children}</p>
  )
}

/** Where the row will land, at the depth it will land at. */
function Line({ depth }: { depth: Depth }) {
  return (
    // Above the lifted row (z-20), which would otherwise pass straight over the
    // one thing the drag is being aimed at.
    // Aligned with the badge at each level — the same `pl-3` / `pl-9` the rows
    // carry, so the line reads as "this deep" rather than as its own margin.
    <div className={cx('pointer-events-none relative z-30 h-0', depth === 1 ? 'ml-9' : 'ml-3')} aria-hidden>
      <div className="absolute inset-x-0 -top-px h-0.5 rounded-full bg-accent">
        <span className="absolute -left-1 -top-[3px] size-2 rounded-full bg-accent" />
      </div>
    </div>
  )
}
