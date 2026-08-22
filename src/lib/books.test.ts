import { describe, expect, it } from 'vitest'
import type { Account, AccountGrant, Category, Transaction } from './db'
import { shiftMonth } from './dates'
import {
  accountsInBook,
  bookBalances,
  bookOpening,
  bookBridge,
  bookMonthlySpendByCategory,
  bookSpendByCategory,
  bookSplitByCategory,
  bookTotals,
  sumBookTotals,
  bookTotalsInRange,
  bookSpendByCategoryInRange,
  classifyAccounts,
  classifyFlows,
  contributionSplit,
  contributionSplitInRange,
  sumContributionSplits,
  savedInto,
  savingsAccounts,
  showsInBook,
  isHouseholdPaid,
  DEFAULT_MONTH_RULE,
  type BookMap,
} from './books'

/** What these tests count months under, unless one of them varies it. */
const RULE = DEFAULT_MONTH_RULE

/**
 * The fixture is the household this model was designed around, with one month
 * of real behaviour in it:
 *
 *   both salaries land in private accounts
 *   most of each salary moves to the joint account
 *   the household spends and saves from there
 *   a bit of personal spending stays behind
 *
 * Every assertion below is checked from GABI's device, which can see the joint
 * accounts and his own — and not a single row of his partner's private account.
 * That asymmetry is the whole point: the household figures still have to be
 * complete and correct.
 */

const ME = 'gabi'
const HER = 'wife'

const account = (id: string, kind: Account['kind'] = 'current'): Account => ({
  id,
  name: id,
  kind,
  openingBalanceMinor: 0,
  sortOrder: 0,
  updatedAt: 'x',
})

const grant = (accountId: string, userId: string, level: AccountGrant['level'] = 'owner'): AccountGrant => ({
  id: `${accountId}:${userId}`,
  accountId,
  userId,
  level,
  updatedAt: 'x',
})

const accounts = [
  account('joint'),
  account('jointSavings', 'savings'),
  account('myPrivate'),
]

const grantsByAccount = new Map<string, AccountGrant[]>([
  ['joint', [grant('joint', ME), grant('joint', HER)]],
  ['jointSavings', [grant('jointSavings', ME), grant('jointSavings', HER)]],
  ['myPrivate', [grant('myPrivate', ME)]],
])

const books: BookMap = classifyAccounts(accounts, grantsByAccount, ME)

