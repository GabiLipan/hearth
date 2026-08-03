-- Hearth — subcategories, monthly budgets, goals and transfers
--
-- A MIGRATION, not a rewrite: 01–03 are already applied to a live project, so
-- this alters what is there and backfills rather than recreating it. Run it
-- once, after 03-rpc.sql. Safe to run against a household that already has data.

-- ============================================================
-- 1. Categories: subcategories, and personal categories
-- ============================================================

alter table public.categories
  add column if not exists parent_id uuid references public.categories(id) on delete cascade,
  -- null = the household's; set = that person's own, and only usable on their
  -- own non-shared accounts (enforced further down).
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

create index if not exists categories_parent on public.categories (parent_id);
create index if not exists categories_owner on public.categories (owner_id);

-- Null now means "inherit from my parent". A top-level category still has to
-- carry its own, which the check below enforces — otherwise a category could
-- exist with nothing to inherit from and no colour of its own.
alter table public.categories alter column icon drop not null;
alter table public.categories alter column slot drop not null;
-- The defaults have to go too, or an omitted icon silently becomes 'package'
-- and null — the value that means "inherit" — is unreachable.
alter table public.categories alter column icon drop default;
alter table public.categories alter column slot drop default;

alter table public.categories drop constraint if exists categories_top_level_has_style;
alter table public.categories add constraint categories_top_level_has_style
  check (parent_id is not null or (icon is not null and slot is not null));

/**
 * One level of nesting, and a child always matches its parent's kind.
 *
 * Arbitrary depth sounds more flexible but it is not what anyone wants from a
 * budget: it turns every total into a recursive query and every screen into a
 * tree. "Home & utilities → Insurance" is the whole requirement.
 */
create or replace function public.categories_hierarchy_guard()
returns trigger language plpgsql set search_path = public as $$
declare parent public.categories;
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception 'A category cannot be its own parent' using errcode = '23514';
  end if;

  select * into parent from public.categories where id = new.parent_id;
  if parent.id is null then
    raise exception 'Unknown parent category' using errcode = '23503';
  end if;
  if parent.parent_id is not null then
    raise exception 'Subcategories cannot be nested further' using errcode = '23514';
  end if;
  if parent.kind is distinct from new.kind then
    raise exception 'A subcategory must be the same kind as its parent' using errcode = '23514';
  end if;
  if exists (select 1 from public.categories where parent_id = new.id) then
    raise exception 'A category with subcategories cannot become one' using errcode = '23514';
  end if;

  return new;
end $$;

drop trigger if exists categories_hierarchy on public.categories;
create trigger categories_hierarchy
  before insert or update of parent_id, kind on public.categories
  for each row execute function public.categories_hierarchy_guard();

-- A personal category may only be used on a non-shared account its owner owns.
-- Enforced here rather than in the form, because the form is not what protects
-- anything — anyone can post whatever they like straight to the API.
create or replace function public.personal_category_guard()
returns trigger language plpgsql set search_path = public as $$
declare cat_owner uuid; acc_visibility public.account_visibility; acc_owner uuid;
begin
  if new.category_id is null then return new; end if;

  select owner_id into cat_owner from public.categories where id = new.category_id;
  if cat_owner is null then return new; end if;

  select visibility, owner_id into acc_visibility, acc_owner
    from public.accounts where id = new.account_id;

  if acc_visibility = 'shared' or acc_owner is distinct from cat_owner then
    raise exception 'A personal category can only be used on your own private accounts'
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists transactions_personal_category on public.transactions;
create trigger transactions_personal_category
  before insert or update of category_id, account_id on public.transactions
  for each row execute function public.personal_category_guard();

-- Categories are no longer uniformly visible: a personal one belongs to one person.
drop policy if exists categories_select on public.categories;
drop policy if exists categories_insert on public.categories;
drop policy if exists categories_update on public.categories;

create policy categories_select on public.categories
  for select to authenticated
  using (
    household_id = (select public.my_household())
    and (owner_id is null or owner_id = (select auth.uid()))
  );

create policy categories_insert on public.categories
  for insert to authenticated
  with check (
    household_id = (select public.my_household())
    -- You cannot create a category that is personal to someone else.
    and (owner_id is null or owner_id = (select auth.uid()))
  );

create policy categories_update on public.categories
  for update to authenticated
  using (
    household_id = (select public.my_household())
    and (owner_id is null or owner_id = (select auth.uid()))
  )
  with check (
    household_id = (select public.my_household())
    and (owner_id is null or owner_id = (select auth.uid()))
  );

-- ============================================================
-- 2. Budgets belong to a month
-- ============================================================
--
-- Previously one row per category, overwritten in place — so changing £450 to
-- £400 destroyed the £450 and "how did we do in March?" was unanswerable. A
-- budget is now a fact about a particular month, which is what makes history,
-- suggestions and the sparkline possible at all.

