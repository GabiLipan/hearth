-- Hearth — tests for getting an account back (migration 11)
--
-- Companion to 99 … 99f. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.
--
-- Two of the three functions here GRANT something rather than merely reading,
-- so most of this file is about who is refused. `claim_account` in particular
-- is the only place in the app where being a household admin gets you access
-- to an account, and the whole permission model rests on that not leaking: an
-- admin manages people and nothing else.

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

-- Reads past RLS, to assert what is REALLY in the table. `security definer` is
-- load-bearing: under `set role authenticated` a plain helper is filtered by
-- the policies it is trying to look behind, and would pass vacuously.
create function pg_temp.cnt(tbl text, pred text)
returns bigint language plpgsql security definer as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I where %s', tbl, pred) into n;
  return n;
end $$;

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

create function pg_temp.drop_grants(acct uuid)
returns void language plpgsql security definer as $$
begin
  update public.account_grants set deleted_at = now() where account_id = acct;
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
  insert into auth.users (id, email) values (gabi, 'g7@test.local'), (sam, 'p7@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.sam',  sam::text,  false);
end $$;

set role authenticated;

-- ============================================================
-- Fixture: Gabi is the admin (he created the household), Sam joins.
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; cur uuid; b uuid;
begin
  h := public.create_household('Recovery test');
  perform set_config('test.join_code', h.join_code, false);
  perform set_config('test.household', h.id::text, false);

  insert into public.accounts (name, kind) values ('Current', 'current') returning id into cur;
  perform set_config('test.current', cur::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (cur, current_date, 'TESCO', -4520) returning id into b;
  perform set_config('test.txn', b::text, false);

  insert into public.bills (name, payee, amount_minor, account_id, freq, next_due, active, auto_post)
  values ('Rent', 'LANDLORD', -120000, cur, 'monthly', current_date, true, false)
  returning id into b;
  perform set_config('test.bill', b::text, false);

  -- Deleted a fortnight before the account, so it must NOT come back with it.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor, deleted_at)
  values (cur, current_date, 'OLD MISTAKE', -100, now() - interval '14 days')
  returning id into b;
  perform set_config('test.old', b::text, false);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$ begin perform public.join_household(current_setting('test.join_code')); end $$;

-- ============================================================
-- 1. Delete, then put it back
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare restored integer;
begin
  perform public.delete_account(current_setting('test.current')::uuid, true);

  perform pg_temp.check('the account is gone',
    pg_temp.val('accounts', 'deleted_at', format('id = %L', current_setting('test.current'))) is not null);
  perform pg_temp.check('and so are its transactions',
    pg_temp.cnt('transactions',
      format('account_id = %L and deleted_at is null', current_setting('test.current'))) = 0);

  perform pg_temp.check('the bin lists it',
    (select count(*) from public.deleted_accounts()
      where id = current_setting('test.current')::uuid) = 1);

  restored := public.restore_account(current_setting('test.current')::uuid);

  perform pg_temp.check('the account is back',
    pg_temp.val('accounts', 'deleted_at', format('id = %L', current_setting('test.current'))) is null);
  perform pg_temp.check('its transaction is back',
    pg_temp.val('transactions', 'deleted_at', format('id = %L', current_setting('test.txn'))) is null);
  perform pg_temp.check('its bill is back',
    pg_temp.val('bills', 'deleted_at', format('id = %L', current_setting('test.bill'))) is null);
  perform pg_temp.check('it reports how many transactions came with it', restored = 1);

  -- The one that matters: restoring an account is not an undo of every edit
  -- anybody ever made to it.
  perform pg_temp.check('a transaction deleted earlier stays deleted',
    pg_temp.val('transactions', 'deleted_at', format('id = %L', current_setting('test.old'))) is not null);

  perform pg_temp.check('the bin is empty again',
    (select count(*) from public.deleted_accounts()) = 0);
end $$;

-- ============================================================
-- 2. Restoring is owning
-- ============================================================

do $$
begin
  perform pg_temp.set_level(current_setting('test.current')::uuid,
                            current_setting('test.sam')::uuid, 'manage');
  perform public.delete_account(current_setting('test.current')::uuid, true);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
