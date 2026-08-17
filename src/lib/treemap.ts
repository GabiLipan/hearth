/**
 * A set of amounts as a set of rectangles, laid out so that area means money.
 *
 * The one thing a ring does badly is size: comparing two arcs means comparing
 * two angles, and past the biggest two or three nobody can. Comparing two
 * rectangles is comparing two areas, which is the same comparison the figures
 * themselves invite — and unlike a row of bars it uses the whole of a card
 * rather than a strip of it, which is what lets every category carry its own
 * name and amount in place instead of in a legend beside the picture.
 *
 * ## Squarified, not sliced
 *
 * The naive layout — slice the box left to right in proportion — produces
 * splinters: at six categories the last one is a 4px column the full height of
 * the card, which is unreadable, unlabellable and very nearly untappable. So
 * this is the squarified algorithm (Bruls, Huizing, van Wijk): take the
 * categories biggest first, and keep adding them to the current row for as long
 * as doing so makes the row's worst aspect ratio BETTER. When the next one would
 * make it worse, the row is closed, its strip is taken off the free rectangle,
 * and the next row starts in what is left.
 *
 * The rows always run along the free rectangle's shorter side, which is what
 * keeps the tiles near square as the space it is filling changes shape.
 *
 * ## Area is exact, and there is no minimum tile
 *
 * Every tile's area is its share of the total, to floating-point. Nothing is
 * floored to keep a small category visible, deliberately: a floor makes the
 * tiles stop summing to the figure printed above them, which is the fault the
 * Sankey's `minBand` has to carry a note about. The tail is handled one level
 * up instead — `bookSlices` already folds everything past the top N into
 * "Other" — so what arrives here is a handful of comparable amounts rather than
 * ninety, and the caller decides what to do with a tile too small to label.
 */

/** A tile in the box the caller asked for, in the same units it gave. */
export interface Tile {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The worst aspect ratio in a row of areas laid along a side of length `side`.
 *
 * The row's thickness is fixed by its total area, so its widest tile and its
 * narrowest one bound the row's quality: whichever of the two is further from
 * square is what the eye notices.
 */
function worstRatio(areas: number[], side: number): number {
  let sum = 0
  let min = Infinity
  let max = 0
  for (const a of areas) {
    sum += a
    if (a < min) min = a
    if (a > max) max = a
  }
  if (sum <= 0 || side <= 0 || min <= 0) return Infinity
  const s2 = sum * sum
  const side2 = side * side
  return Math.max((side2 * max) / s2, s2 / (side2 * min))
}

/**
 * Tiles for `values`, filling a `width` × `height` box.
 *
 * The result is aligned to the INPUT order, not to the sorted order the layout
 * works in, so the caller can zip it straight back onto its own list. A value
 * that is zero or negative gets a zero-size tile rather than being dropped —
 * dropping would shift every index after it, and silently rendering the wrong
 * category's name on a tile is worse than rendering nothing.
 */
export function squarify(values: number[], width: number, height: number): Tile[] {
  const out: Tile[] = values.map(() => ({ x: 0, y: 0, w: 0, h: 0 }))
  if (!(width > 0) || !(height > 0)) return out

  const items = values
    .map((value, index) => ({ value, index }))
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value)
  const total = items.reduce((s, i) => s + i.value, 0)
  if (total <= 0) return out

  /** Value → area, so the whole box is spoken for. */
  const scale = (width * height) / total

  // The rectangle still to be filled, shrinking a row at a time.
  let x = 0
  let y = 0
  let w = width
  let h = height

  let i = 0
  while (i < items.length) {
    const side = Math.min(w, h)
    const row = [items[i].value * scale]
    let j = i + 1
    // Extend while it helps. `>=` rather than `>` would keep swallowing tiles
    // that make no difference, which on equal values fills the row with all of
    // them and produces one strip instead of a grid.
    while (j < items.length) {
      const next = items[j].value * scale
      if (worstRatio([...row, next], side) > worstRatio(row, side)) break
      row.push(next)
      j++
    }

    const sum = row.reduce((s, a) => s + a, 0)
    /** How deep the row is: its area spread along the side it runs down. */
    const thick = side > 0 ? sum / side : 0

    if (w <= h) {
      // Across the top of what is left, thickening downwards.
      let cx = x
      row.forEach((area, k) => {
        const tw = thick > 0 ? area / thick : 0
        out[items[i + k].index] = { x: cx, y, w: tw, h: thick }
        cx += tw
      })
      y += thick
      h = Math.max(0, h - thick)
    } else {
      // Down the left of what is left, thickening rightwards.
      let cy = y
      row.forEach((area, k) => {
        const th = thick > 0 ? area / thick : 0
        out[items[i + k].index] = { x, y: cy, w: thick, h: th }
        cy += th
      })
      x += thick
      w = Math.max(0, w - thick)
    }

    i = j
  }

  return out
}
