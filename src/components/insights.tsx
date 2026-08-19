import { Fragment, useMemo } from 'react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  LineChart,
  Line,
  ReferenceLine,
} from 'recharts'
import { useChartColors } from '../hooks/useChartColors'
import { paintOf } from '../lib/palette'
import type { SplitSlice } from '../lib/books'
import { useApp } from '../state/AppContext'
import { useTouchTooltip, TIP_FADE_MS } from '../hooks/useTouchTooltip'
import { monthLabel, thisMonthKey } from '../lib/dates'
import type {
  FixedVariable,
  Heatmap,
  PacePoint,
  PayeeTotal,
  SalaryBar,
  SavingsRatePoint,
  WaterfallStep,
} from '../lib/insights'
import { CategoryIcon } from './CategoryIcon'
import { roundedBar, stackedBar } from './charts'
import { ScrollTable, table, cx } from './ui'

/**
 * The report views that are not a donut.
 *
 * Two rules hold across all of them, because they are what stops a chart being
 * confidently wrong:
 *
 *   - a month that has not finished is drawn faded, at the same 45% the other
 *     charts use, and says so in words;
 *   - nothing is invented to fill a gap. A missing value is a gap in the line,
 *     not a zero, because a zero is a claim.
 */

const PARTIAL_OPACITY = 0.45

/**
 * An axis label that wraps onto a second line instead of colliding.
 *
 * The waterfall's steps are phrases — "Moved to savings", "Left in current" —
 * and four of them across a phone-width chart run into each other into one
 * unreadable string. Recharts' own tick has no wrapping, and shortening the
 * words to fit would take the meaning out of the one chart whose whole point is
 * the sequence of steps.
 */
function WrapTick({
  x,
  y,
  payload,
  fill,
}: {
  // Recharts types these loosely — `x` and `y` are `string | number` on the
  // props it hands a custom tick, though it only ever passes numbers.
  x?: string | number
  y?: string | number
  payload?: { value?: unknown }
  fill: string
}) {
  const words = String(payload?.value ?? '').split(' ')
  const lines = words.length < 2 ? words : [words.slice(0, -1).join(' '), words[words.length - 1]]
  return (
    // The offset goes on the FIRST tspan, not on the <text>. A tspan carrying
    // its own `dy` replaces the shift it would have inherited rather than
    // adding to it, so `<text dy=15><tspan dy=0>` puts the first line back on
    // the axis line — through the bars.
    <text x={x} y={y} textAnchor="middle" fill={fill} fontSize={11}>
      {lines.map((line, i) => (
        <tspan key={line} x={x} dy={i === 0 ? 15 : 12}>
          {line}
        </tspan>
      ))}
    </text>
  )
}

