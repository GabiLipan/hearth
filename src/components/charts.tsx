import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  AreaChart,
  Area,
  ReferenceLine,
} from 'recharts'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useChartColors } from '../hooks/useChartColors'
import { useTouchTooltip, TIP_FADE_MS } from '../hooks/useTouchTooltip'
import { useApp } from '../state/AppContext'
import { distinctShades } from '../lib/shade'
import { niceScale, type Scale } from '../lib/scale'
import { OTHER_SLICE_ID, type CategorySlice, type MonthPoint } from '../lib/stats'
import { cx } from './ui'

/* ---------- Drawing a ring in ---------- */

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A 0 → 1 sweep that restarts whenever `key` changes.
 *
 * The donut used to be drawn outright, with `isAnimationActive={false}` and a
 * note explaining that Recharts 3.x leaves a PADDED pie frozen at the first
 * frame of its entrance animation — so the ring never appeared at all. Turning
 * the flag back on would put that bug back. This drives the sweep from outside
 * Recharts instead: the pie is always static as far as it is concerned, and
 * what changes each frame is the angle it is asked to draw to.
 *
 * Two things it has to survive, both of which this codebase has been caught by
 * before:
 *
 *   - A BACKGROUNDED TAB never runs the rAF callback, so nothing that has to be
 *     TRUE may live in one. The timeout is not a tidy-up, it is the guarantee:
 *     background timers are throttled but they do fire, so the ring always ends
 *     up complete even if not one frame was ever painted.
 *   - Reduced motion means no sweep at all, decided before the first paint
 *     rather than by cancelling one.
 */
function useSweep(key: string, duration = 620): number {
  const [t, setT] = useState(() => (reducedMotion() ? 1 : 0))
  const raf = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (reducedMotion()) {
      setT(1)
      return
    }
    setT(0)
    const started = performance.now()
    const frame = (now: number) => {
      const p = Math.min(1, (now - started) / duration)
      // Ease out: a ring that decelerates into place reads as settling rather
      // than as stopping.
      setT(1 - (1 - p) ** 3)
      if (p < 1) raf.current = requestAnimationFrame(frame)
    }
    raf.current = requestAnimationFrame(frame)
    timer.current = setTimeout(() => setT(1), duration + 120)
    return () => {
      cancelAnimationFrame(raf.current)
      clearTimeout(timer.current)
    }
  }, [key, duration])

  return t
}

