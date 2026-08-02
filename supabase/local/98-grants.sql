-- LOCAL TESTING ONLY — do not run this on Supabase.
--
-- Supabase grants table privileges to `anon` and `authenticated` by default;
-- plain Postgres does not. Without these the RLS tests would pass for the wrong
-- reason (permission denied rather than "the policy filtered it out"), so this
-- mirrors the real project's grants.
--
-- The DELETE grant is included deliberately, because Supabase grants it. What
-- stops a hard delete is the absence of a DELETE *policy*, not the absence of
-- the privilege — and those two fail differently: no privilege raises an error,
-- while no policy silently matches zero rows. Withholding the grant here made
-- the "nobody can hard-delete" test pass locally for the wrong reason.

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
