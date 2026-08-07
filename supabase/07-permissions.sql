-- Hearth — per-member account permissions (7 of 7)
--
-- A MIGRATION. Run once, after 06-category-palette.sql. Safe to re-run.
--
-- What changes
-- ------------
-- Until now the HOUSEHOLD was the authorisation root: every policy began
-- `household_id = my_household()`, so an account was a household row that a
-- person happened to own, and access was one enum — shared / balance / private.
-- That cannot say who may add a transaction, cannot tell editing your own
-- entries from editing everyone's, has no read-only tier, and gives no way to
-- nominate an owner.
--
-- This inverts it. An account belongs to the people GRANTED on it, and the
-- household is only a directory of people you are allowed to share with. Two
-- consequences worth stating up front:
--
--   * Access is deny-by-default. No grant means the account does not exist as
--     far as that person is concerned. §3 backfills grants for every account
--     that exists today and REFUSES TO INSTALL if that would leave anyone
--     locked out — the failure mode here is silent empty lists, not an error.
--
--   * Leaving a household no longer costs you your own accounts. They are
--     yours, so they travel with you (§8, depart_household).
--
-- A household admin manages PEOPLE and nothing else. They get no read or write
-- access to any account they were not granted — the only way an admin's action
-- touches an account is the departure cascade, which changes other people's
-- grants without ever granting the admin anything.
--
-- And, as always: `security definer` turns RLS off, so every definer function
-- below restates in its body the predicate its policy would have applied. §7 is
-- a checklist, not prose.

-- ============================================================
-- 0. Refuse to install against a schema that is missing 05 or 06
-- ============================================================
--
-- plpgsql bodies are only syntax-checked at creation time, so without this the
-- file would report success and fail at runtime — see the same guard at the top
-- of 05-ownership-and-deletes.sql for why that is worse than refusing.

do $$
begin
  if to_regprocedure('public.delete_account(uuid,boolean)') is null
     or not exists (
       select 1 from pg_constraint
        where conrelid = 'public.categories'::regclass
          and conname = 'categories_slot_check'
          and pg_get_constraintdef(oid) like '%12%'
     )
  then
    raise exception
      'Run 05-ownership-and-deletes.sql and 06-category-palette.sql first: this migration rewrites delete_account() and assumes the widened palette'
      using errcode = '42P01';
  end if;
end $$;

-- ============================================================
-- 1. Types and tables
-- ============================================================

do $$ begin
  if not exists (select 1 from pg_type where typname = 'member_role') then
    create type public.member_role as enum ('member', 'admin');
  end if;
end $$;

-- An ORDERED enum, not a smallint rank. Postgres orders an enum by declaration
-- order, so `level >= 'contribute'` is a native, btree-indexable comparison
-- with no lookup table to keep in step — and a second representation of the
-- same fact is exactly the drift that broke `categories.slot` against the
-- palette. The cost, worth writing down: `alter type ... add value` cannot be
-- used in the same transaction that uses the new value, so inserting a level
-- later needs its own migration file.
--
-- 'none' is an ARGUMENT, never a stored value: absence of a live row is the
-- only representation of no access. Passing 'none' to upsert_account_grant()
-- tombstones the grant.
do $$ begin
  if not exists (select 1 from pg_type where typname = 'access_level') then
    create type public.access_level as enum
      ('none', 'balance', 'view', 'contribute', 'manage', 'owner');
  end if;
end $$;

-- ---------- household_members ----------
--
-- `profiles.household_id` stays the authoritative "which household am I in"
-- pointer — my_household() is called by every policy and every definer
-- function, and re-pointing it at a join table would be the widest possible
-- blast radius. This table is a trigger-maintained PROJECTION of it that adds
-- the two things profiles cannot carry: a role, and a tombstone the client can
-- sync. It cannot drift, because a trigger maintains it rather than an RPC.