/* ---------- Shared tooltip ---------- */
interface TipRow {
  name: string
  value: number
  color?: string
}
function ChartTip({
  active,
  label,
  rows,
  fading,
}: {
  active?: boolean
  label?: string
  rows: TipRow[]
  /** On its way out after a touch — see `useTouchTooltip`. */
  fading?: boolean
}) {
  const { money } = useApp()
  if (!active || rows.length === 0) return null
  return (
    <div
      className="rounded-xl bg-surface px-3 py-2 text-sm shadow-lg ring-1 ring-hairline"
      style={{ opacity: fading ? 0 : 1, transition: `opacity ${TIP_FADE_MS}ms linear` }}
    >
      {label && <div className="mb-1 font-medium text-ink-2">{label}</div>}
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-2">
          {r.color && <span className="size-2.5 rounded-full" style={{ background: r.color }} />}
          <span className="text-ink-3">{r.name}</span>
          <span className="ml-auto pl-3 font-semibold text-ink tabular">{money(r.value)}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * How a month that has not finished yet is drawn: at 45%, everywhere.
 *
 * A part-month plotted solid beside eleven whole ones reads as a collapse in
 * spending rather than as the 3rd of the month, and that misreading is worse
 * on the charts than anywhere else — a figure you can question, a bar you just
 * see. Dimming is the lightest thing that says "not comparable yet" without
 * hiding the number or rescaling the axis around it.
 */
const PARTIAL_OPACITY = 0.45
const bars = (data: MonthPoint[], fill: string, keyPrefix: string) =>
  data.map((d, i) => (
    <Cell key={`${keyPrefix}-${i}`} fill={fill} fillOpacity={d.partial ? PARTIAL_OPACITY : 1} />
  ))

/* ---------- A chart that shows six months and holds thirty ---------- */

/**
 * The window is what the toggle says; the history is everything there is.
 *
 * "Last 6 months" is the right amount to READ — twelve bars on a phone are
 * four pixels apart and tell you nothing — and the wrong amount to HAVE, because
 * the question a trend raises is always "and before that?". Showing the window
 * and scrolling to the rest answers it without a second control: the chart is
 * as legible as it was, and the history is one swipe away.
 *
 * It opens at the most recent month, which is the one you came to see, and
 * every earlier one is to the left of it — the direction a timeline already runs.
 */
const PLOT_TOP = 8
/**
 * The strip the month labels sit in.
 *
 * Given to the `XAxis` explicitly rather than left to Recharts' default,
 * because the axis outside the scroller has to know exactly where the plot area
 * ends to line its labels up with the grid. A default that changed by a pixel
 * would put every figure a pixel off its line, on every chart at once.
 */
const X_AXIS_H = 24
const AXIS_W = 56

/** Where a value sits, in pixels down from the top of the chart box. */
function yOf(value: number, scale: Scale, height: number): number {
  const bottom = height - X_AXIS_H
  const span = scale.max - scale.min || 1
  return bottom - ((value - scale.min) / span) * (bottom - PLOT_TOP)
}

/**
 * The value axis, drawn outside the scrolling area.
 *
 * Plain DOM rather than a second Recharts chart: two charts agree about where
 * their plot areas are only by accident, and the accident stops holding the
 * first time a margin changes. This shares the arithmetic with the grid instead
 * — same `Scale`, same constants — so the labels cannot drift from the lines.
 */
function ValueAxis({ scale, height }: { scale: Scale; height: number }) {
  const { money } = useApp()
  return (
    <div className="relative shrink-0" style={{ width: AXIS_W, height }} aria-hidden>
      {scale.ticks.map((t) => (
        <span
          key={t}
          className="absolute right-2 -translate-y-1/2 text-xs text-ink-3 tabular"
          style={{ top: yOf(t, scale, height) }}
        >
          {money(t, { compact: true, hideDecimals: true })}
        </span>
      ))}
    </div>
  )
}

/**
 * Where a tooltip goes, once its chart can scroll.
 *
 * A Recharts tooltip normally lives inside `.recharts-wrapper`, and that is
 * fine for a chart that is entirely on screen. Here it is fatal twice over.
 * The wrapper is inside a box with `overflow-x: auto`, which clips on BOTH
 * axes — so anything the tooltip puts outside the visible window is simply cut
 * off, which looks exactly like it sliding under the pinned value axis. And
 * Recharts positions it against the chart's viewBox, which for a windowed
 * chart is the whole twelve months rather than the six you can see, so it has
 * no idea where the edges it should flip away from actually are.
 *
 * So the tooltip is portalled out of the scroller into a layer over the card,
 * and placed here. Recharts deliberately applies NO positioning of its own
 * once `portal` is set (see `TooltipBoundingBox`) — the whole job comes with
 * the whole control.
 */
/** How far from the pointer the panel sits. */
const TIP_GAP = 14

/**
 * `visible` months across the width, the rest reachable by scrolling.
 *
 * The inner width is a PERCENTAGE of the scroller, so nothing has to be
 * measured: 12 months at a window of 6 is 200%, whatever the card is. The
 * chart inside is told to hide its own value axis and to use the domain and
 * ticks the axis beside it was drawn from.
 */
export function MonthScroller({
  count,
  visible,
  height,
  scale,
  children,
}: {
  count: number
  visible: number
  height: number
  scale: Scale
  /**
   * The chart, given the element its `Tooltip` should portal into and what its
   * `active` should be. A render prop rather than a plain child because both
   * have to reach a `Tooltip` nested inside a Recharts chart, and Recharts
   * finds its own children by type — a wrapper component around `Tooltip`
   * would simply not be seen.
   */
  children: (portal: HTMLElement | null, active: boolean | undefined) => ReactElement
}) {
  const ref = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<HTMLDivElement | null>(null)
  const scrolls = count > visible
  /**
   * A tapped bar has no "leave", so the panel is given an ending: it stays
   * while the finger is down and fades a few seconds after it lifts. The fade
   * goes on the LAYER rather than on the panel inside it — the layer is the
   * one thing here that is not Recharts', and it holds the panel for every
   * chart that scrolls, so all four fade the same way.
   */
  const touch = useTouchTooltip()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !scrolls) return
    // The most recent month, which is the one the page is about. The inner
    // width is CSS-driven, so `scrollWidth` is already right — nothing is
    // waiting on Recharts to measure itself.
    el.scrollLeft = el.scrollWidth
  }, [count, visible, scrolls])

  /**
   * Follow the pointer, in the card's coordinates rather than the chart's.
   *
   * Written straight to the style rather than held in state: this fires on
   * every pointer move over the chart, and a re-render per move would re-run
   * every `useMemo` in the chart under it.
   */
  const pointer = useRef({ x: 0, y: 0 })
  const place = useCallback(() => {
    const outer = box.current
    const layer = tip
    const panel = layer?.firstElementChild as HTMLElement | null
    if (!outer || !layer) return
    const r = outer.getBoundingClientRect()
    const x = pointer.current.x - r.left
    const y = pointer.current.y - r.top
    const w = panel?.offsetWidth ?? 0
    const h = panel?.offsetHeight ?? 0
    // Right of the pointer, unless that would run off the card — then left of
    // it. The card's edge is the boundary that matters, and it is the one
    // Recharts cannot see from inside the scroller.
    const left = Math.max(0, x + TIP_GAP + w > r.width ? x - TIP_GAP - w : x + TIP_GAP)
    const top = Math.max(0, Math.min(y - h / 2, Math.max(0, r.height - h)))
    layer.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  }, [tip])

  /**
   * Place it again whenever it changes size.
   *
   * The panel does not exist on the pointer move that first activates it, so
   * that placement measures nothing and cannot know whether there is room to
   * the right — which is exactly the case where flipping matters, and the
   * pointer may never move again to correct it. The same observer covers the
   * panel growing or shrinking as it moves between months with longer figures
   * in them.
   */
  useEffect(() => {
    if (!tip) return
    const ro = new ResizeObserver(place)
    ro.observe(tip)
    return () => ro.disconnect()
  }, [tip, place])

  return (
    /* No fade at the scrolling edge, deliberately. Every gradient that would
       hint at more to the left also washes out the bar under it — and a faded
       bar already MEANS something here: a month that has not finished. The
       scrollbar and the caption say it instead, in a vocabulary that is not
       already spoken for. */
    <div ref={box} className="relative flex">
      <ValueAxis scale={scale} height={height} />
      <div
        ref={ref}
        // `pb-2` is for the scrollbar, not for spacing: a scrollbar is drawn at
        // the bottom of the PADDING box, and without it a thin one lands
        // straight through the month labels and strikes them out.
        className={cx('min-w-0 flex-1', scrolls && 'overflow-x-auto overscroll-x-contain pb-2')}
        style={{ scrollbarWidth: 'thin' }}
        {...touch.handlers}
        onPointerMove={(e) => {
          pointer.current = { x: e.clientX, y: e.clientY }
          place()
          touch.keep()
        }}
      >
        <div style={{ width: scrolls ? `${(count / visible) * 100}%` : '100%' }}>
          <ResponsiveContainer width="100%" height={height}>
            {children(tip, touch.active)}
          </ResponsiveContainer>
        </div>
      </div>
      {/* Outside the scroller, so nothing clips it, and above the axis, so it
          is never behind the figures it is explaining. Recharts hides and shows
          the panel inside it; this layer only ever moves. */}
      <div
        ref={setTip}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 z-30"
        style={{ opacity: touch.fading ? 0 : 1, transition: `opacity ${TIP_FADE_MS}ms linear` }}
      />
    </div>
  )
}

