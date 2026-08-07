-- Hearth — tests for subcategories, monthly budgets, goals and transfers
--
-- Companion to 99-rls-tests.sql, covering what migration 04 added. Same shape:
-- runs in a transaction, rolls back, every row of the output must read ok = true.

begin;

create temp table results (id serial, check_name text, ok boolean, detail text);
grant all on results to authenticated;
grant usage, select on sequence results_id_seq to authenticated;

create function pg_temp.check(name text, condition boolean, detail text default '')
returns void language sql as $$
  insert into results (check_name, ok, detail) values (name, condition, detail)
$$;

create function pg_temp.act_as(u uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u)::text, true);
end $$;

do $$
declare gabi uuid := gen_random_uuid(); partner uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (gabi, 'g2@test.local'), (partner, 'p2@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.partner', partner::text, false);
end $$;

set role authenticated;

-- ---------- fixtures ----------

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; shared_acct uuid; private_acct uuid; home uuid;
begin
  h := public.create_household('Model test');
  perform set_config('test.join_code', h.join_code, false);

  -- Since 07 no account is seeded, so both are created here. 'Joint account' is
  -- made genuinely joint further down, once the partner has somebody to be.
  insert into public.accounts (name, kind) values ('Joint account', 'current')
    returning id into shared_acct;
  insert into public.accounts (name, kind) values ('My cash', 'cash')
    returning id into private_acct;

  select id into home from public.categories where name = 'Home & utilities';

  perform set_config('test.shared_acct', shared_acct::text, false);
  perform set_config('test.private_acct', private_acct::text, false);
  perform set_config('test.home', home::text, false);
end $$;

-- The partner joins up front, because "shared" and "private" are now facts
-- about who holds a grant rather than a column — an account is only private in
-- the sense that matters if there is somebody it is being kept from.
select pg_temp.act_as(current_setting('test.partner')::uuid);
do $$ begin perform public.join_household(current_setting('test.join_code')); end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);
do $$
begin
  perform public.upsert_account_grant(null, current_setting('test.shared_acct')::uuid,
                                      current_setting('test.partner')::uuid, 'owner');
  -- 'My cash' is granted to nobody else, which is what makes it private now.
end $$;

-- ---------- subcategories ----------

do $$
declare home uuid := current_setting('test.home')::uuid; sub uuid; n bigint;
begin
  insert into public.categories (name, parent_id, kind)
  values ('Insurance', home, 'expense') returning id into sub;
  perform set_config('test.sub', sub::text, false);

  perform pg_temp.check('a subcategory can be created under a category', sub is not null);

  -- Style columns left null: the client resolves them from the parent, so a
  -- subcategory follows its parent's colour until someone overrides it.
  select count(*) into n from public.categories where id = sub and icon is null and slot is null;
  perform pg_temp.check('a subcategory inherits style by storing none of its own', n = 1);

  -- One level only. Deeper nesting turns every total into a recursive query and
  -- every screen into a tree, for no benefit anyone asked for.
  begin
    insert into public.categories (name, parent_id, kind) values ('Car insurance', sub, 'expense');
    perform pg_temp.check('nesting a subcategory under a subcategory is refused', false, 'it was allowed');
  exception when others then
    perform pg_temp.check('nesting a subcategory under a subcategory is refused', true);
  end;

  begin
    insert into public.categories (name, parent_id, kind) values ('Odd', home, 'income');
    perform pg_temp.check('a subcategory of a different kind is refused', false, 'it was allowed');
  exception when others then
    perform pg_temp.check('a subcategory of a different kind is refused', true);
  end;

  begin
    insert into public.categories (name, icon, slot, kind) values ('Styleless', null, null, 'expense');
    perform pg_temp.check('a top-level category must carry its own style', false, 'it was allowed');
  exception when others then
    perform pg_temp.check('a top-level category must carry its own style', true);
  end;
end $$;

-- ---------- personal categories ----------

do $$
declare personal uuid;
begin
  insert into public.categories (name, icon, slot, kind, owner_id)
  values ('Therapy', 'health', 4, 'expense', current_setting('test.gabi')::uuid)
  returning id into personal;
  perform set_config('test.personal_cat', personal::text, false);

  -- Allowed: an account nobody else shares.
  insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
  values (current_setting('test.private_acct')::uuid, personal, current_date, 'Clinic', -6000);
  perform pg_temp.check('a personal category works on an account nobody else shares', true);

  -- Refused: the joint account. "Only where nobody else can see it" is enforced
  -- by the database, not the form — the form is not what protects anything.
  begin
    insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
    values (current_setting('test.shared_acct')::uuid, personal, current_date, 'Clinic', -6000);
    perform pg_temp.check('a personal category is refused on an account somebody else holds', false, 'it was allowed');
  exception when others then
    perform pg_temp.check('a personal category is refused on an account somebody else holds', true);
  end;
end $$;

-- ---------- monthly budgets ----------

do $$
declare
  home uuid := current_setting('test.home')::uuid;
  this_month date := date_trunc('month', current_date)::date;
  last_month date := (date_trunc('month', current_date) - interval '1 month')::date;
  n bigint; copied integer; amount bigint;
