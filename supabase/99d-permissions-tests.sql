-- Hearth — tests for per-member account permissions (migration 07)
--
-- Companion to 99, 99b and 99c. Same shape: runs in a transaction, rolls back,
-- every row of the output must read ok = true.
--
-- Two things make this file different from the others.
--
-- Access is now deny-by-default, so "they cannot see it" is the boring case and
-- the interesting assertions are the ones proving somebody CAN. And an UPDATE
-- blocked by a policy's `using` clause does not raise — it matches zero rows,
-- silently — so the contribute-tier checks assert the row still holds its old
-- value, read past RLS, rather than catching an exception. Only `with check`
-- violations raise.

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

-- Read past RLS, to assert what is REALLY in the table. `security definer` is
-- the load-bearing word: under `set role authenticated` a plain helper is
-- filtered by the very policies it is trying to look behind, so it would pass
-- just as happily if the row had been destroyed outright.
create function pg_temp.live(tbl text, pred text)
returns bigint language plpgsql security definer as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I where deleted_at is null and %s', tbl, pred) into n;
  return n;
end $$;

create function pg_temp.val(tbl text, col text, pred text)
returns text language plpgsql security definer as $$
declare v text;
begin
  execute format('select %I::text from public.%I where %s', col, tbl, pred) into v;
  return v;
end $$;

-- Which household somebody is in. Definer, because once they have left, the
-- `profiles_select` policy stops the person doing the asking from reading their
-- row at all — which is correct, and would otherwise make this read null and
-- every assertion built on it fail for the wrong reason.
create function pg_temp.hh_of(u uuid)
returns uuid language plpgsql security definer as $$
declare h uuid;
begin
  select household_id into h from public.profiles where id = u;
  return h;
end $$;

create function pg_temp.epoch(h uuid)
returns integer language plpgsql security definer as $$
declare n integer;
begin
  select visibility_epoch into n from public.households where id = h;
  return n;
end $$;

-- Grant without going through the RPC's gate, for building fixtures.
create function pg_temp.grant_to(acct uuid, who uuid, lvl public.access_level)
returns void language plpgsql security definer as $$
begin
  insert into public.account_grants (account_id, user_id, level)
  values (acct, who, lvl)
  on conflict (account_id, user_id) where deleted_at is null
  do update set level = lvl;
end $$;

do $$
declare gabi uuid := gen_random_uuid(); sam uuid := gen_random_uuid(); alex uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (gabi, 'g4@test.local'), (sam, 'p4@test.local'), (alex, 't4@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.sam',  sam::text,  false);
  perform set_config('test.alex', alex::text, false);
end $$;

set role authenticated;

-- ============================================================
-- Fixture
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare
  h public.households;
  joint uuid; solo uuid; watched uuid; contrib uuid; viewed uuid; managed uuid;
  groceries uuid;
begin
  h := public.create_household('Permissions test');
  perform set_config('test.join_code', h.join_code, false);
  perform set_config('test.household', h.id::text, false);

  select id into groceries from public.categories where name = 'Groceries' and household_id = h.id;
  perform set_config('test.groceries', groceries::text, false);

  -- Nothing is seeded any more, so every account here is created on purpose.
  insert into public.accounts (name, kind) values ('Joint',   'current') returning id into joint;
  insert into public.accounts (name, kind) values ('Solo',    'cash')    returning id into solo;
  insert into public.accounts (name, kind) values ('Watched', 'savings') returning id into watched;
  insert into public.accounts (name, kind) values ('Contrib', 'current') returning id into contrib;
  insert into public.accounts (name, kind) values ('Viewed',  'current') returning id into viewed;
  insert into public.accounts (name, kind) values ('Managed', 'current') returning id into managed;

  perform set_config('test.joint',   joint::text,   false);
  perform set_config('test.solo',    solo::text,    false);
  perform set_config('test.watched', watched::text, false);
  perform set_config('test.contrib', contrib::text, false);
  perform set_config('test.viewed',  viewed::text,  false);
  perform set_config('test.managed', managed::text, false);

  insert into public.transactions (account_id, category_id, occurred_on, payee, amount_minor)
  values (joint,   groceries, current_date, 'Tesco',   -1000),
         (solo,    groceries, current_date, 'Private', -2000),
         (watched, null,      current_date, 'Payday',  50000),
         (contrib, groceries, current_date, 'Gabi on contrib', -3000),
         (viewed,  groceries, current_date, 'Gabi on viewed',  -4000),
         (managed, groceries, current_date, 'Gabi on managed', -5000);
