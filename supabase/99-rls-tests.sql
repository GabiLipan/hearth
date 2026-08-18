-- Hearth — row level security tests (4 of 4)
--
-- These are the most important tests in the project. An RLS mistake is silent:
-- nothing errors, you simply see rows you should not, or fail to see rows you
-- should. Nothing in the app can catch that, because the app is not the thing
-- enforcing it.
--
-- Run locally against a scratch Postgres (see supabase/local/README.md), or in
-- the Supabase SQL editor after signing up the two accounts named below.
-- Everything runs in one transaction and rolls back, so it is safe to re-run.
--
-- Reading the output: every row must have `ok = true`.
--
-- Rewritten for migration 07. Access is no longer an enum on the account; it is
-- a grant per person per account, and no grant means no access at all. The
-- three tiers these tests used to exercise now read: an account somebody owns
-- with you (shared), one they hold at `balance`, and one they were never
-- granted at all (private).

begin;

-- ---------- fixtures ----------

create temp table results (id serial, check_name text, ok boolean, detail text);
-- The checks run while impersonating a signed-in user, so that role needs to be
-- able to record its results.
grant all on results to authenticated;
grant usage, select on sequence results_id_seq to authenticated;

create function pg_temp.check(name text, condition boolean, detail text default '')
returns void language sql as $$
  insert into results (check_name, ok, detail) values (name, condition, detail)
$$;

-- Become a signed-in user. `request.jwt.claims` is the same setting Supabase's
-- real auth.uid() reads, so the policies are exercised exactly as deployed.
create function pg_temp.act_as(u uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u)::text, true);
end $$;

-- Ids are supplied explicitly: Supabase's real `auth.users.id` has no default
-- (the auth service always provides one), unlike the local shim's table.
do $$
declare
  gabi uuid := gen_random_uuid();
  partner uuid := gen_random_uuid();
  stranger uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (gabi, 'gabi@test.local');
  insert into auth.users (id, email) values (partner, 'partner@test.local');
  insert into auth.users (id, email) values (stranger, 'stranger@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.partner', partner::text, false);
  perform set_config('test.stranger', stranger::text, false);
end $$;

set role authenticated;

-- ---------- build a household ----------

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare
  h public.households;
  shared_acct uuid; balance_acct uuid; private_acct uuid;
  groceries uuid;
begin
  h := public.create_household('Test house');
  perform set_config('test.household', h.id::text, false);
  perform set_config('test.join_code', h.join_code, false);

  select id into groceries from public.categories where name = 'Groceries';
  perform set_config('test.groceries', groceries::text, false);

  -- Every account is created deliberately: since 07 nothing is seeded for you.
  insert into public.accounts (name, kind) values ('Joint account', 'current')
    returning id into shared_acct;
  insert into public.accounts (name, kind) values ('Balance pot', 'savings')
    returning id into balance_acct;
  insert into public.accounts (name, kind) values ('Secret stash', 'cash')
    returning id into private_acct;

  perform set_config('test.shared_acct', shared_acct::text, false);
  perform set_config('test.balance_acct', balance_acct::text, false);
  perform set_config('test.private_acct', private_acct::text, false);

  -- 3 transactions: one on each account, distinct amounts so sums are unambiguous.
  insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor) values
    (shared_acct,  groceries, current_date, 'Tesco',     -1000),
    (balance_acct, groceries, current_date, 'Waitrose',  -2000),
    (private_acct, groceries, current_date, 'Gift shop', -4000);

  -- One household budget, one personal.
  perform public.upsert_budget(null, groceries, false, 50000, current_date);
  perform public.upsert_budget(null, groceries, true,  9900, current_date);
end $$;

-- Seeding sanity: the categories came from the server, exactly once — and no
-- account came with them, which is the point of the change in 07.
do $$
begin
  perform pg_temp.check('seeds 11 categories',
    (select count(*) from public.categories) = 11,
    (select count(*)::text from public.categories));
  perform pg_temp.check('seeds NO account; the 3 here were all created on purpose',
    (select count(*) from public.accounts) = 3, '');
  perform pg_temp.check('creating an account makes you its owner',
    (select count(*) from public.account_grants
      where user_id = current_setting('test.gabi')::uuid and level = 'owner' and deleted_at is null) = 3, '');
