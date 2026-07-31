-- Hearth — RPCs (3 of 4)
--
-- Everything here exists because the operation cannot be expressed safely as a
-- plain PostgREST call: it needs to be atomic, or it needs to resolve a unique
-- constraint that PostgREST's `on_conflict=` cannot name (it takes a bare
-- column list, so no partial and no expression indexes), or it needs to read
-- rows the caller cannot select.
--
-- Ordinary inserts, field-level updates and soft deletes do NOT belong here —
-- they go straight through PostgREST from the client's outbox.

-- ---------- shared helpers ----------

create or replace function public.advance_due(d date, f public.bill_freq)
returns date language sql immutable as $$
  select (d + case f
    when 'weekly'      then interval '1 week'
    when 'fortnightly' then interval '2 weeks'
    when 'monthly'     then interval '1 month'
    when 'quarterly'   then interval '3 months'
    when 'yearly'      then interval '1 year'
  end)::date
$$;

create or replace function public.new_join_code()
returns text language sql volatile as $$
  select upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8))
$$;

-- Seeded SERVER-side, with server-generated uuids. The old client seeded these
-- itself with hardcoded ids like 'def-groceries', before its first pull — which
-- is what resurrected deleted categories and produced a duplicate set per
-- device. Shared by create_household() and wipe_household().
create or replace function public.seed_household(h uuid, uid uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.categories (household_id, name, icon, slot, kind, sort_order)
  values
    (h, 'Groceries',        'cart',    2, 'expense', 0),
    (h, 'Home & utilities', 'home',    5, 'expense', 1),
    (h, 'Transport',        'car',     1, 'expense', 2),
    (h, 'Dining out',       'dining',  8, 'expense', 3),
    (h, 'Shopping',         'bag',     7, 'expense', 4),
    (h, 'Subscriptions',    'tv',      6, 'expense', 5),
    (h, 'Health',           'health',  4, 'expense', 6),
    (h, 'Fun & leisure',    'fun',     3, 'expense', 7),
    (h, 'Other',            'package', 1, 'expense', 8),
    (h, 'Salary',           'wallet',  2, 'income',  9),
    (h, 'Other income',     'coins',   4, 'income', 10);

  insert into public.accounts (household_id, name, kind, visibility, created_by)
  values (h, 'Joint account', 'current', 'shared', uid);
end $$;

-- ---------- household lifecycle ----------

-- Idempotent by design: two tabs finishing sign-in at the same moment both call
-- this, and the second must get the first one's household back rather than
-- creating a second one. (The old client's auto-provisioning did exactly that,
-- and stranded a household full of data whenever the user then joined their
-- partner.)
create or replace function public.create_household(household_name text default 'Our household')
returns public.households
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  h public.households;
  existing uuid;
begin
  if uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;

  select household_id into existing from public.profiles where id = uid;
  if existing is not null then
    select * into h from public.households where id = existing;
    return h;
  end if;

  insert into public.households (name, join_code)
  values (coalesce(nullif(trim(household_name), ''), 'Our household'), public.new_join_code())
  returning * into h;

  update public.profiles set household_id = h.id where id = uid;
  perform public.seed_household(h.id, uid);

  return h;
end $$;

-- Joining wipes nothing server-side; the client drops its cache and re-pulls.
-- Switching from an existing household is allowed but explicit — the caller is
-- told what will happen before this is called.
create or replace function public.join_household(code text)
returns public.households
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  h public.households;
  previous uuid;
begin
  if uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;

  select * into h from public.households
   where upper(join_code) = upper(trim(code));
  if h.id is null then
    raise exception 'No household found for that code' using errcode = 'P0002';
  end if;

  select household_id into previous from public.profiles where id = uid;
  if previous = h.id then return h; end if;

  update public.profiles set household_id = h.id where id = uid;
  return h;
end $$;

-- Leaving must bump the old household's epoch (the profiles trigger does it),
-- which is what tells this device to wipe its cache on next contact.
create or replace function public.leave_household()
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set household_id = null where id = (select auth.uid());
end $$;

-- ---------- constrained upserts ----------

-- `budgets` has two partial unique indexes (household vs personal) that
-- PostgREST cannot target, so the conflict is resolved here instead. Passing
-- amount_minor = null removes the budget.
create or replace function public.upsert_budget(
  p_id uuid,
  p_category_id uuid,
  p_personal boolean,
  p_amount_minor bigint
)
returns public.budgets
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := (select auth.uid());
  hh uuid := public.my_household();
  own uuid := case when p_personal then uid else null end;
  b public.budgets;
begin
  if hh is null then raise exception 'No household' using errcode = '42501'; end if;
  if not exists (select 1 from public.categories where id = p_category_id and household_id = hh) then
    raise exception 'Unknown category' using errcode = '23503';
  end if;

  select * into b from public.budgets
   where household_id = hh and category_id = p_category_id
     and owner_id is not distinct from own and deleted_at is null;

  if p_amount_minor is null then
    if b.id is not null then
      update public.budgets set deleted_at = now() where id = b.id returning * into b;
    end if;
    return b;
  end if;

  if b.id is null then
    insert into public.budgets (id, household_id, category_id, owner_id, amount_minor)
    values (coalesce(p_id, gen_random_uuid()), hh, p_category_id, own, p_amount_minor)
    returning * into b;
  else
    update public.budgets set amount_minor = p_amount_minor where id = b.id returning * into b;
  end if;
  return b;
end $$;

-- `rules` is unique on lower(match) — another expression index PostgREST cannot
-- target. Re-categorising a payee updates the existing rule rather than
-- failing, which is what `learnRule` on the client has always meant to do.
create or replace function public.upsert_rule(
  p_id uuid,
  p_match text,
  p_category_id uuid
)
returns public.rules
language plpgsql security definer set search_path = public as $$
declare
  hh uuid := public.my_household();
  r public.rules;
begin
  if hh is null then raise exception 'No household' using errcode = '42501'; end if;

  insert into public.rules (id, household_id, match, category_id, created_by)
  values (coalesce(p_id, gen_random_uuid()), hh, trim(p_match), p_category_id, (select auth.uid()))
  on conflict (household_id, lower(match)) where deleted_at is null
  do update set category_id = excluded.category_id, updated_at = now()
  returning * into r;
  return r;
end $$;

-- ---------- bills ----------

-- Records every occurrence of every auto-post bill that has come due, in ONE
-- transaction. `bill_postings`' composite primary key means two devices running
-- this simultaneously produce one transaction per occurrence, not two, and
-- `next_due` advances exactly once.
create or replace function public.post_due_bills(p_until date default current_date)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  hh uuid := public.my_household();
  uid uuid := (select auth.uid());
  b record;
  due date;
  txn uuid;
  guard integer;
  posted integer := 0;
begin
  if hh is null then return 0; end if;

  for b in
    select * from public.bills
     where household_id = hh and deleted_at is null and active and auto_post and next_due <= p_until
     for update
  loop
    due := b.next_due;
    guard := 0;
    while due <= p_until and guard < 60 loop
      guard := guard + 1;

      insert into public.transactions
        (household_id, account_id, category_id, bill_id, occurred_on, payee, note, amount_minor, created_by)
      values
        (hh, b.account_id, b.category_id, b.id, due,
         coalesce(nullif(b.payee, ''), b.name), b.name, b.amount_minor, uid)
      returning id into txn;

      insert into public.bill_postings (bill_id, due_on, household_id, transaction_id)
      values (b.id, due, hh, txn)
      on conflict (bill_id, due_on) do nothing;

      if not found then
        -- Another device already recorded this occurrence; undo our transaction.
        delete from public.transactions where id = txn;
      else
        posted := posted + 1;
      end if;

      due := public.advance_due(due, b.freq);
    end loop;

    update public.bills set next_due = due where id = b.id;
  end loop;

  return posted;
end $$;

-- "Record it now" from the Bills screen: one occurrence, same idempotency.
create or replace function public.post_bill(p_bill_id uuid, p_on_date date default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  hh uuid := public.my_household();
  b public.bills;
  txn uuid;
begin
  select * into b from public.bills where id = p_bill_id and household_id = hh for update;
  if b.id is null then raise exception 'Unknown bill' using errcode = 'P0002'; end if;

  insert into public.transactions
    (household_id, account_id, category_id, bill_id, occurred_on, payee, note, amount_minor, created_by)
  values
    (hh, b.account_id, b.category_id, b.id, coalesce(p_on_date, b.next_due),
     coalesce(nullif(b.payee, ''), b.name), b.name, b.amount_minor, (select auth.uid()))
  returning id into txn;

  insert into public.bill_postings (bill_id, due_on, household_id, transaction_id)
  values (b.id, b.next_due, hh, txn)
  on conflict (bill_id, due_on) do nothing;

  if not found then
    delete from public.transactions where id = txn;
    return null;
  end if;

  update public.bills set next_due = public.advance_due(b.next_due, b.freq) where id = b.id;
  return txn;
end $$;

create or replace function public.skip_bill(p_bill_id uuid)
returns date
language plpgsql security definer set search_path = public as $$
-- `next` would be read as the RETURN NEXT keyword, hence `following`.
declare b public.bills; following date;
begin
  select * into b from public.bills where id = p_bill_id and household_id = public.my_household() for update;
  if b.id is null then raise exception 'Unknown bill' using errcode = 'P0002'; end if;
  following := public.advance_due(b.next_due, b.freq);
  update public.bills set next_due = following where id = b.id;
  return following;
end $$;

-- ---------- balances ----------

-- SECURITY DEFINER, and deliberately not a view.
--
-- A `security_invoker` view would let RLS filter the hidden transactions out of
-- the sum() and return a silently WRONG balance — the worst possible failure in
-- a finance app. A definer view would give the right number but expose a
-- caller-filterable `select *` surface over the whole table. A function returns
-- aggregates only, and carries its own authorization predicate in the body
-- where the caller cannot widen it.
create or replace function public.account_balances()
returns table (account_id uuid, balance_minor bigint)
language sql stable security definer set search_path = public as $$
  select a.id,
         a.opening_balance_minor + coalesce(sum(t.amount_minor) filter (where t.deleted_at is null), 0)
  from public.accounts a
  left join public.transactions t on t.account_id = a.id
  where a.deleted_at is null
    and a.household_id = public.my_household()
    and (a.visibility <> 'private' or a.owner_id = (select auth.uid()))
  group by a.id, a.opening_balance_minor
$$;

-- ---------- sync integrity ----------

-- SECURITY INVOKER on purpose: RLS applies, so these counts are what THIS
-- caller should be able to see, which is exactly what their cache should hold.
-- The client runs this after each delta pull; a mismatch triggers a full pull
-- of that table. It is what turns "a row was silently skipped forever" into
-- "the cache heals itself within seconds".
create or replace function public.sync_checksums()
returns table (table_name text, live_rows bigint, max_updated_at timestamptz)
language sql stable set search_path = public as $$
  select 'categories',   count(*), max(updated_at) from public.categories   where deleted_at is null
  union all
  select 'accounts',     count(*), max(updated_at) from public.accounts     where deleted_at is null
  union all
  select 'bills',        count(*), max(updated_at) from public.bills        where deleted_at is null
  union all
  select 'transactions', count(*), max(updated_at) from public.transactions where deleted_at is null
  union all
  select 'budgets',      count(*), max(updated_at) from public.budgets      where deleted_at is null
  union all
  select 'rules',        count(*), max(updated_at) from public.rules        where deleted_at is null
$$;

-- ---------- danger zone ----------

-- Settings → "Delete everything". Tombstones rather than truncates, so the
-- other device learns about the wipe instead of silently re-uploading its copy.
create or replace function public.wipe_household()
returns void
language plpgsql security definer set search_path = public as $$
declare hh uuid := public.my_household();
begin
  if hh is null then return; end if;
  update public.transactions set deleted_at = now() where household_id = hh and deleted_at is null;
  update public.budgets      set deleted_at = now() where household_id = hh and deleted_at is null;
  update public.rules        set deleted_at = now() where household_id = hh and deleted_at is null;
  delete from public.bill_postings where household_id = hh;
  update public.bills        set deleted_at = now() where household_id = hh and deleted_at is null;
  update public.accounts     set deleted_at = now() where household_id = hh and deleted_at is null;
  update public.categories   set deleted_at = now() where household_id = hh and deleted_at is null;
  -- Leave the household usable: a transaction cannot be recorded without an
  -- account, so a wipe that removed the last one would brick the add form.
  perform public.seed_household(hh, (select auth.uid()));
end $$;

-- ---------- grants ----------

do $$
declare f text;
begin
  foreach f in array array[
    'create_household(text)', 'join_household(text)', 'leave_household()',
    'upsert_budget(uuid,uuid,boolean,bigint)', 'upsert_rule(uuid,text,uuid)',
    'post_due_bills(date)', 'post_bill(uuid,date)', 'skip_bill(uuid)',
    'account_balances()', 'sync_checksums()', 'wipe_household()',
    'advance_due(date,public.bill_freq)'
  ] loop
    execute format('revoke execute on function public.%s from anon, public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Internal only: never callable from a client.
revoke execute on function public.new_join_code() from anon, public, authenticated;
revoke execute on function public.seed_household(uuid, uuid) from anon, public, authenticated;
