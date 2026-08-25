/**
 * A page somebody has arranged: which sections are on it, in what order, how
 * wide and how tall each one is, and which shape its chart takes.
 *
 * Shared by the home page and Reports rather than written twice. The two pages
 * hold quite different things — widgets that summarise a month, charts that
 * compare twelve — but the arranging is the same problem in both, and a second
 * copy of it would drift.
 *
 * Everything here is pure. The gesture lives in `components/Arrange.tsx`, the
 * catalogues live with the pages, and this file is only the rules: what a
 * stored layout means once the catalogue has moved on, and what box each
 * section takes in a grid of a given width.
 *
 * ## Why a grid, and not the masonry it replaced
 *
 * A card used to be one column, two, or the width of the page, and a run of
 * one-column cards was packed into balanced masonry columns. That answered
 * "leave no dead space" and nothing else: a card had no say in its own height,
 * so a chart worth looking at got exactly as much room as a list of five
 * payees, and every wide card cut the page into independent bands that could
 * not be arranged across.
 *
 * So both axes are the section's to choose. A section takes `span` columns and
 * `rows` row units, the row unit is a real length (see `ROW_UNIT`), and the
 * holes that leaves are filled by the grid's own dense packing rather than by
 * an arrangement computed here. `placements` is what is left of the old
 * `bands`: it clamps what was stored to what this screen can actually show,
 * and the CSS does the rest.
 */

/**
 * How wide a section is, in columns.
 *
 * `'full'` is not `MAX_SPAN` spelled differently — it means "however many
 * columns this screen has", so a section set to full on a four-column monitor
 * is still full on a phone with one. A number is clamped instead: a three-column
 * section on a two-column laptop is two columns wide, and goes back to three
 * when the window grows.
 */
export type Span = number | 'full'

/** The widest a section may be asked for, whatever the screen turns out to be. */
export const MAX_SPAN = 4

/**
 * How tall a section is, in row units — see `ROW_UNIT` for what one is worth.
 *
 * One is the ordinary case and behaves exactly as the old layout did: the row
 * is as tall as the tallest card in it and a card of prose is whatever height
 * its prose is. Asking for two or three is asking for a picture rather than a
 * summary, and it is the only way to say so.
 */
export const MAX_HEIGHT = 3

/**
 * The height of one row unit, in pixels, and the one number the grid and the
 * resize gesture must agree about.
 *
 * It is a floor rather than a fixed track: `grid-auto-rows` is
 * `minmax(ROW_UNIT, auto)`, so a card taller than the room it asked for grows
 * its row rather than being cut off — which is what lets a section state a
 * height at all without anybody having to know what its contents measure.
 */
export const ROW_UNIT = 116

/**
 * A choice a section offers about itself, beyond which shape it takes.
 *
 * `variants` answers "what kind of picture is this" and is the primary axis —
 * a ring or bars, a line or an area. These answer everything else: how many
 * categories are worth naming, how many months are worth drawing, whether the
 * figures are written into the heatmap or left to its colour. They are
 * separate because they compose: every shape of the breakdown can show five
 * categories or twenty, and folding the two into one list would mean six
 * entries that have to be read as a grid.
 *
 * The first choice is the default, the same rule `variants` follows.
 */
export interface OptionDef {
  id: string
  /** What the choice is called — a noun, since it heads a list of answers. */
  label: string
  choices: { value: string; label: string }[]
  /**
   * Which choice is the default, where that is not the first one.
   *
   * `variants` can get away with "the first is the default" because a list of
   * shapes has no natural order to disagree with. A list of numbers does: five,
   * eight, twelve, twenty reads as a scale, and reordering it to put the
   * default first makes the control look broken. So the order is the reader's
   * and the default is stated. Ignored if it names a choice that is not there.
   */
  defaultValue?: string
}

