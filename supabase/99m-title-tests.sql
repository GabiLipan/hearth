-- Hearth — tests for the name on a transaction (migration 20)
--
-- Companion to 99 … 99l. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.
--
-- Two halves worth pinning. `transactions.title` is a plain writable column, so
-- what it gets is what any plain column gets — the check constraint, and
-- `transactions_update` and nothing new deciding who may set one. And
-- `upsert_rule` changed shape: it takes a name, `category_id` may now be null,
-- and there must be exactly ONE signature of it left, because a second one is
-- silent — supabase-js drops undefined arguments and every rule the app learns
-- would dead-letter with "could not find the function in the schema cache".

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
create function pg_temp.val(tbl text, col text, pred text)
returns text language plpgsql security definer as $$
declare v text;
begin
  execute format('select %I::text from public.%I where %s', col, tbl, pred) into v;
  return v;
end $$;

create function pg_temp.set_level(acct uuid, who uuid, lvl public.access_level)
returns void language plpgsql security definer as $$
begin
  insert into public.account_grants (account_id, user_id, level)
  values (acct, who, lvl)
  on conflict (account_id, user_id) where deleted_at is null
  do update set level = lvl;
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
  insert into auth.users (id, email) values (gabi, 'ti@test.local'), (sam, 'tl@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.sam',  sam::text,  false);
end $$;

set role authenticated;

-- ============================================================
-- 0. The migration is applied
-- ============================================================

do $$
begin
  perform pg_temp.check('transactions.title exists',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'transactions' and column_name = 'title'));
  perform pg_temp.check('rules.title exists',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'rules' and column_name = 'title'));

  -- The one failure with no error message: two signatures, an ambiguous call,
  -- and every learned rule dead-lettering a minute later in Settings.
  perform pg_temp.check('exactly one upsert_rule signature',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'upsert_rule') = 1,
    'run 20 again if 03-rpc.sql was re-run after it');
end $$;

