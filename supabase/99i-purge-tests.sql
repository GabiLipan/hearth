-- Hearth — tests for emptying the bin (migration 15)
--
-- Companion to 99 … 99h. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.
--
-- This is the only function in the schema that issues a real DELETE. There are
-- no DELETE policies anywhere, so nothing behind it is enforced by RLS — every
-- check `purge_account` makes, it makes by hand, and this file is what says
-- those checks are still there. Most of it is therefore about who is refused
-- and about what is left standing afterwards, rather than about the deletion
-- itself, which is the easy half.

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
-- load-bearing throughout this file: the whole question is whether rows still
-- exist, and under `set role authenticated` a plain helper would be filtered by
-- the policies it is trying to look behind and would answer "gone" about a row
-- that is merely hidden.
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

-- Pairs two rows as a transfer without going through `link_transfer`, which
-- refuses when the caller cannot write both legs — which is exactly the case
-- section 4 needs to set up.
create function pg_temp.pair(a uuid, b uuid, cat uuid default null)
returns uuid language plpgsql security definer as $$
declare t uuid := gen_random_uuid();
begin
  update public.transactions
     set transfer_id = t, category_id = null, prior_category_id = cat
   where id in (a, b);
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
  insert into auth.users (id, email) values (gabi, 'g9@test.local'), (sam, 'p9@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.sam',  sam::text,  false);
end $$;

set role authenticated;

-- ============================================================
-- Fixture
-- ============================================================
--
-- Gabi owns Current (the one to be destroyed) and Savings. Sam is in the
-- household and owns a private account Gabi cannot write to. Current carries a
-- transaction, a bill, a posting joining the two, and a goal pointing at it.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; cur uuid; sav uuid; b uuid; t uuid; c uuid;
begin
  h := public.create_household('Purge test');
  perform set_config('test.join_code', h.join_code, false);
  perform set_config('test.household', h.id::text, false);

  insert into public.accounts (name, kind) values ('Current', 'current') returning id into cur;
  insert into public.accounts (name, kind) values ('Savings', 'savings') returning id into sav;
  perform set_config('test.current', cur::text, false);
  perform set_config('test.savings', sav::text, false);

  select id into c from public.categories where household_id = h.id limit 1;
  perform set_config('test.category', c::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (cur, current_date, 'TESCO', -4520) returning id into t;
  perform set_config('test.txn', t::text, false);

  insert into public.bills (name, payee, amount_minor, account_id, freq, next_due, active, auto_post)
  values ('Rent', 'LANDLORD', -120000, cur, 'monthly', current_date, true, false)
  returning id into b;
  perform set_config('test.bill', b::text, false);

  -- The rent payment itself lives in Current and settles the occurrence.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (cur, current_date, 'LANDLORD', -120000) returning id into t;
  perform public.link_bill_payment(b, t, current_date);

  -- A payment in a DIFFERENT account against that same bill. It must survive
  -- the purge with its money intact and merely stop naming a bill.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor, bill_id)
  values (sav, current_date, 'LANDLORD', -120000, b) returning id into t;
  perform set_config('test.elsewhere', t::text, false);

  insert into public.goals (name, target_minor, account_id)
  values ('House deposit', 1000000, cur) returning id into t;
  perform set_config('test.goal', t::text, false);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
declare sams uuid;
begin
  perform public.join_household(current_setting('test.join_code'));
  insert into public.accounts (name, kind) values ('Sams private', 'current') returning id into sams;
  perform set_config('test.sams', sams::text, false);
end $$;

