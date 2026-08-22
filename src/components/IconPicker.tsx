import { useMemo, useState } from 'react'
import { Check, Pipette } from 'lucide-react'
import { CategoryIcon, ICON_GROUPS, searchIcons } from './CategoryIcon'
import { SLOT_NAMES, SWATCH_ORDER, isHexColour, paintHex, slotVar } from '../lib/palette'
import { useApp } from '../state/AppContext'
import { contrast, faceInk, inkOn, DARK_INK, GRAPHIC_CONTRAST, LIGHT_INK } from '../lib/ink'
import { Face, SearchInput, TextInput, cx } from './ui'

/** The colour a fresh custom swatch opens on, when there is nothing to edit yet. */
const CUSTOM_SEED = '#7c6cf0'

/**
 * The twelve palette slots as a row of swatches, and a colour of your own.
 *
 * Lifted out of the category form when accounts gained a colour too. Both need
 * exactly this and there is nothing to configure between them — a second copy
 * would be a second place for the ring, the offset and the tick to drift.
 *
 * The swatches are in `SWATCH_ORDER`, not slot order: slot numbers are on rows
 * in the database and were arranged so that consecutive CHART SERIES differ,
 * which as a grid of colours is a scrambled wheel. Six per row then reads warm
 * on the top row and cool on the bottom.
 *
 * ## The custom one
 *
 * Offered only when `onColorChange` is passed, and it is a thirteenth swatch
 * rather than a second control: "the colour of this category" has one answer,
 * and two controls would let a form show a slot ringed and a custom colour set
 * at the same time with no way to tell which is winning. Choosing a slot clears
 * the custom colour, which is what makes the twelve the way BACK.
 *
 * It is a disclosure that pushes the fields in below it, never a popover: this
 * lives inside a `Sheet`, and a `Popover` portals at `z-40` under the sheet's
 * `z-50` — it would open behind the form it belongs to. The sheet's body is
 * already animating between the shapes its contents take, so growing costs
 * nothing.
 *
 * Both halves of the disclosure are wanted. The native `<input type="color">`
 * is the platform's own picker — a wheel on a phone, an eyedropper on a desktop
 * — and it is the only one here that can sample a colour off the screen. The
 * hex field is for the case that picker cannot serve: a brand colour someone
 * has been given as six characters, which is most of why anybody wants this at
 * all. It commits only on a value that parses, so a half-typed `#7c6` never
 * paints the badge black on the way through.
 */
