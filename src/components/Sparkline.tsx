/**
 * Six months of spending against the budget line, at a glance.
 *
 * Deliberately unlabelled: it answers "is this month unusual?" and nothing
 * else. The budget line is what turns the shape into a judgement — bars over
 * the line are months you went past it.
 */
export function Sparkline({
  values,
  budget,
  width = 96,
  height = 22,
  className,
}: {
  values: number[]
  /** Draws a reference line, when there is a budget to compare against. */
  budget?: number
  width?: number
  height?: number
  className?: string
}) {
  if (values.length === 0) return null
  const ceiling = Math.max(...values, budget ?? 0, 1)
  const gap = 2
  const barWidth = (width - gap * (values.length - 1)) / values.length
  const budgetY = budget ? height - (budget / ceiling) * height : null

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={`Spending over the last ${values.length} months`}
    >
      {values.map((v, i) => {
        const h = Math.max(1, (v / ceiling) * height)
        const over = budget != null && v > budget
        return (
          <rect
            key={i}
            x={i * (barWidth + gap)}
            y={height - h}
            width={barWidth}
            height={h}
            rx={1.5}
            // The last bar is the month being edited, so it reads as "now".
            fill={over ? 'var(--critical)' : 'var(--ink-3)'}
            opacity={i === values.length - 1 ? 0.95 : 0.4}
          />
        )
      })}
      {budgetY != null && (
        <line x1="0" y1={budgetY} x2={width} y2={budgetY} stroke="var(--accent)" strokeWidth="1" strokeDasharray="2 2" />
      )}
    </svg>
  )
}