/** The axis props every scrolling chart shares, so they cannot disagree. */
const axisProps = (c: ReturnType<typeof useChartColors>, scale: Scale) =>
  ({
    x: {
      dataKey: 'label',
      height: X_AXIS_H,
      tickLine: false,
      axisLine: { stroke: c.baseline },
      tick: { fill: c.ink3, fontSize: 12 },
      dy: 4,
    },
    // Hidden, not absent: the chart still needs an axis to scale against and to
    // hang the grid lines off, it just must not draw one — `ValueAxis` has.
    y: { hide: true, domain: [scale.min, scale.max] as [number, number], ticks: scale.ticks },
  }) as const

const CHART_MARGIN = { top: PLOT_TOP, right: 6, left: 6, bottom: 0 }

/* ---------- Monthly spending: bars, a line, or an area ---------- */

export type TrendShape = 'bars' | 'line' | 'area'

export const TREND_SHAPES: { value: TrendShape; label: string }[] = [
  { value: 'bars', label: 'Bars' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
]

/**
 * The same list without the area, for a series that crosses zero.
 *
 * An area chart shades the gap between the line and the axis, and when the line
 * dips below zero it shades a region that reads as a quantity — a big filled
 * shape under the baseline, in the same colour as the good months above it.
 * Bars have a direction; a filled area does not.
 */
export const NET_SHAPES: { value: TrendShape; label: string }[] = [
  { value: 'line', label: 'Line' },
  { value: 'bars', label: 'Bars' },
]

export function SpendBars({
  data,
  height = 220,
  visible = data.length,
  shape = 'bars',
}: {
  data: MonthPoint[]
  height?: number
  /** How many months fit across the width. The rest scroll. */
  visible?: number
  shape?: TrendShape
}) {
  const c = useChartColors()
  const scale = useMemo(() => niceScale(0, Math.max(...data.map((d) => d.spend), 0)), [data])
  const a = axisProps(c, scale)
  const tip = (portal: HTMLElement | null, shown: boolean | undefined) => (
    <Tooltip
      portal={portal}
      active={shown}
      cursor={shape === 'bars' ? { fill: c.ink3, fillOpacity: 0.08 } : { stroke: c.ink3, strokeOpacity: 0.3 }}
      content={({ active, payload, label }) => (
        <ChartTip
          active={active}
          label={String(label ?? '')}
          rows={(payload ?? []).map((p) => ({ name: 'Spent', value: Number(p.value), color: c.series[0] }))}
        />
      )}
    />
  )

  return (
    <MonthScroller count={data.length} visible={visible} height={height} scale={scale}>
      {(portal, shown) => (shape === 'bars' ? (
        <BarChart data={data} margin={CHART_MARGIN} barCategoryGap="35%">
          <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
          <XAxis {...a.x} />
          <YAxis {...a.y} />
          {tip(portal, shown)}
          <Bar dataKey="spend" fill={c.series[0]} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
            {bars(data, c.series[0], 'spend')}
          </Bar>
        </BarChart>
      ) : shape === 'area' ? (
        <AreaChart data={data} margin={CHART_MARGIN}>
          <defs>
            <linearGradient id="spend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c.series[0]} stopOpacity={0.35} />
              <stop offset="100%" stopColor={c.series[0]} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
          <XAxis {...a.x} />
          <YAxis {...a.y} />
          {tip(portal, shown)}
          <Area
            type="monotone"
            dataKey="spend"
            stroke={c.series[0]}
            strokeWidth={2}
            fill="url(#spend-fill)"
            dot={false}
            activeDot={{ r: 5, strokeWidth: 2, stroke: c.surface }}
            isAnimationActive={false}
          />
        </AreaChart>
      ) : (
        <LineChart data={data} margin={CHART_MARGIN}>
          <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
          <XAxis {...a.x} />
          <YAxis {...a.y} />
          {tip(portal, shown)}
          <Line
            type="monotone"
            dataKey="spend"
            stroke={c.series[0]}
            strokeWidth={2}
            dot={{ r: 3, fill: c.series[0], strokeWidth: 2, stroke: c.surface }}
            activeDot={{ r: 5, strokeWidth: 2, stroke: c.surface }}
            isAnimationActive={false}
          />
        </LineChart>
      ))}
    </MonthScroller>
  )
}

/* ---------- Income vs spending (two entities, fixed colors) ---------- */
export function IncomeSpendBars({
  data,
  height = 240,
  visible = data.length,
}: {
  data: MonthPoint[]
  height?: number
  visible?: number
}) {
  const c = useChartColors()
  const income = c.series[1] // aqua — income everywhere in the app
  const spend = c.series[0] // blue — spending everywhere in the app
  const scale = useMemo(
    () => niceScale(0, Math.max(...data.flatMap((d) => [d.spend, d.income]), 0)),
    [data],
  )
  const a = axisProps(c, scale)
  return (
    <div>
      <MonthScroller count={data.length} visible={visible} height={height} scale={scale}>
        {(portal, shown) => (
        <BarChart data={data} margin={CHART_MARGIN} barCategoryGap="30%" barGap={2}>
          <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
          <XAxis {...a.x} />
          <YAxis {...a.y} />
          <Tooltip
            portal={portal}
            active={shown}
            cursor={{ fill: c.ink3, fillOpacity: 0.08 }}
            content={({ active, payload, label }) => (
              <ChartTip
                active={active}
                label={String(label ?? '')}
                rows={(payload ?? []).map((p) => ({
                  name: p.dataKey === 'income' ? 'Income' : 'Spending',
                  value: Number(p.value),
                  color: p.dataKey === 'income' ? income : spend,
                }))}
              />
            )}
          />
          <Bar dataKey="income" fill={income} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false}>
            {bars(data, income, 'income')}
          </Bar>
          <Bar dataKey="spend" fill={spend} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false}>
            {bars(data, spend, 'spend')}
          </Bar>
        </BarChart>
        )}
      </MonthScroller>
      <div className="mt-1 flex flex-wrap justify-center gap-x-5 gap-y-1 text-sm text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ background: income }} /> Income
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ background: spend }} /> Spending
        </span>
        {data.some((d) => d.partial) && <span className="text-ink-3">Faded = this month so far</span>}
        {data.length > visible && <span className="text-ink-3">Scroll back for earlier months</span>}
      </div>
    </div>
  )
}

