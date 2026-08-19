-- Hearth — tests for putting money already in an account towards a goal (24)
--
-- Companion to 99 … 99p. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.
--
-- The point of the whole migration is that money does NOT have to move, so the
-- first thing asserted is that a pot fills with no transaction written at all.
-- The rest is the cap, which is the only part with teeth — and the part that
-- has to hold against a goal the caller cannot see.

begin;

create temp table results (id serial, check_name text, ok boolean, detail text);
grant all on results to authenticated;
grant usage, select on sequence results_id_seq to authenticated;

create function pg_temp.check(name text, condition boolean, detail text default '')
returns void language sql as $$
  insert into results (check_name, ok, detail) values (name, condition, detail)
$$;

create function pg_temp.act_as(u uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u)::text, true);
end $$;

-- Whether an assignment is accepted, as a boolean rather than an exception.
-- Its own subtransaction, so a refusal does not abandon the run.
create function pg_temp.assigns(goal uuid, amount bigint)
returns boolean language plpgsql as $$
begin
  perform public.assign_to_goal(gen_random_uuid(), goal, amount, current_date, null);
  return true;
exception when others then
  return false;
end $$;

-- Reads past RLS. `security definer` is load-bearing: under `set role
-- authenticated` a plain helper is filtered by the policies it is looking
-- behind, and would pass vacuously — which here would mean a test of "the
-- other person's goal counts towards the cap" that could never fail.
create function pg_temp.held(goal uuid)
returns bigint language plpgsql security definer as $$
declare v bigint;
begin
  select coalesce(sum(amount_minor), 0) into v
    from public.goal_entries where goal_id = goal and deleted_at is null;
  return v;
end $$;

create function pg_temp.rows_on(acct uuid)
returns bigint language plpgsql security definer as $$
declare v bigint;
begin
  select count(*) into v from public.transactions where account_id = acct and deleted_at is null;
  return v;
end $$;

do $$
declare gabi uuid := gen_random_uuid(); sam uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (gabi, 'g24@test.local'), (sam, 's24@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.sam', sam::text, false);
end $$;

set role authenticated;
select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; acct uuid; deposit uuid; car uuid;
begin
  h := public.create_household('Goal allocation test');

  -- A savings account with £3,000 already in it, put there as an opening
  -- balance: no transfer, no transaction, nothing Hearth recorded. This is
  -- exactly the money that could not be pointed at a goal before.
  insert into public.accounts (name, kind, opening_balance_minor)
  values ('Joint savings', 'savings', 300000) returning id into acct;

  insert into public.goals (name, target_minor, account_id)
  values ('House deposit', 1000000, acct) returning id into deposit;
  insert into public.goals (name, target_minor, account_id)
  values ('New car', 500000, acct) returning id into car;

  perform set_config('test.acct', acct::text, false);
  perform set_config('test.deposit', deposit::text, false);
  perform set_config('test.car', car::text, false);
end $$;

-- ============================================================
-- 1. Money that is already there
-- ============================================================

do $$
declare acct uuid := current_setting('test.acct')::uuid;
        deposit uuid := current_setting('test.deposit')::uuid;
begin
  perform pg_temp.check(
    'the account holds its opening balance with no transactions at all',
    public.account_balance_minor(acct) = 300000 and pg_temp.rows_on(acct) = 0);

  perform public.assign_to_goal(gen_random_uuid(), deposit, 200000, current_date, 'The deposit');

  perform pg_temp.check('money already in the account can be put towards a goal',
    pg_temp.held(deposit) = 200000);
  perform pg_temp.check('and nothing moved to do it',
    pg_temp.rows_on(acct) = 0 and public.account_balance_minor(acct) = 300000,
    'the whole point: a goal is a claim on money, not a container it is inside');
  perform pg_temp.check('what is left unassigned is the difference',
    public.account_assigned_minor(acct) = 200000);
end $$;

-- ============================================================
-- 2. The cap
-- ============================================================

