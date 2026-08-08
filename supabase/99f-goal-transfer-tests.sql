-- Hearth — tests for tagging a goal on money that already moved (migration 10)
--
-- Companion to 99, 99b, 99c, 99d and 99e. Same shape: runs in a transaction,
-- rolls back, every row of the output must read ok = true.
--
-- `link_transfer` and `set_transfer_goal` are `security definer`, so RLS is off
-- inside them and the only protection is what they check by hand. The two
-- questions worth the most assertions are therefore not about goals at all:
--
--   - can somebody who may only VIEW an account tag a transfer that touches it?
--   - can somebody tag a goal that is not theirs to see?
--
-- The second is new to this migration. A personal goal is invisible to the
-- other person under `goals_select`, and `may_use_goal` is the only thing
-- restating that once RLS is switched off.

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

-- Read past RLS, to assert what is REALLY in the table. `security definer` is
-- load-bearing: under `set role authenticated` a plain helper is filtered by
-- the policies it is trying to look behind, and would pass vacuously.
create function pg_temp.val(tbl text, col text, pred text)
returns text language plpgsql security definer as $$
declare v text;
begin
  execute format('select %I::text from public.%I where %s', col, tbl, pred) into v;
  return v;
end $$;

create function pg_temp.cnt(tbl text, pred text)
returns bigint language plpgsql security definer as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I where %s', tbl, pred) into n;
  return n;
end $$;

create function pg_temp.grant_to(acct uuid, who uuid, lvl public.access_level)
returns void language plpgsql security definer as $$
begin
  insert into public.account_grants (account_id, user_id, level)
  values (acct, who, lvl)
  on conflict (account_id, user_id) where deleted_at is null
  do update set level = lvl;
end $$;

-- Did calling this raise? Returns the SQLSTATE, or null if it succeeded.
create function pg_temp.raises(stmt text)
returns text language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlstate;
end $$;

do $$
declare gabi uuid := gen_random_uuid(); sam uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (gabi, 'g6@test.local'), (sam, 'p6@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.sam',  sam::text,  false);
end $$;

set role authenticated;

-- ============================================================
-- Fixture
-- ============================================================
--
--   current  — Gabi owns, Sam may only VIEW
--   savings  — Gabi owns, Sam has no grant at all
--
-- two pairs of legs waiting to be linked, a household goal and a goal of
-- Gabi's own.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare
  h public.households;
  cur uuid; sav uuid; g uuid; leg uuid;
begin
  h := public.create_household('Goal transfer test');
  perform set_config('test.join_code', h.join_code, false);
  perform set_config('test.household', h.id::text, false);

  insert into public.accounts (name, kind) values ('Current', 'current') returning id into cur;
  insert into public.accounts (name, kind) values ('Savings', 'savings') returning id into sav;
  perform set_config('test.current', cur::text, false);
  perform set_config('test.savings', sav::text, false);

  insert into public.goals (name, target_minor) values ('House deposit', 2000000) returning id into g;
  perform set_config('test.goal', g::text, false);

  insert into public.goals (name, target_minor, owner_id)
  values ('My bike', 90000, current_setting('test.gabi')::uuid) returning id into g;
  perform set_config('test.mygoal', g::text, false);

  -- Pair one: the monthly joint → savings movement, imported from two
  -- statements and not yet paired.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (cur, current_date, 'TFR TO SAVINGS', -50000) returning id into leg;
  perform set_config('test.out1', leg::text, false);
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (sav, current_date, 'TFR FROM CURRENT', 50000) returning id into leg;
  perform set_config('test.in1', leg::text, false);

  -- Pair two, same shape, for the "tag it afterwards" path.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (cur, current_date - 30, 'TFR TO SAVINGS', -50000) returning id into leg;
  perform set_config('test.out2', leg::text, false);
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (sav, current_date - 30, 'TFR FROM CURRENT', 50000) returning id into leg;
  perform set_config('test.in2', leg::text, false);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$ begin perform public.join_household(current_setting('test.join_code')); end $$;

