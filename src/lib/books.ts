import type { Account, AccountGrant, Category, Transaction } from './db'
import { atLeast } from './accounts'
import { budgetCategoryId, styleOf } from './categories'
import { monthKey, monthLabel, shiftMonth, thisMonthKey } from './dates'
import { OTHER_SLICE_ID, type CategorySlice } from './stats'

/**
 * Books.
 *
 * The app used to have exactly one scope — "every transaction this device can
 * see" — and every total was computed over it. For a couple with a joint
 * account and a private account each, that scope is not a thing. It is the
 * household's money plus one person's money, added together, and it produces a
 * different number on each of their screens with nothing on either to say why.
 *
 * So: three sets of books, never summed.
 *
 *   household — the accounts both of us are on
 *   mine      — the accounts only I am on
 *   theirs    — invisible, by design, and therefore not a book this device has
 *
 * The rule that makes it work is about transfers. Today a transfer is *nothing*:
 * both legs excluded from everything. Here it depends on where the two legs
 * land:
 *
 *   - both legs in one book (joint current → joint savings) — still nothing
 *   - legs in different books (my private → joint) — an outflow from mine and
 *     income to the household's
 *
 * Because the books are never added together, counting a crossing twice — once
 * on each side — is correct rather than a double count.
 *
 * Two properties fall out of this, and both are the reason it was chosen over
 * the alternatives:
 *
 *   1. The household book is complete and IDENTICAL on both devices, without
 *      either person seeing the other's salary. Every leg it needs is a
 *      transaction in a joint account, which both of them can read.
 *   2. The household book is right even before anything is linked. An unlinked
 *      £1,800 arriving in the joint account counts as household income either
 *      way; linking only relabels it from "other income" to "her contribution".
 *      Linking matters for the PERSONAL book, and each person can do their own
 *      without the other.
 */

export type BookId = 'household' | 'mine' | 'all'

export const BOOK_LABEL: Record<BookId, string> = {
  household: 'Our household',
  mine: 'Mine',
  all: 'Everything',
}

/**
 * How each book describes itself.
 *
 * The words are not decoration, and they live here rather than on a page so the
 * dashboard and Reports cannot drift into describing the same figure two ways.
 * On the household book "income" is the money we each put in and "net" is
 * literally what we saved — every account is inside the book, so nothing leaves
 * except by being spent. On the personal book "net" is what is still sitting in
 * my account after contributing and spending, and contributing is neither of
 * those. Calling both of them "Income" and "Net" is how the old single-scope
 * page managed to be wrong in two directions at once.
 */
export const BOOK_WORDS: Record<BookId, { income: string; spend: string; net: string; netHint: string }> = {
  household: {
    income: 'Paid in',
    spend: 'Household spending',
    net: 'Left over',
    netHint:
      'What we put in, minus what the household spent. Every account is inside this book, so this is what we actually saved.',
  },
  mine: {
    income: 'Earned',
    spend: 'Personal spending',
    net: 'Left with me',
    netHint:
      'Salary minus what I moved to the household and what I spent on myself. Contributing is not spending.',
  },
  all: {
    income: 'Money in',
    spend: 'Money out',
    net: 'Net',
    netHint: 'Every account this device can see, added together. Transfers between them cancel out.',
  },
}

export const BOOK_HINT: Record<BookId, string> = {
  household: 'The accounts we are both on. What we each put in, and what the household spent.',
  mine: 'My own accounts. My salary, what I contributed, and what I spent personally.',
  all: 'Every account this device can see, added together. Useful for balances; not a meaningful income figure.',
}

/**
 * Which book each account belongs to.
 *
 * Derived from grants rather than stored, so there is nothing to configure and
 * nothing that can disagree with the permissions that are already there.
 *
 * `household` needs two people at `view` or above — deliberately not "any
 * grant", so that granting a partner `balance` on a private account for
 * reassurance does not silently reclassify it as shared. Seeing the total is
 * not being on the account.
 *
 * `mine` requires owner level as well as being alone on it. Without that,
 * an account somebody shared with me at `view` would look like mine: the
 * sharing list I can read below `manage` is only ever my own grant, so "one
 * grant" and "one person" are not the same question. Such accounts land in
 * neither book and appear only under Everything.
 */
