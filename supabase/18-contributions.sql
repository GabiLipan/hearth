-- Hearth — saying who paid in, when there is no far leg to ask (18 of 18)
--
-- A MIGRATION. Run once, after 17-account-appearance.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- A contribution is attributed by its FAR LEG. `contributionSplit` does not use
-- `created_by` on purpose — for an imported statement that is whoever did the
-- importing, not whose money it was — so it reads the other end of the transfer
-- instead: far leg in one of my accounts, mine; far leg nowhere to be found,
-- theirs, because the only accounts hidden from me belong to the other people in
-- the household.
--
-- That is exactly right whenever a transfer exists. It has no answer at all when
-- the other person is not using the app: their payment into the joint account
-- arrives as a lone positive row that nothing can ever be paired with. The
-- household's income total is still correct — money did arrive — but two things
-- are wrong and one of them moves figures:
--
--   1. it is attributed to nobody, and reads as "other income";
--   2. it never gets the contribution cut-off, so money paid in on 29 July funds
--      JULY instead of August — and August's spending is then compared against
--      income that is not there.
--
-- The second is the damaging one, and it is not a rounding error: it is a whole
-- month's funding in the wrong bucket, on the chart the household is mostly
-- read through.
--
-- The rule, decided rather than derived: a row carrying `contributor_id` is a
-- contribution from that person, whose far leg this app will never see. It is
-- consulted ONLY where there is no transfer — pairing still wins, and always
-- will, because two real rows beat a statement about one.
--
-- Nothing about the totals changes when a row is tagged. The household received
-- the money either way; what changes is whose it is, and which month it is for.
--
-- ## Why just a column
--
-- `transactions_update` already decides who may change a transaction, and this
-- is a field on one — the same reasoning as `paid_for_household` in 13, which
-- this is modelled on. No RPC, no policy of its own, and it goes through the
-- ordinary outbox like any other edit.
--
-- Note this is deliberately NOT the same shape as `explain_requested_by` in 16.
-- That one needed an RPC because asking a question about a row is not editing it
-- and wants a LOWER bar than a PATCH. This is the opposite: saying whose money
-- arrived is an ordinary edit of the row, and anyone who may not edit the row
-- has no business relabelling the household's income.
--
-- ## Why there is no membership check
--
-- `contributor_id` is a label on a row both people can already read, so a value
-- naming somebody outside the household leaks nothing and grants nothing — it
-- degrades to "Someone" on screen, which is what `nameOf` says about any member
-- it cannot resolve. A trigger enforcing membership would be a second place for
-- the departure cascade in 07 to have to know about, in exchange for tidiness.
-- The client offers members and nothing else.

-- ============================================================
-- 0. Refuse to install against a schema missing 13
-- ============================================================
--
-- Not decoration. plpgsql bodies are only syntax-checked at creation time, so a
-- migration built on a missing one installs "successfully" and fails at runtime;
-- and this column is meaningless without the book model 13 completes.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'transactions'
       and column_name = 'paid_for_household'
  ) then
    raise exception
      'Run 13-paid-for-household.sql first: contributions are the other half of the same book model'
      using errcode = '42P01';
  end if;
end $$;

-- ============================================================
-- 1. The mark
-- ============================================================

alter table public.transactions
  add column if not exists contributor_id uuid references auth.users(id) on delete set null;

comment on column public.transactions.contributor_id is
  'Money paid into a household account by this person, whose far leg is in an account this app will never see. Consulted only where there is no transfer_id.';

-- Money IN only. A payment OUT of a joint account into somebody's private
-- account is a withdrawal, which is a different claim with a different sign and
-- its own reading — and crediting the household with a negative contribution
-- would invent money, exactly as `paid_for_household` on an incoming refund
-- would. The mirror case is deliberately left unbuilt rather than half-built.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.transactions'::regclass
       and conname = 'transactions_contributor_is_income'
  ) then
    alter table public.transactions
      add constraint transactions_contributor_is_income
      check (contributor_id is null or amount_minor > 0);
  end if;
end $$;

-- Only ever a handful of rows, and every query about them asks the same
-- question, so a partial index stays small while answering it outright.
create index if not exists transactions_contributor
  on public.transactions (household_id, contributor_id)
  where contributor_id is not null and deleted_at is null;
