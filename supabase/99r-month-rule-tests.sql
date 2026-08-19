-- Hearth — tests for when a month's money arrives (migration 25)
--
-- Companion to 99 … 99q. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.
--
-- Two things are being asserted, and they are unrelated except in origin.
--
-- `set_month_rule` is a security-definer function, which means RLS is OFF
-- inside it — so the whole test is about whether it restates the membership
-- check the policy would have applied. The failure it guards against has
-- happened here before: `wipe_household()` did not restate its predicate and
-- one person's "erase everything" reached the other's private accounts.
--
-- `transactions.book_month` has no policy of its own, deliberately:
-- `transactions_update` already decides who may change a transaction and this
-- is a field on one. That is a claim worth checking rather than assuming, so
-- the last block confirms somebody with no grant cannot set it.

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

-- Reads past RLS, to assert what is REALLY in the table. A plain helper would
-- be filtered by the very policies it is trying to look behind, and would pass
-- vacuously.
create function pg_temp.val(tbl text, col text, pred text)
returns text language plpgsql security definer as $$
declare v text;
begin
  execute format('select %I::text from public.%I where %s', col, tbl, pred) into v;
  return v;
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
-- Fixture: one household, one account, one transaction
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; acct uuid; t uuid;
begin
  h := public.create_household('Month rule test');
  perform set_config('test.household', h.id::text, false);

  insert into public.accounts (name, kind) values ('Joint', 'current') returning id into acct;
  perform set_config('test.acct', acct::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (acct, date '2026-07-04', 'TESCO', -6000) returning id into t;
  perform set_config('test.txn', t::text, false);
end $$;

-- ============================================================
-- 1. What a household starts with
-- ============================================================

do $$
begin
  perform pg_temp.check('a new household keeps the hard-coded cutoff this replaced',
    pg_temp.val('households', 'contribution_cutoff_day',
      format('id = %L', current_setting('test.household'))) = '25');
  perform pg_temp.check('and applies the same day to income, as 18 already did',
    pg_temp.val('households', 'income_cutoff_day',
      format('id = %L', current_setting('test.household'))) = '25');
end $$;

-- ============================================================
-- 2. Setting it
-- ============================================================

do $$
begin
  perform public.set_month_rule(23, 23);
  perform pg_temp.check('a member can move the contribution cutoff',
    pg_temp.val('households', 'contribution_cutoff_day',
      format('id = %L', current_setting('test.household'))) = '23');
  perform pg_temp.check('and the income one separately',
    pg_temp.val('households', 'income_cutoff_day',
      format('id = %L', current_setting('test.household'))) = '23');

  -- Null is a real answer — "never shift this" — not an absent argument.
  perform public.set_month_rule(null, 20);
  perform pg_temp.check('turning one off leaves the other alone',
    pg_temp.val('households', 'contribution_cutoff_day',
      format('id = %L', current_setting('test.household'))) is null
    and pg_temp.val('households', 'income_cutoff_day',
      format('id = %L', current_setting('test.household'))) = '20');
end $$;

do $$
begin
  -- 31 is the interesting rejection: a real day, and a cutoff on it would do
  -- nothing whatever in February.
  perform pg_temp.check('a day outside 1..28 is refused',
    pg_temp.raises('select public.set_month_rule(31, null)') = '22023');
  perform pg_temp.check('and so is one below it',
    pg_temp.raises('select public.set_month_rule(0, null)') = '22023');
  perform pg_temp.check('a refused change leaves the rule as it was',
    pg_temp.val('households', 'income_cutoff_day',
      format('id = %L', current_setting('test.household'))) = '20');
end $$;

-- ============================================================
-- 3. Somebody else's household is not yours to re-time
-- ============================================================
--
-- The definer check. Sam is a real signed-in user in a household of their own,
-- so nothing here is about authentication — it is entirely about whether the
-- function looked at `my_household()` before it wrote.

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
begin
  perform public.create_household('Sam''s own');
  perform public.set_month_rule(10, 10);

  perform pg_temp.check('an outsider cannot re-time my household',
    pg_temp.val('households', 'income_cutoff_day',
      format('id = %L', current_setting('test.household'))) = '20');
  perform pg_temp.check('and has changed their own instead',
    pg_temp.val('households', 'income_cutoff_day',
      format('id = %L', public.my_household())) = '10');
end $$;

-- ============================================================
-- 4. A row's own month rides the ordinary transaction policies
-- ============================================================
--
-- No policy of its own, which is the claim being tested: `book_month` is
-- reachable exactly when the row is.

do $$
begin
  perform pg_temp.check('somebody with no grant cannot move a row to another month',
    (select count(*) from public.transactions
      where id = current_setting('test.txn')::uuid) = 0);
  update public.transactions set book_month = '2026-08'
   where id = current_setting('test.txn')::uuid;
  perform pg_temp.check('and an update they are not entitled to changes nothing',
    pg_temp.val('transactions', 'book_month',
      format('id = %L', current_setting('test.txn'))) is null);
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
begin
  update public.transactions set book_month = '2026-08'
   where id = current_setting('test.txn')::uuid;
  perform pg_temp.check('the owner can say which month a row counts in',
    pg_temp.val('transactions', 'book_month',
      format('id = %L', current_setting('test.txn'))) = '2026-08');

  perform pg_temp.check('a month key that is not one is refused',
    pg_temp.raises(format(
      'update public.transactions set book_month = ''2026-13'' where id = %L',
      current_setting('test.txn'))) = '23514');
  perform pg_temp.check('and so is a whole date',
    pg_temp.raises(format(
      'update public.transactions set book_month = ''2026-08-01'' where id = %L',
      current_setting('test.txn'))) = '23514');

  update public.transactions set book_month = null
   where id = current_setting('test.txn')::uuid;
  perform pg_temp.check('clearing it puts the row back on its own date',
    pg_temp.val('transactions', 'book_month',
      format('id = %L', current_setting('test.txn'))) is null);
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
