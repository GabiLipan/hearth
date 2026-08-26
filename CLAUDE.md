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

Load `local/00-shim.sql`, then `01` … `19`, then `local/98-grants.sql`, then `exec`
a test file and read its result set — every row must have `ok = true`.
`pgcrypto` needs the explicit import: `PGlite.create({ extensions: { pgcrypto } })`
from `@electric-sql/pglite/contrib/pgcrypto`.

Take the last result set that HAS rows, not the last one: every test file ends
with `rollback`, which returns none, so reading `results[results.length - 1]`
reports zero checks and zero failures — a green run that asserted nothing.

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
| `09-reconcile.sql` | linking rows that already exist: a transaction to a bill occurrence, two transactions into one transfer, and both undos |
| `10-goal-transfers.sql` | a transfer that already exists can fund a goal — `link_transfer` gains `p_goal_id`, `set_transfer_goal` tags one afterwards, `unlink_transfer` releases it |
| `11-account-recovery.sql` | `restore_account` undoes a delete, `deleted_accounts` is the bin, `claim_account` lets an admin take an ownerless account and `unowned_accounts` is how they find one |
| `12-transfer-categories.sql` | `transactions.prior_category_id`, so unlinking a transfer gives each leg back the category linking took off it |
| `13-paid-for-household.sql` | `transactions.paid_for_household` — household spending paid from a personal account |
| `14-book-override.sql` | `accounts.book_override` — say which book an account is in, where deriving it from grants is wrong |
| `15-purge-account.sql` | `purge_account` — the bottom of the bin: destroy a deleted account and its rows for good |
| `16-explain-requests.sql` | `transactions.explain_requested_*` — ask the one person who can see the other half of a row |
| `17-account-appearance.sql` | `accounts.slot` + `accounts.icon` — an account gets a colour and an icon, like a category |
| `18-contributions.sql` | `transactions.contributor_id` — say who paid money in, where the far leg is in an account that will never be in the app |
| `19-published-household-rows.sql` | `accounts.publishes_household_rows` — a row marked as the household's is readable by the household, wherever it was paid from. The one row-level rule in the schema |
| `20-transaction-titles.sql` | `transactions.title` + `rules.title` — what a row is CALLED, as opposed to what the bank wrote, learned back through the same rules that learn a category. `rules.category_id` becomes nullable, and `upsert_rule` gains a fourth argument |
| `21-rule-conditions.sql` | `rules.amount_min_minor` / `amount_max_minor` / `account_id` — a rule may ask for more than the payee. Two subscriptions from one vendor at two prices become two rules, so the uniqueness rule moves from the payee to the whole condition set, and `upsert_rule` gains three more arguments |
| `22-rule-edits.sql` | `upsert_rule` looks before it inserts, so a rule's CONDITIONS can be edited — its payee, an amount, an account. Same signature as 21's, body only |
| `23-custom-colours.sql` | `categories.color` / `accounts.color` / `goals.color` — a `#rrggbb` of your own, laid OVER the slot rather than replacing it. Null is the ordinary case |
| `24-goal-allocations.sql` | `goal_entries` — a goal is a CLAIM on money already in an account, not a pot you move money into. `assign_to_goal` puts some of what an account holds towards a goal and refuses to let the goals on one account claim more than it has; `settle_goals` takes a withdrawal off what is unassigned first and then off the largest pot |
| `25-month-rule.sql` | `households.contribution_cutoff_day` + `income_cutoff_day` (null = never shift) and `set_month_rule` — the 25th stops being a constant and becomes two settings; `transactions.book_month` is one row's own answer, and the only thing that can move spending |
| `26-account-ink.sql` | `accounts.ink` — the MARK on an account's tile, where measuring it is not the answer. Null (the ordinary case) means measure it. Same deploy trap as `23`: run it BEFORE deploying |

All are re-runnable, with **five ordering traps**, and three of them are the
same trap. The rule migrations stack: `20` drops the three-argument
`upsert_rule` for a four-argument one and `21` drops that for a seven-argument
one, while `03` and `20` both stay re-runnable — so running either after `21`
or `22` puts an older signature back beside the current one, PostgREST cannot
resolve the call, and every rule the app learns dead-letters with "could not
find the function … in the schema cache". Re-run the highest of them;
`00-which-migrations-applied.sql` has a row that counts the signatures.

**`22` is the trap that counts no signatures**, and it is the nastiest of them
for exactly that reason: it replaces `21`'s `upsert_rule` with the SAME
seven-argument signature, so re-running `21` afterwards silently swaps the body
back to the broken one — no error, no second overload, and the signature count
still reads 1. Editing what a rule matches starts dead-lettering on
`rules_pkey` again and nothing else in the schema notices. The detector row for
`22` therefore reads `prosrc` rather than the signature. Verified by doing it.

`21` also REPLACES `rules_match_unique` with `rules_condition_unique`, and while
the old index stands a second rule for one payee is refused outright — there is a
row for that too. The next: `19` replaces
`07`'s `transactions_select`, so re-running `07` afterwards silently puts the
narrower policy back — nothing errors, published rows simply stop arriving, and
the household book quietly loses everything paid from a personal account. Re-run
`19`; `00-which-migrations-applied.sql` has a row that detects exactly this. And
the first of them, which is where the pattern was learned: `10` drops the two-argument
`link_transfer` and replaces it with a three-argument one, and `09` is still
re-runnable, so running `09` *after* `10` puts the old signature back beside
the new. PostgREST then cannot resolve the call — supabase-js drops `undefined`
arguments — and every transfer link dead-letters with "could not find the
function … in the schema cache". Re-run `10` to clear it;
`00-which-migrations-applied.sql` has a row that detects exactly this.

`23` sets no ordering trap and one DEPLOY trap instead, which is the other
shape this has taken: `READABLE` in `mapping.ts` is derived from `WRITABLE`, so
the moment `color` became writable every pull started asking PostgREST for it.
An app shipped ahead of its migration therefore does not lose the colour
feature, it loses SYNC — every pull of categories, accounts and goals fails on
an unknown column. Run `23` before deploying, not after.

`05` refuses to install if `04` is missing — necessary,
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
`rules.ts` (payee matching, learning — where a payee is filed AND what it is
called — the conditions beyond the payee that tell two charges from one vendor
apart, bulk recategorisation, and which of the covered rows to touch), `bills.ts`
(suggestions, posting, reconciliation), `imports.ts` (an import recognised
after the fact, and the two ways of putting a wrong one right — the screen for
it is `components/ImportHistory.tsx`, in Settings beside the accounts rather
than on the way in to the next import),
`transfers.ts` (pairing and linking),
`routes.ts` (recurring movements, derived from confirmed transfers),
`unexplained.ts` (the blind spot, and asking the person who can see past it),
`contributors.ts` (naming the person behind an arrival whose far leg does not
exist, and remembering the name for next month),
`goals.ts` (a pot as a claim on money already somewhere: what an account's goals
have taken, what is left unassigned, and what a withdrawal costs which pot),
`palette.ts` (the twelve slots, the order they are offered in, and a colour of
your own over the top of one), `categoryTree.ts` (what a drag on the category
list means, and what it writes), `accountOrder.ts` (the same drag on the
accounts list, flat — and the order the list is in before anybody has dragged
anything),
`layout.ts` (which sections a page shows, in what order, how wide AND how tall,
in which shape, and what else each one lets you decide — home and Reports share
it),
`drill.ts` (out of a figure and into the rows behind it, and the way back),
`sticky.ts` (a filter that outlives leaving the page and dies with the tab), `monthRule.ts` (when this household's month starts, and how that reaches both devices), `books.ts` (the three sets of books, which month each row counts in, what was left over when the month began, and where the money actually is), `sankey.ts` (a period as one balanced flow,
and where every band goes), `scale.ts` (a value axis with round numbers, shared
by a scrolling chart and the axis pinned beside it),
`reimbursements.ts` (what the household owes you — computed always, shown only
behind the `showOwed` flag; see `useFlag`), `shade.ts` (telling apart
two categories the palette gave one colour), `ink.ts` (which ink is legible
written straight onto one of those colours), `treemap.ts` (a set of amounts as a
set of rectangles, area meaning money),
`scroll.ts` (the element the app scrolls, which is not the document, and why),
`headline.ts` (what the phone's header says once a page has been scrolled into,
published by the page and read by the header),
`splash.ts` (taking the boot splash off, once there is an app behind it),
`outbox.ts` (queue, retries, dead letters), `pull.ts` (read path),
`api.ts` (the single PostgREST boundary), `mapping.ts` (camel↔snake + writable
allow-lists), `session.ts` (auth, household, sync orchestration),
`components/TxnName.tsx` (what a row is called, and the bank's own words after
it), `components/TxnSelect.tsx` (the rows a rule is about, and which of them to
touch — the same list wherever a rule is applied from),
`components/confirm.tsx` (asking before something irreversible, in the
app's own voice), `components/toast.tsx` (saying what just happened, and offering to take
it back).

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

**One row can leave its account, and exactly one.** Migration 19 is the first
row-level rule in the schema: a transaction marked `paid_for_household`, on an
account whose `publishes_household_rows` says so, is readable by everybody in
the household — and nothing else on that account is. Not the balance, not the
account's name, not one row that has not been marked. It exists because
`paid_for_household` counted the household's money correctly on the payer's
screen and was invisible on the other, which was the one documented thing
breaking the property the household book was chosen for.

Four things follow, and the first is the one to remember:

- **`my_account_ids()` is still the whole story for WRITES and no longer for
  reads.** `transactions_update`, `may_edit_transaction()` and every definer
  function that calls it are untouched: reading a published row gives you no way
  to change it, un-publish it, delete it, link it into a transfer, or ask about
  it. §5 of the migration is the audit, function by function, written down.
- **Consent is per ACCOUNT, asked once, and revocable.** "Is this an account I
  am willing to pay household things from" has a considered answer; "may she see
  this £90", asked every week, has a reflex one.
- **Both directions bump the epoch.** Off, because a row that becomes invisible
  emits no realtime event and no tombstone. On, because a delta pull is keyed on
  `updated_at` and the newly readable history has none that is new. Marking or
  un-marking one ROW bumps only on the way out, and DELETING a published row
  bumps not at all — the tombstone still satisfies the policy, which is why the
  policy has no `deleted_at` condition.
- **Nothing can be un-seen**, and the consent sheet says so in words. So does
  the note: the whole row travels, because RLS has no column-level half.

The client side is `isHouseholdPaid` / `showsInBook` in `books.ts`. A row like
this is on an account in NO book — including on the payer's own device, where
they hold the account perfectly well and it is still not one the household book
is made of — so `classifyFlows` classifies it from the FLAG rather than from
`bookOf`, and every row list built by selecting accounts has to admit it
explicitly or come up short of the total printed over it. Getting that wrong is
how it first shipped: the household list was missing the payer's own shopping
while the heading above it counted the money.

**A household admin manages people and nothing else.** They can invite, remove
and promote; they gain no access to any account they were not granted, and
`my_account_ids()` must never consult `is_household_admin()`.

Five rules that follow:

- **RLS is the only enforcement, and `security definer` switches it off.** Any
  definer function must restate in its body every predicate the policies would
  have applied. `wipe_household()` did not, and one person's "Erase everything"
  deleted the other's private accounts. Migration 09 states the
  `transactions_update` predicate once, as `may_edit_transaction(account_id,
  created_by)`; a new definer function that touches a transaction calls that
  rather than retyping the expression and drifting from it.
- **A function that changes two rows must authorise both.** `link_transfer()`
  checks each leg and refuses unless it may write both, because half a transfer
  is worse than none: the visible leg would leave the totals while the hidden
  one stayed in them, and no screen could explain the difference. Same for
  `unlink_transfer()`, from the other direction.
- **There are no DELETE policies anywhere.** Deletion is `set deleted_at`, an
  UPDATE. A hard delete would leave the other device's cache holding the row
  forever with nothing left to replicate. `purge_account()` (migration 15) is
  the single exception and shows what one costs: it is reachable only from the
  bin, so the row has already been tombstoned once; it is owner-only, checked by
  hand because no policy is going to do it; and it bumps the epoch — not because
  anyone's access changed, but because destroying the tombstone leaves a device
  that has been offline since the delete with nothing to learn it from.
- **Grants outlive the accounts they point at.** `delete_account()` and
  `wipe_household()` deliberately leave `account_grants` alone: `accounts_select`
  needs a grant, so revoking one would leave every other device holding the
  account forever with no tombstone it is allowed to read. Migration 11 depends
  on this a second time — `restore_account()` can recognise an owner *after* the
  account is gone only because the grant is still there. `purge_account()` is
  where they finally go, by cascade — there is no row left for them to
  authorise, and no device left that could be told about one.
- **An ownerless account is invisible, so listing one needs its own function.**
  `accounts_select` needs a grant, so an account whose grants have all gone —
  what `depart_household()` can leave behind — cannot be seen by anybody,
  including the admin entitled to claim it. `unowned_accounts()` exists for
  exactly that, and returns names only: being able to give an account an owner
  is not being able to read it.
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
- **`on conflict` names ONE arbiter, and a row can already be there two ways.**
  `upsert_rule` was a single `insert … on conflict (the condition set) do update`
  for eighteen migrations, which resolves the case it was written for — two
  devices learning one payee — and not the other one: the client sends the id of
  the row being edited, so an edit that changes any part of the condition set
  collides with nothing on that index and dies on `rules_pkey` instead. Editing
  what a rule MATCHED therefore never worked, and it failed the worst way — a
  dead letter minutes later in Settings, reading `duplicate key value violates
  unique constraint "rules_pkey"`, which "Try again" cannot fix because the
  retry re-sends the same doomed insert. Migration `22` looks before inserting,
  which is the shape `upsert_budget` had from the start. The general lesson:
  where the client supplies the primary key, an upsert needs to consider the
  primary key as well as the natural one, and `on conflict` alone cannot.

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
- **A locally created row has none of the server's stamped columns**, and
  nothing writes them back — `insertRows` sends `ignoreDuplicates: true` with no
  `.select()`, so the only thing that fills in `created_by`, `created_at` and
  the real `updated_at` is the next pull, up to a minute later. That matters
  because `useMyLevels` bridges the gap between creating an account and its
  owner grant arriving by reading `created_by`: when `AccountForm` did not stamp
  it locally the bridge never fired, and a new account was one nobody could
  edit, share or delete until a background pull happened to land. Callers stamp
  `createdBy` themselves (`stripLocal` keeps it out of the payload, so the
  server still writes its own). The same emptiness makes a fresh account's
  cached grant list `[]`, so anything counting or listing grants has to floor
  itself at "you" rather than report nobody.
- **The sharing list is only knowable at `manage` and above.**
  `account_grants_select` gives you your own grant on anything and other
  people's only where you could change them anyway, so below `manage`
  `useGrantsFor`/`useGrantsByAccount` return just your own row. Rendered as
  "who can see this" that reads as "only you" on an account three people have
  open. Gate on `canManageAccount` before treating the array as a sharing list.
- **A grid item's `min-width` is `auto`, which is its CONTENT's width.** So a
  card holding a `ScrollTable` (or the heatmap, at `min-w-[34rem]`) grows the
  grid column to fit it, and the `overflow-x-auto` inside never gets the chance
  to scroll — the card ends up wider than a phone screen. Worse, `main` carries
  `overflow-x: clip` on mobile, so the excess is silently CUT OFF rather than
  showing a scrollbar, and the page still measures as fitting. Any grid whose
  children can contain something wide needs `[&>*]:min-w-0`; the Reports grid
  does. `minmax(min(100%, 22rem), 1fr)` in the auto-fill grids is the same
  guard, spelled differently.
