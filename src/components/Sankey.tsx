import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Receipt } from 'lucide-react'
import { useChartColors } from '../hooks/useChartColors'
import { useTouchTooltip, TIP_FADE_MS } from '../hooks/useTouchTooltip'
import { useApp } from '../state/AppContext'
import { layoutFlow, type FlowGraph, type FlowNode } from '../lib/sankey'
import { cx } from './ui'

/**
 * The month drawn as one path from where the money came in to what it became.
 *
 * Hand-rolled rather than Recharts' own Sankey, for the same reason the donut
 * drives its own sweep: what is wanted here is a specific picture — three
 * columns, ribbons whose width IS the money, palette colours that match the
 * categories everywhere else in the app — and a general-purpose component gets
 * you most of that and then argues about the rest.
 *
 * The arithmetic all lives in `lib/sankey.ts` and is tested there. This file
 * turns boxes into rectangles and ribbons into paths, and decides what to do
 * when there is not room for a label.
 */

/** Room for the names either side of the diagram. */
const LABEL = 116
/** Below this the bands are too thin to read whatever we do, so it scrolls instead. */
const MIN_WIDTH = 560
const NODE_W = 12
/**
 * The gap between two bands in a column.
 *
 * Passed to the layout rather than left to its default, because the hit areas
 * below divide it: each band owns the space out to the halfway line between it
 * and its neighbour, and it can only do that if this file and the arithmetic
 * agree on how much space there is.
 */
const BAND_GAP = 6

/** A name that will not fit is shortened rather than allowed to overlap its neighbour. */
function short(name: string, max = 18) {
  return name.length <= max ? name : `${name.slice(0, max - 1).trimEnd()}…`
}

/**
 * A ribbon: two cubic curves and two straight ends.
 *
 * The control points sit half way across, which is what gives the flat middle
 * and the steep ends — a ribbon that eases out of one bar and into the other
 * rather than pointing at it.
 */
function ribbonPath(x0: number, y0: number, x1: number, y1: number, t: number) {
  const mid = (x0 + x1) / 2
  return [
    `M${x0},${y0}`,
    `C${mid},${y0} ${mid},${y1} ${x1},${y1}`,
    `L${x1},${y1 + t}`,
    `C${mid},${y1 + t} ${mid},${y0 + t} ${x0},${y0 + t}`,
    'Z',
  ].join(' ')
}

