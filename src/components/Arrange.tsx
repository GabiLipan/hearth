import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Check, EyeOff, GripHorizontal, Plus, SlidersHorizontal } from 'lucide-react'
import { getSetting, setSetting } from '../lib/db'
import {
  MAX_HEIGHT,
  ROW_UNIT,
  currentVariant,
  effectiveHeight,
  effectiveSpan,
  moveTo,
  nextSpan,
  normaliseLayout,
  optionValue,
  optionsFor,
  placements,
  setHeight,
  setOption,
  setSpan,
  setVariant,
  toggle,
  type LayoutItem,
  type SectionDef,
  type Span,
} from '../lib/layout'
import { Popover, cx, type InfoGround } from './ui'
import { appScrollX, appScrollY, scrollAppBy } from '../lib/scroll'

/**
 * A page you can rearrange with your hands.
 *
 * ## The two handles
 *
 * A card is moved by the grabber at the top of it and resized by the corner at
 * the bottom of it, and both exist only in Customise mode.
 *
 * They are handles rather than modes because the two acts are told apart by
 * WHERE you take hold, which is a thing the hand already knows: the top middle
 * is where you pick a window up, the bottom corner is where you pull it bigger.
 *
 * **Nothing else on the card starts either gesture.** The card itself was the
 * drag handle for a while, on the reasoning that a grabber is a permanent piece
 * of furniture in service of an occasional act and that in Customise mode a
 * press on a card can mean nothing else. What that produced was a page where
 * every press moved something: there is no way to touch a card to steady it, to
 * read the figure you are about to rearrange around, or to change your mind
 * half way through — and on a phone, no way to scroll the page at all without
 * catching a card. A handle is smaller than a card on purpose. The card knows
 * how to be moved; it does not volunteer.
 *
 * ## And nothing inside a card is live while it is being arranged
 *
 * The whole subtree is `inert` in Customise mode. A chart that answers a hover
 * with a tooltip, or a tap by drilling into the rows behind it, is a card
 * behaving like a card at the moment you are treating it as a tile — you reach
 * for the corner, the tooltip opens under your finger, and a press that misses
 * the handle navigates to Activity. `inert` takes hit testing, the tab order
 * and the accessibility tree together, which is what makes this one line rather
 * than a `pointer-events-none` that still leaves the card focusable.
 *
 * ## Why a long press does not enter Customise mode
 *
 * It used to: holding a finger anywhere on a card that was not itself a control
 * turned the mode on and picked the card up, which is the platform idiom for
 * "pick this up" and reads well written down. In practice it fired by accident
 * far more often than on purpose. A page of figures is a page people rest a
 * thumb on while reading, and the cost of a false positive is not a wasted
 * gesture — it is the whole page changing mode and starting to move under them.
 *
 * The `SLOP` and control-target guards made the gesture careful rather than
 * rare, and no amount of care fixes a gesture whose idle state is "a finger on
 * the screen". Rearranging a page is a deliberate, occasional act, so it is
 * reached deliberately: the Customise button at the bottom of the page, which
 * was always there and is now the only way in.
 *
 * ## Why the geometry is frozen
 *
 * The same reason `CategoryTree` freezes it: hit-testing against a layout that
 * is reflowing under the finger tests geometry the reflow has just invalidated.
 * Boxes are measured once at pick-up in the SCROLLER's coordinates, so an auto-scroll
 * moves the page under them without invalidating anything, and the caret is
 * drawn from `moveTo`'s own answer rather than from the pointer — a drop that
 * lands somewhere other than where the finger is says so before you let go.
 *
 * `pointercancel` must not commit. It is the system taking the gesture away.
 */

/** How close to the edge of the screen starts an auto-scroll. */
const EDGE = 84

/**
 * A resize in flight: the card, and the size the pointer is currently asking
 * for. Held here rather than written straight to the layout so that a drag
 * across three widths is one stored change rather than three — and so that
 * letting go outside the grid can put the card back exactly as it was.
 *
 * `span` and `rows` are the EFFECTIVE numbers, so the preview is what the
 * screen will actually show; the stored value is worked back out on commit.
 */