-- ------------------------------------------------------------
-- Two transfers, both with a leg in the account that is going
-- ------------------------------------------------------------
--
--   Current ↔ Savings       — Gabi may write both, so section 4 expects the
--                             survivor released and its remembered category
--                             back.
--   Current ↔ Sams private  — Gabi may not write Sam's leg, so it is skipped
--                             and the purge proceeds anyway. Refusing there
--                             would make the bin unemptiable through no fault
--                             of the person trying to empty it, and the half
--                             already dangles: delete_account soft-deletes this
--                             side long before purge is reached.
--
-- Set up while the account is still live, because that is when it happens.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare a uuid; b uuid;
begin
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.current')::uuid, current_date, 'Transfer to Savings', -25000)
  returning id into a;
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.savings')::uuid, current_date, 'Transfer from Current', 25000)
  returning id into b;
  perform set_config('test.survivor', b::text, false);
  perform pg_temp.pair(a, b, current_setting('test.category')::uuid);

  -- The out-leg of the second pair. A row of its own: reusing the first would
  -- silently move that transfer_id and quietly undo the pair above.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.current')::uuid, current_date, 'Transfer to Sam', -5000)
  returning id into a;
  perform set_config('test.to_sam', a::text, false);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
declare b uuid;
begin
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.sams')::uuid, current_date, 'Transfer from Current', 5000)
  returning id into b;
  perform set_config('test.sams_leg', b::text, false);
  perform set_config('test.sams_transfer',
    pg_temp.pair(current_setting('test.to_sam')::uuid, b)::text, false);
end $$;

-- ============================================================
-- 1. The bin is the only door
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
begin
  -- Deleting is reversible and this is not, so they are deliberately two
  -- presses. A live account is refused rather than quietly deleted first.
  perform pg_temp.check('a live account cannot be purged',
    pg_temp.raises(format('select public.purge_account(%L::uuid)',
      current_setting('test.current'))) = '42501');

  perform pg_temp.check('and it is still there afterwards',
    pg_temp.cnt('accounts', format('id = %L', current_setting('test.current'))) = 1);

  perform pg_temp.check('an id that does not exist is refused the same way',
    pg_temp.raises(format('select public.purge_account(%L::uuid)', gen_random_uuid())) = '42501');
end $$;

-- ============================================================
-- 2. Owner only
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
  -- `manage` may write anything ON the account. It may not destroy it, for the
  -- same reason it may not delete or restore it.
  perform pg_temp.check('manage cannot purge',
    pg_temp.raises(format('select public.purge_account(%L::uuid)',
      current_setting('test.current'))) = '42501');

  perform pg_temp.check('and the account is still there',
    pg_temp.cnt('accounts', format('id = %L', current_setting('test.current'))) = 1);

  perform pg_temp.check('nor can a member purge an account they hold nothing on',
    pg_temp.raises(format('select public.purge_account(%L::uuid)',
      current_setting('test.savings'))) = '42501');
end $$;

-- ============================================================
-- 3. Destroy it
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare destroyed integer;
declare epoch_before bigint;
begin
  select visibility_epoch into epoch_before from public.households
   where id = current_setting('test.household')::uuid;

  perform pg_temp.check('the bin lists it before',
    (select count(*) from public.deleted_accounts()
      where id = current_setting('test.current')::uuid) = 1);

  destroyed := public.purge_account(current_setting('test.current')::uuid);

  -- The rows, actually gone rather than hidden. `cnt` is security definer, so
  -- a zero here means the table is empty of them, not that RLS is hiding them.
  perform pg_temp.check('the account row is gone',
    pg_temp.cnt('accounts', format('id = %L', current_setting('test.current'))) = 0);
  perform pg_temp.check('its transactions are gone',
    pg_temp.cnt('transactions', format('account_id = %L', current_setting('test.current'))) = 0);
  perform pg_temp.check('its bill is gone',
    pg_temp.cnt('bills', format('id = %L', current_setting('test.bill'))) = 0);
  perform pg_temp.check('the posting went with the bill',
    pg_temp.cnt('bill_postings', format('bill_id = %L', current_setting('test.bill'))) = 0);

  -- The grants go too, and this is the one place in the schema where that is
  -- right: everywhere else they outlive the account so an owner stays
  -- recognisable, and here there is no longer a row for them to authorise.
  perform pg_temp.check('and so do the grants on it',
    pg_temp.cnt('account_grants', format('account_id = %L', current_setting('test.current'))) = 0);

  perform pg_temp.check('it reports how many transactions it destroyed', destroyed = 4,
    destroyed::text);

  perform pg_temp.check('the bin no longer lists it',
    (select count(*) from public.deleted_accounts()
      where id = current_setting('test.current')::uuid) = 0);

  -- Not because anyone's access changed — it changed nobody's. Because the
  -- tombstone a device offline since before the delete was going to sync has
  -- just ceased to exist, and the epoch is the only signal that survives that.
  perform pg_temp.check('the epoch moved',
    (select visibility_epoch from public.households
      where id = current_setting('test.household')::uuid) > epoch_before);
