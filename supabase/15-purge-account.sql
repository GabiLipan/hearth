-- Hearth — emptying the bin (15 of 15)
--
-- A MIGRATION. Run once, after 14-book-override.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- Migration 11 gave a deleted account a way back. It did not give it a way
-- out. `delete_account()` sets `deleted_at` and nothing ever unsets it or
-- removes the row, so `deleted_accounts()` returns every account either of us
-- has ever deleted, for ever — the Recoverable section in Settings only grows,
-- and the test accounts from the first week sit there next to a real one that
-- went yesterday. Worse, it is misleading about what is stored: "deleted" reads
-- as gone, and every transaction on it is still in the table.
--
-- So: one function, `purge_account()`, that actually destroys it.
--
-- Three rules shape it.
--
-- 1. THE BIN IS THE ONLY DOOR. It refuses on a live account. Deleting is
--    reversible and purging is not, so the two are deliberately separate
--    presses on separate days, and there is no argument to `delete_account()`
--    that skips the reversible step.
--
-- 2. IT DESTROYS ONLY WHAT IS ALREADY DELETED. Live rows elsewhere are not its
--    business. The two places that touch them are forced by foreign keys and
--    are both the right answer anyway (see section 2).
--
-- 3. IT BUMPS THE EPOCH, and not for the usual reason. Nobody's access changes
--    — the account was already invisible to everybody. What changes is that the
--    TOMBSTONE goes. A device that has been offline since before the delete
--    still holds the account and its transactions, and was going to learn about
--    the deletion by pulling the `deleted_at` row; purge removes the only
--    evidence, and that device would hold them for ever with nothing left to
--    replicate. The epoch is the one signal that survives a row disappearing,
--    so it is what covers this. A full re-pull on both devices is a fair price
--    for a rare, deliberate press.

-- ============================================================
-- 0. Refuse to install against a schema missing 11
-- ============================================================
--
-- Not decoration. plpgsql bodies are only syntax-checked at creation time, so a
-- migration referencing a function that is not there installs "successfully"
-- and fails at runtime, on the one press where failing quietly is worst.

do $$
begin
  if to_regprocedure('public.restore_account(uuid)') is null
     or to_regprocedure('public.deleted_accounts()') is null then
    raise exception
      'Run 11-account-recovery.sql first: purge_account is the other half of the bin it created'
      using errcode = '42883';
  end if;
  if to_regprocedure('public.may_edit_transaction(uuid,uuid)') is null then
    raise exception
      'Run 09-reconcile.sql first: purge_account releases transfer partners through may_edit_transaction()'
      using errcode = '42883';
  end if;
end $$;

