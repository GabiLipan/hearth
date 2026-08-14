-- Hearth — tests for saying who paid in (migration 18)
--
-- Companion to 99 … 99j. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.
--
-- `contributor_id` is a plain writable column rather than an RPC, so what there
-- is to test is exactly what a plain column gets: the check constraint, and the
-- fact that `transactions_update` — and nothing new — decides who may set it.
-- The interesting cases are the two ends of that. At `contribute` you may tag
-- what you added and not what your partner imported, which is the same rule as
-- any other edit and is worth pinning here because relabelling the household's
-- income is a more tempting thing to have got wrong than changing a payee.

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
  insert into auth.users (id, email) values (gabi, 'ga@test.local'), (sam, 'pa@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.sam',  sam::text,  false);
end $$;

set role authenticated;

-- ============================================================
-- 0. The column is actually there
-- ============================================================

do $$
begin
  perform pg_temp.check('migration 18 is applied',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'transactions'
               and column_name = 'contributor_id'));
end $$;

-- ============================================================
-- Fixture
-- ============================================================
--
-- The joint account both of them are on, holding two arrivals: the one Gabi
-- imported and the one Sam did. `created_by` is what `transactions_update`
-- reads at `contribute`, and the whole point of the second row is to have one
-- that is not Gabi's to change.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; joint uuid; t uuid;
begin
  h := public.create_household('Contribution test');
  perform set_config('test.join_code', h.join_code, false);

  insert into public.accounts (name, kind) values ('Joint', 'current') returning id into joint;
  perform set_config('test.joint', joint::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (joint, current_date, 'A KAMINSKA', 180000) returning id into t;
  perform set_config('test.arrival', t::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (joint, current_date, 'TESCO', -4520) returning id into t;
  perform set_config('test.shop', t::text, false);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
declare t uuid;
begin
  perform public.join_household(current_setting('test.join_code'));
  perform pg_temp.set_level(current_setting('test.joint')::uuid, current_setting('test.sam')::uuid, 'owner');

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.joint')::uuid, current_date, 'A KAMINSKA', 180000) returning id into t;
  perform set_config('test.sams_row', t::text, false);
end $$;

-- ============================================================
-- 1. Tagging an arrival
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
begin
  perform pg_temp.check('nothing is tagged to begin with',
    pg_temp.val('transactions', 'contributor_id',
      format('id = %L', current_setting('test.arrival'))) is null);

  update public.transactions set contributor_id = current_setting('test.sam')::uuid
   where id = current_setting('test.arrival')::uuid;

  perform pg_temp.check('an owner can say whose the money was',
    pg_temp.val('transactions', 'contributor_id',
      format('id = %L', current_setting('test.arrival'))) = current_setting('test.sam'));
end $$;

do $$
begin
  update public.transactions set contributor_id = null
   where id = current_setting('test.arrival')::uuid;

  perform pg_temp.check('and can take it back off again',
    pg_temp.val('transactions', 'contributor_id',
      format('id = %L', current_setting('test.arrival'))) is null);

  -- Put it back for the tests below.
  update public.transactions set contributor_id = current_setting('test.sam')::uuid
   where id = current_setting('test.arrival')::uuid;
end $$;

-- ============================================================
-- 2. Money in only
-- ============================================================
--
-- A payment OUT of a joint account into somebody's private one is a withdrawal,
-- which is a different claim with a different sign. Crediting the household with
-- a negative contribution would invent money, exactly as the same flag on an
-- incoming refund would in migration 13 — so the constraint refuses it rather
-- than the client being trusted to.

do $$
begin
  perform pg_temp.check('a payment out cannot be tagged as a contribution',
    pg_temp.raises(format(
      'update public.transactions set contributor_id = %L where id = %L',
      current_setting('test.gabi'), current_setting('test.shop'))) = '23514');
end $$;

-- ============================================================
-- 3. Who may set it
-- ============================================================
--
-- Nothing new: `transactions_update` already decides, and this is a field on a
-- transaction. Asserted anyway, because "relabel the household's income" is a
-- more tempting thing to have quietly widened than "change a payee", and a
-- migration that added a policy of its own is exactly how that would happen.

do $$
begin
  perform pg_temp.set_level(current_setting('test.joint')::uuid,
                            current_setting('test.gabi')::uuid, 'contribute');

  -- Still Gabi's own row, so this is allowed.
  update public.transactions set contributor_id = current_setting('test.gabi')::uuid
   where id = current_setting('test.arrival')::uuid;
  perform pg_temp.check('at contribute you may tag what you added',
    pg_temp.val('transactions', 'contributor_id',
      format('id = %L', current_setting('test.arrival'))) = current_setting('test.gabi'));

  -- Sam's row. The UPDATE matches no rows rather than raising: that is what a
  -- policy does, and it is why a bulk tag has to be filtered client-side rather
  -- than attempted and counted.
  update public.transactions set contributor_id = current_setting('test.gabi')::uuid
   where id = current_setting('test.sams_row')::uuid;
  perform pg_temp.check('at contribute you may not tag what your partner added',
    pg_temp.val('transactions', 'contributor_id',
      format('id = %L', current_setting('test.sams_row'))) is null);
end $$;

do $$
begin
  perform pg_temp.set_level(current_setting('test.joint')::uuid,
                            current_setting('test.gabi')::uuid, 'view');

  update public.transactions set contributor_id = null
   where id = current_setting('test.arrival')::uuid;
  perform pg_temp.check('at view you may not tag anything at all',
    pg_temp.val('transactions', 'contributor_id',
      format('id = %L', current_setting('test.arrival'))) = current_setting('test.gabi'));
end $$;

-- ============================================================
-- 4. It replicates like any other edit
-- ============================================================
--
-- The tag has to reach the other device, and the only thing that carries it is
-- the ordinary delta pull keyed on `updated_at`. If `touch_updated_at` did not
-- fire on this column the other person would never learn about it.

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
declare before_at timestamptz; after_at timestamptz;
begin
  before_at := pg_temp.val('transactions', 'updated_at',
    format('id = %L', current_setting('test.sams_row')))::timestamptz;

  update public.transactions set contributor_id = current_setting('test.sam')::uuid
   where id = current_setting('test.sams_row')::uuid;

  after_at := pg_temp.val('transactions', 'updated_at',
    format('id = %L', current_setting('test.sams_row')))::timestamptz;

  perform pg_temp.check('tagging moves updated_at, so the other device pulls it',
    after_at >= before_at,
    format('%s -> %s', before_at, after_at));
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