- **A `<tspan>` carrying its own `dy` REPLACES the shift it would have
  inherited**, rather than adding to it. `<text dy="15"><tspan dy="0">` puts the
  first line back at the text's `y`, not 15px below it — which in a wrapped
  chart axis label drew the first line straight through the bars. Put the
  offset on the first tspan (`dy={i === 0 ? 15 : 12}`), not on the `<text>`.
- **Do not use CSS `columns` for cards.** Safari ignores `break-inside: avoid`
  in a multi-column layout and cuts a card in half at the column boundary,
  stranding its bottom border at the top of the next column; `column-span: all`
  is unreliable there too. Both the home page and Settings shipped with this.
  What replaced it was `Columns` in `ui.tsx` — flex columns balanced from
  measured heights, with no fragmentation context for anything to split in —
  and what replaced THAT is one CSS grid, so `Columns` is gone. The rule it was
  written for stands: cards are never laid out with CSS `columns`.
- **`Select` carries `w-full`, so a width passed to it does nothing.** Tailwind
  emits `.w-full` after `.w-40`, so the base class wins however the attribute is
  ordered — the control fills its flex row and squeezes a `flex-1 min-w-0
  truncate` sibling to zero width. This is how the sharing list came to show a
  photo and a level with no name between them. Put the width on a wrapper.
- **A cut-off word says "there was more" with three characters; a fade says it
  with none.** `.fade-x` is `overflow: hidden` plus a mask that takes the last
  1.5rem to transparent, and it replaced `truncate` everywhere in Activity's
  table — in columns that tight, an ellipsis is three characters of payee
  spent saying that the payee did not fit. The gradient is positional on the
  BOX, so a cell whose text ends before the ramp is untouched: nothing fades
  unless something is genuinely running off the edge. It cannot share an element
  with `.pin-edge`, because a mask applies to an element's pseudo-elements too
  and would take the shade with it — the cell wears the shade, an inner span
  wears the fade — and the cell must NOT hide its own overflow, or it clips the
  shade drawn just outside its right edge.
- **A pinned column meets the scrolling ones at a hard line unless something
  softens it.** `.pin-edge` draws ten pixels of `--pin-shade` just outside the
  last pinned cell, so one thing passes behind another instead of two sharp
  edges of text meeting. The shade is black in BOTH themes: a shadow is an
  absence of light, and a pale one in the dark theme reads as a glow coming off
  the column. It appears only while the table is actually scrolled sideways
  (`ScrollTable` marks the scroller `data-scrolled`) — a depth cue with nothing
  moving under it is a vertical line in the middle of a table, which is a column
  divider this app draws nowhere else.
- **Two pinned columns need the first one's width to be a number, and it has to
  be MEASURED.** Activity's table pins Date and Payee — what a row IS, against
  the columns saying what it was filed as — and the second one's `left` has to
  equal the first one's width exactly, or a strip of the scrolled-under table
  shows between them. Stating both (`w-32` and `left-32`) makes them agree only
  under `table-fixed`, which prices every other column at a stated width too —
  and a category longer than its column then wraps or is cut, when what it wants
  is simply to be wider. So the layout is auto, `ScrollTable` measures the first
  header cell with a border-box `ResizeObserver` and publishes `--pin-next`, and
  `table.pinnedNext` reads that. Only ONE column may then carry `w-full max-w-0`
  — the payee — which is what makes it take the slack and give it back first
  while every other column sizes to its own contents.
  The month heading rows are `sticky left-3 w-fit` inside their cell for the
  same gesture: a heading that slides away is a band of tint over rows it no
  longer names.
- **A running balance can only be READ down one account.** Every figure in
  Activity's Balance column is true wherever it appears — what that row's own
  account held once that row had gone through it — and a column of them down a
  list spanning three accounts does not add up: 1,284 then 43 then 900, none of
  them differing by the amount printed beside it, because consecutive rows are
  answers about different accounts. A bank statement has this column precisely
  because every line on it is one account. So the column is present only while
  the rows in view are one account's (`oneAccount`, read from `filtered` rather
  than the paginated `visible`, or scrolling far enough to reach a second
  account would make a column vanish mid-page), and the Account filter is how
  you ask for it.
- **A balance is not a filtered figure.** Activity's Balance column is what the
  account held after each row, computed by `runningBalances` over EVERY
  transaction the device holds — never over what the filters left on screen,
  where a search for one shop would produce a column of numbers that look like
  balances and are the sum of that shop's spending. It counts forwards from the
  opening balance (where `balanceHistory` walks backwards from today's figure,
  because that one has to END on the number printed beside it), and it is silent
  — absent from the map, a dash on screen — about an account this device does
  not hold, which a published `paid_for_household` row is.
- **A sticky table column must be opaque.** `table.pinned` paints `--surface`,
  and its hover state is `--row-hover` rather than `surface-2/50`, because at
  50% alpha the columns scrolling underneath are readable straight through it.
- **A form keyed on the row it edits also remounts when it closes**, which
  throws the sheet away before it can animate out. The key is load-bearing —
  those forms read their fields straight from the prop with
  `useState(bill?.name ?? '')`, so the remount is the only thing that loads them
  — so key on a counter bumped when the form *opens* instead. Opening still
  gets fresh fields; closing no longer remounts.
- **A sheet grows from the last control pressed**, tracked by one capture-phase
  `pointerdown` listener in `ui.tsx` rather than an `origin` prop handed down
  from every opener. Pass `origin` explicitly only to override it. The origin is
  fixed when the sheet opens, or the exit would collapse into the close button.
- **Interrupting an animation means reading the DOM, not a remembered target.**
  `BottomTabs` starts every transition from live geometry, and cancels the
  running animations *before* measuring where the next one is going: until they
  are cancelled the animations own those properties, so the resting widths
  written underneath have no effect on layout and the measurement reads the old
  transition mid-flight. Tapping a third tab while the second is travelling is
  the case that catches both.
- **A finish event is never delivered while the app is in the background.** The
  animation still reaches `finished`, but `onfinish` and `ResizeObserver`
  callbacks wait for the next rendering opportunity. So nothing that has to be
  *true* may live in one: `BottomTabs` writes the resting layout first and
  animates over the top of it, with no `fill`, so backgrounding the app
  mid-transition cannot strand the bar.
- **Never set `overflow` on `<html>` or `<body>`.** Overflow on the root
  propagates to the viewport, and on iOS that detaches `position: fixed` from
  the visual viewport: the bottom tab bar stopped tracking the screen, sat
  wrong on a short page, was left behind by a taller one, and only snapped back
  once you scrolled. `overflow-x: clip` was there to contain the sideways travel
  of a page change; it lives on `main` instead, mobile only, where the element
  is exactly the width of the viewport. Nothing in the app sets it any more —
  the sheet scroll lock was the last one, and it locks `#app-scroll` now.
- **Padding inside a scroller is a place content scrolls THROUGH.** The status
  strip above `md` was `md:pt-[var(--safe-top)]` on `#app-scroll`, which reserves
  the room and then lets every row travel up into it — under the material iPadOS
  (and a Mac's own window chrome) paints over the top of a full-screen app. The
  result was a band of blurred rows across the top of the content column on an
  installed iPad, which nothing in this codebase drew and no CSS of ours could
  have removed. The inset is the FRAME's padding now, so the scroller BEGINS
  below the strip and what shows there is the page's own ground. Two things go
  with it: the rail no longer adds `--safe-top` to its top margin (the row it is
  in already starts below the clock, and stating it twice held the rail a status
  bar lower than the content beside it), and `Notices` still does — an absolutely
  positioned box resolves against the frame's PADDING box, which includes the
  padding rather than starting under it.
- **"Installed" is not the same question as "has a status bar over it".**
  `--safe-top` floors the top inset at 24px where the app is installed and
  `env(safe-area-inset-top)` reports 0 — which is an iPad, where the app is
  `black-translucent` and iPadOS paints the clock over the window while
  reporting nothing. Applied to every installed app it also reserves 24px on a
  Mac, which has a real title bar with the traffic lights in it and nothing
  overlapping the page at all: a strip of empty window at the top of every
  screen, for ever. The condition is `any-pointer: coarse`, not
  `pointer: coarse` — an iPad with a Magic Keyboard reports a FINE primary
  pointer and is still an iPad with a clock over the top of it, and
  `any-pointer` asks whether a touch screen is there at all, which is the
  question being asked.
- **`100dvh` is wrong on a cold start of an installed iOS PWA**, by about the
  height of the browser chrome that is not there, and it stays wrong until the
  viewport is "exercised" — a scroll is enough. There is no event for the
  settle, so there is nothing to await and nothing to re-measure: every number
  the app can read agrees with every other one and they are all short together.
  The tell is a layout that is correct the instant you touch it and wrong every
  time you open the app. `100vh` is the LARGE viewport, a fixed number needing
  no settling, and in standalone there is no chrome for it to be wrong about —
  so `.app-frame` takes `dvh` in a browser tab and `vh` in the installed app.
  Two selectors, deliberately: iOS is both the platform with the bug and the
  one whose `display-mode: standalone` support cannot be relied on, so
  `index.html` stamps `data-standalone` from `navigator.standalone` before first
  paint. A fix that only fires where the bug is absent is not a fix.
- **`sticky` is not immune to the bounce either.** A sticky element never rises
  above its own natural position, so the top bar — `sticky top-0` inside the
  scroller — was carried down by a pull past the top of a page, the same
  complaint as the tab bar at the other end. It is `absolute` over the frame
  now, with the scroller padded by `--header-h` to match, so the rows still pass
  BEHIND it and it keeps its frosted edge. In flow above the scroller would hold
  just as still and would cut the content off at a hard line instead, which is a
  different-looking app. `--header-h` is what stops the first card starting
  underneath the bar, and it is what `appScrollerTopInset()` reads, so a jump
  lands where the eye expects rather than under the discs.
- **Nothing on a phone is `position: fixed` any more.** The tab bar and the FAB
  are positioned against `.app-frame`, because `fixed` resolves against a
  viewport the app cannot see or correct — which is how the same bar was moved
  by the rubber band and then, separately, placed 60-odd pixels too high on
  every cold start. Anchoring it to a frame the app sizes itself removes both at
  once. It costs nothing now: the frame stopped scrolling when the scroll moved
  inside it, so "outside the scroller" and "fixed" stopped being the same
  requirement. `Toaster` is the exception and is still fixed — it appears in
  response to something you did, by which time the viewport has long settled.

  `absolute` within the frame rather than in flow, since the bars became
  capsules: a floating shape only means anything if content passes behind it,
  and in flow nothing could. The bounce is untouched by that — `.app-frame` is
  not what moves during one — but the room the bars stop occupying has to be
  handed back, which is what `--header-h` and `--tabbar-h` are. **Both are
  measured, never constants**: one is a row plus `env(safe-area-inset-top)`, the
  other a capsule plus the home indicator's inset, and a notched phone, a flat
  one and the same phone in a browser tab all answer differently. One effect in
  `Layout` writes both and a `ResizeObserver` keeps them true.
- **Both bars are 5px larger than the pill inside them, and that is the whole
  shape.** The bar's radius is half its height at both levels, so the travelling
  pill nests in the bar's own corner. Two consequences worth not undoing:
  `PILL_BLEED` is now clamped to the tab row (`wrap.clientWidth`) as well as to
  the gap, or the first and last pills spend their bleed pushing through the
  5px and touch the rim while the four in the middle do not; and the pill is
  `inset-y-0`, not `inset-y-1`, because the clearance is stated once, as the
  bar's padding.
- **A floating control needs frost, not a tint.** The book lens was
  `bg-accent/12` on a solid header bar, which was legible because the bar behind
  it was opaque. Floating over the rows, 12% of an accent is 12% of whatever
  transaction happens to be underneath, and the word inside it becomes
  unreadable the moment you scroll — caught in dark mode, where a white row ran
  straight through it. `CHROME_FROST` in `ui.tsx` is the four properties that go
  together, stated once so the lens, the settings disc and the tab bar cannot
  drift: they are meant to read as one set of objects at two ends of one screen.
  Deliberately thin (65%, 6px) — the point of floating the bars was to see
  things pass behind them, and a frost that hides the page is a bar with extra
  steps. The accent is spent on the SELECTED option once the lens is open, not
  on the closed control: two blue things in an otherwise empty corner read as
  two states of one thing rather than as a control and a label.
- **A masked `backdrop-filter` does not ramp a blur — it CROSS-FADES.** At mask
  alpha `a` the result is `a` parts blurred backdrop and `1 − a` parts the
  original, still perfectly sharp. So the obvious cheap progressive blur — one
  layer, one radius, a gradient mask — spends its whole middle laying half a
  blur over legible text. It looks like dirty glasses, and it is worse than
  nothing: measured over the strip above the bar it *raised* local edge energy
  by 21% against no scrim at all, because a soft copy offset against a sharp one
  makes doubled edges rather than fewer. No radius or mask curve rescues it; the
  sharp copy is in the recipe. `.dock-scrim` is four stacked layers instead
  (1 / 3 / 8 / 20px), each mask reaching full opacity *before* the next begins to
  appear, so every band cross-fades blur against blur. Only the topmost mixes
  with the unfiltered page and it does so at 1px, where there is no edge to
  ghost. 80% of the sharp detail gone below the bar, against 60% for the single
  layer, and no legible text anywhere in the tail. It costs four filters on an
  element that is on screen the whole time the app is; that is the price of the
  effect, and frame times did not move.

  Both edges wear it — `.scrim-down` under the tab bar, `.scrim-up` behind the
  header discs — and every stop is written from the CLEAR end so one set of
  numbers serves both. **Each one stops exactly where the content starts**,
  which is the scroller's own padding: `--header-h` at the top,
  `--tabbar-h` at the bottom. That is not tidiness. Reaching 40px further into
  the page put the large page title inside layer 1's ramp AT REST, and 1px of
  blur cross-faded against sharp text is invisible on a row and plainly visible
  on 28px bold — a doubled ghost along the top of every letter, which is the
  exact fault the stack exists to remove. Anything sitting in the ramp when
  nothing is moving wants to be fully sharp or fully blurred, never mixed.
- **The floating chrome must refuse the gesture, not merely survive it.** Both
  bars sit OUTSIDE `#app-scroll`, positioned against the frame, so a drag that
  starts on one has no scroller to act on — and iOS answers that by rubber-
  banding the viewport, which carries the whole app with it, bars included. They
  visibly slid and snapped back, which is the one thing the frame arrangement
  exists to prevent. `overscroll-behavior` is no help: on `<body>` it does
  nothing in Safari, and on `<html>` it takes the page's own bounce with it.
  Two halves, both wanted: `touch-none` on each control (declarative, enough
  almost everywhere) and a non-passive `touchmove` → `preventDefault` on the
  header and the dock (the guarantee, because WebKit has been unreliable about
  `touch-action` on an element with no scrollable ancestor — exactly this case).
  Attached to the two containers rather than to each control, because both are
  `pointer-events-none` with children opting back in: a touch on a bar bubbles
  through, and a touch on the empty space beside one never enters the subtree at
  all. That asymmetry is the feature — the page stays draggable everywhere the
  chrome is not.
- **Pull down to dismiss lives in one hook, and it has four sharp edges.**
  `useSwipeDismiss` is on `Sheet` and on the settings modal, so everything
  modal in the app inherits it — confirmations, the drill sheet, every form.
  - **It is `touchstart`/`touchmove`, not pointer events, and that is not a
    style choice.** The gesture has to `preventDefault` the moment it commits,
    or iOS rubber-bands the scroller under the finger while the panel is also
    moving. Pointer events are passive by default on touch and cannot. It also
    gives "mobile only" for free: a mouse never gets there.
  - **A CSS animation beats an inline style for the property it animates.** So a
    panel that keyframes its own `transform` on the way out — `animate-sheet-out`,
    `animate-origin-out`, `animate-settings-out` — would snap back to the top and
    leave from there, which is the one jump the drag exists to remove. The hook
    returns `dismissing` and every caller MUST use it to suppress its own exit.
  - **It commits DOWNWARD only, and the direction test is what makes the sheet
    scrollable at all.** `stealsFromScroller` has already refused a gesture that
    starts part-way down a scroller, so everything reaching the direction test
    starts at the top — where an upward drag is the whole of how you read the
    rest of the page. Committing on "predominantly vertical" and then
    `preventDefault`ing meant a swipe up from the top scrolled nothing and
    dragged the panel a resisted quarter-inch instead: not a sheet that scrolled
    badly, a sheet that could not be scrolled, since every scroll starts from
    the top once. The resistance in `move` is still there and now only ever
    means a finger taking a pulled-down panel back past where it started.
  - **The listeners attach to a ref that does not exist yet** unless `enabled`
    waits for `shown`, the same trap `useMorphHeight` and the focus effect carry
    notes about: on the render where `open` first turns true, `Sheet` returns
    `null`. Keyed on `open` alone the effect fires once against a null ref and
    never looks again, and the gesture is dead on every sheet, silently. It was,
    until a browser said so.

  The rule for when a drag is a dismiss rather than a scroll is deliberately
  positional, not modal: walk up from whatever was touched, and refuse if
  anything on the way is scrolled away from its top. You can pull a sheet down
  only from a point where pulling down would otherwise do nothing. `[data-no-swipe]`
  opts a subtree out for the case that rule cannot cover — a slider, a
  vertically draggable list.
- **Every toggle in the app is `Segmented`, and it is a capsule now.** Both
  levels are `rounded-full`, so the thumb nests in the track's own corner rather
  than sitting in it as a smaller, differently-shaped box, and the thumb is
  `bg-accent/12` — the same tint the tab bar's travelling pill uses — with the
  chosen option in accent and a heavier weight. Eleven call sites inherit that,
  which is the point: Expense/Income, the theme, the book on a wide screen and
  the Reports controls are one language stated once. The remaining `aria-pressed`
  controls are NOT toggles and should stay as they are — the icon and colour
  pickers are grids, and Reports' phone view switch is a `FilterChip` matching
  the chips beside it.
- **Every button in the app is a capsule, and every icon-only button is a
  circle.** One `rounded-full` on `Button` covers ninety-odd call sites; the
  handful of raw `<button>`s that never went through it were changed to match —
  the sidebar's nav rows and its Add button, the month stepper's two arrows, the
  drag handle on a category, Budgets' ± pair, Activity's row actions and payee
  filter, the drill sheet's action and the button inside a chart's tooltip. The
  point is that the shape means "press me" and nothing else does: the phone's
  tab pill, the FAB, `Segmented`, the chips and the toast's Undo were already
  capsules, and a `rounded-lg` button beside them read as a different kind of
  thing. What deliberately did NOT change is anything that is not a button: text
  inputs and selects keep `rounded-xl`, because a field and an action wanting to
  look different is the one distinction the shape is carrying. Nor did the
  surfaces — cards, sheets, popover panels, menu rows inside them, and the icon
  and colour grids are tiles, not buttons.
- **Settings is a modal route on a phone, and the background is held for the
  whole subtree.** It renders over the page rather than instead of it, so
  closing it gives back the scroll position rather than the top of a rebuilt
  page — `App` renders the ordinary routes against `location.state.background`
  while the address says `/settings`, and `Layout` renders the settings routes
  as a layer. Three things that will bite:
  - **`Layout` must derive every page-ish thing from the BACKGROUND's pathname**,
    not the location's, or the modal lights no tab, titles the window "Settings"
    over the Activity list, and offers the book lens on a screen with no figures.
  - **The background cannot come from `location.state` alone.** Settings' group
    screens are ordinary `<Link to="/settings/data">`s, and a link cannot know it
    is inside a modal — the first tap would land on an entry with no state and
    drop Settings into the page slot mid-gesture. `resolveBackground` remembers
    it while the path stays under `/settings` and forgets it the moment it
    leaves. It is module scope because `App` and `Layout` need the same answer in
    the same render pass.
  - **It is gated to phone widths with `useWide`**, because the X that closes it
    lives in a header that is `md:hidden`. Above `md` a modal would be a layer
    nothing could dismiss, and an iPad Mini crosses that breakpoint on rotation.
  It carries a `Sheet`'s top corners and a shadow cast UPWARD (`--elev-up`,
  defined per theme like the other two), both of which are off screen at rest —
  the corners sit on the frame's own top edge and the frame clips the shadow
  above them. They are spent entirely on the two moments it moves: arriving, and
  being pulled back down, which is when it has to stop reading as a page that
  replaced the last one.
  Closing is `navigate(background, { replace: true })`, never `navigate(-1)`:
  the group screens are real routes, so one step back from `/settings/data` is
  the Settings index with the modal still up.