export function SlotPicker({
  value,
  onChange,
  color,
  onColorChange,
  label = 'Colour',
  hint,
}: {
  value: number
  onChange: (slot: number) => void
  /** A colour of its own, overriding the slot. */
  color?: string
  /** Passing this offers the custom swatch. Omit it for slots alone. */
  onColorChange?: (color: string | undefined) => void
  label?: string
  hint?: string
}) {
  const custom = color !== undefined
  const [open, setOpen] = useState(false)
  // What the hex field is showing, which is not what is saved: it holds
  // half-typed values the swatch must not be painted with.
  const [draft, setDraft] = useState(color ?? CUSTOM_SEED)
  const swatch = custom ? color : draft

  const pick = (next: string) => {
    setDraft(next)
    onColorChange?.(next)
  }

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-ink-2 md:mb-1 md:text-xs">
        {label}
        {hint && <span className="ml-1.5 font-normal text-ink-3">· {hint}</span>}
      </span>
      {/* Six per row, deterministically: the wheel is only readable as a wheel
          if it breaks in the same place every time, and a `flex-wrap` row
          breaks wherever the sheet happens to be wide. Warm above, cool below,
          with the custom swatch landing under the first column — beside the
          twelve rather than among them. */}
      <div className="grid w-fit grid-cols-6 gap-2">
        {SWATCH_ORDER.map((s) => {
          const chosen = !custom && value === s
          return (
            <button
              key={s}
              type="button"
              onClick={() => {
                onChange(s)
                onColorChange?.(undefined)
                setOpen(false)
              }}
              title={SLOT_NAMES[s]}
              aria-label={SLOT_NAMES[s]}
              aria-pressed={chosen}
              className={cx(
                'grid size-8 place-items-center rounded-full transition desktop:size-7',
                chosen ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface' : 'hover:scale-110',
              )}
              style={{ background: slotVar(s) }}
            >
              {chosen && <Check size={15} className="text-white drop-shadow" />}
            </button>
          )
        })}

        {onColorChange && (
          <button
            type="button"
            onClick={() => {
              setOpen((o) => (custom ? !o : true))
              if (!custom) onColorChange(draft)
            }}
            title="A colour of your own"
            aria-label="A colour of your own"
            aria-pressed={custom}
            aria-expanded={open}
            className={cx(
              'grid size-8 place-items-center rounded-full transition desktop:size-7',
              custom
                ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface'
                : 'ring-1 ring-hairline hover:scale-110',
            )}
            style={{ background: custom ? swatch : 'var(--surface-2)' }}
          >
            {custom ? (
              <Check size={15} className="text-white drop-shadow" />
            ) : (
              <Pipette size={15} className="text-ink-3" />
            )}
          </button>
        )}
      </div>

      {onColorChange && custom && open && (
        <div className="mt-2.5 flex items-center gap-2">
          <input
            type="color"
            value={isHexColour(swatch ?? '') ? (swatch as string) : CUSTOM_SEED}
            onChange={(e) => pick(e.target.value.toLowerCase())}
            aria-label="Pick a colour"
            className="size-10 shrink-0 cursor-pointer rounded-xl bg-surface-2 p-1 md:size-9 md:rounded-lg"
          />
          <TextInput
            value={draft}
            onChange={(e) => {
              const next = e.target.value
              setDraft(next)
              if (isHexColour(next)) onColorChange(next.trim().toLowerCase())
            }}
            onBlur={() => setDraft(color ?? CUSTOM_SEED)}
            spellCheck={false}
            autoCapitalize="none"
            aria-label="Colour, as a hex code"
            placeholder="#7c6cf0"
            className="font-mono"
          />
        </div>
      )}
    </div>
  )
}

/**
 * The mark on an account's tile: measured, or said outright.
 *
 * An account badge is a solid tile now and the icon on it is whichever of black
 * or white measures more legible against the fill — see `faceInk`, which also
 * has the failure that made the tint untenable. So the ordinary answer is
 * "Auto", it is correct in both themes without anybody choosing it, and this
 * control exists for the one case measurement cannot reach: a brand mark in the
 * brand's own colour on a pale tile. Measurement says black on white, which is
 * right, and the answer wanted is navy.
 *
 * Four swatches rather than the twelve `SlotPicker` offers, because this is not
 * the same question. The palette exists to tell twelve categories apart; a mark
 * on a tile has essentially two useful answers and one exception, and offering
 * a wheel here would imply the mark is a third thing to co-ordinate rather than
 * the readable half of a pair.
 *
 * The live preview is the point of the row. A contrast figure is a number
 * nobody can picture, so the tile is drawn at the size it will actually be worn
 * at, and the sentence under it only appears when the pair measures below the
 * bar for a graphic. It says so and does not refuse: it is their bank's
 * colours, on their own screen, and a control that overrules what somebody can
 * plainly see is worse than one that mentions it.
 */
