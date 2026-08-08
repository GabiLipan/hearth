-- Hearth — money already moved can fund a goal (10 of 10)
--
-- A MIGRATION. Run once, after 09-reconcile.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- A goal is funded by tagging the incoming leg of a transfer, and exactly one
-- thing could write that tag: `create_transfer()`. So a goal could only be fed
-- by money you moved *from inside Hearth*.
--
-- Which is the wrong half. The joint → savings transfer that actually happens
-- every month arrives in a CSV, gets paired by `link_transfer()` (or by the
-- reviewer, automatically), and there was then no way to say "that is the
-- house deposit". You could only re-record the same movement by hand, which is
-- the exact failure 09 was written to end.
--
-- Two functions, and one correction:
--
--   1. link_transfer(out, in, goal)  — tag as the pair is linked
--   2. set_transfer_goal(transfer, goal) — tag, retag or untag afterwards
--   3. unlink_transfer() now clears the tag as well
--
-- (2) is not a convenience. Auto-linking is the common path — `TransferReview`
-- pairs a cross-book transfer with no prompt at all — so by the time anybody
-- looks at the row, linking has already happened and (1) is unreachable. A
-- goal that can only be chosen during an action the app performs for you is a
-- goal that can never be chosen.
--
-- On (3): leaving `goal_id` on a leg that is no longer part of a transfer
-- would keep it counting towards the goal as an ordinary credit — `goalProgress`
-- sums `goal_id`, not transfers — so the pot would still claim money that,
-- as far as the app is now concerned, simply arrived. Unlinking already
-- discards the categories for the same reason it discards this. Both are
-- recorded as a known gap; neither is recoverable.

-- ============================================================
-- 0. Refuse to install against a schema that is missing 04 or 09
-- ============================================================
--
-- plpgsql bodies are only syntax-checked at creation time, so without this the
-- file reports success and the first tagged transfer fails at runtime. 04
-- brings `goals` and `transactions.goal_id`; 09 brings the predicate every
-- definer function here authorises against.

do $$
begin
  if to_regclass('public.goals') is null then
    raise exception 'Run 04-subcategories-budgets-goals.sql first: this migration tags a goal'
      using errcode = '42P01';
  end if;
  if to_regprocedure('public.may_edit_transaction(uuid,uuid)') is null then
    raise exception 'Run 09-reconcile.sql first: this migration authorises against may_edit_transaction()'
      using errcode = '42883';
  end if;
end $$;

