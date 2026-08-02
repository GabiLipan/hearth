import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakePostgrest, type FakeRow } from '../test/fakePostgrest'

const fake = createFakePostgrest({})
vi.mock('./supabase', () => ({ supabase: fake.client, isConfigured: true }))

// Imported after the mock so it picks up the fake client.
const { pullAll, pullPage } = await import('./api')

/**
 * The regression this file exists for.
 *
 * The old sync ordered by `updated_at` alone and paged with a `limit`. Rows
 * written by one statement share a timestamp, so when a page boundary landed
 * inside a group of ties, the rest of that group was skipped — and because the
 * cursor had already moved past their timestamp, they were never fetched again.
 * A large CSV import could silently lose its tail forever.
 */
function rowsSharingOneTimestamp(count: number, timestamp: string): FakeRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `row-${String(i).padStart(4, '0')}`,
    updated_at: timestamp,
    payee: `Payee ${i}`,
  }))
}

describe('keyset paging', () => {
  beforeEach(() => {
    fake.requests.length = 0
  })

  it('fetches all 501 rows when every one shares a single timestamp', async () => {
    const timestamp = '2026-03-01T10:00:00.123456+00:00'
    const table = rowsSharingOneTimestamp(501, timestamp)
    const local = createFakePostgrest({ transactions: table })
    vi.mocked(fake.client.from).mockImplementation(local.client.from)

    const rows = await pullAll('transactions', 500)

    expect(rows).toHaveLength(501)
    expect(new Set(rows.map((r) => r.id)).size).toBe(501)
    // Ordering by timestamp alone could not have done this: the second page has
    // to resume from (timestamp, last id), not from the timestamp.
    expect(rows[500].id).toBe('row-0500')
  })

  it('does not re-read a row it has already seen when resuming mid-pull', async () => {
    const local = createFakePostgrest({
      transactions: [
        { id: 'a', updated_at: '2026-03-01T10:00:00+00:00' },
        { id: 'b', updated_at: '2026-03-01T10:00:00+00:00' },
        { id: 'c', updated_at: '2026-03-02T10:00:00+00:00' },
      ],
    })
    vi.mocked(fake.client.from).mockImplementation(local.client.from)

    const page = await pullPage('transactions', { updatedAt: '2026-03-01T10:00:00+00:00', id: 'a' }, 10)
    expect(page.rows.map((r) => r.id)).toEqual(['b', 'c'])
  })

  it('starts a pull inclusively, so the rewind window actually re-reads', async () => {
    const local = createFakePostgrest({
      transactions: [
        { id: 'a', updated_at: '2026-03-01T10:00:00+00:00' },
        { id: 'b', updated_at: '2026-03-02T10:00:00+00:00' },
      ],
    })
    vi.mocked(fake.client.from).mockImplementation(local.client.from)

    // No id in the cursor means "start here", and the boundary row must come back:
    // the point of rewinding is to re-read a window, and re-applying is idempotent.
    const page = await pullPage('transactions', { updatedAt: '2026-03-01T10:00:00+00:00' }, 10)
    expect(page.rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('sends timestamps in a form that survives a query string', async () => {
    const local = createFakePostgrest({ transactions: [] })
    vi.mocked(fake.client.from).mockImplementation(local.client.from)

    await pullPage('transactions', { updatedAt: '2026-03-01T10:00:00.123456+00:00', id: 'a' }, 10)

    // A literal `+` in a query string decodes as a space. PostgREST parses the
    // `Z` form identically, so the offset is normalised before it is sent.
    const sent = local.requests[0].filters.join(' ')
    expect(sent).toContain('2026-03-01T10:00:00.123456Z')
    expect(sent).not.toContain('+00:00')
  })

  it('keeps microsecond precision rather than truncating through Date', async () => {
    const local = createFakePostgrest({
      transactions: [{ id: 'a', updated_at: '2026-03-01T10:00:00.123456+00:00' }],
    })
    vi.mocked(fake.client.from).mockImplementation(local.client.from)

    const page = await pullPage('transactions', undefined, 10)
    // JavaScript's Date only holds milliseconds. A cursor round-tripped through
    // it would land fractionally ahead of rows it had not read.
    expect(page.lastUpdatedAt).toBe('2026-03-01T10:00:00.123456+00:00')
  })
})