- **A `ResizeObserver` watches the CONTENT box unless told otherwise**, and both
  `--header-h` and `--tabbar-h` are a fixed row inside padding that is entirely
  `env(safe-area-inset-*)`. So on the one event that changes them — a rotation
  taking the top inset from 59px to 0 — the content box does not move, the
  callback never fires, and the scroller keeps padding itself for a header that
  is no longer that tall. Both observations pass `{ box: 'border-box' }`. Any
  future measurement of an element whose size lives in `env()` padding needs the
  same, and the failure is silent in exactly the orientation nobody tests in.
- **There are two pill springs, and the difference is deliberate.** The tab
  bar's (`PILL_SPRING`, ζ≈0.8, ~7% overshoot) is pressed constantly by a thumb
  and travels a short way; the lens's (`pillBounce()`, ζ 0.55, 12%) is pressed
  occasionally and travels from a 44px disc to a 230px row. Both are SAMPLED
  from a spring rather than hand-picked — see the `origin-in` note below for why
  chosen stops always feel linear. The lens's is a `linear()` easing, which
  needs Safari 17.2 and, unlike a CSS declaration, does not degrade in the Web
  Animations API — it throws — so `pillBounce()` probes with `CSS.supports`
  before handing one back.
- **The mobile header is a layer, not a bar, so it must not take taps.** There
  is no plate and no title in it any more — the tab bar names the page already,
  so a permanent title bar was spending 52px saying the same word twice, and the
  title is a large heading at the top of `main` that scrolls away. What is left
  spans the full width of every page and is mostly empty, so the `<header>` is
  `pointer-events-none` with its children opting back in. As a solid bar it
  could afford to swallow taps across the top of the screen; as a transparent
  layer, the first card is behind it.
- **The document does not scroll. `#app-scroll` does.** This is the one
  structural thing to know about `Layout`: it is a frame exactly `h-dvh` tall
  that never scrolls, holding a single scrolling column, with the tab bar and
  the FAB OUTSIDE that column. It exists because of the rubber band — scroll
  past the end of a page on iOS and the visual viewport slides off the layout
  viewport, and `position: fixed` resolves against the layout one, so the bar
  left the bottom of the screen on every bounce. It was not positioned wrongly;
  the thing it was positioned against moved, and no CSS opts an element out of
  that. Moving the scroll inside leaves the bounce entirely intact — the column
  rubber-bands natively, on flicks as well as drags, because it is iOS doing it
  — while the bar sits on a viewport nothing can move.

  **Both cheaper fixes were tried and reverted**, so try neither again:
  - *Kill the bounce* (`overscroll-behavior-y: none` moved to `<html>`). Works,
    and the bounce is wanted — no bounce is worse than a moving bar.
  - *Correct the bar in JS* from `visualViewport`. Reads as SHAKING: the band is
    compositor-driven and the correction is a main-thread `setState` per event,
    so the bar chases it a frame or two behind the whole way. The arithmetic was
    right — measuring correctly on the wrong thread is the problem, so there is
    no tuning that saves it.

  What this costs is that `window.scrollY` is permanently 0 and
  `window.scrollTo` is a silent no-op. Everything goes through `lib/scroll.ts`
  instead, and the trap is that a call left behind still compiles and still
  runs. Two things it is worth knowing are already handled: `Popover` listens
  for scroll on `window` in the CAPTURE phase, which still reaches a scroll on a
  descendant (the non-capture spelling would silently never fire again), and the
  drag geometry in `CategoryTree`/`Arrange` freezes boxes in the scroller's
  coordinates — pointer and boxes convert the same way, so the scroller's own
  offset on screen cancels and never appears in the arithmetic.
- **A sticky inset is measured from the scroller's CONTENT box**, so the
  scroller's own padding is added to it rather than absorbed by it. `#app-scroll`
  carries `pt-[var(--header-h)]` to hold the first card clear of the absolutely
  positioned top bar, and Activity's month headings *also* said
  `top: var(--header-h)` — left over from when the bar was `sticky top-0` inside
  the scroller and there was no padding under it. Both were true at once for
  exactly one commit, and the headings parked at TWICE the bar's height,
  floating in the middle of the rows they belonged to. The clearance is stated
  once, in the padding: anything that wants to stick under the bar wants
  `top-0`, and anything that wants to SCROLL something to that line wants
  `appScrollerTopInset()` — the same number, read from the scroller, rather than
  a second constant to drift from the first.

  Those headings do not stick at all any more, and the reason is worth keeping:
  a sticky band works by butting into the underside of something solid, and once
  the top bar became two floating discs there was nothing for it to butt into —
  it was a full-width rectangle with square corners parked in the middle of the
  rows, separating nothing from nothing, in a screen where everything else that
  floats is a capsule. The job moved rather than being dropped. `lib/headline.ts`
  lets a page publish a line, and the header shows it in the middle, between the
  lens and the settings disc, for as long as you are inside that month's rows —
  the same answer, in the place the eye already goes for it. It is `null` above
  the first heading, so the capsule is absent rather than repeating the large
  page title that is still on screen there.
- **The boot splash is in `index.html`, and only its dismissal is in the app.**
  The OS splash cannot be animated — Android composites the launcher icon on
  `background_color`, iOS shows a still image — so the animated opening is the
  first thing the page paints, and anything shipped inside the bundle paints
  after the blank page it exists to cover. Two rules keep it honest. It comes
  off when React has painted, never when `SyncState.ready` resolves: a returning
  user's `ready` comes from the cache, but a device that has never completed a
  sign-in waits on the network, and tying the splash to that hangs the app on a
  fireplace on exactly the offline launches the cache exists for. And it has a
  floor as well as a ceiling — a warm start paints in under 100ms, and an
  animation cut off three frames in reads as a glitch rather than as motion. The
  ceiling is an inline `setTimeout` in `index.html` rather than in `splash.ts`,
  because the case it covers is the bundle never arriving to call anything.

  **What it shows is a lockup that LOOPS, not an entrance that finishes.** The
  icon and the name sit on one line in the middle of the screen at 40% of the
  width; the icon breathes to 1.05 and the letters lift 0.085em behind it, both
  on one period (`--pulse`) and both sampled from the same sine — one motion in
  two places rather than two that happen to agree. It loops because nothing here
  knows how long the boot will take: a one-shot entrance had to guess, and a
  slower boot left a still picture on screen for the rest of the wait, which
  reads as a hang. `MIN_VISIBLE_MS` in `splash.ts` is therefore a floor and not
  a completion — there is no frame at which the animation is done. Two sizing
  notes: `.brand` is an inline-size container so the icon, gap and type are
  stated in `cqw` and cannot drift out of proportion however the row was sized
  (it is clamped at both ends), and the word cancels its own trailing
  letter-spacing or the whole lockup sits visibly left of centre.

  **Its ground is the app's `--page`, not the mark's dark**, written out as two
  literal colours under `[data-theme]` because the stylesheet is in the bundle
  and this has to be right on the first frame — the theme is already stamped on
  the root by the script above it. The dark the mark was drawn against is the
  ICON's own tile now, beside the name rather than behind both, so the wordmark
  is `--ink` (both values, same reason) rather than the cream it was on the card
  — cream on the light page is invisible. So the join the splash is honest about
  is the one with the APP, which is what you look at for the rest of the
  session, rather than the one with the OS. `manifest.background_color` cannot
  be themed at runtime and so can no longer match the frame after it; it stays
  the icon's dark, which the OS's tile now shrinks into rather than being
  replaced by.
- **`overscroll-behavior` propagates to the viewport from `<html>` only**, where
  `overflow` propagates from `<body>` too. So the declaration on `body` does
  nothing in Safari and stops Chrome's pull-to-refresh, which is exactly what is
  wanted and is why it stays there. Moving it to the root takes iOS's bounce
  away with it.
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
- **The same delay makes `open` the wrong thing to measure a sheet against.**
  `useMorphHeight` animates the body between the shapes its contents take (the
  Expense/Income toggle, a prompt appearing under a category), and it keys off
  `shown` — on the render where `open` first turns true the phase has not caught
  up, `Sheet` still returns `null`, and a layout effect fires against a content
  node that does not exist yet and is never scheduled to look again. Its "don't
  animate the first measurement" flag is a passive effect rather than a
  `requestAnimationFrame` for the reason `BottomTabs` gives: a sheet opened while
  the tab is backgrounded would otherwise never switch its transition on.
- **A promoted subcategory has no style of its own to promote.** A subcategory
  stores `icon` and `slot` as null — null means "inherit", which is what keeps a
  parent and its children looking like a set — but
  `categories_top_level_has_style` requires a top-level row to carry both. So
  clearing `parentId` alone produces a row the check constraint rejects, minutes
  later, as a dead letter. `writesFor` in `categoryTree.ts` resolves the
  inherited style with `styleOf` and writes it alongside, which also means the
  category looks exactly the same after being promoted as before. Demotion is
  the mirror: clear both, so it inherits its new parent.
- **The category drag mirrors the server's rules rather than discovering them.**
  A parent travels with its children, nothing crosses between spending and
  income, and a parent with children cannot become one — all three are
  `categories_hierarchy_guard`, restated in `move()` so a drop the database
  would refuse is never offered. The drag's geometry is frozen at pick-up in
  the SCROLLER's coordinates, so auto-scrolling does not invalidate it, and the
  insertion line is drawn from `move`'s own answer rather than from the pointer:
  when a drop is clamped, the line goes where the row will actually land.
  `pointercancel` must NOT commit — it is the system taking the gesture away,
  not a drop.
- **A genie is a warp, and the web has no warp — so it is timing and 3D.**
  macOS bends the window's sides into a curve, which no affine transform can
  do. The two honest options are an animated `clip-path` (a repaint of the whole
  sheet every frame, on a form full of inputs) or `perspective` + `rotateX`,
  which tips the edge nearest the button away so THAT edge narrows while the far
  one stays wide — a trapezoid the eye reads as a funnel, and composited, so it
  measures with nothing over a frame budget. Opacity holds until the very end: a
  genie is swallowed, not faded, and dropping it early turns the neck into a
  smear. `EXIT_MS` in `ui.tsx` must outlast the exit keyframes — a number left
  behind there cuts the last frames off it.
