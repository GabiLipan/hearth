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

Load `local/00-shim.sql`, then `01` … `08`, then `local/98-grants.sql`, then `exec`
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
| `07-permissions.sql` | `household_members`, `account_grants`, per-level RLS, the departure cascade |
| `08-profiles.sql` | display names backfilled and editable, optional avatars, role change stops bumping the epoch |

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

**An account belongs to the people granted on it, not to the household.** That
inverted in migration 07: every policy used to begin `household_id =
my_household()`, and now `account_grants` is the only thing that authorises an
account, its transactions and its bills. The household's remaining job is to
decide who you are allowed to share with.

Access is **deny by default** — no grant means the account does not exist as far
as that person is concerned — at six levels, an ordered Postgres enum so
`level >= 'contribute'` is a native comparison:

| Level | Sees the account | Sees its transactions | Can write |
|---|---|---|---|
| `owner` | yes | yes | everything, plus who else can see it |
| `manage` | yes | yes | everything on it, but cannot re-share it |
| `contribute` | yes | yes | add, and edit or delete **only what they added** |
| `view` | yes | yes | nothing |
| `balance` | yes, and the correct total | **no** | nothing |
| no grant | no | no | nothing |

`contribute` is enforced against `transactions.created_by`, which
`stamp_ownership` pins, so "you may change what you added" needs no extra
policy — a soft delete is an UPDATE and falls out of the same expression.

Categories, budgets and goals still carry an `owner_id` (`null` = the
household's, set = that person's alone) and are still household-scoped. Only
accounts moved.

**A household admin manages people and nothing else.** They can invite, remove
and promote; they gain no access to any account they were not granted, and
`my_account_ids()` must never consult `is_household_admin()`.

Four rules that follow:

- **RLS is the only enforcement, and `security definer` switches it off.** Any
  definer function must restate in its body every predicate the policies would
  have applied. `wipe_household()` did not, and one person's "Erase everything"
  deleted the other's private accounts.
- **There are no DELETE policies anywhere.** Deletion is `set deleted_at`, an
  UPDATE. A hard delete would leave the other device's cache holding the row
  forever with nothing left to replicate.
- **Grants outlive the accounts they point at.** `delete_account()` and
  `wipe_household()` deliberately leave `account_grants` alone: `accounts_select`
  needs a grant, so revoking one would leave every other device holding the
  account forever with no tombstone it is allowed to read.
- **Anything that changes who-can-see-what bumps `households.visibility_epoch`.**
  A row that becomes invisible emits no realtime event and no tombstone, so the
  epoch is the only signal; a client seeing a new one drops its cache and
  re-pulls. Creating an account deliberately does *not* bump it — that would
  make every new account wipe its creator's own cache.

**Leaving takes your own accounts with you.** `depart_household()` revokes what
you were only a guest on, moves the accounts you own alone (with their
transactions, bills and a copy of the household's category names so your history
still reads), and leaves co-owned ones behind. It is the one function here that
can corrupt rather than merely deny.

### Client predicates must mirror server policies

Use these — do not hand-roll an ownership check. Getting this wrong has caused
real bugs three times (a shared account that could not be edited or deleted,
bills that silently hid your own accounts, and a goal picker that offered
accounts you could not post to).

Every one takes a **level** and nothing else, because the server's
`my_account_ids(min_level)` reads a grant and nothing else. `useMyLevels()` is
the single place a level comes from.

| Helper (`lib/accounts.ts`, `lib/categories.ts`) | Mirrors |
|---|---|
| `canSeeAccount(level)` | `accounts_select` |
| `canSeeTransactionsAt(level)` | `transactions_select` |
| `canAddTransactions(level)` | `transactions_insert` |
| `canManageAccount(level)` | `accounts_update` |
| `canAdministerAccount(level)` | `account_grants` writes, `delete_account` |
| `canEditTransaction(txn, level, userId)` | `transactions_update`, `created_by` half included |
| `usableOn(cats, grants, userId)` | `personal_category_guard` trigger |

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
- **`insert … returning` runs the SELECT policy too.** The creator's `owner`
  grant is written by an AFTER trigger, so for that one instant the row cannot
  see itself — and PostgREST asks for the row back on every insert, so account
  creation failed outright. `accounts_select` carries a second disjunct for
  exactly that case; do not "simplify" it away.
