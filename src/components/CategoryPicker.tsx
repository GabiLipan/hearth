import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Category } from '../lib/db'
import { styleOf, type CategoryStyle } from '../lib/categories'
import { paintOf } from '../lib/palette'
import { CategoryIcon } from './CategoryIcon'
import { cx } from './ui'

/**
 * Choosing a category, and then — only if there is one — a subcategory.
 *
 * The flat version showed every category and every subcategory at once, as one
 * wrapped run of chips. With four subcategories under a few of the parents that
 * is sixty-odd targets in a sheet you are meant to fill in one-handed, and the
 * two levels look alike enough that the list reads as noise rather than as a
 * shape.
 *
 * So: a grid of the parents only, and tapping one opens its children in a
 * drawer beneath **the whole row**, the way a folder opened on an early iPhone.
 * Two things come out of that shape for free — the tile you tapped never moves,
 * so the drawer clearly belongs to it, and nothing to the right of it is pushed
 * onto another line.
 *
 * Tapping a parent also selects it. Picking the more specific child is then one
 * further tap rather than a precondition, which matters because most rows never
 * need one.
 */

/** Must match the `gap-2` on the grid — the caret is positioned in pixels. */
const GAP = 8
/** Below this a tile cannot hold an icon and a two-word name. */
const MIN_TILE = 96

/**
 * How many columns fit, measured from the container rather than the window.
 *
 * The picker lives inside a sheet whose width is capped well below the
 * viewport's, so a media query would be answering a different question — and
 * the drawer's caret is placed from this count, so a wrong answer is visible
 * rather than merely suboptimal.
 */
