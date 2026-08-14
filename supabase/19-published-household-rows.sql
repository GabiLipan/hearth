-- Hearth — a household expense you can both see, wherever it was paid from (19 of 19)
--
-- A MIGRATION. Run once, after 18-contributions.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- Migration 13 gave a personal-account row the flag `paid_for_household`, and
-- the book model already counts it properly: a contribution out of the payer's
-- book, and household spending in the household's. That arithmetic is right and
-- is not changed here.
--
-- What was wrong is that it was only ever right on ONE SCREEN. The row lives in
-- a private account, `transactions_select` authorises a transaction by its
-- account and nothing else, so the other person could not read it. The
-- household book — chosen, and documented in `lib/books.ts`, precisely because
-- it is complete and IDENTICAL on both devices — had exactly one hole in it,
-- and this was it. I buy the shop on my card, my screen says the household
-- spent £90 on groceries, and hers says it spent nothing.
--
-- We pay for household things out of our own accounts constantly, so that hole
-- is not an edge case; it is most of the grocery figure.
--
-- ## What this adds, and what it deliberately does not
--
-- One column on `accounts`, `publishes_household_rows`, and one disjunct on
-- `transactions_select`. Together they say: *on an account whose owner has
-- agreed to it, a row marked as household spending is readable by the rest of
-- the household — and nothing else on that account is.*
--
-- This is the FIRST row-level rule in the schema. Every other policy here
-- authorises a transaction by its account; this one lets a row out of an
-- account the reader has no grant on. Three things follow, and they are the
-- whole risk of this migration:
--
--   1. `my_account_ids()` is no longer the only thing that authorises a SELECT
--      on `transactions`. It is still the only thing that authorises a WRITE.
--      §5 is the audit, restated rather than assumed.
--   2. Un-marking a row makes it invisible, and an invisible row emits no
--      realtime event and no tombstone — so the other device would hold it for
--      ever. §4 bumps the epoch, which is the only signal that exists for this.
--   3. Nothing can be un-seen. Once her device has pulled the row, she has read
--      it. The consent sheet in the client says so in words.
--
-- ## Why consent is per ACCOUNT and not per row
--
-- Because the question being asked is not "may she see this £90", it is "is
-- this an account I am willing to pay household things from". Asking per row
-- would be asking the same question every week and getting a reflex answer, and
-- a reflex answer is not consent. Per account it is asked once, on the first
-- row, and it is revocable.
--
-- ## Why it is not a `balance` grant
--
-- The obvious cheap version is to grant the household `balance` on the payer's
-- account. That shows the account's running total — every payday, and the size
-- of all their personal spending in aggregate — which is enormously more than
-- one grocery row and is not what anybody was asking for. A grant is about an
-- ACCOUNT; this is about a row.
--
-- ## Why the account's NAME is not exposed
--
-- A published row arrives on the other device with no account it may read. The
-- tempting fix is `unowned_accounts()`'s shape — an RPC returning names only —
-- and it is the wrong fix here. The reader does not want to know it was the
-- Amex; they want to know it was Sam. `created_by` is already on the row and
-- already readable, and the client renders the payer rather than the account.
-- So the exposure stays at exactly one row and nothing about the account
-- travels with it.
--
-- ## What a published row carries
--
-- The whole row: payee, amount, date, category and NOTE. There is no
-- column-level filtering in RLS and inventing a view to get it would be a
-- second read path to keep in step with this one. The consent sheet says the
-- note rides along.

-- ============================================================
-- 0. Refuse to install against a schema missing 07 or 13
-- ============================================================
--
-- Not decoration. plpgsql bodies are only syntax-checked at creation time, so a
-- migration built on a missing one installs "successfully" and fails at
-- runtime — and a policy referencing a column that is not there would take
-- `transactions_select` down with it, which is every read in the app.

do $$
begin
  if to_regprocedure('public.my_account_ids(public.access_level)') is null then
    raise exception
      'Run 07-permissions.sql first: this migration rewrites transactions_select, which authorises against my_account_ids()'
      using errcode = '42883';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'transactions'
       and column_name = 'paid_for_household'
  ) then
    raise exception
      'Run 13-paid-for-household.sql first: this migration publishes exactly the rows that column marks'
      using errcode = '42P01';
  end if;
end $$;

-- ============================================================
-- 1. The consent
-- ============================================================
--
-- Default false, and it stays false until somebody ticks it. An account that
-- has been used for household spending for a year does not start publishing
-- because this file ran.

alter table public.accounts
  add column if not exists publishes_household_rows boolean not null default false;

comment on column public.accounts.publishes_household_rows is
  'The owner has agreed that rows on this account marked paid_for_household are readable by the rest of the household. Nothing else on the account is.';