create table if not exists public.household_members (
  -- Surrogate key rather than (household_id, user_id): the Dexie cache is keyed
  -- by `id`, the pull pages on (updated_at, id), and api.patchRow does
  -- .eq('id', …). Every synced table in this schema looks like this.
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Denormalised from profiles so the client needs one table, not two.
  display_name text,
  role public.member_role not null default 'member',
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Partial, so someone who left can rejoin the same household later.
create unique index if not exists household_members_unique
  on public.household_members (household_id, user_id) where deleted_at is null;
create index if not exists household_members_pull
  on public.household_members (household_id, updated_at, id);

-- ---------- account_grants ----------
--
-- Deliberately has NO household_id. A grant is a fact about a person and an
-- account, and it has to survive that person changing households — which is the
-- whole point of this migration. Scoping it to a household would re-introduce
-- the coupling being removed here.

create table if not exists public.account_grants (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  level public.access_level not null check (level <> 'none'),
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists account_grants_unique
  on public.account_grants (account_id, user_id) where deleted_at is null;
-- The hot path: my_account_ids() reads this once per query.
create index if not exists account_grants_mine
  on public.account_grants (user_id, account_id) where deleted_at is null;
create index if not exists account_grants_account
  on public.account_grants (account_id) where deleted_at is null;
create index if not exists account_grants_pull
  on public.account_grants (user_id, updated_at, id);

-- Neither table gets stamp_ownership: household_members has its household set
-- by the projection trigger, and account_grants has no household at all.
drop trigger if exists household_members_touch on public.household_members;
create trigger household_members_touch before insert or update on public.household_members
  for each row execute function public.touch_updated_at();

drop trigger if exists account_grants_touch on public.account_grants;
create trigger account_grants_touch before insert or update on public.account_grants
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 2. Membership projection
-- ============================================================

create or replace function public.project_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.household_id is not null
     and old.household_id is distinct from new.household_id then
    update public.household_members
       set deleted_at = now()
     where household_id = old.household_id and user_id = new.id and deleted_at is null;
  end if;

  if new.household_id is not null then
    insert into public.household_members (household_id, user_id, display_name)
    values (new.household_id, new.id, new.display_name)
    on conflict (household_id, user_id) where deleted_at is null
    -- `role` is deliberately absent from the update list: it belongs to this
    -- table, not to profiles, so renaming yourself must not demote you.
    do update set display_name = excluded.display_name;
  end if;
  return null;
end $$;

drop trigger if exists profiles_project_membership on public.profiles;
create trigger profiles_project_membership
  after insert or update of household_id, display_name on public.profiles
  for each row execute function public.project_membership();

-- Backfill the projection for everyone who already belongs somewhere.
insert into public.household_members (household_id, user_id, display_name)
select p.household_id, p.id, p.display_name
  from public.profiles p
 where p.household_id is not null
on conflict (household_id, user_id) where deleted_at is null do nothing;

-- Exactly one admin per household, and it is whoever set the household up.
--
-- Admin is a strictly NEW power, so it goes to as few people as possible. The
-- most reliable creator signal in the schema is who created the household's
-- first account, because create_household() seeded one with created_by = the
-- caller; the earliest profile is the fallback.
with founder as (
  select h.id as household_id,
         coalesce(
           (select a.created_by from public.accounts a
             where a.household_id = h.id and a.created_by is not null
             order by a.created_at, a.id limit 1),
           (select p.id from public.profiles p
             where p.household_id = h.id order by p.created_at, p.id limit 1)
         ) as user_id
    from public.households h
)
update public.household_members m set role = 'admin'
  from founder f
 where m.household_id = f.household_id
   and m.user_id = f.user_id
   and m.deleted_at is null;

-- ============================================================
-- 3. Backfill the grants — and refuse to install if it is wrong
-- ============================================================
--
-- This runs BEFORE the policies are swapped, on purpose. If the mapping is
-- wrong the file raises here with the old, working policies still installed.
-- Deny-by-default means a mistake in this block does not produce an error
-- anyone will see: it produces empty lists and an account picker with nothing
-- in it, which is why both assertions below exist.

with mapped as (
  select a.id as account_id, m.user_id, a.owner_id,
         case
           -- Today EITHER person may edit and erase a shared account and
           -- everything on it. 'owner' for everyone is the only mapping that
           -- preserves that exactly; anything less silently takes away a
           -- capability people have right now.
           when a.visibility = 'shared'  then 'owner'::public.access_level
           when a.owner_id = m.user_id   then 'owner'::public.access_level
           when a.visibility = 'balance' then 'balance'::public.access_level
           else null  -- 'private' and not yours: no grant at all
         end as level
    from public.accounts a
    join public.household_members m
      on m.household_id = a.household_id and m.deleted_at is null
)
insert into public.account_grants (account_id, user_id, level, granted_by)
select account_id, user_id, level, owner_id
  from mapped where level is not null
on conflict (account_id, user_id) where deleted_at is null do nothing;

-- Tombstoned accounts are included on purpose: a deleted account must stay
-- selectable by everyone who cached it, or their device never learns it is
-- gone. Any account the mapping left with no owner at all — an owner_id nulled
-- by a deleted auth user — goes to every member, matching how a shared account
-- behaved.
insert into public.account_grants (account_id, user_id, level)
select a.id, m.user_id, 'owner'
  from public.accounts a
  join public.household_members m
    on m.household_id = a.household_id and m.deleted_at is null
 where not exists (
   select 1 from public.account_grants g
    where g.account_id = a.id and g.deleted_at is null
 )
on conflict (account_id, user_id) where deleted_at is null do nothing;

do $$
declare orphans bigint; blind bigint;
begin
  select count(*) into orphans from public.accounts a
   where not exists (
     select 1 from public.account_grants g
      where g.account_id = a.id and g.deleted_at is null and g.level = 'owner'
   );
  if orphans > 0 then
    raise exception 'Backfill left % account(s) with no owner — refusing to install', orphans
      using errcode = 'P0001';
  end if;

  -- Scoped to households that actually have an account: since this migration a
  -- household with none is legitimate (nothing is auto-created any more).
  select count(*) into blind from public.household_members m
   where m.deleted_at is null
     and exists (
       select 1 from public.accounts a
        where a.household_id = m.household_id and a.deleted_at is null
     )
     and not exists (
       select 1 from public.account_grants g
        where g.user_id = m.user_id and g.deleted_at is null and g.level >= 'contribute'
     );
  if blind > 0 then
    raise exception '% member(s) would be left with no account they can post to — refusing to install', blind
      using errcode = 'P0001';
  end if;
end $$;

-- ============================================================
-- 4. Helper functions
-- ============================================================
--
-- security definer so the policies can call them without recursing into the
-- policies on account_grants, and so the `(select …)` InitPlan convention of
-- 02-rls.sql keeps working: the scalar is hoisted and evaluated once per query
-- rather than once per row.

-- Accounts the caller may act on at `min_level` or above.
--
-- Replaces my_txn_account_ids(). Note what is NOT here: any mention of a
-- household. An account belongs to the people granted on it, wherever they
-- happen to be, and keeping the household out of this predicate is what stops a
-- stale household_id locking somebody out of their own account.
--
-- Deliberately does not filter deleted_at either — a tombstoned account must
-- stay selectable, or the other device never learns it is gone.
create or replace function public.my_account_ids(min_level public.access_level)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select g.account_id from public.account_grants g
   where g.user_id = (select auth.uid())
     and g.deleted_at is null
     and g.level >= min_level
$$;

-- Kept as a shim so anything still calling it gets the NEW semantics rather
-- than the old ones. Every in-tree caller is rewritten below.
create or replace function public.my_txn_account_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select public.my_account_ids('view')
$$;

-- Does this account have any live grant at all?
--
-- security definer because it is called from accounts_select: a plain subquery
-- there would be filtered by account_grants' own policy, so a caller who simply
-- cannot SEE somebody else's grant would conclude there is none.
create or replace function public.account_has_grants(a uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.account_grants g
     where g.account_id = a and g.deleted_at is null
  )
$$;

-- Membership administration ONLY. This grants nothing on any account, ever —
-- it is not consulted by my_account_ids() and must never be.
create or replace function public.is_household_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_members m
     where m.user_id = (select auth.uid())
       and m.household_id = public.my_household()
       and m.deleted_at is null
       and m.role = 'admin'
  )
$$;

-- ============================================================
-- 5. Policies
-- ============================================================
--
-- The household conjunct is REMOVED from accounts, transactions and bills. It
-- was the authorisation root; it is now not even useful as a filter, because a
-- grant is already narrower than a household and the conjunct would break the
-- moment an account travels with its owner.

alter table public.household_members enable row level security;
alter table public.account_grants enable row level security;

-- ---------- accounts ----------
drop policy if exists accounts_select on public.accounts;
drop policy if exists accounts_insert on public.accounts;
drop policy if exists accounts_update on public.accounts;

-- 'balance' is the floor: the account row and its total are visible one tier
-- below its transactions. That gap IS the balance-only tier.
--
-- The second disjunct is not an afterthought, it is load-bearing. RLS applies
-- the SELECT policy to the rows an `insert … returning` projects, and the
-- creator's owner grant is written by an AFTER trigger — which has not run at
-- that point. Without this, creating an account fails outright: PostgREST asks
-- for the row back on every insert, so the client could never make one.
--
-- It is written as "an account you created that nobody holds any grant on",
-- which by construction exists for exactly that one instant. It doubles as the
-- only route back for an account whose grants all somehow went away, which
-- would otherwise be permanently unreachable by anybody.
create policy accounts_select on public.accounts
  for select to authenticated
  using (
    id in (select public.my_account_ids('balance'))
    or (created_by = (select auth.uid()) and not public.account_has_grants(id))
  );

-- A new account has no grant yet — the after-insert trigger writes the
-- creator's. Both columns below are stamped by stamp_ownership, so this checks
-- what the trigger produced rather than what the client sent.
create policy accounts_insert on public.accounts
  for insert to authenticated
  with check (
    household_id = (select public.my_household())
    and created_by = (select auth.uid())
  );

-- Renaming, re-typing, changing the opening balance: 'manage'. Changing WHO can
-- see it is a write to account_grants, which has no insert or update policy at
-- all — so 'manage' has no route to escalate itself.
create policy accounts_update on public.accounts
  for update to authenticated
  using      (id in (select public.my_account_ids('manage')))
  with check (id in (select public.my_account_ids('manage')));

-- ---------- transactions ----------
drop policy if exists transactions_select on public.transactions;
drop policy if exists transactions_insert on public.transactions;
drop policy if exists transactions_update on public.transactions;

create policy transactions_select on public.transactions
  for select to authenticated
  using (account_id in (select public.my_account_ids('view')));

create policy transactions_insert on public.transactions
  for insert to authenticated
  with check (account_id in (select public.my_account_ids('contribute')));

-- The 'contribute' tier, in one expression: manage edits anything, contribute
-- edits only what it added. `created_by` is pinned by stamp_ownership on
-- update, so it cannot be rewritten to dodge this. Soft delete is an UPDATE, so
-- "you may delete only what you added" falls out with nothing extra.
--
-- The with-check half is NOT redundant with the using half. Without it a
-- contributor could move their own transaction onto an account they merely
-- view, writing a row into it sideways.
create policy transactions_update on public.transactions
  for update to authenticated
  using (
    account_id in (select public.my_account_ids('manage'))
    or (account_id in (select public.my_account_ids('contribute'))
        and created_by = (select auth.uid()))
  )
  with check (
    account_id in (select public.my_account_ids('manage'))
    or (account_id in (select public.my_account_ids('contribute'))
        and created_by = (select auth.uid()))
  );

-- ---------- bills ----------
-- A bill is a standing instruction to write transactions, so it follows the
-- same ladder as the transactions it produces.
drop policy if exists bills_select on public.bills;
drop policy if exists bills_insert on public.bills;
drop policy if exists bills_update on public.bills;

create policy bills_select on public.bills
  for select to authenticated
  using (account_id in (select public.my_account_ids('view')));

create policy bills_insert on public.bills
  for insert to authenticated
  with check (account_id in (select public.my_account_ids('contribute')));

create policy bills_update on public.bills
  for update to authenticated
  using (
    account_id in (select public.my_account_ids('manage'))
    or (account_id in (select public.my_account_ids('contribute'))
        and created_by = (select auth.uid()))
  )
  with check (
    account_id in (select public.my_account_ids('manage'))
    or (account_id in (select public.my_account_ids('contribute'))
        and created_by = (select auth.uid()))
  );

-- ---------- bill_postings ----------
-- Still defers entirely to the bills policy above.
drop policy if exists bill_postings_select on public.bill_postings;
create policy bill_postings_select on public.bill_postings
  for select to authenticated
  using (bill_id in (select id from public.bills));

-- ---------- the new tables ----------
drop policy if exists household_members_select on public.household_members;
create policy household_members_select on public.household_members
  for select to authenticated
  using (household_id = (select public.my_household()));

-- You always see your OWN grants, on anything. You see other people's only
-- where you could change them anyway. Strictly narrower than "everyone sees the
-- whole sharing list"; the cost is that a view-level member cannot tell who
-- else is looking, which is the deny-by-default reading of the question.
drop policy if exists account_grants_select on public.account_grants;
create policy account_grants_select on public.account_grants
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or account_id in (select public.my_account_ids('manage'))
  );