-- ============================================================
-- 1. The goal predicate, stated once
-- ============================================================
--
-- This is `goals_select`/`goals_update` from 04, as a function, for the same
-- reason `may_edit_transaction` exists: everything below is `security definer`,
-- which switches RLS off, so a predicate that is not restated here is a
-- predicate that is not applied at all.
--
-- Note it takes the household explicitly rather than calling `my_household()`.
-- The caller has already established which household the transactions belong
-- to, and a goal from a *different* household of the same person would
-- otherwise satisfy `my_household()` while being nothing to do with the money
-- being tagged.
--
-- Null is a legal argument and means "no goal", which is always allowed: that
-- is how a tag is removed.
create or replace function public.may_use_goal(p_goal_id uuid, p_household uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_goal_id is null
      or exists (
        select 1 from public.goals g
         where g.id = p_goal_id
           and g.deleted_at is null
           and g.household_id = p_household
           and (g.owner_id is null or g.owner_id = (select auth.uid()))
      )
$$;

comment on function public.may_use_goal(uuid, uuid) is
  'Mirrors the goals_update policy, scoped to one household. Definer functions that tag a goal must call this.';

-- ============================================================
-- 2. link_transfer, now able to tag the goal it funds
-- ============================================================
--
-- The two-argument version is DROPPED rather than left beside this one. An
-- overload pair would be actively dangerous here: supabase-js omits arguments
-- that are `undefined`, and an omitted argument changes PostgREST's overload
-- resolution — the failure is not "the goal was null", it is "could not find
-- the function public.link_transfer in the schema cache", minutes later, in a
-- dead letter. One signature, with a default, cannot do that.
--
-- Everything else is 09's function unchanged, and deliberately so: this is a
-- re-statement rather than a patch, because `create or replace` cannot add a
-- parameter and a diff of two versions of a security-definer body is exactly
-- where a dropped check hides.

-- One consequence worth knowing: 09 is still re-runnable, and re-running it
-- AFTER this file puts the two-argument version back beside the three-argument
-- one. Run this file again afterwards.
-- `00-which-migrations-applied.sql` detects exactly that state.
drop function if exists public.link_transfer(uuid, uuid);

create or replace function public.link_transfer(
  p_out_id uuid,
  p_in_id uuid,
  p_goal_id uuid default null
)
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

  -- Checked before the idempotent return below, so re-linking an existing pair
  -- with a goal nobody may use is refused rather than quietly succeeding.
  if not public.may_use_goal(p_goal_id, in_txn.household_id) then
    raise exception 'Unknown goal' using errcode = '42501';
  end if;

  -- Already linked to each other: idempotent, same reasoning as above. The tag
  -- is still applied, so a retry that adds a goal is not a no-op.
  if out_txn.transfer_id is not null and out_txn.transfer_id = in_txn.transfer_id then
    if p_goal_id is not null and in_txn.goal_id is distinct from p_goal_id then
      update public.transactions set goal_id = p_goal_id where id = p_in_id;
    end if;
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

  -- On the INCOMING leg only, matching create_transfer. The money arriving is
  -- what the pot gained; the money leaving is not a second contribution, and
  -- tagging both would double every goal in the app.
  if p_goal_id is not null then
    update public.transactions set goal_id = p_goal_id where id = p_in_id;
  end if;

  return transfer;
end $$;

-- ============================================================
-- 3. Tagging a transfer that already exists
-- ============================================================
--
-- Takes the transfer rather than the transaction, because "which goal did this
-- movement fund" is a property of the pair, and because the caller should not
-- have to know that the tag lives on the incoming leg.
--
-- Passing null clears it. Returns the id of the leg now carrying the tag, or
-- null when the tag was removed — the client has no way to know which leg that
-- was, and the answer is what it needs to drop from its own cache.
create or replace function public.set_transfer_goal(p_transfer_id uuid, p_goal_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t public.transactions;
  hh uuid;
  in_leg uuid;
  legs integer := 0;
begin
  if p_transfer_id is null then
    raise exception 'Unknown transfer' using errcode = 'P0002';
  end if;

  -- Every leg is authorised before any is changed, the same way
  -- unlink_transfer does it: tagging half a transfer is the same corruption as
  -- releasing half of one.
  for t in select * from public.transactions
            where transfer_id = p_transfer_id and deleted_at is null
            order by id for update
  loop
    if not public.may_edit_transaction(t.account_id, t.created_by) then
      raise exception 'Not allowed to change both sides of that transfer' using errcode = '42501';
    end if;
    hh := t.household_id;
    if t.amount_minor > 0 then in_leg := t.id; end if;
    legs := legs + 1;
  end loop;

  if legs = 0 then
    raise exception 'Unknown transfer' using errcode = 'P0002';
  end if;

  if not public.may_use_goal(p_goal_id, hh) then
    raise exception 'Unknown goal' using errcode = '42501';
  end if;

  -- Cleared from every leg first. A pair whose direction was corrected, or one
  -- imported the other way round, could otherwise be left with the tag on the
  -- outgoing leg and a second copy on the incoming one.
  update public.transactions set goal_id = null
   where transfer_id = p_transfer_id and deleted_at is null and goal_id is not null;

  if p_goal_id is null then
    return null;
  end if;

  -- A transfer with no incoming leg visible to this device is one whose far
  -- side is in somebody else's account, and the tag has nowhere honest to go.
  if in_leg is null then
    raise exception 'That transfer has no incoming side here' using errcode = 'P0002';
  end if;

  update public.transactions set goal_id = p_goal_id where id = in_leg;
  return in_leg;
end $$;

-- ============================================================
-- 4. Unlinking gives the money back
-- ============================================================
--
-- Re-stated from 09 with one line added. Without it, splitting a transfer back
-- into two ordinary transactions leaves the credit still tagged, so the goal
-- keeps counting money the app no longer believes was ever moved there.

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

  update public.transactions set transfer_id = null, goal_id = null
   where transfer_id = p_transfer_id and deleted_at is null;

  return n;
end $$;

-- ============================================================
-- 5. Grants
-- ============================================================
--
-- `create or replace` resets grants, and `drop` + `create` discards them
-- outright, so every function touched above is re-granted here rather than
-- being assumed from 09.

do $$
declare f text;
begin
  foreach f in array array[
    'may_use_goal(uuid,uuid)',
    'link_transfer(uuid,uuid,uuid)',
    'set_transfer_goal(uuid,uuid)',
    'unlink_transfer(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