alter table public.budgets add column if not exists month date;
update public.budgets set month = date_trunc('month', now())::date where month is null;
alter table public.budgets alter column month set not null;

alter table public.budgets drop constraint if exists budgets_month_is_first;
alter table public.budgets add constraint budgets_month_is_first
  check (month = date_trunc('month', month)::date);

drop index if exists public.budgets_household_unique;
drop index if exists public.budgets_personal_unique;

create unique index budgets_household_unique
  on public.budgets (household_id, category_id, month)
  where owner_id is null and deleted_at is null;

create unique index budgets_personal_unique
  on public.budgets (household_id, category_id, owner_id, month)
  where owner_id is not null and deleted_at is null;

create index if not exists budgets_month on public.budgets (household_id, month);

-- ============================================================
-- 3. Goals — pots you save towards
-- ============================================================
--
-- Deliberately separate from budgets. A budget is a ceiling that resets every
-- month; a goal accumulates towards a target. Folding one into the other makes
-- both harder to explain.

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  icon text not null default 'piggy',
  slot smallint not null default 9 check (slot between 1 and 12),
  target_minor bigint not null check (target_minor > 0),
  target_date date,
  -- null = the household's goal; set = that person's own.
  owner_id uuid references auth.users(id) on delete cascade,
  -- Optionally, where the money actually sits.
  account_id uuid references public.accounts(id) on delete set null,
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists goals_pull on public.goals (household_id, updated_at, id);

alter table public.goals enable row level security;

-- Dropped first, like the category policies above, so this file can be re-run
-- when you are not sure whether it was applied. `create policy` has no
-- `if not exists`, and a half-applied migration is worse than a repeated one.
drop policy if exists goals_select on public.goals;
drop policy if exists goals_insert on public.goals;
drop policy if exists goals_update on public.goals;

create policy goals_select on public.goals
  for select to authenticated
  using (
    household_id = (select public.my_household())
    and (owner_id is null or owner_id = (select auth.uid()))
  );

create policy goals_insert on public.goals
  for insert to authenticated
  with check (
    household_id = (select public.my_household())
    and (owner_id is null or owner_id = (select auth.uid()))
  );

create policy goals_update on public.goals
  for update to authenticated
  using (
    household_id = (select public.my_household())
    and (owner_id is null or owner_id = (select auth.uid()))
  )
  with check (
    household_id = (select public.my_household())
    and (owner_id is null or owner_id = (select auth.uid()))
  );

drop trigger if exists goals_touch on public.goals;
drop trigger if exists goals_stamp on public.goals;

create trigger goals_touch before insert or update on public.goals
  for each row execute function public.touch_updated_at();
create trigger goals_stamp before insert or update on public.goals
  for each row execute function public.stamp_ownership();

-- ============================================================
-- 4. Transfers, and money paid into a goal
-- ============================================================
--
-- A transfer is two rows sharing a `transfer_id`: money out of one account and
-- into another. Two rows rather than one because each account's balance is the
-- sum of its own transactions, and that stays true with no special cases.
--
-- Both legs must be excluded from spending and income — moving your own money
-- between pockets is neither.

alter table public.transactions
  add column if not exists transfer_id uuid,
  add column if not exists goal_id uuid references public.goals(id) on delete set null;

create index if not exists transactions_transfer on public.transactions (transfer_id)
  where transfer_id is not null;
create index if not exists transactions_goal on public.transactions (goal_id)
  where goal_id is not null;

/**
 * Move money between two accounts as one atomic pair.
 *
 * The client supplies both row ids so a retry after a dropped response is
 * `on conflict do nothing` on each leg rather than a second transfer — the same
 * idempotency the rest of the write path relies on.
 */
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
  if hh is null then raise exception 'No household' using errcode = '42501'; end if;
  if p_amount_minor <= 0 then
    raise exception 'A transfer must be a positive amount' using errcode = '23514';
  end if;
  if p_from_account = p_to_account then
    raise exception 'Cannot transfer to the same account' using errcode = '23514';
  end if;

  -- Both ends must be accounts this person is allowed to record against, or a
  -- transfer would be a way to write into an account RLS hides from them.
  select name into from_name from public.accounts
    where id = p_from_account and household_id = hh and id in (select public.my_txn_account_ids());
  select name into to_name from public.accounts
    where id = p_to_account and household_id = hh and id in (select public.my_txn_account_ids());
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

-- ============================================================
-- 5. RPCs updated for the month dimension
-- ============================================================

drop function if exists public.upsert_budget(uuid, uuid, boolean, bigint);

create or replace function public.upsert_budget(
  p_id uuid,
  p_category_id uuid,
  p_personal boolean,
  p_amount_minor bigint,
  p_month date
)
returns public.budgets
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  hh uuid := public.my_household();
  own uuid := case when p_personal then uid else null end;
  m date := date_trunc('month', p_month)::date;
  b public.budgets;
