/**
 * The category colour palette. A category stores a `slot` (1..SLOT_COUNT) which
 * resolves to the `--series-N` token, so every colour has a light and a dark
 * variant that stay legible in either theme — which a free-form hex picker
 * could not guarantee.
 */
export const SLOT_COUNT = 12

export const SLOTS = Array.from({ length: SLOT_COUNT }, (_, i) => i + 1)

/** Names shown to the user (and to screen readers) for each slot. */
export const SLOT_NAMES: Record<number, string> = {
  1: 'Blue',
  2: 'Green',
  3: 'Amber',
  4: 'Cyan',
  5: 'Indigo',
  6: 'Red',
  7: 'Pink',
  8: 'Orange',
  9: 'Teal',
  10: 'Violet',
  11: 'Olive',
  12: 'Clay',
}

export const slotVar = (slot: number) => `var(--series-${((slot - 1) % SLOT_COUNT) + 1})`

/**
 * The order the twelve are OFFERED in, which is not the order they are stored
 * in. Slot numbers are on rows in the database and cannot move; slot order was
 * chosen so that consecutive chart series differ, which is the right question
 * for a legend and the wrong one for a grid of swatches — as a row it is a
 * scrambled colour wheel. This is the wheel put back together, warm to cool, so
 * that six per row gives reds through greens above and teals through pinks
 * below. `SlotPicker` maps over this; everything else still counts 1..12.
 */
export const SWATCH_ORDER = [6, 8, 12, 3, 11, 2, 9, 4, 1, 5, 10, 7]

/**
 * The colour to paint something with: its own if it has been given one, else
 * its palette slot.
 *
 * A custom colour is a single hex for BOTH themes, where a slot resolves to a
 * token with a light and a dark step — so the palette is still the answer for
 * anything that has not been deliberately overridden, and the twelve stay the
 * thing most rows are drawn from. Everything that paints a face goes through
 * here rather than through `slotVar` directly, or a custom colour would appear
 * on the badge and not in the chart beside it.
 */
export const paintOf = (slot: number | undefined, color?: string) =>
  color ?? slotVar(slot ?? 1)

/** Whether a string is a colour we are willing to store. */
export const isHexColour = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value.trim())

/**
 * The slot to give a new category: the least-used one, so a fresh category is
 * visually distinct from what's already there instead of colliding with it.
 */
export function nextFreeSlot(used: number[]): number {
  const counts = new Map<number, number>(SLOTS.map((s) => [s, 0]))
  for (const s of used) {
    const key = ((s - 1) % SLOT_COUNT) + 1
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return SLOTS.reduce((best, s) => ((counts.get(s) ?? 0) < (counts.get(best) ?? 0) ? s : best), 1)
}

/* ---------- resolving a token to something measurable ---------- */

/**
 * A CSS custom property as a concrete `#rrggbb`, cached per theme.
 *
 * `inkOn` measures contrast and so needs a colour it can parse; `slotVar`
 * hands back `var(--series-3)`, which nothing outside the browser's style
 * resolution can read. The tokens themselves are plain hex in `index.css`, with
 * a light and a dark step, so one `getComputedStyle` per token per theme is the
 * whole cost — and the cache is keyed on the theme precisely so a flip
 * re-resolves rather than repainting yesterday's answer.
 *
 * Deliberately not a table of inks written beside the palette. That is the
 * argument `lib/ink.ts` opens with and it holds here: two themes' worth of
 * exceptions, going stale the first time a slot is re-tuned, with nothing to
 * say so. Measuring the value that is actually on the page cannot go stale.
 *
 * Undefined off the DOM — the unit tests run in node — so every caller needs a
 * behaviour for "cannot measure this", and for `Face` that is the tint it drew
 * before any of this existed.
 */
const hexCache = new Map<string, string>()

export function tokenHex(token: string, theme: string): string | undefined {
  const key = `${theme}|${token}`
  const hit = hexCache.get(key)
  if (hit) return hit
  if (typeof document === 'undefined') return undefined
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  // Only a hit is cached. A miss is a token that has been renamed or a read
  // that happened before the stylesheet resolved, and caching either would make
  // a face permanently and invisibly wrong — where re-reading costs one style
  // recalc on a path that is otherwise never taken.
  if (!isHexColour(raw)) return undefined
  const value = raw.toLowerCase()
  hexCache.set(key, value)
  return value
}

/** The hex a face will actually be painted in: its own colour, else its slot's. */
export function paintHex(slot: number | undefined, color: string | undefined, theme: string): string | undefined {
  if (color && isHexColour(color)) return color.trim().toLowerCase()
  if (slot === undefined) return undefined
  return tokenHex(`--series-${((slot - 1) % SLOT_COUNT) + 1}`, theme)
}