begin
  perform public.upsert_budget(null, home, false, 45000, last_month);
  perform public.upsert_budget(null, home, false, 40000, this_month);

  select count(*) into n from public.budgets where category_id = home and deleted_at is null;
  -- The whole point of the migration: changing this month's number no longer
  -- destroys last month's.
  perform pg_temp.check('two months of the same budget coexist', n = 2, n::text);

  select amount_minor into amount from public.budgets
   where category_id = home and month = last_month and deleted_at is null;
  perform pg_temp.check('last month keeps its own amount', amount = 45000, amount::text);

  -- Same month twice updates in place rather than duplicating.
  perform public.upsert_budget(null, home, false, 42000, this_month);
  select count(*) into n from public.budgets
   where category_id = home and month = this_month and deleted_at is null;
  perform pg_temp.check('re-budgeting a month updates in place', n = 1, n::text);
end $$;

do $$
declare
  next_month date := (date_trunc('month', current_date) + interval '1 month')::date;
  this_month date := date_trunc('month', current_date)::date;
  copied integer; again integer;
begin
  copied := public.copy_budgets(this_month, next_month);
  perform pg_temp.check('budgets carry forward to a new month', copied >= 1, copied::text);

  -- Running it twice must not double up: the first of the month may well be
  -- reached from two devices.
  again := public.copy_budgets(this_month, next_month);
  perform pg_temp.check('carrying forward twice copies nothing the second time', again = 0, again::text);
end $$;

-- ---------- transfers ----------

do $$
declare
  out_id uuid := gen_random_uuid();
  in_id uuid := gen_random_uuid();
  transfer uuid;
  legs bigint; spend bigint; from_bal bigint; to_bal bigint;
begin
  select balance_minor into from_bal from public.account_balances()
   where account_id = current_setting('test.shared_acct')::uuid;

  transfer := public.create_transfer(
    out_id, in_id,
    current_setting('test.shared_acct')::uuid,
    current_setting('test.private_acct')::uuid,
    25000, current_date, 'Holiday saving', null);

  select count(*) into legs from public.transactions where transfer_id = transfer;
  perform pg_temp.check('a transfer creates two linked legs', legs = 2, legs::text);

  select balance_minor into to_bal from public.account_balances()
   where account_id = current_setting('test.private_acct')::uuid;
  select balance_minor into from_bal from public.account_balances()
   where account_id = current_setting('test.shared_acct')::uuid;
  perform pg_temp.check('the money leaves one account', from_bal = -25000, from_bal::text);
  -- -6000 from the therapy transaction above, +25000 in.
  perform pg_temp.check('and arrives in the other', to_bal = 19000, to_bal::text);

  -- Replaying the same call must not move the money twice.
  perform public.create_transfer(
    out_id, in_id,
    current_setting('test.shared_acct')::uuid,
    current_setting('test.private_acct')::uuid,
    25000, current_date, 'Holiday saving', null);
  select count(*) into legs from public.transactions
   where id in (out_id, in_id);
  perform pg_temp.check('replaying a transfer does not move the money twice', legs = 2, legs::text);

  begin
    perform public.create_transfer(gen_random_uuid(), gen_random_uuid(),
      current_setting('test.shared_acct')::uuid, current_setting('test.shared_acct')::uuid,
      100, current_date, null, null);
    perform pg_temp.check('a transfer to the same account is refused', false, 'it was allowed');
  exception when others then
    perform pg_temp.check('a transfer to the same account is refused', true);
  end;
end $$;

-- ---------- goals ----------

do $$
declare household_goal uuid; personal_goal uuid;
begin
  insert into public.goals (name, target_minor, target_date)
  values ('Holiday', 240000, current_date + 180) returning id into household_goal;

  insert into public.goals (name, target_minor, owner_id)
  values ('New bike', 90000, current_setting('test.gabi')::uuid) returning id into personal_goal;

  perform set_config('test.goal', household_goal::text, false);
  perform pg_temp.check('a goal can be created', household_goal is not null);
end $$;

-- ---------- what the partner sees ----------

select pg_temp.act_as(current_setting('test.partner')::uuid);

do $$
declare n bigint;
begin
  perform pg_temp.check('the partner cannot see a personal category',
    not exists (select 1 from public.categories where name = 'Therapy'), '');

  perform pg_temp.check('the partner can see a shared subcategory',
    exists (select 1 from public.categories where name = 'Insurance'), '');

  select count(*) into n from public.goals;
  perform pg_temp.check('the partner sees the household goal but not the personal one', n = 1, n::text);
  perform pg_temp.check('the partner cannot see a personal goal',
    not exists (select 1 from public.goals where name = 'New bike'), '');

  -- The transfer's incoming leg landed in an account they hold no grant on, so
  -- only one half of it should be visible.
  select count(*) into n from public.transactions where transfer_id is not null;
  perform pg_temp.check('the partner sees only the leg on an account they can read', n = 1, n::text);

  begin
    insert into public.goals (name, target_minor, owner_id)
    values ('Sneaky', 1000, current_setting('test.gabi')::uuid);
    perform pg_temp.check('the partner cannot create a goal in someone else''s name', false, 'it was allowed');
  exception when others then
    perform pg_temp.check('the partner cannot create a goal in someone else''s name', true);
  end;
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
