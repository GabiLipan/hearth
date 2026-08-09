-- Hearth — tests for asking about a row (migration 16)
--
-- Companion to 99 … 99i. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.
--
-- The interesting property is the one that reads like a mistake: these RPCs
-- need only `view`, which is LESS than it takes to change the row they mark.
-- That is deliberate and load-bearing — the person asking is by definition the
-- one who cannot resolve it — so the tests assert both halves: that `view` is
-- enough, and that no grant at all is still nothing.

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

-- Reads past RLS, to assert what is REALLY in the table.
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

create function pg_temp.drop_grant(acct uuid, who uuid)
returns void language plpgsql security definer as $$
begin
  update public.account_grants set deleted_at = now()
   where account_id = acct and user_id = who;
end $$;

create function pg_temp.pair(a uuid, b uuid)
returns uuid language plpgsql security definer as $$
declare t uuid := gen_random_uuid();
begin
  update public.transactions set transfer_id = t where id in (a, b);
  return t;
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
-- Fixture
-- ============================================================
--
-- The joint account, which both of them are on, holding the arrival nobody has
-- paired — the £1,800 that only Sam can explain, because its other leg is in
-- Sam's private account. And Sam's private account itself, which Gabi is not on
-- at all.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; joint uuid; t uuid;
begin
  h := public.create_household('Explain test');
  perform set_config('test.join_code', h.join_code, false);

  insert into public.accounts (name, kind) values ('Joint', 'current') returning id into joint;
  perform set_config('test.joint', joint::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (joint, current_date, 'TFR', 180000) returning id into t;
  perform set_config('test.arrival', t::text, false);

  -- An ordinary purchase, for the "already accounted for" cases.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (joint, current_date, 'TESCO', -4520) returning id into t;
  perform set_config('test.shop', t::text, false);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
declare sams uuid; t uuid;
begin
  perform public.join_household(current_setting('test.join_code'));
  perform pg_temp.set_level(current_setting('test.joint')::uuid, current_setting('test.sam')::uuid, 'owner');

  insert into public.accounts (name, kind) values ('Sams private', 'current') returning id into sams;
  perform set_config('test.sams', sams::text, false);

  -- The far leg. Gabi cannot see this row and never will — which is the entire
  -- reason the arrival needs asking about rather than pairing.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (sams, current_date, 'TFR TO JOINT', -180000) returning id into t;
  perform set_config('test.far_leg', t::text, false);
end $$;

-- ============================================================
-- 1. Asking
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare first_asked timestamptz;
begin
  perform pg_temp.check('nothing is marked to begin with',
    pg_temp.val('transactions', 'explain_requested_at',
      format('id = %L', current_setting('test.arrival'))) is null);

  first_asked := public.request_explanation(current_setting('test.arrival')::uuid);
  perform pg_temp.check('asking marks the row', first_asked is not null);

  perform pg_temp.check('and records who asked',
    pg_temp.val('transactions', 'explain_requested_by',
      format('id = %L', current_setting('test.arrival'))) = current_setting('test.gabi'));

  -- The mark has to reach the other device, and the ordinary delta pull is how.
  -- Without the touch trigger firing on this update it would sit on the server
  -- being true and never be read by anybody.
  perform pg_temp.check('the row is bumped, so the pull will carry it',
    pg_temp.val('transactions', 'updated_at',
      format('id = %L', current_setting('test.arrival')))::timestamptz >= first_asked);

  -- Pressing twice, or two devices syncing the same intent. Moving the
  -- timestamp forward each time would let a question renew itself for ever.
  perform pg_temp.check('asking again keeps the first ask',
    public.request_explanation(current_setting('test.arrival')::uuid) = first_asked);
end $$;

-- ============================================================
-- 2. Only about rows you can see
-- ============================================================

do $$
begin
  -- The far leg, in Sam's private account. Gabi has no grant on it, so as far
  -- as he is concerned it does not exist — and the refusal must not tell him
  -- otherwise, which is why the message is the same as for a bad id.
  perform pg_temp.check('cannot ask about a row in an account you are not on',
    pg_temp.raises(format('select public.request_explanation(%L::uuid)',
      current_setting('test.far_leg'))) = '42501');

  perform pg_temp.check('and an id that does not exist is refused identically',
    pg_temp.raises(format('select public.request_explanation(%L::uuid)', gen_random_uuid())) = '42501');

  perform pg_temp.check('the far leg is untouched',
    pg_temp.val('transactions', 'explain_requested_at',
      format('id = %L', current_setting('test.far_leg'))) is null);
end $$;

-- ============================================================
-- 3. Seeing is enough — you do not need to be able to CHANGE the row
-- ============================================================
--
-- The property the feature rests on. Sam imported the joint statement, so at
-- `contribute` Gabi may not edit that row at all; he can see it perfectly well
-- and is exactly the person who needs to point at it.

do $$ begin perform public.clear_explanation(current_setting('test.arrival')::uuid); end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
declare t uuid;
begin
  -- Sam's row, in the shared account, so `contribute` will not let Gabi edit it.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.joint')::uuid, current_date, 'FPO SAVINGS', -50000)
  returning id into t;
  perform set_config('test.sams_row', t::text, false);
