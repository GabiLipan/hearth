-- Hearth — tests for giving the categories back (migration 12)
--
-- Companion to 99 … 99g. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.

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

-- Reads past RLS. `security definer` is load-bearing: under `set role
-- authenticated` a plain helper is filtered by the policies it is looking
-- behind, and would pass vacuously.
create function pg_temp.val(tbl text, col text, pred text)
returns text language plpgsql security definer as $$
declare v text;
begin
  execute format('select %I::text from public.%I where %s', col, tbl, pred) into v;
  return v;
end $$;

do $$
declare gabi uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (gabi, 'g8@test.local');
  perform set_config('test.gabi', gabi::text, false);
end $$;

set role authenticated;
select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; cur uuid; sav uuid; cat uuid; leg uuid;
begin
  h := public.create_household('Transfer category test');
  select id into cat from public.categories where household_id = h.id and kind = 'expense' limit 1;
  perform set_config('test.cat', cat::text, false);

  insert into public.accounts (name, kind) values ('Current', 'current') returning id into cur;
  insert into public.accounts (name, kind) values ('Savings', 'savings') returning id into sav;

  -- Both legs categorised, the way an imported statement arrives.
  insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
  values (cur, cat, current_date, 'TFR TO SAVINGS', -50000) returning id into leg;
  perform set_config('test.out', leg::text, false);

  insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
  values (sav, cat, current_date, 'TFR FROM CURRENT', 50000) returning id into leg;
  perform set_config('test.in', leg::text, false);
end $$;

-- ============================================================
-- 1. Linking still clears, and now remembers
-- ============================================================

do $$
declare tr uuid;
begin
  tr := public.link_transfer(current_setting('test.out')::uuid, current_setting('test.in')::uuid);
  perform set_config('test.transfer', tr::text, false);

  perform pg_temp.check('linking clears the category, as it always did',
    pg_temp.val('transactions', 'category_id', format('id = %L', current_setting('test.out'))) is null);
  perform pg_temp.check('and remembers what it was',
    pg_temp.val('transactions', 'prior_category_id', format('id = %L', current_setting('test.out')))
      = current_setting('test.cat'));
  perform pg_temp.check('on both legs',
    pg_temp.val('transactions', 'prior_category_id', format('id = %L', current_setting('test.in')))
      = current_setting('test.cat'));
end $$;

-- ============================================================
-- 2. Unlinking puts them back
-- ============================================================

do $$
begin
  perform public.unlink_transfer(current_setting('test.transfer')::uuid);

  perform pg_temp.check('unlinking restores the category',
    pg_temp.val('transactions', 'category_id', format('id = %L', current_setting('test.out')))
      = current_setting('test.cat'));
  perform pg_temp.check('on both legs',
    pg_temp.val('transactions', 'category_id', format('id = %L', current_setting('test.in')))
      = current_setting('test.cat'));
  perform pg_temp.check('and stops remembering, so a later link starts clean',
    pg_temp.val('transactions', 'prior_category_id', format('id = %L', current_setting('test.out'))) is null);
end $$;

-- ============================================================
-- 3. A newer answer wins over a remembered one
-- ============================================================

do $$
declare tr uuid; other uuid;
begin
  select id into other from public.categories
   where household_id = (select public.my_household()) and kind = 'expense'
     and id <> current_setting('test.cat')::uuid
   limit 1;
  perform set_config('test.other', other::text, false);

  tr := public.link_transfer(current_setting('test.out')::uuid, current_setting('test.in')::uuid);

  -- Nothing forbids categorising a leg while it is linked, and if somebody
  -- does, their answer is newer than the remembered one.
  update public.transactions set category_id = other where id = current_setting('test.out')::uuid;

  perform public.unlink_transfer(tr);

  perform pg_temp.check('a category set while linked is not overwritten',
    pg_temp.val('transactions', 'category_id', format('id = %L', current_setting('test.out')))
      = current_setting('test.other'));
  perform pg_temp.check('the untouched leg still gets its old one back',
    pg_temp.val('transactions', 'category_id', format('id = %L', current_setting('test.in')))
      = current_setting('test.cat'));
end $$;

-- ============================================================
-- 4. A leg that never had a category gets none
-- ============================================================

do $$
declare cur uuid; sav uuid; a uuid; b uuid; tr uuid;
begin
  select id into cur from public.accounts where name = 'Current';
  select id into sav from public.accounts where name = 'Savings';

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (cur, current_date - 5, 'TFR', -1000) returning id into a;
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (sav, current_date - 5, 'TFR', 1000) returning id into b;

  tr := public.link_transfer(a, b);
  perform public.unlink_transfer(tr);

  perform pg_temp.check('an uncategorised leg comes back uncategorised',
    pg_temp.val('transactions', 'category_id', format('id = %L', a)) is null);
  perform pg_temp.check('and nothing is left remembered',
    pg_temp.val('transactions', 'prior_category_id', format('id = %L', b)) is null);
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
