import { describe, expect, it } from 'vitest'
import { initialsOf, nameOf } from '../components/PersonDot'

/**
 * The regression this file exists for.
 *
 * The permissions list showed two blank rows, each with a level beside it and
 * no name — because `display_name ?? 'Someone'` only catches null and
 * undefined, and a profile written before the name backfill carried an empty
 * string. Nullish coalescing was the wrong operator for a field whose empty
 * value is `''`.
 */

describe('nameOf', () => {
  it('falls back when the name is missing', () => {
    expect(nameOf(undefined)).toBe('Someone')
    expect(nameOf({ displayName: undefined })).toBe('Someone')
  })

  it('falls back when the name is empty or only spaces — the actual bug', () => {
    expect(nameOf({ displayName: '' })).toBe('Someone')
    expect(nameOf({ displayName: '   ' })).toBe('Someone')
  })

  it('uses the name when there is one', () => {
    expect(nameOf({ displayName: 'Gabi' })).toBe('Gabi')
    expect(nameOf({ displayName: '  Gabi  ' })).toBe('Gabi')
  })
})

describe('initialsOf', () => {
  it('takes the first and last word', () => {
    expect(initialsOf('Anna Kaminska')).toBe('AK')
    expect(initialsOf('Mary Jane Watson')).toBe('MW')
  })

  it('takes one letter from a single word', () => {
    expect(initialsOf('gabi')).toBe('G')
  })

  // The backfilled name is an email local-part, so these are the common shapes.
  it('splits on the punctuation an email local-part uses', () => {
    expect(initialsOf('anna.kaminska')).toBe('AK')
    expect(initialsOf('gabi_lipan')).toBe('GL')
    expect(initialsOf('gabi-lipan')).toBe('GL')
  })

  it('never returns nothing', () => {
    expect(initialsOf('')).toBe('?')
    expect(initialsOf('   ')).toBe('?')
  })
})
