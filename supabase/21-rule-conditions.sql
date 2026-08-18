-- Hearth — a rule that can say more than "the payee contains" (21 of 21)
--
-- A MIGRATION. Run once, after 20-transaction-titles.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- A rule matched on one thing: a normalised substring of the payee. That is
-- exactly right for "pets at home → Pets", and it cannot express the case that
-- broke it — two subscriptions from the same vendor, £8.99 and £12.99, which
-- arrive on the statement as the same string and are two different things.
-- Filing one filed both, and naming one named both.
--
-- The obvious fix — match on the amount too — is wrong as a blanket rule,
-- because an energy bill from the same vendor is a different amount every
-- month and matching it on price would file nothing at all. So the amount has
-- to be something a rule OPTS IN to, per rule, and the same goes for the
-- account: the same card number billed to two accounts is two rules' worth of
-- difference in some households and noise in most.
--
-- Hence three columns and no new tables. A rule is still a payee substring; it
-- may now ALSO require an amount, a range of amounts, or a particular account.
--
-- ## The amount is stored as a MAGNITUDE
--
-- `transactions.amount_minor` is negative for spending, and nobody thinks of a
-- subscription as costing minus eight ninety-nine. Both bounds are therefore
-- non-negative and compared against `abs(amount_minor)` — see `ruleMatches` in
-- lib/rules.ts, which does the same on the client. A rule cannot distinguish a
-- £30 refund from a £30 charge, which is deliberate: the direction of a row is
-- already what decides whether a category is applied at all
-- (`recategorisable`), and giving a rule a second, contradictable opinion about
-- it is a way to make two screens disagree.
--
-- ## The uniqueness rule had to grow with it
--
-- `rules_match_unique` is `(household_id, lower(match))`, which is the whole
-- reason writing a rule is an RPC: an expression index is not something
-- PostgREST can name in `on conflict`. Two rules for "vendor a" at different
-- prices is now the POINT of the feature, so that index would refuse the second
-- one — the feature and the constraint cannot both stand.
--
-- The replacement keys on the whole condition set. Note the `coalesce`s: nulls
-- are distinct by default in a unique index, so without them two rules that
-- both say "vendor a, any amount, any account" would not collide, and learning
-- the same payee on two devices during a shared import — routine rather than
-- exotic — would quietly make two rules where there was one. The sentinels are
-- outside anything an amount can be, and the zero uuid is not an account.
--
-- ## An account you cannot see is not an account you may key a rule on
--
-- `rules` is household-scoped and readable by everybody in the household, while
-- an ACCOUNT is authorised by a grant and by nothing else (migration 07). So
-- `upsert_rule` checks `p_account_id` against `my_account_ids('view')` rather
-- than against the household — otherwise a rule would be a way to confirm that
-- a particular account id exists on a household member's device. It is the same
-- discipline every definer function here follows: restate the predicate the
-- policies would have applied, because `security definer` switches them off.
--
-- ## upsert_rule gains three arguments, and the old signature is DROPPED
--
-- The trap migrations 10 and 20 both document: supabase-js drops `undefined`
-- arguments, so leaving the four-argument version beside the seven-argument one
-- makes the call ambiguous and every rule write dead-letters with "could not
-- find the function … in the schema cache". Re-running 03-rpc.sql OR
-- 20-transaction-titles.sql after this file puts an older signature back —
-- `00-which-migrations-applied.sql` has a row that detects exactly that.
--
-- No policy changes. The three columns are ordinary columns on a table whose
-- policies are already household-scoped.

-- ---------- 0. Refuse to install on a database missing what this builds on ----------
--
-- plpgsql bodies are only syntax-checked at creation time, so a migration
-- referencing a missing table installs "successfully" and fails at runtime.

do $$
begin
  if to_regclass('public.rules') is null then
    raise exception 'Run 01-schema.sql first: public.rules does not exist';
  end if;
  if to_regclass('public.accounts') is null then
    raise exception 'Run 01-schema.sql first: public.accounts does not exist';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'rules' and column_name = 'title'
  ) then
    raise exception 'Run 20-transaction-titles.sql first: public.rules.title does not exist';
  end if;
end $$;

-- ---------- 1. The columns ----------

alter table public.rules
  add column if not exists amount_min_minor bigint,
  add column if not exists amount_max_minor bigint,
  add column if not exists account_id uuid references public.accounts(id) on delete cascade;