function useGrid(ref: RefObject<HTMLElement | null>) {
  const [grid, setGrid] = useState({ cols: 3, width: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const width = el.clientWidth
      if (!width) return
      const cols = Math.max(2, Math.min(5, Math.floor((width + GAP) / (MIN_TILE + GAP))))
      setGrid((prev) => (prev.cols === cols && prev.width === width ? prev : { cols, width }))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [ref])
  return grid
}

export function CategoryPicker({
  groups,
  byId,
  value,
  onChange,
}: {
  groups: { parent: Category; children: Category[] }[]
  byId: Map<string, Category>
  value: string | undefined
  onChange: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { cols, width } = useGrid(ref)
  const [open, setOpen] = useState<string | null>(null)

  /**
   * Which group the current selection lives in — the parent itself, or the
   * parent of the chosen child.
   */
  const selectedParent = value ? (byId.get(value)?.parentId ?? value) : undefined

  /**
   * Follow a selection made from outside: the categoriser suggesting one from
   * the payee, or opening the sheet on a row already filed under a child. Left
   * closed the sheet would show the parent highlighted and no sign of which
   * child it actually is.
   *
   * It cannot fight the user closing the drawer by hand — that leaves
   * `selectedParent` where it was, so this does not re-run.
   */
  useEffect(() => {
    if (!selectedParent) return
    const group = groups.find((g) => g.parent.id === selectedParent)
    if (group && group.children.length > 0) setOpen(selectedParent)
  }, [selectedParent, groups.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const openIndex = open ? groups.findIndex((g) => g.parent.id === open) : -1
  const openGroup = openIndex >= 0 ? groups[openIndex] : undefined
  // The last tile on the same row as the open one — the drawer goes after it,
  // never mid-row, so the tiles either side of the tapped one stay put.
  const drawerAfter =
    openIndex >= 0 ? Math.min(groups.length - 1, Math.floor(openIndex / cols) * cols + cols - 1) : -1
  const tile = width > 0 ? (width - (cols - 1) * GAP) / cols : 0
  const caret = tile > 0 ? (openIndex % cols) * (tile + GAP) + tile / 2 : 0

  return (
    <div
      ref={ref}
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {groups.map((group, i) => {
        const { parent, children } = group
        const childSelected = children.find((c) => c.id === value)
        return (
          <Fragment key={parent.id}>
            <Tile
              name={parent.name}
              child={childSelected?.name}
              style={styleOf(parent, byId)}
              selected={value === parent.id || childSelected !== undefined}
              expandable={children.length > 0}
              expanded={open === parent.id}
              onSelect={() => {
                // Always choose the parent: it is a real answer, and it is the
                // way back from a child you no longer want.
                onChange(parent.id)
                if (children.length === 0) setOpen(null)
                else setOpen(open === parent.id && value === parent.id ? null : parent.id)
              }}
            />
            {i === drawerAfter && openGroup && (
              <Drawer caret={caret} items={openGroup.children} value={value} onChange={onChange} />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

function Tile({
  name,
  child,
  style,
  selected,
  expandable,
  expanded,
  onSelect,
}: {
  name: string
  /** The chosen subcategory, shown under the parent's name so the tile is the whole answer. */
  child?: string
  style: CategoryStyle
  selected: boolean
  expandable: boolean
  expanded: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-expanded={expandable ? expanded : undefined}
      className={cx(
        'relative flex min-h-[4.25rem] flex-col items-center justify-center gap-1 rounded-xl px-1.5 py-2 text-center ring-1 transition',
        selected
          ? 'bg-accent text-accent-ink ring-accent'
          : 'bg-surface-2 text-ink-2 ring-transparent hover:ring-hairline',
      )}
    >
      <span style={selected ? undefined : { color: paintOf(style.slot, style.color) }}>
        <CategoryIcon icon={style.icon} size={18} />
      </span>
      {/* `w-full` so `truncate` has a width to truncate against — inside a
          centred flex column the span would otherwise size to its own text. */}
      <span className="w-full truncate text-xs font-medium leading-tight">{name}</span>
      {child && <span className="w-full truncate text-[0.65rem] leading-tight opacity-75">{child}</span>}
      {/*
        That this tile has more inside it, said with a shape rather than a
        glyph.

        It was an 11px chevron in the top-right corner, which is the smallest
        thing on the screen, is nowhere near the centred content it belongs to,
        and is the only corner furniture in an app whose controls are capsules.
        This is the grabber under a sheet — the one shape in the language that
        already means "there is another layer here, and it comes out
        downwards", which is exactly where the drawer appears. It reads at a
        glance across a grid of twelve without ever being read as a control of
        its own, and it retracts when the drawer is out, because the layer it
        was promising is now on screen.
      */}
      {expandable && (
        <span
          aria-hidden
          className={cx(
            'absolute bottom-1.5 left-1/2 h-[3px] -translate-x-1/2 rounded-full transition-all duration-200',
            selected ? 'bg-current' : 'bg-ink-3',
            // One conditional per property. Written as two — `opacity-40` plus
            // `opacity-0` when expanded — the second never wins: which of two
            // conflicting utilities applies is Tailwind's generated order, not
            // the order they are listed in, and the bar simply stayed on.
            expanded ? 'w-3 opacity-0' : selected ? 'w-7 opacity-40' : 'w-7 opacity-30',
          )}
        />
      )}
    </button>
  )
}

/**
 * The children of the open parent, spanning the full width under their row.
 *
 * The caret is placed in pixels from the measured tile width rather than as a
 * percentage: with a gap between the columns the two are not the same, and a
 * caret pointing between two tiles is worse than none at all.
 */
function Drawer({
  caret,
  items,
  value,
  onChange,
}: {
  caret: number
  items: Category[]
  value: string | undefined
  onChange: (id: string) => void
}) {
  return (
    <div className="animate-drawer grid" style={{ gridColumn: '1 / -1' }}>
      <div className="min-h-0 overflow-hidden">
        <div className="relative mt-1 rounded-xl bg-surface-2 px-3 pb-3 pt-3.5">
          <span
            aria-hidden
            className="absolute -top-1 size-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-surface-2"
            style={{ left: caret }}
          />
          {/* No icons on the chips. A subcategory inherits its parent's icon by
              design, so a drawer of them is the same glyph four times — which
              adds nothing here, where the parent is directly above, and costs
              the room the names want. */}
          <div className="flex flex-wrap gap-1.5">
            {items.map((child) => (
              <button
                key={child.id}
                type="button"
                onClick={() => onChange(child.id)}
                aria-pressed={value === child.id}
                className={cx(
                  'rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition',
                  value === child.id
                    ? 'bg-accent text-accent-ink ring-accent'
                    : 'bg-surface text-ink-2 ring-hairline hover:ring-ink-3/40',
                )}
              >
                {child.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