export function Sankey({
  graph,
  caption,
  onPick,
  canPick = (n) => n.side !== 'hub',
}: {
  graph: FlowGraph
  caption?: string
  /**
   * Out of a band and into the rows behind it. The node is handed over whole
   * because only the caller knows what its id means — `cat:…` is a category,
   * `in:theirs` is somebody's contribution, and the diagram itself has no
   * opinion about which of those has transactions to show.
   */
  onPick?: (node: FlowNode) => void
  /** Which bands lead anywhere. Everything but the hub, unless told otherwise. */
  canPick?: (node: FlowNode) => boolean
}) {
  const c = useChartColors()
  const { money } = useApp()
  const box = useRef<HTMLDivElement>(null)
  /** The card, which is what the panel is kept inside — not the scrolling box. */
  const frame = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(MIN_WIDTH)
  const [hovered, setHovered] = useState<{ id: string; x: number; y: number } | null>(null)
  /**
   * How tall the panel is, which is not knowable until it exists.
   *
   * It sits ABOVE the pointer, so its height decides whether it fits — and a
   * name long enough to wrap onto three lines is exactly the case this panel
   * was made taller to serve, so the two arrived together: the first long name
   * pushed the panel off the top of the card. Measured rather than assumed, and
   * re-measured from a `ResizeObserver` because the panel does not exist on the
   * pointer move that first opens it, and the pointer may never move again.
   */
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    if (!panel) return
    const measure = () => setSize({ w: panel.offsetWidth, h: panel.offsetHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(panel)
    return () => ro.disconnect()
  }, [panel])

  /**
   * Where the pointer is, in the card's coordinates.
   *
   * Taken from the pointer event and the frame's own rect rather than from
   * `offsetX`, which is measured inside the SVG — and the SVG scrolls
   * sideways, so on a narrow screen a band hovered after scrolling would have
   * put its panel a scrollbar's worth of travel away from the band it names.
   */
  const at = (e: { clientX: number; clientY: number }) => {
    const r = frame.current?.getBoundingClientRect()
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 }
  }

  /**
   * A tap has no ending of its own, so one is given to it: the panel stays
   * while the finger is down and fades a few seconds after it lifts. The same
   * gesture everywhere else in the app — see `useTouchTooltip`.
   */
  const touch = useTouchTooltip(() => setHovered(null))

  /**
   * What names a band: the band itself, the ribbon leaving it, and the strip
   * its label sits in.
   *
   * `pointerdown` as well as `pointermove`, because a tap that does not travel
   * emits no move at all on some browsers — and a tap is the whole gesture on
   * the device where a name is most likely to have been shortened.
   */
  /** Whether a click on a band goes anywhere — see the note inside. */
  const byClick = Boolean(onPick) && !touch.coarse

  const names = (id: string) => ({
    onPointerDown: (e: ReactPointerEvent) => setHovered({ id, ...at(e) }),
    onPointerMove: (e: ReactPointerEvent) => setHovered({ id, ...at(e) }),
    // On a mouse the click is spare, so the band itself is the way through. On
    // a finger it is not: the tap is what opens the panel, so the way through
    // is the button inside it. Same reasoning as the charts — see `MonthPick`.
    //
    // No `className` here: every element this is spread onto already has one,
    // and a spread AFTER a `className` attribute silently replaces it — which
    // would take the fade off the ribbons to add a cursor.
    onClick: byClick
      ? () => {
          const node = boxOf.get(id)?.node
          if (node && canPick(node)) onPick?.(node)
        }
      : undefined,
  })

  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setAvailable(el.clientWidth || MIN_WIDTH)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const width = Math.max(MIN_WIDTH, available)
  const counts = useMemo(
    () => ({
      ins: graph.nodes.filter((n) => n.side === 'in').length,
      outs: graph.nodes.filter((n) => n.side === 'out').length,
    }),
    [graph],
  )
  // Tall enough that every band has room for its own label. A diagram that
  // fits the screen and cannot be read is not the smaller of two evils.
  const height = Math.max(280, Math.max(counts.ins, counts.outs) * 42)

  const layout = useMemo(
    () => layoutFlow(graph, { width: width - LABEL * 2, height, nodeWidth: NODE_W, padding: BAND_GAP }),
    [graph, width, height],
  )

  const colourOf = (n: FlowNode) =>
    n.side === 'hub' ? c.ink2 : n.muted || n.slot === undefined || n.slot === 0 ? c.ink3 : c.slot(n.slot)

  const boxOf = useMemo(() => new Map(layout.boxes.map((b) => [b.node.id, b])), [layout])
  const hoveredNode = hovered ? boxOf.get(hovered.id)?.node : undefined
  /** Everything dims except the band under the pointer and the ribbon it owns. */
  const lit = (id: string) => !hovered || hovered.id === id

  /** Is there room to hang the panel above the pointer? Below it if not. */
  const above = !hovered || hovered.y - 10 - size.h >= 0
  /**
   * Centred on the pointer, and never over either edge of the card.
   *
   * From the panel's own measured width rather than a guess at it: a name long
   * enough to need this panel is also what makes the panel wide, so a fixed
   * half-width was wrong in exactly the case it was there for.
   */
  const half = size.w / 2
  const cardW = frame.current?.clientWidth ?? width
  const left = hovered ? Math.min(Math.max(hovered.x, half), Math.max(half, cardW - half)) : 0

  if (layout.boxes.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-3">Nothing moved in this period.</p>
  }

  return (
    <div ref={frame} className="relative">
      <div ref={box} className="overflow-x-auto overscroll-x-contain">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={caption ?? 'Where the money came from and what it became'}
          {...touch.handlers}
          // A mouse that leaves takes the panel with it, as it always did. A
          // finger emits this too, the moment it lifts — and obeying it there
          // would close the panel at exactly the instant the linger exists to
          // keep it open.
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setHovered(null)
          }}
        >
          <g transform={`translate(${LABEL},0)`}>
            {layout.ribbons.map((r) => {
              const node = boxOf.get(r.colourFrom)?.node
              const on = lit(r.colourFrom)
              return (
                <path
                  key={`${r.link.from}->${r.link.to}`}
                  d={ribbonPath(r.x0, r.y0, r.x1, r.y1, r.thickness)}
                  fill={node ? colourOf(node) : c.ink3}
                  fillOpacity={on ? (hovered ? 0.62 : 0.34) : 0.1}
                  className={cx('transition-[fill-opacity] duration-150', byClick && 'cursor-pointer')}
                  {...names(r.colourFrom)}
                />
              )
            })}

            {layout.boxes.map((b) => (
              <rect
                key={b.node.id}
                x={b.x}
                y={b.y}
                width={b.width}
                height={b.height}
                rx={3}
                fill={colourOf(b.node)}
                fillOpacity={lit(b.node.id) ? 1 : 0.25}
                className={cx('transition-[fill-opacity] duration-150', byClick && 'cursor-pointer')}
                {...names(b.node.id)}
              />
            ))}

            {/* Labels last, so nothing is drawn over them. A band with no room
                for one keeps its colour and its hover; the alternative is two
                names on top of each other, which is worse than one missing. */}
            {layout.boxes.map((b) => {
              if (b.node.side === 'hub' || b.height < 13) return null
              const left = b.node.side === 'in'
              const x = left ? b.x - 8 : b.x + NODE_W + 8
              const y = b.y + b.height / 2
              return (
                <text
                  key={`t-${b.node.id}`}
                  x={x}
                  y={y}
                  textAnchor={left ? 'end' : 'start'}
                  className="pointer-events-none"
                  fill={c.ink2}
                  fontSize={11}
                >
                  <tspan x={x} dy={b.height < 30 ? 4 : -2}>
                    {short(b.node.name)}
                  </tspan>
                  {/* The amount only where the band is tall enough to take two
                      lines without the second one landing on its neighbour. */}
                  {b.height >= 30 && (
                    <tspan x={x} dy={13} fill={c.ink3}>
                      {money(b.node.valueMinor, { compact: true, hideDecimals: true })}
                    </tspan>
                  )}
                </text>
              )
            })}

            {/* The name, as something you can point at.

                A label is drawn `pointer-events-none` so it cannot steal the
                hover from the band it belongs to — which left the one thing on
                the diagram you would reach for when you cannot read it as the
                one thing that answered nothing. A shortened name is exactly the
                case: `short()` cuts at eighteen characters, so "Groceries &
                household" is a band whose label does not say what it is and
                whose own 4px of colour is hard to hit with a finger.

                So each band claims its whole row — the label strip and the node
                — as a transparent target, out to the halfway line between it
                and its neighbour, which is what makes a 3px band tappable
                without taking the tap that belonged to the band above. Drawn
                last so it is over the labels; transparent, so it changes
                nothing about how the diagram looks. */}
            {layout.boxes.map((b) => {
              if (b.node.side === 'hub') return null
              const left = b.node.side === 'in'
              return (
                <rect
                  key={`h-${b.node.id}`}
                  x={left ? b.x - LABEL : b.x}
                  y={b.y - BAND_GAP / 2}
                  width={LABEL + NODE_W}
                  height={b.height + BAND_GAP}
                  fill="transparent"
                  className={cx(byClick && 'cursor-pointer')}
                  {...names(b.node.id)}
                />
              )
            })}
          </g>
        </svg>
      </div>

      {hovered && hoveredNode && (
        <div
          ref={setPanel}
          // Follows the pointer, clamped to the card so a band near the right
          // edge does not open a panel off it.
          // Above the diagram and outside the scrolling box, so nothing clips
          // it and nothing is drawn over it. Clamped to the card rather than to
          // the SVG: the SVG is wider than the card whenever this scrolls.
          className={cx(
            // `w-max` with a cap, rather than letting the box shrink to fit:
            // shrink-to-fit resolves against the widest LINE it can find, so a
            // long name wrapped itself into a four-word column while most of
            // the room the panel was allowed sat empty beside it.
            'pointer-events-none absolute z-30 w-max max-w-[min(20rem,92%)] -translate-x-1/2 rounded-xl bg-surface px-3 py-2 text-sm shadow-lg ring-1 ring-hairline',
            // Above the pointer where there is room for it, and below where
            // there is not — the top bands of the diagram have nothing above
            // them, and a panel pinned to the card's top edge instead would
            // cover the very labels it was opened to explain.
            above && '-translate-y-full',
          )}
          style={{
            left,
            top: above ? hovered.y - 10 : hovered.y + 18,
            opacity: touch.fading ? 0 : 1,
            transition: `opacity ${TIP_FADE_MS}ms linear`,
          }}
        >
          <div className="flex items-start gap-2">
            <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: colourOf(hoveredNode) }} />
            {/* The whole name, wrapped rather than shortened — this panel is
                the only place the diagram admits to what it cut off. */}
            <span className="min-w-0 break-words text-ink-3">{hoveredNode.name}</span>
            <span className="ml-auto shrink-0 pl-3 font-semibold text-ink tabular">
              {money(hoveredNode.valueMinor)}
            </span>
          </div>
          {graph.totalMinor > 0 && hoveredNode.side !== 'hub' && (
            <p className="mt-0.5 text-xs text-ink-3">
              {Math.round((hoveredNode.valueMinor / graph.totalMinor) * 100)}% of everything that moved
            </p>
          )}
          {/* What the band is made of, where it is made of two things.
              "You put in" is one claim and belongs in one ribbon, but it is
              reached two ways — money moved into the joint account, and things
              bought for the household straight off a personal card — and the
              second is the one somebody will not have expected to be in there.
              The parts sum to the figure above them; `spendFlow` guarantees it. */}
          {hoveredNode.parts && (
            <ul className="mt-1.5 space-y-0.5 border-t border-hairline pt-1.5 text-xs">
              {hoveredNode.parts.map((p) => (
                <li key={p.label} className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 break-words text-ink-3">{p.label}</span>
                  {/* The count stacks UNDER the amount rather than running on
                      after the label. Inline, "Paid from a personal account · 4
                      payments" wrapped and stranded the "payments" on a line of
                      its own, which reads as a layout fault; here both columns
                      take two lines and the figures stay in a column. */}
                  <span className="shrink-0 text-right">
                    <span className="block text-ink-2 tabular">{money(p.valueMinor)}</span>
                    {p.count ? (
                      <span className="block text-[0.6875rem] leading-tight text-ink-3">
                        {p.count} {p.count === 1 ? 'payment' : 'payments'}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* The way through on a finger, where the tap that opened this panel
              could not also have been a click. The panel is otherwise inert, so
              this button re-enables pointers for itself alone. */}
          {onPick && touch.coarse && canPick(hoveredNode) && (
            <button
              type="button"
              onClick={() => onPick(hoveredNode)}
              className="pointer-events-auto mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg bg-surface-2 px-2 py-1.5 text-xs font-medium text-ink-2 transition hover:text-ink"
            >
              <Receipt size={12} /> See transactions
            </button>
          )}
        </div>
      )}

      <p className={cx('mt-2 text-xs text-ink-3', !caption && 'sr-only')}>
        {caption ?? 'Left: where the money came from. Right: what it became. Each ribbon is as wide as the amount it carries.'}
      </p>
    </div>
  )
}