begin
  if hh is null then raise exception 'No household' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.categories
     where id = p_category_id and household_id = hh
       and (owner_id is null or owner_id = uid)
  ) then
    raise exception 'Unknown category' using errcode = '23503';
  end if;

  select * into b from public.budgets
   where household_id = hh and category_id = p_category_id
     and owner_id is not distinct from own and month = m and deleted_at is null;

  if p_amount_minor is null then
    if b.id is not null then
      update public.budgets set deleted_at = now() where id = b.id returning * into b;
    end if;
    return b;
  end if;

  if b.id is null then
    insert into public.budgets (id, household_id, category_id, owner_id, amount_minor, month)
    values (coalesce(p_id, gen_random_uuid()), hh, p_category_id, own, p_amount_minor, m)
    returning * into b;
  else
    update public.budgets set amount_minor = p_amount_minor where id = b.id returning * into b;
  end if;
  return b;
end $$;

/**
 * Carry a month's budgets forward.
 *
 * Without this, month-scoped budgets would mean retyping everything on the
 * first of every month, which nobody would do — and the history would be full
 * of holes that look like "we had no budget" rather than "nobody re-entered it".
 * Existing budgets in the target month are left alone.
 */
create or replace function public.copy_budgets(p_from date, p_to date)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  hh uuid := public.my_household();
  uid uuid := (select auth.uid());
  src date := date_trunc('month', p_from)::date;
  dst date := date_trunc('month', p_to)::date;
  copied integer;
begin
  if hh is null then return 0; end if;

  with inserted as (
    insert into public.budgets (household_id, category_id, owner_id, amount_minor, month)
    select b.household_id, b.category_id, b.owner_id, b.amount_minor, dst
      from public.budgets b
     where b.household_id = hh
       and b.month = src
       and b.deleted_at is null
       and (b.owner_id is null or b.owner_id = uid)
       and not exists (
         select 1 from public.budgets t
          where t.household_id = hh and t.category_id = b.category_id
            and t.owner_id is not distinct from b.owner_id
            and t.month = dst and t.deleted_at is null
       )
    returning 1
  )
  select count(*) into copied from inserted;

  return copied;
end $$;

-- Goals join the pull, so the cache can tell when one has been removed.
create or replace function public.sync_checksums()
returns table (table_name text, live_rows bigint, max_updated_at timestamptz)
language sql stable set search_path = public as $$
  select 'categories',   count(*), max(updated_at) from public.categories   where deleted_at is null
  union all
  select 'accounts',     count(*), max(updated_at) from public.accounts     where deleted_at is null
  union all
  select 'bills',        count(*), max(updated_at) from public.bills        where deleted_at is null
  union all
  select 'transactions', count(*), max(updated_at) from public.transactions where deleted_at is null
  union all
  select 'budgets',      count(*), max(updated_at) from public.budgets      where deleted_at is null
  union all
  select 'rules',        count(*), max(updated_at) from public.rules        where deleted_at is null
  union all
  select 'goals',        count(*), max(updated_at) from public.goals        where deleted_at is null
$$;

-- A wipe has to reach the new tables too, or "erase everything" would quietly
-- leave the goals behind.
create or replace function public.wipe_household()
returns void
language plpgsql security definer set search_path = public as $$
declare hh uuid := public.my_household();
begin
  if hh is null then return; end if;
  update public.transactions set deleted_at = now() where household_id = hh and deleted_at is null;
  update public.budgets      set deleted_at = now() where household_id = hh and deleted_at is null;
  update public.rules        set deleted_at = now() where household_id = hh and deleted_at is null;
  update public.goals        set deleted_at = now() where household_id = hh and deleted_at is null;
  delete from public.bill_postings where household_id = hh;
  update public.bills        set deleted_at = now() where household_id = hh and deleted_at is null;
  update public.accounts     set deleted_at = now() where household_id = hh and deleted_at is null;
  -- Children before parents: a subcategory tombstoned after its parent would
  -- briefly reference a deleted row on the way through the other device's cache.
  update public.categories   set deleted_at = now()
   where household_id = hh and deleted_at is null and parent_id is not null;
  update public.categories   set deleted_at = now() where household_id = hh and deleted_at is null;
  perform public.seed_household(hh, (select auth.uid()));
end $$;

-- ============================================================
-- 6. Grants and realtime
-- ============================================================

-- Adding a table that is already published is an error, not a no-op, so this is
-- guarded too — otherwise re-running the file stops here.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'goals'
  ) then
    alter publication supabase_realtime add table public.goals;
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'upsert_budget(uuid,uuid,boolean,bigint,date)',
    'copy_budgets(date,date)',
    'create_transfer(uuid,uuid,uuid,uuid,bigint,date,text,uuid)'
  ] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