-- No INSERT or UPDATE policy on either table, and no DELETE policy anywhere.
-- Every write goes through a security-definer RPC carrying its own gate, for
-- the same reason `households` has no UPDATE policy: making it physically
-- impossible beats making it discouraged.

-- ============================================================
-- 6. Triggers
-- ============================================================

-- The creator of an account owns it. Without this the insert policy would let
-- you create an account you then could not see.
create or replace function public.grant_creator_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare uid uuid := coalesce(new.created_by, (select auth.uid()));
begin
  if uid is null then return null; end if;
  insert into public.account_grants (account_id, user_id, level, granted_by)
  values (new.id, uid, 'owner', uid)
  on conflict (account_id, user_id) where deleted_at is null do nothing;
  -- Deliberately does NOT bump the epoch: nothing anyone had cached has
  -- changed, and bumping here would make creating an account wipe your own
  -- cache and re-pull the world.
  return null;
end $$;

drop trigger if exists accounts_grant_creator on public.accounts;
create trigger accounts_grant_creator after insert on public.accounts
  for each row execute function public.grant_creator_owner();

-- accounts_epoch_trigger watched visibility/owner_id, both inert from here on,
-- so it can never fire again.
drop trigger if exists accounts_epoch on public.accounts;

-- Moving a transaction between accounts can expose or hide it — but only when
-- the set of people who may READ it actually differs.
create or replace function public.transactions_epoch_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.account_id is distinct from new.account_id then
    if (select array_agg(user_id order by user_id) from public.account_grants
         where account_id = old.account_id and deleted_at is null and level >= 'view')
       is distinct from
       (select array_agg(user_id order by user_id) from public.account_grants
         where account_id = new.account_id and deleted_at is null and level >= 'view')
    then
      perform public.bump_epoch(new.household_id);
    end if;
  end if;
  return null;