export interface BookMap {
  household: Set<string>
  mine: Set<string>
  /** Someone else's, shared with me. In no book of mine. */
  others: Set<string>
}

export function classifyAccounts(
  accounts: Account[],
  grantsByAccount: Map<string, AccountGrant[]>,
  userId: string | undefined,
): BookMap {
  const household = new Set<string>()
  const mine = new Set<string>()
  const others = new Set<string>()

  for (const a of accounts) {
    const grants = grantsByAccount.get(a.id) ?? []
    const onIt = new Set(grants.filter((g) => atLeast(g.level, 'view')).map((g) => g.userId))
    // A freshly created account has no grant yet — the server writes the
    // creator's from an AFTER trigger — so anything counting grants has to floor
    // itself at "you" rather than concluding nobody is on it.
    const justMade = !!userId && a.createdBy === userId
    if (justMade) onIt.add(userId!)

    const iOwnIt = justMade || grants.some((g) => g.userId === userId && g.level === 'owner')

    if (onIt.size >= 2) household.add(a.id)
    // Ownership, not just presence. One grant is not the same as one person:
    // below `manage` the only grant I can read is my own, so an account
    // somebody shared with me at `view` looks exactly like an account nobody
    // else is on. Requiring `owner` tells the two apart.
    else if (iOwnIt) mine.add(a.id)
    else others.add(a.id)
  }
  return { household, mine, others }
}

/** The accounts a book is made of. `all` is everything this device can see. */
export function accountsInBook(book: BookId, books: BookMap): Set<string> {
  if (book === 'household') return books.household
  if (book === 'mine') return books.mine
  return new Set([...books.household, ...books.mine, ...books.others])
}

/* ---------- what one transaction is ---------- */

export type Flow =
  /** Money one of us put into the household from a private account. */
  | 'contribution'
  /** Money paid into a joint account from outside the household entirely. */
  | 'external-income'
  /** The household spending its money. */
  | 'household-spend'
  /** Money taken back out of the household into a private account. */
  | 'withdrawal'
  /** My salary, or anything else arriving from outside. */
  | 'personal-income'
  /** What I spent on myself. */
  | 'personal-spend'
  /** Both legs in the same book: joint current → joint savings. Not an event. */
  | 'internal'
  /** In no book of mine, or a transfer whose far leg makes no sense. */
  | 'ignored'

/** Which book an account id sits in, or undefined for one that is nobody's business here. */
function bookOf(accountId: string, books: BookMap): 'household' | 'mine' | undefined {
  if (books.household.has(accountId)) return 'household'
  if (books.mine.has(accountId)) return 'mine'
  return undefined
}

/**
 * Classify every transaction at once.
 *
 * Done in bulk rather than one at a time because a transfer's meaning depends
 * on its OTHER leg, which means an index of legs by `transferId` — and building
 * that per transaction would be quadratic over the whole history.
 *
 * The interesting case is a leg whose partner is missing. That is not a bug: a
 * contribution from my partner's private account has its far leg in an account
 * I am not on and will never pull. The incoming leg in the joint account is all
 * I get, and it is enough — money arrived in the household from outside the
 * household's own accounts, which is exactly what a contribution is.
 */
export function classifyFlows(txns: Transaction[], books: BookMap): Map<string, Flow> {
  const legs = new Map<string, Transaction[]>()
  for (const t of txns) {
    if (!t.transferId) continue
    const list = legs.get(t.transferId)
    if (list) list.push(t)
    else legs.set(t.transferId, [t])
  }

  const out = new Map<string, Flow>()
  for (const t of txns) {
    const here = bookOf(t.accountId, books)
    if (!here) {
      out.set(t.id, 'ignored')
      continue
    }

    if (t.transferId) {
      const partner = legs.get(t.transferId)?.find((l) => l.id !== t.id)
      // `undefined` means two different things here, and they are kept apart:
      // no partner ROW at all (an account I am not on — in a household of two,
      // my partner's private account), versus a partner row in an account that
      // is in neither of my books.
      const there = partner ? bookOf(partner.accountId, books) : undefined
      const unseen = !partner

      if (partner && there === here) {
        out.set(t.id, 'internal')
        continue
      }
      if (here === 'household') {
        // Crossing out of the household, or in from a private account —
        // including one I will never see, which is precisely a contribution.
        out.set(t.id, t.amountMinor > 0 ? 'contribution' : 'withdrawal')
        continue
      }
      // My account. Crossing into the household is a contribution; anything
      // else is a transfer between my own accounts, or one whose far leg makes
      // no sense from here. I can see all of my own accounts, so `unseen` on
      // this side should not happen — refusing to guess beats calling it income.
      if (there === 'household') {
        out.set(t.id, t.amountMinor < 0 ? 'contribution' : 'withdrawal')
      } else {
        out.set(t.id, unseen ? 'ignored' : 'internal')
      }
      continue
    }

    if (here === 'household') {
      out.set(t.id, t.amountMinor > 0 ? 'external-income' : 'household-spend')
    } else {
      out.set(t.id, t.amountMinor > 0 ? 'personal-income' : 'personal-spend')
    }
  }
  return out
}

