import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { CategoryIcon, ICON_GROUPS, searchIcons } from './CategoryIcon'
import { SLOT_NAMES, SLOTS, slotVar } from '../lib/palette'
import { SearchInput, cx } from './ui'

/**
 * The twelve palette slots as a row of swatches.
 *
 * Lifted out of the category form when accounts gained a colour too. Both need
 * exactly this and there is nothing to configure between them — a second copy
 * would be a second place for the ring, the offset and the tick to drift.
 */
export function SlotPicker({
  value,
  onChange,
  label = 'Colour',
  hint,
}: {
  value: number
  onChange: (slot: number) => void
  label?: string
  hint?: string
}) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-ink-2 md:mb-1 md:text-xs">
        {label}
        {hint && <span className="ml-1.5 font-normal text-ink-3">· {hint}</span>}
      </span>
      <div className="flex flex-wrap gap-2">
        {SLOTS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            title={SLOT_NAMES[s]}
            aria-label={SLOT_NAMES[s]}
            aria-pressed={value === s}
            className={cx(
              'grid size-8 place-items-center rounded-full transition desktop:size-7',
              value === s ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface' : 'hover:scale-110',
            )}
            style={{ background: slotVar(s) }}
          >
            {value === s && <Check size={15} className="text-white drop-shadow" />}
          </button>
        ))}
      </div>
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
  label = 'Icon',
  hint,
}: {
  value?: string
  onChange: (key: string) => void
  /** Highlight colour for the chosen icon — the category or account's own. */
  colour: string
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
                      value === key
                        ? { background: `color-mix(in oklab, ${colour} 16%, var(--surface-2))`, color: colour }
                        : undefined
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