let seq = 0
const txn = (over: Partial<Transaction> & { accountId: string; amountMinor: number }): Transaction => ({
  id: `t${++seq}`,
  date: '2026-03-15',
  payee: 'x',
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

/** March, exactly as described: see the header. */
function march() {
  const mySalary = txn({ accountId: 'myPrivate', amountMinor: 300000, date: '2026-03-01', categoryId: 'salary' })
  // My contribution — both legs visible to me, because one of them is mine.
  const myOut = txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-03-02', transferId: 'mine' })
  const myIn = txn({ accountId: 'joint', amountMinor: 200000, date: '2026-03-02', transferId: 'mine' })
  // Hers. She linked it on her device, so the incoming leg carries a transferId
  // — but the far leg is in an account I am not on and never will be.
  const herIn = txn({ accountId: 'joint', amountMinor: 180000, date: '2026-03-02', transferId: 'hers' })

  const benefit = txn({ accountId: 'joint', amountMinor: 8800, date: '2026-03-05', categoryId: 'benefits' })

  const mortgage = txn({ accountId: 'joint', amountMinor: -120000, categoryId: 'home' })
  const groceries = txn({ accountId: 'joint', amountMinor: -60000, categoryId: 'groceries' })
  const utilities = txn({ accountId: 'joint', amountMinor: -25000, categoryId: 'utilities' })
  const otherHome = txn({ accountId: 'joint', amountMinor: -35000, categoryId: 'home' })

  // Joint current to joint savings: inside one book, so not an event.
  const saveOut = txn({ accountId: 'joint', amountMinor: -100000, date: '2026-03-28', transferId: 'save' })
  const saveIn = txn({ accountId: 'jointSavings', amountMinor: 100000, date: '2026-03-28', transferId: 'save' })

  const myShopping = txn({ accountId: 'myPrivate', amountMinor: -70000, categoryId: 'shopping' })

  return [mySalary, myOut, myIn, herIn, benefit, mortgage, groceries, utilities, otherHome, saveOut, saveIn, myShopping]
}

describe('sorting accounts into books', () => {
  it('puts the accounts we are both on in the household book', () => {
    expect(books.household).toEqual(new Set(['joint', 'jointSavings']))
    expect(books.mine).toEqual(new Set(['myPrivate']))
  })

  it('does not reclassify a private account just because a balance was shared', () => {
    // Letting your partner see the total is not putting them on the account,
    // and it must not silently move your salary into the household's books.
    const shared = new Map(grantsByAccount)
    shared.set('myPrivate', [grant('myPrivate', ME), grant('myPrivate', HER, 'balance')])

    const b = classifyAccounts(accounts, shared, ME)

    expect(b.mine.has('myPrivate')).toBe(true)
    expect(b.household.has('myPrivate')).toBe(false)
  })

  it('claims a brand new account whose owner grant has not arrived yet', () => {
    // The server writes the creator's grant from an AFTER trigger, so for a
    // moment the cached grant list is empty and nobody is on the account.
    const fresh = [...accounts, { ...account('brandNew'), createdBy: ME }]

    expect(classifyAccounts(fresh, grantsByAccount, ME).mine.has('brandNew')).toBe(true)
  })

  it('puts an account somebody shared with me in neither of my books', () => {
    // I can read it, but it is not mine and it is not ours. One grant is not
    // the same as one person: below `manage` the only grant I can see is my own.
    const withTheirs = [...accounts, account('hersSharedWithMe')]
    const g = new Map(grantsByAccount)
    g.set('hersSharedWithMe', [grant('hersSharedWithMe', ME, 'view')])

    const b = classifyAccounts(withTheirs, g, ME)

    expect(b.others.has('hersSharedWithMe')).toBe(true)
    expect(b.mine.has('hersSharedWithMe')).toBe(false)
  })
})

describe('what each transaction is', () => {
  const txns = march()
  const flows = classifyFlows(txns, books)
  const flowOf = (i: number) => flows.get(txns[i].id)

  it('reads a contribution from both ends as the same event', () => {
    expect(flowOf(1)).toBe('contribution') // leaving my private
    expect(flowOf(2)).toBe('contribution') // arriving in joint
  })

  it('recognises a contribution whose far leg it can never see', () => {
    // Her salary is invisible to me. The incoming leg in the joint account is
    // all I get, and it is enough: money arrived in the household from outside
    // the household's own accounts.
    //
    // `-unpaired` says there is only one row here, which is what lets the
    // Everything book count it — see the note on the flow. Everywhere else it
    // behaves as an ordinary contribution.
    expect(flowOf(3)).toBe('contribution-unpaired')
  })

  it('treats joint current to joint savings as a non-event', () => {
    expect(flowOf(9)).toBe('internal')
    expect(flowOf(10)).toBe('internal')
  })

  it('separates household spending from personal spending', () => {
    expect(flowOf(5)).toBe('household-spend')
    expect(flowOf(11)).toBe('personal-spend')
  })

  it('keeps outside money paid into the joint account apart from a contribution', () => {
    expect(flowOf(4)).toBe('external-income')
  })
})

describe('the household book', () => {
  const txns = march()
  const flows = classifyFlows(txns, books)
  const t = bookTotals(txns, flows, RULE, 'household', '2026-03', books)

  it('counts both contributions, including the one I cannot trace', () => {
    expect(t.contributions).toBe(380000)
  })

  it('counts outside income separately', () => {
    expect(t.externalIncome).toBe(8800)
  })

  it('counts only what left a joint account on a purchase', () => {
    // £2,400 of spending. The £1,000 moved to savings is not spending, and the
    // old "everything I can see" total counted my £700 of shopping here too.
    expect(t.spend).toBe(240000)
  })

  it('makes net equal what we actually saved', () => {
    // £3,888 in, £2,400 out. The joint balances rose by exactly this much, and
    // the £1,000 moved to savings nets to zero because it never left the book.
    expect(t.net).toBe(148800)
  })
})

describe('my own book', () => {
  const txns = march()
  const flows = classifyFlows(txns, books)
  const t = bookTotals(txns, flows, RULE, 'mine', '2026-03', books)

  it('shows my salary and nothing of the household', () => {
    expect(t.externalIncome).toBe(300000)
    expect(t.contributions).toBe(0)
  })

  it('treats contributing as neither spending nor saving', () => {
    expect(t.contributed).toBe(200000)
    expect(t.spend).toBe(70000)
  })

  it('leaves me with what is genuinely left', () => {
    // £3,000 − £2,000 contributed − £700 spent.
    expect(t.net).toBe(30000)
  })
})

describe('money coming back out of the household', () => {
  it('is a withdrawal on both sides, not household spending or fresh salary', () => {
    const out = txn({ accountId: 'joint', amountMinor: -25000, date: '2026-03-20', transferId: 'back' })
    const back = txn({ accountId: 'myPrivate', amountMinor: 25000, date: '2026-03-20', transferId: 'back' })
    const txns = [...march(), out, back]
    const flows = classifyFlows(txns, books)

    expect(flows.get(out.id)).toBe('withdrawal')
    expect(flows.get(back.id)).toBe('withdrawal')

    const house = bookTotals(txns, flows, RULE, 'household', '2026-03', books)
    expect(house.spend).toBe(240000) // unchanged — it was not spent
    expect(house.withdrawn).toBe(25000)
    expect(house.net).toBe(148800 - 25000)

    const me = bookTotals(txns, flows, RULE, 'mine', '2026-03', books)
    expect(me.externalIncome).toBe(300000) // salary, undisturbed
    expect(me.returned).toBe(25000)
    expect(me.net).toBe(30000 + 25000)
  })
})

describe('the payday ambiguity that used to block auto-linking', () => {
  it('gives the same answer whichever incoming leg mine is paired with', () => {
    // We both move £2,000 to the joint account on the same day. Which incoming
    // leg belongs to which outgoing leg is unknowable — and irrelevant, because
    // both readings land in the same book.
    const base = [
      txn({ accountId: 'myPrivate', amountMinor: 300000, date: '2026-03-01' }),
      txn({ accountId: 'joint', amountMinor: -50000, categoryId: 'groceries' }),
    ]
    const myOut = txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-03-02', transferId: 'A' })
    const inOne = txn({ accountId: 'joint', amountMinor: 200000, date: '2026-03-02', transferId: 'A' })
    const inTwo = txn({ accountId: 'joint', amountMinor: 200000, date: '2026-03-02', transferId: 'B' })

    const readingA = [...base, myOut, inOne, inTwo]
    // The other reading: my leg paired with the other arrival instead.
    const readingB = [
      ...base,
      { ...myOut, transferId: 'B' },
      { ...inOne, transferId: 'B' },
      { ...inTwo, transferId: 'A' },
    ]

    const totalsFor = (txns: Transaction[], book: 'household' | 'mine') =>
      bookTotals(txns, classifyFlows(txns, books), RULE, book, '2026-03', books)

    expect(totalsFor(readingA, 'household')).toEqual(totalsFor(readingB, 'household'))
    expect(totalsFor(readingA, 'mine')).toEqual(totalsFor(readingB, 'mine'))
  })
})

describe('spending by category, per book', () => {
  const cats: Category[] = [
    { id: 'home', name: 'Home & utilities', kind: 'expense', sortOrder: 0, updatedAt: 'x' },
    { id: 'mortgage', name: 'Mortgage', kind: 'expense', parentId: 'home', sortOrder: 1, updatedAt: 'x' },
    { id: 'water', name: 'Water', kind: 'expense', parentId: 'home', sortOrder: 2, updatedAt: 'x' },
    { id: 'shopping', name: 'Shopping', kind: 'expense', sortOrder: 3, updatedAt: 'x' },
  ]
  const txns = [
    txn({ accountId: 'joint', amountMinor: -120000, categoryId: 'mortgage' }),
    txn({ accountId: 'joint', amountMinor: -4000, categoryId: 'water' }),
    txn({ accountId: 'joint', amountMinor: -1000, categoryId: 'home' }),
    txn({ accountId: 'myPrivate', amountMinor: -70000, categoryId: 'shopping' }),
  ]
  const flows = classifyFlows(txns, books)

  it('rolls subcategories up to their parent, and keeps the books apart', () => {
    const house = bookSpendByCategory(txns, flows, RULE, cats, 'household', '2026-03', books)
    expect(house).toEqual([{ categoryId: 'home', totalMinor: 125000 }])

    // My shopping is in MY book, and must not appear in the household's pie.
    const mine = bookSpendByCategory(txns, flows, RULE, cats, 'mine', '2026-03', books)
    expect(house.find((s) => s.categoryId === 'shopping')).toBeUndefined()
    expect(mine).toEqual([{ categoryId: 'shopping', totalMinor: 70000 }])
  })

  it('drills into a parent without losing what was booked on the parent itself', () => {
    // The drill-down has to add up to the slice that was clicked, or it reads as
    // a bug even when both numbers are right.
    const inside = bookSpendByCategory(txns, flows, RULE, cats, 'household', '2026-03', books, 'home')

    expect(inside).toEqual([
      { categoryId: 'mortgage', totalMinor: 120000 },
      { categoryId: 'water', totalMinor: 4000 },
      { categoryId: 'home', totalMinor: 1000 },
    ])
    expect(inside.reduce((s, r) => s + r.totalMinor, 0)).toBe(125000)
  })
})

describe('money moved at the end of one month to be spent in the next', () => {
  // How we actually do it: both salaries land near the end of July, we move
  // most of each to the joint account on the 31st, and August's mortgage,
  // groceries and bills come out of that. Left on its own date, August reads
  // "paid in £0.57, spent £3,142" for most of the month.
  const july = [
    txn({ accountId: 'myPrivate', amountMinor: 300000, date: '2026-07-28', categoryId: 'salary' }),
    txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-07-31', transferId: 'julyMine' }),
    txn({ accountId: 'joint', amountMinor: 200000, date: '2026-07-31', transferId: 'julyMine' }),
    txn({ accountId: 'joint', amountMinor: 180000, date: '2026-07-31', transferId: 'julyHers' }),
  ]
  const august = [
    txn({ accountId: 'joint', amountMinor: -120000, date: '2026-08-03', categoryId: 'home' }),
    txn({ accountId: 'joint', amountMinor: -60000, date: '2026-08-12', categoryId: 'groceries' }),
    txn({ accountId: 'joint', amountMinor: 57, date: '2026-08-31', categoryId: 'interest' }),
  ]
  const txns = [...july, ...august]
  const flows = classifyFlows(txns, books)

  it('counts the contribution towards the month it was for', () => {
    const aug = bookTotals(txns, flows, RULE, 'household', '2026-08', books)

    expect(aug.contributions).toBe(380000)
    expect(aug.spend).toBe(180000)
    // Interest paid in on the 31st is an arrival like any other, so it funds
    // September rather than the month it landed in. One rule for everything
    // that comes IN — see `CONTRIBUTION_CUTOFF_DAY`.
    expect(aug.externalIncome).toBe(0)
    expect(bookTotals(txns, flows, RULE, 'household', '2026-09', books).externalIncome).toBe(57)
    expect(aug.net).toBe(380000 - 180000)
  })

  it('does not leave it counted in July as well', () => {
    const jul = bookTotals(txns, flows, RULE, 'household', '2026-07', books)

    expect(jul.contributions).toBe(0)
    expect(jul.income).toBe(0)
  })

  it('moves both legs together, so my book agrees about when it happened', () => {
    // The same event must not land in different months on either side of it.
    expect(bookTotals(txns, flows, RULE, 'mine', '2026-07', books).contributed).toBe(0)
    expect(bookTotals(txns, flows, RULE, 'mine', '2026-08', books).contributed).toBe(200000)
    // And the salary that paid for it moves WITH it. Shifting only the
    // contribution is half a rule: it left July holding a salary and no
    // contribution, and August holding a contribution and no salary, so the
    // personal book read "Earned £0 · To our household £2,909" every month.
    expect(bookTotals(txns, flows, RULE, 'mine', '2026-07', books).externalIncome).toBe(0)
    expect(bookTotals(txns, flows, RULE, 'mine', '2026-08', books).externalIncome).toBe(300000)
  })

  it('so a month holds the salary AND what it paid for, which is the point', () => {
    const aug = bookTotals(txns, flows, RULE, 'mine', '2026-08', books)
    expect(aug.income).toBe(300000)
    expect(aug.contributed).toBe(200000)
    expect(aug.net).toBe(100000)
    // July holds neither, rather than one of each.
    expect(bookTotals(txns, flows, RULE, 'mine', '2026-07', books).income).toBe(0)
    expect(bookTotals(txns, flows, RULE, 'mine', '2026-07', books).contributed).toBe(0)
  })

  it('leaves an ordinary mid-month salary exactly where it landed', () => {
    const midMonth = [txn({ accountId: 'myPrivate', amountMinor: 300000, date: '2026-08-15', categoryId: 'salary' })]
    const f = classifyFlows(midMonth, books)
    expect(bookTotals(midMonth, f, RULE, 'mine', '2026-08', books).externalIncome).toBe(300000)
    expect(bookTotals(midMonth, f, RULE, 'mine', '2026-09', books).externalIncome).toBe(0)
  })

  it('leaves a contribution made early in the month where it is', () => {
    // Somebody topping the joint account up on the 8th is funding this month,
    // not next. Only the end-of-month advance shifts.
    const early = [txn({ accountId: 'joint', amountMinor: 50000, date: '2026-08-08', transferId: 'topup' })]
    const f = classifyFlows(early, books)

    expect(bookTotals(early, f, RULE, 'household', '2026-08', books).contributions).toBe(50000)
    expect(bookTotals(early, f, RULE, 'household', '2026-09', books).contributions).toBe(0)
  })

  it('does not shift a withdrawal, which is not an advance on anything', () => {
    const out = txn({ accountId: 'joint', amountMinor: -25000, date: '2026-08-30', transferId: 'back' })
    const back = txn({ accountId: 'myPrivate', amountMinor: 25000, date: '2026-08-30', transferId: 'back' })
    const f = classifyFlows([out, back], books)

    expect(bookTotals([out, back], f, RULE, 'household', '2026-08', books).withdrawn).toBe(25000)
    expect(bookTotals([out, back], f, RULE, 'household', '2026-09', books).withdrawn).toBe(0)
  })
})

describe('a household that has moved its cutoffs', () => {
  it('shifts a contribution from the day the household chose, not the 25th', () => {
    // The bug this replaced: payday moves to the 23rd because the 25th is a
    // Sunday, the transfer follows it, and both fall back into the month they
    // were meant to leave — a whole month's funding in the wrong bucket.
    const rows = [
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-07-23', transferId: 'early' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-07-23', transferId: 'early' }),
    ]
    const f = classifyFlows(rows, books)
    const earlier = { contributionDay: 23, incomeDay: 23 }

    expect(bookTotals(rows, f, RULE, 'household', '2026-08', books).contributions).toBe(0)
    expect(bookTotals(rows, f, earlier, 'household', '2026-08', books).contributions).toBe(200000)
    expect(bookTotals(rows, f, earlier, 'household', '2026-07', books).contributions).toBe(0)
  })

  it('leaves everything where it lands when a cutoff is off', () => {
    const rows = [
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-07-31', transferId: 'late' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-07-31', transferId: 'late' }),
    ]
    const f = classifyFlows(rows, books)
    const off = { contributionDay: null, incomeDay: null }

    expect(bookTotals(rows, f, off, 'household', '2026-07', books).contributions).toBe(200000)
    expect(bookTotals(rows, f, off, 'household', '2026-08', books).contributions).toBe(0)
  })

  it('keeps the two cutoffs independent', () => {
    // The whole reason there are two. The salary arrives on the 24th and the
    // transfer goes on the 26th; one cutoff has to be wrong about one of them.
    const rows = [
      txn({ accountId: 'myPrivate', amountMinor: 300000, date: '2026-07-24', categoryId: 'salary' }),
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-07-26', transferId: 'split' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-07-26', transferId: 'split' }),
    ]
    const f = classifyFlows(rows, books)
    const split = { contributionDay: 25, incomeDay: 24 }

    // Both land in August, which is the month they fund — and neither had to
    // borrow the other's date to get there.
    expect(bookTotals(rows, f, split, 'mine', '2026-08', books).externalIncome).toBe(300000)
    expect(bookTotals(rows, f, split, 'household', '2026-08', books).contributions).toBe(200000)
    // Under one shared cutoff of 25 the salary falls back into July, which is
    // the half of the old behaviour that made "Earned" and "Paid in" disagree.
    expect(bookTotals(rows, f, RULE, 'mine', '2026-07', books).externalIncome).toBe(300000)
  })

  it('shifts income without shifting contributions, and the reverse', () => {
    const rows = [
      txn({ accountId: 'myPrivate', amountMinor: 300000, date: '2026-07-28', categoryId: 'salary' }),
      txn({ accountId: 'joint', amountMinor: 180000, date: '2026-07-28', transferId: 'hers' }),
    ]
    const f = classifyFlows(rows, books)

    const incomeOnly = { contributionDay: null, incomeDay: 25 }
    expect(bookTotals(rows, f, incomeOnly, 'mine', '2026-08', books).externalIncome).toBe(300000)
    expect(bookTotals(rows, f, incomeOnly, 'household', '2026-07', books).contributions).toBe(180000)

    const contributionsOnly = { contributionDay: 25, incomeDay: null }
    expect(bookTotals(rows, f, contributionsOnly, 'mine', '2026-07', books).externalIncome).toBe(300000)
    expect(bookTotals(rows, f, contributionsOnly, 'household', '2026-08', books).contributions).toBe(180000)
  })

  it('never shifts spending, however late in the month and however low the cutoff', () => {
    const rows = [txn({ accountId: 'joint', amountMinor: -60000, date: '2026-07-31', categoryId: 'groceries' })]
    const f = classifyFlows(rows, books)
    const aggressive = { contributionDay: 1, incomeDay: 1 }

    expect(bookTotals(rows, f, aggressive, 'household', '2026-07', books).spend).toBe(60000)
    expect(bookTotals(rows, f, aggressive, 'household', '2026-08', books).spend).toBe(0)
  })
})

