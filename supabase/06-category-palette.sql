-- Hearth — widen the category palette to match the app (6 of 6)
--
-- A MIGRATION. Run once, after 05-ownership-and-deletes.sql. Safe to re-run.
--
-- What was wrong
-- --------------
-- `categories.slot` was declared `check (slot between 1 and 8)` in 01-schema.sql,
-- back when the palette had eight colours. It has twelve: index.css defines
-- --series-1..12 in both themes, palette.ts sets SLOT_COUNT = 12, and 04 gave
-- `goals.slot` a `between 1 and 12` check. Only `categories` was left behind.
--
-- The result was not a cosmetic limit. `nextFreeSlot()` picks the LEAST-USED
-- colour, so once a household has the eleven seeded categories, every new
-- category is auto-assigned slot 9-12 — and the insert is rejected with
-- `violates check constraint "categories_slot_check"`. Adding a category was
-- broken by default rather than in a corner case, and because the write goes
-- through the outbox the failure surfaced later as a dead letter rather than as
-- an error on the form.

-- `slot is null` is spelled out rather than left to three-valued logic: 04 made
-- the column nullable, where null means "inherit this from my parent".
alter table public.categories drop constraint if exists categories_slot_check;
alter table public.categories add constraint categories_slot_check
  check (slot is null or slot between 1 and 12);

-- Kept in step for the same reason, and stated here so the two cannot drift
-- apart again silently.
alter table public.goals drop constraint if exists goals_slot_check;
alter table public.goals add constraint goals_slot_check
  check (slot between 1 and 12);
