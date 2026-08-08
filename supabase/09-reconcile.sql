-- Hearth — reconciling what already happened (9 of 9)
--
-- A MIGRATION. Run once, after 08-profiles.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- Everything in this app that links a transaction to something else does it by
-- CREATING the transaction. `post_bill()` writes a row and records the
-- occurrence. `create_transfer()` writes two rows and stamps them with a shared
-- `transfer_id`. Both are the right shape for money you are recording as it
-- happens, and the wrong shape entirely for money that already left your
-- account and arrived here in a CSV.
--
-- So a mortgage imported from a statement sat there as an ordinary expense
-- while the bill it paid stayed "overdue" until you pressed a button that
-- wrote a SECOND mortgage payment. And two legs of a transfer imported from two
-- different statements could never become a transfer, because `transfer_id` is
-- not a client-writable column — deliberately, since a client that could write
-- it could fabricate half a transfer and make money disappear from both totals.
--
-- The fix is four functions that link rows that already exist, and unlink them
-- again. Nothing here creates or destroys a transaction; every one of them only
-- moves a foreign key.
--
--   1. link_bill_payment   — this transaction IS that bill's occurrence
--   2. unlink_bill_payment — no it isn't
--   3. link_transfer       — these two transactions are one movement of money
--   4. unlink_transfer     — no they aren't
--
-- All four are `security definer`, because `bill_postings` and the far leg of a
-- transfer are rows the caller may not be able to reach directly. Which means
-- each one has to restate in its body every predicate the policies would have
-- applied — the lesson 05 was written to record. `may_edit_transaction()` below
-- exists so that predicate is written once and mirrored, rather than being
-- retyped four times and drifting on the fifth.

-- ============================================================
-- 0. Refuse to install against a schema that is missing 07
-- ============================================================
--
-- Every function below calls my_account_ids(access_level), which 07 introduced.
-- Postgres will not catch that on its own: plpgsql bodies are only
-- syntax-checked at creation time, so without this guard the file reports
-- success and the first attempt to reconcile a bill fails at runtime with
-- "function my_account_ids(unknown) does not exist".

do $$
begin
  if to_regprocedure('public.my_account_ids(public.access_level)') is null then
    raise exception
      'Run 07-permissions.sql first: this migration authorises against my_account_ids(access_level)'
      using errcode = '42883';
  end if;
end $$;

