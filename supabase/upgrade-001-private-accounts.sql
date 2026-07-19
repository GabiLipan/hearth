-- Upgrade 001: private accounts
-- Run AFTER schema.sql, in the Supabase SQL Editor.
-- Adds per-row ownership + privacy so an account can be private to its owner
-- or share only its balance, enforced by RLS (not by the app).

alter table public.records
  add column if not exists owner_id uuid,
  add column if not exists private boolean not null default false;

-- Stamp the creator on insert; never trust the client for this.
create or replace function public.set_record_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.owner_id is null then
    new.owner_id = auth.uid();
  end if;
  return new;
end $$;

create trigger records_owner
  before insert on public.records
  for each row execute function public.set_record_owner();

-- Replace the single all-access policy with privacy-aware ones.
drop policy if exists "members full access to household records" on public.records;

create policy "members read shared or own records"
  on public.records for select to authenticated
  using (
    household_id in (select public.my_households())
    and (not private or owner_id = auth.uid())
  );

create policy "members insert household records"
  on public.records for insert to authenticated
  with check (household_id in (select public.my_households()));

create policy "members update shared or own records"
  on public.records for update to authenticated
  using (
    household_id in (select public.my_households())
    and (not private or owner_id = auth.uid())
  )
  with check (household_id in (select public.my_households()));
