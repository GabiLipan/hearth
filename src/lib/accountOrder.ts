import type { Account } from './db'

/**
 * Rearranging accounts: what a drag means, and what it has to write.
 *
 * A flat cousin of `lib/categoryTree.ts`. Everything the category drag needs to
 * reason about depth, kinds and families falls away here — an account has no
 * parent and no half of the list it may not cross — so what is left is one
 * index calculation, kept out of the gesture for the same reason: an index
 * calculation is testable and a drag controller is not.
 *
 * ## Why accounts had no order at all until now
 *
 * `accounts.sortOrder` has existed since the first schema and nothing has ever
 * written anything but the column default. Every account sat at 0, so the list
 * fell back to Dexie's tie-break — primary-key order over client-generated
 * uuids, which is the `toArray()[0]` trap applied to a whole screen. The order
 * was stable, arbitrary, and changed if you deleted an account and made it
 * again. `byOrder` breaks the remaining ties by name so that a household that
 * has never dragged anything still reads alphabetically rather than randomly.
 *
 * ## Why a reorder needs the whole list writable
 *
 * `sortOrder` is a column on the account row, so writing one is an ordinary
 * `accounts_update` and needs `manage`. A move renumbers every row it passes —
 * with every account at 0 there is no spare numbering to slot into — so a drag
 * over an account somebody else manages would queue a write the server refuses,
 * and writes here fail late and quietly. `AccountList` therefore offers the
 * handles only when you can manage all of them; see `canManageAccount`.
 */

/**
 * The order the app reads accounts in: their stored position, then their name.
 *
 * The name is the tie-break rather than the id because every account starts at
 * 0 and most households will never drag one. See the note above.
 */
export const byOrder = (a: Pick<Account, 'sortOrder' | 'name'>, b: Pick<Account, 'sortOrder' | 'name'>) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)

/**
 * The list as it would be after the drop.
 *
 * `index` is a gap in the DISPLAYED rows — 0 before the first, `ids.length`
 * after the last — which still contain the row being dragged, because nothing
 * has reflowed under the finger. Returns the list unchanged when the drop is a
 * no-op, so a caller can compare by identity to decide whether anything is
 * worth writing.
 */
export function move(ids: string[], id: string, index: number): string[] {
  const from = ids.indexOf(id)
  if (from < 0) return ids
  const j = index <= from ? index : index - 1
  if (j === from || j < 0 || j > ids.length - 1) return ids
  const rest = [...ids.slice(0, from), ...ids.slice(from + 1)]
  return [...rest.slice(0, j), id, ...rest.slice(j)]
}

export interface AccountPatch {
  id: string
  patch: { sortOrder: number }
}

/**
 * The smallest set of writes that makes `next` true.
 *
 * One number per row — its position in the whole list — so a move can never
 * leave two accounts claiming the same place. Rows already sitting on their
 * number are left alone, which on the first ever drag is at most one of them:
 * everything starts at 0.
 */
export function writesFor(next: string[], accounts: Account[]): AccountPatch[] {
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const out: AccountPatch[] = []
  next.forEach((id, i) => {
    const account = byId.get(id)
    if (account && account.sortOrder !== i) out.push({ id, patch: { sortOrder: i } })
  })
  return out
}

/**
 * Where the arrow keys move a row: the gap above the row before it, or the gap
 * below the row after it. Null at either end, where there is nowhere to go.
 */
export function keyboardTarget(ids: string[], id: string, dir: 'up' | 'down'): number | null {
  const from = ids.indexOf(id)
  if (from < 0) return null
  if (dir === 'up') return from === 0 ? null : from - 1
  return from === ids.length - 1 ? null : from + 2
}
