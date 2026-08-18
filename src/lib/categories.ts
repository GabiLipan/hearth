import type { Category } from './db'

/**
 * Subcategory helpers.
 *
 * A subcategory stores no icon or colour of its own; null means "inherit". That
 * is what keeps a parent and its children looking like a set — change the
 * parent's colour and the children follow, instead of drifting apart the way
 * copied values would.
 *
 * Nesting is one level deep, enforced by the database, so every lookup here is
 * a single hop rather than a walk.
 */

export interface CategoryStyle {
  icon: string
  slot: number
  /** A colour of its own, overriding the slot. Inherited by a subcategory. */
  color?: string
}

const FALLBACK: CategoryStyle = { icon: 'tag', slot: 1 }

/** The icon and colour to draw a category with, resolved through its parent. */
export function styleOf(category: Category | undefined, byId: Map<string, Category>): CategoryStyle {
  if (!category) return FALLBACK
  const parent = category.parentId ? byId.get(category.parentId) : undefined
  return {
    icon: category.icon ?? parent?.icon ?? FALLBACK.icon,
    slot: category.slot ?? parent?.slot ?? FALLBACK.slot,
    // A custom colour inherits the same way, and for the same reason: a parent
    // recoloured by hand takes its children with it rather than leaving them on
    // the palette slot underneath.
    color: category.color ?? (category.slot == null ? parent?.color : undefined),
  }
}

/**
 * Which category a transaction counts towards for budgeting: the parent if it
 * has one. Budgets live on top-level categories only, so spending on
 * "Insurance" counts against "Home & utilities".
 */
export const budgetCategoryId = (category: Category | undefined): string | undefined =>
  category ? (category.parentId ?? category.id) : undefined

export const isTopLevel = (c: Category) => !c.parentId

export const topLevel = (categories: Category[]) => categories.filter(isTopLevel)

export const childrenOf = (categories: Category[], parentId: string) =>
  categories.filter((c) => c.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder)

/** Parents each followed by their own children — the order every picker shows. */
export function grouped(categories: Category[]): { parent: Category; children: Category[] }[] {
  return topLevel(categories)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((parent) => ({ parent, children: childrenOf(categories, parent.id) }))
}

/** "Home & utilities · Insurance", for anywhere a subcategory appears out of context. */
export function fullName(category: Category, byId: Map<string, Category>): string {
  const parent = category.parentId ? byId.get(category.parentId) : undefined
  return parent ? `${parent.name} · ${category.name}` : category.name
}

/**
 * The categories usable when recording against a given account.
 *
 * A personal category is only valid on an account nobody else can see — since
 * migration 07 that means an account whose only grant is its owner's. The
 * database refuses anything else (`personal_category_guard`), so the picker
 * must not offer it.
 *
 * `grants` is every grant on that account. For an account you own you see them
 * all, which is the only case where a personal category could apply anyway.
 */
export function usableOn(
  categories: Category[],
  grants: { userId: string }[],
  myUserId: string | undefined,
): Category[] {
  const mineAlone = grants.length === 1 && !!myUserId && grants[0].userId === myUserId
  return categories.filter((c) => {
    if (!c.ownerId) return true
    if (c.ownerId !== myUserId) return false
    return mineAlone
  })
}
