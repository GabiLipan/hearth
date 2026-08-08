-- Hearth — getting an account back (11 of 11)
--
-- A MIGRATION. Run once, after 10-goal-transfers.sql. Safe to re-run.
--
-- What was missing
-- ----------------
-- Two ways to lose an account, neither of which had a way back inside the app.
--
-- 1. DELETING ONE. `delete_account()` soft-deletes the account, its
--    transactions and its bills, and unhooks any goal pointing at it. Every
--    row is still there — `deleted_at` is set, nothing is dropped — but there
--    was no function to unset it, so the only recovery was the SQL editor. For
--    a shared finance app that is a bad shape: the account vanishes for BOTH
--    people the moment one of them presses delete, and the other may not even
--    know it happened.
--
-- 2. LOSING THE LAST OWNER. Ownership lives in `account_grants`, and
--    `depart_household()` revokes the grants of whoever leaves. An account
--    co-owned by two people who have both gone — or one whose owner removed
--    their own access, which the app warns about but permits — ends up visible
--    to nobody who can administer it. `dev-repair-accounts.sql` fixes this by
--    hand; a household admin should not need the SQL editor.
--
--   1. restore_account   — undo a soft delete, with everything it took down
--   2. deleted_accounts  — what is in the bin, so the client can offer it
--   3. claim_account     — an admin takes ownership of an ownerless account
--   4. unowned_accounts  — which ones those are, since nothing else can see them
--
-- All four are `security definer`, so each restates the predicates the
-- policies would have applied. That is the lesson 05 exists to record.

-- ============================================================
-- 0. Refuse to install against a schema missing 07
-- ============================================================

do $$
begin
  if to_regprocedure('public.my_account_ids(public.access_level)') is null
     or to_regclass('public.household_members') is null then
    raise exception
      'Run 07-permissions.sql first: this migration authorises against my_account_ids() and household_members'
      using errcode = '42883';
  end if;
end $$;