-- Answers the policy's question past RLS.
--
-- `security definer` for the same reason `account_has_grants` is: a plain
-- subquery inside `transactions_select` would be filtered by `accounts_select`,
-- which needs a grant — so a reader who cannot SEE the account would conclude
-- it does not publish, and the disjunct could never fire for the one person it
-- exists for.
--
-- It reads a tombstoned account too. A deleted account's published rows are
-- deleted with it and their tombstones have to stay readable, or the other
-- device holds them for ever; the same reasoning as `my_account_ids()` not
-- filtering `deleted_at`.
create or replace function public.account_publishes(a uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.accounts
     where id = a and publishes_household_rows
  )
$$;

comment on function public.account_publishes(uuid) is
  'Whether this account''s owner has agreed to publish its household-spending rows. Called from transactions_select, so it must be definer.';

-- ============================================================
-- 2. The policy
-- ============================================================
--
-- The first disjunct is 07's policy, unchanged and still first, so the ordinary
-- case is decided by the same expression it always was.
--
-- The second is deliberately as narrow as it can be written, and every conjunct
-- is doing work:
--
--   `paid_for_household`   the mark itself. Without it, nothing publishes.
--   `amount_minor < 0`     money OUT only. `classifyFlows` reads the flag only
--                          on a negative row — a refund landing back on the
--                          card is not household spending — so a positive row
--                          carrying the flag would be published and then
--                          counted by nobody. Publishing what nothing reads is
--                          how a leak with no purpose survives review.
--   `household_id = ...`   the reader must be in the same household. `accounts`
--                          travel between households (`depart_household`), and
--                          this is what stops a row travelling with one from
--                          staying readable by the people left behind.
--   `account_publishes`    the consent.
--
-- Note there is no `deleted_at` condition, on purpose: the tombstone of a
-- published row must stay selectable, or the other device never learns it went.
--
-- `(select public.my_household())` rather than a bare call, so the planner
-- hoists it into an InitPlan and evaluates it once per query rather than once
-- per row — the convention 02-rls.sql sets and every policy since has kept.

drop policy if exists transactions_select on public.transactions;
create policy transactions_select on public.transactions
  for select to authenticated
  using (
    account_id in (select public.my_account_ids('view'))
    or (
      paid_for_household
      and amount_minor < 0
      and household_id = (select public.my_household())
      and public.account_publishes(account_id)
    )
  );

-- The policy asks two questions of a transaction that no index answered:
-- "is this row published" and "whose household". Partial, because the marked
-- rows are a handful of the table.
create index if not exists transactions_published
  on public.transactions (household_id, account_id)
  where paid_for_household and amount_minor < 0;

-- ============================================================
-- 3. Writing is NOT widened
-- ============================================================
--
-- Stated here rather than left to be inferred from the absence of a change.
--
-- `transactions_update` and `transactions_insert` are untouched, and so is
-- `may_edit_transaction()` — which 09 introduced precisely so that the update
-- predicate is written once and definer functions restate it by CALLING it.
-- Reading a published row gives you no way to change it: not the category, not
-- the payee, not the flag that published it. The person who can see it is not
-- the person who owns it, and the row stays the payer's to correct.
--
-- The one place that asymmetry is uncomfortable is `request_explanation()` in
-- 16, which needs only `view` — "seeing a row is the whole qualification for
-- being confused by it". It is deliberately NOT widened to published rows: it
-- authorises against `my_account_ids('view')`, and a published row has no
-- grant behind it at all. A published row is also not the thing that function
-- is for; it has no missing far leg, and the person who can explain it is
-- named on it.

-- ============================================================
-- 4. Going invisible again
-- ============================================================
--
-- The asymmetry that makes this section necessary: a row BECOMING visible
-- carries its own signal, because whatever made it visible moved `updated_at`
-- and the other device's delta pull reads exactly that. A row becoming
-- INVISIBLE carries none — it is not returned by the pull, it emits no realtime
-- event, and it leaves no tombstone. The other device would hold it for ever,
-- with the household's grocery figure permanently counting money that is no
-- longer claimed.
--
-- `visibility_epoch` is the only mechanism that exists for this, and it is a
-- big hammer: every device drops its whole cache and re-pulls. That is the
-- accepted cost, and it is why both triggers below are strictly one-directional
-- — an ordinary tick of the household box must not wipe anybody's cache.
--
-- The exception, and it is the reason the policy has no `deleted_at` condition:
-- DELETING a published row does not hide it. The tombstone still satisfies the
-- policy, so the ordinary pull carries the deletion across like any other.

-- ---------- the account's consent being withdrawn ----------
--
-- Both directions here, unlike the row trigger. Turning consent OFF hides rows
-- that are already on the other device. Turning it ON reveals rows whose
-- `updated_at` is months old — a delta pull is keyed on that cursor, so without
-- a bump the other device would never learn about the history it may now read,
-- and would sit showing a household figure that is short by everything recorded
-- before the switch.
create or replace function public.accounts_publish_epoch_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.publishes_household_rows is distinct from new.publishes_household_rows then
    perform public.bump_epoch(new.household_id);
  end if;
  return null;
end $$;

drop trigger if exists accounts_publish_epoch on public.accounts;
create trigger accounts_publish_epoch after update on public.accounts
  for each row execute function public.accounts_publish_epoch_trigger();

