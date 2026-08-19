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
 *
 *      With one exception, which is the reason migration 19 exists: a household
 *      thing paid out of somebody's own card is household spending that lives
 *      outside every joint account. That row is published — by consent, per
 *      account, and alone — so the property above survives it. Anything else
 *      that ever needs to count a row from an account this device is not on has
 *      to earn its way out of an account the same way.
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
    netHint:
      'Every account this device can see. Money moved between our books is counted in neither, because both legs are in view here — so this is not the other two books added together. "How the books add up" shows the arithmetic.',
  },
}

export const BOOK_HINT: Record<BookId, string> = {
  household: 'The accounts we are both on. What we each put in, and what the household spent.',
  mine: 'My own accounts. My salary, what I contributed, and what I spent personally.',
  all: 'Every account this device can see, and how the other two books reconcile against it.',
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
    /**
     * Said outright, and it wins.
     *
     * Deriving from grants is the rule and this is the escape hatch for the
     * cases where the rule is wrong — a joint account we treat as one person's,
     * or my own account that is really the household's float. Checked first so
     * the override is not something the derivation can quietly outvote.
     *
     * It changes nobody's ACCESS: the grants are untouched, and this only
     * decides which of your own totals the account lands in.
     */
    if (a.bookOverride === 'household') {
      household.add(a.id)
      continue
    }
    if (a.bookOverride === 'mine') {
      mine.add(a.id)
      continue
    }

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
  /**
   * The same event, with only one row on this device.
   *
   * Either the far leg is in an account I am not on — my partner linked it
   * herself, and her private account is not mine to read — or there is no far
   * leg at all, because she is not using the app and somebody tagged the
   * arrival with `contributorId`.
   *
   * Kept apart from `contribution` for one reason, and it is arithmetic rather
   * than vocabulary: `bookTotals` drops contributions under the `all` book,
   * because there both legs are in view and counting either would double-count.
   * With only one row there is nothing to double-count, and dropping it deletes
   * real income from Everything. Everywhere else the two behave identically.
   */
  | 'contribution-unpaired'
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
   *
   * Since migration 19 it is also the only flow this device can hold a row for
   * without holding its account: a published row from my partner's card is
   * household spending here and a contribution in a book I cannot see. On that
   * side the by-account filter drops it from `mine` and from Everything all by
   * itself, which is exactly right — I did not contribute it and it is not in
   * an account I hold.
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

    /**
     * Said outright on the row, and it does not depend on which book the
     * account is in — including the case where the account is in no book of
     * mine at all, or is not on this device.
     *
     * That last case is the point of migration 19. My partner's household
     * shopping, paid from her own card, now reaches my device as a single row
     * whose account I have no grant on and never will. `bookOf` has nothing to
     * say about it, and before this it fell straight through to `ignored` — so
     * the row arrived and then counted for nothing, which is a worse failure
     * than not replicating it at all.
     *
     * Hoisted above the `!here` bail rather than added beside it, because the
     * flag IS the classification here: whoever paid, and out of whatever, this
     * is the household spending its money.
     *
     * Money OUT only, and never on an account already in the household book —
     * a refund landing back on the card is not a contribution to anything, and
     * money leaving a joint account is already the household's to spend. The
     * server's policy publishes exactly the same rows, so the two cannot drift
     * into a row that replicates and is then ignored.
     */
    if (!t.transferId && t.paidForHousehold && t.amountMinor < 0 && here !== 'household') {
      out.set(t.id, 'paid-for-household')
      continue
    }

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
        // `unseen` is the exact test for "only one row here": a partner in an
        // `others` account is still a second row this device holds, and under
        // Everything both of them are in view.
        if (t.amountMinor > 0) out.set(t.id, unseen ? 'contribution-unpaired' : 'contribution')
        else out.set(t.id, 'withdrawal')
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
      // Somebody has said whose money this is, and there is no transfer to
      // disagree with — the far leg is in an account that will never be in this
      // app, so pairing is not a thing that can happen later. Money IN only:
      // the server checks the same, because a negative contribution would
      // credit the household with money it never had.
      if (t.contributorId && t.amountMinor > 0) out.set(t.id, 'contribution-unpaired')
      else out.set(t.id, t.amountMinor > 0 ? 'external-income' : 'household-spend')
    } else {
      out.set(t.id, t.amountMinor > 0 ? 'personal-income' : 'personal-spend')
    }
  }
  return out
}

/* ---------- which month a contribution belongs to ---------- */

