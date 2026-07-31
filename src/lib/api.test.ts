import { describe, expect, it } from 'vitest'
import { classify, SyncError } from './api'

/**
 * Misclassifying a failure is expensive in both directions: calling a permanent
 * error transient wedges the queue retrying something that can never succeed,
 * and calling a transient error permanent throws away a write over a dropped
 * connection.
 */
describe('failure classification', () => {
  const cases: [string, unknown, 'transient' | 'permanent'][] = [
    ['a dropped connection', new TypeError('Failed to fetch'), 'transient'],
    ['a 5xx from the server', { status: 503, message: 'Service Unavailable' }, 'transient'],
    ['connection exception (class 08)', { code: '08006', message: 'connection failure' }, 'transient'],
    ['out of resources (class 53)', { code: '53300', message: 'too many connections' }, 'transient'],
    ['serialization failure', { code: '40001', message: 'could not serialize' }, 'transient'],
    ['deadlock', { code: '40P01', message: 'deadlock detected' }, 'transient'],
    ['an expired token, which refreshes and retries', { code: 'PGRST301', message: 'JWT expired' }, 'transient'],

    ['a duplicate key', { code: '23505', message: 'duplicate key' }, 'permanent'],
    ['a missing foreign key', { code: '23503', message: 'violates foreign key' }, 'permanent'],
    ['a failed check constraint', { code: '23514', message: 'violates check' }, 'permanent'],
    ['an RLS denial', { code: '42501', message: 'violates row-level security' }, 'permanent'],
    ['a bad value', { code: '22P02', message: 'invalid input syntax' }, 'permanent'],
    ['an unrecognised error', { message: 'something odd' }, 'permanent'],
  ]

  for (const [name, error, expected] of cases) {
    it(`treats ${name} as ${expected}`, () => {
      expect(classify(error).kind).toBe(expected)
    })
  }

  it('passes an already-classified error straight through', () => {
    const original = new SyncError('nope', 'permanent', 'NO_ROWS')
    expect(classify(original)).toBe(original)
  })

  it('keeps the SQLSTATE so a caller can tell why', () => {
    expect(classify({ code: '23503', message: 'fk' }).code).toBe('23503')
  })
})
