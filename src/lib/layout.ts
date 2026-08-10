/**
 * A page somebody has arranged: which sections are on it, in what order, how
 * wide each one is, and which shape its chart takes.
 *
 * Shared by the home page and Reports rather than written twice. The two pages
 * hold quite different things — widgets that summarise a month, charts that
 * compare twelve — but the arranging is the same problem in both, and a second
 * copy of it would drift.
 *
 * Everything here is pure. The gesture lives in `components/Arrange.tsx`, the
 * catalogues live with the pages, and this file is only the rules: what a
 * stored layout means once the catalogue has moved on, and how a list of spans
 * becomes rows on a screen of a given width.
 */

/**
 * How wide a section is, in columns.
 *
 * `'full'` is not `Infinity` spelled differently — it means "however many
 * columns this screen has", so a section set to full on a four-column monitor
 * is still full on a phone with one. A number is clamped instead: a two-column
 * section on a one-column phone is one column wide, and goes back to two when
 * the window grows.
 */
export type Span = 1 | 2 | 'full'

/** One entry in a page's catalogue of what it can show. */
export interface SectionDef {
  id: string
  /** What the section is called when it is being arranged or is hidden. */
  label: string
  defaultSpan?: Span
  /**
   * New sections arrive switched on, which is what makes a feature discoverable
   * to somebody who arranged their page a year ago. Anything big enough to be
   * an imposition says so here.
   */
  defaultOn?: boolean
  /** The shapes this section's chart can take. The first is its default. */
  variants?: { value: string; label: string }[]
}

export interface LayoutItem {
  id: string
  on: boolean
  span: Span
  /** One of the section's `variants`, or undefined for its default. */
  variant?: string
}

const SPANS: Span[] = [1, 2, 'full']

const isSpan = (v: unknown): v is Span => SPANS.includes(v as Span)

/**
 * A stored layout, reconciled with what the page can actually show today.
 *
 * Storage is a string in `settings` written by an older build, so nothing in it
 * can be trusted: a section may have been removed, renamed, or gained variants
 * since. Unknown ids are dropped, duplicates collapse, unknown spans and
 * variants fall back to the catalogue's defaults, and anything the catalogue
 * has that the stored layout does not is appended — on, unless the definition
 * says otherwise.
 */
export function normaliseLayout(stored: unknown, catalogue: SectionDef[]): LayoutItem[] {
  const defs = new Map(catalogue.map((d) => [d.id, d]))
  const seen = new Set<string>()
  const out: LayoutItem[] = []

  for (const raw of Array.isArray(stored) ? stored : []) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<LayoutItem>
    const def = typeof item.id === 'string' ? defs.get(item.id) : undefined
    if (!def || seen.has(def.id)) continue
    seen.add(def.id)
    out.push({
      id: def.id,
      on: item.on !== false,
      span: isSpan(item.span) ? item.span : (def.defaultSpan ?? 1),
      variant: variantOf(def, item.variant),
    })
  }

  for (const def of catalogue) {
    if (seen.has(def.id)) continue
    out.push({ id: def.id, on: def.defaultOn !== false, span: def.defaultSpan ?? 1, variant: undefined })
  }
  return out
}

/** The stored variant if the section still offers it, else its default. */
function variantOf(def: SectionDef, stored: unknown): string | undefined {
  if (typeof stored !== 'string') return undefined
  return def.variants?.some((v) => v.value === stored) ? stored : undefined
}

/** The variant in force: what was chosen, or the first one offered. */
export function currentVariant(def: SectionDef | undefined, item: LayoutItem | undefined): string | undefined {
  return item?.variant ?? def?.variants?.[0]?.value
}

/**
 * Move a section to a gap in the VISIBLE list.
 *
 * `gap` counts the positions between visible sections — 0 is before the first,
 * `visible.length` is after the last — because that is what a drop target is:
 * a space, not an item. Hidden sections are pushed to the end, which is the
 * only place their order is ever read from (the row of chips that puts them
 * back).
 *
 * Returns the array it was given when nothing moved, so a caller can skip the
 * write.
 */
