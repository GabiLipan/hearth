-- Hearth — saying which book an account is in (14 of 14)
--
-- A MIGRATION. Run once, after 13-paid-for-household.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- An account's book is DERIVED from its grants: two people on it makes it the
-- household's, one owner alone makes it mine. That is the right default and it
-- needs no configuring, which is why it was built that way — nothing to set,
-- and nothing that can disagree with the permissions.
--
-- But derivation is a rule about access, and a book is a statement about whose
-- money it is. They usually agree and sometimes do not:
--
--   - a joint account we opened for one purpose and treat as one person's;
--   - my own account that is really the household's float, which I have not
--     shared because there is nothing on it to see;
--   - an account shared with a parent, which is in neither of our books and
--     lands under Everything with no way to say where it belongs.
--
-- So: an override, null by default. Deriving stays the rule; this is the escape
-- hatch for the cases where the rule is wrong.
--
-- Just a column. `accounts_update` already decides who may change an account,
-- and this is a field on one — no RPC, no policy of its own. It goes through
-- the ordinary outbox.
--
-- It bumps the visibility epoch through the existing `accounts_epoch_trigger`
-- only if that trigger watches the whole row; it does not need to. Moving an
-- account between books changes no one's ACCESS to anything — it changes which
-- of your own totals it lands in, and every device already has the row.

alter table public.accounts
  add column if not exists book_override text
    check (book_override is null or book_override in ('household', 'mine'));

comment on column public.accounts.book_override is
  'Overrides the book derived from grants. Null = derive, which is the normal case.';
