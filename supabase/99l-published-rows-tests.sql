-- Hearth — tests for publishing household expenses (migration 19)
--
-- Companion to 99 … 99k. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.
--
-- These matter more than any test file here so far, because migration 19 is the
-- first time a transaction is readable outside the account it lives on. Every
-- other policy in the schema authorises by account, and `my_account_ids()` was
-- the only thing that ever answered the question. So the tests are mostly about
-- what did NOT change:
--
--   * reading a published row must not let you write it, or its account, or its
--     bills, or anything else on it;
--   * the account itself, its balance and its unmarked rows must stay invisible;
--   * consent must be revocable, and both directions must bump the epoch —
--     without which the other device either never learns about the history it
--     may now read, or holds a hidden row for ever.
--
-- The fixture is deliberately the real household: a joint account both people
-- are on, and one private account each that the other is not on at all.

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
-- policies it is trying to look behind, and passes vacuously — which for a file
-- whose whole subject is what one person can see would make every check here
-- agree with itself and prove nothing.
create function pg_temp.val(tbl text, col text, pred text)
returns text language plpgsql security definer as $$
declare v text;
begin
  execute format('select %I::text from public.%I where %s', col, tbl, pred) into v;
  return v;
end $$;

-- What the CALLER can see, RLS and all. The mirror of `val`, and the one that
-- actually asks this migration's question.
create function pg_temp.visible(tbl text, pred text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I where %s', tbl, pred) into n;
  return n;
end $$;

create function pg_temp.set_level(acct uuid, who uuid, lvl public.access_level)
returns void language plpgsql security definer as $$
begin
  insert into public.account_grants (account_id, user_id, level)
  values (acct, who, lvl)
  on conflict (account_id, user_id) where deleted_at is null
  do update set level = lvl;
end $$;

-- Set the publish flag past RLS, for the cases that are about the POLICY rather
-- than about who may flip the switch. Section 5 flips it as an ordinary
-- authenticated write, which is what tests the switch itself.
create function pg_temp.publish(acct uuid, on_off boolean)
returns void language plpgsql security definer as $$
begin
  update public.accounts set publishes_household_rows = on_off where id = acct;
end $$;

create function pg_temp.epoch(hh uuid)
returns integer language plpgsql security definer as $$
declare v integer;
begin
  select visibility_epoch into v from public.households where id = hh;
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
-- 0. The migration is actually applied
-- ============================================================

do $$
begin
  perform pg_temp.check('migration 19 is applied',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'accounts'
               and column_name = 'publishes_household_rows')
    and to_regprocedure('public.account_publishes(uuid)') is not null);
end $$;

