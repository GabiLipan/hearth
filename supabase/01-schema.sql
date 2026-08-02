-- Hearth — schema (1 of 4)
-- Run in order on a fresh Supabase project:
--   01-schema.sql → 02-rls.sql → 03-rpc.sql → (optionally) 99-rls-tests.sql
--
-- Design notes
-- ------------
-- The server is the source of truth. Every device keeps a derived cache and an
-- outbox of pending writes, so the columns here are what the client mirrors.
--
--  * `id` is a uuid the CLIENT generates, so a retried insert after a dropped
--    response is `on conflict do nothing` rather than a duplicate row.
--  * `updated_at` is stamped by a trigger and is the ONLY clock that matters —
--    clients never write it, and the pull cursor reads it.
--  * `deleted_at` is a soft-delete tombstone so deletions replicate.
--  * `household_id`, `owner_id` and `created_by` are trigger-stamped from the
--    caller's JWT, never trusted from the client.
--  * Amounts are integer minor units (pence). Negative = money out.

create extension if not exists pgcrypto;

-- ---------- enums ----------

create type public.account_kind as enum ('current', 'credit', 'savings', 'cash');
create type public.category_kind as enum ('expense', 'income');
create type public.bill_freq as enum ('weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly');

-- shared:  partner sees the account and every transaction on it
-- balance: partner sees the account and its balance, but no transactions
-- private: partner sees nothing at all
create type public.account_visibility as enum ('shared', 'balance', 'private');

-- ---------- households and people ----------

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our household',
  join_code text not null unique,
  currency text not null default 'GBP',
  -- Bumped whenever something changes what a member is allowed to see. Clients
  -- that notice a new epoch drop their cache and re-pull, which is how rows
  -- that became invisible get evicted (an invisible row cannot send a tombstone).
  visibility_epoch integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One household per person: `household_id` lives here rather than in a join
-- table, so "which household am I in?" is a single unambiguous value.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid references public.households(id) on delete set null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_household on public.profiles (household_id);

-- ---------- data ----------

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  icon text not null default 'package',
  slot smallint not null default 1 check (slot between 1 and 8),
  kind public.category_kind not null default 'expense',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  kind public.account_kind not null default 'current',
  visibility public.account_visibility not null default 'shared',
  -- Whose account it is. Required once it stops being fully shared, otherwise
  -- "private" would have nobody it is private *to*.
  owner_id uuid references auth.users(id) on delete set null,
  opening_balance_minor bigint not null default 0,
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint accounts_private_needs_owner
    check (visibility = 'shared' or owner_id is not null)
);

