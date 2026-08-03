-- Hearth — tests for ownership boundaries on destructive operations
--
-- Companion to 99-rls-tests.sql and 99b-model-tests.sql, covering migration 05.
-- Same shape: runs in a transaction, rolls back, every row of the output must
-- read ok = true.
--
-- These matter more than most. The functions under test are `security definer`,
-- so RLS is switched off inside them and nothing but the predicates written in
-- their bodies stands between one person and the other's private accounts. A
-- mistake here does not raise an error — it silently deletes somebody's money.

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

-- Read past RLS, to assert what is REALLY still in the table.
--
-- `security definer` is the load-bearing word: it runs as the role that created
-- this function, which is not subject to the policies. Counting these rows as a
-- signed-in user would assert that the POLICY hides the partner's account, which
-- is 99-rls-tests.sql's job and is true either way — it would pass just as
-- happily if wipe_household() had deleted the row outright.
create function pg_temp.live(tbl text, pred text)
returns bigint language plpgsql security definer as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I where deleted_at is null and %s', tbl, pred) into n;
  return n;
end $$;

do $$
declare gabi uuid := gen_random_uuid(); partner uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (gabi, 'g3@test.local'), (partner, 'p3@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.partner', partner::text, false);
end $$;

set role authenticated;

-- ---------- a household with something private in it on each side ----------

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; joint uuid; g_private uuid; g_cat uuid; groceries uuid; home uuid;
begin
  h := public.create_household('Wipe test');
  perform set_config('test.join_code', h.join_code, false);
  perform set_config('test.household', h.id::text, false);

  select id into joint from public.accounts where name = 'Joint account';
  select id into groceries from public.categories where name = 'Groceries';
  select id into home from public.categories where name = 'Home & utilities';
  perform set_config('test.joint', joint::text, false);
  perform set_config('test.groceries', groceries::text, false);
  perform set_config('test.home', home::text, false);

  insert into public.accounts (name, kind, visibility)
  values ('Gabi cash', 'cash', 'private') returning id into g_private;
  perform set_config('test.g_private', g_private::text, false);

  insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
  values (joint, groceries, current_date, 'Tesco', -1000),
         (g_private, groceries, current_date, 'Gift', -2000);

  insert into public.categories (name, icon, slot, kind, owner_id)
  values ('Gabi therapy', 'health', 4, 'expense', current_setting('test.gabi')::uuid)
  returning id into g_cat;

  perform public.upsert_budget(null, groceries, true, 5000, current_date);
  insert into public.goals (name, target_minor, owner_id)
  values ('Gabi bike', 90000, current_setting('test.gabi')::uuid);
end $$;

select pg_temp.act_as(current_setting('test.partner')::uuid);

do $$
declare p_private uuid; p_balance uuid; p_sub uuid;
begin
  perform public.join_household(current_setting('test.join_code'));

  insert into public.accounts (name, kind, visibility)
  values ('Partner stash', 'cash', 'private') returning id into p_private;
  insert into public.accounts (name, kind, visibility)
  values ('Partner ISA', 'savings', 'balance') returning id into p_balance;
  perform set_config('test.p_private', p_private::text, false);
  perform set_config('test.p_balance', p_balance::text, false);

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (p_private,  current_date, 'Present for Gabi', -12000),
         (p_balance,  current_date, 'Payday',            50000);

  -- A personal SUBCATEGORY of a household category, which the wipe is about to
  -- tombstone out from under it.
  insert into public.categories (name, parent_id, kind, owner_id)
  values ('Partner meds', current_setting('test.home')::uuid, 'expense',
          current_setting('test.partner')::uuid)
  returning id into p_sub;
  perform set_config('test.p_sub', p_sub::text, false);

  perform public.upsert_budget(null, current_setting('test.groceries')::uuid, true, 7700, current_date);
  insert into public.goals (name, target_minor, owner_id)
  values ('Partner guitar', 120000, current_setting('test.partner')::uuid);
end $$;

-- ---------- Gabi erases everything ----------

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
begin
  perform public.wipe_household();
end $$;

-- THE regression. Every one of these was destroyed before migration 05.

