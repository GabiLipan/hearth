-- Hearth — tests for a colour of your own (migration 23)
--
-- Companion to 99 … 99o. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.
--
-- The check constraint IS the validation — the value is written straight into a
-- `background:` on the client — so most of this is what the column refuses.

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

-- Whether a value is accepted, as a boolean rather than an exception. Every
-- call is its own subtransaction, so a rejection does not abandon the test run.
create function pg_temp.accepts(tbl text, id uuid, value text)
returns boolean language plpgsql as $$
begin
  execute format('update public.%I set color = %L where id = %L', tbl, value, id);
  return true;
exception when check_violation then
  return false;
end $$;

-- Reads past RLS. `security definer` is load-bearing: under `set role
-- authenticated` a plain helper is filtered by the policies it is looking
-- behind, and would pass vacuously.
create function pg_temp.val(tbl text, col text, pred text)
returns text language plpgsql security definer as $$
declare v text;
begin
  execute format('select %I::text from public.%I where %s', col, tbl, pred) into v;
  return v;
end $$;

do $$
declare gabi uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (gabi, 'g23@test.local');
  perform set_config('test.gabi', gabi::text, false);
end $$;

set role authenticated;
select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; cat uuid; acct uuid; goal uuid;
begin
  h := public.create_household('Custom colour test');
  select id into cat from public.categories where household_id = h.id and kind = 'expense' limit 1;
  perform set_config('test.cat', cat::text, false);

  insert into public.accounts (name, kind) values ('Current', 'current') returning id into acct;
  perform set_config('test.account', acct::text, false);

  insert into public.goals (name, icon, slot, target_minor) values ('Holiday', 'piggy', 4, 100000)
  returning id into goal;
  perform set_config('test.goal', goal::text, false);
end $$;

-- ============================================================
-- 1. Null is the ordinary case, on all three
-- ============================================================

do $$
begin
  perform pg_temp.check('a category starts with no colour of its own',
    pg_temp.val('categories', 'color', format('id = %L', current_setting('test.cat'))) is null);
  perform pg_temp.check('so does an account',
    pg_temp.val('accounts', 'color', format('id = %L', current_setting('test.account'))) is null);
  perform pg_temp.check('so does a goal',
    pg_temp.val('goals', 'color', format('id = %L', current_setting('test.goal'))) is null);
end $$;

-- ============================================================
-- 2. What each of the three accepts
-- ============================================================

do $$
declare cat uuid := current_setting('test.cat')::uuid;
begin
  perform pg_temp.check('a category takes six hex digits',
    pg_temp.accepts('categories', cat, '#7c6cf0'));
  perform pg_temp.check('and the value is what comes back',
    pg_temp.val('categories', 'color', format('id = %L', cat)) = '#7c6cf0');
  -- The client lowercases before sending; upper case is accepted anyway, so a
  -- row written by hand in the SQL editor is not a row the app cannot read.
  perform pg_temp.check('upper case is accepted too',
    pg_temp.accepts('categories', cat, '#7C6CF0'));

  perform pg_temp.check('an account takes one',
    pg_temp.accepts('accounts', current_setting('test.account')::uuid, '#1f9e8a'));
  perform pg_temp.check('a goal takes one',
    pg_temp.accepts('goals', current_setting('test.goal')::uuid, '#1f9e8a'));
end $$;

-- ============================================================
-- 3. And what it refuses
--
-- Three-digit shorthand is refused rather than expanded: the client normalises
-- before it sends, so a short value arriving means something skipped that path.
-- The last two are the reason the constraint is this strict at all.
-- ============================================================

do $$
declare cat uuid := current_setting('test.cat')::uuid;
begin
  perform pg_temp.check('no hash is refused', not pg_temp.accepts('categories', cat, '7c6cf0'));
  perform pg_temp.check('three digits are refused', not pg_temp.accepts('categories', cat, '#7c6'));
  perform pg_temp.check('five digits are refused', not pg_temp.accepts('categories', cat, '#7c6cf'));
  perform pg_temp.check('eight digits are refused', not pg_temp.accepts('categories', cat, '#7c6cf0ff'));
  perform pg_temp.check('a colour name is refused', not pg_temp.accepts('categories', cat, 'rebeccapurple'));
  perform pg_temp.check('a token is refused', not pg_temp.accepts('categories', cat, 'var(--series-1)'));
  perform pg_temp.check('anything trailing the hex is refused',
    not pg_temp.accepts('categories', cat, '#7c6cf0; background: url(x)'));
  perform pg_temp.check('an account refuses the same',
    not pg_temp.accepts('accounts', current_setting('test.account')::uuid, 'red'));
  perform pg_temp.check('and so does a goal',
    not pg_temp.accepts('goals', current_setting('test.goal')::uuid, 'red'));
end $$;

-- ============================================================
-- 4. Clearing it goes back to the slot
--
-- The slot is never touched by any of this: a custom colour is an override laid
-- OVER one, so clearing the colour has something to fall back to. A top-level
-- category with a colour and no slot would be refused by
-- `categories_top_level_has_style`, which is the last check here.
-- ============================================================

do $$
declare cat uuid := current_setting('test.cat')::uuid;
begin
  perform pg_temp.check('setting a colour leaves the slot alone',
    pg_temp.val('categories', 'slot', format('id = %L', cat)) is not null);

  update public.categories set color = null where id = cat;
  perform pg_temp.check('and it can be cleared',
    pg_temp.val('categories', 'color', format('id = %L', cat)) is null);
end $$;

do $$
declare failed boolean := false;
begin
  begin
    insert into public.categories (household_id, name, kind, color, sort_order)
    values ((select household_id from public.categories where id = current_setting('test.cat')::uuid),
            'Colour but no slot', 'expense', '#7c6cf0', 99);
  exception when check_violation then
    failed := true;
  end;
  perform pg_temp.check('a top-level category still needs a slot, colour or not', failed);
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