- **Do not use CSS `columns` for cards.** Safari ignores `break-inside: avoid`
  in a multi-column layout and cuts a card in half at the column boundary,
  stranding its bottom border at the top of the next column; `column-span: all`
  is unreliable there too. Both the home page and Settings shipped with this.
  `Columns` in `ui.tsx` lays out flex columns and balances them from measured
  heights instead — there is no fragmentation context, so nothing can split.
- **`Select` carries `w-full`, so a width passed to it does nothing.** Tailwind
  emits `.w-full` after `.w-40`, so the base class wins however the attribute is
  ordered — the control fills its flex row and squeezes a `flex-1 min-w-0
  truncate` sibling to zero width. This is how the sharing list came to show a
  photo and a level with no name between them. Put the width on a wrapper.
- **A sticky table column must be opaque.** `table.pinned` paints `--surface`,
  and its hover state is `--row-hover` rather than `surface-2/50`, because at
  50% alpha the columns scrolling underneath are readable straight through it.
- **Never set `overflow` on `<html>` or `<body>`.** Overflow on the root
  propagates to the viewport, and on iOS that detaches `position: fixed` from
  the visual viewport: the bottom tab bar stopped tracking the screen, sat
  wrong on a short page, was left behind by a taller one, and only snapped back
  once you scrolled. `overflow-x: clip` was there to contain the sideways travel
  of a page change; it lives on `main` instead, mobile only, where the element
  is exactly the width of the viewport.
- **iOS keeps painting the page behind the keyboard.** `visualViewport` shrinks
  but the layout viewport does not, so a sheet sized to the visual viewport ends
  at the keyboard's top edge with the dimmed page showing through beneath it —
  and the gap is sometimes taller than the keyboard, so `Sheet` paints a filler
  from the sheet's bottom edge downwards and overshoots deliberately. For the
  same reason the sheet's top gap is `env(safe-area-inset-top)` plus a margin
  rather than a percentage: a percentage of the *shrunken* viewport puts the top
  edge under the dynamic island.
- **A `Sheet` outlives `open` by `EXIT_MS`** so it can animate out, and it
  renders the title, children and footer it had when it was last open. Callers
  clear the row being edited in the same breath as they close (`onClose={() =>
  setEditing(null)}`), and without the freeze the sheet would flip to its "new
  item" form on the way out. A sheet keyed on what it is editing
  (`key={editing?.id ?? 'closed'}`) remounts instead, and so has no exit at all.
- **A budget is per month, so "the budget" is never a single number.** `useBudgets()`
  returns every month; `useBudgetsForMonth()` returns one. Handing the whole lot to a
  view that assumes one month renders each category once per month it was ever
  budgeted (the home widget did this, and double-counted the totals). Anything
  comparing history against budget must read the budget in force for *that* month —
  `lib/budgetHistory.ts` does this, and fills months with none from the median of
  the months that have one.

## Known gaps (not yet fixed)

- `importJSON` preserves `ownerId`, so a backup taken by one person and restored
  by another dead-letters rows that RLS refuses. It does not merge or remap.
- `stats.ts` `monthlySeries` has an `else if`/`else` pair with identical bodies —
  the income branch is dead code, harmless but misleading.
- Bill posting, transfers, account deletion and the wipe are **online-only** RPCs.
  Deliberate (they must be atomic), but there is no queued-offline story for them.
- No end-to-end test covers two users at once; the two-person cases are asserted
  in `supabase/99c-ownership-tests.sql` at the SQL layer only.