do $$
declare n bigint;
begin
  perform pg_temp.check('a wipe leaves the partner''s private account alone',
    pg_temp.live('accounts', format('id = %L', current_setting('test.p_private'))) = 1);

  perform pg_temp.check('a wipe leaves the partner''s balance-only account alone',
    pg_temp.live('accounts', format('id = %L', current_setting('test.p_balance'))) = 1);

  n := pg_temp.live('transactions',
    format('account_id in (%L, %L)', current_setting('test.p_private'), current_setting('test.p_balance')));
  perform pg_temp.check('a wipe leaves the transactions on them alone', n = 2, n::text);

  perform pg_temp.check('a wipe leaves the partner''s personal budget alone',
    pg_temp.live('budgets', format('owner_id = %L', current_setting('test.partner'))) = 1);

  perform pg_temp.check('a wipe leaves the partner''s personal goal alone',
    pg_temp.live('goals', format('owner_id = %L', current_setting('test.partner'))) = 1);

  perform pg_temp.check('a wipe leaves the partner''s personal category alone',
    pg_temp.live('categories', format('id = %L', current_setting('test.p_sub'))) = 1);

  -- ...and it is still usable: orphaned under a tombstoned parent it would
  -- disappear from every picker on their device, which is the same loss by a
  -- slower route.
  perform pg_temp.check('the partner''s personal subcategory is promoted, not orphaned',
    pg_temp.live('categories',
      format('id = %L and parent_id is null and icon is not null and slot is not null',
             current_setting('test.p_sub'))) = 1);
end $$;

-- The half that must still happen: shared data and the caller's own data go.

do $$
declare n bigint;
begin
  perform pg_temp.check('a wipe removes the caller''s own private account',
    pg_temp.live('accounts', format('id = %L', current_setting('test.g_private'))) = 0);

  perform pg_temp.check('a wipe removes the shared account',
    pg_temp.live('accounts', format('id = %L', current_setting('test.joint'))) = 0);

  n := pg_temp.live('transactions',
    format('account_id in (%L, %L)', current_setting('test.joint'), current_setting('test.g_private')));
  perform pg_temp.check('a wipe removes the transactions on both of them', n = 0, n::text);

  perform pg_temp.check('a wipe removes the caller''s personal budget',
    pg_temp.live('budgets', format('owner_id = %L', current_setting('test.gabi'))) = 0);

  perform pg_temp.check('a wipe removes the caller''s personal category',
    pg_temp.live('categories', format('name = %L', 'Gabi therapy')) = 0);

  perform pg_temp.check('a wipe removes the caller''s personal goal',
    pg_temp.live('goals', format('owner_id = %L', current_setting('test.gabi'))) = 0);
end $$;

-- Re-seeding must leave the household usable without doubling up.

do $$
declare n bigint;
begin
  n := pg_temp.live('categories', 'owner_id is null');
  perform pg_temp.check('a wipe re-seeds exactly one set of starter categories', n = 11, n::text);

  n := pg_temp.live('accounts', 'visibility = ''shared''');
  perform pg_temp.check('a wipe leaves exactly one usable shared account', n = 1, n::text);

  -- Erasing twice in a row is a thing people do. It must not produce 22.
  perform public.wipe_household();
  n := pg_temp.live('categories', 'owner_id is null');
  perform pg_temp.check('erasing twice does not duplicate the starter categories', n = 11, n::text);
  n := pg_temp.live('accounts', 'visibility = ''shared''');
  perform pg_temp.check('erasing twice does not duplicate the starter account', n = 1, n::text);
end $$;

-- ---------- deleting one account ----------

do $$
declare acct uuid; removed integer; n bigint; refused boolean;
begin
  insert into public.accounts (name, kind, visibility) values ('Spending', 'current', 'shared')
  returning id into acct;
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (acct, current_date, 'Coffee', -320), (acct, current_date, 'Lunch', -900);

  -- Refusing by default is what stops a client whose cache said "empty" from
  -- destroying rows the user was never shown.
  begin
    removed := public.delete_account(acct, false);
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('deleting an account with transactions is refused unless confirmed', refused);
  perform pg_temp.check('the refused account is still there',
    pg_temp.live('accounts', format('id = %L', acct)) = 1);

  removed := public.delete_account(acct, true);
  perform pg_temp.check('confirming reports how many transactions went', removed = 2, removed::text);
  perform pg_temp.check('the account is gone',
    pg_temp.live('accounts', format('id = %L', acct)) = 0);

  -- The whole reason this is one server-side operation: an account tombstoned
  -- without its transactions leaves them counting towards every budget and
  -- report on the client, which sums transactions with no reference to an account.
  n := pg_temp.live('transactions', format('account_id = %L', acct));
  perform pg_temp.check('its transactions went with it', n = 0, n::text);
end $$;

-- A goal pointing at a deleted account survives, minus the account.

do $$
declare acct uuid; goal uuid;
begin
  insert into public.accounts (name, kind, visibility) values ('Holiday pot', 'savings', 'shared')
  returning id into acct;
  insert into public.goals (name, target_minor, account_id) values ('Japan', 300000, acct)
  returning id into goal;

  perform public.delete_account(acct, true);
  perform pg_temp.check('a goal outlives the account it named',
    pg_temp.live('goals', format('id = %L and account_id is null', goal)) = 1);
end $$;

-- ---------- what one person cannot delete ----------

select pg_temp.act_as(current_setting('test.partner')::uuid);

