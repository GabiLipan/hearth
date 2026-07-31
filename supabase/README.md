# Hearth — database

The server is the source of truth. Each device keeps a derived cache and an
outbox of pending writes; nothing here is optional or "eventually consistent by
convention" — the rules in `02-rls.sql` are what actually enforce privacy, not
the app.

## Applying it

In the Supabase SQL editor, run in order:

1. `01-schema.sql` — tables, triggers, indexes, realtime publication
2. `02-rls.sql` — row level security policies
3. `03-rpc.sql` — the functions clients call

Then, to prove it works, sign up two accounts and run `99-rls-tests.sql`. It
runs inside a transaction and rolls back, so it is safe to re-run and leaves
nothing behind. Every row of the output must read `ok = true`.

## Running it locally

You do not need Docker or a system Postgres. From a scratch directory:

```bash
npm install embedded-postgres pg
```

`supabase/local/` holds a shim that fakes the pieces Supabase provides —
the `auth` schema, `auth.uid()`, the `anon`/`authenticated` roles, the
`supabase_realtime` publication, and the default table grants. Apply
`local/00-shim.sql` first and `local/98-grants.sql` last:

```
local/00-shim.sql → 01-schema.sql → 02-rls.sql → 03-rpc.sql → local/98-grants.sql → 99-rls-tests.sql
```

Never run anything in `local/` against the real project.

## Things that are load-bearing

**There are no DELETE policies.** Deletion is `set deleted_at = now()`, which is
an UPDATE. A hard delete would vanish without trace and the other device's cache
would keep the row forever, because there would be nothing left to replicate.
Omitting the policy makes that impossible rather than merely discouraged.

**`account_balances()` is a function, not a view.** A `security_invoker` view
would let RLS filter the hidden rows out of the `sum()` and return a silently
wrong balance — the worst possible failure in a finance app. A definer view
would give the right number but expose a caller-filterable `select *` over the
whole table. The function returns aggregates only and carries its own
authorization predicate where a caller cannot widen it.

**`visibility_epoch` is how deletions-by-privacy propagate.** A row that becomes
invisible cannot announce itself: it emits no realtime event and leaves no
tombstone. So any change to who-can-see-what bumps the household's epoch, and a
client that sees a new epoch drops its cache and re-pulls (keeping its outbox).

**`updated_at` uses `clock_timestamp()`, not `now()`.** `now()` is the
transaction's start time, so a 500-row import would stamp every row identically.
The pull cursor pages on `(updated_at, id)` and handles ties either way, but real
per-row write times mean far fewer of them.

**Client-generated UUIDs are the idempotency mechanism.** A retried insert after
a dropped response is `on conflict (id) do nothing`, not a duplicate row. This is
the single biggest reason the old sync produced duplicates and this one does not.

**Names are deliberately not unique.** Two people typing "Coffee" at the same
moment should produce a tidy-up job, not a hard write failure on a row they have
already watched appear on screen. `transactions.import_hash` is likewise only an
index, never a constraint — two genuine £3.20 coffees at the same shop on the
same day share a hash, and silently dropping the second would corrupt the balance
with no way to notice.
