import { cx } from './ui'

/**
 * Spend against budget, in Stephen Few's bullet layout.
 *
 * A plain progress bar answers "how far through the budget am I" and nothing
 * else. The bullet adds the two things you actually want next to that: the
 * budget as a *tick* rather than the end of the track, so overspending has
 * somewhere to go, and the range this category normally spends in as a band
 * behind the bar, so "£240" reads as high or low without you remembering.
 *
 * Track = the scale. Pale block = typical range. Bar = spent. Tick = budget.
 */
export function BudgetBullet({
  spent,
  budget,
  typical,
  pace,
  color,
  label,
  className,
}: {
  spent: number
  budget: number
  /** [low, high] of recent months' spending, for the context band. */
  typical?: [number, number]
  /**
   * How far through the month we are, 0–1. Draws a faint second tick at the
   * spend you would be at if the budget were spread evenly — the "on track to
   * date" mark the home page has always shown.
   */
  pace?: number
  /** The category's colour; falls back to the accent. */
  color?: string
  /** Read out to screen readers in place of the visual. */
  label: string
  className?: string
}) {
  // Headroom past the largest mark, so the budget tick never sits on the edge
  // and an overspend is visibly past it rather than clamped to full.
  const scale = Math.max(spent, budget, typical?.[1] ?? 0) * 1.15 || 1
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`
  const over = spent > budget

  return (
    <div
      className={cx('relative h-2.5 w-full rounded-full bg-surface-2 md:h-2', className)}
      role="img"
      aria-label={label}
    >
      {typical && (
        <div
          className="absolute inset-y-0 rounded-full bg-ink-3/40"
          style={{ left: pct(typical[0]), width: pct(Math.max(0, typical[1] - typical[0])) }}
        />
      )}
      {/* Thin, so the band behind it stays readable: spending usually lands near
          the top of the typical range, and a fat bar simply covers it. */}
      <div
        className="absolute inset-y-[32%] left-0 rounded-full transition-[width] duration-500"
        style={{ width: pct(spent), background: over ? 'var(--critical)' : color ?? 'var(--accent)' }}
      />
      {pace != null && pace < 1 && (
        <div
          className="absolute inset-y-0 w-px -translate-x-1/2 bg-ink-3/60"
          style={{ left: pct(budget * pace) }}
          aria-hidden
        />
      )}
      <div
        className="absolute -inset-y-px w-[1.5px] -translate-x-1/2 rounded-full"
        style={{ left: pct(budget), background: 'var(--ink)' }}
      />
    </div>
  )
}