-- ============================================================
-- Fixture
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; joint uuid; t uuid; c uuid;
begin
  h := public.create_household('Title test');
  perform set_config('test.join_code', h.join_code, false);

  select id into c from public.categories where kind = 'expense' limit 1;
  perform set_config('test.category', c::text, false);

  insert into public.accounts (name, kind) values ('Joint', 'current') returning id into joint;
  perform set_config('test.joint', joint::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (joint, current_date, 'SQ *THE GOOD FORK 3241', -4520) returning id into t;
  perform set_config('test.row', t::text, false);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
declare t uuid;
begin
  perform public.join_household(current_setting('test.join_code'));
  perform pg_temp.set_level(current_setting('test.joint')::uuid, current_setting('test.sam')::uuid, 'owner');

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.joint')::uuid, current_date, 'DD PETS AT HOME INS', -1899) returning id into t;
  perform set_config('test.sams_row', t::text, false);
end $$;

-- ============================================================
-- 1. Naming a row
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
begin
  perform pg_temp.check('a row starts with no name of its own',
    pg_temp.val('transactions', 'title', format('id = %L', current_setting('test.row'))) is null);

  update public.transactions set title = 'Dinner at The Good Fork'
   where id = current_setting('test.row')::uuid;

  perform pg_temp.check('an owner can name a row',
    pg_temp.val('transactions', 'title',
      format('id = %L', current_setting('test.row'))) = 'Dinner at The Good Fork');

  -- The payee is what the bank said, and everything that matches, pairs or
  -- de-duplicates still reads it. Naming a row must not touch it.
  perform pg_temp.check('naming a row leaves the payee exactly as the bank wrote it',
    pg_temp.val('transactions', 'payee',
      format('id = %L', current_setting('test.row'))) = 'SQ *THE GOOD FORK 3241');
end $$;

do $$
begin
  update public.transactions set title = null where id = current_setting('test.row')::uuid;
  perform pg_temp.check('and can take the name back off again',
    pg_temp.val('transactions', 'title', format('id = %L', current_setting('test.row'))) is null);

  perform pg_temp.check('a blank name is refused rather than rendering as an empty row',
    pg_temp.raises(format('update public.transactions set title = %L where id = %L',
                          '   ', current_setting('test.row'))) = '23514');

  perform pg_temp.check('a name is one line',
    pg_temp.raises(format('update public.transactions set title = %L where id = %L',
                          E'Dinner\nand drinks', current_setting('test.row'))) = '23514');

  perform pg_temp.check('a name is not an essay',
    pg_temp.raises(format('update public.transactions set title = %L where id = %L',
                          repeat('x', 81), current_setting('test.row'))) = '23514');

  update public.transactions set title = 'Dinner at The Good Fork'
   where id = current_setting('test.row')::uuid;
end $$;

-- ============================================================
-- 2. Who may name one
-- ============================================================
--
-- Nothing new: `transactions_update` already decides, and this is a field on a
-- transaction. Asserted anyway, because a migration that quietly added a policy
-- of its own is exactly how "anyone may relabel anything" would arrive.

do $$
begin
  perform pg_temp.set_level(current_setting('test.joint')::uuid,
                            current_setting('test.gabi')::uuid, 'contribute');

  update public.transactions set title = 'Dinner out'
   where id = current_setting('test.row')::uuid;
  perform pg_temp.check('at contribute you may name what you added',
    pg_temp.val('transactions', 'title',
      format('id = %L', current_setting('test.row'))) = 'Dinner out');

  -- Sam's row. The UPDATE matches no rows rather than raising: that is what a
  -- policy does, which is why a bulk rename has to be filtered client-side.
  update public.transactions set title = 'Not mine to name'
   where id = current_setting('test.sams_row')::uuid;
  perform pg_temp.check('at contribute you may not name what somebody else added',
    pg_temp.val('transactions', 'title',
      format('id = %L', current_setting('test.sams_row'))) is null);

  perform pg_temp.set_level(current_setting('test.joint')::uuid,
                            current_setting('test.gabi')::uuid, 'owner');
end $$;

-- ============================================================
-- 3. It replicates like any other edit
-- ============================================================

do $$
declare before_at timestamptz; after_at timestamptz;
begin
  before_at := pg_temp.val('transactions', 'updated_at',
    format('id = %L', current_setting('test.row')))::timestamptz;

  update public.transactions set title = 'Dinner at the Fork'
   where id = current_setting('test.row')::uuid;

  after_at := pg_temp.val('transactions', 'updated_at',
    format('id = %L', current_setting('test.row')))::timestamptz;

  perform pg_temp.check('naming a row moves updated_at, so the other device pulls it',
    after_at >= before_at, format('%s -> %s', before_at, after_at));
end $$;

-- ============================================================
-- 4. Learning a name, through the same rules that learn a category
-- ============================================================

do $$
declare r public.rules; n bigint;
begin
  r := public.upsert_rule(null, 'the good fork', current_setting('test.category')::uuid, 'Dinner out');
  perform pg_temp.check('a rule can carry a category and a name at once',
    r.category_id = current_setting('test.category')::uuid and r.title = 'Dinner out',
    coalesce(r.title, '<null>'));

  -- Categories are only learned from spending; a NAME is worth learning on any
  -- row, which is why category_id became nullable in migration 20.
  r := public.upsert_rule(null, 'smith j ltd', null, 'Salary');
  perform pg_temp.check('a rule may be about the name alone',
    r.category_id is null and r.title = 'Salary');

  perform pg_temp.check('a rule that says nothing at all is refused',
    pg_temp.raises(format('select public.upsert_rule(null, %L, null, null)', 'nothing')) = '23514');

  -- The whole row is the payload on every call (see RPC_TABLES in outbox.ts),
  -- so both fields are authoritative — including when one of them is being
  -- cleared. Re-learning must update in place rather than colliding on
  -- lower(match), which is why this is an RPC in the first place.
  r := public.upsert_rule(null, 'the good fork', current_setting('test.category')::uuid, null);
  select count(*) into n from public.rules where lower(match) = 'the good fork' and deleted_at is null;
  perform pg_temp.check('re-learning a payee updates its rule instead of duplicating', n = 1, n::text);
  perform pg_temp.check('a null name clears the name rather than being left alone',
    r.title is null, coalesce(r.title, '<null>'));

  perform pg_temp.check('an empty name is stored as no name',
    (public.upsert_rule(null, 'the good fork', current_setting('test.category')::uuid, '  ')).title is null);
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