interface Resize {
  id: string
  span: number
  rows: number
}

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

  /**
   * What the catalogue OFFERS, as something that can be compared.
   *
   * The catalogue itself is rebuilt on every render by the page that owns it,
   * so its identity says nothing and using it as a dependency would re-read the
   * stored layout forever. Its list of ids is the part that matters and is
   * stable across renders that changed nothing.
   */
  const offered = catalogue.map((d) => d.id).join(',')

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
    // `offered` and not `catalogue`: see above. It is in the deps rather than
    // just `key` because a section can now come and go while the page is
    // mounted — a preference read from `db.meta` resolves a frame after the
    // first paint, and a layout normalised against the catalogue as it was
    // then has no entry for a section that has only just been offered. Without
    // this, turning one on in Settings did nothing until the next reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, offered])

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
 * reasons that both bite. The grid packs densely, so DOCUMENT order is not
 * reading order — a narrow card later in the list is pulled back into a hole an
 * earlier wide one could not fill, and lands on the screen above the card it
 * follows in the array. And a section whose data has nothing to show renders
 * empty and is hidden, so it has a box of zero size that must not be allowed to
 * win "nearest centre" from the far corner of the page.
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
   * One section. `controls` is its picker, or null where the section offers no
   * choice — sections place it in their own heading, because only they know
   * where their heading is. `options` is every non-shape choice, resolved.
   */
  render: (args: {
    item: LayoutItem
    def: SectionDef
    variant?: string
    options: Record<string, string>
    controls: ReactNode
  }) => ReactNode
  gap?: string
}) {
  const defs = useMemo(() => new Map(catalogue.map((d) => [d.id, d])), [catalogue])
  const visible = useMemo(() => layout.filter((i) => i.on && defs.has(i.id)), [layout, defs])
  const hidden = useMemo(() => layout.filter((i) => !i.on && defs.has(i.id)), [layout, defs])

  const wrap = useRef<HTMLDivElement>(null)
  /** Every visible section's box, in the scroller's coordinates, frozen at pick-up. */
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

  const [drag, setDrag] = useState<{ id: string; from: number; dx: number; dy: number } | null>(null)
  const [gapAt, setGapAt] = useState<number | null>(null)
  const [resize, setResize] = useState<Resize | null>(null)
  /**
   * Where the resize began and how big the card was then.
   *
   * The gesture is RELATIVE — the size the pointer asks for is the size it
   * started at plus however many steps it has travelled — rather than measured
   * from the card's own top-left corner. That is not a refinement: a row track
   * grows to fit a card taller than the height it asked for, so a card asking
   * for one unit is routinely two units tall, and an absolute reading would
   * jump it to three the instant the handle was touched, before the pointer had
   * moved at all.
   */
  const grab = useRef({ x: 0, y: 0, span: 1, rows: 1, col: 1, row: 1 })
  /**
   * The size the corner is currently asking for, as a ref as well as state.
   *
   * The gesture runs on `window` listeners — see `grabCorner` — which are
   * created once, at pointer-down, and would otherwise read the layout and the
   * preview as they were in that one render for the whole drag.
   */
  const sizing = useRef<Resize | null>(null)
  const live = useRef({ layout, columns, visible })
  useEffect(() => {
    live.current = { layout, columns, visible }
  })
  /**
   * Whether the corner was DRAGGED rather than pressed.
   *
   * A pointer down and up on the same element is also a click, so without this
   * every resize ends by cycling the width one step past wherever it was let
   * go — the press meaning of the handle firing on top of its drag meaning.
   */
  const dragged = useRef(false)

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
    const x = pointer.current.x + appScrollX()
    const y = pointer.current.y + appScrollY()

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
      anchor.current = { x: rect.left + appScrollX(), y: rect.top + appScrollY() }
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
          left: r.left + appScrollX(),
          top: r.top + appScrollY(),
          right: r.right + appScrollX(),
          bottom: r.bottom + appScrollY(),
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
    if (!dragging.current) return false
    dragging.current = false
    setDrag(null)
    setGapAt(null)
    boxes.current = []
    return true
  }, [])

  function down(e: React.PointerEvent, id: string) {
    // Nothing at all outside Customise mode: a press on a card there is
    // somebody reading the page. See the note at the top of this file for why
    // the long press that used to live here is gone.
    if (!editing) return
    // Only the primary button, and never a press that started on a control.
    if (e.button !== 0) return
    // The grabber and nothing else. Everything else on the card — including
    // the card itself — is something to look at while arranging, not something
    // that moves when touched. See the note at the top of this file.
    if (!(e.target as Element | null)?.closest('[data-drag-handle]')) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* carry on uncaptured — the listeners are on the card either way */
    }
    begin(id, e.clientX, e.clientY)
  }

  function track(e: React.PointerEvent) {
    pointer.current = { x: e.clientX, y: e.clientY }
    if (!dragging.current) return
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

  /* ---------- the corner ---------- */

  /**
   * One step of the grid, in pixels: a column plus the gutter after it, and a
   * row unit plus the gutter under it.
   *
   * Read off the live grid rather than stated as a constant, because the gap is
   * a Tailwind class the caller passes in and the column width is whatever the
   * page is wide. `columnGap`/`rowGap` resolve to pixels in a computed style
   * even when they were written in rem.
   */
  function stepOf(el: HTMLElement) {
    const cs = getComputedStyle(el)
    const colGap = parseFloat(cs.columnGap) || 0
    const rowGap = parseFloat(cs.rowGap) || 0
    const cols = Math.max(1, columns)
    return {
      x: (el.getBoundingClientRect().width + colGap) / cols,
      y: ROW_UNIT + rowGap,
    }
  }

  /**
   * Take hold of the corner.
   *
   * The listeners go on `window` rather than on the handle, which is what makes
   * this a DRAG rather than a press. Pointer capture on the handle is not
   * enough on its own: the card re-renders on every step of the resize, and
   * anything that unmounts or replaces the handle mid-gesture — as an earlier
   * version of this did, by rendering the handles only while nothing was being
   * resized — takes the capture with it. The pointer then travels over a
   * control that is no longer there, no further event arrives, and the whole
   * thing behaves like a button that changed the size once.
   */
  function grabCorner(e: React.PointerEvent, item: LayoutItem) {
    if (!editing || e.button !== 0) return
    const el = wrap.current
    if (!el) return
    e.preventDefault()
    e.stopPropagation()

    const step = stepOf(el)
    grab.current = {
      x: e.clientX,
      y: e.clientY,
      span: effectiveSpan(item.span, columns),
      rows: effectiveHeight(item.rows, columns),
      col: step.x,
      row: step.y,
    }
    dragged.current = false
    sizing.current = { id: item.id, span: grab.current.span, rows: grab.current.rows }
    setResize(sizing.current)

    const move = (ev: PointerEvent) => {
      ev.preventDefault()
      dragCorner(ev.clientX, ev.clientY)
    }
    const done = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      if (commit) dropCorner()
      else {
        sizing.current = null
        setResize(null)
      }
    }
    const up = () => done(true)
    // The system taking the gesture away is not a drop, here as everywhere
    // else in this file.
    const cancel = () => done(false)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  function dragCorner(x: number, y: number) {
    const at = sizing.current
    if (!at) return
    const g = grab.current
    const cols = Math.max(1, live.current.columns)
    const clamp = (v: number, hi: number) => Math.max(1, Math.min(hi, v))
    const span = clamp(g.span + Math.round((x - g.x) / g.col), cols)
    // A phone has one width and one height, so there is nothing to drag
    // vertically for — see `effectiveHeight`. The handle is not rendered there
    // at all; this is the guard for a rotation mid-gesture.
    const rows = cols <= 1 ? 1 : clamp(g.rows + Math.round((y - g.y) / g.row), MAX_HEIGHT)
    if (Math.abs(x - g.x) > 4 || Math.abs(y - g.y) > 4) dragged.current = true
    if (at.span === span && at.rows === rows) return
    sizing.current = { ...at, span, rows }
    setResize(sizing.current)
  }

  /**
   * Let go: write the size once.
   *
   * A width equal to the column count is stored as `'full'` rather than as that
   * number, which is the whole difference between "as wide as the page" and "as
   * wide as the page happens to be today" — dragging a card to the right-hand
   * edge of a three-column screen means the first, and storing `3` would make
   * it two thirds of a four-column one.
   */
  function dropCorner() {
    const at = sizing.current
    sizing.current = null
    setResize(null)
    if (!at) return
    const { layout: now, columns: cols, visible: on } = live.current
    const item = on.find((i) => i.id === at.id)
    if (!item) return
    let next = now
    const span: Span = at.span >= Math.max(1, cols) ? 'full' : at.span
    if (effectiveSpan(item.span, cols) !== at.span || (span === 'full') !== (item.span === 'full')) {
      next = setSpan(next, item.id, span)
    }
    if (effectiveHeight(item.rows, cols) !== at.rows) next = setHeight(next, item.id, at.rows)
    if (next !== now) onLayout(next)
  }

  // Escape abandons a drag, as everywhere else in the app.
  useEffect(() => {
    if (!drag && !resize) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      stop()
      setResize(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drag, resize, stop])

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
        scrollAppBy(0, by)
        reread()
      }
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [drag, reread])

  /**
   * The whole of both gestures, from the keyboard.
   *
   * A corner that has to be dragged is unreachable without a pointer, so the
   * shift key is the second axis: the arrows alone move a card, and with shift
   * held they resize it — sideways for the width, up and down for the height,
   * which is the same picture the corner draws with a hand.
   */
  function keys(e: React.KeyboardEvent, id: string) {
    const at = visible.findIndex((i) => i.id === id)
    if (at < 0) return
    const item = visible[at]
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp'
    const on = e.key === 'ArrowRight' || e.key === 'ArrowDown'
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown'

    if (e.shiftKey && (back || on)) {
      e.preventDefault()
      const step = on ? 1 : -1
      if (vertical) {
        const rows = effectiveHeight(item.rows, columns) + step
        if (rows >= 1 && rows <= MAX_HEIGHT) onLayout(setHeight(layout, id, rows))
        return
      }
      const span = effectiveSpan(item.span, columns) + step
      if (span < 1 || span > Math.max(1, columns)) return
      onLayout(setSpan(layout, id, span >= Math.max(1, columns) ? 'full' : span))
      return
    }

    if (back || on) {
      e.preventDefault()
      const next = moveTo(layout, id, back ? at - 1 : at + 2)
      if (next !== layout) onLayout(next)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onLayout(setSpan(layout, id, nextSpan(item.span, columns)))
    }
  }

  const section = ({ item, span, rows }: { item: LayoutItem; span: number; rows: number }) => {
    const def = defs.get(item.id)
    if (!def) return null
    const lifted = drag?.id === item.id
    const resizing = resize?.id === item.id ? resize : null
    const cols = resizing?.span ?? span
    const high = resizing?.rows ?? rows
    return (
      <div
        key={item.id}
        data-section={item.id}
        // `touch-action: none` only while arranging: a vertical drag on a card
        // must not scroll the page then, and must do nothing else the rest of
        // the time. Outside Customise mode nothing here claims the gesture at
        // all, so the browser keeps the scroll.
        // A widget with nothing to say renders nothing — no accounts, no bills
        // due — and its wrapper must disappear with it rather than leaving a
        // gap, or in Customise mode a dashed outline around a void. `:empty`
        // on the wrapper itself cannot see that, because the wrapper always has
        // the inner box (and, while arranging, the controls) inside it; `:has`
        // asks about the inner box instead.
        // Every card is as tall as the box the grid gave it, and that is a
        // deliberate reversal of the rule the masonry layout followed.
        // There, a card that could not spend the height kept its own and left
        // the slack at the FOOT of its column, where nothing was ever drawn and
        // nobody could see it; only a card holding a `Fill` was stretched,
        // because stretching the others moved the hole inside them.
        // In a grid the slack has nowhere to go. A row is as tall as the
        // tallest card in it, so a card left at its own height leaves a gap
        // between itself and the card below — a hole in the middle of the page
        // rather than at the bottom of a column. Of the two, whitespace inside
        // a card reads as a card; whitespace between them reads as a fault, and
        // it is the exact fault this grid was asked for to remove. `Fill` still
        // does the work wherever there is something in the card that can grow.
        className={cx(
          'relative h-full min-w-0 [&:has(>div:empty)]:hidden',
          editing && 'touch-none select-none',
        )}
        style={{
          gridColumn: `span ${cols} / span ${cols}`,
          gridRow: `span ${high} / span ${high}`,
          ...(lifted ? { transform: `translate(${drag.dx}px, ${drag.dy}px)`, zIndex: 30 } : null),
          ...(resizing ? { zIndex: 20 } : null),
        }}
        tabIndex={editing ? 0 : undefined}
        aria-label={
          editing
            ? `${def.label}, ${cols} of ${Math.max(1, columns)} columns wide${
                columns > 1 ? `, ${high} of ${MAX_HEIGHT} tall` : ''
              }. Arrow keys to move it, shift and the arrow keys to resize it.`
            : undefined
        }
        onPointerDown={(e) => down(e, item.id)}
        onPointerMove={track}
        onPointerUp={finish}
        onPointerCancel={stop}
        onKeyDown={editing ? (e) => keys(e, item.id) : undefined}
      >
        <div
          className={cx(
            'transition-[box-shadow,transform,opacity]',
            // The card itself, whatever the section rendered, becomes a column
            // as tall as the box it was given. Stated here rather than on
            // twenty-odd cards, which is also what stops half of them drifting
            // out of it: a card that is not a flex column has nothing for
            // `Fill` to grow inside.
            'h-full [&>*]:flex [&>*]:h-full [&>*]:flex-col',
            editing && 'rounded-2xl ring-2 ring-dashed ring-accent/40 md:rounded-xl',
            lifted && 'scale-[1.02] opacity-95 shadow-2xl ring-accent',
            resizing && 'ring-accent',
          )}
          // Nothing inside a card is live while the page is being arranged: a
          // chart that answers a hover with a tooltip, or a tap by drilling
          // into the rows behind it, is a card behaving like a card at the
          // moment you are treating it as a tile. `inert` is hit testing, the
          // tab order and the accessibility tree in one word — a
          // `pointer-events-none` would leave it focusable and readable to a
          // screen reader as though it were still a chart.
          inert={editing}
        >
          {render({
            item,
            def,
            variant: currentVariant(def, item),
            options: optionsFor(def, item),
            controls: def.variants?.length || def.options?.length ? (
              <VariantPicker
                on={def.ground}
                def={def}
                item={item}
                onVariant={(v) => onLayout(setVariant(layout, item.id, v))}
                onOption={(optionId, value) => onLayout(setOption(layout, item.id, optionId, value))}
              />
            ) : null,
          })}
        </div>

        {editing && !lifted && (
          <>
            {/* The grabber, in the top middle: the one shape in this app that
                already means "take hold of this", borrowed from the underside
                of a sheet. Centred rather than in a corner because both corners
                of a card are spoken for — a heading and a picker on one side, a
                figure or a link on the other — and because the middle of the
                top edge is where a window is picked up everywhere else.
                It is the ONLY way to move a card, so it is a target rather than
                a hint: 40px of it, standing slightly proud of the card's top
                edge where nothing else on the card ever sits. */}
            <button
              type="button"
              data-drag-handle
              aria-hidden
              tabIndex={-1}
              title={`Drag to move ${def.label}`}
              className={cx(
                'absolute left-1/2 top-0 z-20 flex h-6 w-10 -translate-x-1/2 -translate-y-1/2',
                'cursor-grab items-center justify-center rounded-full active:cursor-grabbing',
                'bg-surface text-ink-3 shadow-md ring-1 ring-hairline',
              )}
            >
              <GripHorizontal size={15} />
            </button>

            <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-full bg-surface p-1 shadow-md ring-1 ring-hairline">
              <button
                type="button"
                onClick={() => onLayout(toggle(layout, item.id))}
                aria-label={`Hide ${def.label}`}
                title="Hide"
                className="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink"
              >
                <EyeOff size={14} />
              </button>
            </div>

            {/* The corner, on a screen with more than one column. A phone has
                one width and one height — see `effectiveHeight` — so a handle
                there could only write a size that shows up on somebody else's
                laptop, which is a control that appears to do nothing and does
                something out of sight. A press cycles the width, which is what
                the button beside the eye used to do, so the one-tap way to two
                columns survives the handle replacing it. */}
            {columns > 1 && (
              <button
                type="button"
                data-no-drag
                // Down only: the rest of the gesture is on `window`, so nothing
                // that happens to this element while the card reflows under the
                // pointer can interrupt it.
                onPointerDown={(e) => grabCorner(e, item)}
                onClick={() => {
                  // A press and a drag are the same pointer sequence, and a
                  // drag ends with a click on the element it started on — so
                  // without this every resize would finish one width past
                  // wherever it was let go.
                  if (dragged.current) {
                    dragged.current = false
                    return
                  }
                  onLayout(setSpan(layout, item.id, nextSpan(item.span, columns)))
                }}
                aria-label={`Resize ${def.label}`}
                title="Drag to resize"
                className={cx(
                  'absolute -bottom-1 -right-1 z-20 grid size-7 cursor-nwse-resize place-items-center',
                  'rounded-full bg-surface text-ink-3 shadow-md ring-1 ring-hairline',
                  resizing ? 'text-accent ring-accent' : 'hover:text-ink',
                )}
              >
                <CornerGlyph />
              </button>
            )}
          </>
        )}

        {/* What the corner is currently asking for, said in numbers over the
            card it is resizing. A grid step is a big change made in small
            movements, and without this the only feedback is the page reflowing
            around a card whose own edges are under your hand. */}
        {resizing && (
          <span className="pointer-events-none absolute bottom-2 right-2 z-30 rounded-full bg-accent px-2 py-1 text-xs font-semibold text-accent-ink tabular">
            {cols} × {high}
          </span>
        )}
      </div>
    )
  }

  return (
    <div>
      {/*
        One grid, not a page of bands.
        `grid-auto-flow: dense` is what makes a page of mixed sizes worth
        having: a two-column card that will not fit the tail of a row lets the
        next one-column card fill it rather than leaving a hole and starting
        again underneath — which is the cap the masonry-plus-rows arrangement
        could never get rid of, because a wide card cut the page in two and each
        half packed itself in ignorance of the other.
        What it costs is that visual order and DOM order can differ: a later
        card can be pulled back into an earlier gap. Everything in the drag
        reads live geometry rather than the array (`begin` measures every
        `[data-section]` box and carries the index with it), so the caret still
        lands where the eye is — see `Box`.
        `grid-auto-rows` is a MINIMUM, so a card taller than the height it asked
        for grows its row instead of being cut off, and a page of ordinary cards
        that never ask for a second unit behaves exactly as it used to.
      */}
      <div
        ref={wrap}
        className={cx('relative grid', gap)}
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`,
          gridAutoRows: `minmax(${ROW_UNIT}px, auto)`,
          gridAutoFlow: 'row dense',
        }}
      >
        {placements(visible, columns).map(section)}

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
                type="button"
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
          Take a card by the grip at the top to move it, or its bottom corner to make it wider and taller.
          With a card focused, the arrow keys move it and shift with the arrow keys resizes it.
        </p>
      )}

      <div className="mt-5 flex justify-center">
        <button
          type="button"
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
 * The corner, drawn as the corner of a card being pulled.
 *
 * Two strokes rather than the three of a native resize gripper: the handle is
 * 24px in the corner of a card that is mostly figures, and a third line at this
 * size reads as texture rather than as a hint.
 */
function CornerGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M10 4 L4 10" />
      <path d="M10 8 L8 10" />
    </svg>
  )
}

/**
 * What this section looks like: its shape, and everything else it lets you
 * decide.
 *
 * Deliberately NOT inside Customise mode. Rearranging a page is something you
 * do once; asking the same figures a different way — a ring for the shares, bars
 * for the sizes, five categories or twenty — is something you do while reading,
 * and burying it behind a mode would mean three taps to compare two pictures.
 *
 * It is placed by the section rather than floated over the card, because the
 * corner of a card is already spoken for on most of them.
 *
 * One control rather than one per choice. A card's heading has room for a word,
 * not for a row of chips, and the choices are read together anyway — "bars, top
 * ten" is one sentence about one picture. The trigger says the shape where
 * there is one and the section's own label where there is not, so a section
 * whose only choice is "how many" does not grow a control labelled with a
 * number.
 *
 * The lists stay OPEN as they are used: changing how many categories a chart
 * shows is a thing you do two or three times, watching the picture behind the
 * panel each time, and closing on every tap would make that three round trips.
 * Picking a shape closes, because that is a decision rather than an adjustment.
 */
function VariantPicker({
  def,
  item,
  onVariant,
  onOption,
  on = 'surface',
}: {
  def: SectionDef
  item: LayoutItem
  onVariant: (next: string) => void
  onOption: (optionId: string, next: string) => void
  /** The ground the trigger sits on. See `SectionDef.ground`. */
  on?: InfoGround
}) {
  const shapes = def.variants ?? []
  const shape = shapes.find((o) => o.value === currentVariant(def, item)) ?? shapes[0]
  const groups = def.options ?? []

  const row = (label: string, chosen: boolean, onClick: () => void) => (
    <button
      type="button"
      key={label}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2"
    >
      <Check size={15} className={cx('shrink-0', chosen ? 'text-accent' : 'opacity-0')} />
      {label}
    </button>
  )

  return (
    <Popover
      align="right"
      width="w-48"
      trigger={({ open, toggle: press }) => (
        <button
          type="button"
          onClick={press}
          data-no-drag
          aria-expanded={open}
          aria-label={`How ${def.label} is shown`}
          title="How this is shown"
          className={cx(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium transition-colors',
            on === 'panel'
              ? 'hover:bg-white/10'
              : open
                ? 'bg-surface-2 text-ink'
                : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
          )}
          // The panel defines its own ink, and the trigger sits on the heading
          // line beside the ⓘ — so it takes exactly what the ⓘ takes there,
          // rather than the surface's grey. Stated as a style for the reason
          // `InfoToggle` gives: there is no Tailwind colour for a per-theme
          // token.
          style={on === 'panel' ? { color: open ? 'var(--panel-ink)' : 'var(--panel-ink-2)' } : undefined}
        >
          {shape?.label ?? <SlidersHorizontal size={13} />}
        </button>
      )}
    >
      {(close) => (
        <>
          {shapes.map((o) =>
            row(o.label, o.value === shape?.value, () => {
              onVariant(o.value)
              close()
            }),
          )}
          {groups.map((opt) => (
            <div key={opt.id} className={cx((shapes.length > 0 || groups[0] !== opt) && 'mt-1 border-t border-hairline pt-1')}>
              <p className="px-2.5 pb-0.5 pt-1 text-xs font-semibold uppercase tracking-wide text-ink-3">{opt.label}</p>
              {opt.choices.map((c) => row(c.label, c.value === optionValue(def, item, opt.id), () => onOption(opt.id, c.value)))}
            </div>
          ))}
        </>
      )}
    </Popover>
  )
}
