import { describe, expect, it } from 'vitest'
import type { Account, AccountGrant, Category, Transaction } from './db'
import {
  bookBalances,
  bookSpendByCategory,
  bookTotals,
  sumBookTotals,
  bookTotalsInRange,
  bookSpendByCategoryInRange,
  classifyAccounts,
  classifyFlows,
  contributionSplit,
  showsInBook,
  isHouseholdPaid,
  type BookMap,
} from './books'

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
  const t = bookTotals(txns, flows, 'household', '2026-03', books)

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
  const t = bookTotals(txns, flows, 'mine', '2026-03', books)

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

    const house = bookTotals(txns, flows, 'household', '2026-03', books)
    expect(house.spend).toBe(240000) // unchanged — it was not spent
    expect(house.withdrawn).toBe(25000)
    expect(house.net).toBe(148800 - 25000)

    const me = bookTotals(txns, flows, 'mine', '2026-03', books)
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
      bookTotals(txns, classifyFlows(txns, books), book, '2026-03', books)

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
    const house = bookSpendByCategory(txns, flows, cats, 'household', '2026-03', books)
    expect(house).toEqual([{ categoryId: 'home', totalMinor: 125000 }])

    // My shopping is in MY book, and must not appear in the household's pie.
    const mine = bookSpendByCategory(txns, flows, cats, 'mine', '2026-03', books)
    expect(house.find((s) => s.categoryId === 'shopping')).toBeUndefined()
    expect(mine).toEqual([{ categoryId: 'shopping', totalMinor: 70000 }])
  })

  it('drills into a parent without losing what was booked on the parent itself', () => {
    // The drill-down has to add up to the slice that was clicked, or it reads as
    // a bug even when both numbers are right.
    const inside = bookSpendByCategory(txns, flows, cats, 'household', '2026-03', books, 'home')

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
    const aug = bookTotals(txns, flows, 'household', '2026-08', books)

    expect(aug.contributions).toBe(380000)
    expect(aug.spend).toBe(180000)
    // Interest paid into the joint account is real outside income and stays
    // exactly where it landed.
    expect(aug.externalIncome).toBe(57)
    expect(aug.net).toBe(380000 + 57 - 180000)
  })

  it('does not leave it counted in July as well', () => {
    const jul = bookTotals(txns, flows, 'household', '2026-07', books)

    expect(jul.contributions).toBe(0)
    expect(jul.income).toBe(0)
  })

  it('moves both legs together, so my book agrees about when it happened', () => {
    // The same event must not land in different months on either side of it.
    expect(bookTotals(txns, flows, 'mine', '2026-07', books).contributed).toBe(0)
    expect(bookTotals(txns, flows, 'mine', '2026-08', books).contributed).toBe(200000)
    // My salary keeps its real date — only the contribution shifts.
    expect(bookTotals(txns, flows, 'mine', '2026-07', books).externalIncome).toBe(300000)
  })

  it('leaves a contribution made early in the month where it is', () => {
    // Somebody topping the joint account up on the 8th is funding this month,
    // not next. Only the end-of-month advance shifts.
    const early = [txn({ accountId: 'joint', amountMinor: 50000, date: '2026-08-08', transferId: 'topup' })]
    const f = classifyFlows(early, books)

    expect(bookTotals(early, f, 'household', '2026-08', books).contributions).toBe(50000)
    expect(bookTotals(early, f, 'household', '2026-09', books).contributions).toBe(0)
  })

  it('does not shift a withdrawal, which is not an advance on anything', () => {
    const out = txn({ accountId: 'joint', amountMinor: -25000, date: '2026-08-30', transferId: 'back' })
    const back = txn({ accountId: 'myPrivate', amountMinor: 25000, date: '2026-08-30', transferId: 'back' })
    const f = classifyFlows([out, back], books)

    expect(bookTotals([out, back], f, 'household', '2026-08', books).withdrawn).toBe(25000)
    expect(bookTotals([out, back], f, 'household', '2026-09', books).withdrawn).toBe(0)
  })
})

