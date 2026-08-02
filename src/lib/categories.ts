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
}

const FALLBACK: CategoryStyle = { icon: 'tag', slot: 1 }

/** The icon and colour to draw a category with, resolved through its parent. */
export function styleOf(category: Category | undefined, byId: Map<string, Category>): CategoryStyle {
  if (!category) return FALLBACK
  if (category.icon != null && category.slot != null) {
    return { icon: category.icon, slot: category.slot }
  }
  const parent = category.parentId ? byId.get(category.parentId) : undefined
  return {
    icon: category.icon ?? parent?.icon ?? FALLBACK.icon,
    slot: category.slot ?? parent?.slot ?? FALLBACK.slot,
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
 * A personal category is only valid on a non-shared account its owner owns —
 * the database refuses anything else, so the picker must not offer it.
 */
export function usableOn(
  categories: Category[],
  account: { visibility: string; ownerId?: string } | undefined,
  myUserId: string | undefined,
): Category[] {
  return categories.filter((c) => {
    if (!c.ownerId) return true
    if (c.ownerId !== myUserId) return false
    return !!account && account.visibility !== 'shared' && account.ownerId === c.ownerId
  })
}
