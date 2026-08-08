import { describe, expect, it } from 'vitest'
import type { Account, AccountGrant, Category, Transaction } from './db'
import {
  bookSpendByCategory,
  bookTotals,
  classifyAccounts,
  classifyFlows,
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
    expect(flowOf(3)).toBe('contribution')
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