describe('a row that says which month it is for', () => {
  const cats: Category[] = [
    { id: 'groceries', name: 'Groceries', kind: 'expense', sortOrder: 0, updatedAt: 'x' },
  ]

  it('moves spending, which no cutoff can', () => {
    const rows = [
      txn({ accountId: 'joint', amountMinor: -60000, date: '2026-07-04', categoryId: 'groceries', bookMonth: '2026-08' }),
    ]
    const f = classifyFlows(rows, books)

    expect(bookTotals(rows, f, RULE, 'household', '2026-07', books).spend).toBe(0)
    expect(bookTotals(rows, f, RULE, 'household', '2026-08', books).spend).toBe(60000)
  })

  it('carries the category breakdown with it, so the donut still adds up', () => {
    // The failure this prevents: a "£600 spent" heading over a donut of £0,
    // because the total moved the row and the breakdown did not.
    const rows = [
      txn({ accountId: 'joint', amountMinor: -60000, date: '2026-07-04', categoryId: 'groceries', bookMonth: '2026-08' }),
    ]
    const f = classifyFlows(rows, books)

    expect(bookSpendByCategory(rows, f, RULE, cats, 'household', '2026-08', books)).toEqual([
      { categoryId: 'groceries', totalMinor: 60000 },
    ])
    expect(bookSpendByCategory(rows, f, RULE, cats, 'household', '2026-07', books)).toEqual([])
  })

  it('beats a cutoff that would have moved it somewhere else', () => {
    // An answer somebody typed is never overridden by one the app inferred —
    // including "no, this one really is July's".
    const rows = [
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-07-31', transferId: 'pinned', bookMonth: '2026-07' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-07-31', transferId: 'pinned', bookMonth: '2026-07' }),
    ]
    const f = classifyFlows(rows, books)

    expect(bookTotals(rows, f, RULE, 'household', '2026-07', books).contributions).toBe(200000)
    expect(bookTotals(rows, f, RULE, 'household', '2026-08', books).contributions).toBe(0)
  })
})

describe('who put what into the household', () => {
  it('tells my contribution from hers, without seeing her account', () => {
    // Mine is traceable because one leg is in my own account. Hers is knowable
    // only by elimination: the far leg is in an account I am not on, and the
    // only accounts hidden from me belong to the other people here.
    const txns = march()
    const flows = classifyFlows(txns, books)
    const split = contributionSplit(txns, flows, RULE, '2026-03', books)

    expect(split.mineMinor).toBe(200000)
    expect(split.theirsMinor).toBe(180000)
    expect(split.otherMinor).toBe(8800) // child benefit
    expect(split.mineMinor + split.theirsMinor).toBe(380000)
  })

  it('does not claim to know who sent money nobody has linked', () => {
    // An unlinked arrival is indistinguishable from a tax refund — both are
    // just a credit in the joint account. It must not be attributed to anyone.
    const arrival = txn({ accountId: 'joint', amountMinor: 180000, date: '2026-03-02' })
    const flows = classifyFlows([arrival], books)
    const split = contributionSplit([arrival], flows, RULE, '2026-03', books)

    expect(split.mineMinor).toBe(0)
    expect(split.theirsMinor).toBe(0)
    expect(split.otherMinor).toBe(180000)
  })

  it('counts what somebody bought for the household on their own card', () => {
    // The second way money gets in, and it never passes through a joint
    // account: I buy the shop on my card. It used to be left out of this
    // split entirely, which is why the Sankey needed a band of its own for it.
    const rows = [
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-03-02', transferId: 'mine' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-03-02', transferId: 'mine' }),
      txn({ accountId: 'myPrivate', amountMinor: -9000, date: '2026-03-10', paidForHousehold: true, createdBy: ME }),
    ]
    const split = contributionSplit(rows, classifyFlows(rows, books), RULE, '2026-03', books, ME)

    expect(split.mineMinor).toBe(209000)
    expect(split.minePaidMinor).toBe(9000)
    expect(split.mineCount).toBe(2)
    expect(split.minePaidCount).toBe(1)
  })

  it('attributes a published one to whoever paid it, not to me', () => {
    // My partner's shopping, on her own card, reaching this device only because
    // her account publishes its household rows. `createdBy` is the right
    // question HERE and the wrong one for an arrival in a joint account — see
    // the note on `contributionSplit`.
    const rows = [
      txn({ accountId: 'herCard', amountMinor: -9000, date: '2026-03-10', paidForHousehold: true, createdBy: HER }),
    ]
    const split = contributionSplit(rows, classifyFlows(rows, books), RULE, '2026-03', books, ME)

    expect(split.theirsMinor).toBe(9000)
    expect(split.theirsPaidMinor).toBe(9000)
    expect(split.mineMinor).toBe(0)
  })

  it('will not guess when nothing says who paid', () => {
    const rows = [
      txn({ accountId: 'myPrivate', amountMinor: -9000, date: '2026-03-10', paidForHousehold: true }),
    ]
    const split = contributionSplit(rows, classifyFlows(rows, books), RULE, '2026-03', books, ME)

    expect(split.mineMinor).toBe(0)
    expect(split.theirsMinor).toBe(0)
    expect(split.otherMinor).toBe(9000)
  })

  it('adds up to what the household book says came in', () => {
    // The property the Sankey rests on: the bands are the split, the ribbon
    // widths are the totals, and a diagram whose left side does not add up
    // invents a "from what was already there" band to cover the difference.
    const rows = [
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-03-02', transferId: 'mine' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-03-02', transferId: 'mine' }),
      txn({ accountId: 'joint', amountMinor: 180000, date: '2026-03-02', transferId: 'hers' }),
      txn({ accountId: 'myPrivate', amountMinor: -9000, date: '2026-03-10', paidForHousehold: true, createdBy: ME }),
      txn({ accountId: 'herCard', amountMinor: -4400, date: '2026-03-11', paidForHousehold: true, createdBy: HER }),
    ]
    const f = classifyFlows(rows, books)
    const split = contributionSplit(rows, f, RULE, '2026-03', books, ME)

    expect(split.mineMinor + split.theirsMinor + split.otherMinor).toBe(
      bookTotals(rows, f, RULE, 'household', '2026-03', books).contributions,
    )
  })
})

describe('what the book held, at the start of a month and now', () => {
  const seeEverything = () => true

  it('winds the balance back to the 1st, and leaves today alone', () => {
    // March opens with £1,000 already in the joint accounts, then a month of
    // contributions, spending and one internal transfer runs through them.
    const opened = accounts.map((a) =>
      a.id === 'joint' ? { ...a, openingBalanceMinor: 100000 } : a,
    )
    const rows = [
      ...march(),
      // February, so it is inside the opening figure rather than the month.
      txn({ accountId: 'joint', amountMinor: -20000, date: '2026-02-10', categoryId: 'groceries' }),
    ]

    const b = bookBalances(opened, rows, 'household', books, '2026-03', seeEverything)!

    // £1,000 opening, less February's £200.
    expect(b.startMinor).toBe(80000)
    // …plus every joint row in March. The internal transfer nets to zero across
    // the two joint accounts, which is exactly why it is not an event.
    expect(b.nowMinor).toBe(80000 + 200000 + 180000 + 8800 - 120000 - 60000 - 25000 - 35000)
  })

  it('is undefined when any account in the book is one we can only see the total of', () => {
    // No line items means no way to wind the figure back — and dropping that
    // account would make "start" and "now" measure different sets of accounts.
    const canSee = (id: string) => id !== 'jointSavings'
    expect(bookBalances(accounts, march(), 'household', books, '2026-03', canSee)).toBeUndefined()
  })

  it('is undefined for a book with no accounts in it at all', () => {
    const noBooks: BookMap = { household: new Set(), mine: new Set(), others: new Set() }
    expect(bookBalances(accounts, march(), 'household', noBooks, '2026-03', seeEverything)).toBeUndefined()
  })

  it('counts only the accounts of the book it was asked about', () => {
    const b = bookBalances(accounts, march(), 'mine', books, '2026-03', seeEverything)!
    // Salary in, contribution out, personal spending.
    expect(b.nowMinor).toBe(300000 - 200000 - 70000)
    expect(b.startMinor).toBe(0)
  })
})