describe('who put what into the household', () => {
  it('tells my contribution from hers, without seeing her account', () => {
    // Mine is traceable because one leg is in my own account. Hers is knowable
    // only by elimination: the far leg is in an account I am not on, and the
    // only accounts hidden from me belong to the other people here.
    const txns = march()
    const flows = classifyFlows(txns, books)
    const split = contributionSplit(txns, flows, '2026-03', books)

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
    const split = contributionSplit([arrival], flows, '2026-03', books)

    expect(split.mineMinor).toBe(0)
    expect(split.theirsMinor).toBe(0)
    expect(split.otherMinor).toBe(180000)
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

describe('adding several months into one set of figures', () => {
  it('sums the parts and RECOMPUTES the derived ones', () => {
    // `income` and `net` are derived from the other fields, so adding them
    // directly would count the same money twice.
    const rows = march()
    const one = bookTotals(rows, classifyFlows(rows, books), 'household', '2026-03', books)
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
      bookSpendByCategory(rows, flows, cats, 'household', m, books).map((r) => [r.categoryId, r.totalMinor]),
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
    expect(bookTotals(rows, flows, 'household', '2026-04', books).contributions).toBe(200000)
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
    expect(t.spend).toBe(bookTotals(rows, classifyFlows(rows, books), 'household', '2026-03', books).spend)
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
    const t = bookTotals(rows(), flows(), 'mine', '2026-03', books)
    expect(t.spend).toBe(0)
    expect(t.contributed).toBe(9000)
    // Salary less what I put in. The £90 is not mine to have spent.
    expect(t.net).toBe(300000 - 9000)
  })

  it('is money in AND money out of the household book', () => {
    const t = bookTotals(rows(), flows(), 'household', '2026-03', books)
    expect(t.contributions).toBe(9000)
    expect(t.spend).toBe(9000)
    // Received and spent in the same breath.
    expect(t.net).toBe(0)
  })

  it('reaches the household category breakdown, even though it is in my account', () => {
    // The point of the whole feature: the household's grocery figure is the
    // household's real grocery figure.
    const byCat = bookSpendByCategory(rows(), flows(), cats, 'household', '2026-03', books)
    expect(byCat).toEqual([{ categoryId: 'groceries', totalMinor: 9000 }])
  })

  it('and stays out of mine', () => {
    expect(bookSpendByCategory(rows(), flows(), cats, 'mine', '2026-03', books)).toEqual([])
  })

  it('the categories still add up to the total above them', () => {
    // The failure `spendsIn` exists to prevent: a "£90 spent" heading over an
    // empty donut.
    for (const book of ['household', 'mine', 'all'] as const) {
      const total = bookTotals(rows(), flows(), book, '2026-03', books).spend
      const byCat = bookSpendByCategory(rows(), flows(), cats, book, '2026-03', books)
      expect(byCat.reduce((s, r) => s + r.totalMinor, 0)).toBe(total)
    }
  })

  it('is ordinary spending under Everything, counted once', () => {
    // My account and the joint one are one pool there, so the contribution is
    // internal again and what is left is simply spending.
    const t = bookTotals(rows(), flows(), 'all', '2026-03', books)
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
    expect(bookTotals(refund, f, 'household', '2026-03', books).contributions).toBe(0)
    expect(bookTotals(refund, f, 'mine', '2026-03', books).externalIncome).toBe(9000)
  })

  it('does nothing when the flag is on a joint account', () => {
    // Already the household's money; there is nothing to move.
    const joint = [
      txn({ accountId: 'joint', amountMinor: -9000, date: '2026-03-10', categoryId: 'groceries', paidForHousehold: true }),
    ]
    const t = bookTotals(joint, classifyFlows(joint, books), 'household', '2026-03', books)
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
    const t = bookTotals(fixture, flows(), 'household', '2026-03', books)
    expect(t.contributions).toBe(9000)
    expect(t.spend).toBe(9000 + 4000)
  })

  it('reaches the household grocery figure', () => {
    expect(bookSpendByCategory(fixture, flows(), cats, 'household', '2026-03', books)).toEqual([
      { categoryId: 'groceries', totalMinor: 13000 },
    ])
  })

  it('is in neither of my own books', () => {
    // I did not contribute it, and Everything means the accounts this device
    // holds — which hers is not.
    for (const book of ['mine', 'all'] as const) {
      const t = bookTotals(fixture, flows(), book, '2026-03', books)
      expect(t.contributed).toBe(0)
      expect(t.contributions).toBe(0)
    }
    expect(bookTotals(fixture, flows(), 'mine', '2026-03', books).spend).toBe(0)
  })

  it('the categories still add up to the total above them', () => {
    for (const book of ['household', 'mine', 'all'] as const) {
      const total = bookTotals(fixture, flows(), book, '2026-03', books).spend
      const byCat = bookSpendByCategory(fixture, flows(), cats, book, '2026-03', books)
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
    const heading = bookTotals(rows, f, 'household', '2026-03', books).spend
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

    expect(bookTotals(rows, flows, 'household', '2026-08', books).contributions).toBe(180000)
    expect(bookTotals(rows, flows, 'household', '2026-07', books).contributions).toBe(0)
  })

  it('leaves the household no better and no worse off', () => {
    // Tagging relabels and re-dates. It must not invent or remove money: the
    // same rows, in the month each lands in, come to the same income either way.
    const rows = [tagged()]
    const untagged = [tagged({ contributorId: undefined })]

    const withTag = bookTotals(rows, classifyFlows(rows, books), 'household', '2026-08', books)
    const without = bookTotals(untagged, classifyFlows(untagged, books), 'household', '2026-07', books)

    expect(withTag.income).toBe(without.income)
    expect(withTag.net).toBe(without.net)
    // What changed is which bucket it is in, and that is all.
    expect(withTag.contributions).toBe(180000)
    expect(without.externalIncome).toBe(180000)
  })

  it('puts it on her name rather than in the unattributed bucket', () => {
    const rows = [tagged()]
    const split = contributionSplit(rows, classifyFlows(rows, books), '2026-08', books, ME)

    expect(split.theirsMinor).toBe(180000)
    expect(split.mineMinor).toBe(0)
    expect(split.otherMinor).toBe(0)
  })

  it('tells my own tag from hers', () => {
    const rows = [tagged({ contributorId: ME })]
    const split = contributionSplit(rows, classifyFlows(rows, books), '2026-08', books, ME)

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
    const split = contributionSplit(rows, classifyFlows(rows, books), '2026-08', books, ME)

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
    expect(bookTotals(rows, flows, 'household', '2026-07', books).contributions).toBe(0)
  })

  it('ignores a tag on a personal account', () => {
    // `contributorId` is a claim about money arriving in the HOUSEHOLD. On my
    // own account it is just my income.
    const rows = [tagged({ accountId: 'myPrivate' })]
    const flows = classifyFlows(rows, books)

    expect(flows.get(rows[0].id)).toBe('personal-income')
    expect(bookTotals(rows, flows, 'mine', '2026-07', books).externalIncome).toBe(180000)
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
    expect(bookTotals(rows, flows, 'household', '2026-08', books).contributions).toBe(0)
  })

  it('still counts under Everything, where there is no second leg to double it', () => {
    // The regression `contribution-unpaired` exists to prevent. `bookTotals`
    // drops contributions under `all` because both legs are normally in view;
    // with only one row, dropping it deletes real income from the book.
    const rows = [tagged()]
    const flows = classifyFlows(rows, books)
    const all = bookTotals(rows, flows, 'all', '2026-08', books)

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
    expect(bookTotals([herIn], flows, 'all', '2026-08', books).income).toBe(180000)
  })

  it('leaves a genuinely paired contribution alone under Everything', () => {
    // Both legs visible, so counting either really would double it. This is the
    // case the `all` guard was written for and it must keep working.
    const out = txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-07-29', transferId: 'p' })
    const into = txn({ accountId: 'joint', amountMinor: 200000, date: '2026-07-29', transferId: 'p' })
    const rows = [out, into]

    expect(bookTotals(rows, classifyFlows(rows, books), 'all', '2026-08', books).income).toBe(0)
  })

  it('does not shift an arrival nobody has claimed', () => {
    // Until somebody says it is a contribution it is ordinary income, and
    // guessing would move a tax refund into next month.
    const rows = [tagged({ contributorId: undefined })]
    const flows = classifyFlows(rows, books)

    expect(bookTotals(rows, flows, 'household', '2026-07', books).externalIncome).toBe(180000)
    expect(bookTotals(rows, flows, 'household', '2026-08', books).externalIncome).toBe(0)
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
      const total = bookTotals(rows, flows, book, '2026-03', books).spend
      const byCat = bookSpendByCategory(rows, flows, cats, book, '2026-03', books)
      expect(byCat.reduce((s, r) => s + r.totalMinor, 0)).toBe(total)
    }
  })
})
