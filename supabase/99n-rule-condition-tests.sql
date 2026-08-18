-- Hearth — tests for what a rule may match on (migration 21)
--
-- Companion to 99 … 99m. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.
--
-- Three things are worth pinning here, and only one of them is the feature.
-- The feature is that two rules for one payee at two amounts can now both
-- exist, which is a claim about an INDEX rather than about a column — the old
-- `rules_match_unique` refused the second one outright. The other two are the
-- ways this could go quietly wrong: an account you cannot see must not be
-- keyable (the function is `security definer`, so the policies that would have
-- said so are switched off), and there must be exactly ONE upsert_rule
-- signature left, because a second one is silent.

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

-- Reads past RLS, to assert what is REALLY in the table. Must be `security
-- definer`: under `set role authenticated` a plain helper is filtered by the
-- policies it is trying to look behind, and passes vacuously.
create function pg_temp.count_rules(pred text)
returns int language plpgsql security definer as $$
declare n int;
begin
  execute format('select count(*) from public.rules where %s', pred) into n;
  return n;
end $$;

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
  insert into auth.users (id, email) values (gabi, 'rc1@test.local'), (sam, 'rc2@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.sam',  sam::text,  false);
end $$;

set role authenticated;

-- ============================================================
-- 0. The migration is applied
-- ============================================================

do $$
begin
  perform pg_temp.check('rules.amount_min_minor exists',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'rules' and column_name = 'amount_min_minor'));
  perform pg_temp.check('rules.account_id exists',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'rules' and column_name = 'account_id'));

  -- The old index is the whole obstacle: while it stands, the second rule for
  -- a payee is refused with a duplicate key and the feature does not exist.
  perform pg_temp.check('the payee-only unique index is gone',
    to_regclass('public.rules_match_unique') is null,
    'run 21 again');
  perform pg_temp.check('uniqueness is over the whole condition set',
    to_regclass('public.rules_condition_unique') is not null);

  -- The one failure with no error message: two signatures, an ambiguous call,
  -- and every learned rule dead-lettering a minute later in Settings.
  perform pg_temp.check('exactly one upsert_rule signature',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'upsert_rule') = 1,
    'run 21 again if 03-rpc.sql or 20 was re-run after it');
end $$;

-- ============================================================
-- Fixture
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; joint uuid; c uuid;
begin
  h := public.create_household('Rule condition test');
  select id into c from public.categories where kind = 'expense' limit 1;
  perform set_config('test.category', c::text, false);

  insert into public.accounts (name, kind) values ('Joint', 'current') returning id into joint;
  perform set_config('test.joint', joint::text, false);
end $$;

-- ============================================================
-- 1. Two rules, one payee
-- ============================================================

do $$
declare r public.rules; n int; c uuid := current_setting('test.category')::uuid;
begin
  r := public.upsert_rule(null, 'vendor a', c, 'Design tools', 899, 899, null);
  perform pg_temp.check('an exact amount is stored as a magnitude',
    r.amount_min_minor = 899 and r.amount_max_minor = 899);

  r := public.upsert_rule(null, 'vendor a', c, 'Music', 1299, 1299, null);
  n := pg_temp.count_rules('lower(match) = ''vendor a'' and deleted_at is null');
  perform pg_temp.check('two prices from one payee are two rules', n = 2, n::text);

  -- …and re-learning either one still updates in place, which is the property
  -- the RPC exists for: two devices learning the same payee during a shared
  -- import must converge rather than collide.
  r := public.upsert_rule(null, 'vendor a', c, 'Music streaming', 1299, 1299, null);
  n := pg_temp.count_rules('lower(match) = ''vendor a'' and deleted_at is null');
  perform pg_temp.check('re-learning one of them updates rather than duplicating', n = 2, n::text);
  perform pg_temp.check('and it is the one with the matching amount that changed',
    r.title = 'Music streaming' and r.amount_max_minor = 1299);

  -- The unconditional rule is a third thing: it says "this payee, whatever it
  -- costs", which is what an energy bill needs.
  r := public.upsert_rule(null, 'vendor a', c, 'Vendor A', null, null, null);
  n := pg_temp.count_rules('lower(match) = ''vendor a'' and deleted_at is null');
  perform pg_temp.check('a rule with no amount sits beside them', n = 3, n::text);

  -- …and IS a single rule. Nulls are distinct in a unique index by default, so
  -- without the coalesce in `rules_condition_unique` this would be a fourth.
  r := public.upsert_rule(null, 'vendor a', c, 'Vendor A Ltd', null, null, null);
  n := pg_temp.count_rules('lower(match) = ''vendor a'' and deleted_at is null');
  perform pg_temp.check('two unconditional rules for one payee are still one', n = 3, n::text);
end $$;

-- ============================================================
-- 2. The bounds are corrected rather than refused
-- ============================================================

do $$
declare r public.rules; c uuid := current_setting('test.category')::uuid;
begin
  -- Two bounds typed into two boxes pass through "larger first" on the way to
  -- being right; dead-lettering that a minute later in Settings would be a poor
  -- way to be told.
  r := public.upsert_rule(null, 'vendor b', c, null, 1500, 500, null);
  perform pg_temp.check('bounds the wrong way round are swapped',
    r.amount_min_minor = 500 and r.amount_max_minor = 1500);

  -- A magnitude. Spending is stored negative and nobody thinks of a
  -- subscription as costing minus eight ninety-nine.
  r := public.upsert_rule(null, 'vendor c', c, null, -899, -899, null);
  perform pg_temp.check('a negative bound is taken as its magnitude',
    r.amount_min_minor = 899 and r.amount_max_minor = 899);
end $$;

-- ============================================================
-- 3. An account you cannot see is not one you may key a rule on
-- ============================================================
--
-- The function is `security definer`, so `accounts_select` is not applied. This
-- restates it. Without the check, a rule would be a way to confirm that a
-- particular account id exists on somebody else's device.

do $$
declare c uuid := current_setting('test.category')::uuid; stranger uuid := gen_random_uuid();
begin
  perform pg_temp.check('a rule may be keyed on an account I can see',
    (public.upsert_rule(null, 'vendor d', c, null, null, null,
       current_setting('test.joint')::uuid)).account_id = current_setting('test.joint')::uuid);

  perform pg_temp.check('a rule may not be keyed on an account I cannot',
    pg_temp.raises(format('select public.upsert_rule(null, %L, %L::uuid, null, null, null, %L::uuid)',
                          'vendor e', c, stranger)) = '42501');
end $$;

-- ============================================================
-- 4. What was true before is still true
-- ============================================================

do $$
declare c uuid := current_setting('test.category')::uuid;
begin
  perform pg_temp.check('a rule that says nothing at all is still refused',
    pg_temp.raises(format('select public.upsert_rule(null, %L, null, null, null, null, null)', 'nothing'))
      = '23514');

  -- The conditions are not something a rule can be ABOUT: they narrow what it
  -- matches, they are not what it says.
  perform pg_temp.check('conditions alone do not make a rule that says something',
    pg_temp.raises(format('select public.upsert_rule(null, %L, null, null, 899, 899, null)', 'nothing either'))
      = '23514');
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