describe('what was left when the month started', () => {
  const seeEverything = () => true
  const opening = (
    rows: Transaction[],
    book: Parameters<typeof bookOpening>[4],
    month: string | string[],
    accs = accounts,
    rule = RULE,
  ) => bookOpening(accs, rows, classifyFlows(rows, books), rule, book, books, month, seeEverything)!

  /**
   * The seam this exists to close, in the shape it actually turns up in.
   *
   * The salary lands on the 25th of July, so it is August's money. £400 of it
   * is spent before the month turns, and that spending keeps its real date —
   * so it is July's. Neither month can be read on its own.
   */
  function paydayOverspill() {
    return [
      txn({ accountId: 'myPrivate', amountMinor: 300000, date: '2026-07-25', categoryId: 'salary' }),
      txn({ accountId: 'myPrivate', amountMinor: -40000, date: '2026-07-28', categoryId: 'shopping' }),
      txn({ accountId: 'myPrivate', amountMinor: -100000, date: '2026-08-10', categoryId: 'shopping' }),
    ]
  }

  it('carries last month`s overspill in as a negative leftover', () => {
    const rows = paydayOverspill()

    // July: the salary has gone to August, and the £400 spent out of it has not.
    const july = opening(rows, 'mine', '2026-07')
    expect(july.openingMinor).toBe(0)
    // The salary is sitting in the account and belongs to a later month, so
    // this is the amount by which July's card will fail to match the bank. Net
    // of August's own £1,000, because the figure's job is to be exactly that
    // difference rather than a sum of arrivals — see `BookOpening.laterMinor`.
    expect(july.laterMinor).toBe(300000 - 100000)

    // August opens £400 down: the money its salary has already spent.
    expect(opening(rows, 'mine', '2026-08').openingMinor).toBe(-40000)
  })

  it('makes the month`s figures add up to what the accounts hold', () => {
    // The whole point. £3,000 in, £400 spent in July and £1,000 in August, so
    // the account holds £1,600 — and that is what August's card must say once
    // the leftover is carried in, rather than the £2,000 it would say alone.
    const rows = paydayOverspill()
    const flows = classifyFlows(rows, books)
    const totals = bookTotals(rows, flows, RULE, 'mine', '2026-08', books)
    const o = opening(rows, 'mine', '2026-08')

    expect(totals.net).toBe(300000 - 100000)
    expect(o.openingMinor + totals.net).toBe(160000)
    expect(o.openingMinor + totals.net).toBe(
      bookBalances(accounts, rows, 'mine', books, '2026-08', seeEverything)!.nowMinor,
    )
  })

  it('holds `opening + net === next month`s opening` across every book', () => {
    // The identity that makes the leftover worth printing: every row is counted
    // in exactly one month, so the months chain. Break `effectiveMonth` or the
    // set of rows either function selects and this is what says so.
    const rows = [...paydayOverspill(), ...march()]
    const flows = classifyFlows(rows, books)

    for (const book of ['household', 'mine', 'all'] as const) {
      for (const m of ['2026-03', '2026-07', '2026-08']) {
        const here = opening(rows, book, m)
        const next = opening(rows, book, shiftMonth(m, 1))
        const net = bookTotals(rows, flows, RULE, book, m, books).net
        expect(`${book} ${m}: ${here.openingMinor + net}`).toBe(`${book} ${m}: ${next.openingMinor}`)
      }
    }
  })

  it('counts by the month a row is FOR, not the month it landed in', () => {
    // The one line that would be easy to write as `t.date < firstOfMonth` and
    // be silently wrong: that puts the salary of the 25th into August's opening
    // balance AND into August's income, counting it twice.
    const rows = paydayOverspill()
    const byDate = bookBalances(accounts, rows, 'mine', books, '2026-08', seeEverything)!

    expect(byDate.startMinor).toBe(260000)
    expect(opening(rows, 'mine', '2026-08').openingMinor).toBe(-40000)
  })

  it('does not shift anything for a household that has turned the rule off', () => {
    const rows = paydayOverspill()
    const off = { contributionDay: null, incomeDay: null }

    // Nothing shifts, so July keeps its own salary and August opens on what
    // was really left. Only August's own spending is still "later" in July,
    // which is a date rather than a rule and is unaffected either way.
    expect(opening(rows, 'mine', '2026-07', accounts, off).laterMinor).toBe(-100000)
    expect(opening(rows, 'mine', '2026-08', accounts, off).openingMinor).toBe(260000)
  })

  it('starts from the accounts` opening balances', () => {
    const opened = accounts.map((a) => (a.id === 'joint' ? { ...a, openingBalanceMinor: 100000 } : a))
    expect(opening(march(), 'household', '2026-03', opened).openingMinor).toBe(100000)
  })

  it('asks about a run of months as one period, not about its first', () => {
    // The year view's case. Asked for January alone, everything from February
    // on is "next month's money" — which would have Reports telling a household
    // that eleven months of its own salary is not counted in the year.
    const rows = paydayOverspill()
    const year = ['2026-07', '2026-08', '2026-09']

    const o = opening(rows, 'mine', year)
    expect(o.openingMinor).toBe(0)
    expect(o.laterMinor).toBe(0)

    // …and the identity still chains across the whole run.
    const flows = classifyFlows(rows, books)
    const net = year.reduce((n, m) => n + bookTotals(rows, flows, RULE, 'mine', m, books).net, 0)
    expect(o.openingMinor + net).toBe(160000)
  })

  it('is undefined on a book holding an account we can only see the total of', () => {
    // Same reason as `bookBalances`: no line items, so no winding it back — and
    // dropping the account would leave a leftover measuring a different set of
    // accounts from the figures it is added to.
    const rows = march()
    const flows = classifyFlows(rows, books)
    const canSee = (id: string) => id !== 'jointSavings'
    expect(bookOpening(accounts, rows, flows, RULE, 'household', books, '2026-03', canSee)).toBeUndefined()

    const noBooks: BookMap = { household: new Set(), mine: new Set(), others: new Set() }
    expect(bookOpening(accounts, rows, flows, RULE, 'mine', noBooks, '2026-03', seeEverything)).toBeUndefined()
  })
})

describe('adding several months into one set of figures', () => {
  it('sums the parts and RECOMPUTES the derived ones', () => {
    // `income` and `net` are derived from the other fields, so adding them
    // directly would count the same money twice.
    const rows = march()
    const one = bookTotals(rows, classifyFlows(rows, books), RULE, 'household', '2026-03', books)
    const two = sumBookTotals([one, one])

    expect(two.contributions).toBe(one.contributions * 2)
    expect(two.spend).toBe(one.spend * 2)
    expect(two.income).toBe(two.contributions + two.externalIncome + two.returned)
    expect(two.net).toBe(two.income - two.spend - two.contributed - two.withdrawn)
    expect(two.income).toBe(one.income * 2)
  })

  it('is all zeroes for no months at all', () => {
    const empty = sumBookTotals([])
    expect(empty.income).toBe(0)
    expect(empty.net).toBe(0)
    expect(empty.spend).toBe(0)
  })
})

describe('asking the same question of several months', () => {
  const cats: Category[] = [
    { id: 'home', name: 'Home & utilities', kind: 'expense', sortOrder: 0, updatedAt: 'x' },
    { id: 'shopping', name: 'Shopping', kind: 'expense', sortOrder: 1, updatedAt: 'x' },
  ]
  const rows = [
    txn({ accountId: 'joint', amountMinor: -120000, date: '2026-03-03', categoryId: 'home' }),
    txn({ accountId: 'joint', amountMinor: -30000, date: '2026-04-03', categoryId: 'home' }),
    txn({ accountId: 'joint', amountMinor: -5000, date: '2026-04-09', categoryId: 'shopping' }),
  ]
  const flows = classifyFlows(rows, books)
  const totalFor = (m: string | string[]) =>
    Object.fromEntries(
      bookSpendByCategory(rows, flows, RULE, cats, 'household', m, books).map((r) => [r.categoryId, r.totalMinor]),
    )

  it('a single key and an array of one are the same question', () => {
    expect(totalFor(['2026-03'])).toEqual(totalFor('2026-03'))
    expect(totalFor('2026-03')).toEqual({ home: 120000 })
  })

  it('adds a category up across every month it is given', () => {
    expect(totalFor(['2026-03', '2026-04'])).toEqual({ home: 150000, shopping: 5000 })
  })

  it('ignores months outside the set', () => {
    expect(totalFor(['2026-04'])).toEqual({ home: 30000, shopping: 5000 })
    expect(totalFor([])).toEqual({})
  })
})

describe('an arbitrary run of days', () => {
  const cats: Category[] = [
    { id: 'home', name: 'Home & utilities', kind: 'expense', sortOrder: 0, updatedAt: 'x' },
    { id: 'shopping', name: 'Shopping', kind: 'expense', sortOrder: 1, updatedAt: 'x' },
  ]

  it('counts both ends of the range', () => {
    const rows = [
      txn({ accountId: 'joint', amountMinor: -1000, date: '2026-03-09', categoryId: 'home' }),
      txn({ accountId: 'joint', amountMinor: -2000, date: '2026-03-10', categoryId: 'home' }),
      txn({ accountId: 'joint', amountMinor: -4000, date: '2026-03-20', categoryId: 'home' }),
      txn({ accountId: 'joint', amountMinor: -8000, date: '2026-03-21', categoryId: 'home' }),
    ]
    const t = bookTotalsInRange(rows, classifyFlows(rows, books), 'household', books, '2026-03-10', '2026-03-20')
    expect(t.spend).toBe(6000)
  })

  it('spans months without caring where they end', () => {
    const rows = [
      txn({ accountId: 'joint', amountMinor: -1000, date: '2026-03-28', categoryId: 'home' }),
      txn({ accountId: 'joint', amountMinor: -2000, date: '2026-04-03', categoryId: 'shopping' }),
    ]
    const flows = classifyFlows(rows, books)
    expect(bookTotalsInRange(rows, flows, 'household', books, '2026-03-25', '2026-04-05').spend).toBe(3000)

    const byCat = bookSpendByCategoryInRange(rows, flows, cats, 'household', books, '2026-03-25', '2026-04-05')
    expect(Object.fromEntries(byCat.map((r) => [r.categoryId, r.totalMinor]))).toEqual({
      home: 1000,
      shopping: 2000,
    })
  })

  it('counts a contribution on the day it moved, NOT the month it is for', () => {
    /**
     * The deliberate difference from `bookTotals`. The 25th cut-off moves a
     * contribution into the month it funds, and a fortnight in the middle of
     * March cannot answer "which month is this for" — so a range counts the day
     * the money actually moved, and the screen says so.
     */
    const rows = [
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-03-28', transferId: 'x' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-03-28', transferId: 'x' }),
    ]
    const flows = classifyFlows(rows, books)

    // bookTotals shifts it into April; the range does not.
    expect(bookTotals(rows, flows, RULE, 'household', '2026-04', books).contributions).toBe(200000)
    expect(bookTotalsInRange(rows, flows, 'household', books, '2026-03-01', '2026-03-31').contributions).toBe(200000)
    expect(bookTotalsInRange(rows, flows, 'household', books, '2026-04-01', '2026-04-30').contributions).toBe(0)
  })

  it('leaves a joint-to-savings transfer out, the way every other total does', () => {
    const rows = march()
    const t = bookTotalsInRange(rows, classifyFlows(rows, books), 'household', books, '2026-03-01', '2026-03-31')
    // Mortgage 1,200 + groceries 600 + utilities 250 + other home 350, and
    // nothing at all for the £1,000 moved from joint current to joint savings.
    expect(t.spend).toBe(240000)
    // Same answer as the month version, which is the point: a range that
    // happens to be a whole month must not disagree with `bookTotals`.
    expect(t.spend).toBe(bookTotals(rows, classifyFlows(rows, books), RULE, 'household', '2026-03', books).spend)
  })
})

