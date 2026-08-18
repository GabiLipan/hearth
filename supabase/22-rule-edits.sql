-- Hearth — migration 22: let a rule's CONDITIONS be edited
--
-- ## The bug
--
-- Every write to `rules` goes through `upsert_rule`, and since migration 03
-- that function has been one statement:
--
--     insert into public.rules (id, …) values (coalesce(p_id, gen_random_uuid()), …)
--     on conflict (household_id, lower(match), …) where deleted_at is null
--     do update set …
--
-- `on conflict` names exactly one arbiter, and the arbiter it names is the
-- condition set. So the statement resolves the case it was written for — two
-- devices learning the same payee — and does not resolve the other way a row
-- can already be there: under the same PRIMARY KEY.
--
-- The client sends `p_id = e.rowId`, which on an edit is the id of the rule
-- being edited (see RPC_WRITERS in outbox.ts). Then:
--
-- * Edit only the category or the name → the condition set is unchanged, the
--   insert conflicts on the condition index, `do update` runs. Works.
-- * Edit the payee, an amount bound, or the account → the new condition set
--   collides with nothing, so no conflict is detected — but `id` is already in
--   the table, and the insert dies on `rules_pkey`.
--
-- Which is to say: **editing what a rule MATCHES has never worked.** Before
-- migration 21 the condition set was just the payee, so it was one field; 21
-- added the amount and the account and made it three. It fails as a dead letter
-- in Settings minutes later, reading `duplicate key value violates unique
-- constraint "rules_pkey"`, and it cannot be retried — "Try again" re-sends the
-- same doomed insert, which is exactly what the dead-letter note in the app
-- warns about.
--
-- ## The fix
--
-- Look before inserting, which is the shape `upsert_budget` has always had: if
-- the id is already a live rule of ours, UPDATE it in place; only otherwise
-- insert and fold onto an identical condition set. An edit is then an edit.
--
-- Two edges the update introduces, both handled below rather than left to the
-- constraint:
--
-- * **Editing a rule onto another live rule's exact condition set.** Two rules
--   would be the same question with two answers, which `rules_condition_unique`
--   refuses. Folded rather than refused: the row being edited is the one the
--   person is looking at, so it keeps its id — which is also the id in their
--   cache, so nothing has to be re-learned — and the other is tombstoned. A
--   refusal here would be a dead letter for something the person asked for
--   deliberately.
-- * **Editing a rule the other device has deleted.** Left as a refusal, because
--   reviving it would quietly undo their delete, but with a sentence instead of
--   a constraint name — that is the one case where the note in Settings is
--   telling the truth and discarding really is the way out.
--
-- No schema changes, no policy changes. `create or replace` over the same
-- seven-argument signature, so unlike 20 and 21 this file adds no new overload
-- and re-running it is free.

-- ---------- 0. Refuse to install on a database missing what this builds on ----------
--
-- plpgsql bodies are only syntax-checked at creation time, so a migration
-- referencing a missing column installs "successfully" and fails at runtime.

do $$
begin
  if to_regclass('public.rules') is null then
    raise exception 'Run 01-schema.sql first: public.rules does not exist';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'rules' and column_name = 'amount_min_minor'
  ) then
    raise exception 'Run 21-rule-conditions.sql first: public.rules.amount_min_minor does not exist';
  end if;
end $$;

-- ---------- 1. The older signatures, again ----------
--
-- Belt and braces. This file does not create a new overload, but it is the
-- newest of the three that define `upsert_rule`, so it is the right place to
-- clear an older one that a re-run of 03 or 20 has put back: supabase-js drops
-- `undefined` arguments, an ambiguous call resolves to neither, and every rule
-- write dead-letters with "could not find the function … in the schema cache".

drop function if exists public.upsert_rule(uuid, text, uuid);
drop function if exists public.upsert_rule(uuid, text, uuid, text);

-- ---------- 2. upsert_rule, where an edit is an edit ----------

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
  m text := trim(p_match);
  lo bigint := p_amount_min_minor;
  hi bigint := p_amount_max_minor;
  -- The sentinel the unique index uses for "no account", so the duplicate
  -- search below asks the index's own question rather than a similar one.
  nil uuid := '00000000-0000-0000-0000-000000000000';
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

  if p_id is not null then
    -- Deleted on another device, and being edited on this one. Refused, because
    -- reviving it would undo their delete silently — but said in words, since
    -- the constraint name this used to produce told nobody anything.
    if exists (
      select 1 from public.rules
      where id = p_id and household_id = hh and deleted_at is not null
    ) then
      raise exception 'That rule was deleted on another device'
        using errcode = 'P0002';
    end if;

    if exists (
      select 1 from public.rules
      where id = p_id and household_id = hh and deleted_at is null
    ) then
      -- Fold a rule that already asks this exact question. See the note above:
      -- the edited row keeps its id, the duplicate goes.
      update public.rules set deleted_at = now(), updated_at = now()
      where household_id = hh
        and id <> p_id
        and deleted_at is null
        and lower(match) = lower(m)
        and coalesce(amount_min_minor, -1) = coalesce(lo, -1)
        and coalesce(amount_max_minor, -1) = coalesce(hi, -1)
        and coalesce(account_id, nil) = coalesce(p_account_id, nil);

      update public.rules set
        match = m,
        category_id = p_category_id,
        title = t,
        amount_min_minor = lo,
        amount_max_minor = hi,
        account_id = p_account_id,
        updated_at = now()
      where id = p_id and household_id = hh and deleted_at is null
      returning * into r;
      return r;
    end if;
  end if;

  -- New to us. The conflict target stays the condition set, which is the case
  -- this statement has always existed for: both devices learning one payee.
  insert into public.rules (
    id, household_id, match, category_id, title,
    amount_min_minor, amount_max_minor, account_id, created_by
  )
  values (
    coalesce(p_id, gen_random_uuid()), hh, m, p_category_id, t,
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
