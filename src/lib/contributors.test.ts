import { describe, expect, it } from 'vitest'
import type { Account, AccountGrant, Transaction } from './db'
import { classifyAccounts, type BookMap } from './books'
import {
  CONFIRMATIONS_NEEDED,
  learnContributors,
  similarArrivals,
  suggestContributor,
  taggable,
} from './contributors'

const ME = 'gabi'
const HER = 'wife'

const account = (id: string): Account => ({
  id,
  name: id,
  kind: 'current',
  openingBalanceMinor: 0,
  sortOrder: 0,
  updatedAt: 'x',
})

const grant = (accountId: string, userId: string): AccountGrant => ({
  id: `${accountId}:${userId}`,
  accountId,
  userId,
  level: 'owner',
  updatedAt: 'x',
})

const books: BookMap = classifyAccounts(
  [account('joint'), account('myPrivate')],
  new Map([
    ['joint', [grant('joint', ME), grant('joint', HER)]],
    ['myPrivate', [grant('myPrivate', ME)]],
  ]),
  ME,
)

let seq = 0
const txn = (over: Partial<Transaction> & { accountId: string; amountMinor: number }): Transaction => ({
  id: `t${++seq}`,
  date: '2026-07-29',
  payee: 'A KAMINSKA',
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

/** Her monthly payment in, `n` times, under the same statement text. */
const paidIn = (n: number, over: Partial<Transaction> = {}) =>
  Array.from({ length: n }, (_, i) =>
    txn({ accountId: 'joint', amountMinor: 180000, contributorId: HER, date: `2026-0${i + 1}-29`, ...over }),
  )

describe('learning who pays in under which name', () => {
  it('says nothing until the payee has been confirmed twice', () => {
    // One is an accident or a one-off gift. The floor is what stops a single
    // tap teaching the app something it will then act on for ever.
    expect(learnContributors(paidIn(1), books).size).toBe(0)
    expect(learnContributors(paidIn(CONFIRMATIONS_NEEDED), books).size).toBe(1)
  })

  it('suggests her for the next one', () => {
    const learned = learnContributors(paidIn(2), books)
    expect(suggestContributor('A KAMINSKA', learned)).toBe(HER)
  })

  it('sees through the reference the bank staples on each month', () => {
    // The whole reason this matches fuzzily: statement text carries a date or
    // a reference that changes every time, so an exact match would learn
    // something that is never asked again.
    const learned = learnContributors(paidIn(2), books)
    expect(suggestContributor('A KAMINSKA 27JUL26', learned)).toBe(HER)
    expect(suggestContributor('A Kaminska ref 99812', learned)).toBe(HER)
  })

  it('says nothing about a payee it has never been told about', () => {
    const learned = learnContributors(paidIn(2), books)
    expect(suggestContributor('BRITISH GAS', learned)).toBeUndefined()
  })

  it('refuses to guess when a payee has been two different people', () => {
    // Exactly the case where a suggestion would be a coin toss, and the person
    // who knows is right there.
    const rows = [...paidIn(2), ...paidIn(2, { contributorId: ME })]
    expect(learnContributors(rows, books).size).toBe(0)
  })

  it('learns only from household accounts', () => {
    // A tag on a personal account means nothing — `classifyFlows` does not read
    // it there — so it must not teach anything either.
    expect(learnContributors(paidIn(3, { accountId: 'myPrivate' }), books).size).toBe(0)
  })

  it('learns only from money coming in', () => {
    expect(learnContributors(paidIn(3, { amountMinor: -180000 }), books).size).toBe(0)
  })

  it('forgets when the rows are untagged', () => {
    // The reason there is no table: the tagged rows ARE the memory, so undoing
    // them undoes the learning with nothing to clean up.
    expect(learnContributors(paidIn(3, { contributorId: undefined }), books).size).toBe(0)
  })
})

describe('which rows the question can be asked about', () => {
  it('accepts money arriving in a joint account', () => {
    expect(taggable(txn({ accountId: 'joint', amountMinor: 180000 }), books)).toBe(true)
  })

  it('refuses money going out', () => {
    expect(taggable(txn({ accountId: 'joint', amountMinor: -180000 }), books)).toBe(false)
  })

  it('refuses a personal account', () => {
    expect(taggable(txn({ accountId: 'myPrivate', amountMinor: 180000 }), books)).toBe(false)
  })

  it('refuses a row that is already half of a transfer', () => {
    // Two real rows beat a statement about one, and `classifyFlows` reads the
    // tag only where there is no transfer — so offering it here would be
    // offering a control that does nothing.
    expect(taggable(txn({ accountId: 'joint', amountMinor: 180000, transferId: 'p' }), books)).toBe(false)
  })
})

describe('the other arrivals from the same payee', () => {
  it('finds them, and leaves out the ones already tagged to that person', () => {
    // Offering to do what is already done makes the count on the checkbox a lie.
    const already = txn({ accountId: 'joint', amountMinor: 180000, contributorId: HER })
    const untagged = txn({ accountId: 'joint', amountMinor: 180000 })
    const elsewhere = txn({ accountId: 'joint', amountMinor: 4200, payee: 'BRITISH GAS' })

    const found = similarArrivals('A KAMINSKA', HER, [already, untagged, elsewhere], books)
    expect(found.map((t) => t.id)).toEqual([untagged.id])
  })

  it('leaves out the row being edited', () => {
    const row = txn({ accountId: 'joint', amountMinor: 180000 })
    expect(similarArrivals('A KAMINSKA', HER, [row], books, row.id)).toEqual([])
  })

  it('includes one tagged to somebody else, which is a correction', () => {
    const wrong = txn({ accountId: 'joint', amountMinor: 180000, contributorId: ME })
    expect(similarArrivals('A KAMINSKA', HER, [wrong], books).map((t) => t.id)).toEqual([wrong.id])
  })
})
