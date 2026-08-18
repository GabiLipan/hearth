-- Hearth — tests for editing a rule's conditions (migration 22)
--
-- Companion to 99 … 99n. Same shape: runs in a transaction, rolls back, every
-- row of the output must read ok = true.
--
-- The first four checks all FAIL against migration 21's upsert_rule, which is
-- the point of them — a test for this that only asserts the happy path would
-- have passed for the whole time the bug was shipped.

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

create function pg_temp.live_rules()
returns bigint language sql security definer as $$
  select count(*) from public.rules where deleted_at is null
$$;

do $$
declare gabi uuid := gen_random_uuid();
        stranger uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (gabi, 'g9@test.local');
  -- Created here rather than beside the test that needs it: `insert into
  -- auth.users` is refused once `set role authenticated` is in force.
  insert into auth.users (id, email) values (stranger, 'stranger9@test.local');
  perform set_config('test.gabi', gabi::text, false);
  perform set_config('test.stranger', stranger::text, false);
end $$;

set role authenticated;
select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare h public.households; cat uuid; other uuid; acc uuid;
begin
  h := public.create_household('Rule edit test');
  select id into cat from public.categories where household_id = h.id and kind = 'expense' limit 1;
  select id into other from public.categories
    where household_id = h.id and kind = 'expense' and id <> cat limit 1;
  insert into public.accounts (name, kind) values ('Current', 'current') returning id into acc;
  perform set_config('test.cat', cat::text, false);
  perform set_config('test.other', other::text, false);
  perform set_config('test.acc', acc::text, false);
end $$;

-- ---------- editing the conditions of a rule that exists ----------

do $$
declare cat uuid := current_setting('test.cat')::uuid;
        acc uuid := current_setting('test.acc')::uuid;
        rid uuid := gen_random_uuid();
        r public.rules;
begin
  r := public.upsert_rule(rid, 'apple.com/bill', cat, null, null, null, null);
  perform pg_temp.check('a new rule is created under the id it was given', r.id = rid);

  -- The case that dead-lettered as rules_pkey: same id, a condition added.
  r := public.upsert_rule(rid, 'apple.com/bill', cat, 'Apple', 899, 899, null);
  perform pg_temp.check('an amount condition can be added to an existing rule',
    r.id = rid and r.amount_min_minor = 899 and r.amount_max_minor = 899);

  -- Same again for the payee, which is the field 03's version already broke.
  r := public.upsert_rule(rid, 'apple.com/subs', cat, 'Apple', 899, 899, null);
  perform pg_temp.check('the payee of an existing rule can be changed',
    r.id = rid and r.match = 'apple.com/subs');

  -- And for the account.
  r := public.upsert_rule(rid, 'apple.com/subs', cat, 'Apple', 899, 899, acc);
  perform pg_temp.check('a rule can be narrowed to one account',
    r.id = rid and r.account_id = acc);

  -- Editing must not multiply rows. One rule went in; one rule is here.
  perform pg_temp.check('editing a rule four times leaves one rule',
    pg_temp.live_rules() = 1, pg_temp.live_rules()::text);

  -- Conditions clear as well as set — every argument is authoritative.
  r := public.upsert_rule(rid, 'apple.com/subs', cat, 'Apple', null, null, null);
  perform pg_temp.check('conditions can be cleared again',
    r.amount_min_minor is null and r.amount_max_minor is null and r.account_id is null);
end $$;

-- ---------- what still has to keep working ----------

do $$
declare cat uuid := current_setting('test.cat')::uuid;
        other uuid := current_setting('test.other')::uuid;
        r public.rules;
        first_id uuid;
