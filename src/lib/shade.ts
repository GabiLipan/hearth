/**
 * Telling apart two things the palette gave the same colour.
 *
 * There are twelve slots and no limit on categories, so a chart routinely holds
 * two slices of identical colour — "Groceries" and "Eating out" both landing on
 * green is the common case, and on a donut they become one indistinguishable
 * arc. `nextFreeSlot` spreads new categories out and cannot prevent this: it
 * only knows about the categories that existed when one was created, and a
 * subcategory inherits its parent's colour on purpose.
 *
 * So the second and later users of a slot are shifted in lightness. Not hue:
 * moving the hue makes a green look like a different category's colour, which
 * is worse than two greens — the palette's job is that Health is always the
 * same green everywhere, and this must not break that for the first user.
 *
 * The shift is applied per CHART, not stored. Two categories that share a slot
 * are only confusable while both are on screen; the same category keeps its
 * own colour on every other screen it appears on.
 */

/* ---------- colour space ---------- */

/**
 * A hex string to HSL. Recharts wants concrete colours rather than
 * `var(--series-3)`, so the values arrive here already resolved by
 * `useChartColors` — which means plain `#rrggbb` (or `#rgb`) is the only form
 * that has to be understood.
 */
export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const raw = m[1]
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw
  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: (h * 60 + 360) % 360, s, l }
}

export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x]
  const to = (n: number) =>
    Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/* ---------- the shift ---------- */

/**
 * How far apart two shades of one slot are placed, in lightness.
 *
 * Big enough to survive a 12px legend swatch and a thin donut arc — anything
 * under about 0.08 reads as the same colour with a rendering artefact — and
 * small enough that the family is still recognisably one colour.
 */
const STEP = 0.11

/**
 * Where a shade may not go.
 *
 * The palette is drawn on `--surface` in both themes, so a shade that walks too
 * far towards either end stops being legible against one of them.
 */
const MIN_L = 0.22
const MAX_L = 0.8

/**
 * The lightnesses available to one colour, in the order they get used.
 *
 * The obvious implementation — base ± STEP, ± 2·STEP, clamped — is wrong, and
 * wrong in the one way that matters: clamping gives two shades the SAME
 * lightness as soon as the fan reaches an edge, which is precisely the
 * collision this file exists to remove. Reflecting off the edge is no better;
 * it lands the reflected value next to one already used.
 *
 * So the ladder never leaves the range in the first place. It walks out from
 * the base in whole steps, taking only the rungs that fit, and when those run
 * out it goes back and halves the gaps — odd multiples of STEP/2, then STEP/4.
 * Every generation lands strictly between values the previous ones produced, so
 * no two rungs can coincide however dark or light the base is.
 *
 * The order does not depend on how many shades are wanted, which is what lets
 * `shade(hex, n)` and `distinctShades` agree without one telling the other how
 * many there will be.
 */
function ladder(base: number, wanted: number): number[] {
  const out: number[] = [base]
  const push = (l: number) => {
    if (l >= MIN_L && l <= MAX_L && out.length < wanted) out.push(l)
  }
  // Whole steps first, then halves, then quarters, then eighths. Four
  // generations is around 40 distinct rungs — far past any chart that has ever
  // put two of one colour on screen.
  for (let gen = 0; gen < 4 && out.length < wanted; gen++) {
    const step = STEP / 2 ** gen
    // Generation 0 takes every whole multiple; later ones take only the ODD
    // multiples of their step, which are exactly the gaps left behind.
    const stride = gen === 0 ? 1 : 2
    for (let i = gen === 0 ? 1 : 1; out.length < wanted && i <= 32; i += stride) {
      push(base + i * step)
      push(base - i * step)
    }
  }
  return out
}

/**
 * The nth distinct shade of one colour. `n = 0` is the colour untouched, which
 * matters: the commonest case is a slot used once, and it must come out exactly
 * as the palette defined it.
 */
export function shade(hex: string, n: number): string {
  if (n <= 0) return hex
  const hsl = hexToHsl(hex)
  if (!hsl) return hex

  const rungs = ladder(hsl.l, n + 1)
  // Only when the base is so close to an edge that the ladder cannot even
  // reach n rungs. Nothing in the palette is, but a hand-set colour could be.
  const l = rungs[n] ?? rungs[rungs.length - 1]

  // A colour reads as washed out as it moves away from mid-lightness unless it
  // is allowed a little more saturation to compensate.
  const s = Math.min(1, hsl.s * (1 + Math.abs(l - hsl.l)))
  return hslToHex(hsl.h, s, l)
}

/**
 * Colours for a list of things, shaded apart where they collide.
 *
 * Order matters and is the caller's: the FIRST item on a slot keeps the real
 * palette colour, so the biggest slice of a donut — the one the eye goes to and
 * the one most likely to be recognised from another screen — is never the one
 * that got shifted.
 *
 * `key` groups the items that must be told apart. Passing the resolved colour
 * itself is usually right, and is what makes this work for a subcategory that
 * inherits its parent's slot as well as for two unrelated categories that
 * happen to share one.
 */
export function distinctShades<T>(items: T[], colourOf: (item: T) => string): string[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = colourOf(item)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return shade(base, n)
  })
}
