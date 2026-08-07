-- Hearth — tests for ownership boundaries on destructive operations
--
-- Companion to 99-rls-tests.sql and 99b-model-tests.sql, covering migration 05
-- as rewritten by 07. Same shape: runs in a transaction, rolls back, every row
-- of the output must read ok = true.
--
-- These matter more than most. The functions under test are `security definer`,
-- so RLS is switched off inside them and nothing but the predicates written in
-- their bodies stands between one person and another's accounts. A mistake here
-- does not raise an error — it silently deletes somebody's money.
--
-- Since 07, "may I destroy this?" is a grant at `owner`, not a visibility
-- column, and nothing is ever seeded for you: a wipe leaves you with no
-- accounts at all rather than a fresh joint one.

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
-- signed-in user would assert that the POLICY hides the other person's account,
-- which is 99-rls-tests.sql's job and is true either way — it would pass just as
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

  select id into groceries from public.categories where name = 'Groceries';
  select id into home from public.categories where name = 'Home & utilities';
  perform set_config('test.groceries', groceries::text, false);
  perform set_config('test.home', home::text, false);

  -- Nothing is seeded since 07, so the joint account is created here and made
  -- joint below, once there is somebody to share it with.
  insert into public.accounts (name, kind) values ('Joint account', 'current')
    returning id into joint;
  perform set_config('test.joint', joint::text, false);

  insert into public.accounts (name, kind) values ('Gabi cash', 'cash')
    returning id into g_private;
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

  insert into public.accounts (name, kind) values ('Partner stash', 'cash')
    returning id into p_private;
  insert into public.accounts (name, kind) values ('Partner ISA', 'savings')
    returning id into p_balance;
  perform set_config('test.p_private', p_private::text, false);
  perform set_config('test.p_balance', p_balance::text, false);

  -- Gabi may watch the ISA's total but never its line items. 'Partner stash' is
  -- granted to nobody else at all.
  perform public.upsert_account_grant(null, p_balance, current_setting('test.gabi')::uuid, 'balance');

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

-- The joint account is made genuinely joint: both own it, either may erase it.
select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
begin
  perform public.upsert_account_grant(null, current_setting('test.joint')::uuid,
                                      current_setting('test.partner')::uuid, 'owner');
end $$;

-- ---------- Gabi erases everything ----------

do $$
begin
  perform public.wipe_household();
end $$;

-- THE regression. Every one of these was destroyed before migration 05.

do $$
declare n bigint;
begin
  perform pg_temp.check('a wipe leaves the account nobody granted the caller alone',
    pg_temp.live('accounts', format('id = %L', current_setting('test.p_private'))) = 1);

  -- Seeing an account is not owning it: 'balance' is four tiers below the level
  -- a wipe acts on, which is exactly why the function carries its own predicate
  -- rather than trusting that a caller who can see a row may destroy it.
  perform pg_temp.check('a wipe leaves an account the caller merely watches alone',
    pg_temp.live('accounts', format('id = %L', current_setting('test.p_balance'))) = 1);

  n := pg_temp.live('transactions',
    format('account_id in (%L, %L)', current_setting('test.p_private'), current_setting('test.p_balance')));
  perform pg_temp.check('a wipe leaves the transactions on them alone', n = 2, n::text);

  perform pg_temp.check('a wipe leaves the other person''s personal budget alone',
    pg_temp.live('budgets', format('owner_id = %L', current_setting('test.partner'))) = 1);

  perform pg_temp.check('a wipe leaves the other person''s personal goal alone',
    pg_temp.live('goals', format('owner_id = %L', current_setting('test.partner'))) = 1);

  perform pg_temp.check('a wipe leaves the other person''s personal category alone',
    pg_temp.live('categories', format('id = %L', current_setting('test.p_sub'))) = 1);

  -- ...and it is still usable: orphaned under a tombstoned parent it would
  -- disappear from every picker on their device, which is the same loss by a
  -- slower route.
  perform pg_temp.check('their personal subcategory is promoted, not orphaned',
    pg_temp.live('categories',
      format('id = %L and parent_id is null and icon is not null and slot is not null',
             current_setting('test.p_sub'))) = 1);

  -- The grants themselves outlive the wipe on purpose: accounts_select needs
  -- one, so revoking here would leave the other device holding the account with
  -- no readable tombstone to evict it by.
  perform pg_temp.check('a wipe does not revoke anybody''s grants',
    pg_temp.live('account_grants', format('account_id = %L', current_setting('test.joint'))) = 2);