do $$
declare g uuid;
begin
  insert into public.goals (name, target_minor, owner_id)
  values ('Sams secret', 50000, current_setting('test.sam')::uuid) returning id into g;
  perform set_config('test.samsgoal', g::text, false);
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);
do $$ begin
  perform pg_temp.grant_to(current_setting('test.current')::uuid,
                           current_setting('test.sam')::uuid, 'view');
end $$;

-- ============================================================
-- 1. Linking a pair and tagging the goal in one go
-- ============================================================

do $$
declare tr uuid;
begin
  tr := public.link_transfer(current_setting('test.out1')::uuid,
                             current_setting('test.in1')::uuid,
                             current_setting('test.goal')::uuid);

  perform pg_temp.check('link_transfer with a goal returns a transfer id', tr is not null);

  perform pg_temp.check('both legs share the transfer id',
    pg_temp.cnt('transactions', format('transfer_id = %L', tr)) = 2);

  perform pg_temp.check('the goal lands on the incoming leg',
    pg_temp.val('transactions', 'goal_id', format('id = %L', current_setting('test.in1')))
      = current_setting('test.goal'));

  -- The whole point of tagging one side: tagging both would count the money
  -- into the pot twice.
  perform pg_temp.check('the outgoing leg is not tagged',
    pg_temp.val('transactions', 'goal_id', format('id = %L', current_setting('test.out1'))) is null);

  perform set_config('test.transfer1', tr::text, false);
end $$;

-- ============================================================
-- 2. Tagging a pair that is already linked
-- ============================================================

do $$
declare tr uuid; leg uuid;
begin
  -- Linked with no goal, the way TransferReview does it automatically.
  tr := public.link_transfer(current_setting('test.out2')::uuid,
                             current_setting('test.in2')::uuid);
  perform set_config('test.transfer2', tr::text, false);

  perform pg_temp.check('a pair linked with no goal is untagged',
    pg_temp.val('transactions', 'goal_id', format('id = %L', current_setting('test.in2'))) is null);

  leg := public.set_transfer_goal(tr, current_setting('test.goal')::uuid);

  perform pg_temp.check('set_transfer_goal returns the leg it tagged',
    leg = current_setting('test.in2')::uuid);
  perform pg_temp.check('tagging afterwards reaches the incoming leg',
    pg_temp.val('transactions', 'goal_id', format('id = %L', current_setting('test.in2')))
      = current_setting('test.goal'));

  -- Retag, then untag.
  perform public.set_transfer_goal(tr, current_setting('test.mygoal')::uuid);
  perform pg_temp.check('retagging replaces rather than adds',
    pg_temp.cnt('transactions', format('transfer_id = %L and goal_id is not null', tr)) = 1);
  perform pg_temp.check('retagging points at the new goal',
    pg_temp.val('transactions', 'goal_id', format('id = %L', current_setting('test.in2')))
      = current_setting('test.mygoal'));

  leg := public.set_transfer_goal(tr, null);
  perform pg_temp.check('untagging returns null', leg is null);
  perform pg_temp.check('untagging clears every leg',
    pg_temp.cnt('transactions', format('transfer_id = %L and goal_id is not null', tr)) = 0);
end $$;

-- ============================================================
-- 3. A goal you cannot see is a goal you cannot tag
-- ============================================================
--
-- The new authorisation in this migration. Sam's personal goal is invisible to
-- Gabi under `goals_select`, and both functions run with RLS off.