- **Keyframe stops are SAMPLED from a spring, never chosen by hand.** Hand-picked
  scales look reasonable in a list and animate at a near-constant speed through
  the middle, which is exactly what "it feels linear" means. `origin-in` is the
  step response of mass 1, ω 20, ζ 0.82 read at fifteen points: two thirds of the
  travel is over in the first quarter and the rest is a settle, which is why the
  class runs them `linear` — the samples ARE the easing. ζ near 0.82 keeps the
  overshoot around 1%, which on a full-viewport frame is ~6px at the far corner.
  The generator lives in the commit that introduced it; re-derive rather than
  nudge a number. The same spring, stiffer and flatter (ω 26, ζ 0.86), is what
  `.morph-height` travels on — as a CSS `linear()` easing rather than keyframes,
  because a transition between two measured numbers has no keyframes to hang
  them on. `linear()` needs Safari 17.2, so the cubic-bezier stays above it as
  the fallback declaration: an unsupported easing drops the whole line, and
  without one underneath the height would jump.
- **Anisotropic scaling has a budget, and it is smaller than it looks.** A
  transform does not re-lay-out the text under it, so scaling Y twice as far as X
  squeezes every word sideways. At 2:1 held for 200ms a phone-sized sheet reads
  as a rendering fault rather than as motion — "too stretched" was the report.
  The funnel wants a peak around 1.4:1, gone inside 100ms; past that it stops
  looking like a neck and starts looking broken.
- **Anticipation reads as latency on anything you pressed.** `--ease-settle`
  started life with a negative first control point, so the sheet's resize dipped
  backwards for its first fifth before setting off — which on a bottom-anchored
  sheet moves the top edge the wrong way and then jolts to catch up. All the
  character belongs at the END, where nobody is waiting for it: the curve is
  half way to its target by ~40ms and overshoots ~3% on arrival. The same goes
  for the frame budget — `useMorphHeight` re-measures in a dependency-less
  layout effect as well as in its ResizeObserver, because a `setState` from an
  observer callback is ordinary priority and can land a frame late.
- **An `overflow-x-auto` bar clips an `absolute` panel on BOTH axes.** The
  filter chips scroll sideways, so a dropdown positioned inside one opened,
  turned its chevron, and showed nothing. There is no way to have a bar that
  scrolls and a panel that escapes it in the same box, so `Popover` portals its
  panel to `document.body` and maintains the position by hand — measured on
  open, re-measured on scroll **in the capture phase** (a scroll on the bar does
  not bubble to `window`), and clamped afterwards against the panel's own
  measured width, which is only knowable once it exists because `w-64` is a
  class and not a number. Outside-click has to test the anchor *and* the panel:
  the panel is no longer a descendant of the trigger.
- **`useBook` is one value for the whole app, not one per component.** It was
  `useState` inside the hook, which was fine while the switcher and the figures
  were the same screen. On a phone the lens is in the header and the figures are
  in the page, so that would have meant changing the lens and watching nothing
  happen. It is a module-level value with subscribers, read through
  `useSyncExternalStore`. Anything else that becomes a lens rather than a page's
  own state needs the same treatment.
- **A phone gets `FilterBar`, a wide screen gets `Toolbar`.** Both are rendered,
  one is hidden — `Toolbar className="hidden md:flex"` and `FilterBar` is
  `md:hidden`. The controls behind them are shared and take a `variant`, so the
  two cannot drift apart in behaviour, only in size. `hidden` beats a base
  `flex` in Tailwind's generated order, and `md:flex` beats both inside its
  media query; that ordering is load-bearing and worth re-checking rather than
  assuming if the utilities ever change.
- **A row tint cannot reach a sticky column.** `table.pinned` paints an opaque
  fill of its own, so `bg-accent/5` on the `<tr>` stops dead at the first cell.
  `.tint-transfer` in `index.css` is plain unlayered CSS mixing the tint into
  `--surface` — opaque, so it survives being scrolled under, and unlayered, so it
  beats the `bg-surface` utility whatever the source order — and it goes on the
  row *and* on the pinned cell.
- **A section that can be switched off is ABSENT from its catalogue, not hidden
  in it.** "Owed to you" is off unless the `showOwed` flag says otherwise, and
  a merely-hidden section still sits in Customise mode's row of things you could
  add — the same offer made more quietly. Two consequences. `normaliseLayout`
  drops a stored item whose section is not in the catalogue, so the card's
  position is forgotten while it is off and it comes back at the end; and
  `useLayout` re-reads when the catalogue's ID LIST changes (not its identity,
  which is rebuilt every render), because a preference read from `db.meta`
  resolves a frame after the first paint — without that, turning one on did
  nothing until the next reload.
- **`bookTotals` selects rows by ACCOUNT, and `paid-for-household` is the one
  exception.** Selecting by account is what stops a contribution being counted
  into both books; that flow genuinely belongs to two at once, so it is admitted
  to the household book while living outside it. Anything computing spending
  must use `spendsIn(flow, book, accountId, ids)` rather than
  `ids.has(...) && isSpend(...)`, or the categories stop adding up to the total
  above them. This used to be the one thing breaking "the household book is
  identical on both screens" — a row in a private account was invisible to the
  other person. Migration 19 closes it, at the price of a consent per account:
  on an account that does not publish you still get exactly the old asymmetry,
  which is now a state somebody chose rather than the only one on offer.
- **A contribution with one row is not a contribution with two, and `bookTotals`
  can tell.** Under the `all` book contributions are SKIPPED, because there both
  legs are in view and counting either would double-count. That is right only
  while there are two legs. A contribution your partner linked on her own
  device, or one tagged with `contributorId` because she is not using the app at
  all, is a single row — and skipping it silently deleted real income from
  Everything. Hence `contribution-unpaired`, which is an ordinary contribution
  everywhere except there, where it counts as `externalIncome`: not as a
  euphemism, but because that is the only inflow band `spendFlow` draws under
  `all`, so filing it as a contribution would leave the Sankey's left side short
  and conjure a "from what was already there" band to cover the difference. Note
  the `switch` in `bookTotals` has **no exhaustiveness check** — a new `Flow`
  falls through it silently, and `tsc` will not say so.
- **"Who put in what" counts two different acts, and only one of them moves.**
  Money reaches the household by being MOVED into a joint account or by
  something being bought for it straight off a personal card, and
  `contributionSplit` counts both — the second attributed by `created_by`, which
  is the right question there and the wrong one for an arrival in a joint
  account (see the trap below). It used to count only the first, which is why
  the Sankey needed a third band, "Paid from a personal account", sitting beside
  two PEOPLE and answering a different question. Those rows now join their
  payer's band and are broken out in its tooltip via `FlowNode.parts`, which
  `spendFlow` guarantees sum to the band above them.
- **Attribution by far leg is confidently wrong about an orphaned transfer.**
  `contributionSplit` reads "no partner row" as "the other person's", which is
  right for a leg they linked themselves and is also what you get when the
  partner row has been DELETED — `remove()` soft-deletes one row and nothing
  clears the other's `transfer_id`. So deleting a duplicate leg after a
  re-import turns your own contribution into your partner's, on the Sankey, for
  ever. `contributorId` is checked first precisely so an explicit answer never
  has to fight the inference; the tell is Activity showing the bare word
  "Transfer" rather than "Transfer from <account>".
- **A budget is per month, so "the budget" is never a single number.** `useBudgets()`
  returns every month; `useBudgetsForMonth()` returns one. Handing the whole lot to a
  view that assumes one month renders each category once per month it was ever
  budgeted (the home widget did this, and double-counted the totals). Anything
  comparing history against budget must read the budget in force for *that* month —
  `lib/budgetHistory.ts` does this, and fills months with none from the median of
  the months that have one.
- **Linking happens on the server, so the local row does not change yet.**
  `link_bill_payment` and `link_transfer` are RPCs, and nothing writes their
  result back — `billId` and `transferId` stay undefined in the cache until the
  next pull, up to a minute later. So a detector re-run before then proposes the
  same pair again. Every caller drops the row from its own list on the tap and
  calls `syncNow()`; `TransferReview` additionally keeps a ref of what it has
  already linked, or auto mode would sit in a loop of RPCs the server refuses.
- **Applying a category in bulk is the easiest way to make fifty dead letters.**
  At `contribute` you may edit only what you added, and writes fail late and
  quietly. `applyCategory` therefore takes a `canEdit` predicate with no default
  and reports what it skipped, so the screen can say "18 updated, 3 are Sam's"
  rather than silently doing less than the button promised.
- **A name is not a payee, and only one of them is the identity.**
  `transactions.title` (migration 20) is what a row is CALLED; `payee` stays
  exactly as the bank wrote it, because `normalizePayee`, the duplicate check,
  transfer pairing, contributor learning and every rule compare THAT. Display
  goes through `TxnName` — the name, then the reference muted after it — and
  never through either field alone: a list reading `t.payee` shows the bank
  string on a row somebody has named, one reading `t.title` shows nothing on the
  rows nobody has, and one printing both unconditionally says "Tesco Tesco" on
  every row nobody has renamed. `displayName` and `reference` are the two halves
  it is built from, for the places that need a string rather than a node.
  Activity searches both, or a row hides from the word on screen or from the
  string on the statement in your hand.
- **A row added by hand may have no reference at all, and that is the normal
  case.** Nobody types "SQ *THE GOOD FORK 3241" from memory. So the form needs a
  name OR a payee rather than both (`payee` has always been `not null default
  ''` server-side, so this needed no migration), `displayName` has a fallback
  for a row with neither, and `matchKey(t)` — the payee, else the name — is what
  a rule is keyed on when one is learned from an entry with no reference. Such a
  rule can never match an imported bank string, which is correct; it matches the
  next thing typed by hand. Anything grouping rows by payee has to use
  `matchKey` too, or every referenceless row of the month collects into one
  blank group — `topPayees` did exactly that.
- **A statement's amounts carry three facts, not two.** Which columns they are
  in, whether there are one or two of them — and, under a single signed column,
  **which sign means money out**. An Amex export is a bank export with every
  sign the other way round: a purchase is a plus and the payment that clears the
  card is a minus. Read at face value that files every purchase as INCOME and
  the payment as spending, silently, and nothing downstream can recover it —
  the sign is what `classifyFlows`, `bookTotals`, every budget and every chart
  read, and `learnRule` only learns a category from `amountMinor < 0`, so an
  inverted import also teaches the rules nothing while inflating income.
  `ColumnMapping.invert` is that third fact. The headers cannot answer it (both
  kinds of file call the column "Amount"), so `looksInverted` asks the rows: a
  statement is mostly spending, so a signed column that is mostly POSITIVE is a
  card. It runs after step 4, which owns the different case of a column with no
  negative at all, and it is forced false under `split`, where the column a
  value sits in has already said. Being a heuristic that can invert every figure
  in a file, it is always shown as a control with the preview under it — and it
  is remembered by `mappingKey`, so a card is answered once per bank rather than
  once per import. `readMapping` DEFAULTS a missing `invert` rather than
  rejecting the object, or every bank the app had already learned would fall
  back to guessing.
- **An import is a batch nothing records, and it has to be recoverable anyway.**
  There is no batch column and inventing one would be a migration for a fact the
  rows already carry: an imported row has an `importHash`, an account and a
  `createdAt`, and one press of Import writes them all at once. `importBatches`
  groups a run of imported rows on one account whose stamps sit within two
  minutes — derived rather than stored, which is the only reason it works on the
  import somebody has ALREADY regretted, which is the one that matters. Two
  things it must keep doing. A run of one row is never offered, because
  completing a hand-typed entry from a statement writes an `importHash` onto a
  row nobody imported and its stamp is when it was typed, so it sits alone
  looking exactly like an import of one — undoing that would delete something
  real. And moving an import needs the edit right on the destination as well as
  the source: `transactions_update` has the same expression in `using` and
  `with check`, so `moveImport`'s `canEdit` asks `canEditTransaction` twice, or
  the writes come back minutes later as dead letters.

  Where it is offered matters as much as that it exists. The list of past
  imports is in Settings › Accounts, not in the wizard: a list of what you have
  already done is not part of doing the next thing, and putting it on the way IN
  makes the first screen of an import a history page. The one exception is the
  single row on the wizard's LAST screen, which is the import just made — the
  same component, one batch, no list — because a wrong account is noticed a
  second after the press rather than a week later.

  The prevention half is that the account is asked for BEFORE the file and
  starts empty. It used to be a control at the foot of the review, defaulted to
  `accounts[0]` — so an import done without noticing that one select went into
  whichever account happened to be first. An empty control gating the file
  picker cannot be answered by accident, and the account then travels with the
  file in sight on every screen, including inside the label of the button that
  writes the rows.
- **An import keeps the bank's string exactly, and finishes the rows already
  here.** It used to store `prettyPayee(r.payee)`, which title-cases a
  stripped-down copy — throwing away the one string you can look up on your
  bank's website, in the one place it is ever authoritative. Making it readable
  is `title`'s job now. And a statement line matching an entry somebody typed is
  no longer only a duplicate to skip: `ReviewRow.completes` carries the fields
  that row is MISSING (its reference above all, plus the import hash, a name and
  a category where it has none), the wizard offers to fill them in, and ticking
  "import it anyway" turns that off — one purchase is either a new row or the
  old one completed, never both. Only ever empty fields: the statement never
  overwrites something a person typed. `findLikelyDuplicate` matches a
  referenceless row on the amount and the date alone, which is a weaker claim
  and is why it is only ever offered, never applied.
- **A rule is a question about a TRANSACTION now, not about a string.** Since
  migration 21 one may also require an amount (a magnitude, compared against
  `abs(amountMinor)`) or an account, so `categoryRule`/`titleRule` take a
  `RuleTarget` and every caller has to hand over everything it knows — the
  import wizard passes the row's amount and the account being imported into,
  the transaction form passes what has been typed so far. A caller that passes
  the payee alone is not merely less precise: an unsatisfied condition is not
  an absent one, so a rule keyed on £8.99 correctly matches nothing, and the
  effect is that conditions are silently ignored on exactly the rows they were
  written for. Specificity, not length, is what wins now — "tesco, exactly £40"
  beats "tesco petrol" — and `learnRule` follows the same rule when deciding
  WHICH rule a save teaches, or correcting the £8.99 charge would quietly
  rewrite the general rule and leave the specific one saying something nobody
  agreed with.