end $$;

-- The half that must still happen: jointly owned data and the caller's own go.

do $$
declare n bigint;
begin
  perform pg_temp.check('a wipe removes the account only the caller held',
    pg_temp.live('accounts', format('id = %L', current_setting('test.g_private'))) = 0);

  perform pg_temp.check('a wipe removes the jointly owned account',
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

-- Re-seeding must leave the household usable without doubling up — and must not
-- invent an account, which is the change 07 made.

do $$
declare n bigint;
begin
  n := pg_temp.live('categories', 'owner_id is null');
  perform pg_temp.check('a wipe re-seeds exactly one set of starter categories', n = 11, n::text);

  n := pg_temp.live('accounts', format('household_id = %L', current_setting('test.household')));
  perform pg_temp.check('a wipe creates NO replacement account', n = 2, n::text);

  -- Erasing twice in a row is a thing people do. It must not produce 22.
  perform public.wipe_household();
  n := pg_temp.live('categories', 'owner_id is null');
  perform pg_temp.check('erasing twice does not duplicate the starter categories', n = 11, n::text);
  n := pg_temp.live('accounts', format('household_id = %L', current_setting('test.household')));
  perform pg_temp.check('erasing twice still creates no account', n = 2, n::text);
end $$;

-- ---------- deleting one account ----------

do $$
declare acct uuid; removed integer; n bigint; refused boolean;
begin
  insert into public.accounts (name, kind) values ('Spending', 'current') returning id into acct;
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

  -- The tombstone must stay readable by everyone who held a grant, or their
  -- cache keeps the account forever with nothing left to replicate.
  perform pg_temp.check('deleting leaves the grants behind so the tombstone can be read',
    (select count(*) from public.account_grants where account_id = acct and deleted_at is null) = 1);
end $$;

-- A goal pointing at a deleted account survives, minus the account.

do $$
declare acct uuid; goal uuid;
begin
  insert into public.accounts (name, kind) values ('Holiday pot', 'savings') returning id into acct;
  insert into public.goals (name, target_minor, account_id) values ('Japan', 300000, acct)
  returning id into goal;

  perform public.delete_account(acct, true);
  perform pg_temp.check('a goal outlives the account it named',
    pg_temp.live('goals', format('id = %L and account_id is null', goal)) = 1);
end $$;

-- ---------- what one person cannot delete ----------

do $$
declare blocked boolean; other_private uuid;
begin
  perform pg_temp.act_as(current_setting('test.gabi')::uuid);
  insert into public.accounts (name, kind) values ('Gabi secret', 'cash') returning id into other_private;
  perform set_config('test.other_private', other_private::text, false);

  perform pg_temp.act_as(current_setting('test.partner')::uuid);
  begin
    perform public.delete_account(current_setting('test.other_private')::uuid, true);
    blocked := false;
  exception when others then blocked := true;
  end;
  perform pg_temp.check('you cannot delete an account you were never granted', blocked);
  perform pg_temp.check('and it is still there',
    pg_temp.live('accounts', format('id = %L', current_setting('test.other_private'))) = 1);
end $$;

do $$
declare blocked boolean; balance_acct uuid;
begin
  perform pg_temp.act_as(current_setting('test.gabi')::uuid);
  insert into public.accounts (name, kind) values ('Gabi ISA', 'savings') returning id into balance_acct;
  perform set_config('test.other_balance', balance_acct::text, false);
  perform public.upsert_account_grant(null, balance_acct, current_setting('test.partner')::uuid, 'balance');

  perform pg_temp.act_as(current_setting('test.partner')::uuid);
  -- A balance-only account IS visible, which is exactly why the delete has to
  -- carry its own check rather than trusting that a caller who can see a row may
  -- destroy it.
  perform pg_temp.check('somebody at balance level can see the account',
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
--
-- Rewritten for 07. `owner_id` and `visibility` are inert columns now, so the
-- old version of this test — send `owner_id = me, visibility = 'private'` and
-- check nothing moved — would pass for the wrong reason: nothing moves whatever
-- anybody sends. What it was really asserting is that you cannot promote
-- yourself on somebody else's account, and that is a grant question.

do $$
declare shared_acct uuid; refused boolean;
begin
  perform pg_temp.act_as(current_setting('test.gabi')::uuid);
  insert into public.accounts (name, kind) values ('Gabi joint', 'current') returning id into shared_acct;
  perform set_config('test.gabi_shared', shared_acct::text, false);
  -- 'manage' is the highest tier that still cannot re-share.
  perform public.upsert_account_grant(null, shared_acct, current_setting('test.partner')::uuid, 'manage');

  perform pg_temp.act_as(current_setting('test.partner')::uuid);

  begin
    perform public.upsert_account_grant(null, current_setting('test.gabi_shared')::uuid,
                                        current_setting('test.partner')::uuid, 'owner');
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('a manager cannot promote themselves to owner', refused);
  perform pg_temp.check('and their level is unchanged',
    (select level::text from public.account_grants
      where account_id = current_setting('test.gabi_shared')::uuid
        and user_id = current_setting('test.partner')::uuid and deleted_at is null) = 'manage');

  begin
    perform public.upsert_account_grant(null, current_setting('test.gabi_shared')::uuid,
                                        current_setting('test.gabi')::uuid, 'none');
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('nor revoke the owner who granted them', refused);
  perform pg_temp.check('who still owns it',
    (select level::text from public.account_grants
      where account_id = current_setting('test.gabi_shared')::uuid
        and user_id = current_setting('test.gabi')::uuid and deleted_at is null) = 'owner');

  -- The ordinary edits 'manage' is meant to allow still work.
  update public.accounts set name = 'Household current'
   where id = current_setting('test.gabi_shared')::uuid;
  perform pg_temp.check('renaming an account you manage still works',
    exists (select 1 from public.accounts
             where id = current_setting('test.gabi_shared')::uuid and name = 'Household current'));
end $$;

-- A jointly owned account is joint, so the person who did NOT create it may
-- delete it. The Settings list used to gate on "did I create this?", which
-- locked one person out of deleting the household's own joint account entirely.

do $$
declare acct uuid; removed integer;
begin
  perform pg_temp.act_as(current_setting('test.gabi')::uuid);
  insert into public.accounts (name, kind) values ('Gabi made this', 'current') returning id into acct;
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (acct, current_date, 'Shop', -500);
  perform public.upsert_account_grant(null, acct, current_setting('test.partner')::uuid, 'owner');

  perform pg_temp.act_as(current_setting('test.partner')::uuid);
  removed := public.delete_account(acct, true);
  perform pg_temp.check('a co-owner can delete an account they did not create',
    removed = 1, removed::text);
  perform pg_temp.check('and it is really gone',
    pg_temp.live('accounts', format('id = %L', acct)) = 0);
end $$;

-- Handing an account over is now an explicit operation rather than a column
-- write, so that it never passes through the zero-owner state the grant RPC
-- refuses.

do $$
declare levels text;
begin
  perform pg_temp.act_as(current_setting('test.gabi')::uuid);
  perform public.transfer_account_ownership(current_setting('test.gabi_shared')::uuid,
                                            current_setting('test.partner')::uuid, true);

  perform pg_temp.check('handing over makes the other person an owner',
    (select level::text from public.account_grants
      where account_id = current_setting('test.gabi_shared')::uuid
        and user_id = current_setting('test.partner')::uuid and deleted_at is null) = 'owner');
  perform pg_temp.check('and steps the previous owner down when asked',
    (select level::text from public.account_grants
      where account_id = current_setting('test.gabi_shared')::uuid
        and user_id = current_setting('test.gabi')::uuid and deleted_at is null) = 'manage');
end $$;

-- ---------- results ----------

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
