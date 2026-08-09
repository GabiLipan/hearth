import { describe, expect, it } from 'vitest'
import type { Transaction } from './db'
import { learnRoutes, routeFor } from './routes'
import { findTransferCandidates } from './transfers'

let seq = 0
const txn = (over: Partial<Transaction> & { accountId: string; amountMinor: number }): Transaction => ({
  id: `t${++seq}`,
  date: '2026-03-31',
  payee: 'x',
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

/** A confirmed transfer: two legs sharing a transferId. */
const moved = (from: string, to: string, amountMinor: number, date: string, id: string) => [
  txn({ accountId: from, amountMinor: -amountMinor, date, transferId: id }),
  txn({ accountId: to, amountMinor, date, transferId: id }),
]

/** Payday, n months of it, on the last day of each month. */
const paydays = (dates: string[], amountMinor = 200000, from = 'myPrivate', to = 'joint') =>
  dates.flatMap((d, i) => moved(from, to, amountMinor, d, `${from}-${to}-${i}`))

describe('learnRoutes', () => {
  it('learns nothing from two movements', () => {
    // Two things a month apart is every pair of things that happened twice.
    expect(learnRoutes(paydays(['2026-01-31', '2026-02-28']))).toEqual([])
  })

  it('learns a monthly route from three', () => {
    const [r] = learnRoutes(paydays(['2026-01-31', '2026-02-28', '2026-03-31']))
    expect(r).toMatchObject({
      fromAccountId: 'myPrivate',
      toAccountId: 'joint',
      typicalMinor: 200000,
      count: 3,
      freq: 'monthly',
      lastOn: '2026-03-31',
    })
    // A date to say out loud, never a row to write.
    expect(r.nextOn).toBe('2026-04-30')
  })

  it('is directional', () => {
    // Joint → savings and savings → joint are two habits that share two
    // accounts. Collapsing them would let a withdrawal teach contributions.
    const txns = [
      ...paydays(['2026-01-31', '2026-02-28', '2026-03-31'], 200000, 'myPrivate', 'joint'),
      ...paydays(['2026-01-05', '2026-02-05'], 50000, 'joint', 'myPrivate'),
    ]
    const routes = learnRoutes(txns)
    expect(routes).toHaveLength(1)
    expect(routes[0].fromAccountId).toBe('myPrivate')
  })

  it('ignores movements at no cadence it has a word for', () => {
    expect(learnRoutes(paydays(['2026-01-01', '2026-01-20', '2026-03-02']))).toEqual([])
  })

  it('survives one irregular month', () => {
    const [r] = learnRoutes(
      paydays(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-29', '2026-08-31']),
    )
    expect(r?.freq).toBe('monthly')
    expect(r?.count).toBe(6)
  })

  it('takes the median amount, so one odd month does not move it', () => {
    const txns = [
      ...moved('myPrivate', 'joint', 200000, '2026-01-31', 'a'),
      ...moved('myPrivate', 'joint', 200000, '2026-02-28', 'b'),
      ...moved('myPrivate', 'joint', 900000, '2026-03-31', 'c'),
    ]
    expect(learnRoutes(txns)[0].typicalMinor).toBe(200000)
  })

  it('skips a transfer whose far leg is invisible', () => {
    // The normal state of half the transfers on this device: my partner's
    // contribution has its other leg in an account I am not on, and the account
    // it came from is the entire point of a route.
    const oneLegged = ['2026-01-31', '2026-02-28', '2026-03-31'].map((d, i) =>
      txn({ accountId: 'joint', amountMinor: 180000, date: d, transferId: `hers-${i}` }),
    )
    expect(learnRoutes(oneLegged)).toEqual([])
  })

  it('does not learn from unlinked rows', () => {
    const loose = ['2026-01-31', '2026-02-28', '2026-03-31'].flatMap((d) => [
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: d }),
      txn({ accountId: 'joint', amountMinor: 200000, date: d }),
    ])
    expect(learnRoutes(loose)).toEqual([])
  })
})

describe('routeFor', () => {
  const routes = learnRoutes(paydays(['2026-01-31', '2026-02-28', '2026-03-31']))

  it('matches the same accounts and a close amount', () => {
    expect(routeFor(routes, 'myPrivate', 'joint', -205000)).toBeTruthy()
    // A pay rise, absorbed.
    expect(routeFor(routes, 'myPrivate', 'joint', -240000)).toBeTruthy()
  })

  it('refuses the wrong direction, the wrong account and a wild amount', () => {
    expect(routeFor(routes, 'joint', 'myPrivate', -200000)).toBeUndefined()
    expect(routeFor(routes, 'myCard', 'joint', -200000)).toBeUndefined()
    expect(routeFor(routes, 'myPrivate', 'joint', -20000)).toBeUndefined()
  })
})

/**
 * The case the whole file exists for. Both of us are paid at the end of the
 * month and both move a round sum into the joint account, so the arrival has
 * two possible partners for ever — and unlike the mirror image, guessing wrong
 * strands an outgoing leg as personal SPENDING.
 */
describe('a route resolving payday', () => {
  const history = paydays(['2026-01-31', '2026-02-28', '2026-03-31'])

  function april(): Transaction[] {
    return [
      // Mine, on the habitual route.
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-04-30' }),
      // My partner's, from an account that has never done this before.
      txn({ accountId: 'herPrivate', amountMinor: -200000, date: '2026-04-30' }),
      // One arrival, which either could explain.
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-04-30' }),
    ]
  }

  it('is ambiguous with no history to go on', () => {
    const cands = findTransferCandidates(april())
    expect(cands).toHaveLength(2)
    expect(cands.every((c) => !c.unambiguous && !c.onRoute)).toBe(true)
  })

  it('is settled once the habit is known', () => {
    const txns = [...history, ...april()]
    const cands = findTransferCandidates(txns, { routes: learnRoutes(txns) })
    const routed = cands.filter((c) => c.onRoute)
    expect(routed).toHaveLength(1)
    expect(routed[0].out.accountId).toBe('myPrivate')
    // Still ambiguous on the rows alone — the route is what settled it, and the
    // other reading is still offered rather than deleted.
    expect(routed[0].unambiguous).toBe(false)
    expect(cands).toHaveLength(2)
  })

  it('decides nothing when the route explains both readings', () => {
    // Two of my own accounts, both with the same habit, and one arrival. A
    // route that fits both has recognised something and settled nothing.
    const both = [
      ...paydays(['2026-01-31', '2026-02-28', '2026-03-31'], 200000, 'myPrivate', 'joint'),
      ...paydays(['2026-01-31', '2026-02-28', '2026-03-31'], 200000, 'mySecond', 'joint'),
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-04-30' }),
      txn({ accountId: 'mySecond', amountMinor: -200000, date: '2026-04-30' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-04-30' }),
    ]
    const cands = findTransferCandidates(both, { routes: learnRoutes(both) })
    expect(cands.filter((c) => c.onRoute)).toHaveLength(0)
  })

  it('never spends one outgoing leg on two arrivals', () => {
    // Otherwise auto mode fires two RPCs for one leg and the server refuses the
    // second — a dead letter for something that was never wrong.
    const txns = [
      ...history,
      txn({ accountId: 'myPrivate', amountMinor: -200000, date: '2026-04-30' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-04-30' }),
      txn({ accountId: 'joint', amountMinor: 200000, date: '2026-05-01' }),
    ]
    const cands = findTransferCandidates(txns, { routes: learnRoutes(txns) })
    expect(cands.filter((c) => c.onRoute)).toHaveLength(0)
  })
})