- **Applying a rule is ONE act, and it was asked twice about two sets.** The
  transaction form offered "rename 9 others" under the name field and "move 9
  others here too" under the category picker — the same act, several fields
  apart, about two overlapping sets of rows, each all-or-nothing. Whether the
  row in front of you happens to need a name, a category or both is not a
  distinction worth two controls. It is one prompt now, over the UNION of
  `similarTo` and `unnamedLike`, and each row gets whatever it is missing when
  the save runs — so a row in both sets is written once, counted once and undone
  in one press. The two queries stay separate underneath, which is what stops a
  category being offered to a transfer leg or a name to nothing.

  Both screens that apply a rule share `TxnSelect`, and the reason is that they
  were answering the same question two ways: Settings showed a list you could
  read and not change, the form showed a count and a tick box. The one bulk
  control worth having beyond all/none is "already filed" — a rule is usually
  taught because a pile of rows landed in the catch-all, and the rows somebody
  filed by hand are exactly the ones to lift out of the selection in one press.
  `isCatchAll` is matched by NAME (`create_household` seeds "Other" and "Other
  income"), because there is no flag on the row and inventing one would be a
  migration for a fact the seed already states — and a household that renames it
  has said it is no longer the bin.

  Where the two screens differ is the DEFAULT, and deliberately. The form
  ticks everything except the rows already filed under something that is not
  the catch-all: the app is offering to touch rows nobody asked it about, and
  quietly refiling a decision somebody made by hand is the one outcome that
  must not be the default. Settings still ticks everything the rule would move,
  because you got there by pressing Apply on that rule — and because "Apply all"
  beside it means exactly that. Conservative where the app initiates,
  literal where the person does.

  A rule's coverage includes the rows already in the right place, so they can be
  ticked; what actually gets WRITTEN excludes them, and the button counts the
  write rather than the selection. A no-op update is a queued write that changes
  nothing, and a button promising more than it does is the same fault
  `applyCategory` takes such care about with rows that are not yours.
- **A tile that opens says so with a shape, not a glyph.** `CategoryPicker`'s
  expandable tiles carried an 11px chevron in the top-right corner: the
  smallest thing on the screen, nowhere near the centred content it belongs to,
  and the only corner furniture in an app whose controls are capsules. It is
  the grabber under a sheet now — a 3px capsule at the foot of the tile, which
  is the one shape in the language that already means "another layer, and it
  comes out downwards", which is exactly where the drawer appears. It retracts
  when the drawer is out. Note the conflict that cost a rebuild: written as
  `opacity-40` plus `opacity-0` when expanded, the bar never went away —
  which of two conflicting utilities wins is Tailwind's generated order, not
  the order they are listed in, so a conditional has to produce ONE value per
  property.
- **A rule now answers two questions, and asking once gets one of them wrong.**
  A rule may carry a category, a name, or both (`rules.category_id` is nullable
  as of 20 — categories are only learned from spending, a name is worth learning
  on income too). So there is no single "the matching rule": `categoryRule` and
  `titleRule` each take the longest match that carries the field being asked
  for. Reading both fields off one lookup lets a title-only rule for
  "tesco petrol" shadow the category rule for "tesco", and the fuel silently
  stops being filed. `coverageOf` asks the category question, so a name-only
  rule covers nothing and offers no bulk apply — applying a rule rewrites
  `category_id` and nothing else. Naming past rows is `applyTitle`, offered
  separately because it is a different set: it includes income and transfer
  legs, which is exactly where a bank string is least readable.
- **A leg whose partner is invisible is a guess nobody may make.** My partner's
  contribution has its far leg in an account I am not on, so until they link it
  my screen counts money out of the joint account as household spending and
  money in as household income. `lib/unexplained.ts` finds those rows — from the
  words the bank used, never from the amount, and never overriding a category
  somebody has set — and the screens say a sentence about them. It reclassifies
  nothing: quietly moving money out of "spending" on the strength of the word
  "TFR" would make the figures wrong in a way nobody could see, which is worse
  than being visibly approximate.
- **Inline editing is gated on `useDesktop()`, not a CSS variant.** What
  changes is behaviour, so it has to be `matchMedia` — over exactly the
  `desktop:` query, wide AND `pointer: fine`. The second half is the point: an
  iPad is wide enough to get the table and has no cursor, so it keeps the sheet.
  Two consequences in `Activity.tsx`: every editable cell must
  `stopPropagation`, or a click edits inline *and* opens the sheet over it; and
  because that leaves no way through, the table carries a narrow hover-revealed
  column whose only job is to open the full form — without it, deletion, notes,
  receipts and transfer linking become unreachable on the machine where they are
  easiest to want. Editors are `absolute` over a `relative` cell rather than
  replacing its content: an input in the flow changes the row height the moment
  its line-height differs by a fraction, and a table that shifts as you mouse
  across it is worse than one you cannot edit.
- **An icon key is permanent.** `icon: 'cart'` lives on rows in the database, so
  a key in `CategoryIcon.tsx` may be ADDED freely and must never be renamed or
  removed — either turns every category using it into the fallback tag, quietly,
  on both devices. `CategoryIcon.test.ts` pins the forty-three the app shipped
  with. Two keys must also never point at the same component: harmless, but a
  picker offering one picture twice looks broken and nobody can tell which they
  chose. And an icon whose Lucide name is a JS global (`Map`, `Infinity`) has to
  be imported under an alias, or it shadows the global for the whole module.

  One group is not Lucide, and it does not work like Lucide.
  `BrandIcons.tsx` is the twenty banks and card networks, and each is a single
  FILLED path — outlines traced from artwork, with the counters knocked out by
  `fill-rule="evenodd"` — where every other icon in the app is `fill: none` and
  a 2px stroke. Three things follow, and the first is silent:

  - **`strokeWidth` must be accepted and ignored.** `CategoryIcon` renders every
    icon as `<Ic size={size} strokeWidth={2} />`, which is right for the two
    hundred Lucide ones and ruinous here: 2px laid around outlines this fine
    closes every counter, and the Amex, the Halifax H and the Visa all become
    solid black rectangles. `Trace` swallows the prop.
  - **The 0.5px `HAIRLINE` is not a border and is tuned, not guessed.** A trace
    carries the weight of whatever it was traced from, and these came out finer
    than the Lucide icons beside them — at 19px, the size `Face` actually
    renders, several read as grey rather than as drawn. Half a pixel of
    `currentColor` around the fill fattens them optically. At 0.7 the counters
    begin to close; by 0.9 the Santander flame is a blob.
  - **Fill and stroke are both `currentColor`**, because `Face` paints the icon
    in the row's palette slot. Nothing here may carry a second colour.

  Their `displayName` is load-bearing — `TERMS` derives the search words from
  it, so it is the only thing that makes "american express" find `amex` — and
  `CategoryIcon.test.ts` asserts every one of them has it. **Judge a new one at
  19px, never at 56**: a contact sheet at 56 flatters everything, and every
  drawing error found here so far was invisible there and obvious at badge size.
  Simple Icons (CC0) is the reference for checking a shape and is deliberately
  not a dependency — it has no Lloyds, Halifax, Bank of Scotland, NatWest, RBS,
  Santander or Nationwide, the whole British high street, and its Visa, Amex and
  Discover are wordmarks. `IconComponent`, not `LucideIcon`, is what the
  registry holds now; both kinds satisfy it and no call site knows which it has.
- **The palette is twelve slots cut at ONE lightness, and the order they are
  OFFERED in is not the order they are stored in.** Slot numbers are on rows in
  the database and cannot move, so `SWATCH_ORDER` is a second list — the wheel
  put back together, warm to cool, six per row — and `SlotPicker` is the only
  thing that reads it. Everything else still counts 1..12. The colours
  themselves are OKLCH at L 0.615 (light) / 0.685 (dark) with hues about 30°
  apart, which is what makes `inkOn` answer "dark" for all twenty-four: a label
  on a fill no longer flips ink between neighbouring tiles, and the worst
  contrast rose from 4.76:1 to 5.17:1. Two things that cost: a swatch now sits
  at 3.4–4.0:1 against the light `--surface` where the old forest green sat at
  5.9, so the selected ring is carrying more of the work; and `--accent` is no
  longer the same value as `--series-1`, because uniform lightness moved slot 1
  lighter than the brand blue. Slot 4 stopped being a second green and became
  the cyan the wheel was missing, which is the one slot that changed family —
  every category already on it repainted. `ink.test.ts` pins the floor rather
  than the values; re-tune a slot and that is what says so.
- **A custom colour is an override laid over a slot, never a replacement for
  one.** `color` (migration 23) is a `#rrggbb` on a category, an account or a
  goal, and `paintOf(slot, color)` is the only thing that should resolve the
  pair — a caller reaching for `slotVar` directly paints the palette colour on a
  row somebody deliberately recoloured. The slot stays REQUIRED underneath for
  two reasons that have both already bitten in other forms:
  `categories_top_level_has_style` demands one, so a row with a colour and no
  slot dead-letters minutes later; and a client that has not learned about the
  column yet still has something to paint with. It is one value for BOTH themes,
  where a slot has a step for each, so a custom colour cannot promise the
  contrast the palette does — which is why the twelve stay the default and the
  thirteenth swatch is the way to it. A colour that does not travel with the
  FIGURE shows on the badge and not in the chart beside it, so `CategorySlice`,
  `FlowNode`, `PayeeTotal` and `HeatmapRow` all carry `color` next to `slot`.
  `SlotPicker` offers it as a disclosure and not a `Popover`: it lives inside a
  `Sheet`, and a popover portals underneath one.

  **That "cannot promise the contrast" is not theoretical, and on an ACCOUNT it
  broke outright.** `Face` derived both halves of a badge from one value — the
  icon in the colour, on a 16% mix of it into the surface — which is legible for
  the twelve, each having a step per theme, and unreadable for a hex, which has
  one value for both. Ask for a bank's own navy and the dark theme gives a dark
  mark on a nearly-black tile. No tuning of the 16% saves it: the fill and the
  mark are the same colour by construction, so in dark mode both are dark, and
  the colours most worth matching — a bank's — are the ones most likely to be
  dark.

  So an account badge is a SOLID tile (`Face fill`), with the mark whichever of
  black or white measures better against it — `faceInk` in `ink.ts`, the same
  question `inkOn` already answers for a name written onto a category's own
  colour. A tile cannot fail that way because it IS a ground rather than a mix
  with one. Four things about it:

  - **Categories keep the tint, deliberately.** A category's colour is there to
    tell it from the eleven others rather than to MATCH something, so in
    practice it is only ever a palette slot, and a list of circles is quieter
    than a list of filled discs. The shapes already say which axis you are
    reading; this says it again in weight.
  - **`accounts.ink` (migration 26) is for what measurement cannot reach**, and
    nothing else: a brand mark in the brand's own colour on a pale tile.
    Measurement says black on white, correctly, and the answer wanted is navy.
    Null is the ordinary case, so every account that existed before 26 got a
    legible mark without anybody opening a form. `InkPicker` measures a chosen
    pair against 3:1 and SAYS so rather than refusing it — their bank's colours,
    on their own screen.
  - **The measurement needs a hex, and `slotVar` is a token.** `paintHex` /
    `tokenHex` in `palette.ts` resolve one off the document, cached per theme,
    and only a HIT is cached: a miss is a renamed token or a read that beat the
    stylesheet, and caching either would make a face permanently and invisibly
    wrong. Undefined off the DOM — the tests run in node — so every caller needs
    a "cannot measure this" behaviour, and for `Face` that is the tint it drew
    before. Quieter than intended, never invisible. Deliberately NOT a table of
    inks beside the palette: that is `ink.ts`'s own opening argument, two themes
    of exceptions going stale the first time a slot is re-tuned.
  - **A free background introduces exactly one new failure**, and it is handled:
    a tile the colour of the card it sits on has no edge, so a white badge on
    the light theme is an icon floating in a row. `needsRing` measures it rather
    than special-casing white — the dark theme's near-black is the same problem
    from the other end — and the threshold is low on purpose, because a ring on
    a merely pale tile is visible as a ring.

  The picker gets the same treatment and for a sharper reason: `IconPicker`
  takes `fill`/`ink` from the account form, because without it the SELECTED cell
  kept the tint — so on the one screen where you are choosing, the navy icon you
  had just picked was the one you could not see. A preview wrong in the same way
  the old badge was is worse than no preview.

- **A control that seeds itself from its own value can seed itself dead.** The
  thirteenth swatch in `InkPicker` opens a disclosure conditioned on `custom` —
  the ink being neither of the two swatches beside it — and it committed the
  DRAFT, which is seeded from the ink the form opened with. So on an account
  already saved with White or Black the draft was that same value, committing it
  changed nothing, `custom` stayed false, and the button did nothing at all,
  however many times it was pressed. Nothing errored and nothing looked
  disabled; it was simply inert, on the one control in the row painted with a
  fixed `text-ink-3` grey over the account's own tile, which is what it got
  reported as ("greyed out"). `customInkSeed` is the invariant stated instead —
  whatever it is handed, what comes back is custom — and `IconPicker.test.ts`
  pins it.
- **A tick or a pipette on a swatch is measured too.** Both were a hardcoded
  white with a drop-shadow behind them, which the palette itself disagrees with:
  the twelve are cut at one lightness, so `inkOn` answers DARK for all
  twenty-four, and the shadow was propping up the losing choice. On the
  thirteenth swatch, where the colour is whatever somebody typed, it fails
  outright — choose a pale brand cream and the tick saying which swatch you had
  chosen is the one thing in the row you cannot see. `markOn` in
  `IconPicker.tsx` asks `inkOn`, and keeps white-and-a-shadow only for the case
  `paintHex` cannot measure at all.
- **Accounts have a `sortOrder` and until now nothing ever wrote one.** Every
  account was created at 0, so the list fell back to Dexie's tie-break — primary
  key order over client-generated uuids, the `toArray()[0]` trap applied to a
  whole screen. `byOrder` breaks the remaining ties by NAME so a household that
  has never dragged anything reads alphabetically, and `AccountList` is the
  category drag with the depth taken out. The gate is the part worth knowing: a
  move renumbers every row it passes (there is no spare numbering to slot into
  when everything is 0), and `sortOrder` is an ordinary column, so a reorder is
  `accounts_update` on ALL of them. One account you hold below `manage` is
  therefore enough to make the whole list unwritable — the handles are absent
  and a line says why, rather than the drag queueing writes that dead-letter a
  minute later.
- **A goal wears the same face as a category, and now gets to choose it.**
  `goals.slot` and `goals.icon` have existed since the table did and the cards
  have always painted them, but the form offered the first twenty-four keys of
  the registry and no colour at all, hard-coding `slot: 9` at the point of
  saving — so every pot in a household was the same blue, and after the icon set
  grew to two hundred those twenty-four were simply "Money and Home". It is
  `SlotPicker` + `IconPicker` now, the same two controls the category and
  account forms use, and a new goal takes `nextFreeSlot` over the goals that
  already exist so pots are distinct from each other rather than from
  categories.

- **An account's colour and icon are derived when unset.** `accountFace` maps
  `kind` to a slot and an icon key, so the Activity table reads properly before
  anybody opens a form and nothing has to be backfilled. Read `accountFace(a)`,
  never `a.slot` — a raw read is `undefined` on the common case and paints the
  badge grey, which is the state the feature exists to remove. The badge is a
  rounded SQUARE where a category is a circle: they share rows, and the shape
  says which axis you are reading before the colour says which one.
- **Everything inside a `<label>` is part of the control's name.** Which is why
  the ⓘ on a `Field` is positioned back onto the heading line from OUTSIDE the
  label rather than nested into it: a descendant button contributes its
  accessible name to the label's, so a nested one renames the field to "Role
  What does this mean?", and an open paragraph appends itself to that. `Field`
  keeps its `<label>` wrapping the control because it never sees the child's id
  and implicit association is the only one available; `CheckRow` has the same
  split for the same reason, and there the `<label>` holds the box and the title
  only. The explanation and the ⓘ are always siblings of it, never children.
- **A `Popover` cannot open from inside a `Sheet`.** The panel portals at `z-40`
  and a sheet is `z-50`, so it opens *behind* the form it belongs to. Anything
  that has to reveal something from inside a sheet is a disclosure that pushes
  content in below — which costs nothing, because `useMorphHeight` is already
  animating the sheet's body between the shapes its contents take. `InfoBody`
  in `ui.tsx` is that, and `CheckRow`/`Field`'s `info` prop is the way to reach
  it: a hint that needs a comma is an `info`, and `status` (a `CheckRow`'s one
  short line) is for what is TRUE right now rather than what the setting means.
  `useInfoNote` is the same ⓘ for a row neither control builds — a heading with
  a button on its line and the paragraph underneath — and it is what the import
  wizard's steps and the Settings automation rows use. **Nothing on a screen may
  be more than a heading and one line of prose**; anything longer goes behind
  one of these, wherever it is.

  It takes a GROUND, and there are exactly two. `.panel-month` defines its own
  ink, so the default `text-ink-3` toggle and paragraph — ink for a surface —
  are an unreadable grey on a saturated panel. Both month panels pass `'panel'`.
  A caller choosing its own colour would be a third ground and is why this is an
  enum rather than a className.
- **Two categories of the same colour is the ORDINARY case.** Twelve slots, no
  limit on categories, and a subcategory inherits its parent's slot on purpose —
  so a donut routinely holds two identical arcs, and drilling in is where it
  bites hardest. `lib/shade.ts` pulls them apart in lightness only; moving the
  hue would make a green look like some other category's colour, which is worse
  than two greens. The FIRST user of a slot always keeps the palette colour
  exactly, and the shift is per-chart, never stored. Its ladder deliberately
  never leaves the legible range rather than clamping into it: a clamp hands two
  shades the same lightness the moment the fan reaches an edge, which is the
  collision the file exists to remove.
- **The donut animates from OUTSIDE Recharts.** `isAnimationActive={false}`
  stays — Recharts 3.x leaves a *padded* pie frozen at frame one of its own
  entrance animation, so turning it on makes the ring never appear.
  `useSweep` drives `startAngle`/`endAngle` (and scales `paddingAngle`, or the
  gaps are wider than the arcs for the first few frames). Its `setTimeout` is
  not a tidy-up but the guarantee: a backgrounded tab never runs the rAF
  callback, so the ring would otherwise be stranded part-drawn.
- **A route is learned, never stored.** `routes.ts` summarises the transfers
  you have already confirmed — three or more between the same two accounts, at
  a cadence it has a word for — and that summary is the only thing that can
  resolve the ambiguity `bookSafe` cannot: two outgoing legs and one arrival,
  where the leg left behind is stranded as personal *spending*. There is no
  table and there must not be, because a route is a second reading of rows that
  already exist; unlinking a transfer un-teaches the habit, which is the
  behaviour you would otherwise have to build. A route never posts anything: a
  bill records money that has not moved, a route only recognises money that
  has, and `nextOn` is a sentence rather than a row.
- **A row of figures divided by hairlines is a strip that only works while
  every figure fits.** The month panel's desktop layout was `flex flex-nowrap`
  with a `border-l` between each `Stat`, and the card can carry seven —
  spending, income, to the household, to savings, the leftover, what is left,
  the budget. Every one is `truncate`, so at one column on a laptop it shipped
  reading "£4,0…" and "+£10,…": two figures rendered as ellipsis, which is the
  exact fault the phone layout above it has a paragraph about. The rules went
  rather than the figures, because a `border-l` cannot survive wrapping — the
  first cell of the second row wears a divider with nothing to its left — so it
  is an auto-fit grid separated by whitespace, which is what the phone layout
  always did. Same rule for the balance variants' tiles, which are narrower
  still because they carry padding of their own: two per row on a phone
  whatever the count, and an odd one out takes the full row.
- **A faded bar already means something, so nothing else may fade one.** Every
  chart draws an unfinished month at 45%, and it says so in words. A gradient
  hinting that a scrolling chart has more to the left washes out the bar under
  it in exactly the same way — on a phone it ate a whole bar, which then read as
  a month that had barely started. `MonthScroller` therefore has no edge fade at
  all; the scrollbar and a caption carry the hint instead.

  The blocks view found the same rule from the other end. Its first version put a
  22% wash under each label to lift the text off the fill, and at eight blocks
  the card read as eight categories each fading towards their own foot — a
  partial-month gradient, eight times, meaning nothing. There is no wash now and
  none is needed: `lib/ink.ts` picks the ink per fill by measured contrast, both
  lines are that ink at full strength, and the hierarchy is weight. **Nothing may
  ramp the opacity of a category's own colour.**
- **Ink on a fill is measured, not looked up.** Writing a category's name onto
  its own colour is the one place in the app where the ground under a label
  differs per label, and the intuition — "white text on the colour" — is wrong
  more often than right. The twelve are cut at one lightness now, so the answer
  is currently "dark" on all twenty-four; that is a PROPERTY of this palette
  rather than a fact about fills, and the old one split 8/12 in the light theme
  and 11/12 in the dark, with a different slot flipping in each. So a table
  beside the palette would be two themes of exceptions and would go stale the
  first time a slot moved, it could not cover `shade.ts` at all — which invents
  lightnesses that were never in the palette — and it could not cover a custom
  colour, which is an arbitrary hex nobody reviewed. `useChartColors` has
  already resolved the tokens to hex, so `inkOn` computes it. What that buys is
  pinned in `ink.test.ts`: every palette colour and every shaded variant clears
  AA — worst cases 5.17:1 and 4.73:1 — which is what makes a bare label on a
  bare fill legitimate. Re-tune a slot and that test is what says so.
- **The blocks view has to be measured before it can be laid out**, and the
  effect that measures it must depend on the thing it measures. A treemap
  squarifies against the box's ASPECT RATIO, so `CategoryMosaic` cannot work in
  percentages — it reads `clientWidth` and lays out in pixels. The box does not
  exist until there are slices, and on a cold start `bookSlices` is empty for the
  first frames while the cache opens, so an effect keyed on `[]` fires once
  against a null ref, is never scheduled again, and the card is silently blank
  for ever: `squarify` keeps returning zero-size tiles and every block returns
  null. It is keyed on `[drawn]` for that reason — the same shape as
  `useMorphHeight` and `Sheet`'s focus effect, and verified by breaking it on
  purpose, which renders nothing at all.
- **`minBand`'s trade is refused here.** The Sankey floors a small band so it
  stays hoverable and pays for it by no longer summing to the total above it.
  `squarify` has no floor: every tile's area is its exact share. The tail is
  handled where it belongs instead — `bookSlices` already folds everything past
  the top N into "Other" — and a block too narrow to READ (52px, about five
  characters) drops to a chip under the picture with its whole name and figure on
  one line. So "label what can be read" rather than "label what fits", and no
  arithmetic is bent to make a label fit.
- **The month panel is the app's one painted surface, and it beats `Card` from
  outside the layers.** `.panel-month` is plain unlayered CSS because it has to
  win against `bg-surface` AND against `ring-1 ring-hairline` — Tailwind
  implements a ring as a `box-shadow`, so a hairline would draw a pale rim across
  a saturated panel and no tinted shadow could coexist with it. `ring-0` is not
  the fix: both spellings compile to the same custom properties and which wins is
  Tailwind's generated order, not the order they are written in. Same reason
  `.tint-transfer` is written this way.

  Three things about it that are load-bearing. Its stops are DEEPENED from
  `--series-1/-5/-10` rather than being them, because the panel's quietest text
  is white at 82% and that measures 3.4:1 on `--accent` — the deepened three
  measure 4.9, 7.9 and 7.4. Every colour on it comes from a `--panel-*` token
  defined per theme, so nothing on the panel may reach for `text-ink-3`,
  `divide-hairline` or `--accent-ink`: those are ink for a surface, and this is
  not one. And the over-budget state is the PANEL's colour, not the figure's —
  green and red on a dark blue are the two figures that most need reading made
  hardest to read, so `Stat` has no tone at all and the words "left" and "over"
  carry it, which also survives being colour-blind.

  It is not always at the top, either: every card on this page can be dragged,
  narrowed to one column, made two units tall or switched off, so the panel has
  to read as itself in the middle column of a grid, half way down the page.
- **A `divide-*` utility sets only the width.** The colour falls back to the
  child's `currentColor` — which on the month panel is full-strength white, about
  four times too strong for a hairline. The desktop stat strip states its own
  `border-l` and `borderColor` per figure instead.
- **A drill is answered twice, and which one depends on what you'll do next.**
  Reading the rows behind a figure is usually a glance — is that £412 one thing
  or forty? — so the default is a SHEET over the chart, which leaves the page
  underneath exactly as it was: same month, same period, same scroll, same
  drilled-into category, nothing to restore on the way back. The moment the
  answer becomes "and one of these is filed wrong", the button inside that sheet
  opens Activity prefiltered, because that is the page that edits rows in place,
  links transfers and attaches receipts, and a modal rebuilding any of it would
  be a weaker copy that drifts. So a drill is a description rather than a
  destination: `matchesDrill` filters rows for the sheet, `drillTo` spells the
  same thing as a URL, and Activity's own month/range/payee filters go through
  `matchesDrill` too — otherwise one figure would be explained by two different
  lists depending on how you asked.
- **A chart's way through to its rows depends on the pointer.** Every figure is
  a claim about a set of transactions, and the answer to "which ones" lives in
  `lib/drill.ts`, the only place that spells one.
  The awkward half is WHERE the target is. On a mouse the click is spare, since
  hover already shows the tooltip, so the bar or the arc or the band is the
  target. On a finger the tap is spoken for — it is what opens the tooltip — so
  a tap that also navigated would mean the panel could never be read; there the
  way through is a button inside the panel, which the linger keeps up long
  enough to press. Hence `useTouchTooltip.coarse`, and hence the button appears
  only once a finger has actually been used.
- **Recharts 3 hands a click an INDEX, not a payload.** `onClick` on a chart
  receives `MouseHandlerDataParam` — `activeIndex`, `activeLabel`, a coordinate
  — and not version 2's `activePayload` array. Reading the old shape off an
  `unknown` compiles perfectly and silently never fires, which is how the
  month-bar drill shipped dead the first time. `monthAt` resolves the index
  against the data it was given, and falls back to the label.
- **A prop that appears on the first touch can cost you the tooltip.** The
  obvious spelling of "click only on a mouse" is `onClick={coarse ? undefined :
  handler}` — but the first touch is also what SETS `coarse`, so the pie's props
  changed mid-gesture, Recharts rebuilt its sectors, and the synthesised mouse
  event that would have opened the panel landed on a node no longer in the
  document. The ring became the one chart a finger could not read. Keep the
  props constant and let the handler ask.
- **The way back has to carry the state of the page it came from.** A bare
  `/reports` is a different page with the same address: it opens on this month,
  as charts, at the top level. So a drill's `backTo` is built with
  `pathWithState`, and Reports reads those params once on arrival and clears
  them — the same discipline Activity applies to the drill itself, and for the
  same reason: a param nobody can see must not go on overriding a control
  somebody then uses.
- **A section's options are a second axis, not more variants.** `variants` is
  what KIND of picture (a ring, bars, a line); `options` is everything else
  (how many categories, how many months, figures or colour alone). They are
  separate because they compose — folding them into one list would make six
  entries that have to be read as a grid — and they share one control in the
  card's heading, because a heading has room for a word rather than a row of
  chips. Anything that changes what is COMPUTED rather than how it is drawn has
  to be read at page level (`sectionOption` in Reports) rather than inside the
  render, because the aggregates are page-level memos the table view shares.
- **An installed app on iOS is RESTORED, not launched, so it never updates
  itself.** Reopening it resumes the same page with the same JavaScript and no
  navigation, so the service worker's update check — which runs at registration,
  i.e. on page load — never runs again, and the app can sit several deploys
  behind. Force-quitting it repeatedly is the folk remedy and works only by
  accident, when one of those launches happens to be a cold start. `lib/updates.ts`
  checks on `visibilitychange`, `focus`, `pageshow` and `online` instead
  (throttled to a minute, with a half-hourly heartbeat) — four, because no one of
  them fires on every platform and version, and `pageshow` is the one a PWA
  restored from the page cache emits when it was never marked hidden on the way
  out. The throttle is what makes the overlap free. Verified end to end rather
  than reasoned about: deploy while the page stays open, fire a
  background/foreground pair, and a waiting worker appears within half a second.
  `registerType` is `prompt`, not `autoUpdate`, for a second reason — `autoUpdate`
  reloads the page the moment the new worker activates, and in an installed app
  that lands in the middle of typing a transaction. The outbox survives a reload;
  a half-filled form does not.

  **A check in flight must never become a latch.** `inFlight` exists so that
  three listeners firing on one resume are one check — and joining a run that
  will never finish is the feature quietly dying. A `fetch` has no timeout of
  its own, and on iOS one issued as the app goes into the background can hang
  rather than fail, so the pending promise was returned to every later caller
  for ever: every press of Check for updates did nothing at all, and closing the
  app did not clear it, because an installed app is RESTORED rather than
  launched — same page, same module state, same pending promise. Three parts to
  the fix and all three are needed: the stamp fetch is aborted after
  `STAMP_TIMEOUT_MS` and `registration.update()` is raced against a timeout of
  its own (both are network calls with the same way of never coming back); a run
  is joined only while it is plausibly still running (`STUCK_MS`), and abandoned
  after that; and every write goes through a `runToken`, so a straggler that
  finally answers cannot land a verdict about a moment that has passed over a
  newer check's. A hung run's `checking` is disowned with it — the button is
  disabled while that is on screen, so a status left behind by a dead run is a
  control nobody can press.

  **Four ways a check could mislead rather than fail**, all now pinned by
  `updates.test.ts` — which fails against each of them, since a test for this is
  worthless if it only asserts the happy path:
  - **A waiting worker is answered from FIRST, before the network.** A
    downloaded update needs no confirming, and asking anyway meant that offline,
    with a new version in hand, the app said "could not reach the server" about
    it. It also covers a worker that reached `waiting` while the page was
    backgrounded, where `onNeedRefresh` may never be delivered.
  - **A failed check does not spend the throttle.** It learned nothing, so the
    next resume retries in seconds rather than being refused for a minute — the
    commonest failure by far is a resume that beats the radio back.
  - **Overlapping checks are one check.** Three of those listeners can fire in
    the same millisecond, and two runs would interleave their writes: one
    setting `current` while the other is mid-catch-up and about to put
    `checking` back over it.
  - **The catch-up loop waits a tick before its first verdict.**
    `registration.update()` resolving means the job finished, not that
    `installing` is readable yet, so an eager first look at a worker arriving
    perfectly normally saw neither `installing` nor `waiting` and called the
    build `stale` — sending the reader to the heavy unregister-and-reload path
    for no reason.

  The version card lives at the bottom of the Settings INDEX only. It used to be
  on all six group screens as well, on the reasoning that each is the bottom of
  a phone's navigation — but six copies of "which version is this" is one answer
  asked six times, and a Check for updates button under a list of categories
  reads as being about categories.
  Activity's filters are `useSticky`/`useStickyIds` (session-scoped, per tab —
  a preference belongs in `settings`, but a filter is a question you are in the
  middle of asking and one asked last Tuesday must not still be hiding rows).
  The catch is that `useEffect(…, [book])` fires on MOUNT as well as on change,
  so "an account filter written under one book means nothing under another" was
  quietly clearing the filter every time the page opened. It compares against a
  ref of the previous book instead. Any new reset-on-change effect needs the
  same treatment.
