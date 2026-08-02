-- LOCAL TESTING ONLY — do not run this on Supabase.
--
-- Supabase provides an `auth` schema, an `auth.uid()` that reads the signed-in
-- user out of the request's JWT, the `anon`/`authenticated` roles, and the
-- `supabase_realtime` publication. A plain Postgres has none of those, so this
-- file fakes just enough of them to run 01/02/03 and the RLS tests locally.
--
-- The fake `auth.uid()` reads the same `request.jwt.claims` setting the real one
-- does, so the tests exercise the real policy expressions unchanged.

create schema if not exists auth;

-- No default on `id`, matching the real table: Supabase's auth service always
-- supplies one. A default here would let the tests pass locally and fail on the
-- real project, which is exactly what it did.
create table if not exists auth.users (
  id uuid primary key,
  email text unique not null
);

create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- Supabase grants signed-in users access to auth.uid(); mirror that, or every
-- policy and trigger that calls it fails with "permission denied for schema auth".
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant select on auth.users to authenticated;
