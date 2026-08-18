-- Hearth — a colour of your own (23 of 23)
--
-- A MIGRATION. Run once, after 22-rule-edits.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- The palette is twelve slots, and `06-category-palette.sql` and
-- `17-account-appearance.sql` both wrote down why it is an INDEX rather than a
-- hex colour: every slot carries a light-theme and a dark-theme value that stay
-- legible on both grounds, which a free-form picker cannot promise. That is
-- still the right default and it is still what almost every row will use.
--
-- What it cannot do is say "this one is the green on my bank card". Twelve is
-- enough to tell categories apart and is not enough to MATCH something, and a
-- household with more than twelve categories — every household — eventually has
-- two of the same colour with no way to separate them by hand.
--
--   `color`  a `#rrggbb` string, or null. Null is the ordinary case and means
--            "use the slot", so nothing is backfilled and nothing changes for a
--            row nobody has overridden.
--
-- `slot` STAYS, and stays required wherever it was required: a custom colour is
-- an override laid over a slot, never a replacement for one. Two reasons, both
-- learned rather than assumed. `categories_top_level_has_style` demands a slot
-- on every top-level category, so a row with a colour and no slot would be
-- rejected minutes later as a dead letter; and a client that does not
-- understand this column — an older install, mid-deploy — still has a slot to
-- paint with rather than a grey badge.
--
-- The check constraint is the whole of the validation, and it is deliberately
-- strict. The value is written into `background:` on the client, so anything
-- that is not six hex digits is either a rendering fault or an injection: six
-- digits and a hash, lower or upper case, nothing else. Three-digit shorthand
-- is refused rather than expanded, because the client normalises before it
-- sends and a value arriving short means something skipped that path.
--
-- No RLS of its own, on any of the three. `categories_update`, `accounts_update`
-- and `goals_update` already decide who may change one of these rows, and this
-- is a field on one — it travels through the ordinary outbox beside `name`.
-- Nor does it bump the visibility epoch: recolouring changes nobody's access,
-- and every device already holds the row.

-- ============================================================
-- 0. Refuse to install against a schema missing what it builds on
-- ============================================================

do $$
begin
  if to_regclass('public.categories') is null or to_regclass('public.accounts') is null then
    raise exception 'Run 01-schema.sql first' using errcode = '42883';
  end if;
  if to_regclass('public.goals') is null then
    raise exception 'Run 04-subcategories-budgets-goals.sql first' using errcode = '42883';
  end if;
end $$;

-- ============================================================
-- 1. The column, on all three things that wear a face
-- ============================================================

alter table public.categories add column if not exists color text;
alter table public.accounts   add column if not exists color text;
alter table public.goals      add column if not exists color text;

do $$
declare
  t text;
begin
  foreach t in array array['categories', 'accounts', 'goals'] loop
    if not exists (
      select 1 from pg_constraint
       where conrelid = ('public.' || t)::regclass
         and conname = t || '_color_check'
    ) then
      execute format(
        'alter table public.%I add constraint %I check (color is null or color ~ ''^#[0-9a-fA-F]{6}$'')',
        t, t || '_color_check'
      );
    end if;
  end loop;
end $$;

comment on column public.categories.color is
  'Custom #rrggbb overriding the slot. Null = use slot. One value for both themes.';
comment on column public.accounts.color is
  'Custom #rrggbb overriding the slot. Null = use slot (or derive from kind).';
comment on column public.goals.color is
  'Custom #rrggbb overriding the slot. Null = use slot.';