-- ============================================================
-- 1. Destroy it
-- ============================================================
--
-- Authorised exactly as `restore_account` is: an `owner` grant, and nothing
-- else. Grants outlive the accounts they point at, which is what lets an owner
-- still be recognised after the account is gone — the same fact migration 11
-- leans on. This is the one function that finally spends it: the grants go with
-- the account (`account_grants.account_id` cascades), because there is no
-- longer a row for them to authorise.
--
-- `security definer`, so it restates the predicate the policies would have
-- applied. There are no DELETE policies anywhere in this schema — deletion is
-- normally `set deleted_at`, an UPDATE — so a genuine DELETE can only happen
-- here, behind a check written by hand. That is the whole reason this file is
-- short and its comments are long.
create or replace function public.purge_account(p_account_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  a public.accounts;
  n integer;
  released integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  -- `deleted_at is not null` is the rule, not a filter: purging is reachable
  -- only from the bin. A live account has to be deleted first, and that press
  -- can be undone.
  select * into a from public.accounts
   where id = p_account_id and deleted_at is not null
   for update;

  -- One message for "not yours" and "not there", for the reason
  -- `delete_account` and `restore_account` both give: distinguishing them
  -- confirms the existence of an account the caller cannot see.
  if a.id is null or a.id not in (select public.my_account_ids('owner')) then
    raise exception 'That account is not yours to destroy' using errcode = '42501';
  end if;

  -- ----------------------------------------------------------
  -- Transfer partners in accounts that are staying
  -- ----------------------------------------------------------
  --
  -- A transfer is two rows sharing a `transfer_id`, and that column is a plain
  -- uuid with no foreign key, so destroying one leg leaves the other pointing
  -- at nothing. That half-transfer is not created here — `delete_account`
  -- already soft-deleted this side, so the surviving leg has been dangling
  -- since then. This is simply the last chance to tidy it, and it is cheap.
  --
  -- Per-leg `may_edit_transaction`, and it does NOT refuse when the answer is
  -- no. `link_transfer` and `unlink_transfer` refuse in that case because half
  -- a transfer is worse than none; here the half already exists either way, so
  -- refusing would only make the bin unemptiable whenever a partner sits in an
  -- account the caller cannot write to. Skipping a leg leaves it exactly as
  -- `delete_account` left it.
  --
  -- `coalesce(category_id, prior_category_id)` and dropping `goal_id` are
  -- `unlink_transfer`'s rules, restated for the same reasons: a category set
  -- while the transfer was linked is the newer answer and wins, and a tag left
  -- on a credit that is no longer part of a transfer would go on filling a pot
  -- with money nothing moved.
  with mine as (
    select distinct transfer_id from public.transactions
     where account_id = a.id and transfer_id is not null
  )
  update public.transactions t
     set transfer_id = null,
         goal_id = null,
         category_id = coalesce(t.category_id, t.prior_category_id),
         prior_category_id = null
   where t.transfer_id in (select transfer_id from mine)
     and t.account_id <> a.id
     and t.deleted_at is null
     and public.may_edit_transaction(t.account_id, t.created_by);
  get diagnostics released = row_count;

  -- ----------------------------------------------------------
  -- The rows themselves, children first
  -- ----------------------------------------------------------
  --
  -- `bills.account_id` and `transactions.account_id` are both `on delete
  -- restrict`, so the account cannot go until they have. Two knock-on effects
  -- follow from the keys and are both what we would have chosen:
  --
  --   `bill_postings`  cascades from the bill, and is the record of which
  --                    occurrence a payment settled — meaningless once both
  --                    the bill and the payment are gone.
  --   `transactions.bill_id`  is `on delete set null`, so a payment recorded in
  --                    somebody else's account against a bill that lived here
  --                    keeps its money and its category and merely stops naming
  --                    a bill. That is a live row changing, and the only
  --                    alternative is refusing to purge because of a link the
  --                    caller may not even be able to see.
  --
  -- `goals.account_id` is `on delete set null` too: the goal keeps its name and
  -- its target and stops naming an account, which is what `delete_account`
  -- already did to it.
  select count(*) into n from public.transactions where account_id = a.id;

  delete from public.bill_postings
   where bill_id in (select id from public.bills where account_id = a.id);

  delete from public.transactions where account_id = a.id;
  delete from public.bills where account_id = a.id;

  -- And the account, taking `account_grants` with it by cascade.
  delete from public.accounts where id = a.id;

  -- Rule 3 above: not a visibility change, a vanished tombstone. Any device
  -- still holding these rows has nothing left to learn the deletion from, and
  -- the epoch is the only signal that survives a row ceasing to exist.
  perform public.bump_epoch(a.household_id);

  return n;
end $$;

comment on function public.purge_account(uuid) is
  'Destroy a deleted account and everything on it, for good. Owner only, bin only, not undoable. Bumps the epoch because it removes the tombstone other devices were going to sync.';

-- ============================================================
-- 2. Grants
-- ============================================================

do $$
begin
  execute 'revoke execute on function public.purge_account(uuid) from anon, public';
  execute 'grant execute on function public.purge_account(uuid) to authenticated';
end $$;
