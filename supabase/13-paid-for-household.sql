-- Hearth — paying for the household out of your own pocket (13 of 13)
--
-- A MIGRATION. Run once, after 12-transfer-categories.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- The weekly shop goes on my own card because the joint card is at home. Today
-- that is £90 of MY spending, and the household's grocery figure is £90 short —
-- which is wrong in both books at once, and there was no way to say so.
--
-- The rule, decided rather than derived: a flagged row is treated exactly as if
-- the money had gone from my account into the joint one and then been spent
-- from there. Two events out of one row:
--
--   my book        — a contribution of £90 (not personal spending)
--   household book — £90 paid in, and £90 of household spending
--
-- The household's NET is unchanged, which is right: it received the money and
-- spent it in the same breath. What changes is that the grocery figure is now
-- the household's real grocery figure, and my book stops claiming I spent £90
-- on myself. The debt sits where it belongs — I put £90 in and the household
-- has not paid it back.
--
-- Counting one row in two books is not a double count. It is the same rule that
-- already governs a transfer crossing between books, and it is safe for the
-- same reason: the books are never added together.
--
-- Just a column. No RPC and no policy of its own: `transactions_update` already
-- decides who may change a transaction, and this is a field on one. It is in
-- `mapping.ts`'s writable allow-list, so it goes through the ordinary outbox
-- like any other edit.

alter table public.transactions
  add column if not exists paid_for_household boolean not null default false;

comment on column public.transactions.paid_for_household is
  'Household spending paid from a personal account: a contribution out of the payer''s book, spending in the household''s.';

-- Only ever true on a handful of rows, so a partial index keeps it small while
-- still answering the one query that matters — "what have I paid for that has
-- not come back to me".
create index if not exists transactions_paid_for_household
  on public.transactions (household_id, account_id)
  where paid_for_household and deleted_at is null;
