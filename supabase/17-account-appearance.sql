-- Hearth — giving an account a face (17 of 17)
--
-- A MIGRATION. Run once, after 16-explain-requests.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- Every transaction belongs to an account, and on the Activity table the
-- account was a column of plain grey text — the one column you cannot scan.
-- Categories have had a colour and an icon since the beginning precisely
-- because that is what makes a long list readable at a glance, and accounts,
-- which are fewer and more distinct, had neither.
--
-- Two columns, and deliberately the SAME two categories use:
--
--   `slot`  1..12, an index into the `--series-N` palette. Not a hex colour:
--           every slot has a light-theme and a dark-theme value that stay
--           legible in both, which a free-form picker cannot promise. This is
--           the reasoning `06-category-palette.sql` already recorded, and the
--           check constraint here is the widened one from the start rather
--           than the 1..8 that had to be fixed later.
--
--   `icon`  a key into the client's icon set, not an image. The set is code, so
--           a key that a device does not recognise falls back to a plain tag
--           rather than breaking; that is why the client never renames a key.
--
-- Both are nullable, and null means "work it out from `kind`". An account that
-- has never been given a face still gets a sensible one — a card icon for a
-- credit card, a piggy bank for savings — so nothing has to be backfilled and
-- nobody has to visit a form before the Activity table improves.
--
-- No RLS of its own. `accounts_update` already decides who may change an
-- account and these are fields on one, so they go through the ordinary outbox
-- like `name` and `book_override`. Nor does either bump the visibility epoch:
-- recolouring an account changes nobody's access, and every device already
-- holds the row.

-- ============================================================
-- 0. Refuse to install against a schema missing 01
-- ============================================================

do $$
begin
  if to_regclass('public.accounts') is null then
    raise exception 'Run 01-schema.sql first' using errcode = '42883';
  end if;
end $$;

-- ============================================================
-- 1. The columns
-- ============================================================

alter table public.accounts
  add column if not exists slot smallint,
  add column if not exists icon text;

-- Named so it can be found and widened the way the categories one had to be.
-- 12 is the whole palette; a slot outside it resolves to nothing and the
-- account would render colourless with no error anywhere.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.accounts'::regclass and conname = 'accounts_slot_check'
  ) then
    alter table public.accounts
      add constraint accounts_slot_check check (slot is null or (slot between 1 and 12));
  end if;
end $$;

-- A key, not a filename. Length is the only thing worth enforcing here: the set
-- of valid keys lives in the client, and a server that tried to list them would
-- have to be redeployed every time an icon was added.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.accounts'::regclass and conname = 'accounts_icon_check'
  ) then
    alter table public.accounts
      add constraint accounts_icon_check check (icon is null or length(icon) between 1 and 40);
  end if;
end $$;

comment on column public.accounts.slot is
  'Palette index 1..12 into --series-N. Null = derive from kind on the client.';
comment on column public.accounts.icon is
  'Key into the client icon set. Null = derive from kind. Never a URL.';