-- ---------- one row ceasing to be published ----------
--
-- Three ways out, and they are the three conjuncts of the policy that a client
-- can move: un-ticking the box, editing the amount so it is no longer money
-- out, and moving the row onto an account that does not publish. The fourth,
-- `household_id`, is pinned by `stamp_ownership` for everything except
-- `depart_household()` — which bumps both households itself.
--
-- Checked against the account's CURRENT publish state on each side, because a
-- row moving between two publishing accounts has not gone anywhere.
create or replace function public.transactions_publish_epoch_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  was boolean;
  is_now boolean;
begin
  was := old.paid_for_household and old.amount_minor < 0
         and public.account_publishes(old.account_id);
  if not was then return null; end if;

  is_now := new.paid_for_household and new.amount_minor < 0
            and public.account_publishes(new.account_id);
  -- A soft delete leaves the row published, which is what carries the deletion
  -- to the other device. Only a row that has genuinely left the policy needs
  -- the hammer.
  if not is_now then
    perform public.bump_epoch(new.household_id);
  end if;
  return null;
end $$;

drop trigger if exists transactions_publish_epoch on public.transactions;
create trigger transactions_publish_epoch after update on public.transactions
  for each row execute function public.transactions_publish_epoch_trigger();

-- ============================================================
-- 5. The definer audit
-- ============================================================
--
-- `security definer` turns RLS off, so every definer function has to restate
-- the predicate its policy would have applied. Widening a SELECT policy means
-- re-reading every one of them and asking whether it derived any authority from
-- the old, narrower rule. This is that list, and it is written down rather than
-- performed silently because the last time this reasoning was skipped —
-- `wipe_household()` under migration 07 — one person's "Erase everything"
-- deleted the other's private accounts.
--
-- The conclusion is that NOTHING has to change, and here is why, function by
-- function:
--
--   may_edit_transaction()   Mirrors transactions_update, which is untouched.
--                            Must NOT be widened: seeing is not editing.
--   link_transfer()          Calls may_edit_transaction() on both legs. A
--   unlink_transfer()        published row can therefore not be linked into a
--   link_bill_payment()      transfer or a bill by the person who can merely
--   unlink_bill_payment()    read it, which is right — half a transfer written
--   set_transfer_goal()      by somebody with no access to one leg's account is
--                            exactly the state 09 refuses to create.
--   wipe_household()         Selects by `account_id = any(mine)` where `mine`
--                            is the caller's OWNER grants. Publishing grants
--                            nobody an owner grant, so a published row is not
--                            in anybody else's wipe. Unchanged.
--   delete_account()         Owner-gated, and acts by account. A published row
--   purge_account()          dies with the account it lives on, as it should.
--   restore_account()        Owner-gated by the surviving grant. Unchanged.
--   claim_account()          Admin-gated, acts on ownerless accounts. It cannot
--                            reach a published row: an account with no grants
--                            has an owner who has departed, and the account
--                            still carries its own publish flag either way.
--   account_balances()       Gated on my_account_ids('balance') and returns an
--                            aggregate. Publishing must not move a balance, and
--                            does not — this is the whole difference between
--                            this feature and a `balance` grant.
--   post_due_bills()         Insert paths, gated on 'contribute'. Unchanged.
--   post_bill(), skip_bill()
--   request_explanation()    Gated on my_account_ids('view'). Deliberately not
--   clear_explanation()      widened — see §3.
--   preview_departure()      Reports on grants. A published row is not a grant.
--   depart_household()       Moves accounts and their transactions between
--                            households, publish flag and all. The `household_id`
--                            conjunct in the policy is what makes that correct:
--                            the row stops being readable by the household it
--                            left, on the same statement that moves it, and the
--                            function already bumps both epochs.
--   unowned_accounts()       Names only, and about accounts. Unchanged.
--   deleted_accounts()
--
-- And one that is security INVOKER and matters more than any of them:
--
--   sync_checksums()         RLS applies, by design, because the client compares
--                            its answer against an equally RLS-filtered cache.
--                            It therefore picks up published rows with no change
--                            at all — which is what stops the reconcile loop
--                            deciding the cache has too many rows and wiping it
--                            once a minute, for ever.
--
-- Nothing below this comment changes a function. That is the finding.

-- ============================================================
-- 6. Grants
-- ============================================================
--
-- `account_publishes` is called from inside a policy, and a policy runs as the
-- invoking role, so `authenticated` must be able to execute it. It answers one
-- boolean about an account id the caller would already have to hold to ask —
-- the same exposure `account_has_grants(uuid)` has carried since 07.

revoke execute on function public.account_publishes(uuid) from anon, public;
grant execute on function public.account_publishes(uuid) to authenticated;

-- Internal only, and re-created above: `create or replace` resets grants, so
-- the revoke has to be re-applied.
revoke execute on function public.accounts_publish_epoch_trigger() from anon, public, authenticated;
revoke execute on function public.transactions_publish_epoch_trigger() from anon, public, authenticated;
