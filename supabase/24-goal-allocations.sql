-- Hearth — money already in the account can be put towards a goal (24 of 24)
--
-- A MIGRATION. Run once, after 23-custom-colours.sql. Safe to re-run.
--
-- What was wrong
-- --------------
-- A goal said where its money sat — `goals.account_id`, "where the money
-- actually sits" — and then could not be fed from it. The only two things that
-- could ever write `transactions.goal_id` were `create_transfer`, which MOVES
-- money and so needs somewhere to move it from, and `set_transfer_goal`, which
-- takes a transfer id and refuses anything that is not half of one. So:
--
--   "The £3,000 already in our joint savings is the house deposit"
--
-- had no expression at all. The pot could only ever count movements Hearth
-- itself recorded. An opening balance, an interest credit, a salary that landed
-- straight in savings, a CSV credit with no matching debit — none of them could
-- be pointed at a goal, and the only workaround the screen offered was to move
-- the money out and back in again, which is exactly the "re-record the same
-- movement by hand" failure migration 10 was written to end.
--
-- The fix is to stop deriving a pot's balance from movement.
--
-- A goal is a CLAIM on money that is already somewhere: an intention laid over
-- an account, not a container the money is inside. So there is a ledger of what
-- has been claimed and released, and the pot is the sum of it. Transferring
-- money to savings is an ordinary transfer between two accounts, which the app
-- has always recorded and which `savedInto` now reports as saving; saying which
-- part of the savings account is the deposit is a separate act, and this is it.
--
-- ## Two rules, and the second is the one with teeth
--
-- **The goals on one account cannot claim more than the account holds.** A pot
-- is a claim, and a claim on money that is not there is a number that will
-- disappoint somebody. `assign_to_goal` refuses; it has to be `security
-- definer` to do it, because the other goals on the same account may be the
-- other person's and `goals_select` hides them — which is precisely why the
-- client cannot be trusted to do this check on its own.
--
-- **Money leaving the account comes off the unassigned part first, and then off
-- the largest goal.** Unassigned money is what is spare, so it is what is spent
-- first; and where there is not enough spare, the goal with the most in it is
-- the one that can most afford to give it up. `settle_goals` writes those
-- subtractions as ordinary ledger rows, dated the day it ran, so the pot's
-- history says what happened rather than a figure quietly changing.
--
-- ## Why a table rather than a column on `goals`
--
-- A stored `saved_minor` would be a second source of truth for a fact two
-- devices can both change, and the outbox has no way to merge two increments of
-- one column — last write wins, and one of the two assignments is silently
-- gone. Rows do not have that problem: two devices each append, both survive,
-- and the sum is right. It is the same reasoning that keeps `settlement` a view
-- rather than a `settled` flag.
--
-- ## No visibility epoch, and no new privacy surface
--
-- An entry is readable exactly where its goal is readable, which is what
-- `may_use_goal` already says — so a personal goal's ledger is as private as
-- the goal, and a household goal's is as shared. Nothing about who can see what
-- changes, so nothing bumps the epoch. Note the one thing an entry does leak,
-- deliberately: refusing an over-assignment tells you that the OTHER goals on
-- that account, including any you cannot see, add up to more than you thought.
-- That is an aggregate about your own account, and the alternative is letting
-- the pots claim money that is not there.

-- ============================================================
-- 0. Refuse to install against a schema that is missing what it builds on
-- ============================================================
--
-- plpgsql bodies are only syntax-checked at creation time, so without this the
-- file reports success and the first assignment fails at runtime. 04 brings
-- `goals` and `goals.account_id`; 10 brings the goal predicate every definer
-- function here authorises against; 07 brings `my_account_ids`.

do $$
begin
  if to_regclass('public.goals') is null
     or not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'goals' and column_name = 'account_id'
     )
  then
    raise exception
      'Run 04-subcategories-budgets-goals.sql first: this migration puts money already in an account towards a goal'
      using errcode = '42P01';
  end if;
  if to_regprocedure('public.may_use_goal(uuid,uuid)') is null then
    raise exception 'Run 10-goal-transfers.sql first: this migration authorises against may_use_goal()'
      using errcode = '42883';
  end if;
  if to_regprocedure('public.my_account_ids(access_level)') is null then
    raise exception 'Run 07-permissions.sql first: this migration authorises against my_account_ids()'
      using errcode = '42883';
  end if;