/**
 * When this household's month starts, for money coming in.
 *
 * Each field is a day of the month, 1..28, or `null` for "do not shift this at
 * all". Money of that sort dated on or after the day counts towards the NEXT
 * month.
 *
 * ## Why anything shifts
 *
 * We are paid at the end of one month and spend it during the next. Every
 * calendar month does therefore contain one salary, one contribution and one
 * month of spending — nothing is missing — but they are the wrong pair:
 * August's spending is funded by the money that arrived on 31 July, while
 * August's own arrival pays for September.
 *
 * Left alone, that is visible twice. The monthly income-versus-spending chart
 * compares spending against money it did not spend; and for most of the month
 * the household reads as though it has spent thousands against nothing, because
 * its income has not turned up yet and will not until the 31st.
 *
 * Shifting the arrival is the smallest fix that addresses both. Spending keeps
 * its real date, so statements still reconcile and nothing else in the app
 * moves; only the money that was always *for* the following month is counted
 * there.
 *
 * ## Why it is a setting, and why there are two of them
 *
 * It was one hard-coded 25, and 25 is a guess about a payday. Paydays move: a
 * salary that lands on the 23rd because the 25th is a Sunday falls back into
 * the month it was meant to leave, and takes its whole month's funding with it.
 * A number that is right eleven months a year is a figure nobody can trust in
 * the twelfth, and nothing on the screen says which month you are looking at.
 *
 * Two days rather than one because they are two events with two dates. The
 * salary arrives when the employer says; the contribution moves when one of us
 * gets round to it, which may be the same day or three days later. A single
 * cutoff has to be wrong about one of them — set it to catch the transfer and
 * it drags an earlier salary with it; set it to catch the salary and it lets a
 * later transfer fall back a month. They are separately switchable for the same
 * reason: they land in different books, contributions in the household's "Paid
 * in" and income in the personal book's "Earned".
 *
 * Both default to 25, which is the constant they replace — so nothing moved for
 * anybody on the day this shipped.
 *
 * ## Why 28 is the ceiling
 *
 * A cutoff of 30 has no meaning in February, and a rule that quietly does
 * nothing for one month a year is worse than one you cannot set.
 *
 * ## Why it belongs to the household
 *
 * See `monthRule.ts`. The household book is complete and IDENTICAL on both our
 * screens — that property is most of why the books exist — and a cutoff kept
 * per device would break it in the one way nobody could see: the same
 * contribution landing in July on one phone and August on the other, with both
 * screens confident.
 */
export interface MonthRule {
  /** Money moved into the household on or after this day is next month's. */
  contributionDay: number | null
  /** Income arriving on or after this day is next month's. */
  incomeDay: number | null
}

/** What a household that has never opened the setting gets: the constant this replaced. */
export const DEFAULT_MONTH_RULE: MonthRule = { contributionDay: 25, incomeDay: 25 }

/**
 * The cutoff that governs one row, or null for a row nothing shifts.
 *
 * Both readings of a contribution, so the shift does not depend on whether the
 * other person happens to use the app — exactly the accident this whole
 * mechanism exists to stop mattering — and both kinds of outside income, since
 * a salary landing on the 31st is the same event as the contribution it pays
 * for and has to be able to move with it.
 *
 * Note what is NOT here. A `withdrawal` is money coming back out in response to
 * something rather than a regular advance, so there is no next month it is
 * obviously "for". Spending is never shifted at all. And `paid-for-household`
 * is spending that happens to also be a contribution: the money left on the day
 * it left, so it belongs to that month on both sides of the book — shifting it
 * would move a purchase away from the statement line it reconciles against.
 */
function cutoffFor(t: Transaction, flow: Flow | undefined, rule: MonthRule): number | null {
  if (flow === 'contribution' || flow === 'contribution-unpaired') return rule.contributionDay
  // The arriving half only. A `contribution` is one flow seen from two ends,
  // and the leg LEAVING a personal account is not an arrival — but it is the
  // same event, so it is shifted above regardless of sign, which is what keeps
  // my book and the household's agreeing about when it happened.
  if ((flow === 'personal-income' || flow === 'external-income') && t.amountMinor > 0) return rule.incomeDay
  return null
}

/**
 * The month a transaction counts towards, which is not always the month it
 * happened in.
 *
 * Three answers, in the order of who is the more likely to be right:
 *
 *   1. `bookMonth` — somebody said so. A bonus paid in November that is really
 *      December's; a January invoice settled in the December lull. It wins
 *      outright, because an answer a person typed is never overridden by one
 *      the app inferred, and it is the only one of the three that can move
 *      SPENDING.
 *   2. The household's cutoff for this kind of arrival, if it has one.
 *   3. The month it happened in.
 *
 * The cutoff is applied to both legs of a contribution, so my book and the
 * household's agree about when it happened — the same event must not land in
 * different months on either side of it. Each month still contains exactly one
 * salary and exactly one contribution; the pairing is simply corrected by one.
 */
export function effectiveMonth(t: Transaction, flow: Flow | undefined, rule: MonthRule): string {
  if (t.bookMonth) return t.bookMonth
  const cutoff = cutoffFor(t, flow, rule)
  if (cutoff === null) return monthKey(t.date)
  const day = Number(t.date.slice(8, 10))
  if (day < cutoff) return monthKey(t.date)
  return shiftMonth(monthKey(t.date), 1)
}