end $$;

-- ---------- the partner joins, and is granted two of the three ----------

select pg_temp.act_as(current_setting('test.partner')::uuid);

do $$
declare h public.households;
begin
  h := public.join_household(current_setting('test.join_code'));
  perform pg_temp.check('partner joins the same household',
    h.id = current_setting('test.household')::uuid, '');
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare partner uuid := current_setting('test.partner')::uuid;
begin
  perform public.upsert_account_grant(null, current_setting('test.shared_acct')::uuid,  partner, 'owner');
  perform public.upsert_account_grant(null, current_setting('test.balance_acct')::uuid, partner, 'balance');
  -- 'Secret stash' is deliberately never granted: deny by default is the whole
  -- privacy model now, rather than a `visibility` column saying so.
end $$;

-- ---------- what the partner can see ----------

select pg_temp.act_as(current_setting('test.partner')::uuid);

do $$
declare n bigint; bal bigint;
begin
  -- An account nobody granted them is invisible; a balance-only one is not.
  select count(*) into n from public.accounts;
  perform pg_temp.check('partner sees 2 of 3 accounts (the ungranted one is hidden)', n = 2, n::text);

  perform pg_temp.check('partner cannot see the ungranted account at all',
    not exists (select 1 from public.accounts where id = current_setting('test.private_acct')::uuid), '');

  -- THE core privacy assertion: transactions on a balance-only or ungranted
  -- account must not be readable, only the fully shared one's.
  select count(*) into n from public.transactions;
  perform pg_temp.check('partner sees only the 1 shared transaction', n = 1, n::text);

  perform pg_temp.check('partner cannot read the ungranted account''s transaction',
    not exists (select 1 from public.transactions where amount_minor = -4000), '');

  perform pg_temp.check('partner cannot read the balance-only transaction',
    not exists (select 1 from public.transactions where amount_minor = -2000), '');

  -- ...but the balance ITSELF must be correct, including the hidden rows.
  -- This is the bit a security_invoker view would silently get wrong: RLS would
  -- filter the -2000 out of the sum and report 0 instead of -2000.
  select balance_minor into bal from public.account_balances()
   where account_id = current_setting('test.balance_acct')::uuid;
  perform pg_temp.check('partner gets the CORRECT balance-only total (-2000, not 0)',
    bal = -2000, coalesce(bal::text, 'null'));

  perform pg_temp.check('partner gets no balance for the ungranted account',
    not exists (select 1 from public.account_balances()
                 where account_id = current_setting('test.private_acct')::uuid), '');

  -- Personal budgets are private to their owner. Untouched by 07: budgets are
  -- still owner-scoped within the household.
  select count(*) into n from public.budgets;
  perform pg_temp.check('partner sees the household budget but not the personal one', n = 1, n::text);
  perform pg_temp.check('partner cannot see a 99.00 personal budget',
    not exists (select 1 from public.budgets where amount_minor = 9900), '');

  -- They see their own grants, and the ones on accounts they could re-share.
  select count(*) into n from public.account_grants;
  perform pg_temp.check('partner sees their own grants plus everyone''s on what they own',
    n = 3, n::text);
end $$;

-- ---------- what the partner cannot do ----------

