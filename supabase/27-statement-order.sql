-- Hearth — where a row sat on the statement (27 of 27)
--
-- A MIGRATION. Run once, after 26-account-ink.sql. Safe to re-run.
--
-- RUN THIS BEFORE DEPLOYING THE CLIENT THAT WRITES IT. `READABLE` in
-- `mapping.ts` is derived from `WRITABLE`, so the moment `statementOrder`
-- becomes writable every pull asks PostgREST for a column that does not exist
-- yet — and an app shipped ahead of its migration does not lose the feature, it
-- loses SYNC. The same trap 23 and 26 carry.
--
-- What was wrong
-- --------------
-- A bank statement has an order, and inside a day it is the only order there
-- is: two rows dated the second of January carry no time, no sequence number,
-- nothing to tell them apart — except their position in the file, which is the
-- bank's own answer to "which of these happened first".
--
-- Hearth threw it away. `extractRows` reads the file in order, the review
-- screen sorted by date, and `createMany` handed out random uuids; the ledger
-- then broke ties on the id. So a day of six transactions came out shuffled,
-- and once every row carried a running balance beside it — which reads down the
-- page and can be checked against a statement line by line — the shuffle
-- stopped being cosmetic. The figures were right and the order was noise.
--
--   `statement_order`  an integer, or null. It counts UPWARDS WITH TIME: the
--                      earliest row of the file is 0 whichever way round the
--                      file was written, because a statement may run newest
--                      first or oldest first and the client normalises that at
--                      import (see `statementOrder` in `lib/imports.ts`).
--
-- Null is the ordinary case for everything that did not come from a file — a
-- row typed by hand, a bill posted by the app, anything imported before this —
-- and nothing is backfilled, because there is nothing to backfill it FROM. Such
-- a row falls back to `created_at` and then to the id, exactly as every row did
-- until now.
--
-- It is deliberately not unique and deliberately not per-day. It is one number
-- per import, and its whole meaning is "later in the file than the row before
-- it"; two rows from two different imports carrying the same 4 is not a
-- contradiction, it is two files each having a fifth line.
--
-- No RLS of its own. `transactions_select` and `transactions_update` already
-- decide who may read and write this row, and this column changes neither
-- question — it says where a row sat in a document, not who it belongs to.

-- ============================================================
-- 0. Refuse to install on a schema that has not caught up
-- ============================================================
--
-- plpgsql bodies are only syntax-checked at creation time, so a migration
-- referencing a missing table installs "successfully" and fails at runtime.
-- Nothing here has a body, but the guard is the house rule and it costs a line.

do $$
begin
  if to_regclass('public.transactions') is null then
    raise exception 'Run 01-schema.sql first' using errcode = '42P01';
  end if;
end $$;

-- ============================================================
-- 1. The column
-- ============================================================

alter table public.transactions add column if not exists statement_order integer;

comment on column public.transactions.statement_order is
  'Position in the imported file, counting up with TIME (0 = earliest), normalised '
  'by the client whichever way round the statement was written. Null for anything '
  'not imported from a file. Ties in the ledger fall back to created_at, then id.';