describe('paying for the household out of my own pocket', () => {
  const cats: Category[] = [
    { id: 'groceries', name: 'Groceries', kind: 'expense', sortOrder: 0, updatedAt: 'x' },
  ]
  /**
   * The weekly shop, on my own card because the joint one was at home.
   *
   * Built once, not per call: `txn()` mints a fresh id each time, so a second
   * call would classify a different set of rows and every lookup by id would
   * miss.
   */
  const fixture = [
    txn({ accountId: 'myPrivate', amountMinor: 300000, date: '2026-03-01', categoryId: 'salary' }),
    txn({
      accountId: 'myPrivate',
      amountMinor: -9000,
      date: '2026-03-10',
      categoryId: 'groceries',
      paidForHousehold: true,
    }),
  ]
  const rows = () => fixture
  const flows = () => classifyFlows(fixture, books)

  it('is a contribution out of my book, not spending', () => {
    const t = bookTotals(rows(), flows(), RULE, 'mine', '2026-03', books)
    expect(t.spend).toBe(0)
    expect(t.contributed).toBe(9000)
    // Salary less what I put in. The £90 is not mine to have spent.
    expect(t.net).toBe(300000 - 9000)
  })

  it('is money in AND money out of the household book', () => {
    const t = bookTotals(rows(), flows(), RULE, 'household', '2026-03', books)
    expect(t.contributions).toBe(9000)
    expect(t.spend).toBe(9000)
    // Received and spent in the same breath.
    expect(t.net).toBe(0)
  })

  it('reaches the household category breakdown, even though it is in my account', () => {
    // The point of the whole feature: the household's grocery figure is the
    // household's real grocery figure.
    const byCat = bookSpendByCategory(rows(), flows(), RULE, cats, 'household', '2026-03', books)
    expect(byCat).toEqual([{ categoryId: 'groceries', totalMinor: 9000 }])
  })

  it('and stays out of mine', () => {
    expect(bookSpendByCategory(rows(), flows(), RULE, cats, 'mine', '2026-03', books)).toEqual([])
  })

  it('the categories still add up to the total above them', () => {
    // The failure `spendsIn` exists to prevent: a "£90 spent" heading over an
    // empty donut.
    for (const book of ['household', 'mine', 'all'] as const) {
      const total = bookTotals(rows(), flows(), RULE, book, '2026-03', books).spend
      const byCat = bookSpendByCategory(rows(), flows(), RULE, cats, book, '2026-03', books)
      expect(byCat.reduce((s, r) => s + r.totalMinor, 0)).toBe(total)
    }
  })

  it('is ordinary spending under Everything, counted once', () => {
    // My account and the joint one are one pool there, so the contribution is
    // internal again and what is left is simply spending.
    const t = bookTotals(rows(), flows(), RULE, 'all', '2026-03', books)
    expect(t.spend).toBe(9000)
    expect(t.contributions).toBe(0)
    expect(t.contributed).toBe(0)
  })

  it('ignores the flag on money coming IN', () => {
    // A refund landing back on the card is not a contribution to anything, and
    // crediting the household with it would invent money.
    const refund = [
      txn({ accountId: 'myPrivate', amountMinor: 9000, date: '2026-03-12', paidForHousehold: true }),
    ]
    const f = classifyFlows(refund, books)
    expect(bookTotals(refund, f, RULE, 'household', '2026-03', books).contributions).toBe(0)
    expect(bookTotals(refund, f, RULE, 'mine', '2026-03', books).externalIncome).toBe(9000)
  })

  it('does nothing when the flag is on a joint account', () => {
    // Already the household's money; there is nothing to move.
    const joint = [
      txn({ accountId: 'joint', amountMinor: -9000, date: '2026-03-10', categoryId: 'groceries', paidForHousehold: true }),
    ]
    const t = bookTotals(joint, classifyFlows(joint, books), RULE, 'household', '2026-03', books)
    expect(t.spend).toBe(9000)
    expect(t.contributions).toBe(0)
  })

  it('counts in a range the same way', () => {
    const t = bookTotalsInRange(rows(), flows(), 'household', books, '2026-03-01', '2026-03-31')
    expect(t.contributions).toBe(9000)
    expect(t.spend).toBe(9000)
  })
})

/**
 * The same feature, read from the OTHER device — which until migration 19 could
 * not read it at all.
 *
 * The row is my partner's weekly shop on her own card. Her account is not in
 * this device's cache and never will be: there is no grant behind it, and the
 * row reached us only because her account publishes its household spending. So
 * every fixture here has a transaction whose `accountId` is in no book, which
 * is a state nothing else in this file can produce.
 *
 * This is the property the household book was chosen for — complete and
 * identical on both devices — and `paid_for_household` was the one documented
 * thing that broke it.
 */
describe('a household expense published from an account this device is not on', () => {
  const cats: Category[] = [
    { id: 'groceries', name: 'Groceries', kind: 'expense', sortOrder: 0, updatedAt: 'x' },
  ]
  const fixture = [
    txn({ accountId: 'joint', amountMinor: -4000, date: '2026-03-04', categoryId: 'groceries' }),
    txn({
      accountId: 'herPrivate',
      amountMinor: -9000,
      date: '2026-03-10',
      categoryId: 'groceries',
      paidForHousehold: true,
    }),
  ]
  const flows = () => classifyFlows(fixture, books)
  const theirs = fixture[1]

  it('is household spending, not an ignored row', () => {
    // `bookOf` has nothing to say about the account, so before migration 19
    // this fell straight through to `ignored` — the row arrived and counted for
    // nothing, which is worse than not replicating it.
    expect(flows().get(theirs.id)).toBe('paid-for-household')
  })

  it('gives the household book the same figures as the payer sees', () => {
    const t = bookTotals(fixture, flows(), RULE, 'household', '2026-03', books)
    expect(t.contributions).toBe(9000)
    expect(t.spend).toBe(9000 + 4000)
  })

  it('reaches the household grocery figure', () => {
    expect(bookSpendByCategory(fixture, flows(), RULE, cats, 'household', '2026-03', books)).toEqual([
      { categoryId: 'groceries', totalMinor: 13000 },
    ])
  })

  it('is in neither of my own books', () => {
    // I did not contribute it, and Everything means the accounts this device
    // holds — which hers is not.
    for (const book of ['mine', 'all'] as const) {
      const t = bookTotals(fixture, flows(), RULE, book, '2026-03', books)
      expect(t.contributed).toBe(0)
      expect(t.contributions).toBe(0)
    }
    expect(bookTotals(fixture, flows(), RULE, 'mine', '2026-03', books).spend).toBe(0)
  })

  it('the categories still add up to the total above them', () => {
    for (const book of ['household', 'mine', 'all'] as const) {
      const total = bookTotals(fixture, flows(), RULE, book, '2026-03', books).spend
      const byCat = bookSpendByCategory(fixture, flows(), RULE, cats, book, '2026-03', books)
      expect(byCat.reduce((s, r) => s + r.totalMinor, 0)).toBe(total)
    }
  })

  it('is admitted to the household row list and to no other', () => {
    // The lists are built from "the accounts in this book that I may read",
    // which this row is not on — so without an explicit admission the household
    // list would come up short of the total printed over it.
    const inHousehold = new Set(books.household)
    expect(showsInBook(theirs, 'household', books, inHousehold)).toBe(true)
    // Under Mine and Everything the account is not one this device holds at
    // all, which is exactly what those books mean — and `bookTotals` agrees.
    expect(showsInBook(theirs, 'mine', books, new Set(books.mine))).toBe(false)
    expect(showsInBook(theirs, 'all', books, new Set([...books.household, ...books.mine]))).toBe(false)
  })

  it('and so is my OWN household shopping, which is the case that shipped broken', () => {
    // My card is an account I hold perfectly well, and still not one in the
    // household book — so selecting the list by account left my own row out of
    // Our household while the figure above it counted the money.
    const mine = txn({
      accountId: 'myPrivate',
      amountMinor: -9000,
      date: '2026-03-10',
      categoryId: 'groceries',
      paidForHousehold: true,
    })
    expect(showsInBook(mine, 'household', books, new Set(books.household))).toBe(true)
    // And it is in Mine and Everything the ordinary way, because the account is.
    expect(showsInBook(mine, 'mine', books, new Set(books.mine))).toBe(true)

    // The list and the heading over it have to agree, which is the whole point.
    const rows = [mine]
    const f = classifyFlows(rows, books)
    const shown = rows.filter((t) => showsInBook(t, 'household', books, new Set(books.household)))
    const heading = bookTotals(rows, f, RULE, 'household', '2026-03', books).spend
    expect(shown.reduce((s, t) => s - t.amountMinor, 0)).toBe(heading)
  })

  it('marks the rows the arithmetic counts, and only those', () => {
    expect(isHouseholdPaid(theirs, books)).toBe(true)
    // Already the household's money: nothing was moved between books.
    const joint = txn({ accountId: 'joint', amountMinor: -9000, date: '2026-03-10', paidForHousehold: true })
    expect(isHouseholdPaid(joint, books)).toBe(false)
    // A refund is not a contribution to anything.
    const refund = txn({ accountId: 'herPrivate', amountMinor: 9000, date: '2026-03-12', paidForHousehold: true })
    expect(isHouseholdPaid(refund, books)).toBe(false)
    expect(classifyFlows([refund], books).get(refund.id)).toBe('ignored')
  })
})