/** One entry in a page's catalogue of what it can show. */
export interface SectionDef {
  id: string
  /** What the section is called when it is being arranged or is hidden. */
  label: string
  defaultSpan?: Span
  /**
   * How many row units it opens at. One unless the section is a picture that
   * is worth nothing small — see `MAX_HEIGHT`.
   */
  defaultHeight?: number
  /**
   * New sections arrive switched on, which is what makes a feature discoverable
   * to somebody who arranged their page a year ago. Anything big enough to be
   * an imposition says so here.
   */
  defaultOn?: boolean
  /**
   * What the section's own heading is drawn ON, which decides nothing but the
   * ink of the controls sitting in it.
   *
   * `.panel-month` is the app's one painted surface and defines its own ink, so
   * a picker taking `text-ink-3` — ink for a surface — is a grey word on a
   * saturated panel. The same distinction the ⓘ beside it already draws; see
   * `InfoGround`.
   */
  ground?: 'surface' | 'panel'
  /** The shapes this section's chart can take. The first is its default. */
  variants?: { value: string; label: string }[]
  /** Everything else it lets you decide. See `OptionDef`. */
  options?: OptionDef[]
}

export interface LayoutItem {
  id: string
  on: boolean
  span: Span
  /**
   * How tall, in row units. Absent means one, so every layout stored before
   * there was a second axis reads exactly as it did.
   */
  rows?: number
  /** One of the section's `variants`, or undefined for its default. */
  variant?: string
  /**
   * The section's other choices, by option id. Absent keys mean the default,
   * so a section that gains an option does not have to migrate anybody.
   */
  opts?: Record<string, string>
}

const isSpan = (v: unknown): v is Span =>
  v === 'full' || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_SPAN)

/**
 * A stored height, clamped to something this build can draw.
 *
 * Undefined rather than 1 when there is nothing to say, so a layout written
 * before the second axis existed stays byte-identical after a round trip —
 * the same care `optsOf` takes, and for the same reason.
 */
const heightOf = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 1 ? Math.min(v, MAX_HEIGHT) : undefined

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
      rows: heightOf(item.rows ?? def.defaultHeight),
      variant: variantOf(def, item.variant),
      opts: optsOf(def, item.opts),
    })
  }

  for (const def of catalogue) {
    if (seen.has(def.id)) continue
    out.push({
      id: def.id,
      on: def.defaultOn !== false,
      span: def.defaultSpan ?? 1,
      rows: heightOf(def.defaultHeight),
      variant: undefined,
    })
  }
  return out
}

/** The stored variant if the section still offers it, else its default. */
function variantOf(def: SectionDef, stored: unknown): string | undefined {
  if (typeof stored !== 'string') return undefined
  return def.variants?.some((v) => v.value === stored) ? stored : undefined
}

/**
 * The stored options, less anything the section has stopped offering.
 *
 * Returns undefined rather than `{}` when nothing survives, so a layout
 * written before options existed stays byte-identical after a round trip and
 * an unremarkable section does not carry an empty object for ever.
 */
