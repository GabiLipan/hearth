import { beforeEach, describe, expect, it, vi } from 'vitest'

const created: { table: string; rows: Record<string, unknown>[] }[] = []
let currentUser: string | undefined = 'me'

vi.mock('./data', () => ({
  createMany: async (table: string, rows: Record<string, unknown>[]) => {
    created.push({ table, rows })
  },
}))
vi.mock('./session', () => ({ syncStore: { getState: () => ({ userId: currentUser }) } }))
vi.mock('./api', () => ({ rpc: async () => undefined }))
vi.mock('./pull', () => ({ fullPull: async () => undefined }))

const { importJSON } = await import('./backup')

const backup = (data: Record<string, unknown[]>) =>
  JSON.stringify({ app: 'hearth', version: 2, data })

const rowsFor = (table: string) => created.find((c) => c.table === table)?.rows ?? []

beforeEach(() => {
  created.length = 0
  currentUser = 'me'
})

describe('restoring a backup somebody else took', () => {
  /**
   * The failure this guards: a backup carries `owner_id` verbatim, and the
   * policy on all three owned tables is `owner_id is null or owner_id =
   * auth.uid()`. Restoring a partner's file used to queue their private rows
   * under their id, and every one came back minutes later as a dead letter.
   */
  const theirs = () =>
    backup({
      categories: [
        { id: 'shared', name: 'Groceries' },
        { id: 'mine', name: 'My therapy', ownerId: 'me' },
        { id: 'hers', name: 'Her therapy', ownerId: 'partner' },
      ],
      budgets: [
        { id: 'b1', categoryId: 'shared', amountMinor: 50000, month: '2026-03-01' },
        { id: 'b2', categoryId: 'hers', amountMinor: 8000, month: '2026-03-01' },
      ],
      goals: [{ id: 'g1', name: 'Her bike', targetMinor: 90000, ownerId: 'partner' }],
      transactions: [
        { id: 't1', accountId: 'a', amountMinor: -500, categoryId: 'shared' },
        { id: 't2', accountId: 'a', amountMinor: -900, categoryId: 'hers' },
      ],
    })

  it('leaves somebody else’s private rows where they are', () => {
    // Not claimed and not published: rewriting the owner would make her private
    // category mine, and clearing it would hand it to us both.
    return importJSON(theirs()).then((res) => {
      expect(rowsFor('categories').map((r) => r.id)).toEqual(['shared', 'mine'])
      expect(rowsFor('goals')).toEqual([])
      expect(res.skippedPrivate).toBe(3) // her category, her budget, her goal
    })
  })

  it('drops a budget whose category it just dropped', () => {
    // `budgets.category_id` is required, so the row would fail a foreign key —
    // the very dead letter this exists to prevent.
    return importJSON(theirs()).then(() => {
      expect(rowsFor('budgets').map((r) => r.id)).toEqual(['b1'])
    })
  })

  it('keeps a transaction and loses only its filing', () => {
    // A transaction's category is optional. The money is the fact; where it was
    // filed is a detail that can be redone.
    return importJSON(theirs()).then(() => {
      const txns = rowsFor('transactions')
      expect(txns.map((r) => r.id)).toEqual(['t1', 't2'])
      expect(txns.find((r) => r.id === 't2')!.categoryId).toBeUndefined()
      expect(txns.find((r) => r.id === 't1')!.categoryId).toBe('shared')
    })
  })

  it('restores everything when it is your own backup', async () => {
    currentUser = 'partner'
    const res = await importJSON(theirs())
    expect(res.skippedPrivate).toBe(1) // only "me"'s category is not theirs
    expect(rowsFor('goals').map((r) => r.id)).toEqual(['g1'])
  })

  it('refuses a file that is not a Hearth backup', async () => {
    await expect(importJSON('{"app":"something-else"}')).rejects.toThrow('Not a Hearth backup file')
  })

  it('still backfills a month onto a pre-migration-04 budget', async () => {
    await importJSON(backup({ budgets: [{ id: 'b', categoryId: 'c', amountMinor: 100 }] }))
    expect(rowsFor('budgets')[0].month).toMatch(/^\d{4}-\d{2}-01$/)
  })
})