end $$;

-- Someone holding an account at exactly 'balance' gets no realtime event for
-- its transactions, so touching the account row is their only signal that the
-- total moved. Statement-level with a transition table, unchanged in shape.
create or replace function public.touch_balance_accounts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.accounts a
     set updated_at = now()
   where a.id in (select account_id from changed_rows)
     and exists (
       select 1 from public.account_grants g
        where g.account_id = a.id and g.deleted_at is null and g.level = 'balance'
     );
  return null;
end $$;

-- A personal category may be used only on an account granted to its owner and
-- to NOBODY else. With no admin override anywhere in this file, "an account
-- nobody else shares" is now literally true, and the client copy can say so.
create or replace function public.personal_category_guard()
returns trigger language plpgsql set search_path = public as $$
declare cat_owner uuid;
begin
  if new.category_id is null then return new; end if;

  select owner_id into cat_owner from public.categories where id = new.category_id;
  if cat_owner is null then return new; end if;

  if not exists (
       select 1 from public.account_grants g
        where g.account_id = new.account_id and g.deleted_at is null
          and g.user_id = cat_owner and g.level >= 'contribute')
     or exists (
       select 1 from public.account_grants g
        where g.account_id = new.account_id and g.deleted_at is null
          and g.user_id <> cat_owner)
  then
    raise exception 'A personal category can only be used on an account nobody else shares'
      using errcode = '23514';
  end if;
  return new;
end $$;

-- stamp_ownership, with two changes.
--
--   * accounts.visibility and accounts.owner_id are DEPRECATED by this
--     migration and pinned inert. They are not dropped yet: an old tab's outbox
--     can still hold a queued accounts patch carrying them, and a dropped
--     column turns that into a 400 and a dead letter, whereas a pinned one
--     makes it a harmless no-op that still matches a row so assertMatched
--     passes and the queue drains. 08 drops them.
--
--   * depart_household() moves rows between households on purpose, and sets a
--     transaction-local flag while it does. Nothing else may.
create or replace function public.stamp_ownership()
returns trigger language plpgsql set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  moving boolean := coalesce(current_setting('hearth.moving', true), '') = 'on';
begin
  if moving then
    -- Leave household_id exactly as supplied.
    null;
  elsif tg_op = 'INSERT' then
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

  -- `created_by` is stamped once and never moves. transactions_update leans on
  -- this: the contribute tier is only enforceable because the column cannot be
  -- rewritten.
  if tg_table_name in ('accounts', 'bills', 'transactions', 'rules', 'goals') then
    if tg_op = 'INSERT' then
      if new.created_by is null then new.created_by = uid; end if;
    else
      new.created_by = old.created_by;
    end if;
  end if;

  if tg_table_name = 'accounts' then
    if tg_op = 'INSERT' then
      new.visibility = 'shared';
      new.owner_id = coalesce(new.owner_id, uid);
    else
      new.visibility = old.visibility;
      new.owner_id = old.owner_id;
    end if;
  end if;

  return new;
end $$;

-- ============================================================
-- 7. Definer functions, restated against the new predicates
-- ============================================================