comment on column public.rules.amount_min_minor is
  'Smallest magnitude this rule matches, in minor units. Null = any. Compared against abs(transactions.amount_minor), so it is never negative.';
comment on column public.rules.amount_max_minor is
  'Largest magnitude this rule matches, in minor units. Null = any. Equal to the minimum for an exact amount.';
comment on column public.rules.account_id is
  'Restricts the rule to one account. Null = any account. Cascades on delete: a rule keyed on an account that no longer exists would match nothing for ever.';

-- A magnitude, and an interval the right way round. Both checked here rather
-- than only in the RPC, because a check constraint is the thing that still
-- holds when somebody fixes a row by hand in the SQL editor.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rules_amount_sane') then
    alter table public.rules add constraint rules_amount_sane check (
      (amount_min_minor is null or amount_min_minor >= 0)
      and (amount_max_minor is null or amount_max_minor >= 0)
      and (amount_min_minor is null or amount_max_minor is null or amount_max_minor >= amount_min_minor)
    );
  end if;
end $$;

-- ---------- 2. Uniqueness over the whole condition set ----------

drop index if exists public.rules_match_unique;

create unique index if not exists rules_condition_unique
  on public.rules (
    household_id,
    lower(match),
    coalesce(amount_min_minor, -1),
    coalesce(amount_max_minor, -1),
    coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where deleted_at is null;

-- ---------- 3. upsert_rule, with the conditions ----------
--
-- Both content fields stay authoritative on every call — a null category
-- clears the category, a null title clears the title — which is why the
-- client's queued payload for this table is the WHOLE row rather than a patch
-- (see RPC_TABLES in outbox.ts). The three conditions behave the same way.

drop function if exists public.upsert_rule(uuid, text, uuid);
drop function if exists public.upsert_rule(uuid, text, uuid, text);

create or replace function public.upsert_rule(
  p_id uuid,
  p_match text,
  p_category_id uuid,
  p_title text,
  p_amount_min_minor bigint,
  p_amount_max_minor bigint,
  p_account_id uuid
)
returns public.rules
language plpgsql security definer set search_path = public as $$
declare
  hh uuid := public.my_household();
  r public.rules;
  t text := nullif(btrim(coalesce(p_title, '')), '');
  lo bigint := p_amount_min_minor;
  hi bigint := p_amount_max_minor;
begin
  if hh is null then raise exception 'No household' using errcode = '42501'; end if;
  if p_category_id is null and t is null then
    raise exception 'A rule must say where to file it, what to call it, or both'
      using errcode = '23514';
  end if;

  -- Magnitudes, and the right way round. Corrected rather than refused: the
  -- two bounds arrive from two fields in one form, and a moment where the
  -- larger has been typed and the smaller has not is an ordinary keystroke,
  -- not an error worth dead-lettering minutes later in Settings.
  if lo is not null then lo := abs(lo); end if;
  if hi is not null then hi := abs(hi); end if;
  if lo is not null and hi is not null and hi < lo then
    select lo, hi into hi, lo;
  end if;

  -- An account is authorised by a grant and by nothing else, and this function
  -- is `security definer`, so the policies that would have said so are switched
  -- off. Restating it: you may key a rule on an account you can see.
  if p_account_id is not null and not exists (
    select 1 from public.my_account_ids('view') a(id) where a.id = p_account_id
  ) then
    raise exception 'No such account' using errcode = '42501';
  end if;

  insert into public.rules (
    id, household_id, match, category_id, title,
    amount_min_minor, amount_max_minor, account_id, created_by
  )
  values (
    coalesce(p_id, gen_random_uuid()), hh, trim(p_match), p_category_id, t,
    lo, hi, p_account_id, (select auth.uid())
  )
  on conflict (
    household_id,
    lower(match),
    coalesce(amount_min_minor, -1),
    coalesce(amount_max_minor, -1),
    coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where deleted_at is null
  do update set category_id = excluded.category_id, title = excluded.title, updated_at = now()
  returning * into r;
  return r;
end $$;

revoke execute on function public.upsert_rule(uuid, text, uuid, text, bigint, bigint, uuid) from anon, public;
grant execute on function public.upsert_rule(uuid, text, uuid, text, bigint, bigint, uuid) to authenticated;