begin
  -- Two devices learning one payee: the second call must land on the first
  -- rule rather than making a second. This is what the on-conflict is for.
  r := public.upsert_rule(gen_random_uuid(), 'tesco', cat, null, null, null, null);
  first_id := r.id;
  r := public.upsert_rule(gen_random_uuid(), 'tesco', other, null, null, null, null);
  perform pg_temp.check('the same payee from two devices is still one rule',
    r.id = first_id and r.category_id = other);

  -- Re-filing an existing rule by id, conditions untouched: the path that
  -- always worked.
  r := public.upsert_rule(first_id, 'tesco', cat, 'Tesco', null, null, null);
  perform pg_temp.check('re-filing a rule by id still updates it in place',
    r.id = first_id and r.category_id = cat and r.title = 'Tesco');

  -- Two prices from one vendor are still two rules (migration 21's whole point).
  r := public.upsert_rule(gen_random_uuid(), 'tesco', cat, null, 4000, 4000, null);
  perform pg_temp.check('one payee at two amounts is still two rules',
    r.id <> first_id);
end $$;

-- ---------- editing one rule onto another's exact conditions ----------

do $$
declare cat uuid := current_setting('test.cat')::uuid;
        a uuid; b uuid; r public.rules;
begin
  r := public.upsert_rule(gen_random_uuid(), 'spotify', cat, 'Spotify', null, null, null);
  a := r.id;
  r := public.upsert_rule(gen_random_uuid(), 'netflix', cat, 'Netflix', null, null, null);
  b := r.id;

  -- Editing netflix's payee to spotify asks a question spotify already asks.
  -- The edited row wins and keeps its id; the other is tombstoned.
  r := public.upsert_rule(b, 'spotify', cat, 'Netflix', null, null, null);
  perform pg_temp.check('folding keeps the id being edited', r.id = b);
  perform pg_temp.check('folding keeps what the edit said', r.title = 'Netflix');
  perform pg_temp.check('folding tombstones the rule it duplicated',
    pg_temp.val('rules', 'deleted_at', format('id = %L', a)) is not null);
  perform pg_temp.check('and does not delete the edited one',
    pg_temp.val('rules', 'deleted_at', format('id = %L', b)) is null);
end $$;

-- ---------- a rule deleted on the other device ----------

do $$
declare cat uuid := current_setting('test.cat')::uuid;
        rid uuid; r public.rules; said text := '';
begin
  r := public.upsert_rule(gen_random_uuid(), 'deliveroo', cat, null, null, null, null);
  rid := r.id;
  update public.rules set deleted_at = now() where id = rid;

  begin
    r := public.upsert_rule(rid, 'deliveroo', cat, 'Deliveroo', null, null, null);
    perform pg_temp.check('editing a deleted rule is refused', false, 'it succeeded');
  exception when others then
    said := sqlerrm;
    perform pg_temp.check('editing a deleted rule is refused', true);
    perform pg_temp.check('and says so in words rather than naming a constraint',
      said not like '%constraint%' and said like '%deleted%', said);
  end;
end $$;

-- ---------- the privacy boundary the update must not cross ----------
--
-- `security definer` switches the policies off, so "you may only edit your own
-- household's rule" has to be restated in the body. If it were not, p_id from
-- another household would fall into the update and rewrite their row.

select pg_temp.act_as(current_setting('test.stranger')::uuid);

do $$
declare h public.households; cat uuid; r public.rules;
begin
  h := public.create_household('Someone else');
  select id into cat from public.categories where household_id = h.id and kind = 'expense' limit 1;
  r := public.upsert_rule(gen_random_uuid(), 'their payee', cat, null, null, null, null);
  perform set_config('test.theirs', r.id::text, false);
end $$;

select pg_temp.act_as(current_setting('test.gabi')::uuid);

do $$
declare cat uuid := current_setting('test.cat')::uuid;
        theirs uuid := current_setting('test.theirs')::uuid;
begin
  begin
    perform public.upsert_rule(theirs, 'hijacked', cat, 'Mine now', null, null, null);
    perform pg_temp.check('another household''s rule cannot be edited by id', false,
      'the call succeeded');
  exception when others then
    perform pg_temp.check('another household''s rule cannot be edited by id', true);
  end;

  perform pg_temp.check('and their rule is untouched',
    pg_temp.val('rules', 'match', format('id = %L', theirs)) = 'their payee',
    coalesce(pg_temp.val('rules', 'match', format('id = %L', theirs)), '<gone>'));
end $$;

reset role;
select id, check_name, ok, detail from results order by id;

rollback;
