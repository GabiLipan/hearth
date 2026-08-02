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
  perform set_config('test.gabi', gabi::text, true);
  perform set_config('test.partner', partner::text, true);
  perform set_config('test.stranger', stranger::text, true);
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

  select id into shared_acct from public.accounts where name = 'Joint account';

  insert into public.accounts (name, kind, visibility)
  values ('Balance pot', 'savings', 'balance') returning id into balance_acct;

  insert into public.accounts (name, kind, visibility)
  values ('Secret stash', 'cash', 'private') returning id into private_acct;

  perform set_config('test.shared_acct', shared_acct::text, false);
  perform set_config('test.balance_acct', balance_acct::text, false);
  perform set_config('test.private_acct', private_acct::text, false);

  -- 3 transactions: one on each account, distinct amounts so sums are unambiguous.
  insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor) values
    (shared_acct,  groceries, current_date, 'Tesco',     -1000),
    (balance_acct, groceries, current_date, 'Waitrose',  -2000),
    (private_acct, groceries, current_date, 'Gift shop', -4000);

  -- One household budget, one personal.
  perform public.upsert_budget(null, groceries, false, 50000);
  perform public.upsert_budget(null, groceries, true,  9900);
end $$;

-- Seeding sanity: defaults came from the server, exactly once.
do $$
begin
  perform pg_temp.check('seeds 11 categories',
    (select count(*) from public.categories) = 11,
    (select count(*)::text from public.categories));
  perform pg_temp.check('seeds 1 starter account, plus the 2 just created',
    (select count(*) from public.accounts) = 3, '');
end $$;

-- ---------- the partner joins ----------

select pg_temp.act_as(current_setting('test.partner')::uuid);

do $$
declare h public.households;
begin
  h := public.join_household(current_setting('test.join_code'));
  perform pg_temp.check('partner joins the same household',
    h.id = current_setting('test.household')::uuid, '');
end $$;

-- ---------- what the partner can see ----------

