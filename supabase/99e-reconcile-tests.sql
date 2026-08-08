-- Hearth — tests for reconciling existing rows (migration 09)
--
-- Companion to 99, 99b, 99c and 99d. Same shape: runs in a transaction, rolls
-- back, every row of the output must read ok = true.
--
-- The four functions under test are all `security definer`, which is to say RLS
-- is switched off inside them and the only thing left is what they check by
-- hand. So roughly half this file is not about bills or transfers at all — it
-- is about whether somebody who may only VIEW an account can use these
-- functions to reach into it sideways. That is the failure mode 05 was written
-- about, and the one worth the most assertions.
--
-- As in 99d: an UPDATE blocked by a policy matches zero rows silently, but
-- these functions RAISE, so the checks here can catch exceptions.

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
  insert into auth.users (id, email) values (gabi, 'g5@test.local'), (sam, 'p5@test.local');
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
--   sams     — Sam owns, Gabi has no grant
--
-- plus a monthly mortgage on `current`, three months overdue, and three
-- payments already sitting in the account as if they had been imported.

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare
  h public.households;
  cur uuid; sav uuid; housing uuid; b uuid;
begin
  h := public.create_household('Reconcile test');
  perform set_config('test.join_code', h.join_code, false);
  perform set_config('test.household', h.id::text, false);

  select id into housing from public.categories
   where name = 'Home & utilities' and household_id = h.id;
  perform set_config('test.housing', housing::text, false);

  insert into public.accounts (name, kind) values ('Current', 'current') returning id into cur;
  insert into public.accounts (name, kind) values ('Savings', 'savings') returning id into sav;
  perform set_config('test.current', cur::text, false);
  perform set_config('test.savings', sav::text, false);

  -- Due on the 1st, three occurrences behind.
  insert into public.bills (name, payee, amount_minor, category_id, account_id, freq, next_due, active, auto_post)
  values ('Mortgage', 'NATIONWIDE MTG', -120000, housing, cur, 'monthly',
          date_trunc('month', current_date)::date - interval '3 months', true, false)
  returning id into b;
  perform set_config('test.bill', b::text, false);

  -- The imported statement: three mortgage payments, one per month.
  insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
  values (cur, housing, (date_trunc('month', current_date) - interval '3 months')::date + 1,
          'NATIONWIDE MTG 0021', -120000)
  returning id into b;
  perform set_config('test.pay1', b::text, false);

  insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
  values (cur, housing, (date_trunc('month', current_date) - interval '2 months')::date + 1,
          'NATIONWIDE MTG 0021', -120000)
  returning id into b;
  perform set_config('test.pay2', b::text, false);

  -- The two legs of a transfer, imported from two different statements.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (cur, current_date, 'TFR TO SAVINGS', -50000) returning id into b;
  perform set_config('test.leg_out', b::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (sav, current_date, 'TFR FROM CURRENT', 50000) returning id into b;
  perform set_config('test.leg_in', b::text, false);

  -- A leg with a mismatched amount, and one in the same account.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (sav, current_date, 'Interest', 4999) returning id into b;
  perform set_config('test.odd_in', b::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (cur, current_date, 'Refund', 50000) returning id into b;
  perform set_config('test.same_acct_in', b::text, false);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$ begin perform public.join_household(current_setting('test.join_code')); end $$;

do $$
declare sams uuid;
begin
  insert into public.accounts (name, kind) values ('Sams', 'current') returning id into sams;
  perform set_config('test.sams', sams::text, false);
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);
do $$ begin
  perform pg_temp.grant_to(current_setting('test.current')::uuid,
                           current_setting('test.sam')::uuid, 'view');
end $$;

-- ============================================================
-- 1. A bill is satisfied by a transaction that already exists
-- ============================================================

do $$
declare due date; new_due date; posted bigint;
begin
  due := (date_trunc('month', current_date) - interval '3 months')::date;

  new_due := public.link_bill_payment(
    current_setting('test.bill')::uuid,
    current_setting('test.pay1')::uuid,
    due);

  perform pg_temp.check('linking a payment returns the new next due date', new_due is not null,
    coalesce(new_due::text, 'null'));

  perform pg_temp.check('the transaction now belongs to the bill',
    pg_temp.val('transactions', 'bill_id', format('id = %L', current_setting('test.pay1')))
      = current_setting('test.bill'));

  posted := pg_temp.cnt('bill_postings', format('bill_id = %L and due_on = %L',
    current_setting('test.bill'), due));
  perform pg_temp.check('the occurrence is recorded exactly once', posted = 1, format('%s rows', posted));

  perform pg_temp.check('next due advanced past the occurrence it satisfied',
    new_due > due, format('%s > %s', new_due, due));

  -- No transaction was written. This is the entire point: the old path recorded
  -- a SECOND mortgage payment.
  perform pg_temp.check('no new transaction was created',
    pg_temp.cnt('transactions', format('account_id = %L and payee like %L',
      current_setting('test.current'), 'NATIONWIDE%')) = 2);
end $$;

-- Linking the same pair again is a no-op, not an error — a retry after a
-- dropped response must not surface to the user as a failure.
do $$
declare again date;
begin
  again := public.link_bill_payment(
    current_setting('test.bill')::uuid,
    current_setting('test.pay1')::uuid,
    (date_trunc('month', current_date) - interval '3 months')::date);
  perform pg_temp.check('re-linking the same payment is idempotent', again is not null,
    coalesce(again::text, 'null'));
  perform pg_temp.check('…and did not record a second occurrence',
    pg_temp.cnt('bill_postings', format('transaction_id = %L', current_setting('test.pay1'))) = 1);
end $$;

-- A second occurrence, further forward. next_due must walk past it rather than
-- advancing by exactly one period and staying overdue.
do $$
declare new_due date;
begin
  new_due := public.link_bill_payment(
    current_setting('test.bill')::uuid,
    current_setting('test.pay2')::uuid,
    (date_trunc('month', current_date) - interval '2 months')::date);
  perform pg_temp.check('next due walks forward past every occurrence paid so far',
    new_due > (date_trunc('month', current_date) - interval '2 months')::date,
    coalesce(new_due::text, 'null'));
end $$;

-- One transaction cannot pay two bills.
do $$
declare other_bill uuid; state text;
begin
  insert into public.bills (name, payee, amount_minor, category_id, account_id, freq, next_due, active, auto_post)
  values ('Second', 'NATIONWIDE MTG', -120000, current_setting('test.housing')::uuid,
          current_setting('test.current')::uuid, 'monthly', current_date, true, false)
  returning id into other_bill;

  state := pg_temp.raises(format('select public.link_bill_payment(%L, %L, %L)',
    other_bill, current_setting('test.pay1'), current_date));
  perform pg_temp.check('a transaction already on one bill cannot be linked to another',
    state = '23505', coalesce(state, 'no error'));
end $$;

-- ============================================================
-- 2. Unlinking releases the occurrence
-- ============================================================

do $$
declare before_due date; after_due date;
begin
  before_due := pg_temp.val('bills', 'next_due', format('id = %L', current_setting('test.bill')))::date;
  after_due  := public.unlink_bill_payment(current_setting('test.pay2')::uuid);

  perform pg_temp.check('unlinking releases the transaction',
    pg_temp.val('transactions', 'bill_id', format('id = %L', current_setting('test.pay2'))) is null);
  perform pg_temp.check('…and removes the posting',
    pg_temp.cnt('bill_postings', format('transaction_id = %L', current_setting('test.pay2'))) = 0);
  perform pg_temp.check('…and winds next due back to the freed occurrence',
    after_due < before_due, format('%s < %s', after_due, before_due));

  -- The payment itself is untouched. It happened, whatever it was for.
  perform pg_temp.check('unlinking does not delete the transaction',
    pg_temp.cnt('transactions', format('id = %L and deleted_at is null',
      current_setting('test.pay2'))) = 1);
end $$;

-- ============================================================
-- 3. Bills: authorisation, with RLS switched off
-- ============================================================

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
declare state text;
begin
  -- Sam can READ everything on `current` — that is what 'view' means — and must
  -- still not be able to reconcile anything on it.
  perform pg_temp.check('sam really can see the account',
    (select count(*) from public.transactions
      where account_id = current_setting('test.current')::uuid) > 0);

  state := pg_temp.raises(format('select public.link_bill_payment(%L, %L, %L)',
    current_setting('test.bill'), current_setting('test.pay2'), current_date));
  perform pg_temp.check('view level cannot link a bill payment', state = '42501',
    coalesce(state, 'no error'));

  perform pg_temp.check('…and nothing moved',
    pg_temp.val('transactions', 'bill_id', format('id = %L', current_setting('test.pay2'))) is null);

  state := pg_temp.raises(format('select public.unlink_bill_payment(%L)', current_setting('test.pay1')));
  perform pg_temp.check('view level cannot unlink one either', state = '42501',
    coalesce(state, 'no error'));
  perform pg_temp.check('…and the posting survived',
    pg_temp.cnt('bill_postings', format('transaction_id = %L', current_setting('test.pay1'))) = 1);
end $$;

-- An account Sam has no grant on at all does not exist as far as they are
-- concerned, and the error must not distinguish "not allowed" from "not there".
do $$
declare state text;
begin
  state := pg_temp.raises(format('select public.link_bill_payment(%L, %L, %L)',
    current_setting('test.bill'), current_setting('test.leg_in'), current_date));
  perform pg_temp.check('no grant at all cannot link a payment', state = '42501',
    coalesce(state, 'no error'));
end $$;

-- ============================================================
-- 4. Transfers: two existing rows become one movement
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare tid uuid; out_tid text; in_tid text;
begin
  tid := public.link_transfer(current_setting('test.leg_out')::uuid,
                              current_setting('test.leg_in')::uuid);
  perform pg_temp.check('linking two existing legs returns a transfer id', tid is not null);

  out_tid := pg_temp.val('transactions', 'transfer_id', format('id = %L', current_setting('test.leg_out')));
  in_tid  := pg_temp.val('transactions', 'transfer_id', format('id = %L', current_setting('test.leg_in')));
  perform pg_temp.check('both legs carry the same transfer id',
    out_tid = in_tid and out_tid = tid::text, format('%s vs %s', out_tid, in_tid));

  -- A transfer is neither spending nor income, so it carries no category —
  -- matching what create_transfer() writes.
  perform pg_temp.check('both legs are left uncategorised',
    pg_temp.val('transactions', 'category_id', format('id = %L', current_setting('test.leg_out'))) is null
    and pg_temp.val('transactions', 'category_id', format('id = %L', current_setting('test.leg_in'))) is null);

  perform pg_temp.check('re-linking the same pair is idempotent',
    public.link_transfer(current_setting('test.leg_out')::uuid,
                         current_setting('test.leg_in')::uuid) = tid);
end $$;

-- Everything that must be refused.
do $$
declare state text; rival uuid;
begin
  -- Deliberately an exact match in amount and a different account, so the only
  -- thing left to refuse it is that leg_out is already spoken for. Pairing it
  -- with a mismatched amount would pass this check for the wrong reason.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.savings')::uuid, current_date, 'Rival leg', 50000)
  returning id into rival;

  state := pg_temp.raises(format('select public.link_transfer(%L, %L)',
    current_setting('test.leg_out'), rival));
  perform pg_temp.check('a leg already in a transfer cannot join another',
    state = '23505', coalesce(state, 'no error'));

  state := pg_temp.raises(format('select public.link_transfer(%L, %L)',
    current_setting('test.same_acct_in'), current_setting('test.odd_in')));
  perform pg_temp.check('the out leg must actually be money out',
    state = '23514', coalesce(state, 'no error'));

  state := pg_temp.raises(format('select public.link_transfer(%L, %L)',
    current_setting('test.pay1'), current_setting('test.odd_in')));
  perform pg_temp.check('two different amounts are not a transfer',
    state = '23514', coalesce(state, 'no error'));

  state := pg_temp.raises(format('select public.link_transfer(%L, %L)',
    current_setting('test.pay1'), current_setting('test.pay1')));
  perform pg_temp.check('a transaction cannot be transferred to itself',
    state = '23514', coalesce(state, 'no error'));
end $$;

-- Same account on both sides: £500 out of Current and £500 into Current is a
-- refund, not a movement, and treating it as one would erase both from the
-- totals.
do $$
declare state text; out_id uuid;
begin
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.current')::uuid, current_date, 'Same account out', -50000)
  returning id into out_id;

  state := pg_temp.raises(format('select public.link_transfer(%L, %L)',
    out_id, current_setting('test.same_acct_in')));
  perform pg_temp.check('both sides in one account is not a transfer',
    state = '23514', coalesce(state, 'no error'));
end $$;

-- A bill payment is spending recorded against a bill; a transfer is excluded
-- from spending. One row cannot be both.
do $$
declare state text; in_id uuid;
begin
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.savings')::uuid, current_date, 'Mirror', 120000)
  returning id into in_id;

  state := pg_temp.raises(format('select public.link_transfer(%L, %L)',
    current_setting('test.pay1'), in_id));
  perform pg_temp.check('a bill payment cannot also be a transfer',
    state = '23514', coalesce(state, 'no error'));
end $$;

-- ============================================================
-- 5. Transfers: both legs are authorised, or neither moves
-- ============================================================
--
-- The case that matters. Sam owns `sams` and may only VIEW `current`. A
-- transfer joining the two would let Sam stamp a row in Gabi's account — and,
-- worse, half a transfer would drop one leg out of the totals while the other
-- still counted, with no screen able to explain the difference.

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
declare state text; sam_leg uuid; gabi_leg uuid;
begin
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.sams')::uuid, current_date, 'Sam out', -7500)
  returning id into sam_leg;

  select id into gabi_leg from public.transactions
   where account_id = current_setting('test.current')::uuid and amount_minor = 50000 limit 1;

  perform pg_temp.check('sam can see the far leg', gabi_leg is not null);

  state := pg_temp.raises(format('select public.link_transfer(%L, %L)', sam_leg, gabi_leg));
  perform pg_temp.check('a leg you may only view cannot be joined into a transfer',
    state in ('42501', '23514'), coalesce(state, 'no error'));

  perform pg_temp.check('…and the far leg was not stamped',
    pg_temp.val('transactions', 'transfer_id', format('id = %L', gabi_leg)) is null);
  perform pg_temp.check('…nor was your own',
    pg_temp.val('transactions', 'transfer_id', format('id = %L', sam_leg)) is null);
end $$;

-- Unlinking has the same requirement, from the other direction: releasing only
-- the leg you may edit is exactly the half-transfer link_transfer refuses to
-- create.
do $$
declare state text; tid uuid;
begin
  tid := pg_temp.val('transactions', 'transfer_id',
    format('id = %L', current_setting('test.leg_out')))::uuid;
  perform pg_temp.check('the fixture transfer is still linked', tid is not null);

  state := pg_temp.raises(format('select public.unlink_transfer(%L)', tid));
  perform pg_temp.check('view level cannot unlink a transfer', state = '42501',
    coalesce(state, 'no error'));
  perform pg_temp.check('…and both legs still carry it',
    pg_temp.val('transactions', 'transfer_id', format('id = %L', current_setting('test.leg_out'))) is not null
    and pg_temp.val('transactions', 'transfer_id', format('id = %L', current_setting('test.leg_in'))) is not null);
end $$;

-- ============================================================
-- 6. The owner can undo it
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare tid uuid; n integer;
begin
  tid := pg_temp.val('transactions', 'transfer_id',
    format('id = %L', current_setting('test.leg_out')))::uuid;
  n := public.unlink_transfer(tid);
  perform pg_temp.check('unlinking releases both legs', n = 2, format('%s legs', n));
  perform pg_temp.check('…and neither carries a transfer id any more',
    pg_temp.cnt('transactions', format('transfer_id = %L', tid)) = 0);
  perform pg_temp.check('…and both transactions still exist',
    pg_temp.cnt('transactions', format('id in (%L, %L) and deleted_at is null',
      current_setting('test.leg_out'), current_setting('test.leg_in'))) = 2);
end $$;

-- ============================================================
-- 7. may_edit_transaction mirrors the policy it claims to
-- ============================================================
--
-- The whole file rests on this one function. If it ever drifts from
-- transactions_update, every check above passes while the thing they are
-- protecting is gone.

do $$
declare contrib uuid; mine uuid; theirs uuid;
begin
  insert into public.accounts (name, kind) values ('Contrib', 'current') returning id into contrib;
  perform pg_temp.grant_to(contrib, current_setting('test.sam')::uuid, 'contribute');

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (contrib, current_date, 'Gabi added this', -100) returning id into mine;

  perform pg_temp.act_as(current_setting('test.sam')::uuid);
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (contrib, current_date, 'Sam added this', -100) returning id into theirs;

  perform pg_temp.check('contribute may edit what it added',
    public.may_edit_transaction(contrib, current_setting('test.sam')::uuid));
  perform pg_temp.check('contribute may not edit what someone else added',
    not public.may_edit_transaction(contrib, current_setting('test.gabi')::uuid));

  perform pg_temp.act_as(current_setting('test.gabi')::uuid);
  perform pg_temp.check('manage and above may edit anything on the account',
    public.may_edit_transaction(contrib, current_setting('test.sam')::uuid));
  perform pg_temp.check('an account you hold nothing on is not editable',
    not public.may_edit_transaction(current_setting('test.sams')::uuid,
                                    current_setting('test.gabi')::uuid));
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
