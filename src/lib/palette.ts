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
  4: 'Forest',
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