describe('saying which book an account is in', () => {
  const withOverride = (id: string, book: 'household' | 'mine') =>
    accounts.map((a) => (a.id === id ? { ...a, bookOverride: book } : a))

  it('wins over what the grants would have said', () => {
    // A joint account both of us are on, which we treat as one person's.
    const b = classifyAccounts(withOverride('joint', 'mine'), grantsByAccount, ME)
    expect(b.mine.has('joint')).toBe(true)
    expect(b.household.has('joint')).toBe(false)
  })

  it('works the other way too', () => {
    // My own account, which is really the household's float.
    const b = classifyAccounts(withOverride('myPrivate', 'household'), grantsByAccount, ME)
    expect(b.household.has('myPrivate')).toBe(true)
    expect(b.mine.has('myPrivate')).toBe(false)
  })

  it('rescues an account that derivation put in neither book', () => {
    // Somebody else's, shared with me at `balance` — I can see the total and
    // nothing else. Below `view`, so it counts as one person on it and I am not
    // the owner: `others`, which is in no book of mine at all.
    const shared = [...accounts, account('withMum')]
    const grants = new Map(grantsByAccount)
    grants.set('withMum', [grant('withMum', 'mum'), grant('withMum', ME, 'balance')])

    expect(classifyAccounts(shared, grants, ME).others.has('withMum')).toBe(true)

    const overridden = shared.map((a) => (a.id === 'withMum' ? { ...a, bookOverride: 'mine' as const } : a))
    const b = classifyAccounts(overridden, grants, ME)
    expect(b.mine.has('withMum')).toBe(true)
    expect(b.others.has('withMum')).toBe(false)
  })

  it('leaves everything alone when it is not set', () => {
    expect(classifyAccounts(accounts, grantsByAccount, ME)).toEqual(books)
  })
})

describe('saying who paid in, when there is no far leg to find', () => {
  /**
   * The case the far-leg model cannot reach: my wife is not using the app, so
   * her payment into the joint account is a lone positive row that nothing can
   * ever be paired with. `contributorId` is somebody saying whose it was.
   */
  const tagged = (over: Partial<Transaction> = {}) =>
    txn({
      accountId: 'joint',
      amountMinor: 180000,
      date: '2026-07-29',
      payee: 'A KAMINSKA',
      contributorId: HER,
      ...over,
    })

  it('counts it towards the month it was for, like any other contribution', () => {
    // The whole point. Money paid in on the 29th funds August; untagged, it
    // was ordinary income and stayed in July.
    const rows = [tagged()]
    const flows = classifyFlows(rows, books)

    expect(bookTotals(rows, flows, RULE, 'household', '2026-08', books).contributions).toBe(180000)
    expect(bookTotals(rows, flows, RULE, 'household', '2026-07', books).contributions).toBe(0)
  })

  it('leaves the household no better and no worse off', () => {
    // Tagging relabels and re-dates. It must not invent or remove money: the
    // same rows, in the month each lands in, come to the same income either way.
    const rows = [tagged()]
    const untagged = [tagged({ contributorId: undefined })]

    // Both land in August now — the shift is about the money arriving, not
    // about whether anybody has said whose it was — so the comparison is
    // between two readings of the SAME month rather than of two.
    const withTag = bookTotals(rows, classifyFlows(rows, books), RULE, 'household', '2026-08', books)
    const without = bookTotals(untagged, classifyFlows(untagged, books), RULE, 'household', '2026-08', books)

    expect(withTag.income).toBe(without.income)
    expect(withTag.net).toBe(without.net)
    // What changed is which bucket it is in, and that is all.
    expect(withTag.contributions).toBe(180000)
    expect(without.externalIncome).toBe(180000)
  })

  it('puts it on her name rather than in the unattributed bucket', () => {
    const rows = [tagged()]
    const split = contributionSplit(rows, classifyFlows(rows, books), RULE, '2026-08', books, ME)

    expect(split.theirsMinor).toBe(180000)
    expect(split.mineMinor).toBe(0)
    expect(split.otherMinor).toBe(0)
  })

  it('tells my own tag from hers', () => {
    const rows = [tagged({ contributorId: ME })]
    const split = contributionSplit(rows, classifyFlows(rows, books), RULE, '2026-08', books, ME)

    expect(split.mineMinor).toBe(180000)
    expect(split.theirsMinor).toBe(0)
  })

  it('beats the far-leg guess rather than being outvoted by it', () => {
    // A linked contribution whose far leg is mine, tagged to her. The explicit
    // answer wins: this is the correction path for an orphaned or mis-paired
    // transfer, and an answer somebody typed must not lose to an inference.
    const out = txn({ accountId: 'myPrivate', amountMinor: -180000, date: '2026-07-29', transferId: 'p' })
    const arrive = tagged({ transferId: 'p' })
    const rows = [out, arrive]
    const split = contributionSplit(rows, classifyFlows(rows, books), RULE, '2026-08', books, ME)

    expect(split.theirsMinor).toBe(180000)
    expect(split.mineMinor).toBe(0)
  })

  it('ignores a tag on money going out', () => {
    // A withdrawal is a different claim with a different sign, and crediting
    // the household with a negative contribution would invent money. The
    // server's check constraint refuses the row; this refuses to read it.
    const rows = [tagged({ amountMinor: -180000 })]
    const flows = classifyFlows(rows, books)

    expect(flows.get(rows[0].id)).toBe('household-spend')
    expect(bookTotals(rows, flows, RULE, 'household', '2026-07', books).contributions).toBe(0)
  })

  it('ignores a tag on a personal account', () => {
    // `contributorId` is a claim about money arriving in the HOUSEHOLD. On my
    // own account it is just my income.
    const rows = [tagged({ accountId: 'myPrivate' })]
    const flows = classifyFlows(rows, books)

    expect(flows.get(rows[0].id)).toBe('personal-income')
    // Dated the 29th, so it funds the following month like any other arrival.
    expect(bookTotals(rows, flows, RULE, 'mine', '2026-08', books).externalIncome).toBe(180000)
  })

  it('does not let a transfer be overruled by a tag', () => {
    // Two real rows beat a statement about one. Both legs are here, so this is
    // an ordinary internal movement and the tag has nothing to say about it.
    const out = txn({ accountId: 'joint', amountMinor: -50000, date: '2026-07-29', transferId: 's' })
    const into = txn({
      accountId: 'jointSavings',
      amountMinor: 50000,
      date: '2026-07-29',
      transferId: 's',
      contributorId: HER,
    })
    const rows = [out, into]
    const flows = classifyFlows(rows, books)

    expect(flows.get(into.id)).toBe('internal')
    expect(bookTotals(rows, flows, RULE, 'household', '2026-08', books).contributions).toBe(0)
  })

  it('still counts under Everything, where there is no second leg to double it', () => {
    // The regression `contribution-unpaired` exists to prevent. `bookTotals`
    // drops contributions under `all` because both legs are normally in view;
    // with only one row, dropping it deletes real income from the book.
    const rows = [tagged()]
    const flows = classifyFlows(rows, books)
    const all = bookTotals(rows, flows, RULE, 'all', '2026-08', books)

    expect(all.income).toBe(180000)
    // Filed as outside income there, which is what the Sankey draws in that
    // book — as a contribution it would be income the diagram never showed.
    expect(all.externalIncome).toBe(180000)
    expect(all.contributions).toBe(0)
  })

  it('counts a contribution she linked on her own device under Everything too', () => {
    // The same hole, reached the other way and pre-dating the tag: a leg with a
    // `transferId` and no partner row on this device.
    const herIn = txn({ accountId: 'joint', amountMinor: 180000, date: '2026-07-29', transferId: 'hers' })
    const flows = classifyFlows([herIn], books)

    expect(flows.get(herIn.id)).toBe('contribution-unpaired')
    expect(bookTotals([herIn], flows, RULE, 'all', '2026-08', books).income).toBe(180000)
  })

  it('leaves a genuinely paired contribution alone under Everything', () => {
    // Both legs visible, so counting either really would double it. This is the
    // case the `all` guard was written for and it must keep working.
    const out = txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-07-29', transferId: 'p' })
    const into = txn({ accountId: 'joint', amountMinor: 200000, date: '2026-07-29', transferId: 'p' })
    const rows = [out, into]

    expect(bookTotals(rows, classifyFlows(rows, books), RULE, 'all', '2026-08', books).income).toBe(0)
  })

  it('shifts an arrival nobody has claimed, because it is still an arrival', () => {
    // It is not a contribution until somebody says so — the flow stays
    // `external-income` and the split still refuses to put a name on it — but
    // WHEN it counts is a question about the money rather than about whose it
    // was, and money that turns up on the 29th is money the next month spends.
    const rows = [tagged({ contributorId: undefined })]
    const flows = classifyFlows(rows, books)

    expect(flows.get(rows[0].id)).toBe('external-income')
    expect(bookTotals(rows, flows, RULE, 'household', '2026-07', books).externalIncome).toBe(0)
    expect(bookTotals(rows, flows, RULE, 'household', '2026-08', books).externalIncome).toBe(180000)
  })

  it('keeps the categories adding up to the total above them', () => {
    // The `spendsIn` invariant, re-checked with the new flow in the mix: a
    // heading that disagrees with the donut under it reads as a bug even when
    // both figures are right.
    const cats: Category[] = [
      { id: 'home', name: 'Home', kind: 'expense', sortOrder: 0, updatedAt: 'x' },
      { id: 'groceries', name: 'Groceries', kind: 'expense', sortOrder: 1, updatedAt: 'x' },
      { id: 'utilities', name: 'Utilities', kind: 'expense', sortOrder: 2, updatedAt: 'x' },
      { id: 'shopping', name: 'Shopping', kind: 'expense', sortOrder: 3, updatedAt: 'x' },
    ]
    const rows = [...march(), tagged({ date: '2026-03-29' })]
    const flows = classifyFlows(rows, books)
    for (const book of ['household', 'mine', 'all'] as const) {
      const total = bookTotals(rows, flows, RULE, book, '2026-03', books).spend
      const byCat = bookSpendByCategory(rows, flows, RULE, cats, book, '2026-03', books)
      expect(byCat.reduce((s, r) => s + r.totalMinor, 0)).toBe(total)
    }
  })
})

