import { describe, expect, it } from 'vitest'
import { diffToPatch, fromDb, insertToDb, patchToDb, selectColumns, type DbRow } from './mapping'

describe('column naming', () => {
  it('converts between camelCase and snake_case', () => {
    expect(insertToDb('transactions', { amountMinor: -500, accountId: 'a' })).toEqual({
      amount_minor: -500,
      account_id: 'a',
    })
  })

  it('maps the one column whose name is not mechanical', () => {
    // `date` is too generic for a SQL column, so the server calls it occurred_on.
    expect(insertToDb('transactions', { date: '2026-03-01' })).toEqual({ occurred_on: '2026-03-01' })
    expect(fromDb<{ date: string }>({ occurred_on: '2026-03-01' } as unknown as DbRow).date).toBe('2026-03-01')
  })

  it('asks the server only for columns it knows about', () => {
    expect(selectColumns('budgets')).toBe('id,category_id,owner_id,amount_minor,month,updated_at,deleted_at')
  })

  it('refuses to write a column the client does not own', () => {
    // household_id, created_by and updated_at are trigger-stamped. A typo should
    // fail here rather than being posted and silently dropped.
    expect(() => patchToDb('transactions', { householdId: 'x' })).toThrow(/not a client-writable column/i)
  })

  it('refuses to write a transfer id, which only the server may set', () => {
    // Both legs of a transfer are created together by create_transfer. A client
    // able to write transferId could fabricate half a transfer, and the money
    // would appear to come from nowhere.
    expect(() => patchToDb('transactions', { transferId: 'x' })).toThrow(/not a client-writable column/i)
  })
})

describe('undefined versus null', () => {
  // This distinction is the whole reason a mapping layer exists. In a
  // field-level update an ABSENT key means "leave it alone" and a NULL means
  // "clear it". Conflating them makes clearing a note a silent no-op.
  it('sends a present-but-undefined field as null, meaning clear it', () => {
    expect(patchToDb('transactions', { note: undefined })).toEqual({ note: null })
  })

  it('does not send a field that was not mentioned', () => {
    expect(patchToDb('transactions', { payee: 'Tesco' })).toEqual({ payee: 'Tesco' })
  })

  it('reads a null back as undefined so optional fields behave normally', () => {
    const row = fromDb<{ note?: string }>({ id: '1', note: null } as unknown as DbRow)
    expect(row.note).toBeUndefined()
    expect('note' in row).toBe(true)
  })

  it('never stores the tombstone column', () => {
    const row = fromDb<Record<string, unknown>>({ id: '1', deleted_at: '2026-01-01' } as unknown as DbRow)
    expect(row).not.toHaveProperty('deletedAt')
  })
})

describe('diffToPatch', () => {
  it('reports only what changed', () => {
    expect(diffToPatch({ payee: 'Tesco', amountMinor: -100 }, { payee: 'Co-op', amountMinor: -100 })).toEqual({
      payee: 'Co-op',
    })
  })

  it('keeps a field that was cleared, so it survives as an explicit null', () => {
    const patch = diffToPatch<{ note?: string }>({ note: 'lunch' }, { note: undefined })
    expect('note' in patch).toBe(true)
    expect(patchToDb('transactions', patch)).toEqual({ note: null })
  })

  it('is empty when nothing moved', () => {
    expect(diffToPatch({ a: 1 }, { a: 1 })).toEqual({})
  })
})
