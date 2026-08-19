-- Hearth — when a month's money arrives (25 of 25)
--
-- A MIGRATION. Run once, after 24-goal-allocations.sql. Safe to re-run.
--
-- What was wrong
-- --------------
-- `CONTRIBUTION_CUTOFF_DAY = 25` was a constant in the client. Money arriving
-- on or after the 25th counts towards the NEXT month, which is right — we are
-- paid at the end of one month and spend it during the next — and 25 was a
-- guess about one household's payday. Two things follow from its being a guess,
-- and one of them moves a whole month's funding:
--
--   * Paydays move. A salary that lands on the 23rd because the 25th is a
--     Sunday falls back into the month it was meant to leave, and the transfer
--     made the same day goes with it. That month then reads as funded twice and
--     the next as funded not at all — on the chart the household is mostly read
--     through, with nothing on it to say which month is which.
--
--   * One number cannot describe two events. The salary arrives when the
--     employer says; the contribution moves when somebody gets round to it,
--     which may be the same day or three days later. Set the cutoff to catch
--     the transfer and it drags an earlier salary with it; set it to catch the
--     salary and it lets a later transfer fall back a month.
--
-- Two settings and one escape hatch
-- ---------------------------------
-- `households.contribution_cutoff_day` and `households.income_cutoff_day`, each
-- null-or-1..28, where NULL means "do not shift this at all". Separate, because
-- they are separate events with separate dates; separately switchable, because
-- they land in different books — contributions in the household's "Paid in",
-- income in the personal book's "Earned".
--
-- On the household rather than on the device. The household book is complete
-- and IDENTICAL on both our screens — that property is most of why the books
-- exist — and a cutoff kept per device would break it in the one way nobody
-- could see: the same contribution landing in July on one phone and August on
-- the other, with both screens confident. Currency is on the household for the
-- same reason.
--
-- 28 is the ceiling, not 31. A cutoff of 30 has no meaning in February, and a
-- rule that quietly does nothing for one month a year is worse than one that
-- cannot be set.
--
-- `transactions.book_month` is the escape hatch, and it is per ROW rather than
-- per rule: a bonus paid in November that is really December's, a deposit paid
-- in advance, a January invoice settled in the December lull. It is a `yyyy-MM`
-- key and NULL means "work it out from the date and the rule", so nothing has
-- to be backfilled and the setting above goes on handling the ordinary case. It
-- beats the rule outright — an answer somebody typed is never overridden by one
-- the app inferred — and it applies to SPENDING too, which no cutoff moves.
--
-- Neither touches the visibility epoch: nothing here changes who can see what.

-- ============================================================
-- 0. Refuse to install against a schema missing 01
-- ============================================================
--
-- plpgsql bodies are only syntax-checked at creation time, so `set_month_rule`
-- would install happily against a database with no `households` table and fail
-- at runtime instead.

do $$
begin
  if to_regclass('public.households') is null or to_regclass('public.transactions') is null then
    raise exception 'Run 01-schema.sql first' using errcode = '42883';
  end if;
end $$;

-- ============================================================
-- 1. The household's two cutoffs
-- ============================================================
--
-- Both default to 25, the constant this replaces, so nothing moved for anybody
-- on the day it shipped. `18-contributions.sql` widened the shift from
-- contributions alone to every arrival; this keeps that and only makes the day
-- sayable — and separately sayable for the two kinds of arrival.

alter table public.households
  add column if not exists contribution_cutoff_day smallint default 25,
  add column if not exists income_cutoff_day smallint default 25;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.households'::regclass and conname = 'households_cutoff_days_check'
  ) then
    alter table public.households
      add constraint households_cutoff_days_check check (
        (contribution_cutoff_day is null or contribution_cutoff_day between 1 and 28)
        and (income_cutoff_day is null or income_cutoff_day between 1 and 28)
      );
  end if;
end $$;

comment on column public.households.contribution_cutoff_day is
  'Money moved into the household on or after this day counts towards the next month. Null = never shift.';
comment on column public.households.income_cutoff_day is
  'Income arriving on or after this day counts towards the next month. Null = never shift.';

-- ============================================================
-- 2. One row's own answer
-- ============================================================

alter table public.transactions
  add column if not exists book_month text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.transactions'::regclass and conname = 'transactions_book_month_check'
  ) then
    alter table public.transactions
      add constraint transactions_book_month_check check (
        book_month is null or book_month ~ '^\d{4}-(0[1-9]|1[0-2])$'
      );
  end if;
end $$;

comment on column public.transactions.book_month is
  'yyyy-MM this row counts towards, overriding the date and the household cutoffs. Null = derive.';

-- No RLS of its own, deliberately. `transactions_update` already decides who
-- may change a transaction and this is a field on one, so it rides the ordinary
-- outbox like `note`, `paid_for_household` or `contributor_id`.

-- Only ever set on a handful of rows, so a partial index stays small while
-- still answering "what has been moved, and where to" for the screen that lists
-- them.
create index if not exists transactions_book_month
  on public.transactions (household_id, book_month)
  where book_month is not null and deleted_at is null;

-- ============================================================
-- 3. Setting the rule
-- ============================================================
--
-- An RPC rather than a policy, for the reason 02-rls.sql gives: `households` is
-- read-only to its members and every mutation goes through a definer function
-- that can restate the check. `set_household_currency` is the shape being
-- copied, including who may call it — any member, not admins only. An admin
-- manages PEOPLE; when a month starts is a fact about the money, and both
-- people live with the answer either way.
--
-- Both arguments are always sent, null included: supabase-js drops `undefined`
-- arguments, and an omitted one changes PostgREST's overload resolution rather
-- than passing null.

create or replace function public.set_month_rule(
  p_contribution_day integer,
  p_income_day integer
)
returns public.households
language plpgsql security definer set search_path = public as $$
declare h public.households;
begin
  if p_contribution_day is not null and (p_contribution_day < 1 or p_contribution_day > 28) then
    raise exception 'A cutoff day must be between 1 and 28' using errcode = '22023';
  end if;
  if p_income_day is not null and (p_income_day < 1 or p_income_day > 28) then
    raise exception 'A cutoff day must be between 1 and 28' using errcode = '22023';
  end if;

  -- security definer switches RLS off, so the membership test the policy would
  -- have applied is restated here rather than assumed.
  update public.households
     set contribution_cutoff_day = p_contribution_day::smallint,
         income_cutoff_day = p_income_day::smallint
   where id = public.my_household()
  returning * into h;

  if h.id is null then
    raise exception 'No household' using errcode = '42501';
  end if;
  return h;
end $$;

revoke execute on function public.set_month_rule(integer, integer) from anon, public;
grant execute on function public.set_month_rule(integer, integer) to authenticated;