end $$;

-- ============================================================
-- 1. The ledger
-- ============================================================
--
-- Deliberately as small as it can be: how much, and when. A positive row puts
-- money towards the goal, a negative row releases it, and the pot is the sum.
-- No running balance, no link to a transaction — the whole point is that the
-- money did not have to move for this to be true.
--
-- `amount_minor <> 0` because a row for nothing is not a record of anything,
-- and it would show in the goal's history as an event that never happened.

create table if not exists public.goal_entries (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  goal_id uuid not null references public.goals(id) on delete cascade,
  amount_minor bigint not null check (amount_minor <> 0),
  occurred_on date not null default current_date,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Matches the client's (updated_at, id) pull cursor.
create index if not exists goal_entries_pull on public.goal_entries (household_id, updated_at, id);
create index if not exists goal_entries_goal on public.goal_entries (goal_id)
  where deleted_at is null;

alter table public.goal_entries enable row level security;

-- Dropped first, so this file can be re-run when you are not sure whether it
-- was applied. `create policy` has no `if not exists`, and a half-applied
-- migration is worse than a repeated one.
drop policy if exists goal_entries_select on public.goal_entries;
drop policy if exists goal_entries_insert on public.goal_entries;
drop policy if exists goal_entries_update on public.goal_entries;

-- An entry is readable exactly where its goal is. `may_use_goal` is that
-- predicate, already written for migration 10 and already `security definer` —
-- which it has to be, since `goals_select` would otherwise filter the subquery
-- and a personal goal's own entries would be invisible to their owner.
create policy goal_entries_select on public.goal_entries
  for select to authenticated
  using (
    household_id = (select public.my_household())
    and public.may_use_goal(goal_id, household_id)
  );

-- Insert and update are for the RPC's benefit and for a soft delete. An
-- ordinary client insert is refused by the cap check below rather than by a
-- policy — a policy cannot see the other person's goals on the same account,
-- which is the whole reason the check is a definer function.
create policy goal_entries_insert on public.goal_entries
  for insert to authenticated
  with check (
    household_id = (select public.my_household())
    and public.may_use_goal(goal_id, household_id)
  );

create policy goal_entries_update on public.goal_entries
  for update to authenticated
  using (
    household_id = (select public.my_household())
    and public.may_use_goal(goal_id, household_id)
  )
  with check (
    household_id = (select public.my_household())
    and public.may_use_goal(goal_id, household_id)
  );

drop trigger if exists goal_entries_touch on public.goal_entries;
drop trigger if exists goal_entries_stamp on public.goal_entries;

create trigger goal_entries_touch before insert or update on public.goal_entries
  for each row execute function public.touch_updated_at();
create trigger goal_entries_stamp before insert or update on public.goal_entries
  for each row execute function public.stamp_ownership();

-- Adding a table that is already published is an error, not a no-op, so this is
-- guarded too — otherwise re-running the file stops here.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'goal_entries'
  ) then
    alter publication supabase_realtime add table public.goal_entries;
  end if;
end $$;

-- ============================================================
-- 2. What an account holds, and what its goals have claimed
-- ============================================================
--
-- Both `security definer`, and both for the same reason: the caller may hold
-- the account perfectly well and still be unable to see the other person's
-- personal goal sitting on it. A cap computed from only the goals you can see
-- is not a cap.
--
-- The balance is opening plus every live row, which is exactly what
-- `computeBalance` does on the client. There is no stored balance column and
-- there must not be one — see the note in `lib/accounts.ts`.

create or replace function public.account_balance_minor(p_account_id uuid)
returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(a.opening_balance_minor, 0)
       + coalesce((
           select sum(t.amount_minor) from public.transactions t
            where t.account_id = p_account_id and t.deleted_at is null
         ), 0)
    from public.accounts a
   where a.id = p_account_id
$$;

