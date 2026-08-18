# Hearth — database

The server is the source of truth. Each device keeps a derived cache and an
outbox of pending writes; nothing here is optional or "eventually consistent by
convention" — the rules in `02-rls.sql` are what actually enforce privacy, not
the app.

## Applying it

In the Supabase SQL editor, run the numbered files in order — `01-schema.sql`
through to `23-custom-colours.sql`. There is no migrations table, so if you are
unsure what a project has already had, run `00-which-migrations-applied.sql`
first: it is read-only and reports a row per migration.

Every file is re-runnable, with three ordering traps. `10` replaces `09`'s
two-argument `link_transfer` with a three-argument one, so re-running `09`
afterwards puts the old signature back beside the new and PostgREST can no
longer resolve the call. Re-run `10` to clear it. And `19` replaces `07`'s
`transactions_select`, so re-running `07` afterwards puts the narrower policy
back — nothing fails, published rows simply stop arriving and the household book
quietly loses whatever was paid from a personal account. Re-run `19`. And `20`
replaces `03`'s three-argument `upsert_rule` with a four-argument one, so
re-running `03` afterwards puts the old signature back beside the new and every
rule the app learns dead-letters with "could not find the function … in the
schema cache". Re-run `20`. `21` and `22` continue that thread — `21` widens
`upsert_rule` again and `22` replaces `21`'s body under the SAME signature, so
re-running `21` after `22` silently restores the broken one and no signature
count can see it. Re-run the highest. The detector has a row for each.

`23` sets no ordering trap and a DEPLOY-order one instead: the client's pull
asks for `color` as soon as the app knows about it, so an app deployed ahead of
this migration does not merely lack custom colours — every pull of categories,
accounts and goals fails on an unknown column. Run it before deploying.

Then, to prove it works, sign up two accounts and run `99-rls-tests.sql`. It
runs inside a transaction and rolls back, so it is safe to re-run and leaves
nothing behind. Every row of the output must read `ok = true`. The other test
files (`99b` … `99p`) are the same shape.

## Running it locally

You do not need Docker or a system Postgres. From a scratch directory:

```bash
npm install @electric-sql/pglite
```

`supabase/local/` holds a shim that fakes the pieces Supabase provides —
the `auth` schema, `auth.uid()`, the `anon`/`authenticated` roles, the
`supabase_realtime` publication, and the default table grants. Apply
`local/00-shim.sql` first and `local/98-grants.sql` last:

```
local/00-shim.sql → 01 … 23 → local/98-grants.sql → 99*-tests.sql
```

`pgcrypto` needs an explicit import:
`PGlite.create({ extensions: { pgcrypto } })` from
`@electric-sql/pglite/contrib/pgcrypto`.

Read the **last result set that has rows**, not the last one. Every test file
ends with `rollback`, which returns none, so taking `results[results.length - 1]`
reports zero checks and zero failures — a green run that asserted nothing.

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

**Almost every policy authorises a transaction by its ACCOUNT. There is exactly
one exception, and knowing it is the point.** Migration 19 lets a row marked
`paid_for_household` out of the account it lives on, to the rest of the
household, and only where that account's `publishes_household_rows` says so. It
is the first and only row-level rule here. Anything new that touches
`transactions` should assume `my_account_ids()` is the whole story for WRITES —
it still is — and check §5 of `19-published-household-rows.sql` before assuming
it for reads.

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
