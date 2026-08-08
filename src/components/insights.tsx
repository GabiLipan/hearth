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
import { useApp } from '../state/AppContext'
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
import { cx } from './ui'

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

/** Matches `ChartTip` in charts.tsx — the same panel, wherever a tooltip appears. */
function Tip({ label, rows }: { label?: string; rows: { name: string; value: string; color?: string }[] }) {
  return (
    <div className="rounded-xl bg-surface px-3 py-2 text-sm shadow-lg ring-1 ring-hairline">
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
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={{ stroke: c.baseline }}
          tick={{ fill: c.ink3, fontSize: 11 }}
          dy={4}
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
          cursor={{ fill: c.ink3, fillOpacity: 0.08 }}
          content={({ active, payload }) => {
            const s = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined
            if (!s) return null
            return (
              <Tip
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
        <Bar dataKey="size" stackId="w" radius={[4, 4, 0, 0]} maxBarSize={56}>
          {data.map((s) => (
            <Cell key={s.key} fill={colourOf(s)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ---------- 2. What a salary turned into ---------- */

export function SalaryStack({ data, height = 240 }: { data: SalaryBar[]; height?: number }) {
  const c = useChartColors()
  const { money } = useApp()
  const parts = [
    { key: 'contributedMinor' as const, name: 'To the household', colour: c.series[1] },
    { key: 'spentMinor' as const, name: 'Spent on me', colour: c.series[0] },
    { key: 'leftMinor' as const, name: 'Left with me', colour: c.series[2] },
  ]

  return (
    <div>
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
            cursor={{ fill: c.ink3, fillOpacity: 0.08 }}
            content={({ active, payload, label }) => {
              const row = active ? (payload?.[0]?.payload as SalaryBar | undefined) : undefined
              if (!row) return null
              return (
                <Tip
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
            <Bar key={p.key} dataKey={p.key} stackId="s" fill={p.colour} maxBarSize={40}>
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
  const parts = [
    { key: 'fixedMinor' as const, name: 'Tracked bills', colour: c.series[3] },
    { key: 'variableMinor' as const, name: 'Everything else', colour: c.series[0] },
  ]

  return (
    <div>
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
            cursor={{ fill: c.ink3, fillOpacity: 0.08 }}
            content={({ active, payload, label }) => {
              const row = active ? (payload?.[0]?.payload as FixedVariable | undefined) : undefined
              if (!row) return null
              const total = row.fixedMinor + row.variableMinor
              return (
                <Tip
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
            <Bar key={p.key} dataKey={p.key} stackId="f" fill={p.colour} maxBarSize={40}>
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

  return (
    <div>
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
          cursor={{ stroke: c.ink3, strokeOpacity: 0.3 }}
          content={({ active, payload, label }) => {
            const row = active ? (payload?.[0]?.payload as SavingsRatePoint | undefined) : undefined
            if (!row) return null
            return (
              <Tip
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
export function TopPayees({ rows }: { rows: PayeeTotal[] }) {
  const { money } = useApp()
  const peak = rows.reduce((m, r) => Math.max(m, r.totalMinor), 0)
  if (rows.length === 0) return null

  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.payee} className="relative overflow-hidden rounded-lg">
          {/* The bar is behind the text rather than beside it: at ten rows the
              two-column version leaves the names in a narrow gutter. */}
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 rounded-lg"
            style={{
              width: `${peak > 0 ? Math.max(2, (r.totalMinor / peak) * 100) : 0}%`,
              background: `color-mix(in oklab, var(--series-${r.slot}) 20%, transparent)`,
            }}
          />
          <div className="relative flex items-center gap-2 px-2.5 py-1.5">
            <span className="shrink-0" style={{ color: `var(--series-${r.slot})` }}>
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
export function CategoryHeatmap({ grid }: { grid: Heatmap }) {
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
              <span className="shrink-0" style={{ color: `var(--series-${row.slot})` }}>
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
                className={cx(
                  'grid place-items-center rounded py-1.5 tabular',
                  value > 0 ? 'text-ink' : 'text-ink-3/40',
                  grid.months[i] === thisMonthKey() && 'opacity-60',
                )}
                style={{
                  background:
                    value > 0 && grid.peakMinor > 0
                      ? `color-mix(in oklab, var(--series-${row.slot}) ${Math.round(
                          // A floor of 8%: a real but small figure must not be
                          // indistinguishable from an empty month.
                          8 + (value / grid.peakMinor) * 62,
                        )}%, transparent)`
                      : undefined,
                }}
              >
                {value > 0 ? money(value, { compact: true, hideDecimals: true }) : '·'}
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

  return (
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
          cursor={{ stroke: c.ink3, strokeOpacity: 0.3 }}
          content={({ active, payload }) => {
            const row = active ? (payload?.[0]?.payload as PacePoint | undefined) : undefined
            if (!row) return null
            return (
              <Tip
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