function optsOf(def: SectionDef, stored: unknown): Record<string, string> | undefined {
  if (!def.options?.length || !stored || typeof stored !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const opt of def.options) {
    const value = (stored as Record<string, unknown>)[opt.id]
    if (typeof value === 'string' && opt.choices.some((c) => c.value === value)) out[opt.id] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The variant in force: what was chosen, or the first one offered. */
export function currentVariant(def: SectionDef | undefined, item: LayoutItem | undefined): string | undefined {
  return item?.variant ?? def?.variants?.[0]?.value
}

/** One option's value in force: what was chosen, or the first choice offered. */
export function optionValue(
  def: SectionDef | undefined,
  item: LayoutItem | undefined,
  optionId: string,
): string | undefined {
  const opt = def?.options?.find((o) => o.id === optionId)
  if (!opt) return undefined
  const has = (v: string | undefined) => v !== undefined && opt.choices.some((c) => c.value === v)
  const stored = item?.opts?.[optionId]
  if (has(stored)) return stored
  return has(opt.defaultValue) ? opt.defaultValue : opt.choices[0]?.value
}

/**
 * Every option a section has, resolved — what a page actually reads.
 *
 * A map rather than a call per option, because the caller is a render function
 * that wants them all and would otherwise repeat the section's own id four
 * times to ask four questions of it.
 */
export function optionsFor(def: SectionDef | undefined, item: LayoutItem | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const opt of def?.options ?? []) {
    const value = optionValue(def, item, opt.id)
    if (value !== undefined) out[opt.id] = value
  }
  return out
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

export function setOption(items: LayoutItem[], id: string, optionId: string, value: string): LayoutItem[] {
  return items.map((i) => (i.id === id ? { ...i, opts: { ...i.opts, [optionId]: value } } : i))
}

/* ---------- how big a section is ---------- */

/**
 * Every width this screen can tell apart, in the order they are offered.
 *
 * A number equal to the column count is dropped: on two columns `2` and `full`
 * are the same picture, and a control with a step that appears to do nothing is
 * a control people press twice and then stop trusting. `full` is always last
 * because it is the one that keeps meaning something when the window changes.
 */
export function spanChoices(columns: number): Span[] {
  const cols = Math.max(1, columns)
  const out: Span[] = []
  for (let n = 1; n < Math.min(cols, MAX_SPAN + 1); n++) out.push(n)
  out.push('full')
  return out
}

/**
 * The next width along, wrapping.
 *
 * A no-op on one column, and that is not a shortcut: every width looks the same
 * on a phone and the value is SHARED with every other screen this household
 * signs in on, so a cycle there would quietly rewrite what the card is on the
 * laptop it was arranged on — a control that appears to do nothing and does
 * something somewhere else.
 */
export function nextSpan(span: Span, columns: number): Span {
  if (columns <= 1) return span
  const usable = spanChoices(columns)
  const i = usable.findIndex((s) => s === span)
  return usable[(i + 1) % usable.length] ?? usable[0]
}

/** How many columns a section actually occupies on a screen this wide. */
export function effectiveSpan(span: Span, columns: number): number {
  const cols = Math.max(1, columns)
  return span === 'full' ? cols : Math.min(Math.max(1, Math.round(span)), cols)
}

/**
 * How many row units it actually occupies.
 *
 * One on a phone, whatever was stored. A single column is a stack of cards read
 * one after another, where a height is not a comparison with anything — it is
 * just a card with a hole in the bottom of it, and the section that asked to be
 * three units tall to hold a chart on a monitor is the one that can least
 * afford that. The stored value is untouched, so rotating a tablet or opening
 * the window gives it straight back.
 */
export function effectiveHeight(rows: number | undefined, columns: number): number {
  if (columns <= 1) return 1
  return Math.min(Math.max(1, Math.round(rows ?? 1)), MAX_HEIGHT)
}

export function setHeight(items: LayoutItem[], id: string, rows: number): LayoutItem[] {
  return items.map((i) => (i.id === id ? { ...i, rows: rows > 1 ? Math.min(rows, MAX_HEIGHT) : undefined } : i))
}

/**
 * What box each visible section takes, clamped to this screen.
 *
 * All that is left of `bands`, which used to decide the whole arrangement:
 * which run of cards became a masonry column, which became a row, and where a
 * wide card cut the page in two. None of that is computed any more — the page
 * is one CSS grid with dense packing, so the holes a mixture of sizes leaves
 * are filled by the browser, in the order the sections are already in.
 *
 * What remains is the part CSS cannot do: `'full'` means this screen's column
 * count rather than a number, and a stored size may be wider or taller than
 * this screen can show.
 */
export interface Placement {
  item: LayoutItem
  /** Columns, 1..columns. */
  span: number
  /** Row units, 1..MAX_HEIGHT. */
  rows: number
}

export function placements(items: LayoutItem[], columns: number): Placement[] {
  const cols = Math.max(1, columns)
  return items.map((item) => ({
    item,
    span: effectiveSpan(item.span, cols),
    rows: effectiveHeight(item.rows, cols),
  }))
}
