import { vi } from 'vitest'

/**
 * A minimal stand-in for PostgREST, faithful to the parts the sync engine
 * depends on: ordering by `(updated_at, id)`, `limit`, and the two cursor
 * filters (`gte` for the start of a pull, the `or(...)` tuple comparison for
 * resuming mid-pull).
 *
 * It exists so the keyset paging can be tested against rows that deliberately
 * share a timestamp — the exact shape a bulk import produces, and the one that
 * broke the previous sync.
 */

export interface FakeRow {
  id: string
  updated_at: string
  deleted_at?: string | null
  [key: string]: unknown
}

/**
 * Postgres parses a timestamp before comparing it, so `...+00:00` and `...Z`
 * are the same instant. String comparison is not, and the client normalises to
 * the `Z` form before putting a timestamp in a query string — so the fake has
 * to normalise both sides or it would reject rows the real server returns.
 */
const asInstant = (ts: string) => ts.replace(/\+00:?00$/, 'Z')

export function createFakePostgrest(tables: Record<string, FakeRow[]>) {
  const requests: { table: string; limit: number; filters: string[] }[] = []

  function query(table: string) {
    let rows = [...(tables[table] ?? [])]
    let limit = Infinity
    const filters: string[] = []

    const builder = {
      select: () => builder,
      order: () => builder,
      limit(n: number) {
        limit = n
        return builder
      },
      gte(column: string, value: string) {
        filters.push(`gte:${value}`)
        rows = rows.filter((r) => asInstant(String(r[column])) >= asInstant(value))
        return builder
      },
      is(column: string, value: null) {
        rows = rows.filter((r) => (r[column] ?? null) === value)
        return builder
      },
      eq(column: string, value: unknown) {
        rows = rows.filter((r) => r[column] === value)
        return builder
      },
      or(expression: string) {
        filters.push(`or:${expression}`)
        // `updated_at.gt.<ts>,and(updated_at.eq.<ts>,id.gt.<id>)`
        const m = expression.match(/^updated_at\.gt\.(.+?),and\(updated_at\.eq\.(.+?),id\.gt\.(.+?)\)$/)
        if (!m) throw new Error(`fake postgrest cannot parse: ${expression}`)
        const [, ts, tsEq, id] = m
        rows = rows.filter(
          (r) => asInstant(r.updated_at) > asInstant(ts) || (asInstant(r.updated_at) === asInstant(tsEq) && r.id > id),
        )
        return builder
      },
      then(resolve: (value: { data: FakeRow[]; error: null }) => unknown) {
        rows.sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id))
        const page = rows.slice(0, limit === Infinity ? undefined : limit)
        requests.push({ table, limit, filters })
        return Promise.resolve(resolve({ data: page, error: null }))
      },
    }
    return builder
  }

  return {
    requests,
    client: {
      from: vi.fn((table: string) => query(table)),
      rpc: vi.fn(async () => ({ data: null, error: null })),
      channel: vi.fn(() => ({ on: vi.fn(), subscribe: vi.fn() })),
      removeChannel: vi.fn(),
      auth: { onAuthStateChange: vi.fn() },
    },
  }
}
