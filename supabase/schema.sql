-- Hearth household sync schema
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run.

-- ---------- tables ----------
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our household',
  join_code text not null unique,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table public.records (
  id text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  tbl text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);

create index records_household_updated on public.records (household_id, updated_at);

-- Server stamps updated_at so the sync cursor is trustworthy.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger records_touch
  before insert or update on public.records
  for each row execute function public.touch_updated_at();

-- ---------- row level security ----------
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.records enable row level security;

-- Which households does the calling user belong to?
-- (security definer so policies can use it without RLS recursion)
create or replace function public.my_households()
returns setof uuid
language sql stable security definer set search_path = public as
$$ select household_id from household_members where user_id = auth.uid() $$;

create policy "members read their household"
  on public.households for select to authenticated
  using (id in (select public.my_households()));

create policy "users read own memberships"
  on public.household_members for select to authenticated
  using (user_id = auth.uid());

create policy "members full access to household records"
  on public.records for all to authenticated
  using (household_id in (select public.my_households()))
  with check (household_id in (select public.my_households()));

-- ---------- RPCs ----------
create or replace function public.create_household(household_name text default 'Our household')
returns table (id uuid, join_code text)
language plpgsql security definer set search_path = public as $$
declare h households;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  insert into households (name, join_code)
    values (household_name, upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)))
    returning * into h;
  insert into household_members (household_id, user_id) values (h.id, auth.uid());
  return query select h.id, h.join_code;
end $$;

create or replace function public.join_household(code text)
returns table (id uuid, join_code text)
language plpgsql security definer set search_path = public as $$
declare h households;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  select * into h from households where upper(households.join_code) = upper(trim(code));
  if h.id is null then
    raise exception 'No household found for that code';
  end if;
  insert into household_members (household_id, user_id)
    values (h.id, auth.uid())
    on conflict do nothing;
  return query select h.id, h.join_code;
end $$;

grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(text) to authenticated;
revoke execute on function public.create_household(text) from anon;
revoke execute on function public.join_household(text) from anon;

-- ---------- realtime ----------
alter publication supabase_realtime add table public.records;