do $$
declare acct uuid := current_setting('test.acct')::uuid;
        deposit uuid := current_setting('test.deposit')::uuid;
        car uuid := current_setting('test.car')::uuid;
        entry uuid := gen_random_uuid();
begin
  perform pg_temp.check('a second goal may claim what is left',
    pg_temp.assigns(car, 100000));
  perform pg_temp.check('and not a penny more',
    not pg_temp.assigns(car, 1),
    'two goals on one account cannot claim more than the account holds');

  -- Releasing is always allowed: it can only lower what the account's goals
  -- claim, so no cap can be breached by it.
  perform public.assign_to_goal(gen_random_uuid(), car, -40000, current_date, null);
  perform pg_temp.check('releasing is always allowed', pg_temp.held(car) = 60000);
  perform pg_temp.check('and frees the room up again', pg_temp.assigns(car, 40000));

  -- Editing an entry re-tests the whole account without counting the old
  -- amount twice: correcting £100 to £150 must be tested as £50 more, not as
  -- another £150. Room is made first, since the account is fully claimed by
  -- now — and a correction that only passed because the account was empty
  -- would not be testing anything.
  perform public.assign_to_goal(gen_random_uuid(), car, -20000, current_date, null);
  perform public.assign_to_goal(entry, car, 10000, current_date, null);

  perform pg_temp.check('an entry can be corrected upwards',
    public.assign_to_goal(entry, car, 15000, current_date, null) = entry);
  perform pg_temp.check('and its old amount does not count twice against the cap',
    pg_temp.held(car) = 95000,
    'the row replaced itself rather than being added again');
  perform pg_temp.check('a correction is still capped',
    not pg_temp.assigns(car, 5001) and pg_temp.assigns(car, 5000));

  perform pg_temp.check('a null amount releases the row',
    public.assign_to_goal(entry, car, null, current_date, null) = entry
      and pg_temp.held(car) = 85000);
end $$;

-- ============================================================
-- 3. A goal that does not say where the money is
-- ============================================================

do $$
declare loose uuid;
begin
  insert into public.goals (name, target_minor) values ('Someday', 100000) returning id into loose;
  perform pg_temp.check('a goal with no account cannot be assigned to',
    not pg_temp.assigns(loose, 1000),
    'there is no balance to cap it against, so the figure would mean nothing');
end $$;

-- ============================================================
-- 4. When the money leaves
-- ============================================================

do $$
declare acct uuid := current_setting('test.acct')::uuid;
        deposit uuid := current_setting('test.deposit')::uuid;
        car uuid := current_setting('test.car')::uuid;
        wrote integer;
begin
  perform pg_temp.check('settling an account that is within its balance writes nothing',
    public.settle_goals(acct) = 0,
    'idempotent, which is what makes it safe to call after every sync');

  -- £500 out of the £3,000. £2,000 is the deposit and £1,000 the car, so
  -- nothing is spare and the shortfall falls on the larger pot.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (acct, current_date, 'Withdrawal', -50000);

  wrote := public.settle_goals(acct);

  -- £500 out, with £150 spare: the spare is spent first and only the remaining
  -- £350 falls on a pot. Asserted as the arithmetic rather than as the figure,
  -- because the figure alone would also pass if the whole £500 came off.
  perform pg_temp.check('the unassigned money is spent first',
    200000 - pg_temp.held(deposit) = 50000 - 15000,
    'the pot gave up the withdrawal LESS what was spare, not the whole of it');
  perform pg_temp.check('and what is left of it comes off the largest goal',
    pg_temp.held(deposit) = 165000 and pg_temp.held(car) = 85000,
    'the car is untouched: it was the smaller pot');
  perform pg_temp.check('as one ordinary ledger row, so the goal history says what happened',
    wrote = 1);
  perform pg_temp.check('and the goals now claim exactly what the account holds',
    public.account_assigned_minor(acct) = public.account_balance_minor(acct));
  perform pg_temp.check('settling again writes nothing', public.settle_goals(acct) = 0);
end $$;

do $$
declare acct uuid := current_setting('test.acct')::uuid;
        deposit uuid := current_setting('test.deposit')::uuid;
        car uuid := current_setting('test.car')::uuid;
