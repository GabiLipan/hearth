-- Hearth — row level security (2 of 4)
--
-- Every policy writes `(select auth.uid())` rather than a bare `auth.uid()`.
-- The scalar subquery is hoisted to an InitPlan and evaluated once per query;
-- a bare call is re-evaluated per row, which on `transactions` is the
-- difference between a fast full pull and a slow one.
--
-- Visibility rules this file encodes:
--   accounts     — hidden when 'private' and not yours
--   transactions — visible only on accounts that are 'shared' or yours, so a
--                  'balance' account's line items stay hidden from a partner
--                  while the account row itself does not
--   budgets      — a budget with an owner is that person's alone
--   everything   — scoped to your one household

alter table public.households    enable row level security;
alter table public.profiles      enable row level security;
alter table public.categories    enable row level security;
alter table public.accounts      enable row level security;
alter table public.bills         enable row level security;
alter table public.transactions  enable row level security;
alter table public.bill_postings enable row level security;
alter table public.budgets       enable row level security;
alter table public.rules         enable row level security;

-- ---------- households ----------
-- Read-only to members; every mutation goes through an RPC in 03-rpc.sql.

create policy households_select on public.households
  for select to authenticated
  using (id = (select public.my_household()));

-- ---------- profiles ----------
-- You can always see yourself, and you can see your household-mate (the app
-- shows who recorded a transaction). `household_id` is changed only by the
-- join/leave RPCs, so it is excluded from what a client may write.

create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or (household_id is not null and household_id = (select public.my_household()))
  );

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()) and household_id is not distinct from (select public.my_household()));

-- ---------- categories ----------

create policy categories_select on public.categories
  for select to authenticated
  using (household_id = (select public.my_household()));

create policy categories_insert on public.categories
  for insert to authenticated
  with check (household_id = (select public.my_household()));

create policy categories_update on public.categories
  for update to authenticated
  using (household_id = (select public.my_household()))
  with check (household_id = (select public.my_household()));

-- ---------- accounts ----------

create policy accounts_select on public.accounts
  for select to authenticated
  using (
    household_id = (select public.my_household())
    and (visibility <> 'private' or owner_id = (select auth.uid()))
  );

create policy accounts_insert on public.accounts
  for insert to authenticated
  with check (
    household_id = (select public.my_household())
    -- You cannot create an account that is private to someone else.
    and (visibility = 'shared' or owner_id = (select auth.uid()))
  );

-- Only the owner may re-tier or rename a non-shared account; a shared account
-- is fair game for either of you.
create policy accounts_update on public.accounts
  for update to authenticated
  using (
    household_id = (select public.my_household())
    and (visibility = 'shared' or owner_id = (select auth.uid()))
  )
  with check (
    household_id = (select public.my_household())
    and (visibility = 'shared' or owner_id = (select auth.uid()))
  );

-- ---------- transactions ----------
-- `my_txn_account_ids()` is a security-definer set-returning function, so the
-- planner evaluates it once as a hashed SubPlan rather than probing the
-- accounts policy per row.

create policy transactions_select on public.transactions
  for select to authenticated
  using (
    household_id = (select public.my_household())
    and account_id in (select public.my_txn_account_ids())
  );

create policy transactions_insert on public.transactions
  for insert to authenticated
  with check (
    household_id = (select public.my_household())
    and account_id in (select public.my_txn_account_ids())
  );

create policy transactions_update on public.transactions
  for update to authenticated
  using (
    household_id = (select public.my_household())
    and account_id in (select public.my_txn_account_ids())
  )
  with check (
    household_id = (select public.my_household())
    and account_id in (select public.my_txn_account_ids())
  );

-- ---------- bills ----------
-- A bill names a payee, so it follows its account's transaction visibility.

create policy bills_select on public.bills
  for select to authenticated
  using (
    household_id = (select public.my_household())
    and account_id in (select public.my_txn_account_ids())
  );

create policy bills_insert on public.bills
  for insert to authenticated
  with check (
    household_id = (select public.my_household())
    and account_id in (select public.my_txn_account_ids())
  );

create policy bills_update on public.bills
  for update to authenticated
  using (
    household_id = (select public.my_household())
    and account_id in (select public.my_txn_account_ids())
  )
  with check (
    household_id = (select public.my_household())
    and account_id in (select public.my_txn_account_ids())
  );

-- ---------- bill_postings ----------
-- Written only by post_due_bills(); readable so a client can tell which
-- occurrences are already recorded.

create policy bill_postings_select on public.bill_postings
  for select to authenticated
  using (
    household_id = (select public.my_household())
    and bill_id in (select id from public.bills)
  );

-- ---------- budgets ----------
-- A personal budget is private to its owner.

create policy budgets_select on public.budgets
  for select to authenticated
  using (
    household_id = (select public.my_household())
    and (owner_id is null or owner_id = (select auth.uid()))
  );

create policy budgets_insert on public.budgets
  for insert to authenticated
  with check (
    household_id = (select public.my_household())
    -- You cannot set a budget on your partner's behalf.
    and (owner_id is null or owner_id = (select auth.uid()))
  );

create policy budgets_update on public.budgets
  for update to authenticated
  using (
    household_id = (select public.my_household())
    and (owner_id is null or owner_id = (select auth.uid()))
  )
  with check (
    household_id = (select public.my_household())
    and (owner_id is null or owner_id = (select auth.uid()))
  );

-- ---------- rules ----------

create policy rules_select on public.rules
  for select to authenticated
  using (household_id = (select public.my_household()));

create policy rules_insert on public.rules
  for insert to authenticated
  with check (household_id = (select public.my_household()));

create policy rules_update on public.rules
  for update to authenticated
  using (household_id = (select public.my_household()))
  with check (household_id = (select public.my_household()));

-- ---------- no DELETE policies, anywhere ----------
--
-- Deletion is `set deleted_at = now()`, which is an UPDATE. A hard DELETE would
-- vanish without trace: the other device's cache would keep the row forever
-- because there is nothing left to replicate. Omitting the policy makes that
-- physically impossible rather than merely discouraged.

-- ---------- function grants ----------

revoke execute on function public.my_household()        from anon, public;
revoke execute on function public.my_txn_account_ids()  from anon, public;
revoke execute on function public.bump_epoch(uuid)      from anon, public, authenticated;

grant execute on function public.my_household()       to authenticated;
grant execute on function public.my_txn_account_ids() to authenticated;