do $$
declare n bigint; bal bigint;
begin
  -- A private account is invisible; a balance-only one is not.
  select count(*) into n from public.accounts;
  perform pg_temp.check('partner sees 2 of 3 accounts (private one hidden)', n = 2, n::text);

  perform pg_temp.check('partner cannot see the private account at all',
    not exists (select 1 from public.accounts where id = current_setting('test.private_acct')::uuid), '');

  -- THE core privacy assertion: transactions on a balance-only or private
  -- account must not be readable, only the shared one's.
  select count(*) into n from public.transactions;
  perform pg_temp.check('partner sees only the 1 shared transaction', n = 1, n::text);

  perform pg_temp.check('partner cannot read the private account transaction',
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

  perform pg_temp.check('partner gets no balance for the private account',
    not exists (select 1 from public.account_balances()
                 where account_id = current_setting('test.private_acct')::uuid), '');

  -- Personal budgets are private to their owner.
  select count(*) into n from public.budgets;
  perform pg_temp.check('partner sees the household budget but not the personal one', n = 1, n::text);
  perform pg_temp.check('partner cannot see a 99.00 personal budget',
    not exists (select 1 from public.budgets where amount_minor = 9900), '');
end $$;

-- ---------- what the partner cannot do ----------

do $$
declare blocked boolean;
begin
  begin
    insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
    values (current_setting('test.private_acct')::uuid, current_setting('test.groceries')::uuid,
            current_date, 'Sneaky', -100);
    blocked := false;
  exception when others then blocked := true;
  end;
  perform pg_temp.check('partner cannot write onto a private account', blocked, '');

  begin
    update public.accounts set visibility = 'shared'
     where id = current_setting('test.balance_acct')::uuid;
    blocked := not found;
  exception when others then blocked := true;
  end;
  perform pg_temp.check('partner cannot re-tier an account they do not own', blocked, '');

  begin
    insert into public.budgets (category_id, owner_id, amount_minor)
    values (current_setting('test.groceries')::uuid, current_setting('test.gabi')::uuid, 100);
    blocked := false;
  exception when others then blocked := true;
  end;
  perform pg_temp.check('partner cannot set a budget in someone else''s name', blocked, '');

  -- No DELETE policy exists anywhere: deletion is `set deleted_at`, so a row
  -- can never vanish without leaving a tombstone for the other device.
  begin
    delete from public.transactions;
    blocked := false;
  exception when others then blocked := true;
  end;
  perform pg_temp.check('nobody can hard-delete a transaction', blocked, '');
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
  perform pg_temp.check('stranger sees only their own starter account', n = 1, n::text);
  select count(*) into n from public.categories;
  perform pg_temp.check('stranger gets their own 11 seeded categories', n = 11, n::text);
end $$;

-- ---------- visibility changes bump the epoch ----------
-- This is what tells a partner's device to drop its cache and re-pull. Without
-- it, a row that becomes invisible stays cached forever: an invisible row emits
-- no realtime event and no tombstone, so nothing else can announce the change.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare before_epoch integer; after_epoch integer;
begin
  select visibility_epoch into before_epoch from public.households
   where id = current_setting('test.household')::uuid;

  update public.accounts set visibility = 'private'
   where id = current_setting('test.shared_acct')::uuid;

  select visibility_epoch into after_epoch from public.households
   where id = current_setting('test.household')::uuid;
  perform pg_temp.check('making an account private bumps the epoch',
    after_epoch > before_epoch, format('%s -> %s', before_epoch, after_epoch));

  -- Back to shared: rows become visible again with an OLD updated_at, so a
  -- delta pull would never fetch them. The epoch must bump in this direction too.
  before_epoch := after_epoch;
  update public.accounts set visibility = 'shared'
   where id = current_setting('test.shared_acct')::uuid;
  select visibility_epoch into after_epoch from public.households
   where id = current_setting('test.household')::uuid;
  perform pg_temp.check('making an account shared again also bumps the epoch',
    after_epoch > before_epoch, format('%s -> %s', before_epoch, after_epoch));

  -- Moving a transaction onto a restricted account hides it from the partner
  -- with no tombstone, so that must bump too.
  before_epoch := after_epoch;
  update public.transactions set account_id = current_setting('test.private_acct')::uuid
   where amount_minor = -1000;
  select visibility_epoch into after_epoch from public.households
   where id = current_setting('test.household')::uuid;
  perform pg_temp.check('moving a transaction to a private account bumps the epoch',
    after_epoch > before_epoch, format('%s -> %s', before_epoch, after_epoch));
end $$;

-- ---------- balance-only accounts signal their partner ----------

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
  -- The partner never receives a realtime event for a transaction they cannot
  -- see, so touching the account row is their only cue to re-read the balance.
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
  perform public.upsert_rule(null, 'tesco', groceries);
  r := public.upsert_rule(null, 'tesco', other);
  select count(*) into n from public.rules where deleted_at is null;
  perform pg_temp.check('re-learning a payee updates its rule instead of duplicating', n = 1, n::text);
  perform pg_temp.check('re-learning a payee changes the category', r.category_id = other, '');

  -- Changing a budget must update in place, and null removes it.
  perform public.upsert_budget(null, groceries, false, 12345);
  select count(*) into n from public.budgets where owner_id is null and deleted_at is null;
  perform pg_temp.check('changing a household budget updates in place', n = 1, n::text);
  perform pg_temp.check('changing a household budget stores the new amount',
    (select amount_minor from public.budgets where owner_id is null and deleted_at is null) = 12345, '');

  perform public.upsert_budget(null, groceries, false, null);
  select count(*) into n from public.budgets where owner_id is null and deleted_at is null;
  perform pg_temp.check('a null amount removes the budget', n = 0, n::text);
end $$;

-- ---------- results ----------

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
