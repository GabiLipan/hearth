-- Hearth — unlinking a transfer gives the categories back (12 of 12)
--
-- A MIGRATION. Run once, after 11-account-recovery.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- Linking two transactions into a transfer clears `category_id` on both, and
-- for a good reason: a transfer is neither spending nor income, so a category
-- on one is at best inert and at worst read as a budgeted expense by anything
-- that has not remembered to exclude transfers.
--
-- The cost was that the old values were gone. Press "Not a transfer" — because
-- the reviewer paired the wrong two rows, which is the entire reason that
-- button exists — and you got back two uncategorised transactions and no way to
-- know what they had been. The undo was lossy, which makes the thing it undoes
-- harder to try.
--
-- So: remember them. One nullable column, written only by the server, holding
-- what a leg was filed under before it became half a transfer.
--
-- Why not a separate table: because the value belongs to the row, exactly one
-- of them exists at a time, and it dies with the row. A table would need its
-- own policies restating `transactions_update`, and there is no question it
-- could answer that the column cannot.

-- ============================================================
-- 0. Refuse to install against a schema missing 09
-- ============================================================

do $$
begin
  if to_regprocedure('public.link_transfer(uuid,uuid,uuid)') is null then
    raise exception
      'Run 09-reconcile.sql and 10-goal-transfers.sql first: this migration rewrites link_transfer()'
      using errcode = '42883';
  end if;
end $$;

-- ============================================================
-- 1. Somewhere to keep it
-- ============================================================
--
-- `on delete set null` matching `category_id` itself: a category deleted while
-- a transfer is linked leaves the leg with nothing to restore, which is the
-- honest outcome — the category it is asking for no longer exists.
--
-- Not in `mapping.ts`'s writable allow-list, and deliberately so. The client
-- never sets this; `link_transfer` and `unlink_transfer` are the only writers,
-- which is what stops it drifting out of step with `category_id`.

alter table public.transactions
  add column if not exists prior_category_id uuid references public.categories(id) on delete set null;

comment on column public.transactions.prior_category_id is
  'What this leg was filed under before link_transfer cleared it. Server-owned; unlink_transfer puts it back.';

-- ============================================================
-- 2. Remember on the way in
-- ============================================================
--
-- Re-stated from 10 with two lines changed, for the reason 10 gave for
-- re-stating 09: `create or replace` on a security-definer body is exactly
-- where a dropped check hides, and a diff of two versions is easier to be sure
-- of than a patch.

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

  if not public.may_use_goal(p_goal_id, in_txn.household_id) then
    raise exception 'Unknown goal' using errcode = '42501';
  end if;

  -- Already linked to each other: idempotent. The tag is still applied, so a
  -- retry that adds a goal is not a no-op.
  if out_txn.transfer_id is not null and out_txn.transfer_id = in_txn.transfer_id then
    if p_goal_id is not null and in_txn.goal_id is distinct from p_goal_id then
      update public.transactions set goal_id = p_goal_id where id = p_in_id;
    end if;
    return out_txn.transfer_id;
  end if;
  if out_txn.transfer_id is not null or in_txn.transfer_id is not null then
    raise exception 'One of those is already part of a transfer' using errcode = '23505';
  end if;

  if out_txn.bill_id is not null or in_txn.bill_id is not null then
    raise exception 'A bill payment cannot also be a transfer' using errcode = '23514';
  end if;

  transfer := gen_random_uuid();

  -- The category still goes, for the reason it always did — but it is kept
  -- rather than dropped, so "Not a transfer" can put it back. `coalesce` so a
  -- pair that was somehow linked and unlinked before does not lose an older
  -- remembered value to a newer null.
  update public.transactions
     set transfer_id = transfer,
         prior_category_id = coalesce(category_id, prior_category_id),
         category_id = null
   where id in (p_out_id, p_in_id);

  if p_goal_id is not null then
    update public.transactions set goal_id = p_goal_id where id = p_in_id;
  end if;

  return transfer;
end $$;

-- ============================================================
-- 3. Give it back on the way out
-- ============================================================
--
-- Re-stated from 10 with one statement changed. Note the order inside the
-- UPDATE does not matter: SQL evaluates every assignment against the row as it
-- was before the statement, so `category_id = prior_category_id` reads the old
-- value even though `prior_category_id` is being cleared in the same breath.

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

  -- `coalesce`, not a bare assignment: somebody may have categorised a leg
  -- while it was linked (nothing forbids it), and their answer is newer than
  -- the remembered one. The goal goes for the reason 10 gave — a tagged credit
  -- that is no longer part of a transfer would go on filling the pot.
  update public.transactions
     set transfer_id = null,
         goal_id = null,
         category_id = coalesce(category_id, prior_category_id),
         prior_category_id = null
   where transfer_id = p_transfer_id and deleted_at is null;

  return n;
end $$;

-- ============================================================
-- 4. Grants
-- ============================================================

do $$
declare f text;
begin
  foreach f in array array['link_transfer(uuid,uuid,uuid)', 'unlink_transfer(uuid)'] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