/**
 * The bug that made Home and Reports print two different household spending
 * figures, stated as arithmetic so it cannot come back quietly.
 *
 * `bookTotals` and `spendsIn` deliberately reach OUTSIDE the book's own
 * accounts for one row type, so they have to be handed everything this device
 * can see. Home used to narrow the list by account first, which disables that
 * branch without erroring, without a warning, and without any figure on either
 * page saying which of them is the odd one out.
 */
describe('handing the aggregates a list that has already been narrowed', () => {
  const cats: Category[] = [
    { id: 'groceries', name: 'Groceries', kind: 'expense', sortOrder: 0, updatedAt: 'x' },
  ]
  const rows = [
    txn({ accountId: 'joint', amountMinor: -60000, date: '2026-03-06', categoryId: 'groceries' }),
    txn({
      accountId: 'myPrivate',
      amountMinor: -9000,
      date: '2026-03-10',
      categoryId: 'groceries',
      paidForHousehold: true,
      createdBy: ME,
    }),
  ]
  const flows = classifyFlows(rows, books)
  /** What `Dashboard.tsx` used to do before calling any of these. */
  const byAccount = (book: 'household' | 'mine' | 'all') => {
    const ids = accountsInBook(book, books)
    return rows.filter((t) => ids.has(t.accountId))
  }

  it('loses exactly the household spending that was paid from a personal account', () => {
    const whole = bookTotals(rows, flows, RULE, 'household', '2026-03', books)
    const narrowed = bookTotals(byAccount('household'), flows, RULE, 'household', '2026-03', books)

    expect(whole.spend).toBe(69000)
    expect(narrowed.spend).toBe(60000)
    expect(whole.spend - narrowed.spend).toBe(9000)
    // And "Paid in" is short by the same amount, which is why `net` still
    // agreed and only the two figures either side of it were wrong.
    expect(whole.contributions - narrowed.contributions).toBe(9000)
    expect(whole.net).toBe(narrowed.net)
  })

  it('loses it from the breakdown too, so the donut and its heading still agree', () => {
    // Both are wrong together, which is the reason nothing on screen looked
    // broken: £600 over a £600 donut, on a month that spent £690.
    const narrowed = bookSpendByCategory(byAccount('household'), flows, RULE, cats, 'household', '2026-03', books)
    expect(narrowed).toEqual([{ categoryId: 'groceries', totalMinor: 60000 }])
    expect(bookSpendByCategory(rows, flows, RULE, cats, 'household', '2026-03', books)).toEqual([
      { categoryId: 'groceries', totalMinor: 69000 },
    ])
  })

  it('changes nothing for the books that hold their own rows', () => {
    // Only the household book reaches outside itself, so `mine` and Everything
    // were never affected — which is what made the household figure look like
    // an isolated oddity rather than a rule being broken.
    for (const book of ['mine', 'all'] as const) {
      expect(bookTotals(byAccount(book), flows, RULE, book, '2026-03', books)).toEqual(
        bookTotals(rows, flows, RULE, book, '2026-03', books),
      )
    }
  })

  it('and `showsInBook` is the filter that keeps a row list honest', () => {
    // The list a page shows has the same problem as the figure above it: the
    // heading counted a row the list left out.
    const ids = accountsInBook('household', books)
    expect(rows.filter((t) => showsInBook(t, 'household', books, ids))).toHaveLength(2)
    expect(rows.filter((t) => ids.has(t.accountId))).toHaveLength(1)
  })
})

/**
 * How the three books relate — the arithmetic the Everything book has never
 * shown and is confusing for the want of.
 *
 * Two of the three add up exactly and one deliberately does not, and the one
 * that does not is the interesting one: a contribution is counted on BOTH sides
 * under Our household and Mine, because they are never summed. Under Everything
 * both legs are in view, so counting either would be a double count — which is
 * why Everything's income is not the other two added together, and why nobody
 * should ever "fix" it to be.
 */
describe('the books reconcile', () => {
  const rows = march()
  const flows = classifyFlows(rows, books)
  const of = (book: 'household' | 'mine' | 'all') => bookTotals(rows, flows, RULE, book, '2026-03', books)

  it('adds spending up exactly, while every account is one this device holds', () => {
    expect(of('all').spend).toBe(of('household').spend + of('mine').spend)
  })

  it('and short by exactly the rows bought from an account this device does not hold', () => {
    // The one place spending does NOT add up, and it is not a defect: Everything
    // means "every account this device can see", and my partner's card is not
    // one — only the single row she published from it is. So the row is
    // household spending and is in no account here, which is what the by-account
    // filter is for. It has to be a LINE on the reconciliation card rather than
    // a discrepancy the reader is left to find.
    const hers = txn({
      accountId: 'herCard',
      amountMinor: -4400,
      date: '2026-03-11',
      categoryId: 'groceries',
      paidForHousehold: true,
      createdBy: HER,
    })
    const withHers = [...rows, hers]
    const f = classifyFlows(withHers, books)
    const t = (book: 'household' | 'mine' | 'all') => bookTotals(withHers, f, RULE, book, '2026-03', books)

    expect(f.get(hers.id)).toBe('paid-for-household')
    expect(accountsInBook('all', books).has('herCard')).toBe(false)
    expect(t('household').spend + t('mine').spend - t('all').spend).toBe(4400)
    // Net is untouched, because the row is income and spending in the same
    // breath on the one side and absent from the other.
    expect(t('all').net).toBe(t('household').net + t('mine').net)
  })

  it('adds what is left up exactly, always', () => {
    // The one identity with no exceptions at all, which is why it is the one
    // the reconciliation card leads with: whatever the crossings did, and
    // whoever paid for what out of which account, the money still sitting in
    // the accounts is the money still sitting in the accounts.
    expect(of('all').net).toBe(of('household').net + of('mine').net)
  })

  it('does not add income up, and the difference is exactly the crossing', () => {
    // The row the reconciliation card has to carry, as an equation. A
    // contribution is counted once in each book, because the books are never
    // summed; under Everything both legs are in view, so it is counted in
    // neither. Nobody should ever "fix" this to add up.
    const crossing = of('mine').contributed + of('mine').returned

    expect(of('all').income).toBe(of('household').income + of('mine').income - crossing)
    expect(of('all').income).toBeLessThan(of('household').income + of('mine').income)
  })

  it('still adds up once somebody buys the shop on their own card', () => {
    // The row that belongs to two books at once is the one most likely to break
    // an identity like this, so it is checked with it in the mix.
    const withCard = [
      ...rows,
      txn({
        accountId: 'myPrivate',
        amountMinor: -9000,
        date: '2026-03-10',
        categoryId: 'groceries',
        paidForHousehold: true,
        createdBy: ME,
      }),
    ]
    const f = classifyFlows(withCard, books)
    const t = (book: 'household' | 'mine' | 'all') => bookTotals(withCard, f, RULE, book, '2026-03', books)

    expect(t('all').spend).toBe(t('household').spend + t('mine').spend)
    expect(t('all').net).toBe(t('household').net + t('mine').net)
    // And the income identity survives the row that belongs to two books,
    // because it left one book as a contribution and arrived in the other as
    // spending rather than as income.
    expect(t('all').income).toBe(
      t('household').income + t('mine').income - t('mine').contributed - t('mine').returned,
    )
  })
})

describe('who paid in, over more than one month', () => {
  const rows = [
    txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-03-02', transferId: 'm1' }),
    txn({ accountId: 'joint', amountMinor: 200000, date: '2026-03-02', transferId: 'm1' }),
    txn({ accountId: 'joint', amountMinor: 180000, date: '2026-03-02', transferId: 'h1' }),
    txn({ accountId: 'myPrivate', amountMinor: -210000, date: '2026-04-02', transferId: 'm2' }),
    txn({ accountId: 'joint', amountMinor: 210000, date: '2026-04-02', transferId: 'm2' }),
    txn({ accountId: 'myPrivate', amountMinor: -9000, date: '2026-04-10', paidForHousehold: true, createdBy: ME }),
  ]
  const flows = classifyFlows(rows, books)

  it('adds two months into one split', () => {
    // Reports asks this of a year. Asking for one month while the totals beside
    // it covered twelve is how eleven months of attributed money turned into
    // money with no name on it.
    const summed = sumContributionSplits([
      contributionSplit(rows, flows, RULE, '2026-03', books, ME),
      contributionSplit(rows, flows, RULE, '2026-04', books, ME),
    ])

    expect(summed.mineMinor).toBe(200000 + 210000 + 9000)
    expect(summed.theirsMinor).toBe(180000)
    expect(summed.minePaidMinor).toBe(9000)
    expect(summed.mineCount).toBe(3)
    expect(summed.minePaidCount).toBe(1)
  })

  it('and agrees with the household totals over the same months', () => {
    const summed = sumContributionSplits(
      ['2026-03', '2026-04'].map((m) => contributionSplit(rows, flows, RULE, m, books, ME)),
    )
    const totals = sumBookTotals(
      ['2026-03', '2026-04'].map((m) => bookTotals(rows, flows, RULE, 'household', m, books)),
    )

    expect(summed.mineMinor + summed.theirsMinor + summed.otherMinor).toBe(totals.contributions)
  })

  it('counts a range on the day the money moved, not the month it was for', () => {
    // The same rule `bookTotalsInRange` follows, and for the same reason: a
    // fortnight in the middle of March cannot answer "which month was this
    // for". The two have to agree, or a hand-drawn range shows a split that
    // does not add up to the figure above it.
    const late = [
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-03-28', transferId: 'late' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-03-28', transferId: 'late' }),
    ]
    const f = classifyFlows(late, books)

    // By month it belongs to April — it was moved on the 28th to be spent in it.
    expect(contributionSplit(late, f, RULE, '2026-04', books, ME).mineMinor).toBe(200000)
    expect(contributionSplit(late, f, RULE, '2026-03', books, ME).mineMinor).toBe(0)
    // By range it belongs to the day it moved.
    expect(contributionSplitInRange(late, f, books, '2026-03-01', '2026-03-31', ME).mineMinor).toBe(200000)
    expect(contributionSplitInRange(late, f, books, '2026-04-01', '2026-04-30', ME).mineMinor).toBe(0)
    expect(contributionSplitInRange(late, f, books, '2026-03-01', '2026-03-31', ME).mineMinor).toBe(
      bookTotalsInRange(late, f, 'household', books, '2026-03-01', '2026-03-31').contributions,
    )
  })
})