-- ============================================================
-- 1. Undo a delete
-- ============================================================
--
-- Symmetric with `delete_account()` and deliberately written to mirror it line
-- for line, because the two have to agree about what "the account and
-- everything on it" means. It restores what that function took down and
-- nothing else:
--
--   the account, its transactions, its bills
--
-- and NOT the goals it unhooked. `delete_account` sets `goals.account_id =
-- null`, which loses the association without recording it, so there is nothing
-- to put back — the goal kept its name and target and simply stopped naming an
-- account. Re-pointing it would be a guess.
--
-- Nor the `bill_postings` it hard-deleted: those rows are gone, which means a
-- restored bill has forgotten which occurrences were paid and will offer them
-- again. That is recoverable by hand (the payments themselves are back) and is
-- the honest consequence of `delete_account` having dropped them outright.
--
-- Authorised by the same grant as deleting. Grants outlive the accounts they
-- point at — `delete_account` deliberately leaves them alone — so an owner can
-- still be recognised after the account is gone, which is exactly what makes
-- this possible at all.
create or replace function public.restore_account(p_account_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  a public.accounts;
  n integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into a from public.accounts
   where id = p_account_id and deleted_at is not null
   for update;

  -- Same message for "not yours" and "not there", for the same reason
  -- delete_account gives one: distinguishing them confirms the existence of an
  -- account the caller cannot see.
  if a.id is null or a.id not in (select public.my_account_ids('owner')) then
    raise exception 'That account is not yours to restore' using errcode = '42501';
  end if;

  -- Only what THIS delete took down. A transaction deleted on its own, before
  -- the account went, stays deleted — restoring the account is not an undo of
  -- every edit anybody ever made to it. The window is generous because
  -- `delete_account` stamps each table in its own statement and
  -- `clock_timestamp()` advances between them.
  update public.transactions set deleted_at = null
   where account_id = a.id
     and deleted_at is not null
     and deleted_at >= a.deleted_at - interval '1 minute';
  get diagnostics n = row_count;

  update public.bills set deleted_at = null
   where account_id = a.id
     and deleted_at is not null
     and deleted_at >= a.deleted_at - interval '1 minute';

  update public.accounts set deleted_at = null where id = a.id;

  -- The account becoming visible again is a change to who-can-see-what that
  -- emits no realtime event on the other device: it is an UPDATE to a row that
  -- device has already discarded. The epoch is the only signal.
  perform public.bump_epoch(a.household_id);

  return n;
end $$;

comment on function public.restore_account(uuid) is
  'Undo delete_account(). Restores the account, its transactions and its bills; goals it unhooked are not re-pointed.';

-- ============================================================
-- 2. What is in the bin
-- ============================================================
--
-- A function rather than a policy change. `accounts_select` deliberately hides
-- deleted rows from the ordinary read path — the client cache holds live rows
-- only, and widening the policy would put tombstones into every pull. This
-- answers one narrow question instead: what could I put back?
--
-- Owner level only, matching `restore_account`. Anything the caller could not
-- restore is not listed, so the screen cannot offer a button that fails.
create or replace function public.deleted_accounts()
returns table (
  id uuid,
  name text,
  kind text,
  deleted_at timestamptz,
  transaction_count bigint
)
language sql stable security definer set search_path = public as $$
  select a.id,
         a.name,
         a.kind::text,
         a.deleted_at,
         (select count(*) from public.transactions t
           where t.account_id = a.id
             and t.deleted_at is not null
             and t.deleted_at >= a.deleted_at - interval '1 minute')
    from public.accounts a
   where a.deleted_at is not null
     and a.id in (select public.my_account_ids('owner'))
   order by a.deleted_at desc
$$;

-- ============================================================
-- 3. An account nobody owns
-- ============================================================
--
-- The one function here that grants access rather than restoring it, so it is
-- the one to be careful with. Three conditions, all required:
--
--   - the caller is an admin of the household the account belongs to;
--   - the account is live;
--   - NOBODY currently holds an `owner` grant on it.
--
-- That last one is what stops this being a back door. An admin manages people
-- and nothing else — `my_account_ids()` must never consult
-- `is_household_admin()`, which is why this is a separate, explicit function
-- rather than a widening of the permission model. An admin cannot use it to
-- reach into an account somebody else owns, because the moment somebody owns
-- it, this refuses.
--
-- It does not confer sight of the past. The caller gets an `owner` grant from
-- now on, which is what `account_grants` means; there is no retrospective
-- claim, and the other people on the account keep the grants they had.
create or replace function public.claim_account(p_account_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  a public.accounts;
  uid uuid := (select auth.uid());
  hh uuid := public.my_household();
begin
  if uid is null or hh is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not public.is_household_admin() then
    raise exception 'Only a household admin can claim an account' using errcode = '42501';
  end if;

  select * into a from public.accounts
   where id = p_account_id and household_id = hh and deleted_at is null
   for update;
  if a.id is null then
    raise exception 'Unknown account' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.account_grants g
     where g.account_id = a.id and g.deleted_at is null and g.level = 'owner'
  ) then
    raise exception 'That account already has an owner' using errcode = '42501';
  end if;

  -- Reuse the caller's existing grant if they have one at a lower level, so the
  -- `(account_id, user_id)` unique index is never fought with.
  insert into public.account_grants (account_id, user_id, level)
  values (a.id, uid, 'owner')
  on conflict (account_id, user_id) where deleted_at is null
  do update set level = 'owner';

  -- Somebody can now see rows they could not a moment ago.
  perform public.bump_epoch(hh);

  return a.id;
end $$;

comment on function public.claim_account(uuid) is
  'A household admin takes ownership of an account nobody owns. Refuses the moment anybody holds an owner grant.';

-- ============================================================
-- 3b. Finding one
-- ============================================================
--
-- Without this, `claim_account` is unreachable. An ownerless account is
-- ownerless because its grants are gone, and `accounts_select` needs a grant —
-- so the account is invisible to every client, including the admin who is
-- entitled to claim it. There is nothing to press.
--
-- Admin-only and household-scoped, and it returns names and nothing else: no
-- balance, no transactions, no hint of what is on it. Being able to give an
-- account an owner is not being able to read it, and this must not become a
-- way to see inside one before deciding to.
create or replace function public.unowned_accounts()
returns table (id uuid, name text, kind text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select a.id, a.name, a.kind::text, a.created_at
    from public.accounts a
   where a.household_id = public.my_household()
     and a.deleted_at is null
     and public.is_household_admin()
     and not exists (
       select 1 from public.account_grants g
        where g.account_id = a.id and g.deleted_at is null and g.level = 'owner'
     )
   order by a.created_at
$$;

-- ============================================================
-- 4. Grants
-- ============================================================

do $$
declare f text;
begin
  foreach f in array array[
    'restore_account(uuid)',
    'deleted_accounts()',
    'claim_account(uuid)',
    'unowned_accounts()'
  ] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