end $$;

select pg_temp.act_as(current_setting('test.sam')::uuid);
do $$ begin perform public.join_household(current_setting('test.join_code')); end $$;

select pg_temp.act_as(current_setting('test.alex')::uuid);
do $$ begin perform public.join_household(current_setting('test.join_code')); end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare sam uuid := current_setting('test.sam')::uuid; alex uuid := current_setting('test.alex')::uuid;
begin
  perform pg_temp.grant_to(current_setting('test.joint')::uuid,   sam,  'owner');
  perform pg_temp.grant_to(current_setting('test.watched')::uuid, sam,  'balance');
  perform pg_temp.grant_to(current_setting('test.contrib')::uuid, sam,  'contribute');
  perform pg_temp.grant_to(current_setting('test.managed')::uuid, sam,  'manage');
  perform pg_temp.grant_to(current_setting('test.viewed')::uuid,  alex, 'view');
end $$;

-- ============================================================
-- 1. Deny by default
-- ============================================================

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
declare seen bigint; really bigint;
begin
  select count(*) into seen from public.accounts where id = current_setting('test.solo')::uuid;
  really := pg_temp.live('accounts', format('id = %L', current_setting('test.solo')));
  perform pg_temp.check('an account nobody granted you is invisible', seen = 0, format('saw %s', seen));
  perform pg_temp.check('…and it is invisible, not absent', really = 1);

  select count(*) into seen from public.transactions
   where account_id = current_setting('test.solo')::uuid;
  perform pg_temp.check('nor are its transactions readable', seen = 0, format('saw %s', seen));
end $$;

-- ============================================================
-- 2. Balance only — the number is right, the line items are gone
-- ============================================================

do $$
declare acct_rows bigint; txn_rows bigint; total bigint;
begin
  select count(*) into acct_rows from public.accounts where id = current_setting('test.watched')::uuid;
  select count(*) into txn_rows  from public.transactions where account_id = current_setting('test.watched')::uuid;
  select balance_minor into total from public.account_balances()
   where account_id = current_setting('test.watched')::uuid;

  perform pg_temp.check('balance tier: the account row is visible', acct_rows = 1);
  perform pg_temp.check('balance tier: its transactions are not', txn_rows = 0, format('saw %s', txn_rows));
  -- The whole point: the sum is computed over rows RLS hides, so a wrong
  -- number here is the worst possible failure in a finance app.
  perform pg_temp.check('balance tier: the total is still CORRECT', total = 50000, format('got %s', total));
end $$;

-- ============================================================
-- 3. View — reads everything, writes nothing
-- ============================================================

select pg_temp.act_as(current_setting('test.alex')::uuid);

do $$
declare txn_rows bigint; refused boolean; before_rows bigint;
begin
  select count(*) into txn_rows from public.transactions
   where account_id = current_setting('test.viewed')::uuid;
  perform pg_temp.check('view tier: every transaction is readable', txn_rows = 1, format('saw %s', txn_rows));

  before_rows := pg_temp.live('transactions', format('account_id = %L', current_setting('test.viewed')));
  begin
    insert into public.transactions (account_id, occurred_on, payee, amount_minor)
    values (current_setting('test.viewed')::uuid, current_date, 'Alex tried', -100);
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('view tier: inserting is refused', refused);
  perform pg_temp.check('view tier: …and nothing was written',
    pg_temp.live('transactions', format('account_id = %L', current_setting('test.viewed'))) = before_rows);
