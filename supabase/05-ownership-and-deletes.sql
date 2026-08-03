-- Hearth — ownership boundaries on destructive operations (5 of 5)
--
-- A MIGRATION, not a rewrite. Run once, after 04-subcategories-budgets-goals.sql.
-- Safe to run against a household that already has data.
--
-- What was wrong
-- --------------
-- Every privacy guarantee in 02-rls.sql is an RLS policy, and `security definer`
-- turns RLS off. `wipe_household()` is security definer and filtered on nothing
-- but `household_id`, so "Erase everything" tombstoned the OTHER person's
-- private accounts, the transactions on them, and their personal categories,
-- budgets and goals — every single row RLS exists to keep one person out of.
--
-- The lesson generalises, so it is written down rather than fixed once: a
-- security-definer function must repeat in its body every predicate the policies
-- would have applied, because nothing else is going to. Each one below says which
-- policy it is mirroring.
--
-- Three changes:
--   1. wipe_household()  — scoped to what the caller may actually destroy
--   2. delete_account()  — a real per-account delete, with the same scoping
--   3. accounts.owner_id — pinned on update, so a shared account cannot be taken

-- ============================================================
-- 0. Refuse to install against a schema that is missing 04
-- ============================================================
--
-- Everything below touches `goals` and `categories.owner_id`, both added by 04.
-- Postgres does NOT catch that on its own: plpgsql bodies are only syntax-checked
-- at creation time, so without this the file reports success and the first
-- "Erase everything" fails with `column "owner_id" does not exist`. A migration
-- that appears to apply and breaks later is worse than one that refuses.

do $$
begin
  if to_regclass('public.goals') is null
     or not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'categories' and column_name = 'owner_id'
     )
  then
    raise exception
      'Run 04-subcategories-budgets-goals.sql first: this migration builds on the goals table and categories.owner_id'
      using errcode = '42P01';
  end if;
end $$;

-- ============================================================
-- 1. Seeding, made safe to repeat
-- ============================================================
--
-- The re-seed after a wipe used to be unconditional, which was fine only because
-- the wipe removed everything. Now that a wipe leaves the other person's rows
-- alone, an unconditional seed would stack a second set of eleven starter
-- categories on top of theirs every time someone erased.

