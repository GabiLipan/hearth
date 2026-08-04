import { useId } from 'react'

/**
 * Six months of budget adherence as a running total.
 *
 * The line is the cumulative sum of overspend minus underspend, so it starts at
 * zero and ends where the half-year actually stands. Every step uses the budget
 * that was in force for that month, which is why the reference is a flat zero
 * rather than a budget line — there is no single budget to draw, and pretending
 * otherwise was the bug this replaced.
 *
 * The line itself stays neutral: the *fill* carries the sign, clipped at the
 * zero crossings, so a category that ran over in spring and clawed it back
 * shows both a red bulge and a green tail instead of one misleading colour.
 */
export function Drift({
  values,
  budgets,
  inferred,
  provisionalLast = false,
  width = 96,
  height = 22,
  className,
}: {
  /** Spend per month, oldest first. */
  values: number[]
  /** The budget in force for each of those months. */
  budgets: number[]
  /** Where that budget was assumed rather than set — drawn lighter. */
  inferred?: boolean[]
  /** The last month is still running, so its point is drawn dashed and hollow. */
  provisionalLast?: boolean
  width?: number
  height?: number
  className?: string
}) {
  const clipId = useId()
  if (values.length === 0) return null

  let running = 0
  const drift = values.map((v, i) => (running += v - (budgets[i] ?? 0)))
  const scale = Math.max(...drift.map(Math.abs), 1) * 1.2
  const mid = height / 2
  // n months means n+1 points: the origin sits at zero, before the first month.
  const step = width / values.length
  const x = (i: number) => i * step
  const y = (v: number) => mid - (v / scale) * (mid - 1)
  const points = [{ x: 0, y: mid }, ...drift.map((v, i) => ({ x: x(i + 1), y: y(v) }))]
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('')
  const area = `${path}L${width} ${mid}L0 ${mid}Z`
  const end = drift[drift.length - 1]
  const over = end > 0

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={`Cumulative spending against budget over ${values.length} months`}
    >
      <defs>
        <clipPath id={`${clipId}-up`}>
          <rect x="0" y="0" width={width} height={mid} />
        </clipPath>
        <clipPath id={`${clipId}-down`}>
          <rect x="0" y={mid} width={width} height={height - mid} />
        </clipPath>
      </defs>
      <path d={area} fill="var(--critical)" opacity={0.16} clipPath={`url(#${clipId}-up)`} />
      <path d={area} fill="var(--good)" opacity={0.16} clipPath={`url(#${clipId}-down)`} />
      <line x1="0" y1={mid} x2={width} y2={mid} stroke="var(--ink-3)" strokeWidth="1" opacity={0.4} strokeDasharray="2 2" />
      {points.slice(1).map((p, i) => {
        const prev = points[i]
        const assumed = inferred?.[i] ?? false
        const provisional = provisionalLast && i === points.length - 2
        return (
          <line
            key={i}
            x1={prev.x}
            y1={prev.y}
            x2={p.x}
            y2={p.y}
            stroke="var(--ink-2)"
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity={assumed ? 0.4 : 0.9}
            strokeDasharray={provisional ? '2.5 2' : undefined}
          />
        )
      })}
      <circle
        cx={points[points.length - 1].x - 1.5}
        cy={points[points.length - 1].y}
        r={2.4}
        fill={provisionalLast ? 'var(--surface)' : over ? 'var(--critical)' : 'var(--good)'}
        stroke={over ? 'var(--critical)' : 'var(--good)'}
        strokeWidth={provisionalLast ? 1.2 : 0}
      />
    </svg>
  )
}
