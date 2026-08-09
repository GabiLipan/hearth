-- Hearth — asking the person who can see the other half (16 of 16)
--
-- A MIGRATION. Run once, after 15-purge-account.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- `lib/unexplained.ts` names a blind spot and can do nothing about it. My
-- partner is paid, and moves £1,800 from their private account into the joint
-- one. That is two rows: the leg going out, in an account I will never see, and
-- the leg arriving, which I can. With no partner row to pair it against, my
-- device has to call the arrival something, and it calls it the household
-- EARNING £1,800. The same movement in reverse is worse — money leaving the
-- joint account for their private one reads as £1,800 of household SPENDING,
-- which is the figure budgets measure and the reports are mostly about.
--
-- The client says a sentence about those rows and deliberately reclassifies
-- nothing: guessing on the strength of the word "TFR" would make the figures
-- wrong in a way nobody could see, which is worse than being visibly
-- approximate.
--
-- But the fix — linking the two legs — needs somebody who can write BOTH, and
-- `link_transfer` refuses anybody else. So the person who can SEE the problem
-- and the person who can SOLVE it are different people, and nothing connected
-- them. My screen said "this is approximate", their screen said nothing, and
-- the arrival sat unlinked until somebody happened to go looking.
--
-- This is that connection, and it turns out to be very small.
--
-- ## Why there is no new table
--
-- The row being asked about is always in a HOUSEHOLD account — that is where a
-- leg with an invisible partner lands, and `unexplainedLegs` looks nowhere else.
-- So both people can already see it, `transactions_select` already authorises
-- it, and what has to cross between the devices is one bit: somebody has asked
-- about this. Two columns, replicated by the ordinary pull, and no policy of
-- their own.
--
-- ## Why it is an RPC and not just a writable column
--
-- Asking a question about a row is not editing it. At `contribute` you may only
-- change what you added, so if my partner imported the joint statement I could
-- see the puzzling row perfectly well and have no way to point at it. The RPCs
-- below need `view` — being able to see the row is the whole qualification for
-- being confused by it.
--
-- Online-only in consequence, which is right: the entire purpose is to reach
-- another device.
--
-- ## Why link_transfer is not touched
--
-- The obvious other half of this is "clear the mark when the legs are linked",
-- and doing it there would mean `create or replace` over a security-definer
-- body for the third time — which is exactly where a dropped check hides. It is
-- not needed. A mark on a linked row is meaningless, so the client only renders
-- one on a row that is still unpaired, and linking makes it inert without
-- anybody having to remember to clear it.

-- ============================================================
-- 0. Refuse to install against a schema missing 07
-- ============================================================

do $$
begin
  if to_regprocedure('public.my_account_ids(public.access_level)') is null then
    raise exception
      'Run 07-permissions.sql first: these RPCs authorise against my_account_ids()'
      using errcode = '42883';
  end if;
end $$;

-- ============================================================
-- 1. The mark
-- ============================================================

alter table public.transactions
  add column if not exists explain_requested_at timestamptz,
  add column if not exists explain_requested_by uuid references auth.users(id) on delete set null;

comment on column public.transactions.explain_requested_at is
  'Somebody who can see this row has asked whoever holds its other half to explain it. Server-owned; set by request_explanation().';

-- Only ever a handful of rows, and every query about them asks the same
-- question, so a partial index stays small while answering it outright.
create index if not exists transactions_explain_requested
  on public.transactions (household_id, explain_requested_at)
  where explain_requested_at is not null and deleted_at is null;

-- ============================================================
-- 2. Asking
-- ============================================================
--
-- `view` and above, deliberately lower than the bar for changing the row. Note
-- the asymmetry that makes this whole feature necessary: the person asking is
-- by definition the one who CANNOT resolve it.
--
-- Idempotent, and the FIRST asker is kept. Re-asking is what a screen does when
-- somebody presses a button twice or two devices sync the same intent, and
-- moving the timestamp forward each time would let a question quietly renew
-- itself for ever without anybody meaning it to.
--
-- It refuses on a row that is already paired or already a bill payment: there
-- is nothing left to explain, and a mark that could be left on an explained row
-- is a mark somebody has to go and tidy up.
create or replace function public.request_explanation(p_transaction_id uuid)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  t public.transactions;
  uid uuid := (select auth.uid());
  asked timestamptz;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into t from public.transactions
   where id = p_transaction_id and deleted_at is null
   for update;

  -- One message for "not yours" and "not there", as everywhere else here:
  -- distinguishing them confirms the existence of a row the caller cannot see.
  if t.id is null or t.account_id not in (select public.my_account_ids('view')) then
    raise exception 'That transaction is not one you can ask about' using errcode = '42501';
  end if;

  if t.transfer_id is not null or t.bill_id is not null then
    raise exception 'That transaction is already accounted for' using errcode = '23514';
  end if;

  if t.explain_requested_at is not null then
    return t.explain_requested_at;
  end if;

  -- `touch_updated_at` fires on this, which is what makes the mark replicate:
  -- the other device learns about it through the ordinary delta pull, with no
  -- realtime event and no epoch bump needed. Nobody's access has changed and
  -- both devices already hold the row.
  update public.transactions
     set explain_requested_at = now(), explain_requested_by = uid
   where id = t.id
   returning explain_requested_at into asked;

  return asked;
end $$;

comment on function public.request_explanation(uuid) is
  'Ask whoever can see the other half of this row to explain it. Needs only `view`: seeing a row is the whole qualification for being confused by it.';

-- ============================================================
-- 3. Withdrawing the question
-- ============================================================
--
-- Same bar, and open to EITHER person on purpose. The asker changes their mind;
-- or the person asked looks and says "no, we really did spend that", which is a
-- perfectly good answer that produces no link.
--
-- There is no separate "declined" state, and the two outcomes are still
-- distinguishable on screen without one: a row that was linked now carries a
-- `transfer_id` and reads as a transfer, and a row that was dismissed is
-- unmarked and still unpaired. A third state would need a rule about who is
-- allowed to overrule whom, which is a conversation two people in a household
-- can have without the database mediating it.
create or replace function public.clear_explanation(p_transaction_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  t public.transactions;
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into t from public.transactions
   where id = p_transaction_id and deleted_at is null
   for update;

  if t.id is null or t.account_id not in (select public.my_account_ids('view')) then
    raise exception 'That transaction is not one you can ask about' using errcode = '42501';
  end if;

  update public.transactions
     set explain_requested_at = null, explain_requested_by = null
   where id = t.id;
end $$;

-- ============================================================
-- 4. Grants
-- ============================================================

do $$
declare f text;
begin
  foreach f in array array['request_explanation(uuid)', 'clear_explanation(uuid)'] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