end $$;

-- ============================================================
-- 4. Contribute — your own entries only
-- ============================================================

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
declare mine uuid; theirs uuid; refused boolean;
begin
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.contrib')::uuid, current_date, 'Sam shop', -700)
  returning id into mine;
  perform set_config('test.sam_txn', mine::text, false);
  perform pg_temp.check('contribute: can add a transaction', mine is not null);

  update public.transactions set payee = 'Sam shop edited' where id = mine;
  perform pg_temp.check('contribute: can edit what they added',
    pg_temp.val('transactions', 'payee', format('id = %L', mine)) = 'Sam shop edited');

  select id into theirs from public.transactions
   where account_id = current_setting('test.contrib')::uuid and payee = 'Gabi on contrib';
  perform set_config('test.gabi_txn', theirs::text, false);

  -- A blocked UPDATE matches zero rows rather than raising, so the assertion
  -- has to be about the row, not about an exception.
  update public.transactions set payee = 'Sam meddling' where id = theirs;
  perform pg_temp.check('contribute: CANNOT edit somebody else''s',
    pg_temp.val('transactions', 'payee', format('id = %L', theirs)) = 'Gabi on contrib',
    coalesce(pg_temp.val('transactions', 'payee', format('id = %L', theirs)), 'gone'));

  update public.transactions set deleted_at = now() where id = theirs;
  perform pg_temp.check('contribute: CANNOT delete somebody else''s',
    pg_temp.live('transactions', format('id = %L', theirs)) = 1);

  -- Their own soft delete does go through: "delete only what you added" falls
  -- out of the same policy, because a delete is an update.
  update public.transactions set deleted_at = now() where id = mine;
  perform pg_temp.check('contribute: can delete what they added',
    pg_temp.live('transactions', format('id = %L', mine)) = 0);

  -- Sideways escape: moving your own row onto an account you may only view.
  -- This one DOES raise, because it is the with-check half that refuses.
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.contrib')::uuid, current_date, 'Sam second', -800)
  returning id into mine;
  begin
    update public.transactions set account_id = current_setting('test.watched')::uuid where id = mine;
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('contribute: cannot move a row onto an account they cannot post to', refused);
  perform pg_temp.check('…and the row still points at the account it was on',
    pg_temp.val('transactions', 'account_id', format('id = %L', mine)) = current_setting('test.contrib'));
end $$;

-- ============================================================
-- 5. Manage — edits anything on the account, controls nothing about it
-- ============================================================

do $$
declare theirs uuid; refused boolean;
begin
  select id into theirs from public.transactions
   where account_id = current_setting('test.managed')::uuid and payee = 'Gabi on managed';

  update public.transactions set payee = 'Sam fixed it' where id = theirs;
  perform pg_temp.check('manage: can edit somebody else''s transaction',
    pg_temp.val('transactions', 'payee', format('id = %L', theirs)) = 'Sam fixed it');

  update public.accounts set name = 'Managed renamed' where id = current_setting('test.managed')::uuid;
  perform pg_temp.check('manage: can rename the account',
    pg_temp.val('accounts', 'name', format('id = %L', current_setting('test.managed'))) = 'Managed renamed');

  begin
    perform public.upsert_account_grant(null, current_setting('test.managed')::uuid,
                                        current_setting('test.alex')::uuid, 'view');
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('manage: CANNOT change who can see it', refused);
  perform pg_temp.check('…and no grant was written',
    pg_temp.live('account_grants', format('account_id = %L and user_id = %L',
      current_setting('test.managed'), current_setting('test.alex'))) = 0);

  begin
    perform public.delete_account(current_setting('test.managed')::uuid, true);
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('manage: CANNOT delete the account', refused);
  perform pg_temp.check('…and the account is still there',
    pg_temp.live('accounts', format('id = %L', current_setting('test.managed'))) = 1);
