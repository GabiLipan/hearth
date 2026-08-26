import { beforeEach, describe, expect, it } from 'vitest'
import { db, type Rule, type Transaction } from './db'
import {
  alreadyFiled,
  applyCategory,
  applyTitle,
  buildTitleMatcher,
  categoryRule,
  cleanTitle,
  conditionWords,
  coverageOf,
  displayName,
  isCatchAll,
  learnRule,
  matchKey,
  reference,
  ruleMatches,
  similarTo,
  titleRule,
  unnamedLike,
  withGroup,
} from './rules'

let seq = 0
const rule = (match: string, categoryId?: string, title?: string, over: Partial<Rule> = {}): Rule => ({
  id: `r${++seq}`,
  match,
  categoryId,
  title,
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

/**
 * What kind each category in these tests is.
 *
 * Every id ending in `-in` is income; everything else is spending. A rule may
 * only file a row of its category's own kind, so nearly every question here now
 * needs an answer to "what sort is this category".
 */
const KIND_OF = (id: string): 'expense' | 'income' => (id.endsWith('-in') ? 'income' : 'expense')

const txn = (over: Partial<Transaction> & { payee: string }): Transaction => ({
  id: `t${++seq}`,
  accountId: 'current',
  date: '2026-03-04',
  amountMinor: -1200,
  createdAt: 'x',
  updatedAt: 'x',
  ...over,
})

describe('what a rule covers', () => {
  it('claims the transactions it is the winning match for', () => {
    const r = rule('tesco', 'groceries')
    const txns = [
      txn({ payee: 'TESCO STORES 3241', categoryId: 'other' }),
      txn({ payee: 'Tesco Express', categoryId: 'groceries' }),
      txn({ payee: 'Sainsburys', categoryId: 'other' }),
    ]

    const cov = coverageOf(r, txns, [r], KIND_OF)

    expect(cov.all).toHaveLength(2)
    // Only the one that would actually move is offered.
    expect(cov.changed).toHaveLength(1)
    expect(cov.changed[0].payee).toBe('TESCO STORES 3241')
  })

  it('does not reach into what a more specific rule owns', () => {
    // Longest match wins, so bulk-applying "tesco" must not quietly undo
    // "tesco petrol". Testing the substring directly would get this wrong while
    // showing a confident count.
    const general = rule('tesco', 'groceries')
    const specific = rule('tesco petrol', 'transport')
    const rules = [general, specific]
    const petrol = txn({ payee: 'TESCO PETROL LEEDS', categoryId: 'transport' })
    const shop = txn({ payee: 'TESCO STORES 3241', categoryId: 'other' })

    expect(coverageOf(general, [petrol, shop], rules, KIND_OF).all).toEqual([shop])
    expect(coverageOf(specific, [petrol, shop], rules, KIND_OF).all).toEqual([petrol])
  })

  it('leaves income and transfers alone', () => {
    const r = rule('acme', 'salary')
    const txns = [
      txn({ payee: 'ACME LTD', amountMinor: 250000 }),
      txn({ payee: 'ACME LTD', amountMinor: -5000, transferId: 'tr' }),
      txn({ payee: 'ACME LTD', amountMinor: -5000, categoryId: 'other' }),
    ]

    expect(coverageOf(r, txns, [r], KIND_OF).all).toHaveLength(1)
  })
})

describe('what an income rule covers', () => {
  it('claims the income rows and never the spending ones', () => {
    const r = rule('amazon', 'refunds-in')
    const txns = [
      txn({ payee: 'AMAZON UK', amountMinor: 2400, categoryId: 'other-in' }),
      txn({ payee: 'AMAZON UK', amountMinor: -2400, categoryId: 'shopping' }),
    ]
    const cov = coverageOf(r, txns, [r], KIND_OF)
    expect(cov.all).toHaveLength(1)
    expect(cov.all[0].amountMinor).toBe(2400)
  })

  it('leaves a transfer leg alone whichever way it went', () => {
    // Linking is what decides a transfer's category; a merchant's name is not
    // evidence about one.
    const r = rule('g lipan', 'salary-in')
    const txns = [txn({ payee: 'G LIPAN 01JAN26', amountMinor: 200_000, transferId: 'tr1' })]
    expect(coverageOf(r, txns, [r], KIND_OF).all).toHaveLength(0)
  })
})

describe('transactions similar to the one being categorised', () => {
  it('finds the same merchant written several ways', () => {
    const txns = [
      txn({ id: 'self', payee: 'PETS AT HOME INS', categoryId: 'pets' }),
      txn({ payee: 'Pets At Home Insurance 8891', categoryId: 'other' }),
      txn({ payee: 'PETS AT HOME', categoryId: 'other' }),
      txn({ payee: 'Vets4Pets', categoryId: 'other' }),
    ]

    const found = similarTo('PETS AT HOME INS', 'pets', 'expense', txns, 'self')

    expect(found).toHaveLength(2)
    expect(found.map((t) => t.payee)).not.toContain('Vets4Pets')
  })

  it('excludes the transaction being edited and anything already filed there', () => {
    const txns = [
      txn({ id: 'self', payee: 'Pets At Home', categoryId: 'pets' }),
      txn({ payee: 'Pets At Home', categoryId: 'pets' }),
    ]

    expect(similarTo('Pets At Home', 'pets', 'expense', txns, 'self')).toHaveLength(0)
  })
})

describe('applying a category in bulk', () => {
  beforeEach(async () => {
    await db.open()
    await db.transactions.clear()
    await db.outbox.clear()
  })

  it('writes only what the caller may edit, and says what it left', async () => {
    // A bulk update is the easiest possible way to queue a dozen writes that
    // each dead-letter a minute later, so the permission predicate is not
    // optional and the count returned has to be the truth.
    const mine = txn({ payee: 'Pets At Home', categoryId: 'other', createdBy: 'me' })
    const theirs = txn({ payee: 'Pets At Home', categoryId: 'other', createdBy: 'them' })
    await db.transactions.bulkPut([mine, theirs])

    const res = await applyCategory([mine, theirs], 'pets', (t) => t.createdBy === 'me')

    expect(res).toEqual({ updated: 1, skipped: 1 })
    expect((await db.transactions.get(mine.id))?.categoryId).toBe('pets')
    expect((await db.transactions.get(theirs.id))?.categoryId).toBe('other')
  })

  it('queues every change it makes, so none of them silently never saves', async () => {
    const a = txn({ payee: 'Pets At Home', categoryId: 'other' })
    const b = txn({ payee: 'Pets At Home', categoryId: 'other' })
    await db.transactions.bulkPut([a, b])

    await applyCategory([a, b], 'pets', () => true)

    const queued = await db.outbox.toArray()
    expect(queued).toHaveLength(2)
    expect(queued.every((e) => e.table === 'transactions' && e.op === 'update')).toBe(true)
  })
})

describe('what a payee is called', () => {
  it('shows the name where there is one, and the bank’s words where there is not', () => {
    expect(displayName({ payee: 'SQ *THE GOOD FORK 3241', title: 'Dinner out' })).toBe('Dinner out')
    expect(displayName({ payee: 'SQ *THE GOOD FORK 3241' })).toBe('SQ *THE GOOD FORK 3241')
    // A blank is not a name — otherwise a row renders with nothing on it.
    expect(displayName({ payee: 'TESCO', title: '   ' })).toBe('TESCO')
  })

  it('shows the bank’s words after the name, and never instead of it twice', () => {
    // The pair every table and card renders: the name, then the reference.
    expect(reference({ payee: 'SQ *THE GOOD FORK 3241', title: 'Dinner out' })).toBe('SQ *THE GOOD FORK 3241')
    // Nothing to add — the payee IS the name on this row.
    expect(reference({ payee: 'Tesco' })).toBeUndefined()
    // Added by hand and never matched to a statement: there is no reference yet.
    expect(reference({ payee: '', title: 'Dinner out' })).toBeUndefined()
  })

  it('labels a row that has a name and no reference at all', () => {
    // Nobody types "SQ *THE GOOD FORK 3241" from memory, so a manual entry is
    // routinely all name and no reference until a statement is imported.
    expect(displayName({ payee: '', title: 'Dinner out' })).toBe('Dinner out')
    expect(displayName({ payee: '' })).toBe('No description')
  })

  it('keys a rule on the reference, falling back to the name', () => {
    expect(matchKey({ payee: 'SQ *THE GOOD FORK 3241', title: 'Dinner out' })).toBe('SQ *THE GOOD FORK 3241')
    expect(matchKey({ payee: '  ', title: 'Dinner out' })).toBe('Dinner out')
    expect(matchKey({})).toBe('')
  })

  it('stores a name as one trimmed line, or as nothing at all', () => {
    expect(cleanTitle('  Dinner   out \n')).toBe('Dinner out')
    expect(cleanTitle('')).toBeUndefined()
    expect(cleanTitle(undefined)).toBeUndefined()
    // The ceiling mirrors the server's check constraint, so a long name is
    // shortened here rather than dead-lettering a minute later.
    expect(cleanTitle('x'.repeat(200))).toHaveLength(80)
  })

  it('asks the category and the name as two separate questions', () => {
    // The trap this exists for: a title-only rule for the more specific payee
    // would otherwise win "the matching rule" outright and the fuel would
    // silently stop being categorised.
    const general = rule('tesco', 'groceries')
    const specific = rule('tesco petrol', undefined, 'Petrol')
    const rules = [general, specific]

    expect(categoryRule({ payee: 'TESCO PETROL LEEDS' }, rules, KIND_OF)?.id).toBe(general.id)
    expect(titleRule({ payee: 'TESCO PETROL LEEDS' }, rules)?.id).toBe(specific.id)
    // And a rule that only files does not claim to name anything.
    expect(titleRule({ payee: 'TESCO STORES 3241' }, rules)).toBeUndefined()
  })

  /**
   * The gap this closes: a salary is the row people most want automated, and
   * until now a category was learned from spending alone — so filing one under
   * Salary taught the app nothing and the next month's arrived as Other income.
   */
  it('files income from a rule, like anything else', () => {
    // `fpi` is a bank type code and `normalizePayee` strips it, so the rule is
    // keyed on what is left — which is exactly what `learnRule` stores.
    const r = rule('smith j ltd', 'salary-in')
    const target = { payee: 'FPI SMITH J LTD 0293', kind: 'income' as const }
    expect(categoryRule(target, [r], KIND_OF)?.categoryId).toBe('salary-in')
  })

  /**
   * And what makes that safe. One payee can pay you and be paid — a refund from
   * a shop, a payment to an employer — and a rule that ignored the sign would
   * file a refund under Groceries and a salary under whatever the employer's
   * expense rows were filed as. Neither is merely unhelpful: both put money in
   * the wrong half of every total in the app.
   */
  it('refuses a category of the wrong sort for the row', () => {
    const spending = rule('amazon', 'shopping')
    const rules = [spending]
    expect(categoryRule({ payee: 'AMAZON UK', kind: 'expense' }, rules, KIND_OF)?.id).toBe(spending.id)
    expect(categoryRule({ payee: 'AMAZON UK', kind: 'income' }, rules, KIND_OF)).toBeUndefined()
  })

  it('lets each sign take the rule that speaks for it', () => {
    // A wrong-kind rule is skipped rather than ending the search, so the two
    // live side by side on one payee.
    const out = rule('amazon', 'shopping')
    const back = rule('amazon', 'refunds-in')
    const rules = [out, back]
    expect(categoryRule({ payee: 'AMAZON UK', kind: 'expense' }, rules, KIND_OF)?.id).toBe(out.id)
    expect(categoryRule({ payee: 'AMAZON UK', kind: 'income' }, rules, KIND_OF)?.id).toBe(back.id)
  })

  it('concludes nothing about the sort where the caller has said nothing', () => {
    // The rules page asks about a rule with no row in front of it.
    const r = rule('smith j ltd', 'salary-in')
    expect(categoryRule({ payee: 'FPI SMITH J LTD' }, [r], KIND_OF)?.id).toBe(r.id)
  })

  it('tells two charges from one payee apart by their amount', () => {
    // The case the whole feature exists for: one vendor, two subscriptions,
    // one string on the statement.
    const small = rule('vendor a', 'software', undefined, { amountMinMinor: 899, amountMaxMinor: 899 })
    const large = rule('vendor a', 'music', undefined, { amountMinMinor: 1299, amountMaxMinor: 1299 })
    const rules = [small, large]

    expect(categoryRule({ payee: 'VENDOR A LTD', amountMinor: -899 }, rules, KIND_OF)?.id).toBe(small.id)
    expect(categoryRule({ payee: 'VENDOR A LTD', amountMinor: -1299 }, rules, KIND_OF)?.id).toBe(large.id)
    // And a third price neither rule claims is left alone rather than guessed at.
    expect(categoryRule({ payee: 'VENDOR A LTD', amountMinor: -450 }, rules, KIND_OF)).toBeUndefined()
  })

  it('compares magnitudes, so the sign of the row is not the rule’s business', () => {
    const r = rule('vendor a', 'software', undefined, { amountMinMinor: 899, amountMaxMinor: 899 })
    expect(ruleMatches(r, { payee: 'vendor a', amountMinor: -899 })).toBe(true)
    expect(ruleMatches(r, { payee: 'vendor a', amountMinor: 899 })).toBe(true)
  })

  it('does not claim a row whose amount is not known yet', () => {
    // The transaction form asks while the amount box is still empty. An
    // unsatisfied condition is not an absent one.
    const r = rule('vendor a', 'software', undefined, { amountMinMinor: 899, amountMaxMinor: 899 })
    expect(ruleMatches(r, { payee: 'vendor a' })).toBe(false)
  })

  it('lets a condition beat a longer match', () => {
    // "tesco petrol" is the longer string; "tesco, exactly £40" is the
    // narrower claim, and specificity is what wins.
    const longer = rule('tesco petrol', 'fuel')
    const conditioned = rule('tesco', 'weekly shop', undefined, { amountMinMinor: 4000, amountMaxMinor: 4000 })
    const rules = [longer, conditioned]

    expect(categoryRule({ payee: 'TESCO PETROL LEEDS', amountMinor: -4000 }, rules, KIND_OF)?.id).toBe(conditioned.id)
    expect(categoryRule({ payee: 'TESCO PETROL LEEDS', amountMinor: -3000 }, rules, KIND_OF)?.id).toBe(longer.id)
  })

  it('keeps an account-keyed rule off the same payee on another account', () => {
    const r = rule('vendor a', 'software', undefined, { accountId: 'joint' })
    expect(ruleMatches(r, { payee: 'vendor a', accountId: 'joint' })).toBe(true)
    expect(ruleMatches(r, { payee: 'vendor a', accountId: 'mine' })).toBe(false)
    expect(ruleMatches(r, { payee: 'vendor a' })).toBe(false)
  })

  it('divides coverage between two rules for one payee', () => {
    const small = rule('vendor a', 'software', undefined, { amountMinMinor: 899, amountMaxMinor: 899 })
    const large = rule('vendor a', 'music', undefined, { amountMinMinor: 1299, amountMaxMinor: 1299 })
    const rules = [small, large]
    const txns = [
      txn({ payee: 'VENDOR A LTD', amountMinor: -899, categoryId: 'other' }),
      txn({ payee: 'VENDOR A LTD', amountMinor: -1299, categoryId: 'other' }),
    ]

    expect(coverageOf(small, txns, rules, KIND_OF).all).toHaveLength(1)
    expect(coverageOf(small, txns, rules, KIND_OF).all[0].amountMinor).toBe(-899)
    expect(coverageOf(large, txns, rules, KIND_OF).all[0].amountMinor).toBe(-1299)
  })

  it('says what a rule asks for, in the words the screens use', () => {
    const money = (m: number) => `£${(m / 100).toFixed(2)}`
    expect(conditionWords(rule('a', 'c', undefined, { amountMinMinor: 899, amountMaxMinor: 899 }), money))
      .toEqual(['exactly £8.99'])
    expect(conditionWords(rule('a', 'c', undefined, { amountMinMinor: 500, amountMaxMinor: 1500 }), money))
      .toEqual(['£5.00 to £15.00'])
    expect(conditionWords(rule('a', 'c', undefined, { amountMinMinor: 500 }), money)).toEqual(['£5.00 or more'])
    expect(conditionWords(rule('a', 'c', undefined, { amountMaxMinor: 500 }), money)).toEqual(['up to £5.00'])
    expect(conditionWords(rule('a', 'c'), money)).toEqual([])
    expect(
      conditionWords(rule('a', 'c', undefined, { accountId: 'joint' }), money, () => 'Joint account'),
    ).toEqual(['on Joint account'])
  })

  it('gives a name-only rule no coverage, because applying one rewrites categories', () => {
    const r = rule('the good fork', undefined, 'Dinner out')
    const txns = [txn({ payee: 'SQ *THE GOOD FORK 3241', categoryId: 'other' })]

    expect(coverageOf(r, txns, [r], KIND_OF)).toEqual({ all: [], changed: [] })
  })

  it('learns a name from history, on income as well as spending', () => {
    const matcher = buildTitleMatcher([
      txn({ payee: 'FPI SMITH J LTD REF 88213', amountMinor: 250000, title: 'Salary' }),
      txn({ payee: 'TESCO STORES 3241', categoryId: 'groceries' }),
    ])

    expect(matcher('FPI SMITH J LTD REF 90114')).toBe('Salary')
    expect(matcher('TESCO STORES 3241')).toBeUndefined()
  })

  it('offers the rows from this payee that are not called this already', () => {
    const txns = [
      txn({ id: 'self', payee: 'SQ *THE GOOD FORK 3241', title: 'Dinner out' }),
      txn({ payee: 'SQ *THE GOOD FORK 9902' }),
      txn({ payee: 'SQ *THE GOOD FORK 1120', title: 'Dinner out' }),
      // Income and transfer legs are included, unlike `similarTo`: a bank
      // string is at its least readable exactly there.
      txn({ payee: 'SQ *THE GOOD FORK 8891', amountMinor: 4520 }),
      txn({ payee: 'Pizza Express' }),
    ]

    const found = unnamedLike('SQ *THE GOOD FORK 3241', 'Dinner out', txns, 'self')

    expect(found.map((t) => t.payee)).toEqual(['SQ *THE GOOD FORK 9902', 'SQ *THE GOOD FORK 8891'])
  })
})

describe('learning and applying a name', () => {
  beforeEach(async () => {
    await db.open()
    await db.transactions.clear()
    await db.rules.clear()
    await db.outbox.clear()
  })

  it('learning a name does not forget a category, or the other way round', async () => {
    await learnRule('TESCO STORES 3241', { categoryId: 'groceries' })
    await learnRule('Tesco Stores', { title: 'Big shop' })

    const rules = await db.rules.toArray()
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ match: 'tesco stores', categoryId: 'groceries', title: 'Big shop' })
  })

  it('teaches the rule that actually covers the row, not the general one', async () => {
    // Two rules for one vendor. Recategorising the £8.99 charge must correct
    // the £8.99 rule — correcting the general one would leave the specific one
    // saying something nobody agrees with.
    // Keyed on the payee exactly as `normalizePayee` leaves it: `learnRule`
    // only ever teaches a rule whose match IS this payee, never a shorter one
    // that happens to cover it.
    await db.rules.bulkPut([
      rule('vendor a ltd', 'software', undefined, { amountMinMinor: 899, amountMaxMinor: 899 }),
      rule('vendor a ltd', 'music'),
    ])
    const specific = (await db.rules.toArray()).find((r) => r.amountMinMinor === 899)!

    await learnRule({ payee: 'VENDOR A LTD', amountMinor: -899 }, { categoryId: 'streaming' })

    expect((await db.rules.get(specific.id))?.categoryId).toBe('streaming')
    expect(await db.rules.count()).toBe(2)
  })

  it('falls back to the general rule when no condition covers the row', async () => {
    await db.rules.put(rule('vendor a ltd', 'software', undefined, { amountMinMinor: 899, amountMaxMinor: 899 }))

    await learnRule({ payee: 'VENDOR A LTD', amountMinor: -1299 }, { categoryId: 'music' })

    const rules = await db.rules.toArray()
    expect(rules).toHaveLength(2)
    // The new one carries no conditions of its own: learning from a row means
    // "this payee", and narrowing it to the amount that happened to be on the
    // row would write a rule that matched exactly one transaction.
    const learnt = rules.find((r) => r.categoryId === 'music')!
    expect(learnt.amountMinMinor).toBeUndefined()
    expect(learnt.accountId).toBeUndefined()
  })

  it('does not write a rule that says nothing', async () => {
    await learnRule('TESCO STORES 3241', {})
    await learnRule('TESCO STORES 3241', { title: '  ' })

    expect(await db.rules.count()).toBe(0)
  })

  it('renames only what the caller may edit, and queues every change', async () => {
    const mine = txn({ payee: 'SQ *THE GOOD FORK 3241', createdBy: 'me' })
    const theirs = txn({ payee: 'SQ *THE GOOD FORK 9902', createdBy: 'them' })
    await db.transactions.bulkPut([mine, theirs])

    const res = await applyTitle([mine, theirs], 'Dinner out', (t) => t.createdBy === 'me')

    expect(res).toEqual({ updated: 1, skipped: 1 })
    expect((await db.transactions.get(mine.id))?.title).toBe('Dinner out')
    expect((await db.transactions.get(theirs.id))?.title).toBeUndefined()
    expect(await db.outbox.count()).toBe(1)
  })
})