do $$
begin
  perform pg_temp.check('cannot tag someone else''s personal goal at link time',
    pg_temp.raises(format(
      'select public.link_transfer(%L::uuid, %L::uuid, %L::uuid)',
      current_setting('test.out2'), current_setting('test.in2'),
      current_setting('test.samsgoal'))) = '42501');

  perform pg_temp.check('cannot tag someone else''s personal goal afterwards',
    pg_temp.raises(format('select public.set_transfer_goal(%L::uuid, %L::uuid)',
      current_setting('test.transfer2'), current_setting('test.samsgoal'))) = '42501');

  perform pg_temp.check('a refused tag leaves the transfer untagged',
    pg_temp.cnt('transactions',
      format('transfer_id = %L and goal_id is not null', current_setting('test.transfer2'))) = 0);

  perform pg_temp.check('a goal that does not exist is refused',
    pg_temp.raises(format('select public.set_transfer_goal(%L::uuid, %L::uuid)',
      current_setting('test.transfer2'), gen_random_uuid())) = '42501');

  perform pg_temp.check('may_use_goal accepts null — that is how a tag is removed',
    public.may_use_goal(null, current_setting('test.household')::uuid));

  perform pg_temp.check('may_use_goal refuses a goal from another household',
    not public.may_use_goal(current_setting('test.goal')::uuid, gen_random_uuid()));
end $$;

-- ============================================================
-- 4. View is not write, however the tag gets there
-- ============================================================
--
-- Sam may read `current` and nothing else. Both legs have to be writable, so
-- both functions must refuse — the second one especially, because it never
-- names an account at all.

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
begin
  perform pg_temp.check('view cannot tag an existing transfer',
    pg_temp.raises(format('select public.set_transfer_goal(%L::uuid, null)',
      current_setting('test.transfer1'))) = '42501');

  perform pg_temp.check('view cannot unlink a transfer either',
    pg_temp.raises(format('select public.unlink_transfer(%L::uuid)',
      current_setting('test.transfer1'))) = '42501');

  perform pg_temp.check('the tag survived the attempts',
    pg_temp.val('transactions', 'goal_id', format('id = %L', current_setting('test.in1')))
      = current_setting('test.goal'));
end $$;

-- Contribute is the interesting middle: Sam may write what Sam added, and
-- these legs are Gabi's.
select pg_temp.act_as(current_setting('test.gabi')::uuid);
do $$ begin
  perform pg_temp.grant_to(current_setting('test.current')::uuid,
                           current_setting('test.sam')::uuid, 'contribute');
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
begin
  perform pg_temp.check('contribute cannot tag a transfer somebody else added',
    pg_temp.raises(format('select public.set_transfer_goal(%L::uuid, null)',
      current_setting('test.transfer1'))) = '42501');
end $$;

-- ============================================================
-- 5. Unlinking gives the money back to nobody
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare n integer;
begin
  n := public.unlink_transfer(current_setting('test.transfer1')::uuid);

  perform pg_temp.check('unlink released both legs', n = 2);
  perform pg_temp.check('unlink cleared the goal as well',
    pg_temp.val('transactions', 'goal_id', format('id = %L', current_setting('test.in1'))) is null);

  -- Without that, `goalProgress` would keep summing a credit that is no longer
  -- part of any transfer — the pot claiming money the app no longer believes
  -- was moved into it.
  perform pg_temp.check('nothing anywhere still points at the goal',
    pg_temp.cnt('transactions', format('goal_id = %L', current_setting('test.goal'))) = 0);
end $$;

-- ============================================================
-- 6. The old two-argument signature is gone
-- ============================================================
--
-- Not tidiness. An overload pair breaks supabase-js, which omits `undefined`
-- arguments — and an omitted argument changes PostgREST's overload resolution
-- into "could not find the function in the schema cache".

do $$
begin
  perform pg_temp.check('link_transfer has exactly one signature',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'link_transfer') = 1);

  perform pg_temp.check('and it takes three arguments',
    to_regprocedure('public.link_transfer(uuid,uuid,uuid)') is not null);

  perform pg_temp.check('called with two, the goal defaults to none',
    public.link_transfer(current_setting('test.out1')::uuid,
                         current_setting('test.in1')::uuid) is not null);
  perform pg_temp.check('and leaves the incoming leg untagged',
    pg_temp.val('transactions', 'goal_id', format('id = %L', current_setting('test.in1'))) is null);
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