/**
 * The same question for a row no cutoff can reach — spending, and everything
 * else the rule leaves alone.
 *
 * Exists so the screens that count spending WITHOUT classifying flows — the
 * budgets, and the sparklines in stats.ts — do not each hand-roll
 * `t.bookMonth ?? monthKey(t.date)` and drift from what `effectiveMonth`
 * answers. A budget that ignored a moved row would disagree with the donut
 * above it about the same month.
 */
export function bookedMonth(t: Transaction): string {
  return t.bookMonth ?? monthKey(t.date)
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
  /**
   * The two halves of `contributed`, which sum to it.
   *
   * They are two different acts and only one of them is a decision. Money
   * MOVED across is a figure somebody agreed and repeats every month; money
   * paid for the household straight off a personal card is an accident of
   * which card was in the wallet. Merged into one band on the diagram, the
   * second is invisible — and it is the half that quietly turns into being
   * owed.
   */
  contributedMoved: number
  contributedPaid: number
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
  contributedMoved: 0,
  contributedPaid: 0,
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
  rule: MonthRule,
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
     * This used to be the one thing breaking the property the household book
     * was chosen for — identical on both screens, because every row it needs is
     * in a joint account we can both read. A row in a private account was not.
     * Migration 19 closes it: an account whose owner has agreed to it publishes
     * the rows marked here, and only those, so the row arrives on the other
     * device and is counted by exactly this branch. On an account that does not
     * publish, the old asymmetry is still what you get — which is now a state
     * somebody chose rather than the only one available.
     */
    if (flow === 'paid-for-household') {
      if (effectiveMonth(row, flow, rule) !== month) continue
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
        else {
          t.contributed += amount
          t.contributedPaid += amount
        }
      }
      continue
    }

    if (!ids.has(row.accountId)) continue
    if (!flow || flow === 'internal' || flow === 'ignored') continue
    // Not `monthKey(row.date)`: a contribution counts towards the month it was
    // FOR, which for money moved at the end of one month is the next one.
    if (effectiveMonth(row, flow, rule) !== month) continue
    // Under `all`, my private account and the joint account are one pool, so a
    // contribution is internal again and both its legs are present. Counting it
    // would be exactly the double count the books exist to prevent.
    if (book === 'all' && (flow === 'contribution' || flow === 'withdrawal')) continue

    switch (flow) {
      case 'contribution':
        // Positive on the household side, negative on mine — the same event
        // seen from each end, which is the whole point of the model.
        if (row.amountMinor > 0) t.contributions += row.amountMinor
        else {
          t.contributed -= row.amountMinor
          t.contributedMoved -= row.amountMinor
        }
        break
      case 'contribution-unpaired':
        // Always positive: `classifyFlows` only sets this on money coming in,
        // and the server's check constraint says the same, so there is no
        // second branch to write here.
        //
        // Under Everything there is no household to contribute TO — the money
        // simply arrived in the visible pool from outside it, which is what
        // `externalIncome` means and, load-bearingly, the only inflow the Sankey
        // draws in that book. Filing it as a contribution there would leave the
        // diagram's left side short and conjure a "from what was already there"
        // band to cover the difference.
        if (book === 'all') t.externalIncome += row.amountMinor
        else t.contributions += row.amountMinor
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
        else {
          t.contributed += amount
          t.contributedPaid += amount
        }
      }
      continue
    }

    if (!ids.has(row.accountId)) continue
    if (!flow || flow === 'internal' || flow === 'ignored') continue
    if (book === 'all' && (flow === 'contribution' || flow === 'withdrawal')) continue

    switch (flow) {
      case 'contribution':
        if (row.amountMinor > 0) t.contributions += row.amountMinor
        else {
          t.contributed -= row.amountMinor
          t.contributedMoved -= row.amountMinor
        }
        break
      // See `bookTotals` for why Everything files this as outside income.
      case 'contribution-unpaired':
        if (book === 'all') t.externalIncome += row.amountMinor
        else t.contributions += row.amountMinor
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
    t.contributedMoved += p.contributedMoved
    t.contributedPaid += p.contributedPaid
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
 * `classifyFlows`' `paid-for-household` test, asked about one row.
 *
 * Exported so a screen tinting or badging a row asks the same question the
 * arithmetic did, rather than re-spelling `paidForHousehold && amountMinor < 0`
 * and drifting from it — the `!books.household.has(...)` conjunct in particular
 * is easy to forget, and forgetting it marks a joint-account row as though
 * somebody had paid for the household out of the household's own money.
 */
export function isHouseholdPaid(
  t: Pick<Transaction, 'accountId' | 'amountMinor' | 'paidForHousehold' | 'transferId'>,
  books: BookMap,
): boolean {
  return (
    !!t.paidForHousehold && !t.transferId && t.amountMinor < 0 && !books.household.has(t.accountId)
  )
}

/**
 * Whether a book's ROW LIST should show this transaction.
 *
 * `visible` — the accounts in the book whose rows this device may read — is the
 * whole answer for every row but one, and the exception is the same one
 * `spendsIn` exists for: a `paid-for-household` row is spending in the
 * household's book while living in an account outside it. Selecting the list by
 * account alone leaves it out of a list whose heading has already counted it,
 * which is the "£412 spent" over a list of £322 that `spendsIn` was written to
 * prevent, one level up.
 *
 * It applies whoever paid, and that is worth saying because the first version
 * of this only admitted rows from accounts this device does NOT hold. On my own
 * device my card is an account I hold perfectly well — and still not one in the
 * household book, so my own household shopping was missing from Our household
 * while being counted in the figure above it.
 *
 * Only the household book has an exception. Under `mine` the row is in my
 * account and arrives through `visible` like anything else; under Everything the
 * same is true for the payer, and for anybody else the account is not one this
 * device holds, which is exactly what Everything means. `bookTotals` agrees in
 * both directions.
 */
export function showsInBook(
  t: Pick<Transaction, 'accountId' | 'amountMinor' | 'paidForHousehold' | 'transferId'>,
  book: BookId,
  books: BookMap,
  visible: Set<string>,
): boolean {
  return visible.has(t.accountId) || (book === 'household' && isHouseholdPaid(t, books))
}

/**
 * Who put what into the household this month.
 *
 * Only askable because of how the books work. Neither of us can see the other's
 * salary, but every contribution ARRIVES in a joint account, and joint accounts
 * are readable by both — so this is one figure that is complete and identical on
 * both screens.
 *
 * Two ways money gets into the household, and both are counted here: it is
 * MOVED into a joint account, or something is bought for the household straight
 * off somebody's own card and never passes through one. The second used to be
 * left out, which put it in a band of its own on the Sankey called "paid from a
 * personal account" — a category of contribution rather than a person, sitting
 * beside two people. It is the same act: you put money in.
 *
 * The parts are kept separately (`minePaidMinor` and friends) so a tooltip can
 * say which was which, and are added for every figure that asks who put in
 * what.
 *
 * Attribution of a MOVED contribution does not use `created_by`. That is
 * whoever entered the row, which for an imported statement is whoever did the
 * importing, not whose money it was. It asks three questions, in this order:
 *
 *   1. has somebody SAID whose this is (`contributorId`)? → that person
 *   2. far leg in one of MY accounts                      → mine
 *   3. far leg not visible at all                         → somebody else's
 *
 * A row paid straight from a personal account is the one case where
 * `created_by` IS the right answer, and the reasoning above is why: there is no
 * far leg to read, and a personal card is imported by the person whose card it
 * is. The two questions are not the same question.
 *
 * The third is an inference, and worth knowing about because it is confidently
 * wrong in one case: a leg whose partner row has gone — the far account deleted,
 * or the other row deleted after linking — is indistinguishable from a leg whose
 * partner was never visible, and gets read as the other person's. That is right
 * for a contribution they linked on their own device, which is what it is for,
 * and it is why (1) exists above it: an explicit answer never has to fight a
 * guess. A row that reads as theirs when you know it was yours is an orphaned
 * transfer, not a mystery — check whether Activity names the far account.
 *
 * The honest limit is `otherMinor`. An arrival nobody has linked OR tagged is
 * indistinguishable from money paid in from outside the household — both are
 * just a credit in the joint account — so the two share a bucket rather than
 * the app pretending it can tell a salary transfer from a tax refund. Linking
 * moves money out of that bucket and onto a name; so does tagging, which is the
 * only route open when the other person is not using the app at all.
 */
export interface ContributionSplit {
  mineMinor: number
  theirsMinor: number
  /**
   * Of the two above, the part bought for the household straight from a
   * personal account rather than moved into a joint one. Already included in
   * them — this says how much of the total got there that way, not extra money.
   */
  minePaidMinor: number
  theirsPaidMinor: number
  /** How many rows are behind each figure, so a band can say how many payments. */
  mineCount: number
  theirsCount: number
  minePaidCount: number
  theirsPaidCount: number
  /**
   * Outside income, plus any arrival nobody has linked yet. See above.
   *
   * Kept as the sum of the two below so nothing reading it has to change, but
   * a screen should prefer them: they are different facts and only one is
   * something you can act on. Child benefit landing in the joint account is
   * simply not a contribution; a £900 credit nobody has paired is one whose
   * owner the app cannot name, and somebody can go and say.
   */
  otherMinor: number
  /** Money from outside the household entirely — interest, benefits, a refund. */
  externalMinor: number
  /** An arrival that looks like a contribution and has no name on it yet. */
  unattributedMinor: number
}

export function contributionSplit(
  txns: Transaction[],
  flows: Map<string, Flow>,
  rule: MonthRule,
  month: string,
  books: BookMap,
  /** Needed to tell "I tagged this as mine" from "I tagged this as theirs". */
  userId?: string,
): ContributionSplit {
  // Not `monthKey(t.date)`: a contribution counts towards the month it was FOR.
  // `bookTotals` files it in the same month, which is what keeps this split
  // adding up to the figure above it.
  return splitCore(txns, flows, books, userId, (t, flow) => effectiveMonth(t, flow, rule) === month)
}

/**
 * The same question over an arbitrary run of days.
 *
 * Deliberately NOT built out of `contributionSplit`, and for exactly the reason
 * `bookTotalsInRange` is not built out of `bookTotals`: a range that does not
 * align to a month cannot use `effectiveMonth`, because "the month this money
 * was for" is a question a fortnight in the middle of March cannot answer. So
 * this counts money on the day it actually moved — the same rule the totals
 * beside it follow, which is what keeps the two agreeing.
 */
export function contributionSplitInRange(
  txns: Transaction[],
  flows: Map<string, Flow>,
  books: BookMap,
  /** Both inclusive, `yyyy-MM-dd`. */
  from: string,
  to: string,
  userId?: string,
): ContributionSplit {
  return splitCore(txns, flows, books, userId, (t) => t.date >= from && t.date <= to)
}

/**
 * Several periods as one split — a year, or any run of months.
 *
 * Every field here is additive, so unlike `sumBookTotals` there is nothing to
 * re-derive: no field of a `ContributionSplit` is computed from the others.
 *
 * It exists because Reports shows a period and `contributionSplit` answers about
 * a month. Asking it once with the month while the totals beside it covered a
 * whole year is how the "Who paid in" bar came to understate every year view,
 * with the remainder silently landing in "Put in — not sure by whom" — the band
 * for money that genuinely has no name on it.
 */
export function sumContributionSplits(parts: ContributionSplit[]): ContributionSplit {
  const out: ContributionSplit = {
    mineMinor: 0,
    theirsMinor: 0,
    minePaidMinor: 0,
    theirsPaidMinor: 0,
    mineCount: 0,
    theirsCount: 0,
    minePaidCount: 0,
    theirsPaidCount: 0,
    otherMinor: 0,
    externalMinor: 0,
    unattributedMinor: 0,
  }
  for (const p of parts) {
    out.mineMinor += p.mineMinor
    out.theirsMinor += p.theirsMinor
    out.minePaidMinor += p.minePaidMinor
    out.theirsPaidMinor += p.theirsPaidMinor
    out.mineCount += p.mineCount
    out.theirsCount += p.theirsCount
    out.minePaidCount += p.minePaidCount
    out.theirsPaidCount += p.theirsPaidCount
    out.otherMinor += p.otherMinor
    out.externalMinor += p.externalMinor
    out.unattributedMinor += p.unattributedMinor
  }
  return out
}

/**
 * The body both of them share, with the period asked as a predicate.
 *
 * One copy rather than two, because the two differ in which rows they count and
 * not at all in how a row is attributed — and the attribution is the delicate
 * part: three questions in a fixed order, with a documented wrong answer in one
 * case. A second copy of that would drift.
 */
function splitCore(
  txns: Transaction[],
  flows: Map<string, Flow>,
  books: BookMap,
  userId: string | undefined,
  within: (t: Transaction, flow: Flow | undefined) => boolean,
): ContributionSplit {
  const legs = new Map<string, Transaction[]>()
  for (const t of txns) {
    if (!t.transferId) continue
    const list = legs.get(t.transferId)
    if (list) list.push(t)
    else legs.set(t.transferId, [t])
  }

  const out: ContributionSplit = {
    mineMinor: 0,
    theirsMinor: 0,
    minePaidMinor: 0,
    theirsPaidMinor: 0,
    mineCount: 0,
    theirsCount: 0,
    minePaidCount: 0,
    theirsPaidCount: 0,
    otherMinor: 0,
    externalMinor: 0,
    unattributedMinor: 0,
  }

  for (const t of txns) {
    const flow = flows.get(t.id)

    /**
     * Bought for the household straight off somebody's own card.
     *
     * Attributed by `created_by`, which is the one place in this function that
     * is the right question — see the note above. It lives outside every
     * household account, so it is handled before the by-account filter, exactly
     * as `bookTotals` handles it.
     *
     * `effectiveMonth` returns the row's own month for this flow: the 25th
     * cut-off moves a contribution into the month it is FOR, and money spent on
     * the 29th was spent on the 29th. `bookTotals` counts it in the same month,
     * which is what keeps this split adding up to the figure above it.
     */
    if (flow === 'paid-for-household') {
      if (!within(t, flow)) continue
      const amount = -t.amountMinor
      if (!t.createdBy) {
        // Nobody's name on it, and it is spending rather than an arrival — so
        // it is a contribution whose payer is unknown, not outside income.
        out.otherMinor += amount
        out.unattributedMinor += amount
      } else if (t.createdBy === userId) {
        out.mineMinor += amount
        out.minePaidMinor += amount
        out.mineCount += 1
        out.minePaidCount += 1
      } else {
        out.theirsMinor += amount
        out.theirsPaidMinor += amount
        out.theirsCount += 1
        out.theirsPaidCount += 1
      }
      continue
    }

    if (!books.household.has(t.accountId) || t.amountMinor <= 0) continue
    if (!within(t, flow)) continue

    if (flow === 'external-income') {
      out.otherMinor += t.amountMinor
      out.externalMinor += t.amountMinor
      continue
    }
    if (flow !== 'contribution' && flow !== 'contribution-unpaired') continue

    // Said outright, and it wins — the same shape as `bookOverride` on an
    // account, and checked first for the same reason: an explicit answer must
    // not be something the inference below can quietly outvote. Note this is
    // reachable on a LINKED contribution too, where it is a correction rather
    // than a substitute.
    if (t.contributorId) {
      if (t.contributorId === userId) {
        out.mineMinor += t.amountMinor
        out.mineCount += 1
      } else {
        out.theirsMinor += t.amountMinor
        out.theirsCount += 1
      }
      continue
    }

    const partner = t.transferId ? legs.get(t.transferId)?.find((l) => l.id !== t.id) : undefined
    // No partner row means an account this device is not on, which in a
    // household is somebody else's private account.
    if (!t.transferId) {
      out.otherMinor += t.amountMinor
      out.unattributedMinor += t.amountMinor
    } else if (!partner) {
      out.theirsMinor += t.amountMinor
      out.theirsCount += 1
    } else if (books.mine.has(partner.accountId)) {
      out.mineMinor += t.amountMinor
      out.mineCount += 1
    } else {
      // A partner leg in an account belonging to neither book: real money that
      // crossed, with nobody this device can name on the other end of it.
      out.otherMinor += t.amountMinor
      out.unattributedMinor += t.amountMinor
    }
  }
  return out
}

/* ---------- money that stayed, and moved ---------- */

/**
 * Money moved into a savings account inside the book.
 *
 * A transfer between two accounts of one book is `internal` — not an event, and
 * correctly counted in nothing. That is right for "what did we earn and spend"
 * and wrong for the question everybody actually asks of a savings account,
 * which is "did we put anything by this month". Both readings are true at once,
 * so this is a SECOND pass over the same rows rather than a new flow: nothing
 * about `bookTotals` moves, `net` is untouched, and what is left over is simply
 * shown split into the part that went to savings and the part that did not.
 *
 * The arriving leg only. The pair nets to zero across the book, so counting
 * both would show nothing moving at all.
 *
 * `householdWaterfall` in insights.ts had this loop inside it, household-only
 * and one month at a time. It calls this now, so the step on the waterfall and
 * the band on the diagram cannot come to different figures.
 */
export function savedInto(
  txns: Transaction[],
  flows: Map<string, Flow>,
  book: BookId,
  books: BookMap,
  savingsAccountIds: Set<string>,
  /** One month, or several. A year asks the same question of twelve. */
  month: string | string[],
): number {
  const ids = accountsInBook(book, books)
  const want = new Set(Array.isArray(month) ? month : [month])
  let saved = 0
  for (const t of txns) {
    if (!savingsAccountIds.has(t.accountId) || !ids.has(t.accountId)) continue
    if (t.amountMinor <= 0 || flows.get(t.id) !== 'internal') continue
    if (!want.has(bookedMonth(t))) continue
    saved += t.amountMinor
  }
  return saved
}

/** The same, over a run of days. See `bookTotalsInRange` for why ranges are separate. */
export function savedIntoRange(
  txns: Transaction[],
  flows: Map<string, Flow>,
  book: BookId,
  books: BookMap,
  savingsAccountIds: Set<string>,
  from: string,
  to: string,
): number {
  const ids = accountsInBook(book, books)
  let saved = 0
  for (const t of txns) {
    if (!savingsAccountIds.has(t.accountId) || !ids.has(t.accountId)) continue
    if (t.amountMinor <= 0 || flows.get(t.id) !== 'internal') continue
    if (t.date < from || t.date > to) continue
    saved += t.amountMinor
  }
  return saved
}

/** The accounts a book saves INTO — savings by kind, and in the book. */
export function savingsAccounts(accounts: Account[], book: BookId, books: BookMap): Set<string> {
  const ids = accountsInBook(book, books)
  return new Set(accounts.filter((a) => a.kind === 'savings' && ids.has(a.id)).map((a) => a.id))
}

/* ---------- how the three books relate ---------- */

/**
 * The three sets of books side by side, and the lines that reconcile them.
 *
 * Everything used to be a fourth filter over the same rows: the same donut, the
 * same bars, the same diagram, with the household and personal accounts added
 * together. It answered nothing the other two answer better, and its income
 * figure is deliberately NOT their sum — with nothing anywhere to say why.
 *
 * Two of the three identities are exact and one is not, and the honest thing is
 * to print all three rather than to quietly round the difference away:
 *
 *   net     all.net   === ours.net + mine.net                          always
 *   spend   all.spend === ours.spend + mine.spend  − unheldSpend
 *   income  all.income === ours.income + mine.income − crossing − unheldSpend
 *
 * `crossing` is a contribution: counted once in each book, because the books
 * are never summed, and in neither under Everything, because there both legs
 * are in view and counting either would count it twice.
 *
 * `unheldSpend` is the surprising one and it is a fact about the privacy model
 * rather than a rounding error. A partner's household shopping, bought on her
 * own card, reaches this device as a single published row: it is spending in
 * the household's book and it is in no account this device holds, so Everything
 * — which means "every account I can see" — is short by exactly it. A card that
 * printed the other two rows and swallowed this one would be a card with a £44
 * hole in it that the reader has to go and find.
 */
export interface BookBridge {
  household: BookTotals
  mine: BookTotals
  all: BookTotals
  /** What crossed between the books, and so is counted in neither under Everything. */
  crossingMinor: number
  /** Household spending bought from an account this device does not hold. */
  unheldSpendMinor: number
  /**
   * How many rows sit in an account that is in NEITHER book — one somebody
   * shared with me, which is mine to read and not mine to count.
   *
   * A count rather than a column of figures, and the difference matters.
   * `classifyFlows` calls every row in such an account `ignored`, so those rows
   * are in no total on this device at all — not in Everything either, despite
   * its name. A fourth column would therefore print figures that reconcile with
   * nothing, which is precisely the fault this card exists to remove. A
   * sentence saying they exist and are counted nowhere is the true version.
   */
  unbookedCount: number
}

export function bookBridge(
  txns: Transaction[],
  flows: Map<string, Flow>,
  rule: MonthRule,
  books: BookMap,
  month: string | string[],
): BookBridge {
  const months = Array.isArray(month) ? month : [month]
  const of = (book: BookId) => sumBookTotals(months.map((m) => bookTotals(txns, flows, rule, book, m, books)))

  const household = of('household')
  const mine = of('mine')
  const all = of('all')
  const want = new Set(months)
  const visible = accountsInBook('all', books)

  let unheldSpendMinor = 0
  let unbookedCount = 0
  for (const row of txns) {
    const flow = flows.get(row.id)
    if (flow === 'paid-for-household' && !visible.has(row.accountId)) {
      if (want.has(effectiveMonth(row, flow, rule))) unheldSpendMinor -= row.amountMinor
      continue
    }
    if (books.others.has(row.accountId) && want.has(bookedMonth(row))) unbookedCount += 1
  }

  return {
    household,
    mine,
    all,
    crossingMinor: mine.contributed + mine.returned,
    unheldSpendMinor,
    unbookedCount,
  }
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
  rule: MonthRule,
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
    ...bookTotals(txns, flows, rule, book, key, books),
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
  rule: MonthRule,
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
    const flow = flows.get(t.id)
    if (!spendsIn(flow, book, t.accountId, ids)) continue
    // `effectiveMonth`, not `monthKey`: no cutoff moves spending, so the two
    // differ only where somebody has moved this row by hand — and that is
    // exactly what keeps the donut adding up to the heading above it, which
    // reads the same rows through `bookTotals`.
    if (!t.categoryId || !want.has(effectiveMonth(t, flow, rule))) continue
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
 * Spend per category per month, one series per category — what a budget is
 * judged against.
 *
 * The book-aware twin of `monthlySpendByCategory` in stats.ts, and it exists
 * because that one is flow-blind. Handed a personal account's rows it counts a
 * contribution leg as spending; handed a household book it cannot see the one
 * row that is household spending from outside the household's accounts. Both of
 * those were live: the Budgets page compared a current-month figure computed
 * with `isSpend` against a six-month "typical" computed without it, so a
 * `paid-for-household` row was in the history and out of the figure beside it.
 *
 * `spendsIn` is the whole of the selection rule, exactly as `bookSpendByCategory`
 * uses it, so the series and the totals above them cannot disagree.
 */
export function bookMonthlySpendByCategory(
  txns: Transaction[],
  flows: Map<string, Flow>,
  rule: MonthRule,
  categories: Category[],
  book: BookId,
  books: BookMap,
  months: string[],
): Map<string, number[]> {
  const catMap = new Map(categories.map((c) => [c.id, c]))
  const ids = accountsInBook(book, books)
  const index = new Map(months.map((m, i) => [m, i]))
  const out = new Map<string, number[]>()

  for (const t of txns) {
    if (!t.categoryId) continue
    const flow = flows.get(t.id)
    if (!spendsIn(flow, book, t.accountId, ids)) continue
    // Equal to `monthKey(t.date)` for every flow `spendsIn` admits UNLESS
    // somebody has moved this row by hand: no cutoff shifts spending, and
    // `bookMonth` is the one thing that does.
    const i = index.get(effectiveMonth(t, flow, rule))
    if (i === undefined) continue
    const cat = catMap.get(t.categoryId)
    if (!cat || cat.kind !== 'expense') continue
    // Subcategory spending rolls up to its parent, the rule budgets, the donut
    // and the heatmap all share.
    const key = budgetCategoryId(cat)!
    let series = out.get(key)
    if (!series) {
      series = months.map(() => 0)
      out.set(key, series)
    }
    series[i] -= t.amountMinor
  }
  return out
}

/**
 * Spend per category, split into the household's part and the personal one.
 *
 * Only meaningful under Everything, which is the one book that contains both.
 * Under Our household or Mine the answer is the whole bar in one colour, and a
 * chart that draws a single segment and calls it a split is a control that
 * appears to do nothing.
 *
 * The two parts are taken by asking `spendsIn` of each book in turn rather than
 * by splitting the combined figure, so a row that belongs to two books at once
 * lands where each book puts it: household shopping bought on a personal card
 * is the household's spending and is not the payer's, exactly as every other
 * figure in the app has it. That also means the parts can sum to LESS than the
 * combined total — a published row from an account this device does not hold is
 * in the household's part and in no account here — so the combined figure is
 * kept rather than re-derived from the halves.
 */
export interface SplitSlice extends CategorySlice {
  householdMinor: number
  mineMinor: number
}

export function bookSplitByCategory(
  txns: Transaction[],
  flows: Map<string, Flow>,
  rule: MonthRule,
  categories: Category[],
  books: BookMap,
  month: string | string[],
  maxSlices = 8,
): SplitSlice[] {
  const catMap = new Map(categories.map((c) => [c.id, c]))
  const want = new Set(Array.isArray(month) ? month : [month])
  const householdIds = accountsInBook('household', books)
  const mineIds = accountsInBook('mine', books)

  const parts = new Map<string, { household: number; mine: number }>()
  for (const t of txns) {
    if (!t.categoryId) continue
    const flow = flows.get(t.id)
    // See `bookSpendByCategory`: a row somebody has moved counts where they
    // said, on both sides of this split.
    if (!want.has(effectiveMonth(t, flow, rule))) continue
    const cat = catMap.get(t.categoryId)
    if (!cat || cat.kind !== 'expense') continue
    const inHousehold = spendsIn(flow, 'household', t.accountId, householdIds)
    const inMine = spendsIn(flow, 'mine', t.accountId, mineIds)
    if (!inHousehold && !inMine) continue
    const key = budgetCategoryId(cat)!
    const at = parts.get(key) ?? { household: 0, mine: 0 }
    if (inHousehold) at.household -= t.amountMinor
    if (inMine) at.mine -= t.amountMinor
    parts.set(key, at)
  }

  // The combined figure comes from `bookSpendByCategory` under Everything, not
  // from adding the halves — see the note above.
  const combined = new Map(
    bookSpendByCategory(txns, flows, rule, categories, 'all', month, books).map((r) => [r.categoryId, r.totalMinor]),
  )
  const rows = [...new Set([...parts.keys(), ...combined.keys()])].map((categoryId) => ({
    categoryId,
    totalMinor: combined.get(categoryId) ?? 0,
  }))

  const slices = toSlices(
    rows.filter((r) => r.totalMinor > 0).sort((a, b) => b.totalMinor - a.totalMinor),
    categories,
    undefined,
    maxSlices,
  )

  // "Other" is the folded tail, so its parts are everything not named above it.
  // Reading the map by its synthetic id would give it a split of nothing, and a
  // bar drawn with no segments in a chart whose whole point is the segments.
  const named = slices.filter((sl) => sl.categoryId !== OTHER_SLICE_ID)
  const grand = [...parts.values()].reduce(
    (sum, p) => ({ household: sum.household + p.household, mine: sum.mine + p.mine }),
    { household: 0, mine: 0 },
  )
  const namedTotals = named.reduce(
    (sum, sl) => ({
      household: sum.household + (parts.get(sl.categoryId)?.household ?? 0),
      mine: sum.mine + (parts.get(sl.categoryId)?.mine ?? 0),
    }),
    { household: 0, mine: 0 },
  )

  return slices.map((slice) =>
    slice.categoryId === OTHER_SLICE_ID
      ? {
          ...slice,
          householdMinor: Math.max(0, grand.household - namedTotals.household),
          mineMinor: Math.max(0, grand.mine - namedTotals.mine),
        }
      : {
          ...slice,
          householdMinor: parts.get(slice.categoryId)?.household ?? 0,
          mineMinor: parts.get(slice.categoryId)?.mine ?? 0,
        },
  )
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
  rule: MonthRule,
  categories: Category[],
  book: BookId,
  month: string | string[],
  books: BookMap,
  drillInto?: string,
  maxSlices = 8,
): CategorySlice[] {
  return toSlices(
    bookSpendByCategory(txns, flows, rule, categories, book, month, books, drillInto),
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
      color: style.color,
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
  rule: MonthRule,
  categories: Category[],
  book: BookId,
  month: string | string[],
  books: BookMap,
): boolean {
  return bookSpendByCategory(txns, flows, rule, categories, book, month, books, categoryId).length > 1
}
