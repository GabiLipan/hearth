-- LOCAL TESTING ONLY — do not run this on Supabase.
--
-- Supabase grants table privileges to `anon` and `authenticated` by default;
-- plain Postgres does not. Without these the RLS tests would pass for the wrong
-- reason (permission denied rather than "the policy filtered it out"), so this
-- mirrors the real project's grants.
--
-- Note there is no DELETE grant: deletion in this app is `set deleted_at`, and
-- there are no DELETE policies anywhere. See the note at the end of 02-rls.sql.

grant usage on schema public to anon, authenticated;
grant select, insert, update on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