-- ============================================================
-- Fixture
-- ============================================================
--
-- Gabi's private card carries four rows, and the differences between them are
-- the whole policy:
--
--   shop     marked, money out          — published
--   haircut  unmarked, money out        — private, and must stay private
--   refund   marked, money IN           — NOT published: a refund landing back
--                                         on the card is not household spending,
--                                         and `classifyFlows` would ignore it,
--                                         so publishing it would be a leak with
--                                         no reader
--   later    marked, money out, added
--            AFTER consent              — for the epoch checks

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; joint uuid; card uuid; t uuid;
begin
  h := public.create_household('Publishing test');
  perform set_config('test.join_code', h.join_code, false);
  perform set_config('test.household', h.id::text, false);

  insert into public.accounts (name, kind) values ('Joint', 'current') returning id into joint;
  perform set_config('test.joint', joint::text, false);

  insert into public.accounts (name, kind, opening_balance_minor)
  values ('Gabis card', 'credit', 250000) returning id into card;
  perform set_config('test.card', card::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor, paid_for_household, note)
  values (card, current_date, 'TESCO', -9000, true, 'the weekly shop') returning id into t;
  perform set_config('test.shop', t::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (card, current_date, 'BARBER', -2200) returning id into t;
  perform set_config('test.haircut', t::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor, paid_for_household)
  values (card, current_date, 'TESCO REFUND', 1500, true) returning id into t;
  perform set_config('test.refund', t::text, false);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
begin
  perform public.join_household(current_setting('test.join_code'));
  perform pg_temp.set_level(current_setting('test.joint')::uuid,
                            current_setting('test.sam')::uuid, 'owner');
end $$;

-- ============================================================
-- 1. Before consent, nothing has changed
-- ============================================================
--
-- The baseline that makes every check below mean something. Marking a row as
-- the household's is what the app has done since migration 13 and it has never
-- published anything; if this section were to pass vacuously the rest of the
-- file would be asserting that a leak stayed a leak.

do $$
begin
  perform pg_temp.check('a marked row is invisible until the account consents',
    pg_temp.visible('transactions', format('id = %L', current_setting('test.shop'))) = 0);
  perform pg_temp.check('and so is the account it is on',
    pg_temp.visible('accounts', format('id = %L', current_setting('test.card'))) = 0);
end $$;

-- ============================================================
-- 2. With consent, the marked row and nothing else
-- ============================================================

select pg_temp.publish(current_setting('test.card')::uuid, true);

do $$
begin
  perform pg_temp.check('the marked row becomes readable',
    pg_temp.visible('transactions', format('id = %L', current_setting('test.shop'))) = 1);

  -- The three things publishing must NOT do, and the reason it is a row-level
  -- rule rather than a `balance` grant: a grant would hand over the running
  -- total, which is every payday and the size of all the personal spending.
  perform pg_temp.check('an unmarked row on the same account stays private',
    pg_temp.visible('transactions', format('id = %L', current_setting('test.haircut'))) = 0);
  perform pg_temp.check('a marked row of money IN is not published',
    pg_temp.visible('transactions', format('id = %L', current_setting('test.refund'))) = 0);
  perform pg_temp.check('the account itself stays invisible',
    pg_temp.visible('accounts', format('id = %L', current_setting('test.card'))) = 0);
end $$;

-- The balance is the sharpest version of the same question, because it is the
-- one thing the obvious cheap implementation would have given away.
do $$
begin
  perform pg_temp.check('and its balance is not returned by account_balances()',
    not exists (select 1 from public.account_balances()
                 where account_id = current_setting('test.card')::uuid));
end $$;

-- The whole row travels, note included. Asserted rather than assumed, because
-- the consent sheet in the client promises exactly this and nothing narrower —
-- there is no column-level filtering in RLS to promise anything else with.
do $$
declare seen text;
begin
  select note into seen from public.transactions
   where id = current_setting('test.shop')::uuid;
  perform pg_temp.check('a published row carries its note, as the consent says it does',
    seen = 'the weekly shop', coalesce(seen, '<null>'));
end $$;

-- ============================================================
-- 3. Reading is not writing
-- ============================================================
--
-- The core of the audit in §5 of the migration, asserted from the outside.
-- `transactions_update` is untouched, so every one of these must fail to match
-- a row — a policy denies by matching nothing rather than by raising, which is
-- why each check reads the value back rather than trusting the statement.

do $$
begin
  update public.transactions set payee = 'NOT MINE TO CHANGE'
   where id = current_setting('test.shop')::uuid;
  perform pg_temp.check('a published row cannot be edited by the person reading it',
    pg_temp.val('transactions', 'payee', format('id = %L', current_setting('test.shop'))) = 'TESCO');

  -- The most tempting one: un-marking it would hide it from the payer's own
  -- household figures, from a device with no access to the account at all.
  update public.transactions set paid_for_household = false
   where id = current_setting('test.shop')::uuid;
  perform pg_temp.check('and cannot be un-published by the person reading it',
    pg_temp.val('transactions', 'paid_for_household',
      format('id = %L', current_setting('test.shop'))) = 'true');

  -- Deletion is an UPDATE here, so it falls out of the same policy — but it is
  -- the one that would destroy rather than merely alter, so it is pinned.
  update public.transactions set deleted_at = now()
   where id = current_setting('test.shop')::uuid;
  perform pg_temp.check('and cannot be deleted by the person reading it',
    pg_temp.val('transactions', 'deleted_at',
      format('id = %L', current_setting('test.shop'))) is null);
end $$;

-- Nor may the reader use the row as a foothold on the ACCOUNT: renaming it,
-- deleting it, or re-sharing it to themselves.
do $$
begin
  update public.accounts set name = 'Mine now'
   where id = current_setting('test.card')::uuid;
  perform pg_temp.check('the account cannot be renamed by the person reading its rows',
    pg_temp.val('accounts', 'name', format('id = %L', current_setting('test.card'))) = 'Gabis card');

  perform pg_temp.check('nor deleted',
    pg_temp.raises(format('select public.delete_account(%L, true)',
      current_setting('test.card'))) = '42501');

  perform pg_temp.check('nor granted to themselves',
    pg_temp.raises(format('select public.upsert_account_grant(null, %L, %L, ''view'')',
      current_setting('test.card'), current_setting('test.sam'))) = '42501');
end $$;

-- Reading a published row is also not grounds for marking one of your OWN rows
-- against it, or for linking it into a transfer. `link_transfer` calls
-- `may_edit_transaction` on both legs, which is what stops half a transfer
-- being written by somebody with no access to the other half.
do $$
declare mine uuid;
begin
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.joint')::uuid, current_date, 'TFR', 9000) returning id into mine;

  perform pg_temp.check('a published row cannot be linked into a transfer by its reader',
    pg_temp.raises(format('select public.link_transfer(%L, %L)',
      current_setting('test.shop'), mine)) is not null);
end $$;

-- And it is not a row you may ask about. `request_explanation` needs only
-- `view`, deliberately below the bar for changing a row — but `view` is a
-- GRANT, and a published row has none behind it. It is also not what that
-- function is for: there is no missing far leg here, and the person who could
-- explain it is named on the row.
do $$
begin
  perform pg_temp.check('and is not a row the reader may ask about',
    pg_temp.raises(format('select public.request_explanation(%L)',
      current_setting('test.shop'))) = '42501');
end $$;

-- ============================================================
-- 4. The payer keeps everything
-- ============================================================
--
-- The mirror of §3, and worth its own section: it would be entirely possible to
-- write a policy that published the row and, in doing so, stopped the person
-- who owns it from editing it — `transactions_update`'s using-clause is a
-- different expression from the select's, and only one of them changed.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
begin
  update public.transactions set payee = 'TESCO METRO'
   where id = current_setting('test.shop')::uuid;
  perform pg_temp.check('the payer can still edit a row they have published',
    pg_temp.val('transactions', 'payee', format('id = %L', current_setting('test.shop'))) = 'TESCO METRO');

  perform pg_temp.check('and still sees everything on their own account',
    pg_temp.visible('transactions', format('account_id = %L', current_setting('test.card'))) = 3);
end $$;

-- ============================================================
-- 5. Who may consent
-- ============================================================
--
-- An ordinary column on `accounts`, so `accounts_update` decides — which means
-- `manage` and above, exactly like renaming it. Asserted because "let the
-- household read some of my card" is a more tempting thing to have quietly
-- widened than a rename, and because the client gates its switch on the same
-- rule and must not be the only thing doing so.

do $$
begin
  -- Off, by the owner, as an ordinary authenticated write rather than through
  -- the definer helper — this is the switch itself.
  update public.accounts set publishes_household_rows = false
   where id = current_setting('test.card')::uuid;
  perform pg_temp.check('the owner can withdraw consent',
    pg_temp.val('accounts', 'publishes_household_rows',
      format('id = %L', current_setting('test.card'))) = 'false');
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
begin
  update public.accounts set publishes_household_rows = true
   where id = current_setting('test.card')::uuid;
  perform pg_temp.check('somebody with no grant cannot consent on your behalf',
    pg_temp.val('accounts', 'publishes_household_rows',
      format('id = %L', current_setting('test.card'))) = 'false');
end $$;

-- `view` can read the account and change nothing on it, which includes this.
do $$
begin
  perform pg_temp.set_level(current_setting('test.card')::uuid,
                            current_setting('test.sam')::uuid, 'view');
  update public.accounts set publishes_household_rows = true
   where id = current_setting('test.card')::uuid;
  perform pg_temp.check('nor can somebody who may only view the account',
    pg_temp.val('accounts', 'publishes_household_rows',
      format('id = %L', current_setting('test.card'))) = 'false');
  -- Put it back: the grant is not part of what the rest of this file is about.
  perform pg_temp.set_level(current_setting('test.card')::uuid,
                            current_setting('test.sam')::uuid, 'balance');
  update public.account_grants set deleted_at = now()
   where account_id = current_setting('test.card')::uuid
     and user_id = current_setting('test.sam')::uuid;
end $$;

-- ============================================================
-- 6. Withdrawing consent hides the rows again
-- ============================================================

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
begin
  perform pg_temp.check('a withdrawn account publishes nothing',
    pg_temp.visible('transactions', format('id = %L', current_setting('test.shop'))) = 0);
end $$;

-- ============================================================
-- 7. The epoch, which is the only signal a hidden row has
-- ============================================================
--
-- A row that becomes invisible emits no realtime event and leaves no tombstone,
-- so without a bump the other device holds it for ever and its household
-- figures go on counting money nobody claims. The reverse is just as bad in a
-- quieter way: a row that becomes VISIBLE has an `updated_at` from whenever it
-- was written, and a delta pull is keyed on exactly that cursor — so turning
-- consent on without a bump would publish a year of history to a device that
-- never asks for it.
--
-- Hence: consent bumps in BOTH directions.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare before_e integer; after_e integer; hh uuid := current_setting('test.household')::uuid;
begin
  before_e := pg_temp.epoch(hh);
  update public.accounts set publishes_household_rows = true
   where id = current_setting('test.card')::uuid;
  after_e := pg_temp.epoch(hh);
  perform pg_temp.check('turning consent on bumps the epoch, so the history replicates',
    after_e > before_e, format('%s -> %s', before_e, after_e));

  before_e := after_e;
  update public.accounts set publishes_household_rows = false
   where id = current_setting('test.card')::uuid;
  after_e := pg_temp.epoch(hh);
  perform pg_temp.check('and turning it off bumps it again, so the rows leave',
    after_e > before_e, format('%s -> %s', before_e, after_e));

  -- One-directional would be a bug in the other direction: an ordinary edit on
  -- a publishing account must not wipe every device's cache.
  perform pg_temp.publish(current_setting('test.card')::uuid, true);
  before_e := pg_temp.epoch(hh);
  update public.accounts set name = 'Gabis card' where id = current_setting('test.card')::uuid;
  perform pg_temp.check('renaming a publishing account does not',
    pg_temp.epoch(hh) = before_e);
end $$;

-- The row-level half. Un-marking one row hides one row, with the same absence
-- of any other signal.
do $$
declare before_e integer; hh uuid := current_setting('test.household')::uuid;
begin
  before_e := pg_temp.epoch(hh);
  update public.transactions set paid_for_household = false
   where id = current_setting('test.shop')::uuid;
  perform pg_temp.check('un-marking a published row bumps the epoch',
    pg_temp.epoch(hh) > before_e);

  -- Marking one does not: the update moves `updated_at`, and the ordinary delta
  -- pull is keyed on that. Ticking the box is the common case, and it must not
  -- cost both devices a full re-pull.
  before_e := pg_temp.epoch(hh);
  update public.transactions set paid_for_household = true
   where id = current_setting('test.shop')::uuid;
  perform pg_temp.check('marking one does not', pg_temp.epoch(hh) = before_e);

  -- Nor does an ordinary edit to a row that is already published.
  before_e := pg_temp.epoch(hh);
  update public.transactions set payee = 'TESCO' where id = current_setting('test.shop')::uuid;
  perform pg_temp.check('nor does editing one', pg_temp.epoch(hh) = before_e);
end $$;

-- Deleting a published row deliberately does NOT bump, and this is the reason
-- the policy has no `deleted_at` condition: the tombstone still satisfies it, so
-- the deletion replicates through the ordinary pull like any other. A bump here
-- would be a full re-pull on both devices every time somebody removed a row.
do $$
declare before_e integer; hh uuid := current_setting('test.household')::uuid;
begin
  before_e := pg_temp.epoch(hh);
  update public.transactions set deleted_at = now()
   where id = current_setting('test.shop')::uuid;
  perform pg_temp.check('deleting a published row does not bump the epoch',
    pg_temp.epoch(hh) = before_e);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
begin
  perform pg_temp.check('and its tombstone is still readable, so the deletion replicates',
    pg_temp.visible('transactions', format('id = %L and deleted_at is not null',
      current_setting('test.shop'))) = 1);
end $$;

-- ============================================================
-- 8. A published row does not survive leaving the household
-- ============================================================
--
-- The `household_id` conjunct in the policy, which is easy to read as belt and
-- braces and is not: accounts travel between households when somebody departs,
-- and without it a card that once published would go on publishing to the
-- people left behind.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare t uuid;
begin
  -- A fresh marked row, since the one above is now tombstoned.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor, paid_for_household)
  values (current_setting('test.card')::uuid, current_date, 'WAITROSE', -4400, true) returning id into t;
  perform set_config('test.later', t::text, false);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