/* ---------- Net cashflow line ---------- */
export function NetLine({
  data,
  height = 220,
  visible = data.length,
  shape = 'line',
}: {
  data: MonthPoint[]
  height?: number
  visible?: number
  shape?: TrendShape
}) {
  const c = useChartColors()
  const scale = useMemo(
    () =>
      niceScale(
        Math.min(...data.map((d) => d.net), 0),
        Math.max(...data.map((d) => d.net), 0),
      ),
    [data],
  )
  const a = axisProps(c, scale)
  const tip = (portal: HTMLElement | null, shown: boolean | undefined) => (
    <Tooltip
      portal={portal}
      active={shown}
      cursor={shape === 'bars' ? { fill: c.ink3, fillOpacity: 0.08 } : { stroke: c.ink3, strokeOpacity: 0.3 }}
      content={({ active, payload, label }) => (
        <ChartTip
          active={active}
          label={String(label ?? '')}
          // A negative month is not a small amount of saving, it is
          // spending more than came in — and calling both of them "net"
          // is how a chart ends up claiming credit for a bad month.
          rows={(payload ?? []).map((p) => ({
            name: Number(p.value) < 0 ? 'Overspent by' : 'Kept',
            value: Math.abs(Number(p.value)),
            color: Number(p.value) < 0 ? c.critical : c.series[4],
          }))}
        />
      )}
    />
  )
  return (
    <MonthScroller count={data.length} visible={visible} height={height} scale={scale}>
      {(portal, shown) => (shape === 'bars' ? (
        <BarChart data={data} margin={CHART_MARGIN} barCategoryGap="35%">
          <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
          <XAxis {...a.x} />
          <YAxis {...a.y} />
          <ReferenceLine y={0} stroke={c.baseline} strokeWidth={1} />
          {tip(portal, shown)}
          {/* A month that went the other way is not a small good month, so it
              is not the good colour. The bars have to be coloured one at a time
              for that — a single fill cannot say which side of zero it is on. */}
          <Bar dataKey="net" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={d.net < 0 ? c.critical : c.series[4]}
                fillOpacity={d.partial ? PARTIAL_OPACITY : 1}
              />
            ))}
          </Bar>
        </BarChart>
      ) : (
        <LineChart data={data} margin={CHART_MARGIN}>
          <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
          <XAxis {...a.x} />
          <YAxis {...a.y} />
          <ReferenceLine y={0} stroke={c.baseline} strokeWidth={1} />
          {tip(portal, shown)}
          <Line
            type="monotone"
            dataKey="net"
            stroke={c.series[4]}
            strokeWidth={2}
            dot={{ r: 3, fill: c.series[4], strokeWidth: 2, stroke: c.surface }}
            activeDot={{ r: 5, strokeWidth: 2, stroke: c.surface }}
            isAnimationActive={false}
          />
        </LineChart>
      ))}
    </MonthScroller>
  )
}