-- No account is ever created for anybody. The Joint account this used to seed
-- was the app deciding what your money looks like; people create their own now.
-- Categories are still seeded, because a transaction with no category is
-- ordinary but a category list with nothing in it is not.
create or replace function public.seed_household(h uuid, uid uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
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
end $$;

create or replace function public.wipe_household()
returns void
language plpgsql security definer set search_path = public as $$
declare
  hh uuid := public.my_household();
  uid uuid := (select auth.uid());
  mine uuid[];
begin
  if hh is null or uid is null then return; end if;

  -- The accounts this person may destroy. Mirrors delete_account()'s gate:
  -- owning an account is what entitles you to erase it.
  select coalesce(array_agg(g.account_id), '{}'::uuid[]) into mine
    from public.account_grants g
   where g.user_id = uid and g.deleted_at is null and g.level = 'owner';

  update public.transactions set deleted_at = now()
   where deleted_at is null and account_id = any(mine);

  -- Mirrors budgets_select: a budget with an owner is that person's alone.
  update public.budgets set deleted_at = now()
   where household_id = hh and deleted_at is null
     and (owner_id is null or owner_id = uid);

  -- Mirrors goals_select.
  update public.goals set deleted_at = now()
   where household_id = hh and deleted_at is null
     and (owner_id is null or owner_id = uid);

  -- Rules carry no owner: auto-categorisation is a property of the household.
  update public.rules set deleted_at = now()
   where household_id = hh and deleted_at is null;

  delete from public.bill_postings
   where bill_id in (select id from public.bills where account_id = any(mine));

  update public.bills set deleted_at = now()
   where deleted_at is null and account_id = any(mine);

  update public.accounts set deleted_at = now()
   where id = any(mine) and deleted_at is null;

  -- account_grants is deliberately left alone. accounts_select now requires a
  -- grant, so revoking here would leave everyone else's cache holding the
  -- account forever with no tombstone they are allowed to read.

  -- A personal subcategory of somebody else's can hang off a household category
  -- about to be tombstoned. Orphaning it would make it vanish from their app
  -- entirely, so it is promoted to top level, keeping the colour and icon it
  -- was inheriting (categories_top_level_has_style requires both).
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

  -- Children before parents. Mirrors categories_select.
  update public.categories set deleted_at = now()
   where household_id = hh and deleted_at is null and parent_id is not null
     and (owner_id is null or owner_id = uid);
  update public.categories set deleted_at = now()
   where household_id = hh and deleted_at is null
     and (owner_id is null or owner_id = uid);

  perform public.seed_household(hh, uid);
end $$;

create or replace function public.delete_account(
  p_account_id uuid,
  p_with_transactions boolean default false
)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  a public.accounts;
  n integer;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into a from public.accounts
   where id = p_account_id and deleted_at is null
   for update;

  -- Owning it is what entitles you to erase it. The message deliberately does
  -- not distinguish "not yours" from "does not exist" — saying which would
  -- confirm the existence of an account the caller cannot see.
  if a.id is null or a.id not in (select public.my_account_ids('owner')) then
    raise exception 'That account is not yours to delete' using errcode = '42501';
  end if;

  select count(*) into n from public.transactions
   where account_id = a.id and deleted_at is null;

  -- The caller is told the count and asks again. This fires when the client's
  -- cache said the account was empty and the server disagrees — somebody else
  -- recorded something that has not synced yet — which is exactly the case
  -- where deleting silently would destroy work the user never saw.
  if n > 0 and not coalesce(p_with_transactions, false) then
    raise exception '% has % transaction(s) recorded on it', a.name, n
      using errcode = 'P0001';
  end if;

  update public.transactions set deleted_at = now()
   where account_id = a.id and deleted_at is null;

  delete from public.bill_postings
   where bill_id in (select id from public.bills where account_id = a.id);

  update public.bills set deleted_at = now()
   where account_id = a.id and deleted_at is null;

  -- A goal keeps its name and target and simply stops naming an account. This
  -- can touch somebody else's personal goal, and has to: the alternative is a
  -- goal pointing at an account that is gone.
  update public.goals set account_id = null
   where account_id = a.id and deleted_at is null;

  update public.accounts set deleted_at = now() where id = a.id;

  -- Grants are left alone, for the same reason as in wipe_household(): every
  -- device that cached this account must stay able to read its tombstone.
  -- Nothing is re-seeded either — an account is never created for anybody.
  return n;
end $$;

-- Both legs at 'contribute'. This is a FIX rather than a translation: the old
-- body used my_txn_account_ids(), which meant write access under the old model
-- but means read-only under the new one — a transfer would have become a way to
-- write into an account you may only look at.
create or replace function public.create_transfer(
  p_out_id uuid,
  p_in_id uuid,
  p_from_account uuid,
  p_to_account uuid,
  p_amount_minor bigint,
  p_on_date date,
  p_note text default null,
  p_goal_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  hh uuid := public.my_household();
  uid uuid := (select auth.uid());
  transfer uuid := gen_random_uuid();
  from_name text;
  to_name text;
begin
  if uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if p_amount_minor <= 0 then
    raise exception 'A transfer must be a positive amount' using errcode = '23514';
  end if;
  if p_from_account = p_to_account then
    raise exception 'Cannot transfer to the same account' using errcode = '23514';
  end if;

  select name into from_name from public.accounts
    where id = p_from_account and id in (select public.my_account_ids('contribute'));
  select name into to_name from public.accounts
    where id = p_to_account and id in (select public.my_account_ids('contribute'));
  if from_name is null or to_name is null then
    raise exception 'Unknown account' using errcode = '42501';
  end if;

  insert into public.transactions
    (id, household_id, account_id, occurred_on, payee, note, amount_minor, transfer_id, created_by)
  values
    (p_out_id, hh, p_from_account, p_on_date, 'Transfer to ' || to_name, p_note, -p_amount_minor, transfer, uid)
  on conflict (id) do nothing;

  insert into public.transactions
    (id, household_id, account_id, occurred_on, payee, note, amount_minor, transfer_id, goal_id, created_by)
  values
    (p_in_id, hh, p_to_account, p_on_date, 'Transfer from ' || from_name, p_note, p_amount_minor, transfer, p_goal_id, uid)
  on conflict (id) do nothing;

  return transfer;
end $$;

-- The 'balance' predicate here IS the balance-only tier: the sum is computed
-- over transactions RLS would hide, and returned as an aggregate only.
create or replace function public.account_balances()
returns table (account_id uuid, balance_minor bigint)
language sql stable security definer set search_path = public as $$
  select a.id,
         a.opening_balance_minor + coalesce(sum(t.amount_minor) filter (where t.deleted_at is null), 0)
  from public.accounts a
  left join public.transactions t on t.account_id = a.id
  where a.deleted_at is null
    and a.id in (select public.my_account_ids('balance'))
  group by a.id, a.opening_balance_minor
$$;

-- Restricted to accounts the caller may post to. This closes a real hole: the
-- old body looped over every auto-post bill in the household, so opening the
-- app wrote transactions into accounts the caller could not read. The accepted
-- consequence is that such a bill now posts when someone who can contribute to
-- it opens the app, rather than when anyone does.
create or replace function public.post_due_bills(p_until date default current_date)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  b record;
  due date;
  txn uuid;
  guard integer;
  posted integer := 0;
begin
  if uid is null then return 0; end if;

  for b in
    select * from public.bills
     where deleted_at is null and active and auto_post and next_due <= p_until
       and account_id in (select public.my_account_ids('contribute'))
     for update
  loop
    due := b.next_due;
    guard := 0;
    while due <= p_until and guard < 60 loop
      guard := guard + 1;

      insert into public.transactions
        (household_id, account_id, category_id, bill_id, occurred_on, payee, note, amount_minor, created_by)
      values
        (b.household_id, b.account_id, b.category_id, b.id, due,
         coalesce(nullif(b.payee, ''), b.name), b.name, b.amount_minor, uid)
      returning id into txn;

      insert into public.bill_postings (bill_id, due_on, household_id, transaction_id)
      values (b.id, due, b.household_id, txn)
      on conflict (bill_id, due_on) do nothing;

      if not found then
        delete from public.transactions where id = txn;
      else
        posted := posted + 1;
      end if;

      due := public.advance_due(due, b.freq);
    end loop;

    update public.bills set next_due = due where id = b.id;
  end loop;

  return posted;
end $$;

-- P0002 rather than 42501 on refusal, so a caller cannot use the error to
-- confirm that a bill they may not see exists.
create or replace function public.post_bill(p_bill_id uuid, p_on_date date default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  b public.bills;
  txn uuid;
begin
  select * into b from public.bills
   where id = p_bill_id
     and account_id in (select public.my_account_ids('contribute'))
   for update;
  if b.id is null then raise exception 'Unknown bill' using errcode = 'P0002'; end if;

  insert into public.transactions
    (household_id, account_id, category_id, bill_id, occurred_on, payee, note, amount_minor, created_by)
  values
    (b.household_id, b.account_id, b.category_id, b.id, coalesce(p_on_date, b.next_due),
     coalesce(nullif(b.payee, ''), b.name), b.name, b.amount_minor, (select auth.uid()))
  returning id into txn;

  insert into public.bill_postings (bill_id, due_on, household_id, transaction_id)
  values (b.id, b.next_due, b.household_id, txn)
  on conflict (bill_id, due_on) do nothing;

  if not found then
    delete from public.transactions where id = txn;
    return null;
  end if;

  update public.bills set next_due = public.advance_due(b.next_due, b.freq) where id = b.id;
  return txn;
end $$;

-- Restates bills_update exactly: skipping is editing the bill.
create or replace function public.skip_bill(p_bill_id uuid)
returns date
language plpgsql security definer set search_path = public as $$
-- `next` would be read as the RETURN NEXT keyword, hence `following`.
declare b public.bills; following date; uid uuid := (select auth.uid());
begin
  select * into b from public.bills
   where id = p_bill_id
     and ( account_id in (select public.my_account_ids('manage'))
        or (account_id in (select public.my_account_ids('contribute')) and created_by = uid) )
   for update;
  if b.id is null then raise exception 'Unknown bill' using errcode = 'P0002'; end if;
  following := public.advance_due(b.next_due, b.freq);
  update public.bills set next_due = following where id = b.id;
  return following;
end $$;

-- Still security INVOKER — RLS applying is the entire point, since the client
-- compares these counts against its own cache, which is also RLS-filtered.
create or replace function public.sync_checksums()
returns table (table_name text, live_rows bigint, max_updated_at timestamptz)
language sql stable set search_path = public as $$
  select 'categories',        count(*), max(updated_at) from public.categories        where deleted_at is null
  union all
  select 'accounts',          count(*), max(updated_at) from public.accounts          where deleted_at is null
  union all
  select 'bills',             count(*), max(updated_at) from public.bills             where deleted_at is null
  union all
  select 'transactions',      count(*), max(updated_at) from public.transactions      where deleted_at is null
  union all
  select 'budgets',           count(*), max(updated_at) from public.budgets           where deleted_at is null
  union all
  select 'rules',             count(*), max(updated_at) from public.rules             where deleted_at is null
  union all
  select 'goals',             count(*), max(updated_at) from public.goals             where deleted_at is null
  union all
  select 'household_members', count(*), max(updated_at) from public.household_members where deleted_at is null
  union all
  select 'account_grants',    count(*), max(updated_at) from public.account_grants    where deleted_at is null
$$;

-- ============================================================
-- 8. Membership, and what happens when somebody leaves
-- ============================================================

/**
 * Everything that has to happen when `p_user_id` stops being a member.
 *
 * The rules, in the order they are applied:
 *
 *   1. Their non-owner grants are revoked. You do not keep access to somebody
 *      else's account by having once been in a household with them.
 *   2. An account they own ALONE goes with them: everyone else's grants on it
 *      are revoked, and the account, its transactions, bills and postings move
 *      to their new household.
 *   3. An account they co-own with an owner who is staying stays put, and their
 *      own grant on it is revoked.
 *   4. They keep a working copy of the taxonomy: the household's categories are
 *      copied into their new household and the transactions they took with them
 *      are repointed at the copies, so their history does not lose its category
 *      names. Their own personal categories, budgets and goals move outright.
 *
 * This is the one function here that can corrupt rather than merely deny — it
 * moves rows between households and rewrites foreign keys — which is why it is
 * online-only, and why 99d asserts each rule separately.
 */
create or replace function public.depart_household(p_user_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  old_hh uuid;
  new_hh uuid;
  keep uuid[];
begin
  select household_id into old_hh from public.profiles where id = p_user_id;
  if old_hh is null then return null; end if;

  -- Rule 2's set: accounts they own with no other owner staying behind.
  select coalesce(array_agg(g.account_id), '{}'::uuid[]) into keep
    from public.account_grants g
   where g.user_id = p_user_id and g.deleted_at is null and g.level = 'owner'
     and not exists (
       select 1
         from public.account_grants o
         join public.profiles p on p.id = o.user_id
        where o.account_id = g.account_id and o.deleted_at is null
          and o.level = 'owner' and o.user_id <> p_user_id
          and p.household_id = old_hh
     );

  -- Rules 1 and 3: everything they are not taking with them.
  update public.account_grants set deleted_at = now()
   where user_id = p_user_id and deleted_at is null
     and not (account_id = any(keep));

  -- Rule 2: an account that leaves takes nobody else's access with it.
  update public.account_grants set deleted_at = now()
   where account_id = any(keep) and user_id <> p_user_id and deleted_at is null;

  insert into public.households (name, join_code)
  values ('My household', public.new_join_code())
  returning id into new_hh;

  -- Moving rows between households is exactly what stamp_ownership exists to
  -- prevent, so the flag is set for the rest of this transaction only.
  perform set_config('hearth.moving', 'on', true);

  update public.accounts      set household_id = new_hh where id = any(keep);
  update public.transactions  set household_id = new_hh where account_id = any(keep);
  update public.bills         set household_id = new_hh where account_id = any(keep);
  update public.bill_postings set household_id = new_hh
   where bill_id in (select id from public.bills where account_id = any(keep));

  -- Rule 4. Copy the household's categories rather than moving them — the
  -- people staying behind need theirs untouched. Parents first: a child may
  -- carry a null icon/slot, which categories_top_level_has_style only permits
  -- while it has a parent to inherit from.
  create temp table if not exists departing_categories (old_id uuid primary key, new_id uuid) on commit drop;
  delete from departing_categories;

  insert into departing_categories (old_id, new_id)
  select id, gen_random_uuid() from public.categories
   where household_id = old_hh and deleted_at is null and owner_id is null;

  insert into public.categories (id, household_id, name, icon, slot, kind, sort_order, parent_id)
  select m.new_id, new_hh, c.name, c.icon, c.slot, c.kind, c.sort_order, null
    from public.categories c join departing_categories m on m.old_id = c.id
   where c.parent_id is null;

  insert into public.categories (id, household_id, name, icon, slot, kind, sort_order, parent_id)
  select m.new_id, new_hh, c.name, c.icon, c.slot, c.kind, c.sort_order,
         (select p.new_id from departing_categories p where p.old_id = c.parent_id)
    from public.categories c join departing_categories m on m.old_id = c.id
   where c.parent_id is not null;

  -- Their own categories move outright, re-parented onto the copies.
  update public.categories c
     set household_id = new_hh,
         parent_id = (select m.new_id from departing_categories m where m.old_id = c.parent_id)
   where c.household_id = old_hh and c.deleted_at is null and c.owner_id = p_user_id;

  -- The transactions that travelled point at the copies.
  update public.transactions t
     set category_id = m.new_id
    from departing_categories m
   where t.account_id = any(keep) and t.category_id = m.old_id;

  -- As do their personal budgets and goals, which move with them. Household
  -- budgets and goals belong to the people staying and are left alone.
  update public.budgets b
     set household_id = new_hh,
         category_id = coalesce((select m.new_id from departing_categories m where m.old_id = b.category_id), b.category_id)
   where b.household_id = old_hh and b.deleted_at is null and b.owner_id = p_user_id;

  update public.goals g
     set household_id = new_hh,
         account_id = case when g.account_id = any(keep) then g.account_id else null end
   where g.household_id = old_hh and g.deleted_at is null and g.owner_id = p_user_id;

  perform set_config('hearth.moving', 'off', true);

  -- Fires project_membership() and profiles_epoch_trigger(), which bumps both
  -- households — every device on either side has to drop its cache.
  update public.profiles set household_id = new_hh where id = p_user_id;

  perform public.seed_household(new_hh, p_user_id);
  return new_hh;
end $$;

/**
 * What depart_household() WOULD do, for the confirmation screen.
 *
 * Read-only, and answerable by anyone who may trigger the departure: the person
 * themselves, or an admin of their household. It reports on accounts without
 * granting any sight of them — a name and an outcome, nothing else.
 */
create or replace function public.preview_departure(p_user_id uuid)
returns table (account_id uuid, account_name text, outcome text)
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  hh uuid := public.my_household();
  their_hh uuid;
begin
  select household_id into their_hh from public.profiles where id = p_user_id;
  if their_hh is null or their_hh is distinct from hh then
    raise exception 'Not a member of this household' using errcode = 'P0002';
  end if;
  if p_user_id <> uid and not public.is_household_admin() then
    raise exception 'Only an admin can do that' using errcode = '42501';
  end if;

  return query
  select a.id, a.name,
         case
           when g.level <> 'owner' then 'loses_access'
           when exists (
             select 1 from public.account_grants o
               join public.profiles p on p.id = o.user_id
              where o.account_id = a.id and o.deleted_at is null and o.level = 'owner'
                and o.user_id <> p_user_id and p.household_id = hh
           ) then 'stays_with_others'
           else 'leaves_with_them'
         end
    from public.account_grants g
    join public.accounts a on a.id = g.account_id
   where g.user_id = p_user_id and g.deleted_at is null and a.deleted_at is null
   order by a.sort_order, a.name;
end $$;

create or replace function public.leave_household()
returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  -- A household must not be left without an admin while other people are still
  -- in it, or nobody can ever manage its membership again.
  if public.is_household_admin() and exists (
       select 1 from public.household_members m
        where m.household_id = public.my_household() and m.deleted_at is null
          and m.user_id <> uid
     ) and not exists (
       select 1 from public.household_members m
        where m.household_id = public.my_household() and m.deleted_at is null
          and m.user_id <> uid and m.role = 'admin'
     )
  then
    raise exception 'Make somebody else an admin before you leave' using errcode = '42501';
  end if;
  perform public.depart_household(uid);
end $$;

create or replace function public.remove_member(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := (select auth.uid());
begin
  if not public.is_household_admin() then
    raise exception 'Only an admin can remove somebody' using errcode = '42501';
  end if;
  if p_user_id = uid then
    raise exception 'Use leave_household() to remove yourself' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.household_members m
     where m.household_id = public.my_household() and m.user_id = p_user_id and m.deleted_at is null
  ) then
    raise exception 'Not a member of this household' using errcode = 'P0002';
  end if;
  perform public.depart_household(p_user_id);
end $$;

create or replace function public.set_member_role(p_user_id uuid, p_role public.member_role)
returns void
language plpgsql security definer set search_path = public as $$
declare hh uuid := public.my_household();
begin
  if not public.is_household_admin() then
    raise exception 'Only an admin can change roles' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.household_members m
     where m.household_id = hh and m.user_id = p_user_id and m.deleted_at is null
  ) then
    raise exception 'Not a member of this household' using errcode = 'P0002';
  end if;
  if p_role = 'member' and not exists (
    select 1 from public.household_members m
     where m.household_id = hh and m.deleted_at is null
       and m.role = 'admin' and m.user_id <> p_user_id
  ) then
    raise exception 'A household needs at least one admin' using errcode = '42501';
  end if;

  update public.household_members set role = p_role
   where household_id = hh and user_id = p_user_id and deleted_at is null;
  -- Not a visibility change in itself, but the client caches the member list
  -- and the role decides what the membership UI offers.
  perform public.bump_epoch(hh);
end $$;

/**
 * Grant, change or revoke one person's access to one account.
 *
 * `p_level = 'none'` tombstones the grant. The household appears here once and
 * only once, and this is its entire job in the permission system: you may only
 * share with somebody you are in a household with.
 */
create or replace function public.upsert_account_grant(
  p_id uuid,
  p_account_id uuid,
  p_user_id uuid,
  p_level public.access_level
)
returns public.account_grants
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  hh uuid := public.my_household();
  g public.account_grants;
  owners integer;
begin
  if uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;

  if p_account_id not in (select public.my_account_ids('owner')) then
    raise exception 'That account is not yours to share' using errcode = '42501';
  end if;

  if p_user_id <> uid and not exists (
    select 1 from public.household_members m
     where m.household_id = hh and m.user_id = p_user_id and m.deleted_at is null
  ) then
    raise exception 'Not a member of this household' using errcode = 'P0002';
  end if;

  select * into g from public.account_grants
   where account_id = p_account_id and user_id = p_user_id and deleted_at is null
   for update;

  -- An account with no owner can never be shared, renamed or deleted by anyone
  -- again, so the last owner cannot be removed or demoted — including by
  -- themselves. transfer_account_ownership() is how you hand one over.
  if g.level = 'owner' and p_level <> 'owner' then
    select count(*) into owners from public.account_grants
     where account_id = p_account_id and deleted_at is null and level = 'owner'
       and user_id <> p_user_id;
    if owners = 0 then
      raise exception 'An account must always have an owner' using errcode = '42501';
    end if;
  end if;

  if p_level = 'none' then
    if g.id is not null then
      update public.account_grants set deleted_at = now() where id = g.id returning * into g;
    end if;
  elsif g.id is null then
    insert into public.account_grants (id, account_id, user_id, level, granted_by)
    values (coalesce(p_id, gen_random_uuid()), p_account_id, p_user_id, p_level, uid)
    returning * into g;
  else
    update public.account_grants set level = p_level, granted_by = uid
     where id = g.id returning * into g;
  end if;

  perform public.bump_epoch(hh);
  return g;
end $$;

/**
 * Hand an account over.
 *
 * A separate function rather than two grant calls because doing it in one
 * statement never passes through the zero-owner state that upsert_account_grant
 * refuses.
 */
create or replace function public.transfer_account_ownership(
  p_account_id uuid,
  p_user_id uuid,
  p_step_down boolean default false
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  hh uuid := public.my_household();
begin
  if p_account_id not in (select public.my_account_ids('owner')) then
    raise exception 'That account is not yours to share' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.household_members m
     where m.household_id = hh and m.user_id = p_user_id and m.deleted_at is null
  ) then
    raise exception 'Not a member of this household' using errcode = 'P0002';
  end if;

  insert into public.account_grants (account_id, user_id, level, granted_by)
  values (p_account_id, p_user_id, 'owner', uid)
  on conflict (account_id, user_id) where deleted_at is null
  do update set level = 'owner', granted_by = uid;

  if p_step_down and p_user_id <> uid then
    update public.account_grants set level = 'manage'
     where account_id = p_account_id and user_id = uid and deleted_at is null;
  end if;

  perform public.bump_epoch(hh);
end $$;

-- The join code IS the invite, so rotating it is how an outstanding invite is
-- revoked.
create or replace function public.rotate_join_code()
returns public.households
language plpgsql security definer set search_path = public as $$
declare h public.households;
begin
  if not public.is_household_admin() then
    raise exception 'Only an admin can reset the invite code' using errcode = '42501';
  end if;
  update public.households set join_code = public.new_join_code()
   where id = public.my_household()
  returning * into h;
  return h;
end $$;

-- An RPC rather than a PostgREST write, so the client's table surface stays the
-- synced tables plus households. The projection trigger copies it across.
create or replace function public.set_display_name(p_name text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'A name cannot be empty' using errcode = '22023';
  end if;
  update public.profiles set display_name = trim(p_name) where id = (select auth.uid());
end $$;

-- Creating a household makes you its admin. Joining one runs the departure
-- cascade for the household you are leaving, because joining is a leave and a
-- join — without it your old accounts would stay behind with people you are no
-- longer sharing with.
create or replace function public.create_household(household_name text default 'Our household')
returns public.households
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  h public.households;
  existing uuid;
begin
  if uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;

  select household_id into existing from public.profiles where id = uid;
  if existing is not null then
    select * into h from public.households where id = existing;
    return h;
  end if;

  insert into public.households (name, join_code)
  values (coalesce(nullif(trim(household_name), ''), 'Our household'), public.new_join_code())
  returning * into h;

  update public.profiles set household_id = h.id where id = uid;
  update public.household_members set role = 'admin'
   where household_id = h.id and user_id = uid and deleted_at is null;
  perform public.seed_household(h.id, uid);

  return h;
end $$;

create or replace function public.join_household(code text)
returns public.households
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  h public.households;
  previous uuid;
begin
  if uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;

  select * into h from public.households
   where upper(join_code) = upper(trim(code));
  if h.id is null then
    raise exception 'No household found for that code' using errcode = 'P0002';
  end if;

  select household_id into previous from public.profiles where id = uid;
  if previous = h.id then return h; end if;

  if previous is not null then
    perform public.depart_household(uid);
  end if;

  update public.profiles set household_id = h.id where id = uid;
  return h;
end $$;

-- ============================================================
-- 9. Realtime, epoch, grants
-- ============================================================

-- Adding a table that is already published is an error rather than a no-op, so
-- this is guarded — otherwise re-running the file stops here.
do $$
declare t text;
begin
  foreach t in array array['household_members', 'account_grants'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Every device must drop its cache: accounts.visibility no longer means what
-- the cached rows say it does, and the two new tables are not cached at all.
update public.households set visibility_epoch = visibility_epoch + 1;

do $$
declare f text;
begin
  foreach f in array array[
    'my_account_ids(public.access_level)',
    'account_has_grants(uuid)',
    'is_household_admin()',
    'upsert_account_grant(uuid,uuid,uuid,public.access_level)',
    'transfer_account_ownership(uuid,uuid,boolean)',
    'set_member_role(uuid,public.member_role)',
    'remove_member(uuid)',
    'preview_departure(uuid)',
    'leave_household()',
    'rotate_join_code()',
    'set_display_name(text)',
    'wipe_household()',
    'delete_account(uuid,boolean)',
    'create_transfer(uuid,uuid,uuid,uuid,bigint,date,text,uuid)',
    'account_balances()',
    'post_due_bills(date)',
    'post_bill(uuid,date)',
    'skip_bill(uuid)',
    'sync_checksums()',
    'create_household(text)',
    'join_household(text)',
    'my_txn_account_ids()'
  ] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Internal only. Re-created above, and `create or replace` resets grants, so
-- the revokes have to be re-applied.
revoke execute on function public.seed_household(uuid, uuid) from anon, public, authenticated;
revoke execute on function public.depart_household(uuid) from anon, public, authenticated;
revoke execute on function public.new_join_code() from anon, public, authenticated;
revoke execute on function public.bump_epoch(uuid) from anon, public, authenticated;
