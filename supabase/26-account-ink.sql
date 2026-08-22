-- Hearth — the mark on the tile (26 of 26)
--
-- A MIGRATION. Run once, after 25-month-rule.sql. Safe to re-run.
--
-- What was wrong
-- --------------
-- An account badge derived both of its halves from one value: the icon painted
-- in the colour, on a 16% mix of that colour into the surface. That works for
-- the twelve palette slots, because `06-category-palette.sql` and
-- `17-account-appearance.sql` both chose an INDEX over a hex for exactly this
-- reason — each slot carries a light-theme value and a dark-theme value, and
-- the pair stays legible on either ground.
--
-- `23-custom-colours.sql` then allowed a hex of its own, which is one value for
-- BOTH themes, and that is where the recipe breaks. Ask for a bank's own navy
-- and the light theme gives a dark mark on a pale navy tile, which is fine, and
-- the dark theme gives a dark mark on a nearly-black tile, which cannot be
-- read. It is not a tuning problem: the fill and the mark are the same colour
-- by construction, so in dark mode both of them are dark. The colours most
-- worth matching — a bank's — are the ones most likely to be dark.
--
-- The fix is mostly on the client, where the badge becomes a SOLID tile with
-- the mark in whichever of black or white measures more legible against it.
-- That needs nothing stored: it is `lib/ink.ts` asked about the fill.
--
-- What it cannot reach is the one case that is a decision rather than a
-- measurement — a brand mark in the brand's own colour on a pale tile, which is
-- how half the high street draws its own app icon. Measurement says black on
-- white, correctly, and the answer wanted is navy.
--
--   `ink`  a `#rrggbb` string, or null. Null is the ordinary case and means
--          "measure it", so nothing is backfilled and every existing account
--          gets a legible mark without anybody opening a form.
--
-- Accounts only, deliberately. A category is a circle in a list of circles and
-- its colour is there to tell it from the eleven others, not to match anything;
-- the tint is right there and nobody has asked otherwise. If this ever spreads,
-- it spreads as a second column on that table rather than by widening this one.
--
-- No RLS of its own. `accounts_update` already decides who may change this row
-- and this is a field on one — it travels through the ordinary outbox beside
-- `name` and `color`. It bumps no visibility epoch: recolouring changes
-- nobody's access, and every device already holds the row.
--
-- THE DEPLOY TRAP, which is 23's trap and is worth restating because it is the
-- expensive one. `READABLE` in `mapping.ts` is derived from `WRITABLE`, so the
-- moment `ink` became writable every pull began asking PostgREST for it. An app
-- shipped ahead of this migration therefore does not lose the feature, it loses
-- SYNC — every pull of accounts fails on an unknown column. Run this BEFORE
-- deploying, not after.

-- ============================================================
-- 0. Refuse to install against a schema missing what it builds on
-- ============================================================
--
-- plpgsql bodies are only syntax-checked at creation time, so a migration
-- referencing a missing column installs "successfully" and fails at runtime.
-- `color` rather than the table: this is the second half of 23, and installing
-- it against a schema without the first half would leave an account able to
-- carry a mark colour and not a tile colour.

do $$
begin
  if to_regclass('public.accounts') is null then
    raise exception 'Run 01-schema.sql first' using errcode = '42883';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'accounts' and column_name = 'color'
  ) then
    raise exception 'Run 23-custom-colours.sql first' using errcode = '42883';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'accounts' and column_name = 'slot'
  ) then
    raise exception 'Run 17-account-appearance.sql first' using errcode = '42883';
  end if;
end $$;

-- ============================================================
-- 1. The column
-- ============================================================
--
-- The same check constraint as 23's, and for the same reason: the value is
-- written straight into `color:` on the client, so anything that is not six hex
-- digits is either a rendering fault or an injection. Three-digit shorthand is
-- refused rather than expanded, because the client normalises before it sends
-- and a short value means something skipped that path.

alter table public.accounts add column if not exists ink text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.accounts'::regclass
       and conname = 'accounts_ink_check'
  ) then
    alter table public.accounts
      add constraint accounts_ink_check check (ink is null or ink ~ '^#[0-9a-fA-F]{6}$');
  end if;
end $$;

comment on column public.accounts.ink is
  'Custom #rrggbb for the MARK on the tile. Null = measure it against `color`/slot.';
