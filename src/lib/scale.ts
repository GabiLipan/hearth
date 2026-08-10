/**
 * A value axis with round numbers on it.
 *
 * Recharts will pick its own domain and ticks, and does it well — but only for
 * a chart that owns its own axis. A chart that SCROLLS cannot: the axis has to
 * stay behind while the bars move, which means it is drawn separately, and two
 * axes agree only if both are told the same numbers. So the domain and the
 * ticks are computed once, here, and handed to both.
 *
 * The steps are the ones people read money in — 1, 2, 2.5 and 5 times a power
 * of ten — so the labels come out as £200, £500, £2,500 rather than £237.
 */
export interface Scale {
  min: number
  max: number
  ticks: number[]
}

const STEPS = [1, 2, 2.5, 5, 10]

/** The smallest of those steps that gets from `rough` to a round number. */
function niceStep(rough: number): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalised = rough / magnitude
  return (STEPS.find((s) => normalised <= s) ?? 10) * magnitude
}

/**
 * A domain covering `min`..`max`, on round ticks, with roughly `count` of them.
 *
 * Zero is always included. A money chart whose axis starts at £3,100 makes a
 * £200 difference look like a collapse, which is the one misreading a chart
 * must not invite — so the floor is zero unless something is genuinely
 * negative, and then zero is a tick in the middle rather than an edge.
 */
export function niceScale(min: number, max: number, count = 4): Scale {
  const lo = Math.min(0, min)
  const hi = Math.max(0, max)
  // Everything is zero: one tick either side, so the baseline is not the only
  // line on the chart.
  if (lo === 0 && hi === 0) return { min: 0, max: 1, ticks: [0, 1] }

  const step = niceStep((hi - lo) / Math.max(1, count))
  const top = Math.ceil(hi / step) * step
  const bottom = Math.floor(lo / step) * step

  const ticks: number[] = []
  // Counted rather than accumulated: adding a float step repeatedly drifts, and
  // a tick at 1999.9999999 formats as £2,000 and lands a pixel off the line.
  const n = Math.round((top - bottom) / step)
  for (let i = 0; i <= n; i++) ticks.push(Math.round(bottom + i * step))
  return { min: Math.round(bottom), max: Math.round(top), ticks }
}
