import type { Category } from './db'
import { styleOf } from './categories'

/**
 * Rearranging categories: what a drag means, and what it has to write.
 *
 * The tree is exactly two levels deep and the database enforces it, so this is
 * a FLAT list with a depth of 0 or 1 rather than a recursive structure. Every
 * question a drag asks — where does this land, whose child does it become, what
 * changes on disk — is then an index calculation, which is testable in a way
 * that a tree walk with a drag controller wrapped round it is not.
 *
 * The server's rules are mirrored here rather than discovered at save time (see
 * `categories_hierarchy_guard` in migration 04), because writes fail late and
 * quietly: a drop the database will refuse must be refused by the drag, not
 * dead-lettered a minute later.
 *
 *   - nesting stops at one level, so a category with children cannot become one
 *   - a subcategory is the same `kind` as its parent, so nothing crosses
 *     between spending and income
 *   - a TOP-LEVEL category must carry its own icon and colour
 *     (`categories_top_level_has_style`), so promoting one has to fill them in
 *
 * That last rule is the one that would otherwise bite: a subcategory stores no
 * style at all — null means "inherit" — so simply clearing its `parentId`
 * produces a row the check constraint rejects.
 */

export type Depth = 0 | 1

export interface TreeRow {
  id: string
  depth: Depth
  kind: Category['kind']
}

/** Spending first, then income; within each, parents in order, children under them. */
export function flatten(categories: Category[]): TreeRow[] {
  const rows: TreeRow[] = []
  const byOrder = (a: Category, b: Category) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
  for (const kind of ['expense', 'income'] as const) {
    const here = categories.filter((c) => c.kind === kind)
    for (const parent of here.filter((c) => !c.parentId).sort(byOrder)) {
      rows.push({ id: parent.id, depth: 0, kind })
      for (const child of here.filter((c) => c.parentId === parent.id).sort(byOrder)) {
        rows.push({ id: child.id, depth: 1, kind })
      }
    }
  }
  return rows
}

/**
 * How many rows travel together. A parent takes its children; a child is alone.
 *
 * This is why a parent can never be dropped inside its own subtree: the subtree
 * is not in the list to be dropped into.
 */
export function blockLength(rows: TreeRow[], index: number): number {
  if (rows[index]?.depth !== 0) return 1
  let n = 1
  while (rows[index + n]?.depth === 1) n++
  return n
}

/** Where a drag would land: a gap in the *displayed* rows, and how deep. */
export interface Drop {
  /** 0 = before the first row, rows.length = after the last. */
  index: number
  depth: Depth
}

/**
 * The list as it would be after the drop, with every rule already applied.
 *
 * Returns the rows unchanged when the drop is a no-op, so a caller can compare
 * by identity to decide whether anything is worth writing.
 */
export function move(rows: TreeRow[], id: string, drop: Drop): TreeRow[] {
  const from = rows.findIndex((r) => r.id === id)
  if (from < 0) return rows

  const n = blockLength(rows, from)
  const block = rows.slice(from, from + n)
  const rest = [...rows.slice(0, from), ...rows.slice(from + n)]
  const kind = block[0].kind

  // The gap is given against the displayed rows, which still contain the block
  // being dragged. Anything past it shifts back by the block's length, and a
  // gap *inside* the block means "leave it where it is".
  let j = drop.index <= from ? drop.index : drop.index >= from + n ? drop.index - n : from

  // Never out of its own kind. Spending and income are two lists that happen to
  // be drawn one above the other, and a subcategory must match its parent.
  const first = rest.findIndex((r) => r.kind === kind)
  if (first < 0) {
    // Nothing of this kind left to sit beside — the block is the whole of it.
    j = kind === 'expense' ? 0 : rest.length
  } else {
    let last = first
    while (rest[last + 1]?.kind === kind) last++
    j = Math.max(first, Math.min(j, last + 1))
  }

  let depth = drop.depth
  // A parent with children cannot become one.
  if (n > 1) depth = 0

  if (depth === 1 && rest[j - 1]?.kind !== kind) {
    // The gap is at the very start of this kind's range, so there is nothing
    // above to belong to — which happens whenever a subcategory is dragged
    // clean out of its own list and clamped back. Slide it just inside the
    // first parent of its kind rather than silently promoting it: the drag was
    // nonsense, and promotion is a change nobody asked for.
    const first0 = rest.findIndex((r) => r.kind === kind && r.depth === 0)
    if (first0 >= j) j = first0 + 1
    else depth = 0
  }

  // A top-level row may not land in the middle of somebody's children, which
  // would separate a parent from the rest of its family. Snap to the nearer end
  // of the family it landed inside — its parent's own row, or past its last
  // child. Anywhere between the two is not a position a top-level row has.
  if (depth === 0 && rest[j]?.depth === 1) {
    let start = j - 1
    while (start >= 0 && rest[start].depth === 1) start--
    start = Math.max(0, start)
    let end = j
    while (rest[end]?.depth === 1) end++
    j = j - start <= end - j ? start : end
  }

  const next = [...rest.slice(0, j), { ...block[0], depth }, ...block.slice(1), ...rest.slice(j)]
  return same(rows, next) ? rows : next
}

