import { describe, expect, it } from 'vitest'
import type { Account, AccountGrant, Transaction } from './db'
import { classifyAccounts, classifyFlows, type BookMap } from './books'
import { askedOfMe, isAsking, looksLikeTransfer, unexplainedLegs, unexplainedTotals } from './unexplained'

/**
 * Same household as books.test.ts, seen from Gabi's device: he is on both joint
 * accounts and his own private one, and cannot see a single row of his
 * partner's.
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

const accounts = [account('joint'), account('jointSavings', 'savings'), account('myPrivate')]

const books: BookMap = classifyAccounts(
  accounts,
  new Map([
    ['joint', [grant('joint', ME), grant('joint', HER)]],
    ['jointSavings', [grant('jointSavings', ME), grant('jointSavings', HER)]],
    ['myPrivate', [grant('myPrivate', ME)]],
  ]),
  ME,
)

let seq = 0
const txn = (over: Partial<Transaction> & { accountId: string; amountMinor: number }): Transaction => ({
  id: `t${++seq}`,
  date: '2026-03-15',
  payee: 'x',
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

const legsOf = (txns: Transaction[], month?: string) =>
  unexplainedLegs(txns, classifyFlows(txns, books), books, month)

describe('spotting a movement only the other person can confirm', () => {
  it('flags money leaving the joint account that reads as a transfer', () => {
    // The case that does damage: this is counted as household SPENDING, which
    // is what budgets measure, until she links it from her side.
    const rows = [txn({ accountId: 'joint', amountMinor: -180000, payee: 'FASTER PAYMENT TO S SMITH' })]

    const legs = legsOf(rows)

    expect(legs).toHaveLength(1)
    expect(legs[0].direction).toBe('out')
  })

  it('flags an arrival with no partner leg', () => {
    const rows = [txn({ accountId: 'joint', amountMinor: 180000, payee: 'TFR FROM S SMITH' })]
    expect(legsOf(rows).map((l) => l.direction)).toEqual(['in'])
  })

  it('says nothing about a transfer that IS linked', () => {
    // Both legs visible, so it is already understood — and one that only she
    // can see is a contribution the moment she links it.
    const rows = [
      txn({ accountId: 'myPrivate', amountMinor: -200000, payee: 'TFR TO JOINT', transferId: 'a' }),
      txn({ accountId: 'joint', amountMinor: 200000, payee: 'TFR FROM GABI', transferId: 'a' }),
      txn({ accountId: 'joint', amountMinor: 180000, payee: 'TFR FROM S SMITH', transferId: 'b' }),
    ]
    expect(legsOf(rows)).toHaveLength(0)
  })

  it('takes a category as the answer, whatever the statement called it', () => {
    // Somebody has said what this is. Overriding them on the strength of a word
    // in the payee is exactly the guessing this file refuses to do.
    const rows = [
      txn({ accountId: 'joint', amountMinor: -6000, payee: 'STANDING ORDER GYM', categoryId: 'health' }),
    ]
    expect(legsOf(rows)).toHaveLength(0)
  })

  it('leaves an ordinary purchase alone, however large', () => {
    // No amount heuristic anywhere: a suspiciously round £2,000 is how you end
    // up flagging somebody's sofa.
    const rows = [
      txn({ accountId: 'joint', amountMinor: -200000, payee: 'JOHN LEWIS' }),
      txn({ accountId: 'joint', amountMinor: -4550, payee: 'TESCO STORES 3456' }),
    ]
    expect(legsOf(rows)).toHaveLength(0)
  })

  it('ignores a bill payment, which is explained already', () => {
    const rows = [
      txn({ accountId: 'joint', amountMinor: -120000, payee: 'STANDING ORDER NATIONWIDE', billId: 'b1' }),
    ]
    expect(legsOf(rows)).toHaveLength(0)
  })

  it('says nothing about my own accounts', () => {
    // Both legs of a movement between my accounts are on this device, so an
    // unlinked one is a pairing job the review list already offers — not an
    // unanswerable question.
    const rows = [txn({ accountId: 'myPrivate', amountMinor: -50000, payee: 'TFR TO SAVINGS' })]
    expect(legsOf(rows)).toHaveLength(0)
  })

  it('narrows to one month when asked', () => {
    const rows = [
      txn({ accountId: 'joint', amountMinor: -180000, payee: 'TFR TO S SMITH', date: '2026-03-10' }),
      txn({ accountId: 'joint', amountMinor: -180000, payee: 'TFR TO S SMITH', date: '2026-02-10' }),
    ]
    expect(legsOf(rows, '2026-03')).toHaveLength(1)
    expect(legsOf(rows)).toHaveLength(2)
  })

  it('is newest first', () => {
    const rows = [
      txn({ accountId: 'joint', amountMinor: -1000, payee: 'TFR ONE', date: '2026-03-01' }),
      txn({ accountId: 'joint', amountMinor: -1000, payee: 'TFR TWO', date: '2026-03-20' }),
    ]
    expect(legsOf(rows).map((l) => l.txn.date)).toEqual(['2026-03-20', '2026-03-01'])
  })
})

describe('what the words are worth', () => {
  const t = (payee: string, over: Partial<Transaction> = {}) =>
    txn({ accountId: 'joint', amountMinor: -100, payee, ...over })

  it('reads the raw payee, not the normalised one', () => {
    // normalizePayee strips exactly these words as noise, because for merchant
    // identity they are. Here they are the whole signal.
    expect(looksLikeTransfer(t('TFR TO SAVINGS'))).toBe(true)
    expect(looksLikeTransfer(t('BGC CREDIT'))).toBe(true)
    expect(looksLikeTransfer(t('FASTER PAYMENT TO J BLOGGS'))).toBe(true)
    expect(looksLikeTransfer(t('Payment from Sam'))).toBe(true)
  })

  it('does not fire on a word that merely contains one', () => {
    expect(looksLikeTransfer(t('TRANSFERWISE-ISH LTD'))).toBe(false)
    expect(looksLikeTransfer(t('BGCO SUPPLIES'))).toBe(false)
  })

  it('takes FP only where a direction follows it', () => {
    // Two letters on their own are far too easy to hit inside a merchant code,
    // and a false positive marks an ordinary purchase as possibly not spending.
    expect(looksLikeTransfer(t('FP TO J BLOGGS'))).toBe(true)
    expect(looksLikeTransfer(t('FP GROUP LTD'))).toBe(false)
  })

  it('leaves two dozen ordinary UK merchants alone', () => {
    const merchants = [
      'TESCO STORES 3456', 'SAINSBURYS S/MKT', 'AMAZON.CO.UK*MK1TR', 'JOHN LEWIS PLC',
      'TFL TRAVEL CH', 'SPOTIFY UK', 'OCTOPUS ENERGY LTD', 'NATIONWIDE MTG 0021',
      'PRET A MANGER', 'SHELL SERVICE STN', 'BOOTS THE CHEMIST', 'TRANSFERWISE LTD',
      'WISE PAYMENTS', 'GREGGS PLC', 'ARGOS RETAIL', 'B&Q 1234', 'SPORTS DIRECT',
      'APPLE.COM/BILL', 'UBER *TRIP', 'DELIVEROO', 'H&M UK', 'NEXT RETAIL',
      'SCREWFIX DIRECT', 'TRAINLINE.COM',
    ]
    expect(merchants.filter((m) => looksLikeTransfer(t(m)))).toEqual([])
  })
})

describe('adding them up', () => {
  it('reports both directions as positive figures with their counts', () => {
    const rows = [
      txn({ accountId: 'joint', amountMinor: -180000, payee: 'TFR TO S SMITH' }),
      txn({ accountId: 'joint', amountMinor: -20000, payee: 'TFR TO S SMITH' }),
      txn({ accountId: 'joint', amountMinor: 5000, payee: 'TFR FROM S SMITH' }),
    ]

    const totals = unexplainedTotals(legsOf(rows))

    expect(totals).toEqual({ inMinor: 5000, outMinor: 200000, inCount: 1, outCount: 2 })
  })

  it('is all zeroes for nothing', () => {
    expect(unexplainedTotals([])).toEqual({ inMinor: 0, outMinor: 0, inCount: 0, outCount: 0 })
  })
})

/**
 * Asking the person who can see the other half — migration 16.
 *
 * The selectors only. Who is allowed to ask, and about what, is the server's
 * business and is asserted in `supabase/99j-explain-tests.sql`.
 */