/* ---------- Category breakdowns ---------- */

/** The shapes a category breakdown can take. */
export type SliceShape = 'donut' | 'bars'

export const SLICE_SHAPES: { value: SliceShape; label: string }[] = [
  { value: 'donut', label: 'Ring' },
  { value: 'bars', label: 'Bars' },
]

/**
 * One colour per slice, with anything that collided pulled apart.
 *
 * Twelve slots and no limit on categories means two slices of identical colour
 * is the ordinary case, not the edge one — and a subcategory inherits its
 * parent's slot deliberately, so drilling in is where it bites hardest.
 * `distinctShades` keeps the FIRST user of a slot exactly as the palette
 * defined it, and the slices arrive biggest first, so the arc the eye goes to
 * is never the one that moved.
 *
 * Shared by the ring and the bars so that switching between them is a change of
 * shape and nothing else. Two colourings of the same figures would make the
 * choice of chart look like a change in the data.
 */
function useSliceColours(slices: CategorySlice[]) {
  const c = useChartColors()
  const otherColor = c.ink3
  const colours = useMemo(
    () =>
      distinctShades(slices, (s) =>
        s.categoryId === OTHER_SLICE_ID ? otherColor : c.slot(s.slot),
      ),
    [slices, c, otherColor],
  )
  const indexOf = useMemo(() => new Map(slices.map((s, i) => [s.categoryId, i])), [slices])
  return (s: CategorySlice) => colours[indexOf.get(s.categoryId) ?? 0] ?? otherColor
}