- **`null` and an empty set are different filters and must read differently.**
  `null` is "all of them, including any added later"; an empty set is "none",
  which is what unticking "All categories" now means — that toggle is the only
  way to reach ONE category without unticking eleven. So `toggle` no longer
  folds empty back to `null` (it still folds a full set, so a category invented
  next week is included), and `catLabel` says "No categories" rather than
  inheriting the "every category" wording, which would have left the control
  claiming everything over an empty list.
- **A tooltip inside a scrolling chart is wrong twice over.** It lives in
  `.recharts-wrapper`, which is inside `overflow-x: auto` — a box that clips on
  BOTH axes, so anything outside the visible window is cut off and reads as the
  tooltip sliding under the pinned value axis. And Recharts places it against
  the chart's viewBox, which for a windowed chart is all twelve months rather
  than the six on screen, so it flips away from edges nobody can see. Both
  charts and the Sankey therefore position their own: `MonthScroller` portals
  the Recharts tooltip into a layer over the card (`Tooltip portal=` — note
  `TooltipBoundingBox` then applies NO positioning of its own, so the whole job
  comes with the whole control), and places it from `clientX/clientY` against
  the card's rect, never `offsetX`, which is measured inside a box that scrolls.
  Placement must also re-run from a `ResizeObserver`: the panel does not exist
  on the pointer move that first activates it, so that placement measures a
  width of zero, cannot tell there is no room to the right, and the pointer may
  never move again to correct it. The same measurement decides which SIDE of the
  pointer the Sankey's panel goes: a wrapped name makes it tall enough to run
  off the top of the card, so it flips underneath where there is no room above.