end $$;

-- ============================================================
-- 6. Owner, and the rule that an account always has one
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare refused boolean; g public.account_grants;
begin
  g := public.upsert_account_grant(null, current_setting('test.viewed')::uuid,
                                   current_setting('test.sam')::uuid, 'contribute');
  perform pg_temp.check('owner: can grant', g.level = 'contribute');

  g := public.upsert_account_grant(null, current_setting('test.viewed')::uuid,
                                   current_setting('test.sam')::uuid, 'none');
  perform pg_temp.check('owner: can revoke',
    pg_temp.live('account_grants', format('account_id = %L and user_id = %L',
      current_setting('test.viewed'), current_setting('test.sam'))) = 0);

  -- Gabi is the only owner of Solo, so stepping down would strand it.
  begin
    perform public.upsert_account_grant(null, current_setting('test.solo')::uuid,
                                        current_setting('test.gabi')::uuid, 'manage');
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('the last owner cannot demote themselves', refused);
  perform pg_temp.check('…and they are still the owner',
    pg_temp.val('account_grants', 'level', format('account_id = %L and user_id = %L and deleted_at is null',
      current_setting('test.solo'), current_setting('test.gabi'))) = 'owner');

  -- Joint has two owners, so one of them may step down.
  perform public.upsert_account_grant(null, current_setting('test.joint')::uuid,
                                      current_setting('test.gabi')::uuid, 'manage');
  perform pg_temp.check('an owner CAN step down while another owner remains',
    pg_temp.val('account_grants', 'level', format('account_id = %L and user_id = %L and deleted_at is null',
      current_setting('test.joint'), current_setting('test.gabi'))) = 'manage');
  -- Put it back for the departure tests below.
  perform pg_temp.grant_to(current_setting('test.joint')::uuid, current_setting('test.gabi')::uuid, 'owner');

  -- Sharing is only possible with somebody you are in a household with.
  begin
    perform public.upsert_account_grant(null, current_setting('test.solo')::uuid,
                                        gen_random_uuid(), 'view');
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('cannot grant to somebody outside the household', refused);
end $$;

-- ============================================================
-- 7. The admin has no reach into accounts at all
-- ============================================================
--
-- The inverse of the test this model was almost built with. Gabi created the
-- household and is its admin; that must buy exactly nothing on Sam's account.

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
declare sam_only uuid;
begin
  insert into public.accounts (name, kind) values ('Sam private', 'cash') returning id into sam_only;
  perform set_config('test.sam_only', sam_only::text, false);
  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (sam_only, current_date, 'Sam secret', -9000);
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare seen bigint; is_admin boolean; total bigint; refused boolean;
begin
  is_admin := public.is_household_admin();
  perform pg_temp.check('the household founder is its admin', is_admin);

  select count(*) into seen from public.accounts where id = current_setting('test.sam_only')::uuid;
  perform pg_temp.check('an admin cannot see an account they were not granted', seen = 0, format('saw %s', seen));

  select count(*) into seen from public.transactions
   where account_id = current_setting('test.sam_only')::uuid;
  perform pg_temp.check('nor its transactions', seen = 0, format('saw %s', seen));

  select count(*) into total from public.account_balances()
   where account_id = current_setting('test.sam_only')::uuid;
  perform pg_temp.check('nor its balance', total = 0);

  begin
    perform public.delete_account(current_setting('test.sam_only')::uuid, true);
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('an admin cannot delete somebody else''s account', refused);
  perform pg_temp.check('…and it is still there',
    pg_temp.live('accounts', format('id = %L', current_setting('test.sam_only'))) = 1);
end $$;

