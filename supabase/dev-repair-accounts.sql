-- Hearth — find and rescue an account nobody can reach
--
-- DEVELOPMENT UTILITY, like dev-reset-data.sql. Not a migration; never part of
-- the 01…09 sequence. Run the whole file once in the Supabase SQL editor to
-- install both functions, then call whichever you need.
--
-- An account is only visible to somebody holding a grant on it. That is the
-- whole privacy model and it is working as intended — but it means an account
-- can end up in a state where nobody can see it, and there is then nothing in
-- the app to click on to fix it. Three ways in:
--
--   1. You removed your own grant while somebody else owned it. Legal, and the
--      app now warns — but the other owner has to give it back.
--   2. The last owner left the household. depart_household() revokes what they
--      were a guest on, and an account can be left with grants but no owner.
--   3. It was deleted. delete_account() sets deleted_at, which hides it from
--      everybody by design.
--
-- ============================================================
-- 1. WHAT STATE IS EVERYTHING IN?
-- ============================================================
--
--   select * from public.dev_account_report();
--
-- Reads past RLS, so it shows accounts no client can see. `owners` of 0 on a
-- live account is the broken case; `deleted` tells you it was deleted rather
-- than orphaned, which is a different problem with a different answer.

create or replace function public.dev_account_report()
returns table (
  account_id uuid,
  account_name text,
  household text,
  deleted boolean,
  owners integer,
  people_on_it integer,
  access text
)
language sql
security definer
set search_path = public
as $$
  select
    a.id,
    a.name,
    h.name,
    a.deleted_at is not null,
    (select count(*)::integer from public.account_grants g
      where g.account_id = a.id and g.deleted_at is null and g.level = 'owner'),
    (select count(*)::integer from public.account_grants g
      where g.account_id = a.id and g.deleted_at is null),
    coalesce(
      (select string_agg(coalesce(nullif(trim(p.display_name), ''), split_part(u.email, '@', 1)) || ' — ' || g.level,
                         ', ' order by g.level desc)
         from public.account_grants g
         join auth.users u on u.id = g.user_id
         left join public.profiles p on p.id = g.user_id
        where g.account_id = a.id and g.deleted_at is null),
      '(nobody)')
  from public.accounts a
  join public.households h on h.id = a.household_id
  order by (a.deleted_at is not null), h.name, a.name
$$;

-- ============================================================
-- 2. GIVE IT BACK
-- ============================================================
--
--   select public.dev_reclaim_account(
--     '<account_id from the report>',
--     '<user_id — see below>');
--
-- To find your user id:
--   select id, email from auth.users;
--
-- Makes that person an owner, and un-deletes the account if it was deleted.
-- Every other grant is left exactly as it was, so this restores access without
-- quietly changing who else can see anything.

create or replace function public.dev_reclaim_account(p_account_id uuid, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.accounts;
  was_deleted boolean;
begin
  select * into a from public.accounts where id = p_account_id;
  if a.id is null then
    raise exception 'No such account: %', p_account_id using errcode = 'P0002';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'No such user: %', p_user_id using errcode = 'P0002';
  end if;

  was_deleted := a.deleted_at is not null;
  if was_deleted then
    update public.accounts set deleted_at = null where id = p_account_id;
  end if;

  -- Reuse the existing row if there is one, live or tombstoned: the unique
  -- index is on (account_id, user_id) where deleted_at is null, and inserting
  -- a second live grant for the same person would collide with it.
  if exists (select 1 from public.account_grants where account_id = p_account_id and user_id = p_user_id) then
    update public.account_grants
       set level = 'owner', deleted_at = null
     where account_id = p_account_id and user_id = p_user_id;
  else
    insert into public.account_grants (account_id, user_id, level)
    values (p_account_id, p_user_id, 'owner');
  end if;

  -- A row that becomes visible again emits no realtime event and has no
  -- tombstone to replicate, so the epoch is the only thing that will make the
  -- devices notice. Without it the account stays missing until something else
  -- happens to bump it.
  perform public.bump_epoch(a.household_id);

  return format('%s is now an owner of "%s"%s. Reopen the app on every device.',
    (select coalesce(nullif(trim(p.display_name), ''), u.email)
       from auth.users u left join public.profiles p on p.id = u.id where u.id = p_user_id),
    a.name,
    case when was_deleted then ', and it has been un-deleted' else '' end);
end $$;

revoke execute on function public.dev_account_report() from anon, public, authenticated;
revoke execute on function public.dev_reclaim_account(uuid, uuid) from anon, public, authenticated;
