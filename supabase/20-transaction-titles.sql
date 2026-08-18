-- Hearth — calling a transaction what it actually is (20 of 20)
--
-- A MIGRATION. Run once, after 19-published-household-rows.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- A bank statement does not write English. "SQ *THE GOOD FORK 3241 LON", "FPI
-- SMITH J LTD REF 88213", "DD PETS AT HOME INS" — every row in Activity is the
-- string the bank sent, and the only two things the app could ever do about it
-- were `prettyPayee` (title-case the normalised form, which turns shouting into
-- Shouting) and the note, which is per row and therefore has to be typed again
-- every month.
--
-- So this adds `transactions.title`: the name a person would use. It never
-- replaces the payee — the payee is what the bank said, and matching, duplicate
-- detection, transfer pairing and every rule in the app still read it. The
-- title is what the app SHOWS.
--
-- ## Why it is learned through `rules`, and not a table of its own
--
-- Because it is the same question categorising already asks: *what do we know
-- about this payee?* A rule is keyed on a normalised payee substring with
-- longest-match-wins, which is exactly the shape "call this one Vet insurance"
-- needs, and re-using it means one page to look at, one thing to forget, and
-- one thing to teach. A second table would be a second copy of `normalizePayee`
-- and a second place for the two to disagree.
--
-- ## The one thing that changes shape: `rules.category_id` becomes nullable
--
-- Categories are only ever learned from spending — income is not categorised by
-- payee, and a transfer is neither — but a NAME is worth learning on any row.
-- "FPI SMITH J LTD" is precisely the sort of thing that wants calling "Salary".
-- So a rule may now carry a title and no category.
--
-- A rule with NEITHER is meaningless, and `rules_say_something` refuses it.
--
-- Two consequences on the client, both handled in lib/rules.ts:
--
--   * "the rule that matches" is now two questions — the longest match that
--     carries a category, and the longest that carries a title. Asking once and
--     reading both fields off the answer would let a title-only rule for
--     "tesco petrol" shadow the category rule for "tesco", and the fuel would
--     silently stop being categorised.
--   * `coverageOf` asks the category question, so a title-only rule covers
--     nothing and offers no bulk apply. That is correct rather than a gap:
--     applying a rule rewrites `category_id` and nothing else.
--
-- ## upsert_rule gains an argument, and the old signature is DROPPED
--
-- Deliberately, and it is the trap migration 10 documents: supabase-js drops
-- `undefined` arguments, so leaving the three-argument version beside the
-- four-argument one makes the call ambiguous and every rule write dead-letters
-- with "could not find the function … in the schema cache". Re-running
-- 03-rpc.sql after this file puts the old signature back — `00-which-
-- migrations-applied.sql` has a row that detects exactly that.
--
-- No policy changes. `title` is an ordinary column on `transactions`, so
-- `transactions_update` already decides who may write one, and a published
-- household row carries its title with it because the whole row travels — RLS
-- has no column-level half. Which is worth saying out loud: a name you give a
-- row you have marked as the household's is a name the household reads.

-- ---------- 0. Refuse to install on a database missing what this builds on ----------
--
-- plpgsql bodies are only syntax-checked at creation time, so a migration
-- referencing a missing table installs "successfully" and fails at runtime.

do $$
begin
  if to_regclass('public.rules') is null then
    raise exception 'Run 01-schema.sql first: public.rules does not exist';
  end if;
  if to_regprocedure('public.upsert_rule(uuid,text,uuid)') is null
     and to_regprocedure('public.upsert_rule(uuid,text,uuid,text)') is null then
    raise exception 'Run 03-rpc.sql first: public.upsert_rule does not exist';
  end if;
end $$;

-- ---------- 1. The column ----------

alter table public.transactions
  add column if not exists title text;

alter table public.rules
  add column if not exists title text;

comment on column public.transactions.title is
  'What to call this row on screen. The payee stays exactly as the bank wrote it; everything that matches, pairs or de-duplicates still reads that.';
comment on column public.rules.title is
  'What to call a transaction from this payee. Null = this rule only says where to file it.';

-- A name is a name: one line, and short enough to sit in a table cell without
-- pushing the amount off the end of a phone. Empty is not a name — the client
-- clears the column rather than writing '' — and the constraint says so, so a
-- blank cannot arrive from an older tab and render as a row with no label.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_title_sane') then
    alter table public.transactions add constraint transactions_title_sane
      check (title is null or (length(trim(title)) between 1 and 80 and title !~ '[\n\r]'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rules_title_sane') then
    alter table public.rules add constraint rules_title_sane
      check (title is null or (length(trim(title)) between 1 and 80 and title !~ '[\n\r]'));
  end if;
end $$;

-- ---------- 2. A rule may now be about the name alone ----------

alter table public.rules alter column category_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rules_say_something') then
    alter table public.rules add constraint rules_say_something
      check (category_id is not null or title is not null);
  end if;
end $$;

-- ---------- 3. upsert_rule, with the name ----------
--
-- `rules` is unique on lower(match), an expression index PostgREST cannot
-- express `on conflict` against — which is why this was an RPC in the first
-- place, and why the client's queued payload for this table is the WHOLE row
-- rather than a patch (see RPC_TABLES in outbox.ts). Both fields are therefore
-- authoritative on every call: a null category clears the category, a null
-- title clears the title, and neither can be "left alone" by accident.

drop function if exists public.upsert_rule(uuid, text, uuid);

create or replace function public.upsert_rule(
  p_id uuid,
  p_match text,
  p_category_id uuid,
  p_title text
)
returns public.rules
language plpgsql security definer set search_path = public as $$
declare
  hh uuid := public.my_household();
  r public.rules;
  t text := nullif(btrim(coalesce(p_title, '')), '');
begin
  if hh is null then raise exception 'No household' using errcode = '42501'; end if;
  if p_category_id is null and t is null then
    raise exception 'A rule must say where to file it, what to call it, or both'
      using errcode = '23514';
  end if;

  insert into public.rules (id, household_id, match, category_id, title, created_by)
  values (coalesce(p_id, gen_random_uuid()), hh, trim(p_match), p_category_id, t, (select auth.uid()))
  on conflict (household_id, lower(match)) where deleted_at is null
  do update set category_id = excluded.category_id, title = excluded.title, updated_at = now()
  returning * into r;
  return r;
end $$;

revoke execute on function public.upsert_rule(uuid, text, uuid, text) from anon, public;
grant execute on function public.upsert_rule(uuid, text, uuid, text) to authenticated;