-- The admin boundary in the other direction: personal budgets, goals and
-- categories are still owner-scoped and an admin sees none of them.
select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
begin
  insert into public.categories (name, icon, slot, kind, owner_id)
  values ('Sam therapy', 'health', 4, 'expense', current_setting('test.sam')::uuid);
  perform public.upsert_budget(null, current_setting('test.groceries')::uuid, true, 5000, current_date);
  insert into public.goals (name, target_minor, owner_id)
  values ('Sam bike', 90000, current_setting('test.sam')::uuid);
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare cats bigint; buds bigint; gls bigint;
begin
  select count(*) into cats from public.categories where name = 'Sam therapy';
  select count(*) into buds from public.budgets  where owner_id = current_setting('test.sam')::uuid;
  select count(*) into gls  from public.goals    where name = 'Sam bike';
  perform pg_temp.check('an admin sees no personal category of another member', cats = 0);
  perform pg_temp.check('nor a personal budget', buds = 0);
  perform pg_temp.check('nor a personal goal', gls = 0);
end $$;

-- ============================================================
-- 8. Member management
-- ============================================================

select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
declare refused boolean;
begin
  begin
    perform public.set_member_role(current_setting('test.alex')::uuid, 'admin');
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('a non-admin cannot change roles', refused);

  begin
    perform public.remove_member(current_setting('test.alex')::uuid);
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('a non-admin cannot remove anybody', refused);

  begin
    perform public.rotate_join_code();
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('a non-admin cannot reset the invite code', refused);
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare refused boolean;
begin
  begin
    perform public.set_member_role(current_setting('test.gabi')::uuid, 'member');
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('the last admin cannot demote themselves', refused);

  begin
    perform public.remove_member(current_setting('test.gabi')::uuid);
    refused := false;
  exception when others then refused := true;
  end;
  perform pg_temp.check('an admin cannot remove themselves', refused);
end $$;

-- ============================================================
-- 9. The departure cascade
-- ============================================================
--
-- Sam owns 'Sam private' alone, co-owns 'Joint' with Gabi, holds 'Contrib' at
-- contribute and 'Watched' at balance. Each of those is a different rule.

do $$
declare preview_rows bigint; leaves bigint; stays bigint; loses bigint;
begin
  select count(*) into preview_rows from public.preview_departure(current_setting('test.sam')::uuid);
  select count(*) into leaves from public.preview_departure(current_setting('test.sam')::uuid)
   where outcome = 'leaves_with_them';
  select count(*) into stays from public.preview_departure(current_setting('test.sam')::uuid)
   where outcome = 'stays_with_others';
  select count(*) into loses from public.preview_departure(current_setting('test.sam')::uuid)
   where outcome = 'loses_access';

  perform pg_temp.check('the preview covers every account they hold', preview_rows = 5, format('%s rows', preview_rows));
  perform pg_temp.check('the preview says one account leaves with them', leaves = 1, format('%s', leaves));
  perform pg_temp.check('the preview says the co-owned one stays', stays = 1, format('%s', stays));
  perform pg_temp.check('the preview says three are simply lost', loses = 3, format('%s', loses));
end $$;

do $$
declare before_epoch integer;
begin
  before_epoch := pg_temp.epoch(current_setting('test.household')::uuid);
  perform set_config('test.epoch_before', before_epoch::text, false);
  perform public.remove_member(current_setting('test.sam')::uuid);
end $$;

