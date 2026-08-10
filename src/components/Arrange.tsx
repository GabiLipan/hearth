import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Check, EyeOff, Plus, SlidersHorizontal } from 'lucide-react'
import { getSetting, setSetting } from '../lib/db'
import {
  bands,
  currentVariant,
  effectiveSpan,
  moveTo,
  nextSpan,
  normaliseLayout,
  setSpan,
  setVariant,
  toggle,
  type LayoutItem,
  type SectionDef,
} from '../lib/layout'
import { Columns, Popover, cx } from './ui'

/**
 * A page you can rearrange with your hands.
 *
 * ## Why there is no drag handle
 *
 * Because a handle is a permanent piece of furniture in service of an
 * occasional act. The category list can afford one — it is a list of plain rows
 * with a spare 36px on the trailing edge — but a page of cards cannot: every
 * card already has a heading, a figure and usually a link in the corner where a
 * grip would want to sit, and eight grips are eight pieces of chrome on a page
 * whose whole job is to be read.
 *
 * So the card IS the handle, in the two situations where a press can only mean
 * "move this":
 *
 *   - in Customise mode, where nothing inside a card is interactive anyway;
 *   - on a long press anywhere on a card that is not itself a control, which is
 *     the platform idiom for "pick this up" on both phones, and which enters
 *     Customise mode as it lifts so the gesture explains itself.
 *
 * The long press is refused over a button, a link or a field. Holding a finger
 * on "Pay it back" while deciding must not turn into a drag, and cancelling
 * that press would be worse than not offering the gesture there.
 *
 * ## Why the geometry is frozen
 *
 * The same reason `CategoryTree` freezes it: hit-testing against a layout that
 * is reflowing under the finger tests geometry the reflow has just invalidated.
 * Boxes are measured once at pick-up in DOCUMENT coordinates, so an auto-scroll
 * moves the page under them without invalidating anything, and the caret is
 * drawn from `moveTo`'s own answer rather than from the pointer — a drop that
 * lands somewhere other than where the finger is says so before you let go.
 *
 * `pointercancel` must not commit. It is the system taking the gesture away.
 */

/** How long a press has to last, outside Customise mode, to become a lift. */
const HOLD_MS = 420
/** How far the finger may stray during that press before it is a scroll instead. */
const SLOP = 8
/** How close to the edge of the screen starts an auto-scroll. */
const EDGE = 84

/* ---------- the stored layout ---------- */

/**
 * A page's arrangement, loaded once and written back on every change.
 *
 * `ready` matters: the first render happens before the settings row has been
 * read, and painting the catalogue's default order and then reshuffling it a
 * frame later is a page that visibly rearranges itself every time you open it.
 */
export function useLayout(key: string, catalogue: SectionDef[]) {
  const [layout, setLayoutState] = useState<LayoutItem[]>(() => normaliseLayout(null, catalogue))
  const [ready, setReady] = useState(false)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    let live = true
    void getSetting(key).then((raw) => {
      if (!live) return
      let stored: unknown = null
      try {
        stored = raw ? JSON.parse(raw) : null
      } catch {
        /* a layout we cannot read is one we start again from */
      }
      setLayoutState(normaliseLayout(stored, catalogue))
      setReady(true)
    })
    return () => {
      live = false
    }
    // The catalogue is rebuilt every render by its page; its identity says
    // nothing. The key is what decides which page's layout this is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const setLayout = useCallback(
    (next: LayoutItem[]) => {
      setLayoutState(next)
      void setSetting(key, JSON.stringify(next))
    },
    [key],
  )

  return { layout, setLayout, ready, editing, setEditing }
}

/* ---------- the grid ---------- */

/**
 * One section's box, and which position in the visible list it belongs to.
 *
 * The index is carried rather than implied by the array's own order, for two
 * reasons that both bite. `Columns` distributes cards down columns, so DOCUMENT
 * order is not reading order — the second card on the page is the top of column
 * two, not the second `data-section` in the DOM. And a section whose data has
 * nothing to show renders empty and is hidden, so it has a box of zero size
 * that must not be allowed to win "nearest centre" from the far corner of the
 * page.
 */
interface Box {
  /** Position in the visible list, which is what `moveTo` counts gaps in. */
  index: number
  left: number
  top: number
  right: number
  bottom: number
}