/** Matches `ChartTip` in charts.tsx — the same panel, wherever a tooltip appears. */
function Tip({
  label,
  rows,
  fading,
}: {
  label?: string
  rows: { name: string; value: string; color?: string }[]
  /** On its way out after a touch — see `useTouchTooltip`. */
  fading?: boolean
}) {
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
          <span className="ml-auto pl-3 font-semibold text-ink tabular">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

/* ---------- 1. Household waterfall ---------- */

/**
 * Where the household's money went, in the order it went there.
 *
 * Recharts has no waterfall, and the standard trick is what is used here: an
 * invisible bar holding each floating step up, with the visible one stacked on
 * top of it. The final bar is a total, so it sits on the axis with no base —
 * that difference is the whole reason to draw this rather than a bar chart.
 */
export function Waterfall({ steps, height = 260 }: { steps: WaterfallStep[]; height?: number }) {
  const c = useChartColors()
  const { money } = useApp()
  /**
   * The ending a tap does not have.
   *
   * These five were written against hover and never got the linger the
   * scrolling charts and the ring have: on a touch screen the panel opened and
   * then sat over the chart until something unrelated closed it. Reported on an
   * iPad, but it was never about the size of the screen — every touch device
   * had it. The same hook, so the same press means the same thing on every
   * chart in the app.
   */
  const tip = useTouchTooltip()

  const data = useMemo(
    () =>
      steps.map((s) => {
        const from = s.total ? 0 : s.runningMinor - s.deltaMinor
        const to = s.runningMinor
        return {
          ...s,
          base: Math.min(from, to),
          size: s.total ? Math.abs(to) : Math.abs(s.deltaMinor),
        }
      }),
    [steps],
  )

  const colourOf = (s: WaterfallStep) =>
    s.total ? c.ink2 : s.deltaMinor >= 0 ? c.series[1] : c.series[0]

  return (
    <div {...tip.handlers}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={{ stroke: c.baseline }}
          tick={(props) => <WrapTick {...props} fill={c.ink3} />}
          height={46}
          interval={0}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fill: c.ink3, fontSize: 12 }}
          tickFormatter={(v: number) => money(v, { compact: true, hideDecimals: true })}
          width={54}
        />
        <Tooltip
          active={tip.active}
          cursor={{ fill: c.ink3, fillOpacity: 0.08 }}
          content={({ active, payload }) => {
            const s = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined
            if (!s) return null
            return (
              <Tip
                fading={tip.fading}
                label={s.label}
                rows={[
                  {
                    name: s.total ? 'Left' : s.deltaMinor >= 0 ? 'In' : 'Out',
                    value: money(s.total ? s.runningMinor : Math.abs(s.deltaMinor)),
                    color: colourOf(s),
                  },
                  ...(s.total ? [] : [{ name: 'Running total', value: money(s.runningMinor) }]),
                ]}
              />
            )
          }}
        />
        {/* The lift. Transparent rather than surface-coloured, so the grid lines
            behind it are not chopped into segments. */}
        <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
        <Bar dataKey="size" stackId="w" shape={roundedBar} maxBarSize={56}>
          {data.map((s) => (
            <Cell key={s.key} fill={colourOf(s)} />
          ))}
        </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ---------- 2. What a salary turned into ---------- */

export function SalaryStack({ data, height = 240 }: { data: SalaryBar[]; height?: number }) {
  const c = useChartColors()
  const { money } = useApp()
  /**
   * The ending a tap does not have.
   *
   * These five were written against hover and never got the linger the
   * scrolling charts and the ring have: on a touch screen the panel opened and
   * then sat over the chart until something unrelated closed it. Reported on an
   * iPad, but it was never about the size of the screen — every touch device
   * had it. The same hook, so the same press means the same thing on every
   * chart in the app.
   */
  const tip = useTouchTooltip()
  /**
   * Two tones of one colour for the two halves of the household share, and
   * separate hues for the rest. A second hue there would read as a fourth
   * destination rather than as two ways of reaching one.
   *
   * `color-mix` against the surface rather than an opacity, because these bars
   * are drawn at 45% on an unfinished month — see `PARTIAL_OPACITY` — and a
   * segment that was already translucent would land at a different lightness
   * from its neighbour in exactly the month somebody is looking hardest at.
   */
  const toUs = c.series[1]
  const parts = [
    { key: 'contributedMovedMinor' as const, name: 'Moved to our household', colour: toUs },
    {
      key: 'contributedPaidMinor' as const,
      name: 'Bought for the household',
      colour: `color-mix(in oklab, ${toUs} 45%, var(--surface))`,
    },
    { key: 'spentMinor' as const, name: 'Spent on me', colour: c.series[0] },
    { key: 'leftMinor' as const, name: 'Left with me', colour: c.series[2] },
  ]

  return (
    <div {...tip.handlers}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }} barCategoryGap="35%">
          <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: c.baseline }} tick={{ fill: c.ink3, fontSize: 12 }} dy={4} />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: c.ink3, fontSize: 12 }}
            tickFormatter={(v: number) => money(v, { compact: true, hideDecimals: true })}
            width={54}
          />
          <Tooltip
            active={tip.active}
            cursor={{ fill: c.ink3, fillOpacity: 0.08 }}
            content={({ active, payload, label }) => {
              const row = active ? (payload?.[0]?.payload as SalaryBar | undefined) : undefined
              if (!row) return null
              return (
                <Tip
                  fading={tip.fading}
                  label={String(label ?? '')}
                  rows={[
                    ...parts.map((p) => ({ name: p.name, value: money(row[p.key]), color: p.colour })),
                    { name: 'Earned', value: money(row.earnedMinor) },
                  ]}
                />
              )
            }}
          />
          {parts.map((p) => (
            <Bar key={p.key} dataKey={p.key} stackId="s" fill={p.colour} shape={stackedBar} maxBarSize={40}>
              {data.map((d) => (
                <Cell key={d.key} fill={p.colour} fillOpacity={d.partial ? PARTIAL_OPACITY : 1} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
      <Legend items={parts.map((p) => ({ name: p.name, colour: p.colour }))} partial={data.some((d) => d.partial)} />
    </div>
  )
}

/* ---------- 3. Fixed against variable ---------- */

export function FixedVariableBars({ data, height = 240 }: { data: FixedVariable[]; height?: number }) {
  const c = useChartColors()
  const { money } = useApp()
  /**
   * The ending a tap does not have.
   *
   * These five were written against hover and never got the linger the
   * scrolling charts and the ring have: on a touch screen the panel opened and
   * then sat over the chart until something unrelated closed it. Reported on an
   * iPad, but it was never about the size of the screen — every touch device
   * had it. The same hook, so the same press means the same thing on every
   * chart in the app.
   */
  const tip = useTouchTooltip()
  const parts = [
    { key: 'fixedMinor' as const, name: 'Tracked bills', colour: c.series[3] },
    { key: 'variableMinor' as const, name: 'Everything else', colour: c.series[0] },
  ]

  return (
    <div {...tip.handlers}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }} barCategoryGap="35%">
          <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: c.baseline }} tick={{ fill: c.ink3, fontSize: 12 }} dy={4} />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: c.ink3, fontSize: 12 }}
            tickFormatter={(v: number) => money(v, { compact: true, hideDecimals: true })}
            width={54}
          />
          <Tooltip
            active={tip.active}
            cursor={{ fill: c.ink3, fillOpacity: 0.08 }}
            content={({ active, payload, label }) => {
              const row = active ? (payload?.[0]?.payload as FixedVariable | undefined) : undefined
              if (!row) return null
              const total = row.fixedMinor + row.variableMinor
              return (
                <Tip
                  fading={tip.fading}
                  label={String(label ?? '')}
                  rows={[
                    ...parts.map((p) => ({ name: p.name, value: money(row[p.key]), color: p.colour })),
                    {
                      name: 'Committed',
                      value: total > 0 ? `${Math.round((row.fixedMinor / total) * 100)}%` : '—',
                    },
                  ]}
                />
              )
            }}
          />
          {parts.map((p) => (
            <Bar key={p.key} dataKey={p.key} stackId="f" fill={p.colour} shape={stackedBar} maxBarSize={40}>
              {data.map((d) => (
                <Cell key={d.key} fill={p.colour} fillOpacity={d.partial ? PARTIAL_OPACITY : 1} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
      <Legend items={parts.map((p) => ({ name: p.name, colour: p.colour }))} partial={data.some((d) => d.partial)} />
    </div>
  )
}

/* ---------- 4. Savings rate ---------- */

/**
 * A percentage, so the axis is a percentage and zero is drawn as a line rather
 * than left to be inferred: below it the household spent more than came in,
 * and that boundary is the only number on this chart that matters at a glance.
 */
export function SavingsRateLine({ data, height = 220 }: { data: SavingsRatePoint[]; height?: number }) {
  const c = useChartColors()
  const { money } = useApp()
  const partial = data.some((d) => d.partial)
  /**
   * The ending a tap does not have.
   *
   * These five were written against hover and never got the linger the
   * scrolling charts and the ring have: on a touch screen the panel opened and
   * then sat over the chart until something unrelated closed it. Reported on an
   * iPad, but it was never about the size of the screen — every touch device
   * had it. The same hook, so the same press means the same thing on every
   * chart in the app.
   */
  const tip = useTouchTooltip()

  return (
    <div {...tip.handlers}>
      <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
        <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: c.baseline }} tick={{ fill: c.ink3, fontSize: 12 }} dy={4} />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fill: c.ink3, fontSize: 12 }}
          tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
          width={44}
        />
        <ReferenceLine y={0} stroke={c.baseline} />
        <Tooltip
          active={tip.active}
          cursor={{ stroke: c.ink3, strokeOpacity: 0.3 }}
          content={({ active, payload, label }) => {
            const row = active ? (payload?.[0]?.payload as SavingsRatePoint | undefined) : undefined
            if (!row) return null
            return (
              <Tip
                fading={tip.fading}
                label={String(label ?? '')}
                rows={
                  row.rate === null
                    ? [{ name: 'Nothing came in', value: '—' }]
                    : [
                        { name: 'Kept', value: `${Math.round(row.rate * 100)}%`, color: c.accent },
                        { name: 'Of', value: money(row.incomeMinor) },
                      ]
                }
              />
            )
          }}
        />
        {/* `connectNulls` off: a month with no income has no rate, and joining
            across it would draw a trend through a hole. */}
        {/* The part-finished month is a hollow dot rather than a solid one.
            It matters more here than on the bars: a rate is a ratio, and half a
            month of spending against a whole month's income reads as a sudden
            burst of thrift. */}
        <Line
          type="monotone"
          dataKey="rate"
          stroke={c.accent}
          strokeWidth={2}
          connectNulls={false}
          dot={(props) => {
            const { cx: x, cy: y, payload, index } = props as {
              cx?: number
              cy?: number
              index: number
              payload: SavingsRatePoint
            }
            if (x === undefined || y === undefined) return <g key={index} />
            return payload.partial ? (
              <circle key={index} cx={x} cy={y} r={4} fill={c.surface} stroke={c.accent} strokeWidth={2} />
            ) : (
              <circle key={index} cx={x} cy={y} r={3} fill={c.accent} />
            )
          }}
        />
        </LineChart>
      </ResponsiveContainer>
      {partial && (
        <p className="mt-1 text-center text-sm text-ink-3">
          The hollow point is this month so far — part of a month's spending against a whole month's income.
        </p>
      )}
    </div>
  )
}