create or replace function public.seed_household(h uuid, uid uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  -- The starter categories belong to the household, so they are seeded only when
  -- the household has none left. A personal category of someone else's is not a
  -- substitute for them and is not counted here.
  if not exists (
    select 1 from public.categories
     where household_id = h and owner_id is null and deleted_at is null
  ) then
    insert into public.categories (household_id, name, icon, slot, kind, sort_order)
    values
      (h, 'Groceries',        'cart',    2, 'expense', 0),
      (h, 'Home & utilities', 'home',    5, 'expense', 1),
      (h, 'Transport',        'car',     1, 'expense', 2),
      (h, 'Dining out',       'dining',  8, 'expense', 3),
      (h, 'Shopping',         'bag',     7, 'expense', 4),
      (h, 'Subscriptions',    'tv',      6, 'expense', 5),
      (h, 'Health',           'health',  4, 'expense', 6),
      (h, 'Fun & leisure',    'fun',     3, 'expense', 7),
      (h, 'Other',            'package', 1, 'expense', 8),
      (h, 'Salary',           'wallet',  2, 'income',  9),
      (h, 'Other income',     'coins',   4, 'income', 10);
  end if;

  -- A transaction cannot be recorded without an account, so `uid` must be left
  -- with at least one they can post to. An account belonging to the OTHER person
  -- is not one of those, which is why this mirrors my_txn_account_ids() rather
  -- than just counting rows.
  if not exists (
    select 1 from public.accounts
     where household_id = h and deleted_at is null
       and (visibility = 'shared' or owner_id = uid)
  ) then
    insert into public.accounts (household_id, name, kind, visibility, created_by)
    values (h, 'Joint account', 'current', 'shared', uid);
  end if;
end $$;

-- ============================================================
-- 2. Erase everything — the caller's everything, not the household's
-- ============================================================
--
-- "Everything" now means: the shared household data both people own jointly,
-- plus the caller's own private data. It does NOT mean the other person's
-- private accounts, their transactions, or their personal categories, budgets
-- and goals. Those are theirs to delete and nobody else's.

create or replace function public.wipe_household()
returns void
language plpgsql security definer set search_path = public as $$
declare
  hh uuid := public.my_household();
  uid uuid := (select auth.uid());
  mine uuid[];
begin
  if hh is null or uid is null then return; end if;

  -- The accounts this person may destroy: the household's shared ones, and their
  -- own at any visibility. Exactly the predicate in the `accounts_update` policy,
  -- restated because security definer means that policy is not running.
  select coalesce(array_agg(id), '{}'::uuid[]) into mine
    from public.accounts
   where household_id = hh
     and (visibility = 'shared' or owner_id = uid);

  -- Mirrors `transactions_update` / my_txn_account_ids(): a line item on the
  -- partner's private or balance-only account is not readable here, let alone
  -- deletable.
  update public.transactions set deleted_at = now()
   where household_id = hh and deleted_at is null and account_id = any(mine);

  -- Mirrors `budgets_select`: a budget with an owner is that person's alone.
  update public.budgets set deleted_at = now()
   where household_id = hh and deleted_at is null
     and (owner_id is null or owner_id = uid);

  -- Mirrors `goals_select`.
  update public.goals set deleted_at = now()
   where household_id = hh and deleted_at is null
     and (owner_id is null or owner_id = uid);

  -- Rules carry no owner: auto-categorisation is a property of the household, so
  -- there is no personal set to spare.
  update public.rules set deleted_at = now()
   where household_id = hh and deleted_at is null;

  delete from public.bill_postings
   where household_id = hh
     and bill_id in (select id from public.bills where household_id = hh and account_id = any(mine));

  -- Mirrors `bills_select`: a bill follows its account's transaction visibility.
  update public.bills set deleted_at = now()
   where household_id = hh and deleted_at is null and account_id = any(mine);

  update public.accounts set deleted_at = now()
   where id = any(mine) and deleted_at is null;

  -- A personal subcategory of the OTHER person's can hang off a household
  -- category about to be tombstoned. Leaving it orphaned would make it vanish
  -- from their app entirely — the client groups children under a parent it can
  -- find, and drops the ones it cannot — so it is promoted to top level instead,
  -- keeping the colour and icon it was inheriting. (`categories_top_level_has_style`
  -- requires both, which is why the coalesce is not optional.)
  update public.categories c
     set parent_id = null,
         icon = coalesce(c.icon, p.icon),
         slot = coalesce(c.slot, p.slot)
    from public.categories p
   where c.household_id = hh and c.deleted_at is null
     and c.parent_id = p.id
     and c.owner_id is not null and c.owner_id is distinct from uid
     and (p.owner_id is null or p.owner_id = uid)
     and p.deleted_at is null;

  -- Children before parents, so a subcategory is never tombstoned after the
  -- category it points at. Mirrors `categories_select`.
  update public.categories set deleted_at = now()
   where household_id = hh and deleted_at is null and parent_id is not null
     and (owner_id is null or owner_id = uid);
  update public.categories set deleted_at = now()
   where household_id = hh and deleted_at is null
     and (owner_id is null or owner_id = uid);

  perform public.seed_household(hh, uid);
end $$;

-- ============================================================
-- 3. Deleting one account
-- ============================================================
--
-- Server-side and atomic, for two reasons.
--
-- An account and the transactions on it have to go together. A tombstoned
-- account whose transactions are still live is worse than either half alone:
-- `account_balances()` skips the account, but every spending total on the client
-- sums transactions without reference to an account, so the money would keep
-- counting against budgets and reports from an account that no longer exists.
--
-- And this is the only place that can refuse. The sheet offering the button is
-- not what protects anything — anyone can call the API directly.

create or replace function public.delete_account(
  p_account_id uuid,
  p_with_transactions boolean default false
)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  hh uuid := public.my_household();
  uid uuid := (select auth.uid());
  a public.accounts;
  n integer;
begin
  if hh is null or uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into a from public.accounts
   where id = p_account_id and household_id = hh and deleted_at is null
   for update;

  -- Same predicate as the `accounts_update` policy. A private or balance-only
  -- account belonging to the other person is not deletable here, and the message
  -- deliberately does not distinguish "not yours" from "does not exist" — saying
  -- which would confirm the existence of an account they cannot see.
  if a.id is null or not (a.visibility = 'shared' or a.owner_id = uid) then
    raise exception 'That account is not yours to delete' using errcode = '42501';
  end if;

  select count(*) into n from public.transactions
   where account_id = a.id and deleted_at is null;

  -- The caller is told the count and asks again. This fires when the client's
  -- cache said the account was empty and the server disagrees — a partner
  -- recorded something that has not synced yet — which is exactly the case where
  -- deleting silently would destroy work the user never saw.
  if n > 0 and not coalesce(p_with_transactions, false) then
    raise exception '% has % transaction(s) recorded on it', a.name, n
      using errcode = 'P0001';
  end if;

  update public.transactions set deleted_at = now()
   where account_id = a.id and deleted_at is null;

  delete from public.bill_postings
   where household_id = hh and bill_id in (select id from public.bills where account_id = a.id);

  update public.bills set deleted_at = now()
   where account_id = a.id and deleted_at is null;

  -- A goal keeps its name and target and simply stops naming an account. This
  -- can touch the other person's personal goal, and has to: the alternative is a
  -- goal pointing at an account that is gone. Nothing about the goal is lost.
  update public.goals set account_id = null
   where household_id = hh and account_id = a.id and deleted_at is null;

  update public.accounts set deleted_at = now() where id = a.id;

  -- Leave the caller able to record a transaction: if that was their last usable
  -- account, seed a fresh shared one rather than stranding them on a form with
  -- an empty account picker.
  perform public.seed_household(hh, uid);

  return n;
end $$;

-- ============================================================
-- 4. An account cannot be taken from its owner
-- ============================================================
--
-- `accounts_update` lets EITHER person edit a shared account, which is what makes
-- a joint account joint. But `owner_id` was writable, so one person could send
-- `owner_id = me, visibility = 'private'` against a shared account the other
-- created and walk off with it — the account and every transaction on it would
-- vanish from its real owner's app, and RLS would then refuse to give it back.
--
-- Pinning the column here rather than adding a policy is what makes the existing
-- `with check` do the rest: once the owner is pinned to the other person, the
-- `visibility = 'shared' or owner_id = me` clause rejects the change on its own.

create or replace function public.stamp_ownership()
returns trigger language plpgsql set search_path = public as $$
declare
  uid uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    new.household_id = public.my_household();
    if new.household_id is null then
      raise exception 'No household' using errcode = '42501';
    end if;
  else
    new.household_id = old.household_id;
  end if;

  -- The table checks below must be NESTED, not `and`-ed: plpgsql resolves
  -- `new.<field>` when it plans the expression, so a single condition
  -- mentioning `new.created_by` would fail on `categories`, which has no such
  -- column, regardless of how the guard is written.

  -- `created_by` is stamped once and never moves.
  if tg_table_name in ('accounts', 'bills', 'transactions', 'rules', 'goals') then
    if tg_op = 'INSERT' then
      new.created_by = uid;
    else
      new.created_by = old.created_by;
    end if;
  end if;

  -- `owner_id` defaults to the creator. It stays editable for the owner — handing
  -- an account over, or claiming one nobody owns — but an account belonging to
  -- somebody else keeps its owner no matter what the client sends. Budgets and
  -- goals also have an owner_id, but there null is meaningful (it marks a
  -- household row) and their policies already refuse to touch another person's,
  -- so those are left alone.
  if tg_table_name = 'accounts' then
    if tg_op = 'INSERT' then
      if new.owner_id is null then new.owner_id = uid; end if;
    elsif old.owner_id is not null and old.owner_id is distinct from uid then
      new.owner_id = old.owner_id;
    end if;
  end if;

  return new;
end $$;

-- ============================================================
-- 5. Grants
-- ============================================================

do $$
declare f text;
begin
  foreach f in array array['wipe_household()', 'delete_account(uuid,boolean)'] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Still internal only: re-created above, so the revoke has to be re-applied.
revoke execute on function public.seed_household(uuid, uuid) from anon, public, authenticated;
