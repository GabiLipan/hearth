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
       'categories_slot_check allows slots up to 12'

union all
-- Until this reads true, permissions are still the three-tier visibility model:
-- the client's member list is empty, nobody can be granted anything, and
-- accounts still belong to the household rather than to the people on them.
select '07-permissions.sql',
       to_regclass('public.account_grants') is not null
   and to_regclass('public.household_members') is not null
   and to_regprocedure('public.my_account_ids(public.access_level)') is not null,
       'account_grants + household_members tables and my_account_ids() exist'

union all
-- Until this reads true, nobody can set their own name or picture and every
-- permissions screen says "Someone".
select '08-profiles.sql',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'household_members'
                  and column_name = 'avatar_url')
   and to_regprocedure('public.set_profile(text,text)') is not null,
       'household_members.avatar_url and set_profile() exist'

union all
-- Until this reads true, an imported statement can never satisfy a bill (the
-- bill stays overdue until you record a second payment by hand) and two
-- imported legs of a transfer can never be joined into one.
-- Deliberately NOT evidenced by `link_transfer(uuid,uuid)`: migration 10 drops
-- that signature and replaces it with a three-argument one, so testing for it
-- would report 09 as missing on an up-to-date project.
select '09-reconcile.sql',
       to_regprocedure('public.link_bill_payment(uuid,uuid,date)') is not null
   and to_regprocedure('public.unlink_bill_payment(uuid)') is not null,
       'link_bill_payment() + unlink_bill_payment() exist'

union all
-- Until this reads true, a goal can only be fed by a transfer the app itself
-- recorded — the joint → savings movement that arrived in a CSV cannot be
-- pointed at the house deposit.
select '10-goal-transfers.sql',
       to_regprocedure('public.set_transfer_goal(uuid,uuid)') is not null
   and to_regprocedure('public.link_transfer(uuid,uuid,uuid)') is not null,
       'set_transfer_goal() + three-argument link_transfer() exist'

union all
-- Until this reads true, a deleted account is gone for good as far as the app
-- is concerned (the rows are all still there, but only the SQL editor can unset
-- `deleted_at`), and an account whose last owner departed is invisible to
-- everybody including the admin entitled to claim it.
select '11-account-recovery.sql',
       to_regprocedure('public.restore_account(uuid)') is not null
   and to_regprocedure('public.deleted_accounts()') is not null
   and to_regprocedure('public.claim_account(uuid)') is not null
   and to_regprocedure('public.unowned_accounts()') is not null,
       'restore_account() + deleted_accounts() + claim_account() + unowned_accounts() exist'

union all
-- Until this reads true, unlinking a transfer leaves both legs uncategorised:
-- linking clears the category and there is nowhere to have remembered it.
select '12-transfer-categories.sql',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'transactions'
                  and column_name = 'prior_category_id'),
       'transactions.prior_category_id exists'

union all
-- Until this reads true, the tick box on a transaction saves nothing: household
-- spending paid from a personal account stays personal spending, and the
-- household's figure for it stays short.
select '13-paid-for-household.sql',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'transactions'
                  and column_name = 'paid_for_household'),
       'transactions.paid_for_household exists'

union all
-- Until this reads true, the book picker on an account saves nothing and the
-- book stays derived from the grants, which is right by default and wrong for
-- the handful of accounts the derivation cannot know about.
select '14-book-override.sql',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'accounts'
                  and column_name = 'book_override'),
       'accounts.book_override exists'

union all
-- Until this reads true, the bin only fills up: an account you deleted can be
-- restored but never got rid of, so Settings lists every account either of you
-- has ever deleted, for ever.
select '15-purge-account.sql',
       to_regprocedure('public.purge_account(uuid)') is not null,
       'purge_account() exists'

union all
-- Until this reads true, the blind spot stays one-sided: your screen can say a
-- figure is standing in for something it cannot see, and there is no way to
-- tell the one person who CAN see it.
select '16-explain-requests.sql',
       to_regprocedure('public.request_explanation(uuid)') is not null
   and to_regprocedure('public.clear_explanation(uuid)') is not null
   and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'transactions'
                  and column_name = 'explain_requested_at'),
       'request_explanation() + clear_explanation() + transactions.explain_requested_at exist'

union all
-- Until this reads true, the colour and icon pickers on an account save
-- nothing. Accounts still show a face — it is derived from the account type —
-- but choosing your own does not stick.
select '17-account-appearance.sql',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'accounts' and column_name = 'slot')
   and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'accounts' and column_name = 'icon'),
       'accounts.slot + accounts.icon exist'

union all
-- Until this reads true, the person picker on an arrival saves nothing: a
-- contribution from somebody who is not using the app stays "other income", and
-- stays in the month it landed rather than the month it was for.
select '18-contributions.sql',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'transactions'
                  and column_name = 'contributor_id'),
       'transactions.contributor_id exists'

union all
-- Not a migration: a state you can only reach by re-running 09 AFTER 10, which
-- re-creates the two-argument link_transfer beside the three-argument one.
-- PostgREST cannot then resolve the call — supabase-js drops `undefined`
-- arguments, so the client asks for a signature that is now ambiguous and gets
-- "could not find the function in the schema cache". Re-run 10 to clear it.
select 'no duplicate link_transfer',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'link_transfer') <= 1,
       'exactly one link_transfer signature — re-run 10 if this is false';
