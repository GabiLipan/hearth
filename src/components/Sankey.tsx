import { useEffect, useMemo, useRef, useState } from 'react'
import { useChartColors } from '../hooks/useChartColors'
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

export function Sankey({ graph, caption }: { graph: FlowGraph; caption?: string }) {
  const c = useChartColors()
  const { money } = useApp()
  const box = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(MIN_WIDTH)
  const [hovered, setHovered] = useState<{ id: string; x: number; y: number } | null>(null)

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
    () => layoutFlow(graph, { width: width - LABEL * 2, height, nodeWidth: NODE_W }),
    [graph, width, height],
  )

  const colourOf = (n: FlowNode) =>
    n.side === 'hub' ? c.ink2 : n.muted || n.slot === undefined || n.slot === 0 ? c.ink3 : c.slot(n.slot)

  const boxOf = useMemo(() => new Map(layout.boxes.map((b) => [b.node.id, b])), [layout])
  const hoveredNode = hovered ? boxOf.get(hovered.id)?.node : undefined
  /** Everything dims except the band under the pointer and the ribbon it owns. */
  const lit = (id: string) => !hovered || hovered.id === id

  if (layout.boxes.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-3">Nothing moved in this period.</p>
  }

  return (
    <div className="relative">
      <div ref={box} className="overflow-x-auto overscroll-x-contain">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={caption ?? 'Where the money came from and what it became'}
          onPointerLeave={() => setHovered(null)}
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
                  className="transition-[fill-opacity] duration-150"
                  onPointerMove={(e) =>
                    setHovered({ id: r.colourFrom, x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })
                  }
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
                className="transition-[fill-opacity] duration-150"
                onPointerMove={(e) =>
                  setHovered({ id: b.node.id, x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })
                }
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
          </g>
        </svg>
      </div>

      {hovered && hoveredNode && (
        <div
          // Follows the pointer, clamped to the card so a band near the right
          // edge does not open a panel off it.
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-xl bg-surface px-3 py-2 text-sm shadow-lg ring-1 ring-hairline"
          style={{
            left: Math.min(Math.max(80, hovered.x + LABEL), width - 80),
            top: Math.max(36, hovered.y - 8),
          }}
        >
          <div className="flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: colourOf(hoveredNode) }} />
            <span className="text-ink-3">{hoveredNode.name}</span>
            <span className="ml-auto pl-3 font-semibold text-ink tabular">{money(hoveredNode.valueMinor)}</span>
          </div>
          {graph.totalMinor > 0 && hoveredNode.side !== 'hub' && (
            <p className="mt-0.5 text-xs text-ink-3">
              {Math.round((hoveredNode.valueMinor / graph.totalMinor) * 100)}% of everything that moved
            </p>
          )}
        </div>
      )}

      <p className={cx('mt-2 text-xs text-ink-3', !caption && 'sr-only')}>
        {caption ?? 'Left: where the money came from. Right: what it became. Each ribbon is as wide as the amount it carries.'}
      </p>
    </div>
  )
}