describe('spend per category per month, per book', () => {
  const cats: Category[] = [
    { id: 'groceries', name: 'Groceries', kind: 'expense', sortOrder: 0, updatedAt: 'x' },
    { id: 'shopping', name: 'Shopping', kind: 'expense', sortOrder: 1, updatedAt: 'x' },
  ]
  const months = ['2026-02', '2026-03']
  const rows = [
    txn({ accountId: 'joint', amountMinor: -50000, date: '2026-02-06', categoryId: 'groceries' }),
    txn({ accountId: 'joint', amountMinor: -60000, date: '2026-03-06', categoryId: 'groceries' }),
    txn({ accountId: 'myPrivate', amountMinor: -70000, date: '2026-03-08', categoryId: 'shopping' }),
    txn({
      accountId: 'myPrivate',
      amountMinor: -9000,
      date: '2026-03-10',
      categoryId: 'groceries',
      paidForHousehold: true,
      createdBy: ME,
    }),
    // A contribution leg is negative and in my account, and is not spending —
    // the flow-blind version of this function counted it.
    txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-03-02', transferId: 'm1' }),
    txn({ accountId: 'joint', amountMinor: 200000, date: '2026-03-02', transferId: 'm1' }),
  ]
  const flows = classifyFlows(rows, books)
  const series = (book: 'household' | 'mine' | 'all') =>
    bookMonthlySpendByCategory(rows, flows, RULE, cats, book, books, months)

  it('agrees month by month with the single-month breakdown', () => {
    // The failure this replaces: Budgets compared a current-month figure
    // computed one way against a six-month "typical" computed another.
    for (const book of ['household', 'mine', 'all'] as const) {
      const byMonth = series(book)
      months.forEach((m, i) => {
        const flat = new Map(
          bookSpendByCategory(rows, flows, RULE, cats, book, m, books).map((r) => [r.categoryId, r.totalMinor]),
        )
        for (const [categoryId, cells] of byMonth) {
          expect(cells[i]).toBe(flat.get(categoryId) ?? 0)
        }
      })
    }
  })

  it('puts a card-paid household shop in the household series and not in mine', () => {
    expect(series('household').get('groceries')).toEqual([50000, 69000])
    expect(series('mine').get('groceries')).toBeUndefined()
    expect(series('mine').get('shopping')).toEqual([0, 70000])
  })

  it('never counts a contribution leg as spending', () => {
    for (const book of ['household', 'mine', 'all'] as const) {
      for (const cells of series(book).values()) {
        expect(cells.every((v) => v < 200000)).toBe(true)
      }
    }
  })
})

describe('money put by rather than spent', () => {
  const rows = march()
  const flows = classifyFlows(rows, books)
  const savings = savingsAccounts(accounts, 'household', books)

  it('counts the arriving leg of a transfer into a savings account in the book', () => {
    expect(savings).toEqual(new Set(['jointSavings']))
    expect(savedInto(rows, flows, 'household', books, savings, '2026-03')).toBe(100000)
  })

  it('counts the arriving leg only', () => {
    // The pair nets to zero across the book, so counting both would show
    // nothing moving at all.
    expect(savedInto(rows, flows, 'household', books, savings, '2026-03')).not.toBe(0)
    expect(savedInto(rows, flows, 'household', books, savings, '2026-02')).toBe(0)
  })

  it('changes no total — it says which part of what is left stopped being available', () => {
    const before = bookTotals(rows, flows, RULE, 'household', '2026-03', books)
    expect(before.net).toBe(before.income - before.spend - before.withdrawn)
    expect(savedInto(rows, flows, 'household', books, savings, '2026-03')).toBeLessThanOrEqual(before.net)
  })

  it('is nothing at all in a book with no savings account in it', () => {
    expect(savingsAccounts(accounts, 'mine', books).size).toBe(0)
    expect(savedInto(rows, flows, 'mine', books, savingsAccounts(accounts, 'mine', books), '2026-03')).toBe(0)
  })
})

describe('the bridge between the books', () => {
  const hers = txn({
    accountId: 'herCard',
    amountMinor: -4400,
    date: '2026-03-11',
    categoryId: 'groceries',
    paidForHousehold: true,
    createdBy: HER,
  })
  const rows = [...march(), hers]
  const flows = classifyFlows(rows, books)
  const bridge = bookBridge(rows, flows, RULE, books, '2026-03')

  it('carries the same figures as asking each book directly', () => {
    for (const book of ['household', 'mine', 'all'] as const) {
      expect(bridge[book]).toEqual(bookTotals(rows, flows, RULE, book, '2026-03', books))
    }
  })

  it('names the crossing, which is why income does not add up', () => {
    expect(bridge.crossingMinor).toBe(bridge.mine.contributed + bridge.mine.returned)
    expect(bridge.all.income).toBe(
      bridge.household.income + bridge.mine.income - bridge.crossingMinor - bridge.unheldSpendMinor,
    )
  })

  it('names the spending Everything cannot see, which is why spending does not either', () => {
    expect(bridge.unheldSpendMinor).toBe(4400)
    expect(bridge.all.spend).toBe(bridge.household.spend + bridge.mine.spend - bridge.unheldSpendMinor)
  })

  it('and what is left adds up with nothing named at all', () => {
    expect(bridge.all.net).toBe(bridge.household.net + bridge.mine.net)
  })

  it('counts rows in an account that is in neither book rather than totalling them', () => {
    // Those rows are `ignored`, so they are in no figure on this device — not
    // even Everything's, despite its name. A column of figures reconciling with
    // nothing is the exact fault this card exists to remove.
    const shared = [...accounts, account('hersSharedWithMe')]
    const g = new Map(grantsByAccount)
    g.set('hersSharedWithMe', [grant('hersSharedWithMe', ME, 'view')])
    const b = classifyAccounts(shared, g, ME)
    // `march()` mints fresh ids on every call, so the base is built once.
    const base = march()
    const withRow = [...base, txn({ accountId: 'hersSharedWithMe', amountMinor: -5000, date: '2026-03-04' })]
    const f = classifyFlows(withRow, b)

    expect(bookBridge(withRow, f, RULE, b, '2026-03').unbookedCount).toBe(1)
    expect(bookTotals(withRow, f, RULE, 'all', '2026-03', b).spend).toBe(
      bookTotals(base, classifyFlows(base, b), RULE, 'all', '2026-03', b).spend,
    )
  })

  it('adds a year the same way it adds a month', () => {
    const year = bookBridge(rows, flows, RULE, books, ['2026-02', '2026-03'])
    expect(year.household.spend).toBe(bridge.household.spend)
    expect(year.all.net).toBe(year.household.net + year.mine.net)
  })
})

describe('spending split into each book\'s share', () => {
  const cats: Category[] = [
    { id: 'home', name: 'Home', kind: 'expense', sortOrder: 0, updatedAt: 'x' },
    { id: 'groceries', name: 'Groceries', kind: 'expense', sortOrder: 1, updatedAt: 'x' },
    { id: 'utilities', name: 'Utilities', kind: 'expense', sortOrder: 2, updatedAt: 'x' },
    { id: 'shopping', name: 'Shopping', kind: 'expense', sortOrder: 3, updatedAt: 'x' },
  ]
  const base = march()
  const flows = classifyFlows(base, books)
  const rows = bookSplitByCategory(base, flows, RULE, cats, books, '2026-03')
  const at = (id: string) => rows.find((r) => r.categoryId === id)!

  it('puts joint spending in the household half and personal spending in mine', () => {
    expect(at('groceries').householdMinor).toBe(60000)
    expect(at('groceries').mineMinor).toBe(0)
    expect(at('shopping').mineMinor).toBe(70000)
    expect(at('shopping').householdMinor).toBe(0)
  })

  it('agrees with the Everything total for each category', () => {
    const combined = new Map(
      bookSpendByCategory(base, flows, RULE, cats, 'all', '2026-03', books).map((r) => [r.categoryId, r.totalMinor]),
    )
    for (const r of rows) expect(r.totalMinor).toBe(combined.get(r.categoryId))
  })

  it('counts a card-paid household shop as the household\'s and not the payer\'s', () => {
    // The row that belongs to two books at once goes where each book puts it —
    // the same answer every other figure in the app gives.
    const withCard = [
      ...base,
      txn({
        accountId: 'myPrivate',
        amountMinor: -9000,
        date: '2026-03-10',
        categoryId: 'groceries',
        paidForHousehold: true,
        createdBy: ME,
      }),
    ]
    const f = classifyFlows(withCard, books)
    const g = bookSplitByCategory(withCard, f, RULE, cats, books, '2026-03').find((r) => r.categoryId === 'groceries')!

    expect(g.householdMinor).toBe(69000)
    expect(g.mineMinor).toBe(0)
    expect(g.totalMinor).toBe(69000)
  })

  it('lets the halves come to less than the total, and says so by construction', () => {
    // A published row from an account this device does not hold is the
    // household's spending and is in no account here, so Everything is short by
    // it — the same line the bridge card names. The total must NOT be
    // re-derived from the halves.
    const withHers = [
      ...base,
      txn({
        accountId: 'herCard',
        amountMinor: -4400,
        date: '2026-03-11',
        categoryId: 'groceries',
        paidForHousehold: true,
        createdBy: HER,
      }),
    ]
    const f = classifyFlows(withHers, books)
    const g = bookSplitByCategory(withHers, f, RULE, cats, books, '2026-03').find((r) => r.categoryId === 'groceries')!

    expect(g.householdMinor).toBe(64400)
    expect(g.totalMinor).toBe(60000)
    expect(g.householdMinor + g.mineMinor).toBeGreaterThan(g.totalMinor)
  })
})