-- ============================================================
-- 1. The predicate, stated once
-- ============================================================
--
-- This is `transactions_update` from 07, verbatim, as a function. The four
-- definer functions below run with RLS off, so this is the only thing standing
-- between "link these two rows" and "write into an account you merely view".
--
-- It takes the two columns rather than the row, so a caller can check a
-- transaction it has already fetched without fetching it twice, and so this
-- cannot accidentally be handed a row from a different table.
--
-- Note what is NOT here: any mention of the household, and any mention of
-- is_household_admin(). An account belongs to the people granted on it.
create or replace function public.may_edit_transaction(p_account_id uuid, p_created_by uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_account_id in (select public.my_account_ids('manage'))
      or (p_account_id in (select public.my_account_ids('contribute'))
          and p_created_by = (select auth.uid()))
$$;

comment on function public.may_edit_transaction(uuid, uuid) is
  'Mirrors the transactions_update policy. Definer functions that bypass RLS must call this.';

-- unlink_bill_payment finds the posting by the transaction it points at, which
-- is the one direction the composite primary key does not answer.
create index if not exists bill_postings_transaction
  on public.bill_postings (transaction_id);

-- ============================================================
-- 2. Bills: this transaction IS the payment
-- ============================================================
--
-- The occurrence is identified by (bill, due date) exactly as `post_bill` has
-- it, and inserts into the same `bill_postings` table with the same
-- `on conflict do nothing`. That composite primary key is what makes this safe
-- to race: if the other device already recorded this occurrence — by posting it
-- or by reconciling a different transaction against it — we take no action and
-- return null, rather than pointing two transactions at one due date.
--
-- `next_due` advances PAST the reconciled date rather than by exactly one
-- period. An import is usually months of history at once, so the first
-- reconciliation of a monthly bill may be catching up on March while next_due
-- still says January; advancing once would leave it overdue and offer the same
-- match again next render. The loop is bounded for the same reason
-- post_due_bills' is: a corrupt freq must not spin forever.
create or replace function public.link_bill_payment(
  p_bill_id uuid,
  p_txn_id uuid,
  p_due_on date default null
)
returns date
language plpgsql security definer set search_path = public as $$
declare
  b public.bills;
  t public.transactions;
  due date;
  guard integer := 0;
begin
  select * into t from public.transactions
   where id = p_txn_id and deleted_at is null for update;
  if t.id is null then
    raise exception 'Unknown transaction' using errcode = 'P0002';
  end if;

  -- Locked in bill-then-transaction order everywhere in this file, so two
  -- devices reconciling the same pair queue rather than deadlock.
  select * into b from public.bills
   where id = p_bill_id and deleted_at is null for update;
  if b.id is null then
    raise exception 'Unknown bill' using errcode = 'P0002';
  end if;

  -- Both halves are checked. Writing bill_id onto the transaction is an update
  -- to the transaction; advancing next_due is an update to the bill; and the
  -- two can live on different accounts, so one grant does not imply the other.
  if not public.may_edit_transaction(t.account_id, t.created_by) then
    raise exception 'Not allowed to change that transaction' using errcode = '42501';
  end if;
  if not public.may_edit_transaction(b.account_id, b.created_by) then
    raise exception 'Not allowed to change that bill' using errcode = '42501';
  end if;

  -- A bill and its payment must be the same household's, or bill_postings would
  -- carry a household_id belonging to neither of them.
  if t.household_id is distinct from b.household_id then
    raise exception 'That transaction belongs to another household' using errcode = '42501';
  end if;

  -- Already this bill's: idempotent, so a retry after a dropped response is a
  -- no-op rather than an error the user has to understand.
  if t.bill_id = b.id then
    return b.next_due;
  end if;
  if t.bill_id is not null then
    raise exception 'That transaction is already recorded against another bill' using errcode = '23505';
  end if;

  due := coalesce(p_due_on, b.next_due);

  insert into public.bill_postings (bill_id, due_on, household_id, transaction_id)
  values (b.id, due, b.household_id, p_txn_id)
  on conflict (bill_id, due_on) do nothing;

  if not found then
    -- The other device recorded this occurrence first. Leave everything alone:
    -- claiming the transaction now would attach it to a due date that already
    -- has a payment.
    return null;
  end if;

  update public.transactions set bill_id = b.id where id = p_txn_id;

  -- Walk forward to the first occurrence that has not been paid.
  while b.next_due <= due and guard < 120 loop
    guard := guard + 1;
    b.next_due := public.advance_due(b.next_due, b.freq);
  end loop;
  update public.bills set next_due = b.next_due where id = b.id;

  return b.next_due;
end $$;

-- Undo. Deliberately does NOT delete the transaction: this function is reached
-- from "that wasn't the mortgage", and the payment is still a real thing that
-- happened to the account whatever it was for.
--
-- It does wind `next_due` back to the freed occurrence, because the alternative
-- is a bill that is silently a month ahead of itself with no way to notice.
-- Winding back is safe where deleting is not: the occurrence has no posting
-- row any more, so it is genuinely unpaid again.
create or replace function public.unlink_bill_payment(p_txn_id uuid)
returns date
language plpgsql security definer set search_path = public as $$
declare
  t public.transactions;
  b public.bills;
  freed date;
begin
  select * into t from public.transactions where id = p_txn_id for update;
  if t.id is null or t.bill_id is null then
    return null;
  end if;

  select * into b from public.bills where id = t.bill_id for update;
  if b.id is null then
    -- The bill is gone; just release the transaction.
    update public.transactions set bill_id = null where id = p_txn_id;
    return null;
  end if;

  if not public.may_edit_transaction(t.account_id, t.created_by) then
    raise exception 'Not allowed to change that transaction' using errcode = '42501';
  end if;
  if not public.may_edit_transaction(b.account_id, b.created_by) then
    raise exception 'Not allowed to change that bill' using errcode = '42501';
  end if;

  delete from public.bill_postings
   where transaction_id = p_txn_id
   returning due_on into freed;

  update public.transactions set bill_id = null where id = p_txn_id;

  if freed is not null and b.next_due > freed then
    update public.bills set next_due = freed where id = b.id;
    return freed;
  end if;
  return b.next_due;
end $$;

-- ============================================================
-- 3. Transfers: these two transactions are one movement
-- ============================================================
--
-- The counterpart to create_transfer() for money that is already recorded.
-- Same end state — one `transfer_id` across two rows in two accounts, so both
-- legs drop out of every spending and income total — reached by stamping rows
-- that exist rather than inserting new ones.
--
-- Both legs are authorised separately and both must pass. Half a transfer is
-- worse than none: the visible leg would be excluded from the totals while the
-- hidden one still counted, and no screen would show why the numbers disagreed.
create or replace function public.link_transfer(p_out_id uuid, p_in_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  out_txn public.transactions;
  in_txn public.transactions;
  transfer uuid;
begin
  if p_out_id = p_in_id then
    raise exception 'A transfer needs two different transactions' using errcode = '23514';
  end if;

  -- Locked in id order, not argument order: two devices linking the same pair
  -- from opposite directions would otherwise each hold what the other wants.
  if p_out_id < p_in_id then
    select * into out_txn from public.transactions where id = p_out_id and deleted_at is null for update;
    select * into in_txn  from public.transactions where id = p_in_id  and deleted_at is null for update;
  else
    select * into in_txn  from public.transactions where id = p_in_id  and deleted_at is null for update;
    select * into out_txn from public.transactions where id = p_out_id and deleted_at is null for update;
  end if;

  if out_txn.id is null or in_txn.id is null then
    raise exception 'Unknown transaction' using errcode = 'P0002';
  end if;

  if not public.may_edit_transaction(out_txn.account_id, out_txn.created_by)
     or not public.may_edit_transaction(in_txn.account_id, in_txn.created_by) then
    raise exception 'Not allowed to change both sides of that transfer' using errcode = '42501';
  end if;

  if out_txn.household_id is distinct from in_txn.household_id then
    raise exception 'Those transactions belong to different households' using errcode = '42501';
  end if;

  if out_txn.account_id = in_txn.account_id then
    raise exception 'Both sides of a transfer are in the same account' using errcode = '23514';
  end if;

  -- Money out on one side, the same money in on the other. Equality rather than
  -- a tolerance: the client proposes candidates fuzzily, but what it finally
  -- asserts has to be exact, or this becomes a way to quietly erase the
  -- difference between two amounts from every total in the app.
  if out_txn.amount_minor >= 0 or in_txn.amount_minor <= 0 then
    raise exception 'A transfer is one payment out and one in' using errcode = '23514';
  end if;
  if out_txn.amount_minor <> -in_txn.amount_minor then
    raise exception 'Both sides of a transfer must be the same amount' using errcode = '23514';
  end if;

  -- Already linked to each other: idempotent, same reasoning as above.
  if out_txn.transfer_id is not null and out_txn.transfer_id = in_txn.transfer_id then
    return out_txn.transfer_id;
  end if;
  if out_txn.transfer_id is not null or in_txn.transfer_id is not null then
    raise exception 'One of those is already part of a transfer' using errcode = '23505';
  end if;

  -- A bill payment is not a transfer, and a transaction cannot be both: one is
  -- spending recorded against a bill, the other is excluded from spending.
  if out_txn.bill_id is not null or in_txn.bill_id is not null then
    raise exception 'A bill payment cannot also be a transfer' using errcode = '23514';
  end if;

  transfer := gen_random_uuid();

  -- The category goes with it. A transfer is neither spending nor income, so a
  -- category on one is at best inert and at worst read as a budgeted expense by
  -- anything that has not remembered to exclude transfers. create_transfer
  -- leaves both legs uncategorised for the same reason; this matches it.
  update public.transactions
     set transfer_id = transfer, category_id = null
   where id in (p_out_id, p_in_id);

  return transfer;
end $$;

-- Undo. Both legs are released, and both stay uncategorised — the categories
-- they had before linking are not recoverable, which is worth knowing before
-- linking one by hand.
create or replace function public.unlink_transfer(p_transfer_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  t public.transactions;
  n integer := 0;
begin
  if p_transfer_id is null then return 0; end if;

  -- Every leg is checked before any is changed. Releasing only the legs you may
  -- edit would leave exactly the half-transfer link_transfer refuses to create.
  for t in select * from public.transactions
            where transfer_id = p_transfer_id and deleted_at is null for update
  loop
    if not public.may_edit_transaction(t.account_id, t.created_by) then
      raise exception 'Not allowed to change both sides of that transfer' using errcode = '42501';
    end if;
    n := n + 1;
  end loop;

  if n = 0 then return 0; end if;

  update public.transactions set transfer_id = null
   where transfer_id = p_transfer_id and deleted_at is null;

  return n;
end $$;

-- ============================================================
-- 4. Grants
-- ============================================================
--
-- `create or replace` resets grants, so these are applied here rather than
-- being assumed from 07. Nothing above is reachable by `anon`.

do $$
declare f text;
begin
  foreach f in array array[
    'may_edit_transaction(uuid,uuid)',
    'link_bill_payment(uuid,uuid,date)',
    'unlink_bill_payment(uuid)',
    'link_transfer(uuid,uuid)',
    'unlink_transfer(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