- **A tapped tooltip has no BEGINNING either, and that is the half that was
  missing.** The panel opened on `pointerdown`, and every chart in the app sits
  inside a scrolling page — so every flick that happened to start on a chart
  opened a tooltip, and you arrived somewhere else with a panel sitting over a
  chart you had scrolled past. A touch is not a tooltip until it has proved it
  is not a scroll: hold still for `TIP_HOLD_MS`, or lift again without having
  travelled `TIP_SLOP`. Either arms it; moving first kills the gesture for good,
  and so does the `pointercancel` the browser sends when it takes the touch to
  scroll with — once dead, always dead, which is what stops the END of a flick
  opening one. A mouse is armed from the start, and re-arms on a bare
  `pointermove`, because a touchscreen laptop can flick with a finger and then
  hover with the trackpad. `useTouchTooltip.armed` is the flag, and a chart that
  tracks what is under the pointer ITSELF rather than letting Recharts do it has
  to gate on it — `Sankey` keeps following the finger and simply draws nothing,
  or a press that turns out to be a hold would have nothing to show.
- **A tapped tooltip has no ending, because nothing ever leaves.** Every chart
  here was written against hover, and a hover ends by itself; a tap opens a
  panel that then sits over the chart until something unrelated closes it.
  `useTouchTooltip` gives the gesture the ending it lacks — the panel stays
  while the finger is down, and a few seconds after it lifts it fades — and
  **every chart has to be wired to it, or it has the old fault and nobody will
  read it as a missing hook.** The five in `insights.tsx` were not, for a while:
  a panel opened by a tap on the waterfall, the salary stack, committed-vs-chosen,
  share-kept or the pace line simply stayed. It was reported as an iPad bug and
  was nothing of the sort — every touch device had it, the iPad is just where
  those charts are big enough to press by accident. Wiring one up is three
  lines: `useTouchTooltip()`, spread `handlers` on the box the chart is drawn
  in, and pass `active={tip.active}` to `<Tooltip>` (plus `fading` to the panel,
  so it leaves the way the others do) — and
  every chart shares it, so the same press means the same thing everywhere.
  Two halves are easy to get wrong. Hiding it means `<Tooltip active={false}>`
  rather than a `content` that returns null: the CURSOR (the band highlight
  under the bar) is drawn by Recharts from the same active state, so a panel
  hidden by its own content leaves the highlight stranded on the chart. And
  what makes it gone must be a TIMER, never the fade finishing — a backgrounded
  tab runs no transitions, so a panel removed by its own `transitionend` comes
  back half-drawn over the chart. Note also that a finger emits `pointerleave`
  the moment it lifts, so a `pointerleave` that closes the panel has to check
  `pointerType`, or the linger is over before it starts.
- **A label drawn `pointer-events-none` is the thing you would reach for.** The
  Sankey's names are, so that a label cannot steal the hover from the band it
  belongs to — which left a name shortened to eighteen characters as the one
  part of the diagram that answered nothing when pressed. Each band claims its
  whole row instead, label strip included, as a transparent `rect` drawn last:
  out to the halfway line between it and its neighbour, which is also what
  makes a 3px band tappable without swallowing the band above it. That halving
  is why `padding` is passed to `layoutFlow` explicitly rather than left to its
  default — the hit areas divide a gap they have to know the size of.
- **A scrolling chart's axis is drawn by hand, not by a second chart.** Two
  Recharts charts agree about where their plot areas are only by accident, and
  the accident stops holding the first time a margin changes. `ValueAxis` is
  plain DOM sharing `niceScale` and the plot constants with the chart beside it,
  whose own `YAxis` is `hide` — present so the grid and the scale still exist,
  invisible because the axis outside has drawn it. `XAxis` carries an explicit
  `height` for the same reason: a default that shifted by a pixel would put
  every figure a pixel off its line, on every chart at once. The scroller also
  needs `pb-2`, because a scrollbar is painted in the bottom of the PADDING box
  and without it a thin one strikes through the month labels.
- **Document order is not reading order in a dense grid.** `grid-auto-flow:
  dense` pulls a narrow card back into a hole an earlier wide one could not
  fill, so a card can be drawn above one it follows in the array — the same
  hazard masonry had, from the other direction. `Arrange` carries
  the visible-list index on every measured box rather than implying it from the
  array, and drops boxes of zero size — a section whose data has nothing to show
  renders empty and is hidden, and a zero box at the origin would otherwise win
  "nearest centre" from the far corner of the page.
- **A card ends where the tallest card beside it ends, and the slack goes to the
  picture.** Two sections sharing a row used to leave a hole in the page down to
  the next full-width card — visibly so on Reports, where two charts of unequal
  height sit under a full-width breakdown. Every card is stretched to its grid
  area now and `Arrange` passes `h-full` all the way down so the card itself is a
  flex column — a height nobody hands on is a card floating at the top of a hole
  rather than one that filled it. `Fill` in `ui.tsx` is what a chart uses to
  spend the space.

  **Which card gets the slack was reversed by the grid, deliberately.** Under
  masonry only a card that could SPEND the height was stretched (`data-fill`);
  everything else kept its own and left the slack at the foot of its column,
  where nothing was drawn and nobody saw it — stretching those moved the hole
  INSIDE the card, where three inches of nothing under a list of payees reads as
  a fault rather than as spacing. In a grid the slack has nowhere to go: a row
  is as tall as its tallest card, so a card left at its own height leaves a gap
  between itself and the card below it, in the middle of the page. Whitespace
  inside a card reads as a card; whitespace between them reads as a fault. So
  everything stretches, and `Fill` still does the work wherever there is
  something in the card that can grow. The Sankey earns its stretch by taking a `height`
  and flooring it at `sankeyHeight(graph)` — bands get thicker, labels stay put.
  Three more things are load-bearing. The stretch cannot disturb the
  balancing it is measured from: after it every column is exactly the tallest
  column's height, so re-running the distribution over the grown heights is a
  fixed point rather than a loop. `Fill` settles the same way rather than
  measuring, because there is nothing stable to measure — the height offered
  depends on the card's height, which depends on the height the chart took — so
  it subtracts the child's own overhead (a legend, a row of chips: whatever it
  came out taller than the number it was given) and lands on the right height in
  one pass, in both directions. And it has a ceiling as well as a floor: `min` is
  what the chart would have been alone and it is never squeezed below it, `max`
  stops "fill the space" next to something very tall from drawing a bar chart
  half a screen high — past it the card keeps the remainder as white space, which
  is the lesser fault.
- **A card has two sizes now, and only one of them is a number of columns.**
  `span` is 1..`MAX_SPAN` or `'full'` (which means "this screen's column count",
  so it stays full when the window changes); `rows` is 1..`MAX_HEIGHT` units of
  `ROW_UNIT`, and the row track is `minmax(ROW_UNIT, auto)` — a floor, so a card
  taller than the height it asked for grows its row rather than being cut off.
  Three things follow. `effectiveHeight` is 1 on a phone whatever was stored: one
  column is a stack read card after card, where a height is not a comparison with
  anything, only a hole in the bottom of a card. `nextSpan` is a NO-OP on one
  column for the sharper version of the same point — the value is shared with
  every other screen the household signs in on, so cycling it on a phone would
  quietly rewrite the arrangement made on the laptop. And a drag that reaches the
  last column stores `'full'` rather than that number, which is the whole
  difference between "as wide as the page" and "as wide as the page happened to
  be that day".
- **The two handles are told apart by where you take hold, and nothing else on
  the card starts either gesture.** The grabber at the top centre moves a card,
  the corner at the bottom right resizes it, both only in Customise mode. The
  card itself was the drag handle for one release, on the reasoning that a
  grabber is permanent furniture in service of an occasional act — what that
  produced was a page where every press moved something: no way to touch a card
  to steady it, no way to change your mind half way through, and on a phone no
  way to scroll the page at all without catching a card. Three things that bite.
  The grabber is a `<button>`, so `down()` tests for `[data-drag-handle]` FIRST
  and ignores everything else. A press and a drag on the corner are the same
  pointer sequence, so the corner's click handler (which cycles the width) has
  to refuse a click that followed a drag, or every resize ends one step past
  where it was let go. And the corner's move and up listeners are on `window`,
  not on the handle: the card re-renders on every step of a resize, and an
  earlier version rendered the handles only while nothing was being resized — so
  the handle unmounted on the first frame of the gesture, took the pointer
  capture with it, and the corner behaved exactly like a button that changed the
  size once.
- **Nothing inside a card is live while the page is being arranged.** The
  card's whole subtree is `inert` in Customise mode. A chart that answers a
  hover with a tooltip, or a tap by drilling into the rows behind it, is a card
  behaving like a card at the moment you are treating it as a tile — you reach
  for the corner, a tooltip opens under your finger, and a press that misses the
  handle navigates to Activity. `inert` is hit testing, the tab order and the
  accessibility tree in one word; `pointer-events-none` would leave the card
  focusable and still readable as a chart.