begin
  perform pg_temp.check('a row added after consent is published too',
    pg_temp.visible('transactions', format('id = %L', current_setting('test.later'))) = 1);
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);
do $$
begin
  -- Gabi leaves, taking the card and its rows to a new household. Sam is
  -- promoted first: a household must never be left without an admin while
  -- somebody is still in it.
  perform public.set_member_role(current_setting('test.sam')::uuid, 'admin');
  perform public.leave_household();
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$
begin
  perform pg_temp.check('and stops being published the moment the account leaves the household',
    pg_temp.visible('transactions', format('id = %L', current_setting('test.later'))) = 0);
end $$;

-- ============================================================
-- 9. sync_checksums() agrees with what the client can pull
-- ============================================================
--
-- Quietly the most important check in the file. `sync_checksums()` is security
-- INVOKER precisely so that RLS applies to it and the client can compare its
-- answer against an equally filtered cache. If a published row were counted
-- there but not returned by the pull — or the reverse — the reconcile loop
-- would decide the cache was wrong and wipe it, once a minute, for ever.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare counted bigint; readable bigint;
begin
  select live_rows into counted from public.sync_checksums() where table_name = 'transactions';
  readable := pg_temp.visible('transactions', 'deleted_at is null');
  perform pg_temp.check('the checksum counts exactly the rows the pull returns',
    counted = readable, format('checksum %s, readable %s', counted, readable));
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