comment on function public.account_balance_minor(uuid) is
  'Opening balance plus every live transaction. Definer, because a goal cap must count money the caller may not itemise.';

create or replace function public.account_assigned_minor(p_account_id uuid)
returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(e.amount_minor), 0)
    from public.goal_entries e
    join public.goals g on g.id = e.goal_id
   where g.account_id = p_account_id
     and g.deleted_at is null
     and e.deleted_at is null
$$;

comment on function public.account_assigned_minor(uuid) is
  'What every goal on this account has claimed, INCLUDING goals the caller cannot see. Definer for exactly that reason.';

-- ============================================================
-- 3. Putting money towards a goal
-- ============================================================
--
-- Upsert by id, the shape `upsert_budget` has had from the start and the one
-- `upsert_rule` had to be rewritten into for migration 22: where the client
-- supplies the primary key, an insert that only considers the natural key dies
-- on the primary one instead, minutes later, as a dead letter nobody can clear
-- by retrying.
--
-- A null amount soft-deletes, which is how the outbox spells a delete for an
-- RPC-backed table — the same call, so there is no second path to keep in step.

create or replace function public.assign_to_goal(
  p_id uuid,
  p_goal_id uuid,
  p_amount_minor bigint,
  p_on_date date,
  p_note text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  hh uuid;
  acct uuid;
  was bigint := 0;
  balance bigint;
  assigned bigint;
begin
  hh := (select public.my_household());
  if hh is null then
    raise exception 'You are not in a household' using errcode = '42501';
  end if;

  if not public.may_use_goal(p_goal_id, hh) then
    raise exception 'Unknown goal' using errcode = '42501';
  end if;

  select g.account_id into acct from public.goals g where g.id = p_goal_id and g.deleted_at is null;

  -- Releasing, or clearing a row put there by mistake. Always allowed: it can
  -- only ever lower what the goals on an account claim, so no cap can be
  -- breached by it and no other goal is affected.
  if p_amount_minor is null then
    update public.goal_entries set deleted_at = now()
     where id = p_id and household_id = hh and deleted_at is null;
    return p_id;
  end if;

  if p_amount_minor = 0 then
    raise exception 'An entry of nothing is not a record of anything' using errcode = '23514';
  end if;

  if acct is null then
    raise exception 'That goal does not say which account the money is in' using errcode = '23514';
  end if;

  -- `view` rather than `contribute`: this records an intention about money that
  -- is already there, and does not touch a single transaction. It is the same
  -- reasoning `request_explanation` is set below the edit bar for.
  if acct not in (select public.my_account_ids('view')) then
    raise exception 'That goal is on an account you cannot see' using errcode = '42501';
  end if;

  -- The row may already exist: a retry after a lost response, or an edit. Its
  -- old amount comes out of the total before the new one goes in, or correcting
  -- £500 to £600 would be tested as though it were another £600.
  select e.amount_minor into was from public.goal_entries e
   where e.id = p_id and e.deleted_at is null;

  balance := public.account_balance_minor(acct);
  assigned := public.account_assigned_minor(acct) - coalesce(was, 0);

  -- Only a claim that GROWS is capped. A release is always allowed, and so is
  -- leaving an existing over-assignment alone — an account whose balance has
  -- fallen is settled by `settle_goals`, not by refusing to touch it.
  if p_amount_minor > 0 and assigned + p_amount_minor > balance then
    raise exception
      'There is only % left unassigned in that account', to_char((balance - assigned) / 100.0, 'FM999999990.00')
      using errcode = '23514', hint = 'Release some from another goal, or put in less.';
  end if;

  insert into public.goal_entries (id, household_id, goal_id, amount_minor, occurred_on, note)
  values (p_id, hh, p_goal_id, p_amount_minor, coalesce(p_on_date, current_date), p_note)
  on conflict (id) do update
    set goal_id = excluded.goal_id,
        amount_minor = excluded.amount_minor,
        occurred_on = excluded.occurred_on,
        note = excluded.note,
        deleted_at = null;

  return p_id;
end $$;

-- ============================================================
-- 4. When the money is no longer there
-- ============================================================
--
-- The rule in one sentence: what leaves the account comes off what is spare,
-- and then off the biggest pot.
--
-- Written down rather than derived. A capped-at-read-time figure would recover
-- on its own the moment money came back, which sounds kinder and is a pot that
-- silently changes size with the account balance — nothing in its history would
-- say a withdrawal had ever touched it. These are ordinary ledger rows, dated
-- the day they were made, and the goal's history reads as what happened.
--
-- Idempotent: running it on an account whose goals are within its balance
-- writes nothing and returns 0, which is what makes it safe to call after every
-- sync rather than only when somebody is watching.

create or replace function public.settle_goals(p_account_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  hh uuid;
  balance bigint;
  over bigint;
  biggest record;
  take bigint;
  n integer := 0;
begin
  hh := (select public.my_household());
  if hh is null then
    raise exception 'You are not in a household' using errcode = '42501';
  end if;
  if p_account_id not in (select public.my_account_ids('view')) then
    raise exception 'Unknown account' using errcode = '42501';
  end if;

  balance := public.account_balance_minor(p_account_id);
  over := public.account_assigned_minor(p_account_id) - balance;
  if over is null or over <= 0 then
    return 0;
  end if;

  -- The largest first, and all of it if that is what it takes, then the next
  -- largest. Ties broken by id so two devices settling the same account reach
  -- the same answer rather than each taking from a different pot.
  --
  -- Every goal on the account, including any this caller cannot see: the money
  -- has gone, and leaving somebody else's pot untouched would mean the shortfall
  -- fell entirely on the pots you happen to own.
  while over > 0 loop
    select g.id as goal_id, coalesce(sum(e.amount_minor), 0) as held
      into biggest
      from public.goals g
      left join public.goal_entries e on e.goal_id = g.id and e.deleted_at is null
     where g.account_id = p_account_id and g.deleted_at is null
     group by g.id
    having coalesce(sum(e.amount_minor), 0) > 0
     order by 2 desc, 1
     limit 1;

    -- Nothing left in any pot. Only reachable if the account has gone negative
    -- past everything assigned, and there is no honest row left to write.
    exit when biggest.goal_id is null;

    take := least(over, biggest.held);
    insert into public.goal_entries (household_id, goal_id, amount_minor, occurred_on, note)
    values (hh, biggest.goal_id, -take, current_date, 'Money left the account');
    over := over - take;
    n := n + 1;
  end loop;

  return n;
end $$;

-- ============================================================
-- 5. Erasing, and leaving
-- ============================================================
--
-- `wipe_household` and `depart_household` both move or remove goals, and an
-- entry that outlived its goal would be a claim on a pot that no longer exists.
-- The foreign key is `on delete cascade`, which covers a real delete; these
-- cover the soft one, which is the only kind either of those functions does.

create or replace function public.tidy_goal_entries()
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with dead as (
    update public.goal_entries e set deleted_at = now()
     where e.deleted_at is null
       and exists (select 1 from public.goals g where g.id = e.goal_id and g.deleted_at is not null)
    returning 1
  )
  select count(*) into n from dead;
  return coalesce(n, 0);
end $$;

comment on function public.tidy_goal_entries() is
  'Soft-deletes entries whose goal has been soft-deleted. Idempotent; safe to call after any wipe.';

-- ============================================================
-- 6. Grants
-- ============================================================
--
-- `create or replace` resets grants and `drop` + `create` discards them, so
-- every function above is granted here rather than being assumed.

do $$
declare f text;
begin
  foreach f in array array[
    'account_balance_minor(uuid)',
    'account_assigned_minor(uuid)',
    'assign_to_goal(uuid,uuid,bigint,date,text)',
    'settle_goals(uuid)',
    'tidy_goal_entries()'
  ] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

grant select, insert, update on public.goal_entries to authenticated;

comment on table public.goal_entries is
  'What has been put towards a goal and taken back off it. The pot is the sum; the money never had to move.';
comment on column public.goal_entries.amount_minor is
  'Positive puts money towards the goal, negative releases it. Never zero.';
comment on column public.goal_entries.occurred_on is
  'The day the claim was made, which is not the day any money moved — it may never have moved at all.';