describe('isCatchAll', () => {
  it('knows the two the household is seeded with', () => {
    expect(isCatchAll('Other')).toBe(true)
    expect(isCatchAll('other income')).toBe(true)
    expect(isCatchAll(' Other ')).toBe(true)
  })

  it('is false for a category somebody chose, and for nothing at all', () => {
    expect(isCatchAll('Groceries')).toBe(false)
    expect(isCatchAll('Other bits')).toBe(false)
    expect(isCatchAll(undefined)).toBe(false)
  })
})

describe('alreadyFiled', () => {
  const nameOf = (id: string) => ({ groceries: 'Groceries', other: 'Other' })[id]

  it('is false with no category, with the catch-all, and with a deleted one', () => {
    expect(alreadyFiled(txn({ payee: 'tesco', categoryId: undefined }), nameOf)).toBe(false)
    expect(alreadyFiled(txn({ payee: 'tesco', categoryId: 'other' }), nameOf)).toBe(false)
    expect(alreadyFiled(txn({ payee: 'tesco', categoryId: 'gone' }), nameOf)).toBe(false)
  })

  it('is true for a category somebody filed it under', () => {
    expect(alreadyFiled(txn({ payee: 'tesco', categoryId: 'groceries' }), nameOf)).toBe(true)
  })
})

describe('withGroup', () => {
  it('adds and removes a group without disturbing the rest', () => {
    expect([...withGroup(['a', 'b'], ['b', 'c'], true)]).toEqual(['a', 'b', 'c'])
    expect([...withGroup(['a', 'b', 'c'], ['b', 'c'], false)]).toEqual(['a'])
  })

  it('does not mutate what it was given', () => {
    const before = new Set(['a'])
    withGroup(before, ['b'], true)
    expect([...before]).toEqual(['a'])
  })
})