const same = (a: TreeRow[], b: TreeRow[]) =>
  a.length === b.length && a.every((r, i) => r.id === b[i].id && r.depth === b[i].depth)

export interface CategoryPatch {
  id: string
  patch: Record<string, unknown>
}

/**
 * The smallest set of writes that makes `next` true.
 *
 * `sortOrder` is the row's position in the whole flattened list rather than its
 * index among its siblings. Parents and their children are contiguous and
 * increasing either way, so `grouped()` reads it identically — and one number
 * per row means a move can never leave two rows claiming the same position.
 *
 * A key present with `undefined` CLEARS the column (see mapping.ts); that is
 * how a demoted category gives up its own colour and goes back to inheriting.
 */
export function writesFor(next: TreeRow[], categories: Category[]): CategoryPatch[] {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const out: CategoryPatch[] = []
  let parentId: string | undefined

  next.forEach((row, i) => {
    const cat = byId.get(row.id)
    if (!cat) return
    if (row.depth === 0) parentId = row.id
    const wanted = row.depth === 1 ? parentId : undefined

    const patch: Record<string, unknown> = {}
    if (cat.sortOrder !== i) patch.sortOrder = i
    if ((cat.parentId ?? undefined) !== wanted) {
      patch.parentId = wanted
      if (wanted === undefined) {
        // Promoted. The style it has been drawing with all along was its old
        // parent's; it keeps exactly that, so the change of rank does not also
        // change its appearance — and the constraint is satisfied.
        const style = styleOf(cat, byId)
        patch.icon = style.icon
        patch.slot = style.slot
      } else {
        // Demoted. Null means inherit, which is what makes a parent and its
        // children look like a set.
        patch.icon = undefined
        patch.slot = undefined
      }
    }
    if (Object.keys(patch).length > 0) out.push({ id: row.id, patch })
  })

  return out
}

/**
 * Where the arrow keys move a row.
 *
 * Block-aware rather than a plain index step: moving a parent up must clear the
 * whole family above it, or the first press would bury it among their children
 * and the second would bring it back out.
 *
 * Returns null where the move has nowhere to go — the top of its kind, or a
 * subcategory being asked to step above its own parent, which is what
 * `outdent` is for.
 */
export function keyboardTarget(rows: TreeRow[], id: string, dir: 'up' | 'down'): Drop | null {
  const from = rows.findIndex((r) => r.id === id)
  if (from < 0) return null
  const row = rows[from]
  const n = blockLength(rows, from)

  if (dir === 'up') {
    const above = rows[from - 1]
    if (!above || above.kind !== row.kind) return null
    if (row.depth === 1) return above.depth === 1 ? { index: from - 1, depth: 1 } : null
    // Top level: step over the whole block above, children included.
    let start = from - 1
    while (rows[start]?.depth === 1) start--
    return { index: start, depth: 0 }
  }

  const after = rows[from + n]
  if (!after || after.kind !== row.kind) return null
  if (row.depth === 1) return after.depth === 1 ? { index: from + 2, depth: 1 } : null
  return { index: from + n + blockLength(rows, from + n), depth: 0 }
}