export function Arrange({
  catalogue,
  layout,
  onLayout,
  columns,
  editing,
  onEditing,
  render,
  gap = 'gap-3 md:gap-2.5',
}: {
  catalogue: SectionDef[]
  layout: LayoutItem[]
  onLayout: (next: LayoutItem[]) => void
  columns: number
  editing: boolean
  onEditing: (next: boolean) => void
  /**
   * One section. `controls` is the chart-shape picker, or null where the
   * section offers no choice — sections place it in their own heading, because
   * only they know where their heading is.
   */
  render: (args: { item: LayoutItem; def: SectionDef; variant?: string; controls: ReactNode }) => ReactNode
  gap?: string
}) {
  const defs = useMemo(() => new Map(catalogue.map((d) => [d.id, d])), [catalogue])
  const visible = useMemo(() => layout.filter((i) => i.on && defs.has(i.id)), [layout, defs])
  const hidden = useMemo(() => layout.filter((i) => !i.on && defs.has(i.id)), [layout, defs])

  const wrap = useRef<HTMLDivElement>(null)
  /** Every visible section's box, in document coordinates, frozen at pick-up. */
  const boxes = useRef<Box[]>([])
  /** The wrapper's own document origin, frozen with them, so the caret can be drawn inside it. */
  const anchor = useRef({ x: 0, y: 0 })
  const pointer = useRef({ x: 0, y: 0 })
  const start = useRef({ x: 0, y: 0 })
  /**
   * True the instant the press becomes a drag — before React has re-rendered.
   * A `pointermove` that arrives first would otherwise be thrown away, and the
   * card would refuse to follow the finger for a frame or two.
   */
  const dragging = useRef(false)
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [drag, setDrag] = useState<{ id: string; from: number; dx: number; dy: number } | null>(null)
  const [gapAt, setGapAt] = useState<number | null>(null)

  /** Where the caret goes, in wrapper-relative coordinates. */
  const caret = useMemo(() => {
    if (gapAt === null || !drag) return null
    const b = boxes.current
    if (b.length === 0) return null
    // The caret sits on the leading edge of the section that will follow it, or
    // on the trailing edge of the last one when the drop is past the end.
    const after = b.find((box) => box.index >= gapAt)
    const box = after ?? b[b.length - 1]
    return {
      left: (after ? box.left : box.right) - anchor.current.x,
      top: box.top - anchor.current.y,
      height: box.bottom - box.top,
    }
  }, [gapAt, drag])

  /** Re-read the drop target from the last known pointer and the frozen boxes. */
  const reread = useCallback(() => {
    const b = boxes.current
    if (b.length === 0) return
    const x = pointer.current.x + window.scrollX
    const y = pointer.current.y + window.scrollY

    let box = b.find((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
    if (!box) {
      // Outside every card — in a gutter, or past the end of the page. The
      // nearest centre is the honest reading of where the finger is pointing.
      let best = Infinity
      for (const r of b) {
        const d = (x - (r.left + r.right) / 2) ** 2 + (y - (r.top + r.bottom) / 2) ** 2
        if (d < best) {
          best = d
          box = r
        }
      }
    }
    if (!box) return
    const gap = x < (box.left + box.right) / 2 ? box.index : box.index + 1
    setGapAt((was) => (was === gap ? was : gap))
    setDrag((was) =>
      was ? { ...was, dx: pointer.current.x - start.current.x, dy: pointer.current.y - start.current.y } : was,
    )
  }, [])

  const begin = useCallback(
    (id: string, clientX: number, clientY: number) => {
      const el = wrap.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      anchor.current = { x: rect.left + window.scrollX, y: rect.top + window.scrollY }
      const at = new Map(visible.map((i, index) => [i.id, index]))
      boxes.current = []
      for (const node of el.querySelectorAll('[data-section]')) {
        const index = at.get(node.getAttribute('data-section') ?? '')
        const r = node.getBoundingClientRect()
        // A section with nothing to show is hidden, and a zero box would sit at
        // the origin waiting to be somebody's nearest centre.
        if (index === undefined || r.width === 0 || r.height === 0) continue
        boxes.current.push({
          index,
          left: r.left + window.scrollX,
          top: r.top + window.scrollY,
          right: r.right + window.scrollX,
          bottom: r.bottom + window.scrollY,
        })
      }
      boxes.current.sort((a, b) => a.index - b.index)
      const from = visible.findIndex((i) => i.id === id)
      if (from < 0) return
      start.current = { x: clientX, y: clientY }
      pointer.current = { x: clientX, y: clientY }
      dragging.current = true
      setDrag({ id, from, dx: 0, dy: 0 })
      setGapAt(from)
    },
    [visible],
  )

  /** Put it back without committing. */
  const stop = useCallback(() => {
    clearTimeout(hold.current)
    if (!dragging.current) return false
    dragging.current = false
    setDrag(null)
    setGapAt(null)
    boxes.current = []
    return true
  }, [])

  function down(e: React.PointerEvent, id: string) {
    // Only the primary button, and never a press that started on a control.
    if (e.button !== 0) return
    const onControl = (e.target as Element | null)?.closest(
      'button, a, input, select, textarea, [role="button"], [data-no-drag]',
    )
    if (editing) {
      if (onControl) return
      e.preventDefault()
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* carry on uncaptured — the listeners are on the card either way */
      }
      begin(id, e.clientX, e.clientY)
      return
    }
    if (onControl) return
    // Not in Customise mode: a long press picks it up, and turns Customise on
    // as it lifts so the mode change is something you watch happen.
    const { clientX, clientY, pointerId, currentTarget } = e
    start.current = { x: clientX, y: clientY }
    pointer.current = { x: clientX, y: clientY }
    clearTimeout(hold.current)
    hold.current = setTimeout(() => {
      if (Math.abs(pointer.current.x - clientX) > SLOP || Math.abs(pointer.current.y - clientY) > SLOP) return
      try {
        currentTarget.setPointerCapture(pointerId)
      } catch {
        /* as above */
      }
      onEditing(true)
      begin(id, clientX, clientY)
    }, HOLD_MS)
  }

  function track(e: React.PointerEvent) {
    pointer.current = { x: e.clientX, y: e.clientY }
    if (!dragging.current) {
      // A press that has started travelling is a scroll, not a lift.
      if (Math.abs(e.clientX - start.current.x) > SLOP || Math.abs(e.clientY - start.current.y) > SLOP) {
        clearTimeout(hold.current)
      }
      return
    }
    reread()
  }

  function finish() {
    const target = gapAt
    const id = drag?.id
    if (!stop()) return
    if (id != null && target != null) {
      const next = moveTo(layout, id, target)
      if (next !== layout) onLayout(next)
    }
  }

  // Escape abandons a drag, as everywhere else in the app.
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stop()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drag, stop])

  // Follow the finger past the edge of the screen. The boxes are in document
  // coordinates, so scrolling moves the page under them with nothing to re-measure.
  useEffect(() => {
    if (!drag) return
    let frame = requestAnimationFrame(function tick() {
      const { y } = pointer.current
      const over = y - EDGE
      const under = window.innerHeight - y - EDGE
      const by = over < 0 ? Math.max(-16, over / 4) : under < 0 ? Math.min(16, -under / 4) : 0
      if (by !== 0) {
        window.scrollBy(0, by)
        reread()
      }
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [drag, reread])

  // A press that is never released — the tab is closed, the component unmounts
  // — must not leave a timer holding a stale callback.
  useEffect(() => () => clearTimeout(hold.current), [])

  function keys(e: React.KeyboardEvent, id: string) {
    const from = visible.findIndex((i) => i.id === id)
    if (from < 0) return
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp'
    const on = e.key === 'ArrowRight' || e.key === 'ArrowDown'
    if (back || on) {
      e.preventDefault()
      const next = moveTo(layout, id, back ? from - 1 : from + 2)
      if (next !== layout) onLayout(next)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const item = visible[from]
      onLayout(setSpan(layout, id, nextSpan(item.span, columns)))
    }
  }

  const section = (item: LayoutItem) => {
    const def = defs.get(item.id)
    if (!def) return null
    const lifted = drag?.id === item.id
    return (
      <div
        key={item.id}
        data-section={item.id}
        // `touch-action: none` only while arranging: a vertical drag on a card
        // must not scroll the page then, and must do nothing else the rest of
        // the time. Outside Customise mode the long press is cancelled by any
        // travel, so the browser keeps the scroll.
        // A widget with nothing to say renders nothing — no accounts, no bills
        // due — and its wrapper must disappear with it rather than leaving a
        // gap, or in Customise mode a dashed outline around a void. `:empty`
        // on the wrapper itself cannot see that, because the wrapper always has
        // the inner box (and, while arranging, the controls) inside it; `:has`
        // asks about the inner box instead.
        className={cx('relative min-w-0 [&:has(>div:empty)]:hidden', editing && 'touch-none select-none')}
        style={lifted ? { transform: `translate(${drag.dx}px, ${drag.dy}px)`, zIndex: 30 } : undefined}
        tabIndex={editing ? 0 : undefined}
        aria-label={editing ? `${def.label}. Arrow keys to move, Enter to change its width.` : undefined}
        onPointerDown={(e) => down(e, item.id)}
        onPointerMove={track}
        onPointerUp={finish}
        onPointerCancel={stop}
        onKeyDown={editing ? (e) => keys(e, item.id) : undefined}
      >
        <div
          className={cx(
            'transition-[box-shadow,transform,opacity]',
            editing && 'rounded-2xl ring-2 ring-dashed ring-accent/40 md:rounded-xl',
            lifted && 'scale-[1.02] opacity-95 shadow-2xl ring-accent',
          )}
        >
          {render({
            item,
            def,
            variant: currentVariant(def, item),
            controls: def.variants?.length ? (
              <VariantPicker
                def={def}
                value={currentVariant(def, item)}
                onChange={(v) => onLayout(setVariant(layout, item.id, v))}
              />
            ) : null,
          })}
        </div>

        {editing && !lifted && (
          <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-full bg-surface p-1 shadow-md ring-1 ring-hairline">
            <button
              onClick={() => onLayout(setSpan(layout, item.id, nextSpan(item.span, columns)))}
              aria-label={`Change the width of ${def.label}`}
              title="Width"
              className="grid size-7 place-items-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <WidthGlyph filled={effectiveSpan(item.span, columns)} of={columns} />
            </button>
            <button
              onClick={() => onLayout(toggle(layout, item.id))}
              aria-label={`Hide ${def.label}`}
              title="Hide"
              className="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              <EyeOff size={14} />
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div ref={wrap} className={cx('relative flex flex-col', gap)}>
        {bands(visible, columns).map((band, i) =>
          band.kind === 'masonry' ? (
            <Columns key={`b${i}`} count={columns} gap={gap}>
              {band.items.map(section)}
            </Columns>
          ) : (
            <div key={`b${i}`} className={cx('flex flex-col', gap)}>
              {band.rows.map((row, j) => (
                <div key={j} className={cx('flex items-start', gap)}>
                  {row.map(({ item, span }) => (
                    <div
                      key={item.id}
                      className="min-w-0"
                      // `flexGrow` from the span and a zero basis, so two
                      // sections sharing a row split it by their widths rather
                      // than by their contents.
                      style={{ flex: `${span} 1 0%` }}
                    >
                      {section(item)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ),
        )}

        {caret && (
          <div
            aria-hidden
            className="pointer-events-none absolute z-40 w-1 -translate-x-1/2 rounded-full bg-accent"
            style={{ left: caret.left, top: caret.top, height: caret.height }}
          />
        )}
      </div>

      {editing && hidden.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 px-1 text-sm font-semibold uppercase tracking-wide text-ink-3">Not shown</p>
          <div className="flex flex-wrap gap-2">
            {hidden.map((item) => (
              <button
                key={item.id}
                onClick={() => onLayout(toggle(layout, item.id))}
                className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3.5 py-2 text-sm font-medium text-ink-2 hover:text-ink"
              >
                <Plus size={14} /> {defs.get(item.id)?.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <p className="mt-3 px-1 text-center text-xs text-ink-3">
          Drag a card to move it. The button in its corner changes how wide it is; with a card focused, the
          arrow keys move it and Enter changes its width.
        </p>
      )}

      <div className="mt-5 flex justify-center">
        <button
          onClick={() => onEditing(!editing)}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition',
            editing ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-ink-3 hover:text-ink',
          )}
        >
          {editing ? (
            <>
              <Check size={15} /> Done
            </>
          ) : (
            <>
              <SlidersHorizontal size={15} /> Customise
            </>
          )}
        </button>
      </div>
    </div>
  )
}

/**
 * How wide this card is, drawn rather than named.
 *
 * "1 of 3 columns" is a sentence; a row of cells with the first one filled is
 * the same fact at a glance, and it keeps meaning the same thing when the
 * window is resized and the column count changes underneath it.
 */
function WidthGlyph({ filled, of }: { filled: number; of: number }) {
  const n = Math.max(1, of)
  const w = 16
  const h = 11
  const cell = w / n
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <rect x="0.5" y="0.5" width={w - 1} height={h - 1} rx="2" fill="none" stroke="currentColor" strokeOpacity="0.35" />
      <rect x="0" y="0" width={Math.min(w, cell * filled)} height={h} rx="2" fill="currentColor" />
    </svg>
  )
}

/**
 * Which shape a chart takes.
 *
 * Deliberately NOT inside Customise mode. Rearranging a page is something you
 * do once; asking the same figures a different way — a ring for the shares, bars
 * for the sizes — is something you do while reading, and burying it behind a
 * mode would mean three taps to compare two pictures.
 *
 * It is placed by the section rather than floated over the card, because the
 * corner of a card is already spoken for on most of them.
 */
function VariantPicker({
  def,
  value,
  onChange,
}: {
  def: SectionDef
  value?: string
  onChange: (next: string) => void
}) {
  const options = def.variants ?? []
  const current = options.find((o) => o.value === value) ?? options[0]
  return (
    <Popover
      align="right"
      width="w-44"
      trigger={({ open, toggle: press }) => (
        <button
          onClick={press}
          data-no-drag
          aria-expanded={open}
          aria-label={`${def.label} chart shape`}
          title="Chart shape"
          className={cx(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium transition-colors',
            open ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
          )}
        >
          {current?.label}
        </button>
      )}
    >
      {(close) =>
        options.map((o) => (
          <button
            key={o.value}
            onClick={() => {
              onChange(o.value)
              close()
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
          >
            <Check size={15} className={cx('shrink-0', o.value === current?.value ? 'text-accent' : 'opacity-0')} />
            {o.label}
          </button>
        ))
      }
    </Popover>
  )
}
