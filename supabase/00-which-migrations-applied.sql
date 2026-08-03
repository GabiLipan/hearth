-- Hearth — which migrations has this project actually had?
--
-- Read-only. Paste into the Supabase SQL editor and run; it changes nothing.
--
-- There is no migrations table (the numbered files are applied by hand), so this
-- asks the schema itself what is present. Every row should read `applied = true`
-- before you run the next file in the sequence.

select '01-schema.sql' as migration,
       to_regclass('public.households') is not null
   and to_regclass('public.transactions') is not null as applied,
       'households + transactions tables exist' as evidence

union all
select '02-rls.sql',
       exists (select 1 from pg_policies
                where schemaname = 'public' and tablename = 'accounts' and policyname = 'accounts_select'),
       'accounts_select policy exists'

union all
select '03-rpc.sql',
       to_regprocedure('public.account_balances()') is not null
   and to_regprocedure('public.wipe_household()') is not null,
       'account_balances() + wipe_household() exist'

union all
select '04-subcategories-budgets-goals.sql',
       to_regclass('public.goals') is not null
   and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'categories' and column_name = 'owner_id')
   and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'budgets' and column_name = 'month'),
       'goals table + categories.owner_id + budgets.month exist'

union all
-- The one that matters for privacy. If this reads false, "Erase everything"
-- still deletes the other person's private accounts.
select '05-ownership-and-deletes.sql',
       to_regprocedure('public.delete_account(uuid,boolean)') is not null,
       'delete_account() exists'

union all
-- Until this reads true, adding a category fails once the household has enough
-- of them for the auto-assigned colour to land past slot 8.
select '06-category-palette.sql',
       exists (select 1 from pg_constraint
                where conrelid = 'public.categories'::regclass
                  and conname = 'categories_slot_check'
                  and pg_get_constraintdef(oid) like '%12%'),
       'categories_slot_check allows slots up to 12';