do $$
declare new_hh uuid;
begin
  new_hh := pg_temp.hh_of(current_setting('test.sam')::uuid);
  perform set_config('test.sam_household', new_hh::text, false);

  perform pg_temp.check('the removed member lands in a household of their own',
    new_hh is not null and new_hh is distinct from current_setting('test.household')::uuid);

  perform pg_temp.check('they are no longer a member of the old household',
    pg_temp.live('household_members', format('household_id = %L and user_id = %L',
      current_setting('test.household'), current_setting('test.sam'))) = 0);

  -- Rule 2: the account they owned alone went with them.
  perform pg_temp.check('an account they owned alone moved with them',
    pg_temp.val('accounts', 'household_id', format('id = %L', current_setting('test.sam_only'))) = new_hh::text);
  perform pg_temp.check('…and its transactions came too',
    pg_temp.val('transactions', 'household_id',
      format('account_id = %L and payee = ''Sam secret''', current_setting('test.sam_only'))) = new_hh::text);
  perform pg_temp.check('…and they still own it',
    pg_temp.val('account_grants', 'level', format('account_id = %L and user_id = %L and deleted_at is null',
      current_setting('test.sam_only'), current_setting('test.sam'))) = 'owner');

  -- Rule 3: the co-owned account stayed, and they lost it.
  perform pg_temp.check('a co-owned account stayed in the old household',
    pg_temp.val('accounts', 'household_id', format('id = %L', current_setting('test.joint')))
      = current_setting('test.household'));
  perform pg_temp.check('…and their grant on it is gone',
    pg_temp.live('account_grants', format('account_id = %L and user_id = %L',
      current_setting('test.joint'), current_setting('test.sam'))) = 0);
  perform pg_temp.check('…while the remaining owner keeps theirs',
    pg_temp.val('account_grants', 'level', format('account_id = %L and user_id = %L and deleted_at is null',
      current_setting('test.joint'), current_setting('test.gabi'))) = 'owner');

  -- Rule 1: everything they merely had access to.
  perform pg_temp.check('their contribute grant is revoked',
    pg_temp.live('account_grants', format('account_id = %L and user_id = %L',
      current_setting('test.contrib'), current_setting('test.sam'))) = 0);
  perform pg_temp.check('their balance grant is revoked',
    pg_temp.live('account_grants', format('account_id = %L and user_id = %L',
      current_setting('test.watched'), current_setting('test.sam'))) = 0);

  -- Rule 4: a working copy of the taxonomy.
  perform pg_temp.check('the household categories were copied for them',
    pg_temp.live('categories', format('household_id = %L and owner_id is null', new_hh)) = 11,
    format('%s categories', pg_temp.live('categories', format('household_id = %L and owner_id is null', new_hh))));
  perform pg_temp.check('their personal category moved with them',
    pg_temp.live('categories', format('household_id = %L and name = ''Sam therapy''', new_hh)) = 1);
  perform pg_temp.check('their personal budget moved with them',
    pg_temp.live('budgets', format('household_id = %L and owner_id = %L', new_hh, current_setting('test.sam'))) = 1);
  perform pg_temp.check('their personal goal moved with them',
    pg_temp.live('goals', format('household_id = %L and name = ''Sam bike''', new_hh)) = 1);
  perform pg_temp.check('the old household kept its own categories',
    pg_temp.live('categories', format('household_id = %L and owner_id is null', current_setting('test.household'))) = 11);

  perform pg_temp.check('the old household''s epoch was bumped',
    pg_temp.epoch(current_setting('test.household')::uuid) > current_setting('test.epoch_before')::integer);
end $$;

-- The departed member can still use what they took with them.
select pg_temp.act_as(current_setting('test.sam')::uuid);

do $$
declare seen bigint; added uuid;
begin
  select count(*) into seen from public.accounts where id = current_setting('test.sam_only')::uuid;
  perform pg_temp.check('after leaving, they can still see their own account', seen = 1);

  select count(*) into seen from public.transactions where account_id = current_setting('test.sam_only')::uuid;
  perform pg_temp.check('…and its history', seen = 1, format('saw %s', seen));

  insert into public.transactions (account_id, occurred_on, payee, amount_minor)
  values (current_setting('test.sam_only')::uuid, current_date, 'After leaving', -100)
  returning id into added;
  perform pg_temp.check('…and can still record against it', added is not null);

  select count(*) into seen from public.accounts where id = current_setting('test.joint')::uuid;
  perform pg_temp.check('but not the account they left behind', seen = 0, format('saw %s', seen));
end $$;

-- ============================================================
-- 10. Erase everything, under the new model
-- ============================================================

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare grants_before bigint;
begin
  grants_before := pg_temp.live('account_grants', 'true');
  perform set_config('test.grants_before', grants_before::text, false);
  perform public.wipe_household();