do $$
declare blocked boolean; before_rows bigint; after_rows bigint; name_now text;
begin
  begin
    insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
    values (current_setting('test.private_acct')::uuid, current_setting('test.groceries')::uuid,
            current_date, 'Sneaky', -100);
    blocked := false;
  exception when others then blocked := true;
  end;
  perform pg_temp.check('partner cannot write onto an account they were not granted', blocked, '');

  begin
    insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
    values (current_setting('test.balance_acct')::uuid, current_setting('test.groceries')::uuid,
            current_date, 'Sneaky', -100);
    blocked := false;
  exception when others then blocked := true;
  end;
  perform pg_temp.check('partner cannot write onto a balance-only account', blocked, '');

  -- Renaming needs 'manage'; balance is three tiers below it. A blocked UPDATE
  -- matches no rows rather than raising, so this checks `not found`.
  update public.accounts set name = 'Renamed by partner'
   where id = current_setting('test.balance_acct')::uuid;
  blocked := not found;
  perform pg_temp.check('partner cannot rename an account they only watch', blocked, '');

  begin
    insert into public.budgets (category_id, owner_id, amount_minor)
    values (current_setting('test.groceries')::uuid, current_setting('test.gabi')::uuid, 100);
    blocked := false;
  exception when others then blocked := true;
  end;
  perform pg_temp.check('partner cannot set a budget in someone else''s name', blocked, '');

  -- Sharing is the owner's to decide: 'balance' cannot re-share what it can see.
  begin
    perform public.upsert_account_grant(null, current_setting('test.balance_acct')::uuid,
                                        current_setting('test.stranger')::uuid, 'view');
    blocked := false;
  exception when others then blocked := true;
  end;
  perform pg_temp.check('partner cannot hand out access to an account they do not own', blocked, '');

  -- No DELETE policy exists anywhere: deletion is `set deleted_at`, so a row
  -- can never vanish without leaving a tombstone for the other device.
  --
  -- Asserted by counting rows, not by expecting an error. Signed-in users DO
  -- hold the DELETE privilege — Supabase grants it — so the statement succeeds
  -- and quietly affects nothing, because RLS with no DELETE policy matches no
  -- rows. "Did an exception fire?" would have been testing the grant; what
  -- matters is whether the rows are still there.
  select count(*) into before_rows from public.transactions;
  begin
    delete from public.transactions;
  exception when others then null; -- also fine: some setups deny the privilege
  end;
  select count(*) into after_rows from public.transactions;
  perform pg_temp.check('nobody can hard-delete a transaction',
    after_rows = before_rows and before_rows > 0, format('%s -> %s', before_rows, after_rows));
end $$;

-- ---------- a stranger in another household ----------

select pg_temp.act_as(current_setting('test.stranger')::uuid);

do $$
declare n bigint;
begin
  perform public.create_household('Other house');
  select count(*) into n from public.transactions;
  perform pg_temp.check('stranger sees none of our transactions', n = 0, n::text);
  select count(*) into n from public.accounts;
  perform pg_temp.check('stranger starts with no accounts at all', n = 0, n::text);
  select count(*) into n from public.categories;
  perform pg_temp.check('stranger gets their own 11 seeded categories', n = 11, n::text);
  select count(*) into n from public.household_members;
  perform pg_temp.check('stranger sees only their own household''s members', n = 1, n::text);
end $$;

-- ---------- changes to who-can-see-what bump the epoch ----------
-- This is what tells another device to drop its cache and re-pull. Without it, a
-- row that becomes invisible stays cached forever: an invisible row emits no
-- realtime event and no tombstone, so nothing else can announce the change.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare before_epoch integer; after_epoch integer; partner uuid := current_setting('test.partner')::uuid;
begin
  select visibility_epoch into before_epoch from public.households
   where id = current_setting('test.household')::uuid;

  perform public.upsert_account_grant(null, current_setting('test.private_acct')::uuid, partner, 'view');

  select visibility_epoch into after_epoch from public.households
   where id = current_setting('test.household')::uuid;
  perform pg_temp.check('granting access bumps the epoch',
    after_epoch > before_epoch, format('%s -> %s', before_epoch, after_epoch));

  -- Revoking hides rows that are already cached, with no tombstone to announce
  -- it, so it must bump in this direction too.
  before_epoch := after_epoch;
  perform public.upsert_account_grant(null, current_setting('test.private_acct')::uuid, partner, 'none');
  select visibility_epoch into after_epoch from public.households
   where id = current_setting('test.household')::uuid;
  perform pg_temp.check('revoking access also bumps the epoch',
    after_epoch > before_epoch, format('%s -> %s', before_epoch, after_epoch));

  -- Moving a transaction onto an account with a different set of readers hides
  -- it from somebody with no tombstone, so that bumps too.
  before_epoch := after_epoch;
  update public.transactions set account_id = current_setting('test.private_acct')::uuid
   where amount_minor = -1000;
  select visibility_epoch into after_epoch from public.households
   where id = current_setting('test.household')::uuid;
  perform pg_temp.check('moving a transaction to a less-shared account bumps the epoch',
    after_epoch > before_epoch, format('%s -> %s', before_epoch, after_epoch));