- **A resize is measured RELATIVELY, from where the gesture began.** The obvious
  reading — pointer position less the card's own top-left corner, over one grid
  step — is wrong because a row track grows to fit a card taller than the height
  it asked for: a one-unit card is routinely two units tall, so an absolute
  reading jumps it to three the instant the handle is touched, before the
  pointer has moved at all. The size asked for is the size it started at plus
  the steps travelled. The step itself is read off the live grid
  (`getComputedStyle`'s `columnGap`/`rowGap` resolve to pixels), never stated as
  a constant, because the gap is a Tailwind class the page passes in.
- **A wrapper cannot see that its child rendered nothing.** Widgets return null
  all the time (no accounts, no bills due), and `:empty` on the wrapper never
  matches because the wrapper always holds the inner box — and, while arranging,
  the controls. `[&:has(>div:empty)]:hidden` asks about the inner box instead,
  which is what stops Customise mode drawing a dashed outline around a void.
- **The Sankey's hub is as tall as the busier side, not as tall as the money.**
  Every band has a `minBand` floor so a small one stays visible and hoverable,
  so a side with eleven bands carries slightly more than the money alone. A hub
  sized to `total * scale` is then met by a stack that overhangs it, which looks
  like an arithmetic error. Sizing it to the thicker side and centring the
  thinner one inside keeps every ribbon exactly as thick at the hub as at its own
  end — which is the only claim the diagram makes.
- **`[]` from a cache that has not opened is not the same claim as `[]` from
  one that has.** Every hook in `cache.ts` hands back `[]` while IndexedDB is
  still opening, which is right for anything counting rows and wrong for
  anything concluding something from their absence: for the first frames of a
  cold start, Budgets said "No expense categories yet" and Rules said "Nothing
  learned yet" to people with a full history. `useAllTransactions` already
  returned `undefined` for its own table for exactly this reason;
  `useCacheReady()` is that signal for the rest, so an empty STATE can wait
  without thirty call sites having to handle `undefined`. It deliberately does
  not wait for a pull — a device offline since yesterday has a perfectly good
  cache, and a new household really does have no categories.
- **A query that only ever looks a few days out must say so to Dexie.** The
  duplicate check reads ±3 days and transfer pairing ±10, and both used to load
  every transaction ever recorded and discard almost all of it — on the save
  path, between the press and the sheet closing. `dateWindow` plus the `date`
  index makes them range queries; an ISO date sorts lexicographically in date
  order, which is what makes `between` on a string index mean what it looks
  like. `DUPLICATE_DAYS`/`PAIR_DAYS` are named next to the queries because a
  window narrower than the matcher's own rule silently stops finding pairs the
  rule still accepts, and nothing fails loudly. Narrowing the input does narrow
  what `findTransferCandidates` can see of the AMBIGUITY around a pair, which is
  why only the manual picker uses a window: it offers the readings and lets you
  choose, where auto-linking must weigh them and still works from the full set.
  The one query that genuinely needs all of history — "and the other eleven from
  this payee", which is fuzzy and so unindexable — is debounced instead, because
  keyed on `payee` it re-read the table on every letter of "Sainsbury's".
- **A segmented control is a radio group, not a tablist.** `Segmented` announced
  "tab 2 of 3" and then did nothing on an arrow key: there are no tab panels
  here and never were — every use of it picks a VALUE. It is `radiogroup` /
  `radio` / `aria-checked` with roving `tabIndex` and arrow keys that move the
  selection (a radio group's arrow key chooses rather than merely pointing).
  Note the measuring effect selects on `[role="radio"]`; changing the role again
  means changing it in two places or the sliding thumb stops finding its target.
- **A recovery link signs you in, which is why it needs a screen.** Supabase's
  password reset lands the device in a real session, so without
  `SyncState.recovering` and the `PASSWORD_RECOVERY` branch in
  `onAuthStateChange` the flow ends with somebody looking at their own
  dashboard, still not knowing their password and with nothing offering to set
  one. `AuthGate` checks it before `ready` and before the household, since every
  other branch would happily show them the app. The reset form's confirmation is
  the same whether or not the address is known — anything else turns it into a
  way of asking which of your friends uses Hearth.
- **There is exactly one `<form>` per sheet, and every other button says
  `type="button"`.** There was no form anywhere for a long time, so Enter did
  nothing in any sheet — while the desktop table's inline editors, over the same
  rows, committed on it. `Sheet` takes an `onSubmit` and wraps its scroller AND
  its footer in a real form (the footer is where the primary action lives, so a
  form around the body alone would not contain it). The cost is the trap that
  comes with it: inside a form a button with no `type` submits, so "Delete"
  beside "Save changes" would have saved the row it was about to remove.
  `Button` therefore defaults to `type="button"` and every raw `<button>` in the
  codebase carries one explicitly — the primary action is the one thing that
  opts in with `type="submit"`, and it must NOT also carry an `onClick`, or
  every press runs the save twice. The form wrapper is `min-h-0`, or a tall
  sheet grows past the screen instead of scrolling: the scroller inside can
  shrink only because `overflow-y: auto` zeroes its automatic minimum size, and
  an ordinary flex item between it and `max-h-full` puts that minimum back.
- **A sheet is a layer, not a place in the tree.** Every `Sheet` portals into
  its own host under `<body>` and pushes it onto one module-level stack
  (`layerStack` in `ui.tsx`), which is what makes three things statable at all:
  `#root` goes `inert` while anything is open (the tab order, hit testing and
  the accessibility tree all at once, which is what a hand-written focus trap is
  approximating), a lower sheet goes `inert` under the confirmation raised from
  inside it, and the scroll lock belongs to the STACK — held per sheet, closing
  a confirmation over a form released it while the form was still open. The
  portal also fixes a latent bug rather than only enabling this: `position:
  fixed` is measured against the nearest transformed ancestor, so a sheet opened
  from a page used to be positioned against `main` while `animate-page-forward`
  was still running a transform on it.
- **Focus goes home when the sheet is GONE, not when it starts leaving.** `open`
  turns false at the top of the 280ms exit, and until the layer comes off the
  stack `#root` is still `inert` — focusing into an inert subtree does nothing
  at all, silently, so restoring there looks exactly like not restoring. The
  restore is keyed on `shown` and is a passive effect, where `useModalLayer`
  clears the flag in a layout one. Taking focus on the way IN has the mirror of
  the `useMorphHeight` trap: on the render where `open` first turns true the
  phase has not caught up, `Sheet` returns `null`, and an effect keyed on `open`
  alone fires once against a null ref and never looks again.
- **A native `confirm()` is not a dialog you can write.** Fourteen of them and
  eight `alert()`s carried the most consequential moments in the app; they
  render in the system font, ignore the theme, and in an installed PWA are
  captioned with the origin. `Settings` was passing two paragraphs separated by
  `\n\n` into a control with no paragraphs. `confirmAction()` and
  `alertAction()` replace them and return promises, so the call sites keep the
  shape they had. The name is deliberately not `confirm`: a module-scoped one
  would shadow the global, and any call site left behind would go on compiling
  as `if (confirm(…))` — where the value is now a Promise and therefore always
  truthy, so every confirmation in the app would silently answer yes.
- **A delete is still a question, not an undo.** The obvious improvement on a
  confirmation is to do it and offer "Undo", and it is not available here: a
  delete is `set deleted_at` on the server, `deletedAt` is readable but NOT
  writable from the client (`mapping.ts`), and ids are client-generated with
  `on conflict do nothing` — so an undo could only re-insert, which the server
  would discard against the tombstone already sitting there. An undo that
  silently does nothing is worse than a question. Undo is offered where the
  reversal is an ordinary UPDATE, which is why bulk recategorisation has one and
  deletion does not; that undo captures the previous `categoryId` of every row
  BEFORE writing, including the rows that had none, since `undefined` is what
  clears a field rather than leaving it alone.
- **Which month a row counts in is never `monthKey(t.date)`.** Two things move
  it. The household's cutoffs (`MonthRule`, migration 25) shift money ARRIVING
  late in the month into the one it funds — separately for contributions and
  for income, because payday and the transfer that follows it are two events
  with two dates and a single number has to be wrong about one of them. And
  `transactions.bookMonth` is one row's own answer, which beats the cutoff and
  is the only thing that can move SPENDING. Ask `effectiveMonth(t, flow, rule)`
  where a flow is to hand and `bookedMonth(t)` where one is not (`stats.ts`) —
  never the date. `rule` is a required parameter rather than a defaulted one
  precisely so a new caller cannot quietly count months the old way. The
  `*InRange` functions are the deliberate exception and still count by real
  date: "the month this money was for" is not a question a fortnight in the
  middle of March can answer.
- **Shifting arrivals and not spending leaves a seam, and the leftover is what
  closes it.** A salary landing on the 23rd is next month's money; the £400
  spent out of it before the month turns keeps its own date and is THIS month's
  spending. So the old month reads several hundred pounds worse than it was and
  the new one reads richer by the same amount, and "left over" matches the bank
  in neither. `bookOpening` carries the position forward instead — and the
  reason it is a second function rather than a line inside `bookBalances` is the
  one thing here that is easy to get silently wrong: it counts by
  `effectiveMonth`, where `bookBalances` counts by `t.date`. Written the obvious
  way, the salary of the 23rd lands in August's opening balance AND in August's
  income, counted twice. Counting by effective month partitions every row into
  exactly one month, which buys the identity the figure is worth printing for
  and which `books.test.ts` pins across all three books:

      opening(M) + net(M) === opening(M + 1)

  For the month you are in, `opening + net` is what the book's accounts hold
  less `laterMinor` — money already in them for a later month. That subtraction
  is the point, not an error: on the 26th the bank holds next month's salary and
  this month does not get to spend it, so the card says so rather than quietly
  disagreeing with the banking app. `laterMinor` is a NET figure for the same
  reason — it has to be exactly that difference, so a future-dated purchase is
  in it too.

  Two consequences on screen. `BOOK_WORDS[book].net` is the RUNNING figure on
  both month panels now — leftover plus this month — and the month-only net has
  moved into the ⓘ, where it is the arithmetic rather than the answer. And
  Reports prints the leftover or the literal start-of-month balance, never both:
  they answer "what did you start with" differently on purpose, so two of them
  on one card is two "start of March" figures with nothing to say why they
  differ. The leftover wins where it exists, because it is the one that
  reconciles with the figures beside it; the balances sentence stays for the
  hand-drawn range, which counts by date and so has no leftover to carry.

  It takes a month or a LIST of them, the same way `savedInto` and
  `bookSpendByCategory` do, and for a reason worth stating: asked for a year's
  January alone, `laterMinor` calls February through December next month's
  money. "Before" is the first of them and "after" is the last.

  It is `undefined` rather than approximate on a book holding a `balance`-level
  account, exactly as `bookBalances` is, and both panels fall back to printing
  the month alone. One seam is left and stated rather than papered over: under
  `all`, a transfer with one leg in an account in NEITHER book moves the balance
  without moving the net — `BookBridge.unbookedCount`'s row again.
- **"How is the month going" and "where is my money" need different arithmetic,
  not a different arrangement of the same figures.** `bookTotals` files every
  row by what it MEANS — a contribution is not income to the person making it, a
  transfer inside one book is not an event at all — which is right for the flow
  card and useless for a balance. `bookPosition` partitions the same rows by
  what they did to a BALANCE instead: `in` arrived from outside, `out` was
  spent, `moved` went somewhere else you hold. Which buys the identity the split
  view rests on, for ANY set of accounts:

      opening + in − out + moved + later === now

  So the account-type subcards add up to the combined figures, which a
  flow-based split could never promise — a transfer to savings is `internal` and
  counted in neither, while both balances plainly moved. Two rows are
  deliberately read differently from `bookTotals` and both are stated in the
  function's own note: `paid-for-household` is `out` here (the money left the
  account by being spent) and `contributed` there (it is not personal
  spending); and a contribution is `in` where it arrives and `moved` where it
  leaves, never `out`.

  The card built on it is `HeroWidget`'s second and third variants — see
  `HERO_SHAPES` for why "together or separately" is a variant rather than an
  option, which is the one place the documented variants/options split does not
  decide it: the choice does not COMPOSE, so as an option it would sit in the
  picker under a variant it means nothing to.

  `laterMinor` is printed on the card rather than left in the ⓘ, and that is not
  a detail: the tiles do not add up to the figure above them by exactly it, and
  a reader who tries the arithmetic and fails will trust neither.

  **What counts as `in` is a question about the PARTNER, not about the flow**,
  and reading it off the flow alone is how Everything came to report a salary
  twice. `classifyFlows` says `contribution` for a leg crossing from a personal
  account to a joint one, because those are two books — but under `all` both
  accounts are in view, so the salary landing in the current account and the
  transfer of it into the joint account are the same money reaching the set
  once. A transfer whose far leg is also inside the set being measured is
  therefore `moved`, both ways, nets to nothing, and can never inflate what came
  in; a leg whose partner is outside the set, or has no partner row at all
  (a contribution from somebody not using the app), is money genuinely arriving.
  That is the same rule `bookTotals` states for itself when it skips a
  contribution under `all`, which is why `bookPosition` builds the same legs
  index `classifyFlows` does.
- **The balances card is two grounds in one card, and the cut is what makes the
  colour possible.** `.panel-month` is the app's one painted surface and its
  rule holds: every colour on it comes from `--panel-*`, because a palette hue
  on a blue gradient is either invisible or a clash — which is why the figures
  were four strengths of white to begin with. Rather than break that, the
  headline and the bar keep the gradient and everything BELOW a hairline cut is
  an ordinary surface, on a soft `--surface-2` → `--surface` gradient, where the
  twelve slots and `Card`'s own vocabulary (white, hairline, `--elev-1`) are
  simply available. The `Card` is `p-0 overflow-hidden` so each zone states its
  own padding and the gradient is clipped by the radius.

  Two things follow. A metric's chip colour is IDENTITY, not judgement — the
  four hues tell four figures apart the way the palette tells twelve categories
  apart — with the single exception of green in / red out, which is a 16% tint
  on a fingernail rather than the `--critical` an alarm paints across a panel,
  and which never "fires" because it labels a figure that is always there. And
  an account-type card is headed by a `Face` on the slot `accountFace` derives
  from `kind`, so the Savings card wears the same teal piggy bank every savings
  account wears in the Accounts list — a second colour chosen for the same idea
  would be the drift this avoids.

  `useInfoNote`'s body stays ABOVE the cut with the ⓘ that opens it. The hook
  takes one ground for both halves, and `--panel-ink-2` is a near-white:
  correct on the gradient, invisible on the surface below it.
- **The month rule is the household's, not the device's.** It rides on
  `households` beside the currency, is cached in `meta` on every pull, and is
  written by an RPC. Kept per device it would break the one property the books
  exist for — the household book being complete and IDENTICAL on both screens —
  by landing the same contribution in July on one phone and August on the
  other, with nothing on either to say why. It bumps no epoch: nobody's access
  changed, so `checkEpoch`'s unconditional rewrite of the cached copy is the
  only thing carrying a change to the other device.
- **Transfer pairing is the one matcher with no tolerance.** Every other
  comparison in the app is fuzzy — `payeeSimilar`, the bill amount window, the
  duplicate check. `findTransferCandidates` requires `out === -in` exactly, and
  `link_transfer` enforces the same equality, because absorbing a £4 difference
  here does not add a row you can delete: it removes two real amounts from every
  total in the app. An ambiguous pair (either side has more than one reading) is
  offered but never linked automatically, for the same reason.

- **A goal is a CLAIM, not a container, and the pot is a ledger.** It used to be
  the sum of transactions carrying `goal_id`, and the only two things that could
  write that were `create_transfer` — which MOVES money, so it needs somewhere
  to move it from — and `set_transfer_goal`, which refuses anything that is not
  half of a transfer. So money already in the savings account could not be put
  towards a goal at all: not an opening balance, not interest, not a salary that
  landed straight there. `goal_entries` (migration 24) replaces it, and three
  things about it are load-bearing. Rows rather than a `savedMinor` column,
  because the outbox cannot merge two increments of one column and one of two
  devices' assignments would be silently lost — the same reasoning that keeps
  `settlement` a view. Every server function is `security definer`, because the
  other goals on a shared account may be the other person's and `goals_select`
  hides them: a cap computed from only the goals you can see is not a cap. And
  the client's `accountAllocation`/`shortfall` mirror the server's rules exactly
  so the screen can say what is about to happen — a figure that changes on the
  next sync with nothing to explain it is the failure being avoided.
- **The month a row counts towards is about ARRIVAL, and the rule applies to
  everything that arrives.** `CONTRIBUTION_CUTOFF_DAY` shifts money landing on
  or after the 25th into the month it funds — we are paid at the end of one
  month and spend it during the next. It used to shift contributions ALONE,
  which is half a rule: right on the household book, where the contribution and
  the spending it pays for land in the same month, and wrong on the personal
  book, where a salary paid on the 31st is an arrival too. July then held the
  salary and no contribution, August the contribution and no salary, so Mine
  read `Earned £0 · To our household £2,909 · Left with me −£3,065` every single
  month and Everything's "money in" was the other person's contribution and
  nothing else. `shifts()` in books.ts is the rule stated once: a contribution,
  a salary, interest, a refund — anything coming IN. Money going out never
  shifts, and neither does `paid-for-household`, which is spending that happens
  to also be a contribution and has to stay on the statement line it reconciles
  against.
- **A same-book transfer is still `internal`, and is now also reportable.**
  `savedInto` is a SECOND reading of rows `bookTotals` correctly counts in
  nothing: no flow moves, no total changes, and what is left over is simply
  drawn split into the part that went to savings and the part that stayed. Any
  future "and also count this as…" wants that shape rather than a new `Flow` —
  a flow is what a row IS, and a row can only be one thing.
- **`layoutFlow` is columns now, and two rules generalised rather than being
  replaced.** `side` still decides ribbon colour and what a click means;
  `column` is what the geometry reads, derived from `side` when absent so every
  three-column graph lays out identically. A ribbon is as thick as the band it
  UNIQUELY belongs to — a band with a `minBand` floor is fatter than its money
  and the ribbon has to be fattened with it, or the join reads as money going
  missing at one end — and an interior band is as tall as the busier of the two
  stacks it carries, which is exactly "the hub is as tall as the busier side"
  said for four columns. `sankey.test.ts` asserts the three-column case is
  unchanged; break either rule and it says so.
- **A card's prose goes behind the ⓘ, and `CardHeading` is where.** Reports had
  eleven cards each carrying a two-sentence paragraph under the title,
  permanently — three lines above every chart on a phone, and the rule about
  headings-and-one-line broken eleven times over. `CardHeading` takes `hint`
  (one short line about what is on screen NOW — "scroll back for earlier
  months") and `info` (everything else). It is a component and not a helper
  because `useInfoNote` is a hook and a page cannot call one per card from
  inside a `switch`.

## Known gaps (not yet fixed)

- `stats.ts` `monthlySeries` has an `else if`/`else` pair with identical bodies —
  the income branch is dead code, harmless but misleading.
- The PDF import path does not ask which sign means money out. `pdfImport.ts`
  derives a sign from balance deltas and credit markers rather than from a
  column, and `ImportWizard.onFile` sends a PDF straight to `buildReview`,
  skipping the mapping step — so there is nowhere to hang the control that the
  CSV path has. A card statement as PDF may still import inverted.
- Bill posting and reconciliation, transfers and their linking, account deletion
  and the wipe are **online-only** RPCs. Deliberate (they must be atomic), but
  there is no queued-offline story for them.
- No end-to-end test covers two users at once; the two-person cases are asserted
  in `supabase/99c-ownership-tests.sql` and `99e-reconcile-tests.sql` at the SQL
  layer only.
- Unlinking a transfer still clears `goal_id`, and that no longer means
  anything: since migration 24 a pot is a `goal_entries` ledger and does not
  read that column at all. The old tagging path is left installed so nothing
  queued by an older tab dead-letters; it feeds nothing. The categories
  ARE recoverable as of migration 12 — `prior_category_id` holds them between
  link and unlink, and a newer answer set while linked wins over the remembered
  one.
- Activity is a LEDGER and runs by date, so a row counted in another month —
  by a cutoff or by `bookMonth` — is still listed where the statement puts it,
  and a drill-down from a report slice can therefore miss it. Deliberate: date
  order is the only order that page can be reconciled against a bank in. The
  divergence is marked rather than hidden (`CountedIn` draws the month on the
  row), but only for a month somebody typed — deciding whether a cutoff applies
  needs the flow, and that needs an index of transfer legs this page does not
  build.
- **Asking about a row needs LESS than changing it.** `request_explanation`
  (migration 16) takes `view`, deliberately below the `transactions_update` bar,
  because the person who can see a puzzling row is by definition the one who
  cannot resolve it — at `contribute` you may not edit a row your partner
  imported. It is safe to be lower only because the row is always in a household
  account both people can already read; nothing new becomes visible. The mark is
  never cleared by linking: `link_transfer` is untouched (a third
  `create or replace` over a security-definer body is where a dropped check
  hides), and `isAsking` ignores a mark on a paired row instead.