/* ---------- aggregates ---------- */

export interface BookTotals {
  /** Everything that came in, whatever the source. */
  income: number
  /** Household only: what we each put in this month. Positive. */
  contributions: number
  /** Money from outside the household: household grants, or my salary. Positive. */
  externalIncome: number
  /** Mine only: money that came back out of the household to me. Positive. */
  returned: number
  /** Money actually spent. Positive. */
  spend: number
  /** Mine only: what I moved to the household. Positive, and NOT spending. */
  contributed: number
  /** Household only: what was taken back out into a private account. Positive. */
  withdrawn: number
  /**
   * What is left. For a book whose accounts this device can all see, this is
   * literally the change in its balances over the month — which is why, for the
   * household book, "net" and "saved" are finally the same number.
   */
  net: number
}

const EMPTY: BookTotals = {
  income: 0,
  contributions: 0,
  externalIncome: 0,
  returned: 0,
  spend: 0,
  contributed: 0,
  withdrawn: 0,
  net: 0,
}

/**
 * One month of a book. `month` is a yyyy-MM key.
 *
 * Rows are selected by ACCOUNT, not by flow. That distinction is load-bearing:
 * a contribution exists as two rows, one in my private account and one in the
 * joint account, and they are the same event seen from each end. Filtering by
 * flow alone counted both of them into both books, which inflated my salary by
 * my partner's contribution and turned the household's net negative.
 */
export function bookTotals(
  txns: Transaction[],
  flows: Map<string, Flow>,
  book: BookId,
  month: string,
  books: BookMap,
): BookTotals {
  const t = { ...EMPTY }
  const ids = accountsInBook(book, books)

  for (const row of txns) {
    if (!ids.has(row.accountId)) continue
    if (monthKey(row.date) !== month) continue
    const flow = flows.get(row.id)
    if (!flow || flow === 'internal' || flow === 'ignored') continue
    // Under `all`, my private account and the joint account are one pool, so a
    // contribution is internal again and both its legs are present. Counting it
    // would be exactly the double count the books exist to prevent.
    if (book === 'all' && (flow === 'contribution' || flow === 'withdrawal')) continue

    switch (flow) {
      case 'contribution':
        // Positive on the household side, negative on mine — the same event
        // seen from each end, which is the whole point of the model.
        if (row.amountMinor > 0) t.contributions += row.amountMinor
        else t.contributed -= row.amountMinor
        break
      case 'withdrawal':
        // Kept apart from salary, so "Earned" on the personal book stays a
        // figure about work rather than one that moves when we reimburse
        // ourselves out of the joint account.
        if (row.amountMinor > 0) t.returned += row.amountMinor
        else t.withdrawn -= row.amountMinor
        break
      case 'external-income':
      case 'personal-income':
        t.externalIncome += row.amountMinor
        break
      case 'household-spend':
      case 'personal-spend':
        t.spend -= row.amountMinor
        break
    }
  }
  t.income = t.contributions + t.externalIncome + t.returned
  t.net = t.income - t.spend - t.contributed - t.withdrawn
  return t
}

/** Whether a transaction is spending, for this book. */
export function isSpend(flow: Flow | undefined): boolean {
  return flow === 'household-spend' || flow === 'personal-spend'
}

export interface BookMonth extends BookTotals {
  key: string
  label: string
}