end $$;

-- ---------- balance-only accounts signal the people watching them ----------

do $$
declare touched_at timestamptz; later timestamptz;
begin
  select updated_at into touched_at from public.accounts
   where id = current_setting('test.balance_acct')::uuid;
  perform pg_sleep(0.01);
  insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
  values (current_setting('test.balance_acct')::uuid, current_setting('test.groceries')::uuid,
          current_date, 'Later', -500);
  select updated_at into later from public.accounts
   where id = current_setting('test.balance_acct')::uuid;
  -- Somebody holding it at 'balance' never receives a realtime event for a
  -- transaction they cannot see, so touching the account row is their only cue
  -- to re-read the balance.
  perform pg_temp.check('a balance-only account is touched when its transactions change',
    later > touched_at, '');
end $$;

-- ---------- bills post exactly once ----------

do $$
declare b uuid; n bigint; first_run integer; second_run integer;
begin
  insert into public.bills (name, payee, amount_minor, category_id, account_id, freq, next_due, active, auto_post)
  values ('Rent', 'Landlord', -80000, current_setting('test.groceries')::uuid,
          current_setting('test.shared_acct')::uuid, 'monthly', current_date - 35, true, true)
  returning id into b;

  first_run := public.post_due_bills(current_date);
  perform pg_temp.check('an overdue monthly bill posts its 2 missed occurrences',
    first_run = 2, first_run::text);

  -- Simulate the other device running the same catch-up concurrently: rewind
  -- next_due and run again. The composite primary key on bill_postings is what
  -- stops a second copy of each occurrence being recorded.
  update public.bills set next_due = current_date - 35 where id = b;
  second_run := public.post_due_bills(current_date);
  perform pg_temp.check('a second device re-posting the same occurrences records none',
    second_run = 0, second_run::text);

  select count(*) into n from public.transactions where bill_id = b;
  perform pg_temp.check('exactly 2 transactions exist for the bill, not 4', n = 2, n::text);
end $$;

-- ---------- constrained upserts ----------

do $$
declare n bigint; r public.rules; groceries uuid := current_setting('test.groceries')::uuid; other uuid;
begin
  select id into other from public.categories where name = 'Transport';

  -- Re-learning a payee must update the rule, not fail on the unique index.
  -- Four arguments since migration 20: the name a rule may also carry.
  perform public.upsert_rule(null, 'tesco', groceries, null, null, null, null);
  r := public.upsert_rule(null, 'tesco', other, null, null, null, null);
  select count(*) into n from public.rules where deleted_at is null;
  perform pg_temp.check('re-learning a payee updates its rule instead of duplicating', n = 1, n::text);
  perform pg_temp.check('re-learning a payee changes the category', r.category_id = other, '');

  -- Changing a budget must update in place, and null removes it.
  perform public.upsert_budget(null, groceries, false, 12345, current_date);
  select count(*) into n from public.budgets where owner_id is null and deleted_at is null;
  perform pg_temp.check('changing a household budget updates in place', n = 1, n::text);
  perform pg_temp.check('changing a household budget stores the new amount',
    (select amount_minor from public.budgets where owner_id is null and deleted_at is null) = 12345, '');

  perform public.upsert_budget(null, groceries, false, null, current_date);
  select count(*) into n from public.budgets where owner_id is null and deleted_at is null;
  perform pg_temp.check('a null amount removes the budget', n = 0, n::text);
end $$;

-- ---------- results ----------

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