create table public.bills (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  payee text not null default '',
  amount_minor bigint not null,
  category_id uuid references public.categories(id) on delete set null,
  account_id uuid not null references public.accounts(id) on delete restrict,
  freq public.bill_freq not null default 'monthly',
  next_due date not null,
  active boolean not null default true,
  auto_post boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  -- Not nullable: a transaction always belongs to an account, otherwise
  -- balances grow an orphan bucket nothing can reconcile.
  account_id uuid not null references public.accounts(id) on delete restrict,
  -- Nullable: deleting a category should not delete its history. The client
  -- renders a missing category as "Uncategorised".
  category_id uuid references public.categories(id) on delete set null,
  bill_id uuid references public.bills(id) on delete set null,
  occurred_on date not null,
  payee text not null default '',
  note text,
  amount_minor bigint not null,
  -- `date|amount|payee` fingerprint used by the import wizard's duplicate
  -- heuristic. Deliberately NOT unique: two genuine £3.20 coffees at the same
  -- shop on the same day share a hash, and silently dropping the second one
  -- would corrupt the balance with no way to notice.
  import_hash text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One posting per bill occurrence. The composite primary key is what stops two
-- devices auto-posting the same due date twice.
create table public.bill_postings (
  bill_id uuid not null references public.bills(id) on delete cascade,
  due_on date not null,
  household_id uuid not null references public.households(id) on delete cascade,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (bill_id, due_on)
);

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  -- null = a household budget both people see; set = that person's own, which
  -- only they can see (see 02-rls.sql).
  owner_id uuid references auth.users(id) on delete cascade,
  amount_minor bigint not null check (amount_minor >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.rules (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  match text not null check (length(trim(match)) > 0),
  category_id uuid not null references public.categories(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ---------- constraints that are real invariants ----------
--
-- Only three. Category and account names are deliberately NOT unique: people
-- legitimately have a "Barclays" current account and a "Barclays" savings, and
-- two people typing "Coffee" at the same moment should produce a tidy-up job,
-- not a hard write failure on a row they have already seen appear on screen.
-- Each of these is written through an RPC in 03-rpc.sql that resolves the
-- conflict server-side, because PostgREST cannot express `on conflict` against
-- a partial or expression index.

create unique index budgets_household_unique
  on public.budgets (household_id, category_id)
  where owner_id is null and deleted_at is null;

create unique index budgets_personal_unique
  on public.budgets (household_id, category_id, owner_id)
  where owner_id is not null and deleted_at is null;

create unique index rules_match_unique
  on public.rules (household_id, lower(match))
  where deleted_at is null;

-- ---------- indexes ----------

-- The pull index: every delta sync is `where household_id = $1 and updated_at
-- > $2 order by updated_at, id`.
create index categories_pull   on public.categories   (household_id, updated_at, id);
create index accounts_pull     on public.accounts     (household_id, updated_at, id);
create index bills_pull        on public.bills        (household_id, updated_at, id);
create index transactions_pull on public.transactions (household_id, updated_at, id);
create index budgets_pull      on public.budgets      (household_id, updated_at, id);
create index rules_pull        on public.rules        (household_id, updated_at, id);

create index transactions_account on public.transactions (account_id) where deleted_at is null;
create index transactions_date    on public.transactions (household_id, occurred_on desc);
create index transactions_import  on public.transactions (household_id, import_hash) where import_hash is not null;
create index bills_due            on public.bills (household_id, next_due) where deleted_at is null and active;
create index budgets_category     on public.budgets (category_id);
create index accounts_owner       on public.accounts (owner_id);

-- ---------- helper functions ----------
--
-- security definer so RLS policies can call them without recursing into the
-- policies on profiles/accounts.

create or replace function public.my_household()
returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from public.profiles where id = (select auth.uid())
$$;

-- Accounts whose *transactions* the caller may read: fully shared ones, plus
-- their own at any visibility. A 'balance' account is excluded here on purpose
-- — the partner sees the account row and its total, never the line items.
create or replace function public.my_txn_account_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from public.accounts
  where household_id = public.my_household()
    and (visibility = 'shared' or owner_id = (select auth.uid()))
$$;

-- ---------- triggers ----------

-- clock_timestamp(), not now(): now() is the transaction's START time and is
-- identical for every row a transaction writes, so a 500-row CSV import would
-- stamp 500 rows with one value. The pull cursor pages on (updated_at, id) and
-- copes with ties either way, but real per-row write times mean far fewer of
-- them, and "when was this row written" stops being a lie.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end $$;

-- Stamps the rows a client must not be allowed to choose for itself, and pins
-- them on update so a row cannot be moved to another household.
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
  if tg_table_name in ('accounts', 'bills', 'transactions', 'rules') then
    if tg_op = 'INSERT' then
      new.created_by = uid;
    else
      new.created_by = old.created_by;
    end if;
  end if;

  -- `owner_id` defaults to the creator but stays editable (handing an account
  -- over, or making a shared one personal). Budgets also have an owner_id, but
  -- there null is meaningful — it marks a household budget — so it is left alone.
  if tg_table_name = 'accounts' then
    if tg_op = 'INSERT' and new.owner_id is null then
      new.owner_id = uid;
    end if;
  end if;

  return new;
end $$;

-- Bump the household's epoch when something changes who can see what. Each of
-- these cases leaves a row cached on a device that is no longer allowed to have
-- it, and none of them can announce themselves — an invisible row sends no
-- realtime event and no tombstone.
create or replace function public.bump_epoch(target uuid)
returns void language sql security definer set search_path = public as $$
  update public.households set visibility_epoch = visibility_epoch + 1 where id = target
$$;

create or replace function public.accounts_epoch_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.visibility is distinct from new.visibility
     or old.owner_id is distinct from new.owner_id then
    perform public.bump_epoch(new.household_id);
  end if;
  return null;
end $$;

-- Moving a transaction between accounts can expose or hide it.
create or replace function public.transactions_epoch_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare moved_to_or_from_restricted boolean;
begin
  if old.account_id is distinct from new.account_id then
    select exists (
      select 1 from public.accounts
      where id in (old.account_id, new.account_id) and visibility <> 'shared'
    ) into moved_to_or_from_restricted;
    if moved_to_or_from_restricted then
      perform public.bump_epoch(new.household_id);
    end if;
  end if;
  return null;
end $$;

-- Someone leaving takes a full copy of the household with them; bumping tells
-- the remaining member's devices nothing, but bumping the household they left
-- is what makes their own device wipe on next contact.
create or replace function public.profiles_epoch_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.household_id is distinct from new.household_id then
    if old.household_id is not null then perform public.bump_epoch(old.household_id); end if;
    if new.household_id is not null then perform public.bump_epoch(new.household_id); end if;
  end if;
  return null;
end $$;

-- A partner with 'balance' visibility never receives realtime events for the
-- transactions (RLS hides them), so they would never learn the total changed.
-- Touching the account row — which they CAN see — is their signal to re-read
-- account_balances().
-- Statement-level with transition tables, not per row: a CSV import of 500
-- transactions must touch the account once, not 500 times.
create or replace function public.touch_balance_accounts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.accounts a
     set updated_at = now()
   where a.visibility = 'balance'
     and a.id in (select account_id from changed_rows);
  return null;
end $$;

create trigger households_touch    before insert or update on public.households    for each row execute function public.touch_updated_at();
create trigger profiles_touch      before insert or update on public.profiles      for each row execute function public.touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array['categories', 'accounts', 'bills', 'transactions', 'budgets', 'rules'] loop
    execute format('create trigger %1$s_touch before insert or update on public.%1$I for each row execute function public.touch_updated_at()', t);
    execute format('create trigger %1$s_stamp before insert or update on public.%1$I for each row execute function public.stamp_ownership()', t);
  end loop;
end $$;

create trigger accounts_epoch     after update on public.accounts     for each row execute function public.accounts_epoch_trigger();
create trigger transactions_epoch after update on public.transactions for each row execute function public.transactions_epoch_trigger();
create trigger profiles_epoch     after update on public.profiles     for each row execute function public.profiles_epoch_trigger();

create trigger transactions_touch_balance_ins
  after insert on public.transactions
  referencing new table as changed_rows
  for each statement execute function public.touch_balance_accounts();

create trigger transactions_touch_balance_upd
  after update on public.transactions
  referencing new table as changed_rows
  for each statement execute function public.touch_balance_accounts();

create trigger transactions_touch_balance_del
  after delete on public.transactions
  referencing old table as changed_rows
  for each statement execute function public.touch_balance_accounts();

-- A profile row must exist before the first household can be created.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- realtime ----------

alter publication supabase_realtime add table public.households;
alter publication supabase_realtime add table public.categories;
alter publication supabase_realtime add table public.accounts;
alter publication supabase_realtime add table public.bills;
alter publication supabase_realtime add table public.transactions;
alter publication supabase_realtime add table public.budgets;
alter publication supabase_realtime add table public.rules;