end $$;

do $$
begin
  perform pg_temp.set_level(current_setting('test.joint')::uuid,
                            current_setting('test.gabi')::uuid, 'contribute');
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);
do $$
begin
  -- The bar this is deliberately below. An UPDATE blocked by RLS does not
  -- raise, it simply matches no rows, so the assertion is on the row itself.
  update public.transactions set payee = 'nope' where id = current_setting('test.sams_row')::uuid;
  perform pg_temp.check('contribute cannot edit somebody elses row',
    pg_temp.val('transactions', 'payee', format('id = %L', current_setting('test.sams_row'))) = 'FPO SAVINGS');

  -- And the bar it sets instead.
  perform pg_temp.check('but can still ask about it',
    public.request_explanation(current_setting('test.sams_row')::uuid) is not null);
end $$;

-- `view` is lower still, and must also be enough.
do $$
begin
  perform pg_temp.set_level(current_setting('test.joint')::uuid,
                            current_setting('test.gabi')::uuid, 'view');
end $$;

do $$
begin
  perform public.clear_explanation(current_setting('test.sams_row')::uuid);
  perform pg_temp.check('view is enough to ask',
    public.request_explanation(current_setting('test.sams_row')::uuid) is not null);
end $$;

-- `balance` is not: it cannot see transactions at all.
do $$
begin
  perform pg_temp.set_level(current_setting('test.joint')::uuid,
                            current_setting('test.gabi')::uuid, 'balance');
end $$;

do $$
begin
  perform pg_temp.check('balance-only cannot ask about a row it cannot read',
    pg_temp.raises(format('select public.request_explanation(%L::uuid)',
      current_setting('test.arrival'))) = '42501');
end $$;

do $$
begin
  perform pg_temp.set_level(current_setting('test.joint')::uuid,
                            current_setting('test.gabi')::uuid, 'owner');
end $$;

-- ============================================================
-- 4. Nothing left to explain
-- ============================================================

do $$
declare t uuid;
begin
  -- A paired row. The question has already been answered by the pairing.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.joint')::uuid, current_date, 'TFR', -25000) returning id into t;
  perform set_config('test.leg_a', t::text, false);
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.joint')::uuid, current_date, 'TFR', 25000) returning id into t;
  perform pg_temp.pair(current_setting('test.leg_a')::uuid, t);

  perform pg_temp.check('cannot ask about a row that is already a transfer',
    pg_temp.raises(format('select public.request_explanation(%L::uuid)',
      current_setting('test.leg_a'))) = '23514');
end $$;

-- ============================================================
-- 5. Either of you can withdraw the question
-- ============================================================
--
-- The asker changes their mind, or the person asked looks and says "no, we
-- really did spend that" — which is a good answer that produces no link.

do $$
begin
  perform pg_temp.check('the arrival starts unmarked',
    pg_temp.val('transactions', 'explain_requested_at',
      format('id = %L', current_setting('test.arrival'))) is null);
  perform public.request_explanation(current_setting('test.arrival')::uuid);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
begin
  -- Sam did not ask, and can still answer.
  perform public.clear_explanation(current_setting('test.arrival')::uuid);
  perform pg_temp.check('the person asked can clear it',
    pg_temp.val('transactions', 'explain_requested_at',
      format('id = %L', current_setting('test.arrival'))) is null);
  perform pg_temp.check('and the asker is forgotten with it',
    pg_temp.val('transactions', 'explain_requested_by',
      format('id = %L', current_setting('test.arrival'))) is null);
end $$;

do $$
begin
  perform pg_temp.drop_grant(current_setting('test.joint')::uuid, current_setting('test.sam')::uuid);
  perform pg_temp.check('somebody with no grant cannot clear it either',
    pg_temp.raises(format('select public.clear_explanation(%L::uuid)',
      current_setting('test.arrival'))) = '42501');
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
