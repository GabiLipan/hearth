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
