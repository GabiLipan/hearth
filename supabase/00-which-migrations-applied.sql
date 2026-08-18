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
-- Until this reads true, a household expense paid from a personal account is
-- right on the payer's screen and invisible on everybody else's — which is the
-- one documented hole in the household book, and the reason the two of you can
-- read different grocery figures for the same month. The consent switch in the
-- account form saves nothing until it does.
select '19-published-household-rows.sql',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'accounts'
                  and column_name = 'publishes_household_rows')
   and to_regprocedure('public.account_publishes(uuid)') is not null,
       'accounts.publishes_household_rows + account_publishes() exist'

union all
-- Also not a migration, and the one thing that can go wrong here without any
-- error: 19 REPLACES transactions_select, and re-running 07 afterwards puts
-- 07's narrower version back. Nothing fails — published rows simply stop
-- arriving, and the household book quietly loses whatever was paid privately.
-- Re-run 19 to clear it.
select 'transactions_select publishes',
       coalesce(
         (select pg_get_expr(pol.polqual, pol.polrelid) like '%account_publishes%'
            from pg_policy pol
            where pol.polrelid = 'public.transactions'::regclass
              and pol.polname = 'transactions_select'),
         false),
       'transactions_select carries the published-row disjunct — re-run 19 if this is false'

union all
-- Until this reads true, the name field on a transaction saves nothing: rows
-- keep showing whatever the bank wrote, and a name learned on one is forgotten
-- by the next.
select '20-transaction-titles.sql',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'transactions' and column_name = 'title')
   and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'rules' and column_name = 'title')
   and to_regprocedure('public.upsert_rule(uuid,text,uuid,text)') is not null,
       'transactions.title + rules.title + four-argument upsert_rule exist'

union all
-- Until this reads true, a rule can only ever match on the payee: two
-- subscriptions from one vendor at two prices are one rule, and filing either
-- files both.
select '21-rule-conditions.sql',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'rules'
                  and column_name = 'amount_min_minor')
   and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'rules' and column_name = 'account_id')
   and to_regprocedure('public.upsert_rule(uuid,text,uuid,text,bigint,bigint,uuid)') is not null,
       'rules.amount_min_minor + rules.account_id + seven-argument upsert_rule exist'

union all
-- 22 REPLACES 21's upsert_rule with the SAME seven-argument signature, so
-- `to_regprocedure` cannot tell the two apart and neither can the duplicate
-- check below — this one reads the body. Until it is true, editing what a rule
-- matches (its payee, an amount, an account) dead-letters on `rules_pkey` and
-- cannot be retried. Note the trap this creates in the other direction:
-- re-running 21 AFTER 22 puts the broken body back silently, with no error and
-- no extra overload for anything else here to notice.
select '22-rule-edits.sql',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'upsert_rule'
                  and p.prosrc like '%deleted on another device%'),
       'upsert_rule edits an existing rule in place instead of re-inserting it'

union all
-- Until this reads true the colour picker offers the twelve slots and nothing
-- else: a custom colour is written into the outbox, refused by PostgREST as an
-- unknown column, and surfaces as a dead letter minutes later in Settings.
select '23-custom-colours.sql',
       (select count(*) from information_schema.columns
         where table_schema = 'public' and column_name = 'color'
           and table_name in ('categories', 'accounts', 'goals')) = 3,
       'categories.color + accounts.color + goals.color exist'

union all
-- Not a migration: 21 replaces the uniqueness rule on `rules`, because two
-- rules for one payee at two amounts is the whole point of it. If the old index
-- is still here the second one is refused outright, with a duplicate-key dead
-- letter minutes later. Re-run 21.
select 'rules keyed on the whole condition',
       to_regclass('public.rules_match_unique') is null
   and to_regclass('public.rules_condition_unique') is not null,
       'rules_condition_unique has replaced rules_match_unique — re-run 21 if this is false'

union all
-- Not a migration: the same trap 09-after-10 sets, now two files along. Both 20
-- and 21 drop the previous upsert_rule and replace it with a wider one, and 03
-- and 20 are both still re-runnable — running either AFTER 21 or 22 puts an
-- older signature back beside the current one. supabase-js drops `undefined`
-- arguments, so the call becomes ambiguous and every rule the app learns
-- dead-letters with "could not find the function in the schema cache". Re-run
-- the highest of them to clear it.
select 'no duplicate upsert_rule',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'upsert_rule') <= 1,
       'exactly one upsert_rule signature — re-run 22 if this is false'

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