end $$;

do $$
begin
  perform pg_temp.check('the wipe removed the accounts the caller owned',
    pg_temp.live('accounts', format('id = %L', current_setting('test.joint'))) = 0);
  perform pg_temp.check('…and one they only managed is not theirs to lose',
    pg_temp.live('accounts', format('id = %L', current_setting('test.sam_only'))) = 1);
  -- Grants are deliberately left alone: accounts_select needs one, so revoking
  -- would leave every other device holding the account with no readable
  -- tombstone to evict it by.
  perform pg_temp.check('the wipe left account_grants alone',
    pg_temp.live('account_grants', 'true') = current_setting('test.grants_before')::bigint,
    format('%s -> %s', current_setting('test.grants_before'), pg_temp.live('account_grants', 'true')));
  perform pg_temp.check('the wipe left the member list alone',
    pg_temp.live('household_members', format('household_id = %L', current_setting('test.household'))) = 2);
  perform pg_temp.check('re-seeding restores exactly the 11 starter categories',
    pg_temp.live('categories', format('household_id = %L and owner_id is null', current_setting('test.household'))) = 11);
  -- The change the user asked for: nothing invents an account for you.
  perform pg_temp.check('and NO account is created for them',
    pg_temp.live('accounts', format('household_id = %L', current_setting('test.household'))) = 0,
    format('%s accounts', pg_temp.live('accounts', format('household_id = %L', current_setting('test.household')))));
end $$;

-- ============================================================
-- 11. The tables themselves
-- ============================================================

do $$
declare before_rows bigint; after_rows bigint;
begin
  before_rows := pg_temp.live('account_grants', 'true');
  begin
    delete from public.account_grants;
  exception when others then null;
  end;
  after_rows := pg_temp.live('account_grants', 'true');
  perform pg_temp.check('nobody can hard-delete a grant',
    after_rows = before_rows and before_rows > 0, format('%s -> %s', before_rows, after_rows));

  before_rows := pg_temp.live('household_members', 'true');
  begin
    delete from public.household_members;
  exception when others then null;
  end;
  after_rows := pg_temp.live('household_members', 'true');
  perform pg_temp.check('nobody can hard-delete a membership',
    after_rows = before_rows and before_rows > 0, format('%s -> %s', before_rows, after_rows));
end $$;

-- The deprecated columns are inert: a client still sending them changes nothing.
do $$
declare acct uuid;
begin
  insert into public.accounts (name, kind) values ('Inertness', 'current') returning id into acct;
  update public.accounts set visibility = 'private', owner_id = current_setting('test.alex')::uuid
   where id = acct;
  perform pg_temp.check('accounts.visibility is inert',
    pg_temp.val('accounts', 'visibility', format('id = %L', acct)) = 'shared');
  perform pg_temp.check('accounts.owner_id is inert',
    pg_temp.val('accounts', 'owner_id', format('id = %L', acct)) = current_setting('test.gabi'));
  perform pg_temp.check('creating an account grants the creator ownership',
    pg_temp.val('account_grants', 'level', format('account_id = %L and user_id = %L and deleted_at is null',
      acct, current_setting('test.gabi'))) = 'owner');
end $$;

-- Creating an account must NOT bump the epoch, or every new account would wipe
-- the creator's own cache and re-pull the world.
do $$
declare before_epoch integer; acct uuid;
begin
  before_epoch := pg_temp.epoch(current_setting('test.household')::uuid);
  insert into public.accounts (name, kind) values ('Epoch check', 'current') returning id into acct;
  perform pg_temp.check('creating an account does not bump the epoch',
    pg_temp.epoch(current_setting('test.household')::uuid) = before_epoch);

  perform public.upsert_account_grant(null, acct, current_setting('test.alex')::uuid, 'view');
  perform pg_temp.check('granting access DOES bump the epoch',
    pg_temp.epoch(current_setting('test.household')::uuid) > before_epoch);
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