describe('a question left on a row', () => {
  const asked = (over: Partial<Transaction> = {}) =>
    txn({ accountId: 'joint', amountMinor: 180000, payee: 'TFR FROM S SMITH', ...over })

  it('is nothing until somebody asks', () => {
    expect(isAsking(asked())).toBe(false)
  })

  it('is a question on a marked, unpaired row', () => {
    expect(isAsking(asked({ explainRequestedAt: '2026-04-01T09:00:00Z', explainRequestedBy: ME }))).toBe(true)
  })

  it('goes quiet once the row is paired, without the mark being cleared', () => {
    // Load-bearing. `link_transfer` deliberately does not clear the mark —
    // doing so would have meant a third `create or replace` over its
    // security-definer body, which is exactly where a dropped check hides. The
    // mark is inert on an explained row instead, and this is what makes it so.
    const mark = { explainRequestedAt: '2026-04-01T09:00:00Z', explainRequestedBy: HER }
    expect(isAsking(asked({ ...mark, transferId: 'x' }))).toBe(false)
    expect(isAsking(asked({ ...mark, billId: 'b1' }))).toBe(false)
  })
})

describe('askedOfMe', () => {
  const hers = txn({
    accountId: 'joint',
    amountMinor: 180000,
    explainRequestedAt: '2026-04-01T09:00:00Z',
    explainRequestedBy: HER,
  })
  const mine = txn({
    accountId: 'joint',
    amountMinor: 5000,
    explainRequestedAt: '2026-04-02T09:00:00Z',
    explainRequestedBy: ME,
  })

  it('is what the other person asked, not what I did', () => {
    // My own question listed back at me as a job to do is how a nudge becomes
    // noise.
    expect(askedOfMe([hers, mine], ME).map((t) => t.id)).toEqual([hers.id])
  })

  it('still shows an unattributed question', () => {
    // An older client, or an asker who has since left the household. Still a
    // question, and still worth answering.
    const orphan = txn({ accountId: 'joint', amountMinor: 100, explainRequestedAt: '2026-04-03T09:00:00Z' })
    expect(askedOfMe([orphan], ME)).toHaveLength(1)
  })

  it('drops one that has since been paired', () => {
    const answered = txn({
      accountId: 'joint',
      amountMinor: 180000,
      explainRequestedAt: '2026-04-01T09:00:00Z',
      explainRequestedBy: HER,
      transferId: 'x',
    })
    expect(askedOfMe([answered], ME)).toEqual([])
  })

  it('puts the newest question first', () => {
    const older = txn({
      accountId: 'joint', amountMinor: 100,
      explainRequestedAt: '2026-03-01T09:00:00Z', explainRequestedBy: HER,
    })
    const newer = txn({
      accountId: 'joint', amountMinor: 100,
      explainRequestedAt: '2026-05-01T09:00:00Z', explainRequestedBy: HER,
    })
    expect(askedOfMe([older, newer], ME).map((t) => t.id)).toEqual([newer.id, older.id])
  })
})
