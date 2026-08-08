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
  /**
   * Spending on the household, paid from a personal account.
   *
   * The only flow that is TWO events rather than one: a contribution out of the
   * payer's book and household spending in the household's. See
   * `13-paid-for-household.sql` for the reasoning, and `bookTotals` for the one
   * place it has to break the by-account selection rule.
   */
  | 'paid-for-household'
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
    } else if (t.paidForHousehold && t.amountMinor < 0) {
      // Money OUT of a personal account only. A refund arriving back on the
      // card is not a contribution to anything, and flagging one would credit
      // the household with money it never had.
      out.set(t.id, 'paid-for-household')
    } else {
      out.set(t.id, t.amountMinor > 0 ? 'personal-income' : 'personal-spend')
    }
  }
  return out
}

/* ---------- which month a contribution belongs to ---------- */

/**
 * Contributions on or after this day of the month count towards the NEXT month.
 *
 * We fund the joint account when we are paid, at the end of one month, and
 * spend it during the next. Every calendar month does therefore contain one
 * contribution and one month of spending — nothing is missing — but they are
 * the wrong pair: August's spending is funded by the money that arrived on 31
 * July, while August's own arrival pays for September.
 *
 * Left alone, that is visible twice. The monthly income-versus-spending chart
 * compares spending against money it did not spend; and for most of the month
 * the household reads as though it has spent thousands against nothing, because
 * its income has not turned up yet and will not until the 31st.
 *
 * Shifting the contribution is the smallest fix that addresses both. Spending
 * keeps its real date, so statements still reconcile and nothing else in the
 * app moves; only the money that was always *for* the following month is
 * counted there.
 */
export const CONTRIBUTION_CUTOFF_DAY = 25

/**
 * The month a transaction counts towards, which is not always the month it
 * happened in.
 *
 * Applied to both legs of a contribution, so my book and the household's agree
 * about when it happened — the same event must not land in different months on
 * either side of it. Each month still contains exactly one salary and exactly
 * one contribution; the pairing is simply corrected by one.
 *
 * NOT applied to withdrawals. Money coming back out of the household is a
 * response to something, not a regular advance, so there is no next month it is
 * obviously "for".
 */
