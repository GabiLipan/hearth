# Hearth

A private finance app for a couple sharing a household. React + TypeScript + Vite,
Tailwind v4, Dexie (IndexedDB) locally, Supabase (Postgres + RLS + Realtime) as the
server. British English, GBP by default, offline-capable PWA.

## Commands

```bash
npm run dev            # vite dev server
npm run build          # tsc -b && vite build
npm test               # vitest run
```

There is no lint script; `tsc -b` is the type gate.

### Running the SQL tests

The database is where the privacy rules live, so `supabase/99*-tests.sql` matter
more than the unit tests. This machine has no Postgres and no Docker — use PGlite
(WASM Postgres, npm, no daemon) from a scratch directory:

```bash
npm install @electric-sql/pglite
```

Load `local/00-shim.sql`, then `01` … `06`, then `local/98-grants.sql`, then `exec`
a test file and read the final result set — every row must have `ok = true`.
`pgcrypto` needs the explicit import: `PGlite.create({ extensions: { pgcrypto } })`
from `@electric-sql/pglite/contrib/pgcrypto`.

A test helper that must read **past** RLS has to be `security definer`; under
`set role authenticated` a plain helper is filtered by the policies it is trying
to look behind, and passes vacuously.

## Migrations

Numbered files in `supabase/`, applied **by hand in order** in the Supabase SQL
editor. There is no migrations table. `00-which-migrations-applied.sql` is a
read-only detector that reports which are present — run it when unsure.

| File | What it adds |
|---|---|
| `01-schema.sql` | tables, triggers, indexes |
| `02-rls.sql` | every row-level security policy |
| `03-rpc.sql` | RPCs that must be atomic or bypass RLS |
| `04-subcategories-budgets-goals.sql` | subcategories, personal categories, monthly budgets, goals, transfers |
| `05-ownership-and-deletes.sql` | scoped wipe, `delete_account`, owner pinning |
| `06-category-palette.sql` | widens `categories.slot` to 12 |

All are re-runnable. `05` refuses to install if `04` is missing — necessary,
because **plpgsql bodies are only syntax-checked at creation time**, so a
migration referencing a missing table installs "successfully" and fails at
runtime. Write that guard into any future migration that builds on an earlier one.

## Architecture

**The server is the source of truth.** The device holds a derived cache and a
queue of unsent writes. It never seeds, never merges, never decides a winner.

```
UI  →  data.ts (create/update/remove)  →  Dexie cache   (instant paint)
                                       └→ outbox       (durable queue)
                                             ↓ flush, strictly in seq order
                                          api.ts → PostgREST / RPC
                                             ↓
       Dexie cache  ←  pull.ts  ←  delta or full pull + checksum reconcile
                    ←  realtime.ts (live rows only; never moves the cursor)
```

Key files: `db.ts` (schema + cache), `data.ts` (the only write path),
`outbox.ts` (queue, retries, dead letters), `pull.ts` (read path),
`api.ts` (the single PostgREST boundary), `mapping.ts` (camel↔snake + writable
allow-lists), `session.ts` (auth, household, sync orchestration).

### Invariants — break these and things corrupt quietly

1. **Every user change goes through `data.ts`.** It writes the cache *and* queues
   the mutation in one Dexie transaction. A cache write with no queued mutation is
   a change that silently never saves.
2. **The cache holds live rows only.** No `deleted` flag; a delete removes the row.
   Tombstones exist server-side so the other device learns about the deletion.
3. **Ids are client-generated uuids** and inserts are `on conflict do nothing`.
   That is the whole idempotency story — a retry after a lost response is a no-op.
4. **`updatedAt` is the server's string, never re-parsed.** PostgREST emits
   microseconds, JS truncates to milliseconds; a round-tripped cursor can land
   ahead of a row it never read.
5. **Field-level updates:** an absent key means "leave alone", a key present with
   `undefined` means "clear". See `mapping.ts`.
6. **`budgets` and `rules` are written by RPC**, so their queued payload is the
   *whole row* — the RPC needs every argument to resolve its own unique index.

### The privacy model

This is the part worth being careful with.

| Account visibility | Partner sees the account | Partner sees its transactions |
|---|---|---|
| `shared` | yes | yes |
| `balance` | yes, and the correct total | **no** |
| `private` | no | no |

Categories, budgets and goals carry an `owner_id`: `null` = the household's,
set = that person's alone. Accounts carry an `owner_id` too, plus a visibility.

**Shared rows are jointly owned — either person may edit or erase them. Owned rows
belong to one person and nobody else may destroy them.** "Erase everything" means
*shared data + my own*, never the partner's.

Three rules that follow:

- **RLS is the only enforcement, and `security definer` switches it off.** Any
  definer function must restate in its body every predicate the policies would
  have applied. `wipe_household()` did not, and one partner's "Erase everything"
  deleted the other's private accounts.
- **There are no DELETE policies anywhere.** Deletion is `set deleted_at`, an
  UPDATE. A hard delete would leave the other device's cache holding the row
  forever with nothing left to replicate.
- **Visibility changes bump `households.visibility_epoch`.** A row that becomes
  invisible emits no realtime event and no tombstone, so the epoch is the only
  signal; a client seeing a new one drops its cache and re-pulls.

### Client predicates must mirror server policies

Use these — do not hand-roll an ownership check. Getting this wrong has caused
real bugs twice (a shared account that could not be edited or deleted, and bills
that silently hid your own private accounts).

| Helper (`lib/accounts.ts`, `lib/categories.ts`) | Mirrors |
|---|---|
| `canUseAccount(a, userId)` | `accounts_update` policy — **pass `userId`; it is not optional** |
| `canSeeTransactions(a, userId)` | `transactions_select` policy |
| `usableOn(cats, account, userId)` | `personal_category_guard` trigger |

## Traps that have actually bitten

- **`(x): x is T =>` is an unchecked assertion.** A type predicate tells the
  compiler the shape is right rather than letting it check. This hid a `Budget`
  built with no `month`.
- **`\uXXXX` in JSX *text* is literal**, not an escape — it renders as
  `’`. Inside a JS string or template literal it is a real escape.
- **supabase-js drops `undefined` RPC arguments.** An omitted argument changes
  PostgREST overload resolution, giving "could not find the function … in the
  schema cache" rather than a null.
- **`db.table.toArray()[0]` is not "the first one"** — it is primary-key order
  over random uuids.
- **Schema constraints drift from the client.** `categories.slot` stayed
  `between 1 and 8` while the palette grew to 12, so adding a category failed once
  the auto-assigned colour passed 8.
- **Writes fail late and quietly.** Everything goes through the outbox, so a bad
  row surfaces minutes later as a dead letter in Settings, not as an error on the
  form. Validate at the boundary (`insertToDb` throws on non-writable columns).

## Known gaps (not yet fixed)

- `importJSON` preserves `ownerId`, so a backup taken by one person and restored
  by another dead-letters rows that RLS refuses. It does not merge or remap.
- `stats.ts` `monthlySeries` has an `else if`/`else` pair with identical bodies —
  the income branch is dead code, harmless but misleading.
- Bill posting, transfers, account deletion and the wipe are **online-only** RPCs.
  Deliberate (they must be atomic), but there is no queued-offline story for them.
- No end-to-end test covers two users at once; the two-person cases are asserted
  in `supabase/99c-ownership-tests.sql` at the SQL layer only.