do $$
declare blocked boolean; other_private uuid;
begin
  -- Gabi makes a fresh private account for the partner to try to reach.
  perform pg_temp.act_as(current_setting('test.gabi')::uuid);
  insert into public.accounts (name, kind, visibility) values ('Gabi secret', 'cash', 'private')
  returning id into other_private;
  perform set_config('test.other_private', other_private::text, false);

  perform pg_temp.act_as(current_setting('test.partner')::uuid);
  begin
    perform public.delete_account(current_setting('test.other_private')::uuid, true);
    blocked := false;
  exception when others then blocked := true;
  end;
  perform pg_temp.check('you cannot delete an account that is private to the other person', blocked);
  perform pg_temp.check('and it is still there',
    pg_temp.live('accounts', format('id = %L', current_setting('test.other_private'))) = 1);
end $$;

do $$
declare blocked boolean; balance_acct uuid;
begin
  perform pg_temp.act_as(current_setting('test.gabi')::uuid);
  insert into public.accounts (name, kind, visibility) values ('Gabi ISA', 'savings', 'balance')
  returning id into balance_acct;
  perform set_config('test.other_balance', balance_acct::text, false);

  perform pg_temp.act_as(current_setting('test.partner')::uuid);
  -- A balance-only account IS visible to the partner, which is exactly why the
  -- delete has to carry its own check rather than trusting that a caller who can
  -- see a row may destroy it.
  perform pg_temp.check('the partner can see the balance-only account',
    exists (select 1 from public.accounts where id = current_setting('test.other_balance')::uuid));

  begin
    perform public.delete_account(current_setting('test.other_balance')::uuid, true);
    blocked := false;
  exception when others then blocked := true;
  end;
  perform pg_temp.check('but cannot delete it', blocked);
  perform pg_temp.check('and it is still there',
    pg_temp.live('accounts', format('id = %L', current_setting('test.other_balance'))) = 1);
end $$;

-- ---------- an account cannot be taken from its owner ----------

do $$
declare shared_acct uuid; owner_after uuid; vis public.account_visibility; failed boolean;
begin
  perform pg_temp.act_as(current_setting('test.gabi')::uuid);
  insert into public.accounts (name, kind, visibility) values ('Gabi joint', 'current', 'shared')
  returning id into shared_acct;
  perform set_config('test.gabi_shared', shared_acct::text, false);

  perform pg_temp.act_as(current_setting('test.partner')::uuid);

  -- A shared account is editable by either person — that is what makes it joint.
  -- Claiming it is not: `owner_id = me, visibility = 'private'` would take the
  -- account and every transaction on it away from the person who created it,
  -- and RLS would then refuse to hand it back.
  begin
    update public.accounts
       set owner_id = current_setting('test.partner')::uuid, visibility = 'private'
     where id = current_setting('test.gabi_shared')::uuid;
    failed := false;
  exception when others then failed := true;
  end;

  select owner_id, visibility into owner_after, vis
    from public.accounts where id = current_setting('test.gabi_shared')::uuid;

  perform pg_temp.check('a shared account keeps its owner',
    owner_after = current_setting('test.gabi')::uuid, coalesce(owner_after::text, 'null'));
  perform pg_temp.check('and cannot be made private by the other person',
    vis = 'shared', vis::text);

  -- The ordinary edits a joint account is meant to allow still work.
  update public.accounts set name = 'Household current'
   where id = current_setting('test.gabi_shared')::uuid;
  perform pg_temp.check('renaming a shared account still works',
    exists (select 1 from public.accounts
             where id = current_setting('test.gabi_shared')::uuid and name = 'Household current'));
end $$;

-- A shared account is joint, so the person who did NOT create it may delete it.
-- The Settings list used to gate on "did I create this?", which locked one
-- person out of deleting the household's own joint account entirely.

do $$
declare acct uuid; removed integer;
begin
  perform pg_temp.act_as(current_setting('test.gabi')::uuid);
  insert into public.accounts (name, kind, visibility) values ('Gabi made this', 'current', 'shared')
  returning id into acct;
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (acct, current_date, 'Shop', -500);

  perform pg_temp.act_as(current_setting('test.partner')::uuid);
  removed := public.delete_account(acct, true);
  perform pg_temp.check('the other person can delete a shared account they did not create',
    removed = 1, removed::text);
  perform pg_temp.check('and it is really gone',
    pg_temp.live('accounts', format('id = %L', acct)) = 0);
end $$;

-- The owner handing their own shared account over is still allowed.

do $$
declare owner_after uuid;
begin
  perform pg_temp.act_as(current_setting('test.gabi')::uuid);
  update public.accounts set owner_id = current_setting('test.partner')::uuid
   where id = current_setting('test.gabi_shared')::uuid;
  select owner_id into owner_after from public.accounts
   where id = current_setting('test.gabi_shared')::uuid;
  perform pg_temp.check('an owner can hand their shared account over',
    owner_after = current_setting('test.partner')::uuid, coalesce(owner_after::text, 'null'));
end $$;

-- ---------- results ----------

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
