-- Hearth — wipe the financial data, keep the people
--
-- DEVELOPMENT UTILITY. Deliberately NOT numbered: this is not a migration and
-- must never be part of the 01…09 sequence.
--
-- What it is for: clearing out test data that has accumulated while trying
-- things out — including rows nobody can reach any more, such as an account
-- whose grants were revoked, which RLS quite correctly hides from every client
-- while leaving it in the table forever.
--
-- What it keeps:  auth.users, profiles, households, household_members.
-- What it removes: every account, grant, transaction, bill, budget, goal, rule
--                  and category, plus the bill_postings that tie them together.
--
-- So everyone stays signed in, the household and its invite code survive, and
-- the app comes back looking like a fresh install with the same people in it.
--
-- ============================================================
-- HOW TO USE IT
-- ============================================================
--
--   1. Run this whole file once in the Supabase SQL editor. It installs the
--      function and does nothing else.
--   2. Then run the call you want:
--
--        -- everything, in every household on this project
--        select public.dev_reset_data();
--
--        -- one household only
--        select public.dev_reset_data('00000000-0000-0000-0000-000000000000');
--
--        -- and if you would rather not have the starter categories back
--        select public.dev_reset_data(null, false);
--
--   3. On each device, pull to refresh (or just reopen the app).
--
-- Step 3 is not optional and the function does what it can to force it. These
-- are HARD deletes, not the tombstones the sync protocol expects — the whole
-- point is to leave no rows behind — and a client asking "what changed since
-- my cursor?" is told about nothing, because a deleted row cannot report its
-- own deletion. So the function bumps `visibility_epoch`, which is the one
-- signal that makes a client throw its cache away and pull from scratch.
--
-- A device that is offline when you run this will still be holding the old rows
-- and, worse, may hold queued writes referring to them. Those will dead-letter
-- in Settings. Discarding them there is the right move; nothing is lost that
-- you were not deliberately deleting.
--
-- ============================================================
-- SAFETY
-- ============================================================
--
-- Execute is revoked from `anon` and `authenticated` at the bottom of this file,
-- so nothing in the app can reach it however hard it tries. It runs from the
-- SQL editor, which is the point: `auth.uid()` is null there, which is also why
-- the household cannot be inferred and has to be passed (or left null for all).
--
-- There is no confirmation and no undo. Take a backup first if the project has
-- anything in it you would miss.

create or replace function public.dev_reset_data(
  p_household uuid default null,
  p_reseed_categories boolean default true
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  scope_all boolean := p_household is null;
  n_accounts bigint;
  n_txns bigint;
  n_cats bigint;
  h record;
  seeder uuid;
begin
  if not scope_all and not exists (select 1 from public.households where id = p_household) then
    raise exception 'No such household: %', p_household using errcode = 'P0002';
  end if;

  select count(*) into n_txns from public.transactions
   where scope_all or household_id = p_household;
  select count(*) into n_accounts from public.accounts
   where scope_all or household_id = p_household;

  -- Children before parents. `on delete cascade` would cover most of this, but
  -- spelling out the order means adding a table to the schema and forgetting it
  -- here shows up as a foreign key error rather than as rows that quietly
  -- survive the reset.
  delete from public.bill_postings
   where scope_all or household_id = p_household;

  delete from public.transactions
   where scope_all or household_id = p_household;

  delete from public.bills   where scope_all or household_id = p_household;
  delete from public.budgets where scope_all or household_id = p_household;
  delete from public.goals   where scope_all or household_id = p_household;
  delete from public.rules   where scope_all or household_id = p_household;

  -- account_grants is the one table with no household of its own — an account
  -- belongs to the people granted on it, wherever they happen to be, and 07
  -- left the column off on purpose. Scope it through the account instead.
  delete from public.account_grants g
   where scope_all
      or g.account_id in (select a.id from public.accounts a where a.household_id = p_household);

  delete from public.accounts where scope_all or household_id = p_household;

  select count(*) into n_cats from public.categories
   where scope_all or household_id = p_household;
  delete from public.categories where scope_all or household_id = p_household;

  -- Put the starter categories back, so the app is usable rather than merely
  -- empty. seed_household() needs a user to attribute them to; any member will
  -- do, and a household with no members gets skipped rather than failing.
  if p_reseed_categories then
    for h in select id from public.households where scope_all or id = p_household loop
      select user_id into seeder from public.household_members
       where household_id = h.id and deleted_at is null
       order by joined_at limit 1;
      if seeder is not null then
        perform public.seed_household(h.id, seeder);
      end if;
    end loop;
  end if;

  -- The only signal that makes a client drop its cache and re-pull. Without it
  -- every device carries on showing rows that no longer exist anywhere.
  update public.households
     set visibility_epoch = visibility_epoch + 1
   where scope_all or id = p_household;

  return format(
    'Removed %s transactions, %s accounts and %s categories%s. Reopen the app on every device.',
    n_txns, n_accounts, n_cats,
    case when p_reseed_categories then ', and re-seeded the starter categories' else '' end
  );
end $$;

comment on function public.dev_reset_data(uuid, boolean) is
  'DEV ONLY. Hard-deletes all financial data, keeping users, households and members. SQL editor only.';

-- Unreachable from the app, whatever it sends.
revoke execute on function public.dev_reset_data(uuid, boolean) from anon, public, authenticated;