/**
 * The same figures as the ring, as a row of bars.
 *
 * A ring is the better picture of SHARES — a quarter looks like a quarter — and
 * a bad picture of sizes, because comparing two arcs means comparing two angles
 * rather than two lengths. Bars are the other way round. Both are honest, they
 * answer different questions, and which question you have is not something the
 * app can know.
 */
export function CategoryBars({ slices }: { slices: CategorySlice[] }) {
  const { money } = useApp()
  const colorOf = useSliceColours(slices)
  const biggest = Math.max(...slices.map((s) => s.totalMinor), 1)
  if (slices.length === 0) return null
  return (
    <ul className="space-y-2">
      {slices.map((s) => (
        <li key={s.categoryId}>
          <div className="flex items-baseline gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-ink-2">{s.name}</span>
            <span className="shrink-0 font-medium tabular">{money(s.totalMinor)}</span>
            <span className="w-10 shrink-0 text-right text-xs text-ink-3 tabular">
              {Math.round(s.fraction * 100)}%
            </span>
          </div>
          {/* Measured against the BIGGEST category rather than the total, so
              the second and third are comparable with the first instead of all
              of them being a sliver of a bar nobody can read. */}
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(2, (s.totalMinor / biggest) * 100)}%`, background: colorOf(s) }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ---------- Category donut with legend list ---------- */
export function CategoryDonut({
  slices,
  centerLabel,
  height = 240,
}: {
  slices: CategorySlice[]
  centerLabel?: { title: string; value: string }
  height?: number
}) {
  const c = useChartColors()
  const { money } = useApp()
  const colorOf = useSliceColours(slices)

  /**
   * Restarts on mount — so the ring draws itself in whenever the tab is opened
   * — and whenever the slices change, which is what makes drilling into a
   * category animate rather than swap.
   */
  const sweep = useSweep(slices.map((s) => s.categoryId).join('|'))
  // Clockwise from twelve o'clock: the conventional reading position, and with
  // the slices sorted biggest first it puts the largest arc where the eye
  // starts. `paddingAngle` scales with the sweep, or the gaps would be wider
  // than the arcs for the first few frames.
  const startAngle = 90
  const endAngle = 90 - 360 * sweep
  /** A tapped slice, like a tapped bar, needs an ending given to it. */
  const touch = useTouchTooltip()
  return (
    /* A CONTAINER query, not `sm:`. This chart is a full-width panel on
       Reports and a widget in a 2-to-4 column grid on the home page, so the
       viewport says nothing useful about how much room it actually has —
       `sm:` put the legend beside a 220px donut inside a 340px card, and the
       figures ran off the edge. `@container` asks the card instead.

       The wrapper is not decoration: an element cannot query ITSELF, so
       `@container` and the `@md:` that reads it have to be on different
       elements. Putting both on the grid silently leaves it one column for
       ever, which looks like a layout choice rather than a broken query. */
    <div className="@container">
      <div className="grid items-center gap-3 @md:grid-cols-[200px_minmax(0,1fr)] [&>*]:min-w-0">
        <div className="relative mx-auto w-full max-w-[220px]" style={{ height }} {...touch.handlers}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="totalMinor"
                nameKey="name"
                innerRadius="68%"
                outerRadius="96%"
                startAngle={startAngle}
                endAngle={endAngle}
                paddingAngle={2 * sweep}
                strokeWidth={2}
                stroke={c.surface}
                // Still off, and still for the reason it always was: Recharts
                // 3.x leaves a PADDED pie frozen at the first frame of its own
                // entrance animation, so the ring never appears. `useSweep`
                // drives the angles from outside instead, which this flag does
                // not interfere with.
                isAnimationActive={false}
              >
                {slices.map((s) => (
                  <Cell key={s.categoryId} fill={colorOf(s)} />
                ))}
              </Pie>
              <Tooltip
                active={touch.active}
                content={({ active, payload }) => {
                  const p = payload?.[0]
                  const s = p?.payload as CategorySlice | undefined
                  return (
                    <ChartTip
                      active={active}
                      fading={touch.fading}
                      rows={s ? [{ name: s.name, value: s.totalMinor, color: colorOf(s) }] : []}
                    />
                  )
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          {centerLabel && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xs text-ink-3">{centerLabel.title}</span>
              <span className="text-xl font-bold tracking-tight tabular">{centerLabel.value}</span>
            </div>
          )}
        </div>
        {/* The legend wraps into columns on a wide card rather than stretching
            each row until the name and its figure sit an inch apart. */}
        <ul className="grid gap-x-6 gap-y-1.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]">
          {slices.map((s) => (
            <li key={s.categoryId} className="flex min-w-0 items-center gap-2.5 text-sm">
              <span className="size-3 shrink-0 rounded-[4px]" style={{ background: colorOf(s) }} />
              {/* `min-w-0` is what makes `truncate` do anything here. A flex
                  item's min-width is auto — its CONTENT's width — so without it
                  the name refuses to shrink, the row stays as wide as the longest
                  category, and the amount and percentage are pushed off the card
                  rather than the name being shortened. */}
              <span className="min-w-0 flex-1 truncate text-ink-2">{s.name}</span>
              <span className="shrink-0 font-medium text-ink tabular">{money(s.totalMinor)}</span>
              <span className="w-10 shrink-0 text-right text-xs text-ink-3 tabular">
                {Math.round(s.fraction * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