export function moveTo(items: LayoutItem[], id: string, gap: number): LayoutItem[] {
  const visible = items.filter((i) => i.on)
  const from = visible.findIndex((i) => i.id === id)
  if (from < 0) return items
  const next = [...visible]
  const [moved] = next.splice(from, 1)
  // Removing the item first shifts every gap after it down by one, so a gap
  // beyond the item's own position has to come back down with them.
  next.splice(Math.max(0, Math.min(next.length, gap > from ? gap - 1 : gap)), 0, moved)
  if (next.every((v, i) => v.id === visible[i].id)) return items
  return [...next, ...items.filter((i) => !i.on)]
}

/** Show or hide a section. A section coming back arrives at the end of the visible list. */
export function toggle(items: LayoutItem[], id: string): LayoutItem[] {
  const item = items.find((i) => i.id === id)
  if (!item) return items
  const rest = items.filter((i) => i.id !== id)
  const next = { ...item, on: !item.on }
  if (!next.on) return [...rest, next]
  const hiddenFrom = rest.findIndex((i) => !i.on)
  return hiddenFrom < 0 ? [...rest, next] : [...rest.slice(0, hiddenFrom), next, ...rest.slice(hiddenFrom)]
}

export function setSpan(items: LayoutItem[], id: string, span: Span): LayoutItem[] {
  return items.map((i) => (i.id === id ? { ...i, span } : i))
}

export function setVariant(items: LayoutItem[], id: string, variant: string): LayoutItem[] {
  return items.map((i) => (i.id === id ? { ...i, variant } : i))
}

/**
 * The next width along.
 *
 * Only offers widths this screen can tell apart: on a two-column layout `2` and
 * `full` are the same picture, so the cycle is one → full and back rather than
 * one → two → full with a step that appears to do nothing.
 */
export function nextSpan(span: Span, columns: number): Span {
  const usable: Span[] = columns >= 3 ? [1, 2, 'full'] : columns === 2 ? [1, 'full'] : [1]
  const i = usable.indexOf(span)
  return usable[(i + 1) % usable.length] ?? usable[0]
}

/** How many columns a section actually occupies on a screen this wide. */
export function effectiveSpan(span: Span, columns: number): number {
  return span === 'full' ? columns : Math.min(span, columns)
}

/**
 * A run of sections, laid out.
 *
 * Two kinds, because two different layouts are right for two different cases:
 *
 *  - `masonry` — a run of one-column sections, packed vertically by `Columns`
 *    so cards of unequal height leave no dead space between them. This is the
 *    ordinary case and it is why the home page looks the way it does.
 *  - `rows` — anything wider. A two-column card cannot join a masonry column
 *    without breaking it, so wide cards are packed into rows of their own,
 *    greedily, up to the column count.
 *
 * A wide section therefore splits the run in two, the way `column-span: all`
 * used to, and the masonry either side of it is independent.
 */
export type Band =
  | { kind: 'masonry'; items: LayoutItem[] }
  | { kind: 'rows'; rows: { item: LayoutItem; span: number }[][] }

export function bands(items: LayoutItem[], columns: number): Band[] {
  const out: Band[] = []
  const cols = Math.max(1, columns)

  for (const item of items) {
    const span = effectiveSpan(item.span, cols)
    const last = out[out.length - 1]

    if (span <= 1) {
      if (last?.kind === 'masonry') last.items.push(item)
      else out.push({ kind: 'masonry', items: [item] })
      continue
    }

    if (last?.kind === 'rows') {
      const row = last.rows[last.rows.length - 1]
      const used = row.reduce((s, r) => s + r.span, 0)
      if (used + span <= cols) {
        row.push({ item, span })
        continue
      }
      last.rows.push([{ item, span }])
      continue
    }
    out.push({ kind: 'rows', rows: [[{ item, span }]] })
  }
  return out
}
