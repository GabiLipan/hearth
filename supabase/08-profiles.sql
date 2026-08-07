-- Hearth — names and faces (8 of 8)
--
-- A MIGRATION. Run once, after 07-permissions.sql. Safe to re-run.
--
-- 07 gave the household a member list but nothing to put on it: `display_name`
-- was whatever `handle_new_user()` happened to split out of an email address,
-- with no way to change it and nothing at all if that trigger never ran for an
-- account. A permissions screen that says "Someone — Owner" twice is not a
-- permissions screen.
--
-- Three changes:
--   1. display_name backfilled, and editable by its owner
--   2. avatar_url, optional, carried on the same projection
--   3. set_member_role stops bumping the visibility epoch

-- ============================================================
-- 0. Refuse to install against a schema that is missing 07
-- ============================================================

do $$
begin
  if to_regclass('public.household_members') is null then
    raise exception 'Run 07-permissions.sql first: this migration extends the household_members projection'
      using errcode = '42P01';
  end if;
end $$;

-- ============================================================
-- 1. Columns
-- ============================================================
--
-- A data URL rather than a link into Supabase Storage. An avatar here is shown
-- at 24-40px next to a name, so it is a few kilobytes once downscaled — small
-- enough that carrying it on the row it belongs to costs less than a bucket,
-- its policies, its lifecycle and a second failure mode when a file goes
-- missing but the row still points at it. The length is capped so this stays
-- true whatever a client tries to send.

alter table public.profiles
  add column if not exists avatar_url text;
alter table public.household_members
  add column if not exists avatar_url text;

alter table public.profiles drop constraint if exists profiles_avatar_is_small;
alter table public.profiles add constraint profiles_avatar_is_small
  check (avatar_url is null or length(avatar_url) <= 40000);

-- ============================================================
-- 2. Backfill: nobody should be nameless
-- ============================================================

-- The email local-part is what handle_new_user() would have used. Anyone whose
-- profile predates that trigger, or who was created another way, gets it now.
update public.profiles p
   set display_name = split_part(u.email, '@', 1)
  from auth.users u
 where u.id = p.id
   and coalesce(trim(p.display_name), '') = '';

-- The projection copies display_name on write, so rows written before this
-- migration need it pushing across once.
update public.household_members m
   set display_name = p.display_name,
       avatar_url = p.avatar_url
  from public.profiles p
 where p.id = m.user_id
   and (coalesce(trim(m.display_name), '') = '' or m.avatar_url is distinct from p.avatar_url);

-- ============================================================
-- 3. The projection carries the avatar too
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
    insert into public.household_members (household_id, user_id, display_name, avatar_url)
    values (new.household_id, new.id, new.display_name, new.avatar_url)
    on conflict (household_id, user_id) where deleted_at is null
    -- `role` stays absent from this list: it belongs to this table, not to
    -- profiles, so changing your name or your photo must not demote you.
    do update set display_name = excluded.display_name,
                  avatar_url = excluded.avatar_url;
  end if;
  return null;
end $$;

drop trigger if exists profiles_project_membership on public.profiles;
create trigger profiles_project_membership
  after insert or update of household_id, display_name, avatar_url on public.profiles
  for each row execute function public.project_membership();

-- ============================================================
-- 4. Editing your own name and picture
-- ============================================================
--
-- An RPC rather than a PostgREST write on `profiles`, so the client's table
-- surface stays the synced tables plus `households`. Both arguments are
-- optional: passing null leaves that half alone, and clearing a photo is an
-- explicit empty string.

create or replace function public.set_profile(p_name text default null, p_avatar text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;

  if p_name is not null then
    if coalesce(trim(p_name), '') = '' then
      raise exception 'A name cannot be empty' using errcode = '22023';
    end if;
    update public.profiles set display_name = trim(p_name) where id = uid;
  end if;

  if p_avatar is not null then
    if length(p_avatar) > 40000 then
      raise exception 'That picture is too large' using errcode = '22001';
    end if;
    -- An empty string means "remove it", which is distinct from null meaning
    -- "leave whatever is there".
    update public.profiles set avatar_url = nullif(p_avatar, '') where id = uid;
  end if;
end $$;

-- Superseded by set_profile, kept so an older tab's call still works.
create or replace function public.set_display_name(p_name text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.set_profile(p_name, null);
end $$;

-- ============================================================
-- 5. A role change is not a visibility change
-- ============================================================
--
-- The epoch is the signal that a row somebody has cached is no longer theirs to
-- see, and it costs every device a full cache drop and re-pull. A role decides
-- who may manage MEMBERSHIP; it grants nothing on any account, so no row
-- changes hands and the ordinary delta pull carries it like any other update.
--
-- Bumping here also had a visible cost: the member list emptied mid-render
-- while the cache rebuilt, so the sheet you were looking at flashed away and
-- came back with the value you had just changed away from.

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
end $$;

-- ============================================================
-- 6. Grants
-- ============================================================

do $$
declare f text;
begin
  foreach f in array array[
    'set_profile(text,text)',
    'set_display_name(text)',
    'set_member_role(uuid,public.member_role)'
  ] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