export function InkPicker({
  slot,
  color,
  value,
  onChange,
  icon,
  label = 'Icon colour',
}: {
  /** The tile, exactly as the badge is given it — so the preview IS the badge. */
  slot: number
  color?: string
  value?: string
  onChange: (ink: string | undefined) => void
  icon?: string
  label?: string
}) {
  const { resolvedTheme } = useApp()
  const fill = paintHex(slot, color, resolvedTheme)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value ?? CUSTOM_SEED)
  const auto = fill ? inkOn(fill).color : LIGHT_INK
  const custom = value !== undefined && value !== LIGHT_INK && value !== DARK_INK
  const swatch = custom ? value : draft
  const shown = value ?? auto
  const ratio = fill ? contrast(fill, shown) : undefined

  const choices: { key: string; ink?: string; title: string; paint: string }[] = [
    // `var(--ink-2)` for the theoretical case `paintHex` could not resolve the
    // tile: there is nothing to measure against, so the letter takes the
    // surface's own ink rather than a white one nobody could see on it.
    { key: 'auto', ink: undefined, title: `Automatic (${auto === DARK_INK ? 'dark' : 'light'})`, paint: fill ? auto : 'var(--ink-2)' },
    { key: 'light', ink: LIGHT_INK, title: 'White', paint: LIGHT_INK },
    { key: 'dark', ink: DARK_INK, title: 'Black', paint: DARK_INK },
  ]

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-ink-2 md:mb-1 md:text-xs">
        {label}
        {value === undefined && <span className="ml-1.5 font-normal text-ink-3">· measured</span>}
      </span>
      <div className="flex items-center gap-3">
        <div className="flex gap-2">
          {choices.map((c) => {
            const chosen = c.key === 'auto' ? value === undefined : value === c.ink
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => {
                  onChange(c.ink)
                  setOpen(false)
                }}
                title={c.title}
                aria-label={c.title}
                aria-pressed={chosen}
                className={cx(
                  'grid size-8 place-items-center rounded-full transition desktop:size-7',
                  chosen ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface' : 'ring-1 ring-hairline hover:scale-110',
                )}
                style={{ background: fill ?? 'var(--surface-2)' }}
              >
                {/* The letter A rather than a tick for the measured one: what
                    makes it different from the two beside it is that it is not
                    a colour, and a tick would say only that it is selected. */}
                {c.key === 'auto' ? (
                  <span className="text-[11px] font-bold leading-none" style={{ color: c.paint }}>A</span>
                ) : (
                  <span className="size-3.5 rounded-full" style={{ background: c.paint }} />
                )}
              </button>
            )
          })}

          <button
            type="button"
            onClick={() => {
              setOpen((o) => (custom ? !o : true))
              if (!custom) onChange(draft)
            }}
            title="A colour of your own"
            aria-label="A colour of your own"
            aria-pressed={custom}
            aria-expanded={open}
            className={cx(
              'grid size-8 place-items-center rounded-full transition desktop:size-7',
              custom ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface' : 'ring-1 ring-hairline hover:scale-110',
            )}
            style={{ background: fill ?? 'var(--surface-2)' }}
          >
            {custom ? (
              <span className="size-3.5 rounded-full" style={{ background: swatch }} />
            ) : (
              <Pipette size={15} className="text-ink-3" />
            )}
          </button>
        </div>

        {/* At the size it is actually worn at. A contrast ratio is a number
            nobody can picture; the tile is the thing being decided. */}
        <Face slot={slot} color={color} ink={value} icon={icon} shape="square" size={36} fill />
      </div>

      {custom && open && (
        <div className="mt-2.5 flex items-center gap-2">
          <input
            type="color"
            value={isHexColour(swatch ?? '') ? (swatch as string) : CUSTOM_SEED}
            onChange={(e) => {
              const next = e.target.value.toLowerCase()
              setDraft(next)
              onChange(next)
            }}
            aria-label="Pick a colour"
            className="size-10 shrink-0 cursor-pointer rounded-xl bg-surface-2 p-1 md:size-9 md:rounded-lg"
          />
          <TextInput
            value={draft}
            onChange={(e) => {
              const next = e.target.value
              setDraft(next)
              if (isHexColour(next)) onChange(next.trim().toLowerCase())
            }}
            onBlur={() => setDraft(value ?? CUSTOM_SEED)}
            spellCheck={false}
            autoCapitalize="none"
            aria-label="Icon colour, as a hex code"
            placeholder="#0a2d5e"
            className="font-mono"
          />
        </div>
      )}

      {ratio !== undefined && ratio < GRAPHIC_CONTRAST && (
        <p className="mt-1.5 text-xs text-ink-3">
          This mark is faint against its tile ({ratio.toFixed(1)}:1, where 3:1 is the readable bar). Automatic picks
          the more legible of black and white.
        </p>
      )}
    </div>
  )
}