begin
  -- `manage` may write anything ON the account. It may not resurrect it, for
  -- the same reason it may not delete it.
  perform pg_temp.check('manage cannot restore',
    pg_temp.raises(format('select public.restore_account(%L::uuid)',
      current_setting('test.current'))) = '42501');

  perform pg_temp.check('and the bin shows manage nothing',
    (select count(*) from public.deleted_accounts()) = 0);

  perform pg_temp.check('the account stayed deleted',
    pg_temp.val('accounts', 'deleted_at', format('id = %L', current_setting('test.current'))) is not null);
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);
do $$ begin perform public.restore_account(current_setting('test.current')::uuid); end $$;

-- ============================================================
-- 3. An account nobody owns
-- ============================================================

do $$
begin
  -- Everybody's grants revoked: the state depart_household() can leave behind.
  perform pg_temp.drop_grants(current_setting('test.current')::uuid);

  perform pg_temp.check('nobody owns it now',
    pg_temp.cnt('account_grants',
      format('account_id = %L and deleted_at is null and level = ''owner''',
        current_setting('test.current'))) = 0);
end $$;

-- Sam is a member, not an admin.
select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
begin
  perform pg_temp.check('a plain member is shown nothing to claim',
    (select count(*) from public.unowned_accounts()) = 0);

  perform pg_temp.check('a plain member cannot claim it',
    pg_temp.raises(format('select public.claim_account(%L::uuid)',
      current_setting('test.current'))) = '42501');
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);
do $$
begin
  -- Without this the feature is unreachable: an ownerless account has no
  -- grant, and accounts_select needs one, so nothing else can see it.
  perform pg_temp.check('the admin is shown the ownerless account',
    (select count(*) from public.unowned_accounts()
      where id = current_setting('test.current')::uuid) = 1);

  perform pg_temp.check('the admin can',
    public.claim_account(current_setting('test.current')::uuid) = current_setting('test.current')::uuid);

  perform pg_temp.check('and now holds owner on it',
    pg_temp.val('account_grants', 'level',
      format('account_id = %L and user_id = %L and deleted_at is null',
        current_setting('test.current'), current_setting('test.gabi'))) = 'owner');

  -- The whole point of the guard: an admin is not a master key.
  perform pg_temp.check('and it drops off the list once claimed',
    (select count(*) from public.unowned_accounts()) = 0);

  perform pg_temp.check('claiming an account that HAS an owner is refused',
    pg_temp.raises(format('select public.claim_account(%L::uuid)',
      current_setting('test.current'))) = '42501');
end $$;

-- ============================================================
-- 4. An admin is not a way into somebody else's account
-- ============================================================
--
-- The property the permission model rests on, asserted from the direction that
-- would break it: Sam's own private account, in the same household, with Gabi
-- as its admin and nothing else.

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
declare sams uuid;
begin
  insert into public.accounts (name, kind) values ('Sams private', 'current') returning id into sams;
  perform set_config('test.sams', sams::text, false);
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);
do $$
begin
  perform pg_temp.check('the admin cannot claim an account Sam owns',
    pg_temp.raises(format('select public.claim_account(%L::uuid)',
      current_setting('test.sams'))) = '42501');

  perform pg_temp.check('nor restore one they do not own',
    pg_temp.raises(format('select public.restore_account(%L::uuid)',
      current_setting('test.sams'))) = '42501');

  perform pg_temp.check('and my_account_ids still does not know about admins',
    current_setting('test.sams')::uuid not in (select public.my_account_ids('balance')));
end $$;

-- ============================================================
-- 5. Restoring an account that is not deleted
-- ============================================================

do $$
begin
  perform pg_temp.check('restoring a live account is refused, not a no-op',
    pg_temp.raises(format('select public.restore_account(%L::uuid)',
      current_setting('test.current'))) = '42501');

  perform pg_temp.check('and an id that does not exist is refused the same way',
    pg_temp.raises(format('select public.restore_account(%L::uuid)', gen_random_uuid())) = '42501');
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