end $$;

-- ============================================================
-- 4. What was left standing
-- ============================================================

do $$
begin
  -- Forced by `transactions.bill_id on delete set null`, and the right answer:
  -- the money and the category are the user's, only the link was the bill's.
  perform pg_temp.check('a payment in another account survives, minus its bill',
    pg_temp.cnt('transactions',
      format('id = %L and bill_id is null and amount_minor = -120000',
        current_setting('test.elsewhere'))) = 1);

  -- `goals.account_id on delete set null`. delete_account had already done
  -- this; the check is that the goal itself is not collateral.
  perform pg_temp.check('the goal keeps its name and target and stops naming an account',
    pg_temp.cnt('goals',
      format('id = %L and account_id is null and target_minor = 1000000 and deleted_at is null',
        current_setting('test.goal'))) = 1);

  -- unlink_transfer's rules, restated: the tag goes, the remembered category
  -- comes back.
  perform pg_temp.check('a transfer partner Gabi may edit is released',
    pg_temp.cnt('transactions',
      format('id = %L and transfer_id is null and goal_id is null',
        current_setting('test.survivor'))) = 1);
  perform pg_temp.check('and gets its category back',
    pg_temp.val('transactions', 'category_id', format('id = %L', current_setting('test.survivor')))
      = current_setting('test.category'));

  -- The half that has to be tolerated rather than fixed. It dangles, it has
  -- always dangled, and the purge went through regardless.
  perform pg_temp.check('a partner in an account Gabi cannot write to is left alone',
    pg_temp.val('transactions', 'transfer_id', format('id = %L', current_setting('test.sams_leg')))
      = current_setting('test.sams_transfer'));
  perform pg_temp.check('and Sam still has the money',
    pg_temp.cnt('transactions',
      format('id = %L and amount_minor = 5000 and deleted_at is null',
        current_setting('test.sams_leg'))) = 1);

  -- Nothing reached sideways.
  perform pg_temp.check('the other account is untouched',
    pg_temp.cnt('accounts',
      format('id = %L and deleted_at is null', current_setting('test.savings'))) = 1);
  perform pg_temp.check('and so is Sams',
    pg_temp.cnt('accounts',
      format('id = %L and deleted_at is null', current_setting('test.sams'))) = 1);
end $$;

-- ============================================================
-- 5. An admin is not a way to destroy somebody else's account
-- ============================================================
--
-- The property the whole permission model rests on, asserted from the direction
-- that would break it worst. Gabi is the household's admin; Sam's private
-- account is deleted and therefore in a bin — just not Gabi's.

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$ begin perform public.delete_account(current_setting('test.sams')::uuid, true); end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);
do $$
begin
  perform pg_temp.check('the admin is shown nothing of Sams bin',
    (select count(*) from public.deleted_accounts()
      where id = current_setting('test.sams')::uuid) = 0);

  perform pg_temp.check('and cannot purge what is in it',
    pg_temp.raises(format('select public.purge_account(%L::uuid)',
      current_setting('test.sams'))) = '42501');

  perform pg_temp.check('Sams account is still there',
    pg_temp.cnt('accounts', format('id = %L', current_setting('test.sams'))) = 1);
end $$;

-- And the owner can, which is what makes the refusal above about who rather
-- than about the account.
select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
begin
  perform public.purge_account(current_setting('test.sams')::uuid);
  perform pg_temp.check('its owner can',
    pg_temp.cnt('accounts', format('id = %L', current_setting('test.sams'))) = 0);
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