begin
  -- Enough to empty the larger pot and start on the smaller one.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (acct, current_date, 'Big withdrawal', -200000);
  perform public.settle_goals(acct);

  perform pg_temp.check('a shortfall bigger than the largest pot moves on to the next',
    pg_temp.held(deposit) = 0 and pg_temp.held(car) = 50000,
    'the deposit is emptied and the car gives up the rest');
  perform pg_temp.check('and never takes a pot below nothing',
    pg_temp.held(deposit) >= 0 and pg_temp.held(car) >= 0);
end $$;

-- ============================================================
-- 5. A goal you cannot see still counts
-- ============================================================
--
-- The reason every function here is `security definer`. Sam's personal goal on
-- the shared account is invisible to Gabi — `goals_select` hides it — and a cap
-- computed from only the goals you can see is not a cap.

do $$
declare sam uuid := current_setting('test.sam')::uuid;
        gabi uuid := current_setting('test.gabi')::uuid;
        shared uuid; code text;
begin
  -- Its own account, with its own balance: the one above has been emptied by
  -- the withdrawal tests, and a cap test on an account with nothing spare in it
  -- would pass for the wrong reason.
  insert into public.accounts (name, kind, opening_balance_minor)
  values ('Shared savings', 'savings', 100000) returning id into shared;
  perform set_config('test.shared', shared::text, false);

  select join_code into code from public.households limit 1;
  perform pg_temp.act_as(sam);
  perform public.join_household(code);
  perform pg_temp.act_as(gabi);
  perform public.upsert_account_grant(gen_random_uuid(), shared, sam, 'manage');
end $$;

do $$
declare sam uuid := current_setting('test.sam')::uuid;
        gabi uuid := current_setting('test.gabi')::uuid;
        shared uuid := current_setting('test.shared')::uuid;
        hers uuid;
begin
  perform pg_temp.act_as(sam);
  insert into public.goals (name, target_minor, account_id, owner_id)
  values ('Her own thing', 100000, shared, sam) returning id into hers;
  perform public.assign_to_goal(gen_random_uuid(), hers, 60000, current_date, null);

  perform pg_temp.act_as(gabi);
  perform pg_temp.check('a personal goal on a shared account is invisible to the other person',
    not exists (select 1 from public.goals where id = hers));
  perform pg_temp.check('and its entries are invisible too',
    not exists (select 1 from public.goal_entries where goal_id = hers));
  perform pg_temp.check('but it still counts towards what the account has claimed',
    public.account_assigned_minor(shared) = 60000,
    'a cap computed from only the goals you can see is not a cap');
end $$;

do $$
declare gabi uuid := current_setting('test.gabi')::uuid;
        shared uuid := current_setting('test.shared')::uuid;
        ours uuid;
begin
  perform pg_temp.act_as(gabi);
  insert into public.goals (name, target_minor, account_id)
  values ('Ours', 100000, shared) returning id into ours;

  perform pg_temp.check('so an assignment past the spare room is refused, whoever holds the rest',
    not pg_temp.assigns(ours, 40001),
    'the £600 he cannot see is £600 he cannot claim');
  perform pg_temp.check('and one within it is allowed', pg_temp.assigns(ours, 40000));
end $$;

-- ============================================================
-- 6. Someone else's account
-- ============================================================

do $$
declare gabi uuid := current_setting('test.gabi')::uuid;
        other uuid; goal uuid;
begin
  perform pg_temp.act_as(gabi);
  -- An account created and then not granted to anybody is unreachable, which
  -- is the shape of "a goal on an account you cannot see".
  insert into public.accounts (name, kind) values ('Not mine', 'savings') returning id into other;
  insert into public.goals (name, target_minor, account_id)
  values ('Elsewhere', 100000, other) returning id into goal;
  delete from public.account_grants where account_id = other;

  perform pg_temp.check('a goal on an account you cannot see cannot be assigned to',
    not pg_temp.assigns(goal, 1000));
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
