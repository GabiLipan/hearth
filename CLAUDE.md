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

Load `local/00-shim.sql`, then `01` … `17`, then `local/98-grants.sql`, then `exec`
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

All are re-runnable, with **one ordering trap**: `10` drops the two-argument
`link_transfer` and replaces it with a three-argument one, and `09` is still
re-runnable, so running `09` *after* `10` puts the old signature back beside
the new. PostgREST then cannot resolve the call — supabase-js drops `undefined`
arguments — and every transfer link dead-letters with "could not find the
function … in the schema cache". Re-run `10` to clear it;
`00-which-migrations-applied.sql` has a row that detects exactly this.

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
`rules.ts` (payee matching, learning, bulk recategorisation), `bills.ts`
(suggestions, posting, reconciliation), `transfers.ts` (pairing and linking),
`routes.ts` (recurring movements, derived from confirmed transfers),
`unexplained.ts` (the blind spot, and asking the person who can see past it),
`categoryTree.ts` (what a drag on the category list means, and what it writes),
`layout.ts` (which sections a page shows, in what order, how wide, and in which
shape — home and Reports share it), `sticky.ts` (a filter that outlives leaving
the page and dies with the tab), `sankey.ts` (a period as one balanced flow,
and where every band goes), `scale.ts` (a value axis with round numbers, shared
by a scrolling chart and the axis pinned beside it),
`reimbursements.ts` (what the household owes you), `shade.ts` (telling apart
two categories the palette gave one colour),
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
  DOCUMENT coordinates, so auto-scrolling does not invalidate it, and the
  insertion line is drawn from `move`'s own answer rather than from the pointer:
  when a drop is clamped, the line goes where the row will actually land.
  `pointercancel` must NOT commit — it is the system taking the gesture away,
  not a drop.
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
- **`bookTotals` selects rows by ACCOUNT, and `paid-for-household` is the one
  exception.** Selecting by account is what stops a contribution being counted
  into both books; that flow genuinely belongs to two at once, so it is admitted
  to the household book while living outside it. Anything computing spending
  must use `spendsIn(flow, book, accountId, ids)` rather than
  `ids.has(...) && isSpend(...)`, or the categories stop adding up to the total
  above them. One honest limit: the household book is normally identical on both
  screens, and this is the only thing that breaks that — a row in a private
  account is invisible to the other person.
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
- **An account's colour and icon are derived when unset.** `accountFace` maps
  `kind` to a slot and an icon key, so the Activity table reads properly before
  anybody opens a form and nothing has to be backfilled. Read `accountFace(a)`,
  never `a.slot` — a raw read is `undefined` on the common case and paints the
  badge grey, which is the state the feature exists to remove. The badge is a
  rounded SQUARE where a category is a circle: they share rows, and the shape
  says which axis you are reading before the colour says which one.
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
- **A faded bar already means something, so nothing else may fade one.** Every
  chart draws an unfinished month at 45%, and it says so in words. A gradient
  hinting that a scrolling chart has more to the left washes out the bar under
  it in exactly the same way — on a phone it ate a whole bar, which then read as
  a month that had barely started. `MonthScroller` therefore has no edge fade at
  all; the scrollbar and a caption carry the hint instead.
- **A filter that outlives its page turns every mount-time reset into a bug.**
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
- **A tapped tooltip has no ending, because nothing ever leaves.** Every chart
  here was written against hover, and a hover ends by itself; a tap opens a
  panel that then sits over the chart until something unrelated closes it.
  `useTouchTooltip` gives the gesture the ending it lacks — the panel stays
  while the finger is down, and a few seconds after it lifts it fades — and
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
- **Document order is not reading order once `Columns` is involved.** Masonry
  distributes cards down columns, so the second card on the page is the top of
  column two rather than the second `data-section` in the DOM. `Arrange` carries
  the visible-list index on every measured box rather than implying it from the
  array, and drops boxes of zero size — a section whose data has nothing to show
  renders empty and is hidden, and a zero box at the origin would otherwise win
  "nearest centre" from the far corner of the page.
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
- **Transfer pairing is the one matcher with no tolerance.** Every other
  comparison in the app is fuzzy — `payeeSimilar`, the bill amount window, the
  duplicate check. `findTransferCandidates` requires `out === -in` exactly, and
  `link_transfer` enforces the same equality, because absorbing a £4 difference
  here does not add a row you can delete: it removes two real amounts from every
  total in the app. An ambiguous pair (either side has more than one reading) is
  offered but never linked automatically, for the same reason.

## Known gaps (not yet fixed)

- `stats.ts` `monthlySeries` has an `else if`/`else` pair with identical bodies —
  the income branch is dead code, harmless but misleading.
- Bill posting and reconciliation, transfers and their linking, account deletion
  and the wipe are **online-only** RPCs. Deliberate (they must be atomic), but
  there is no queued-offline story for them.
- No end-to-end test covers two users at once; the two-person cases are asserted
  in `supabase/99c-ownership-tests.sql` and `99e-reconcile-tests.sql` at the SQL
  layer only.
- Unlinking a transfer releases any goal it was funding, and that value is not
  recoverable. Deliberate: `goalProgress` sums `goal_id` rather than transfers,
  so a tag left on a leg that is no longer part of one would keep the pot
  claiming money the app no longer believes was moved into it. The categories
  ARE recoverable as of migration 12 — `prior_category_id` holds them between
  link and unlink, and a newer answer set while linked wins over the remembered
  one.
- **Asking about a row needs LESS than changing it.** `request_explanation`
  (migration 16) takes `view`, deliberately below the `transactions_update` bar,
  because the person who can see a puzzling row is by definition the one who
  cannot resolve it — at `contribute` you may not edit a row your partner
  imported. It is safe to be lower only because the row is always in a household
  account both people can already read; nothing new becomes visible. The mark is
  never cleared by linking: `link_transfer` is untouched (a third
  `create or replace` over a security-definer body is where a dropped check
  hides), and `isAsking` ignores a mark on a paired row instead.