/* ---------- 5. Top payees ---------- */

/**
 * Plain HTML rather than a chart library.
 *
 * A horizontal bar per row with the name written on it is a table with a
 * gradient, and Recharts' category axis would either truncate "Nationwide
 * Building Society" or eat a third of the width. This also lets each row carry
 * its category's colour and icon, which is what makes the list scannable.
 */
export function TopPayees({
  rows,
  onPick,
}: {
  rows: PayeeTotal[]
  /** Where a payee goes when pressed. Rows are inert without it. */
  onPick?: (payee: string) => void
}) {
  const { money } = useApp()
  const peak = rows.reduce((m, r) => Math.max(m, r.totalMinor), 0)
  if (rows.length === 0) return null

  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li
          key={r.payee}
          className={cx(
            'relative overflow-hidden rounded-lg',
            onPick && 'cursor-pointer transition-shadow hover:ring-1 hover:ring-hairline',
          )}
          onClick={onPick ? () => onPick(r.payee) : undefined}
        >
          {/* The bar is behind the text rather than beside it: at ten rows the
              two-column version leaves the names in a narrow gutter. */}
          <span
            aria-hidden
            // Fully rounded rather than the row's own `rounded-lg`: a payee
            // near the floor of this list is a 2% sliver, and a radius that
            // cannot exceed its width leaves a slab with the corners shaved
            // off. Everything else that draws a bar in the app clamps to half
            // the short side, and a stadium is what that means in CSS.
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${peak > 0 ? Math.max(2, (r.totalMinor / peak) * 100) : 0}%`,
              background: `color-mix(in oklab, ${paintOf(r.slot, r.color)} 20%, transparent)`,
            }}
          />
          <div className="relative flex items-center gap-2 px-2.5 py-1.5">
            <span className="shrink-0" style={{ color: paintOf(r.slot, r.color) }}>
              <CategoryIcon icon={r.icon} size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">{r.payee}</span>
            <span className="shrink-0 text-xs text-ink-3 tabular">
              {r.count}×
            </span>
            <span className="shrink-0 text-sm font-semibold tabular">{money(r.totalMinor)}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ---------- 6. Category heatmap ---------- */

/**
 * Months across, categories down.
 *
 * A CSS grid, not a chart: every cell is a number with a background, and the
 * only thing a plotting library would add is a coordinate system nobody needs.
 * Intensity is a share of the largest single cell — see `categoryHeatmap` for
 * why not per row — and the figure is written into each cell rather than left
 * to a tooltip, because on a phone there is no hover.
 */
export function CategoryHeatmap({
  grid,
  figures = true,
  onPick,
}: {
  grid: Heatmap
  /**
   * Where a cell goes when pressed: one category, one month — the narrowest
   * figure anywhere on the page, and so the one where "which transactions?" has
   * the most exact answer.
   */
  onPick?: (categoryId: string, month: string) => void
  /**
   * Whether each cell carries its amount.
   *
   * On by default, and for a reason worth keeping: on a phone there is no
   * hover, so a wall of colour with no figures answers nothing. Turning them
   * off is for the other end — twenty categories across twelve months, where
   * the numbers are too small to read anyway and the pattern is the point.
   */
  figures?: boolean
}) {
  const { money } = useApp()
  if (grid.rows.length === 0) return null

  return (
    <div className="overflow-x-auto overscroll-x-contain">
      <div
        className="grid min-w-[34rem] gap-px text-xs"
        style={{ gridTemplateColumns: `minmax(7rem, 1fr) repeat(${grid.months.length}, minmax(3.5rem, 1fr))` }}
      >
        <span />
        {grid.months.map((m) => (
          <span key={m} className="pb-1 text-center font-medium text-ink-3">
            {monthLabel(m, 'short')}
            {/* The last column is usually a part-month, and reading ALONG a row
                is the whole point of this — an unmarked short column reads as
                the drift finally stopping. */}
            {m === thisMonthKey() && <span className="block text-[0.65rem] font-normal opacity-70">so far</span>}
          </span>
        ))}

        {grid.rows.map((row) => (
          <Fragment key={row.categoryId}>
            <span className="flex items-center gap-1.5 truncate pr-2 text-ink-2">
              <span className="shrink-0" style={{ color: paintOf(row.slot, row.color) }}>
                <CategoryIcon icon={row.icon} size={13} />
              </span>
              <span className="truncate">{row.name}</span>
            </span>
            {row.cells.map((value, i) => (
              <span
                key={grid.months[i]}
                title={`${row.name} · ${monthLabel(grid.months[i])} · ${money(value)}${
                  grid.months[i] === thisMonthKey() ? ' (so far)' : ''
                }`}
                // An empty cell has nothing behind it, so it stays inert rather
                // than opening a list of no transactions.
                onClick={onPick && value > 0 ? () => onPick(row.categoryId, grid.months[i]) : undefined}
                className={cx(
                  'grid place-items-center rounded tabular',
                  onPick && value > 0 && 'cursor-pointer hover:ring-1 hover:ring-accent/40',
                  // The same height with the figures off, so turning them off
                  // is a change of density rather than of layout.
                  figures ? 'py-1.5' : 'py-3',
                  value > 0 ? 'text-ink' : 'text-ink-3/40',
                  grid.months[i] === thisMonthKey() && 'opacity-60',
                )}
                style={{
                  background:
                    value > 0 && grid.peakMinor > 0
                      ? `color-mix(in oklab, ${paintOf(row.slot, row.color)} ${Math.round(
                          // A floor of 8%: a real but small figure must not be
                          // indistinguishable from an empty month.
                          8 + (value / grid.peakMinor) * 62,
                        )}%, transparent)`
                      : undefined,
                }}
              >
                {!figures ? '' : value > 0 ? money(value, { compact: true, hideDecimals: true }) : '·'}
              </span>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

/* ---------- 7. Pace ---------- */

/**
 * Spend-to-date against the same point last month.
 *
 * Last month is drawn as a dashed reference behind this month's solid line, so
 * "are we ahead" is a question about which line is higher at today's date
 * rather than about reading two numbers off an axis.
 */
export function PaceLine({
  points,
  month,
  height = 220,
}: {
  points: PacePoint[]
  month: string
  height?: number
}) {
  const c = useChartColors()
  const { money } = useApp()
  const previous = points.some((p) => p.lastMonthMinor)
  /**
   * The ending a tap does not have.
   *
   * These five were written against hover and never got the linger the
   * scrolling charts and the ring have: on a touch screen the panel opened and
   * then sat over the chart until something unrelated closed it. Reported on an
   * iPad, but it was never about the size of the screen — every touch device
   * had it. The same hook, so the same press means the same thing on every
   * chart in the app.
   */
  const tip = useTouchTooltip()

  return (
    <div {...tip.handlers}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={points} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={{ stroke: c.baseline }}
          tick={{ fill: c.ink3, fontSize: 12 }}
          ticks={[1, 5, 10, 15, 20, 25, 31]}
          dy={4}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fill: c.ink3, fontSize: 12 }}
          tickFormatter={(v: number) => money(v, { compact: true, hideDecimals: true })}
          width={54}
        />
        <Tooltip
          active={tip.active}
          cursor={{ stroke: c.ink3, strokeOpacity: 0.3 }}
          content={({ active, payload }) => {
            const row = active ? (payload?.[0]?.payload as PacePoint | undefined) : undefined
            if (!row) return null
            return (
              <Tip
                fading={tip.fading}
                label={`Day ${row.day}`}
                rows={[
                  ...(row.thisMonthMinor !== null
                    ? [{ name: monthLabel(month), value: money(row.thisMonthMinor), color: c.accent }]
                    : []),
                  ...(row.lastMonthMinor !== null
                    ? [{ name: 'The month before', value: money(row.lastMonthMinor), color: c.ink3 }]
                    : []),
                ]}
              />
            )
          }}
        />
        {previous && (
          <Line
            type="monotone"
            dataKey="lastMonthMinor"
            stroke={c.ink3}
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
          />
        )}
        {/* Stops at today rather than running flat to the 31st: a flat tail
            reads as three weeks of spending nothing. */}
        <Line
          type="monotone"
          dataKey="thisMonthMinor"
          stroke={c.accent}
          strokeWidth={2.5}
          dot={false}
          connectNulls={false}
        />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ---------- shared ---------- */

function Legend({
  items,
  partial,
}: {
  items: { name: string; colour: string }[]
  partial?: boolean
}) {
  return (
    <div className="mt-1 flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm text-ink-2">
      {items.map((i) => (
        <span key={i.name} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ background: i.colour }} /> {i.name}
        </span>
      ))}
      {partial && <span className="text-ink-3">Faded = this month so far</span>}
    </div>
  )
}

/* ---------- 9. Who paid in ---------- */

export interface PaidInRow {
  key: string
  name: string
  /** Moved into a joint account. */
  movedMinor: number
  /** Bought for the household straight off a personal card. */
  boughtMinor: number
  count: number
  /** The palette slot the person wears — the same one the flow diagram uses. */
  slot: number
  /** Not a person: outside income, or an arrival with no name on it. */
  muted?: boolean
}

export const PAID_IN_SHAPES = [
  { value: 'bars', label: 'Bars' },
  { value: 'split', label: 'Shares' },
  { value: 'table', label: 'Table' },
]

/**
 * What each of us put into the household, and HOW.
 *
 * The two halves are the point of the card. Money moved across is a decision —
 * a figure we agreed, arriving every month; money spent off a personal card is
 * an accident of which card was in the wallet, and it is the half that quietly
 * turns into somebody being owed. The household book could always say £3,934
 * came in and never which of those it was, and the only route to the breakdown
 * was hovering one band of the flow diagram.
 *
 * One row per person, two segments each: the solid part is moved, the lighter
 * step of the SAME hue is bought. A different hue would read as a third person.
 */
export function PaidIn({
  rows,
  totalMinor,
  shape = 'bars',
  onPick,
}: {
  rows: PaidInRow[]
  /** What the bars are a share of — money in, so the bars are comparable. */
  totalMinor: number
  shape?: string
  /** Where a person goes when pressed. Rows are inert without it. */
  onPick?: (row: PaidInRow) => void
}) {
  const { money } = useApp()
  const c = useChartColors()
  if (rows.length === 0) return null

  const paint = (r: PaidInRow) => (r.muted ? c.ink3 : c.slot(r.slot))
  const soft = (r: PaidInRow) => `color-mix(in oklab, ${paint(r)} 45%, var(--surface))`
  const total = Math.max(1, totalMinor)

  if (shape === 'table') {
    return (
      <ScrollTable minWidth={420}>
        <thead>
          <tr className={table.head}>
            <th className={cx(table.th, table.pinned)}>Who</th>
            <th className={cx(table.th, 'text-right')}>Moved across</th>
            <th className={cx(table.th, 'text-right')}>Bought for us</th>
            <th className={cx(table.th, 'text-right')}>Total</th>
            <th className={cx(table.th, 'text-right')}>Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sum = r.movedMinor + r.boughtMinor
            return (
              <tr
                key={r.key}
                className={cx(table.row, onPick && 'cursor-pointer')}
                onClick={onPick ? () => onPick(r) : undefined}
              >
                <td className={cx(table.cell, table.pinned)}>
                  <span className="inline-flex items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: paint(r) }} />
                    {r.name}
                  </span>
                </td>
                <td className={cx(table.cell, 'text-right tabular')}>
                  {r.movedMinor > 0 ? money(r.movedMinor) : <span className="text-ink-3">—</span>}
                </td>
                <td className={cx(table.cell, 'text-right tabular')}>
                  {r.boughtMinor > 0 ? money(r.boughtMinor) : <span className="text-ink-3">—</span>}
                </td>
                <td className={cx(table.cell, 'text-right font-semibold tabular')}>{money(sum)}</td>
                <td className={cx(table.cell, 'text-right text-ink-3 tabular')}>
                  {Math.round((sum / total) * 100)}%
                </td>
              </tr>
            )
          })}
        </tbody>
      </ScrollTable>
    )
  }

  // "Shares" is one stacked bar rather than one per person: the question there
  // is what proportion of the household's money each of us put in, and separate
  // bars answer "how much" and leave you to do the division.
  if (shape === 'split') {
    return (
      <div>
        <div className="flex h-4 gap-0.5 overflow-hidden rounded-full bg-surface-2">
          {rows.flatMap((r) =>
            [
              { id: `${r.key}:moved`, value: r.movedMinor, fill: paint(r) },
              { id: `${r.key}:bought`, value: r.boughtMinor, fill: soft(r) },
            ]
              .filter((part) => part.value > 0)
              .map((part) => (
                <button
                  key={part.id}
                  type="button"
                  title={`${r.name} — ${money(part.value)}`}
                  onClick={onPick ? () => onPick(r) : undefined}
                  className="rounded-full"
                  style={{ width: `${(part.value / total) * 100}%`, background: part.fill }}
                />
              )),
          )}
        </div>
        <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-1.5 text-xs">
              <span className="size-2 shrink-0 rounded-full" style={{ background: paint(r) }} />
              <span className="text-ink-2">{r.name}</span>
              <span className="font-medium tabular">{money(r.movedMinor + r.boughtMinor)}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const peak = rows.reduce((m, r) => Math.max(m, r.movedMinor + r.boughtMinor), 0)
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const sum = r.movedMinor + r.boughtMinor
        const width = peak > 0 ? (sum / peak) * 100 : 0
        return (
          <li key={r.key}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">{r.name}</span>
              <span className="shrink-0 text-sm font-semibold tabular">{money(sum)}</span>
            </div>
            <button
              type="button"
              disabled={!onPick}
              onClick={onPick ? () => onPick(r) : undefined}
              aria-label={`${r.name}, ${money(sum)}`}
              className={cx('mt-1 flex h-3 w-full gap-0.5 rounded-full', onPick && 'cursor-pointer')}
            >
              <span
                className="h-full rounded-full"
                style={{ width: `${width * (sum > 0 ? r.movedMinor / sum : 0)}%`, background: paint(r) }}
              />
              <span
                className="h-full rounded-full"
                style={{ width: `${width * (sum > 0 ? r.boughtMinor / sum : 0)}%`, background: soft(r) }}
              />
            </button>
            {/* The breakdown in words, because the lighter segment on a thin bar
                is the one thing nobody will read off the picture. */}
            <p className="mt-1 text-xs text-ink-3">
              {r.boughtMinor > 0 && r.movedMinor > 0
                ? `${money(r.movedMinor)} moved · ${money(r.boughtMinor)} bought for us`
                : r.boughtMinor > 0
                  ? `all of it bought for us, off a personal card`
                  : `moved across`}
              {r.count > 0 && ` · ${r.count} ${r.count === 1 ? 'payment' : 'payments'}`}
            </p>
          </li>
        )
      })}
    </ul>
  )
}

/* ---------- 10. How the books add up ---------- */

export interface BridgeLine {
  key: string
  label: string
  /** Undefined where the column has nothing to say on this line. */
  household?: number
  mine?: number
  all?: number
  /** A line that is subtracted rather than added — shown in brackets. */
  negative?: boolean
  /** The bottom line, which is the one that always reconciles. */
  total?: boolean
}

// The table is the default here, and deliberately: the whole point of this
// card is the arithmetic, and a bar chart of a reconciliation is a picture of
// numbers you then have to go and read anyway. The bars are the alternative for
// somebody who wants the shape of it at a glance.
export const BRIDGE_SHAPES = [
  { value: 'table', label: 'Table' },
  { value: 'bars', label: 'Bars' },
]

/**
 * The three sets of books side by side, and the lines that reconcile them.
 *
 * It does not ASSERT that the numbers match — it shows the arithmetic,
 * including the lines that do not add up and why. Everything up to now has been
 * a figure you were asked to trust; this is the working.
 */
export function BooksBridge({
  lines,
  shape = 'table',
  partner,
  onPick,
}: {
  lines: BridgeLine[]
  shape?: string
  partner?: string
  onPick?: (line: BridgeLine, book: 'household' | 'mine' | 'all') => void
}) {
  const { money } = useApp()
  const c = useChartColors()
  const cell = (v: number | undefined, negative?: boolean) =>
    v === undefined ? <span className="text-ink-3">—</span> : negative ? `(${money(v)})` : money(v)

  if (shape === 'bars') {
    // Every line as a trio of bars on one scale, so "spending adds up and
    // income does not" is something you can SEE rather than something you have
    // to subtract in your head.
    const peak = Math.max(1, ...lines.flatMap((l) => [l.household ?? 0, l.mine ?? 0, l.all ?? 0]))
    const books = [
      { key: 'household' as const, name: 'Ours', fill: c.slot(1) },
      { key: 'mine' as const, name: 'Mine', fill: c.slot(2) },
      { key: 'all' as const, name: 'Everything', fill: c.ink2 },
    ]
    return (
      <div className="space-y-3">
        {lines.map((line) => (
          <div key={line.key}>
            <p className={cx('text-xs', line.total ? 'font-semibold text-ink' : 'text-ink-2')}>{line.label}</p>
            <div className="mt-1 space-y-1">
              {books.map((b) => {
                const v = line[b.key]
                if (v === undefined) return null
                return (
                  <button
                    key={b.key}
                    type="button"
                    disabled={!onPick}
                    onClick={onPick ? () => onPick(line, b.key) : undefined}
                    className="flex w-full items-center gap-2 text-left"
                  >
                    <span className="w-16 shrink-0 text-[0.6875rem] text-ink-3">{b.name}</span>
                    <span className="h-2.5 min-w-0 flex-1 rounded-full bg-surface-2">
                      <span
                        className="block h-full rounded-full"
                        style={{ width: `${(Math.abs(v) / peak) * 100}%`, background: b.fill }}
                      />
                    </span>
                    <span className="w-24 shrink-0 text-right text-xs tabular">{cell(v, line.negative)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <ScrollTable minWidth={460}>
      <thead>
        <tr className={table.head}>
          <th className={cx(table.th, table.pinned)}></th>
          <th className={cx(table.th, 'text-right')}>Ours</th>
          <th className={cx(table.th, 'text-right')}>{partner ? 'Mine' : 'Mine'}</th>
          <th className={cx(table.th, 'text-right')}>Everything</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.key} className={cx(table.row, line.total && 'font-semibold')}>
            <td className={cx(table.cell, table.pinned, !line.total && 'text-ink-2')}>{line.label}</td>
            {(['household', 'mine', 'all'] as const).map((book) => (
              <td
                key={book}
                className={cx(
                  table.cell,
                  'text-right tabular',
                  line.negative && 'text-ink-3',
                  onPick && line[book] !== undefined && 'cursor-pointer',
                )}
                onClick={onPick && line[book] !== undefined ? () => onPick(line, book) : undefined}
              >
                {cell(line[book], line.negative)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </ScrollTable>
  )
}

/* ---------- 11. Spending, split by book ---------- */

/**
 * One bar per category, each split into the household's part and the personal
 * one.
 *
 * Everything only — it is the one book that contains both, and under the other
 * two the answer is the whole bar in one colour. Bars rather than a ring or
 * blocks, because a split arc is unreadable and a split tile is two tiles.
 *
 * The two segments may sum to LESS than the figure beside them: a published row
 * from an account this device does not hold is the household's spending and is
 * in no account here. That is the same line the bridge card names, and it is
 * why the total comes from `bookSpendByCategory` rather than from adding the
 * halves — see `bookSplitByCategory`.
 */
export function CategorySplitBars({
  slices,
  partner,
  onPick,
}: {
  slices: SplitSlice[]
  partner?: string
  onPick?: (slice: SplitSlice) => void
}) {
  const { money } = useApp()
  const c = useChartColors()
  const peak = slices.reduce((m, s) => Math.max(m, s.totalMinor), 0)
  if (slices.length === 0) return null

  const ours = c.slot(1)
  const mine = c.slot(2)

  return (
    <div>
      <ul className="space-y-2">
        {slices.map((s) => {
          const width = peak > 0 ? (s.totalMinor / peak) * 100 : 0
          const known = s.householdMinor + s.mineMinor
          return (
            <li key={s.categoryId}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0" style={{ color: paintOf(s.slot, s.color) }}>
                    <CategoryIcon icon={s.icon} size={13} />
                  </span>
                  <span className="truncate text-sm">{s.name}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular">{money(s.totalMinor)}</span>
              </div>
              <button
                type="button"
                disabled={!onPick}
                onClick={onPick ? () => onPick(s) : undefined}
                aria-label={`${s.name}, ${money(s.totalMinor)}`}
                className={cx('mt-1 flex h-3 w-full gap-0.5 rounded-full', onPick && 'cursor-pointer')}
              >
                <span
                  className="h-full rounded-full"
                  style={{ width: `${known > 0 ? width * (s.householdMinor / known) : 0}%`, background: ours }}
                />
                <span
                  className="h-full rounded-full"
                  style={{ width: `${known > 0 ? width * (s.mineMinor / known) : 0}%`, background: mine }}
                />
              </button>
            </li>
          )
        })}
      </ul>
      <Legend
        items={[
          { name: 'Our household', colour: ours },
          { name: partner ? 'Mine' : 'Mine', colour: mine },
        ]}
      />
    </div>
  )
}
