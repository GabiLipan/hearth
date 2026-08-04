/**
 * Six months against budget, one bar per month.
 *
 * Bars grow from a zero line at the middle: down for under budget, up for over,
 * sized by the percentage off rather than the pounds, so every row in the table
 * is on the same scale and the column can be read straight down. A quiet month
 * is a small bar whatever the category costs.
 *
 * Colour carries severity on its own: green under budget, then yellow the
 * moment you cross it, deepening to red by 20% over and staying there. The
 * height says how far off, the colour says how much that matters.
 *
 * Two earlier attempts at this column failed and are worth not repeating. A
 * single budget line across all six months compared every month against the
 * one you happened to be viewing. A cumulative drift line then scaled to its
 * own maximum — and since a run of under-budget months only ever grows in one
 * direction, every category drew the same downward ramp.
 */

/**
 * The deviation that fills half the chart; beyond this a bar is clamped.
 *
 * Kept deliberately tight. Real months are mostly within 10% of budget, and at
 * a wider scale those render as a two-pixel slab that reads as a rule through
 * the middle rather than as a bar. Anything past a quarter off is emphatic
 * enough that the exact height has stopped carrying the message — the colour
 * has taken over by then.
 */
const FULL_SCALE = 0.25
/** Over budget by this much is fully red; the ramp from yellow runs up to it. */
const RAMP_TOP = 0.2

/**
 * Yellow at the moment of going over, red by `RAMP_TOP`.
 *
 * `color-mix` rather than interpolating hex ourselves, so the ramp is built
 * from the same `--warning` and `--critical` the rest of the app uses and
 * follows them into dark mode.
 */
function overColour(over: number) {
  const t = Math.round(Math.min(1, over / RAMP_TOP) * 100)
  return `color-mix(in srgb, var(--critical) ${t}%, var(--warning))`
}

export function BudgetBars({
  values,
  budgets,
  inferred,
  labels,
  width = 200,
  height = 32,
  className,
}: {
  /** Spend per month, oldest first. */
  values: number[]
  /** The budget in force for each of those months. */
  budgets: number[]
  /** Where that budget was assumed rather than set — drawn faded. */
  inferred?: boolean[]
  /** Per-bar hover text, e.g. "May · £412 of £450, 8% under". */
  labels?: string[]
  width?: number
  height?: number
  className?: string
}) {
  if (values.length === 0) return null
  const gap = 3
  const barWidth = (width - gap * (values.length - 1)) / values.length
  const mid = height / 2
  const reach = mid - 1

  const bars = values.map((spent, i) => {
    const budget = budgets[i] ?? 0
    if (budget <= 0) return null
    const off = (spent - budget) / budget
    const clamped = Math.max(-1, Math.min(1, off / FULL_SCALE))
    return { off, height: Math.max(1.5, Math.abs(clamped) * reach), faded: inferred?.[i] ?? false }
  })

  const over = bars.filter((b) => b && b.off > 0).length
  const counted = bars.filter(Boolean).length

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={
        counted === 0
          ? 'No budget history for this category'
          : `${counted} months against budget: ${over} over, ${counted - over} under`
      }
    >
      {values.map((_, i) => (
        <rect key={`t${i}`} x={i * (barWidth + gap)} y={0} width={barWidth} height={height} rx={3} fill="var(--surface-2)" />
      ))}
      <line x1={0} y1={mid} x2={width} y2={mid} stroke="var(--ink-3)" strokeWidth={1} opacity={0.35} />
      {bars.map((bar, i) =>
        bar === null ? null : (
          <rect
            key={i}
            x={i * (barWidth + gap)}
            y={bar.off > 0 ? mid - bar.height : mid}
            width={barWidth}
            height={bar.height}
            rx={1.5}
            fill={bar.off > 0 ? overColour(bar.off) : 'var(--good)'}
            opacity={bar.faded ? 0.4 : 0.9}
          >
            {labels?.[i] && <title>{labels[i]}</title>}
          </rect>
        ),
      )}
    </svg>
  )
}