/** The last `n` months of a book, oldest first. */
export function bookSeries(
  txns: Transaction[],
  flows: Map<string, Flow>,
  book: BookId,
  n: number,
  books: BookMap,
  endingAt = thisMonthKey(),
): BookMonth[] {
  const keys: string[] = []
  for (let i = n - 1; i >= 0; i--) keys.push(shiftMonth(endingAt, -i))
  return keys.map((key) => ({
    key,
    label: monthLabel(key, 'short'),
    ...bookTotals(txns, flows, book, key, books),
  }))
}

/**
 * Spend per category for one book and month, ready for the donut.
 *
 * Separate from `spendByCategory` in stats.ts rather than a parameter on it,
 * because the question is different: that one asks "what did everything I can
 * see cost", this one asks "what did THIS book spend". Handing the old one a
 * filtered list would nearly work and would quietly include a contribution as
 * an uncategorised expense.
 *
 * `drillInto` switches from parents to the children of one parent, which is the
 * subcategory view — the same rollup rule as the Budgets page, one level down.
 */
export function bookSpendByCategory(
  txns: Transaction[],
  flows: Map<string, Flow>,
  categories: Category[],
  book: BookId,
  month: string,
  books: BookMap,
  drillInto?: string,
): { categoryId: string; totalMinor: number }[] {
  const catMap = new Map(categories.map((c) => [c.id, c]))
  const totals = new Map<string, number>()
  const ids = accountsInBook(book, books)

  for (const t of txns) {
    if (!ids.has(t.accountId)) continue
    if (!isSpend(flows.get(t.id)) || !t.categoryId || monthKey(t.date) !== month) continue
    const cat = catMap.get(t.categoryId)
    if (!cat || cat.kind !== 'expense') continue

    if (drillInto) {
      // Inside a parent: children keep their own identity, and spending booked
      // straight on the parent stays visible as the parent rather than being
      // dropped — otherwise the drill-down's total would not match the slice
      // that was clicked, which reads as a bug even when both are right.
      if (budgetCategoryId(cat) !== drillInto) continue
      totals.set(cat.id, (totals.get(cat.id) ?? 0) - t.amountMinor)
    } else {
      const key = budgetCategoryId(cat)!
      totals.set(key, (totals.get(key) ?? 0) - t.amountMinor)
    }
  }
  return [...totals.entries()]
    .map(([categoryId, totalMinor]) => ({ categoryId, totalMinor }))
    .sort((a, b) => b.totalMinor - a.totalMinor)
}

/**
 * The same, shaped for the donut: names, colours and shares resolved.
 *
 * Kept apart from `bookSpendByCategory` so the arithmetic stays testable
 * without a category palette. The small tail folds into "Other" at the top
 * level only — inside a drill-down every child is worth seeing, and folding
 * there would produce an "Other" inside "Home & utilities" that nobody could
 * click into.
 */
export function bookSlices(
  txns: Transaction[],
  flows: Map<string, Flow>,
  categories: Category[],
  book: BookId,
  month: string,
  books: BookMap,
  drillInto?: string,
  maxSlices = 8,
): CategorySlice[] {
  const catMap = new Map(categories.map((c) => [c.id, c]))
  const rows = bookSpendByCategory(txns, flows, categories, book, month, books, drillInto)
  const grand = rows.reduce((s, r) => s + r.totalMinor, 0)
  if (grand === 0) return []

  const slices: CategorySlice[] = rows.map(({ categoryId, totalMinor }) => {
    const c = catMap.get(categoryId)!
    const style = styleOf(c, catMap)
    return {
      categoryId,
      name: c.name,
      icon: style.icon,
      slot: style.slot,
      totalMinor,
      fraction: totalMinor / grand,
    }
  })
  if (drillInto || slices.length <= maxSlices) return slices

  const head = slices.slice(0, maxSlices - 1)
  const tail = slices.slice(maxSlices - 1)
  const tailTotal = tail.reduce((s, v) => s + v.totalMinor, 0)
  head.push({
    categoryId: OTHER_SLICE_ID,
    name: 'Other',
    icon: 'package',
    slot: 0,
    totalMinor: tailTotal,
    fraction: tailTotal / grand,
  })
  return head
}

/** Does this category have children worth drilling into, in this month's data? */
export function hasBreakdown(
  categoryId: string,
  txns: Transaction[],
  flows: Map<string, Flow>,
  categories: Category[],
  book: BookId,
  month: string,
  books: BookMap,
): boolean {
  return bookSpendByCategory(txns, flows, categories, book, month, books, categoryId).length > 1
}