export function effectiveMonth(t: Transaction, flow: Flow | undefined): string {
  if (flow !== 'contribution') return monthKey(t.date)
  const day = Number(t.date.slice(8, 10))
  if (day < CONTRIBUTION_CUTOFF_DAY) return monthKey(t.date)
  return shiftMonth(monthKey(t.date), 1)
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
    const flow = flows.get(row.id)

    /**
     * The one exception to selecting rows by ACCOUNT, and it is deliberately
     * written before that filter rather than inside it.
     *
     * Selecting by account is what stops a contribution being counted into both
     * books — see the note on this function. This row genuinely belongs to two
     * books at once: it is money leaving a personal account (a contribution)
     * and money the household spent. So it is admitted to the household book
     * despite living outside it, and to the payer's book as a contribution
     * rather than as spending.
     *
     * The exception cannot widen, because it is gated on a flow that only
     * `classifyFlows` can produce and only for a negative row in a personal
     * account.
     *
     * The honest limit: the household book is normally IDENTICAL on both our
     * screens, because every row it needs is in a joint account we can both
     * read. This one is not — a row in a private account is invisible to the
     * other person, so a household expense paid privately appears in the
     * household book only for people who can see the account it was paid from.
     */
    if (flow === 'paid-for-household') {
      if (effectiveMonth(row, flow) !== month) continue
      const amount = -row.amountMinor
      if (book === 'household') {
        // Received and spent in the same breath: net unchanged, but the
        // category figure is now the household's real one.
        t.contributions += amount
        t.spend += amount
      } else if (ids.has(row.accountId)) {
        // The payer's own book, or Everything. Under `all` my account and the
        // joint one are a single pool, so the contribution is internal again
        // and what is left is simply spending.
        if (book === 'all') t.spend += amount
        else t.contributed += amount
      }
      continue
    }

    if (!ids.has(row.accountId)) continue
    if (!flow || flow === 'internal' || flow === 'ignored') continue
    // Not `monthKey(row.date)`: a contribution counts towards the month it was
    // FOR, which for money moved at the end of one month is the next one.
    if (effectiveMonth(row, flow) !== month) continue
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

/**
 * The same figures over an arbitrary run of days.
 *
 * Deliberately NOT built out of `bookTotals`. A range that does not align to a
 * month cannot use `effectiveMonth`: the 25th cut-off exists to move a
 * contribution into the month it is FOR, and "the month it is for" is a
 * question a fortnight in the middle of March cannot answer. So this counts
 * money on the day it actually moved, and the screen says so — the alternative
 * is a shifted contribution silently landing inside or outside a range the
 * person drew by hand, which is the sort of wrongness nobody can see.
 *
 * Everything else is `bookTotals` unchanged, including the rule that rows are
 * selected by ACCOUNT rather than by flow.
 */
export function bookTotalsInRange(
  txns: Transaction[],
  flows: Map<string, Flow>,
  book: BookId,
  books: BookMap,
  /** Both inclusive, `yyyy-MM-dd`. */
  from: string,
  to: string,
): BookTotals {
  const t = { ...EMPTY }
  const ids = accountsInBook(book, books)

  for (const row of txns) {
    if (row.date < from || row.date > to) continue
    const flow = flows.get(row.id)

    // The same exception as `bookTotals` — see the long note there.
    if (flow === 'paid-for-household') {
      const amount = -row.amountMinor
      if (book === 'household') {
        t.contributions += amount
        t.spend += amount
      } else if (ids.has(row.accountId)) {
        if (book === 'all') t.spend += amount
        else t.contributed += amount
      }
      continue
    }

    if (!ids.has(row.accountId)) continue
    if (!flow || flow === 'internal' || flow === 'ignored') continue
    if (book === 'all' && (flow === 'contribution' || flow === 'withdrawal')) continue

    switch (flow) {
      case 'contribution':
        if (row.amountMinor > 0) t.contributions += row.amountMinor
        else t.contributed -= row.amountMinor
        break
      case 'withdrawal':
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

/** Spend per category over a run of days. The range twin of `bookSpendByCategory`. */
export function bookSpendByCategoryInRange(
  txns: Transaction[],
  flows: Map<string, Flow>,
  categories: Category[],
  book: BookId,
  books: BookMap,
  from: string,
  to: string,
  drillInto?: string,
): { categoryId: string; totalMinor: number }[] {
  const catMap = new Map(categories.map((c) => [c.id, c]))
  const totals = new Map<string, number>()
  const ids = accountsInBook(book, books)

  for (const t of txns) {
    if (t.date < from || t.date > to) continue
    if (!spendsIn(flows.get(t.id), book, t.accountId, ids)) continue
    if (!t.categoryId) continue
    const cat = catMap.get(t.categoryId)
    if (!cat || cat.kind !== 'expense') continue

    if (drillInto) {
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
 * Several months as one set of figures — a year, or any run of them.
 *
 * Every field of `BookTotals` is a sum over its month except `income` and
 * `net`, which are derived from the others; adding those directly would be
 * adding the same money twice, so they are recomputed here from the totals
 * exactly as `bookTotals` computes them from the rows.
 */
export function sumBookTotals(parts: BookTotals[]): BookTotals {
  const t = { ...EMPTY }
  for (const p of parts) {
    t.contributions += p.contributions
    t.externalIncome += p.externalIncome
    t.returned += p.returned
    t.spend += p.spend
    t.contributed += p.contributed
    t.withdrawn += p.withdrawn
  }
  t.income = t.contributions + t.externalIncome + t.returned
  t.net = t.income - t.spend - t.contributed - t.withdrawn
  return t
}

/** Whether a transaction is spending at all, regardless of whose. */
export function isSpend(flow: Flow | undefined): boolean {
  return flow === 'household-spend' || flow === 'personal-spend'
}

/**
 * Whether a row counts as spending IN A PARTICULAR BOOK.
 *
 * `isSpend` plus the by-account filter, in one place, because
 * `paid-for-household` makes the two questions come apart: that row is spending
 * in the household's book while living in an account outside it, and is not
 * spending in the payer's book at all — there it is a contribution.
 *
 * Every breakdown has to use this rather than rolling its own pair of
 * conditions, or the categories stop adding up to the total above them. That is
 * the failure it exists to prevent: a "£412 spent" heading over a donut of
 * £322, with nothing on the screen to explain the difference.
 */
export function spendsIn(
  flow: Flow | undefined,
  book: BookId,
  accountId: string,
  ids: Set<string>,
): boolean {
  if (flow === 'paid-for-household') {
    // Household: yes, that is the whole point. Everything: yes, but only
    // because the payer's account is in view — it is ordinary spending there.
    // Mine: no. I contributed it; the household spent it.
    return book === 'household' || (book === 'all' && ids.has(accountId))
  }
  return ids.has(accountId) && isSpend(flow)
}

/**
 * Who put what into the household this month.
 *
 * Only askable because of how the books work. Neither of us can see the other's
 * salary, but every contribution ARRIVES in a joint account, and joint accounts
 * are readable by both — so this is one figure that is complete and identical on
 * both screens.
 *
 * Attribution does not use `created_by`. That is whoever entered the row, which
 * for an imported statement is whoever did the importing, not whose money it
 * was. It uses the far leg instead:
 *
 *   - far leg in one of MY accounts → mine
 *   - far leg not visible at all    → somebody else's, because the only accounts
 *                                     hidden from me belong to the other people
 *                                     in the household
 *
 * The honest limit is `otherMinor`. An arrival nobody has linked to anything is
 * indistinguishable from money paid in from outside the household — both are
 * just a credit in the joint account — so the two share a bucket rather than
 * the app pretending it can tell a salary transfer from a tax refund. Linking
 * is what moves money out of that bucket and onto a name, and each of us can
 * only link our own.
 */
export interface ContributionSplit {
  mineMinor: number
  theirsMinor: number
  /** Outside income, plus any arrival nobody has linked yet. See above. */
  otherMinor: number
}

export function contributionSplit(
  txns: Transaction[],
  flows: Map<string, Flow>,
  month: string,
  books: BookMap,
): ContributionSplit {
  const legs = new Map<string, Transaction[]>()
  for (const t of txns) {
    if (!t.transferId) continue
    const list = legs.get(t.transferId)
    if (list) list.push(t)
    else legs.set(t.transferId, [t])
  }

  const out: ContributionSplit = { mineMinor: 0, theirsMinor: 0, otherMinor: 0 }

  for (const t of txns) {
    if (!books.household.has(t.accountId) || t.amountMinor <= 0) continue
    const flow = flows.get(t.id)
    if (effectiveMonth(t, flow) !== month) continue

    if (flow === 'external-income') {
      out.otherMinor += t.amountMinor
      continue
    }
    if (flow !== 'contribution') continue

    const partner = t.transferId ? legs.get(t.transferId)?.find((l) => l.id !== t.id) : undefined
    // No partner row means an account this device is not on, which in a
    // household is somebody else's private account.
    if (!t.transferId) out.otherMinor += t.amountMinor
    else if (!partner) out.theirsMinor += t.amountMinor
    else if (books.mine.has(partner.accountId)) out.mineMinor += t.amountMinor
    else out.otherMinor += t.amountMinor
  }
  return out
}

export interface BookMonth extends BookTotals {
  key: string
  label: string
  /** The month we are in, which has not finished. See `MonthPoint.partial`. */
  partial: boolean
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
  const now = thisMonthKey()
  const keys: string[] = []
  for (let i = n - 1; i >= 0; i--) keys.push(shiftMonth(endingAt, -i))
  return keys.map((key) => ({
    key,
    label: monthLabel(key, 'short'),
    // The month we are in has not finished. Anything comparing it against the
    // months either side of it has to say so — see `MonthPoint.partial`.
    partial: key === now,
    ...bookTotals(txns, flows, book, key, books),
  }))
}

/**
 * What the book's accounts held at the start of a month, and what they hold now.
 *
 * The figure the part-finished month actually needs. On the 8th, "Paid in
 * £0.57, spent £3,142, left over −£3,141" is arithmetically right and reads
 * like a disaster; "£4,200 at the start of the month, £1,058 now" is the same
 * month and is useful.
 *
 * Undefined rather than approximate when any account in the book is one this
 * device may only see the TOTAL of. A `balance`-level account gives us today's
 * figure from the server and no line items at all, so there is no way to wind
 * it back to the 1st — and quietly leaving that account out would produce a
 * "start" and a "now" measuring different sets of accounts, which is worse than
 * showing neither.
 */
export function bookBalances(
  accounts: Account[],
  txns: Transaction[],
  book: BookId,
  books: BookMap,
  month: string,
  canSeeRows: (accountId: string) => boolean,
): { startMinor: number; nowMinor: number } | undefined {
  const ids = accountsInBook(book, books)
  const mine = accounts.filter((a) => ids.has(a.id))
  if (mine.length === 0 || mine.some((a) => !canSeeRows(a.id))) return undefined

  const firstOfMonth = `${month}-01`
  let startMinor = 0
  let nowMinor = 0
  for (const a of mine) {
    startMinor += a.openingBalanceMinor
    nowMinor += a.openingBalanceMinor
  }
  for (const t of txns) {
    if (!ids.has(t.accountId)) continue
    nowMinor += t.amountMinor
    if (t.date < firstOfMonth) startMinor += t.amountMinor
  }
  return { startMinor, nowMinor }
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
  /** One month, or several — a year view asks the same question of twelve. */
  month: string | string[],
  books: BookMap,
  drillInto?: string,
): { categoryId: string; totalMinor: number }[] {
  const catMap = new Map(categories.map((c) => [c.id, c]))
  const totals = new Map<string, number>()
  const ids = accountsInBook(book, books)
  const want = new Set(Array.isArray(month) ? month : [month])

  for (const t of txns) {
    if (!spendsIn(flows.get(t.id), book, t.accountId, ids)) continue
    if (!t.categoryId || !want.has(monthKey(t.date))) continue
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
  month: string | string[],
  books: BookMap,
  drillInto?: string,
  maxSlices = 8,
): CategorySlice[] {
  return toSlices(
    bookSpendByCategory(txns, flows, categories, book, month, books, drillInto),
    categories,
    drillInto,
    maxSlices,
  )
}

/** The same, for a run of days. See `bookTotalsInRange` for why ranges are separate. */
export function rangeSlices(
  txns: Transaction[],
  flows: Map<string, Flow>,
  categories: Category[],
  book: BookId,
  books: BookMap,
  from: string,
  to: string,
  drillInto?: string,
  maxSlices = 8,
): CategorySlice[] {
  return toSlices(
    bookSpendByCategoryInRange(txns, flows, categories, book, books, from, to, drillInto),
    categories,
    drillInto,
    maxSlices,
  )
}

/**
 * Category totals, shaped for the donut: names, colours and shares resolved.
 *
 * Shared by the month and range versions rather than written twice — the two
 * differ in which rows they count, and not at all in what a slice looks like.
 * The small tail folds into "Other" at the TOP level only: inside a drill-down
 * every child is worth seeing, and folding there would produce an "Other"
 * inside "Home & utilities" that nobody could click into.
 */
function toSlices(
  rows: { categoryId: string; totalMinor: number }[],
  categories: Category[],
  drillInto: string | undefined,
  maxSlices: number,
): CategorySlice[] {
  const catMap = new Map(categories.map((c) => [c.id, c]))
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
  month: string | string[],
  books: BookMap,
): boolean {
  return bookSpendByCategory(txns, flows, categories, book, month, books, categoryId).length > 1
}
