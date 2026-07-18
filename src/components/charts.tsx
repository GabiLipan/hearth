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
  ReferenceLine,
} from 'recharts'
import { useChartColors } from '../hooks/useChartColors'
import { useApp } from '../state/AppContext'
import { OTHER_SLICE_ID, type CategorySlice, type MonthPoint } from '../lib/stats'

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
}: {
  active?: boolean
  label?: string
  rows: TipRow[]
}) {
  const { money } = useApp()
  if (!active || rows.length === 0) return null
  return (
    <div className="rounded-xl bg-surface px-3 py-2 text-sm shadow-lg ring-1 ring-hairline">
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

/* ---------- Monthly spending bars ---------- */
export function SpendBars({ data, height = 220 }: { data: MonthPoint[]; height?: number }) {
  const c = useChartColors()
  const { money } = useApp()
  return (
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
          content={({ active, payload, label }) => (
            <ChartTip
              active={active}
              label={String(label ?? '')}
              rows={(payload ?? []).map((p) => ({ name: 'Spent', value: Number(p.value), color: c.series[0] }))}
            />
          )}
        />
        <Bar dataKey="spend" fill={c.series[0]} radius={[4, 4, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ---------- Income vs spending (two entities, fixed colors) ---------- */
export function IncomeSpendBars({ data, height = 240 }: { data: MonthPoint[]; height?: number }) {
  const c = useChartColors()
  const { money } = useApp()
  const income = c.series[1] // aqua — income everywhere in the app
  const spend = c.series[0] // blue — spending everywhere in the app
  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }} barCategoryGap="30%" barGap={2}>
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
          <Bar dataKey="income" fill={income} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Bar dataKey="spend" fill={spend} radius={[4, 4, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-1 flex justify-center gap-5 text-sm text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ background: income }} /> Income
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ background: spend }} /> Spending
        </span>
      </div>
    </div>
  )
}

/* ---------- Net cashflow line ---------- */
export function NetLine({ data, height = 220 }: { data: MonthPoint[]; height?: number }) {
  const c = useChartColors()
  const { money } = useApp()
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
        <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: c.baseline }} tick={{ fill: c.ink3, fontSize: 12 }} dy={4} />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fill: c.ink3, fontSize: 12 }}
          tickFormatter={(v: number) => money(v, { compact: true, hideDecimals: true })}
          width={58}
        />
        <ReferenceLine y={0} stroke={c.baseline} strokeWidth={1} />
        <Tooltip
          cursor={{ stroke: c.ink3, strokeOpacity: 0.3 }}
          content={({ active, payload, label }) => (
            <ChartTip
              active={active}
              label={String(label ?? '')}
              rows={(payload ?? []).map((p) => ({ name: 'Net', value: Number(p.value), color: c.series[4] }))}
            />
          )}
        />
        <Line
          type="monotone"
          dataKey="net"
          stroke={c.series[4]}
          strokeWidth={2}
          dot={{ r: 3, fill: c.series[4], strokeWidth: 2, stroke: c.surface }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: c.surface }}
        />
      </LineChart>
    </ResponsiveContainer>
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
  const otherColor = c.ink3
  const colorOf = (s: CategorySlice) => (s.categoryId === OTHER_SLICE_ID ? otherColor : c.slot(s.slot))
  return (
    <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,220px)_1fr]">
      <div className="relative mx-auto w-full max-w-[220px]" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="totalMinor"
              nameKey="name"
              innerRadius="68%"
              outerRadius="96%"
              paddingAngle={2}
              strokeWidth={2}
              stroke={c.surface}
            >
              {slices.map((s) => (
                <Cell key={s.categoryId} fill={colorOf(s)} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                const p = payload?.[0]
                const s = p?.payload as CategorySlice | undefined
                return (
                  <ChartTip
                    active={active}
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
      <ul className="space-y-1.5">
        {slices.map((s) => (
          <li key={s.categoryId} className="flex items-center gap-2.5 text-sm">
            <span className="size-3 shrink-0 rounded-[4px]" style={{ background: colorOf(s) }} />
            <span className="truncate text-ink-2">{s.name}</span>
            <span className="ml-auto font-medium text-ink tabular">{money(s.totalMinor)}</span>
            <span className="w-10 text-right text-xs text-ink-3 tabular">{Math.round(s.fraction * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