/**
 * Choosing one icon out of two hundred.
 *
 * The old picker was forty icons in a single grid, which is about the most you
 * can scan without giving up. At two hundred a flat strip is unusable, so this
 * does the two things that make a long list workable and does them together:
 * groups for when you are browsing, and a search box for when you already know
 * the word.
 *
 * The list is scrolled inside a fixed height rather than growing the sheet.
 * Everything this appears in — the category form, the account form — has a
 * footer with the save button in it, and a picker that pushes that off the
 * bottom of the screen makes the form look like it has no way to finish.
 */
export function IconPicker({
  value,
  onChange,
  colour,
  fill,
  ink,
  label = 'Icon',
  hint,
}: {
  value?: string
  onChange: (key: string) => void
  /** Highlight colour for the chosen icon — the category or account's own. */
  colour: string
  /**
   * Draw the chosen cell as the SOLID tile it will actually be worn as, rather
   * than as a tint of `colour` under itself.
   *
   * Passed by the account form for the reason the badge itself is solid — see
   * `faceInk`. Without it the picker keeps the failure the badge no longer has,
   * on the one screen where you are choosing: a brand navy would be a dark mark
   * on a dark tint in the dark theme, so the icon you had just selected would
   * be the one you could not see. A preview that is wrong in the same way the
   * old badge was is worse than no preview.
   */
  fill?: string
  ink?: string
  label?: string
  hint?: string
}) {
  const [query, setQuery] = useState('')
  const results = useMemo(() => searchIcons(query), [query])
  const searching = query.trim().length > 0

  /** Groups with their matching icons only, so browsing and searching share a layout. */
  const sections = useMemo(() => {
    if (!searching) return ICON_GROUPS.map((g) => ({ name: g.name, keys: Object.keys(g.icons) }))
    const hits = new Set(results)
    return ICON_GROUPS.map((g) => ({
      name: g.name,
      keys: Object.keys(g.icons).filter((k) => hits.has(k)),
    })).filter((g) => g.keys.length > 0)
  }, [results, searching])

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 md:mb-1">
        <span className="block text-sm font-medium text-ink-2 md:text-xs">
          {label}
          {hint && <span className="ml-1.5 font-normal text-ink-3">· {hint}</span>}
        </span>
        {searching && (
          <span className="text-xs text-ink-3">
            {results.length} {results.length === 1 ? 'icon' : 'icons'}
          </span>
        )}
      </div>

      <SearchInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search icons"
        aria-label="Search icons"
        className="mb-2"
      />

      <div className="max-h-64 overflow-y-auto rounded-xl bg-surface-2/50 p-2 md:max-h-56">
        {sections.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-ink-3">
            Nothing matches “{query.trim()}”.
          </p>
        ) : (
          sections.map((g) => (
            <div key={g.name} className="mb-2 last:mb-0">
              {/* The heading earns its place while browsing and is still worth
                  keeping while searching: "three of these are Food" is most of
                  what tells two similar glyphs apart. */}
              <p className="mb-1 px-1 text-xs font-medium text-ink-3">{g.name}</p>
              <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 md:grid-cols-10">
                {g.keys.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onChange(key)}
                    aria-label={key}
                    aria-pressed={value === key}
                    title={key}
                    className={cx(
                      'grid aspect-square place-items-center rounded-xl ring-1 transition md:rounded-lg',
                      value === key
                        ? 'ring-2 ring-ink'
                        : 'bg-surface text-ink-2 ring-transparent hover:ring-hairline',
                    )}
                    style={
                      value !== key
                        ? undefined
                        : fill
                          ? { background: fill, color: faceInk(fill, ink) }
                          : { background: `color-mix(in oklab, ${colour} 16%, var(--surface-2))`, color: colour }
                    }
                  >
                    <CategoryIcon icon={key} size={17} />
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
