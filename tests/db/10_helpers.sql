-- =============================================================================
-- TEST-ONLY helpers. Assertions print "ok - …" notices and raise on failure.
-- Identity switching: `set role authenticated; select tests.login(<uuid>);`
-- =============================================================================
\set ON_ERROR_STOP 1
reset role;

create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

-- Fixed identities used across the suites.
create or replace function tests.uid(p_name text) returns uuid language sql immutable as $$
  select case p_name
    when 'olivia' then '00000000-0000-4000-a000-000000000001'  -- venue owner
    when 'alice'  then '00000000-0000-4000-a000-000000000002'  -- player
    when 'bob'    then '00000000-0000-4000-a000-000000000003'  -- player
    when 'carlos' then '00000000-0000-4000-a000-000000000004'  -- coach / club admin
    when 'mia'    then '00000000-0000-4000-a000-000000000005'  -- venue front desk
    when 'dave'   then '00000000-0000-4000-a000-000000000006'  -- outsider
    when 'erin'   then '00000000-0000-4000-a000-000000000007'  -- fresh player (Step 3 suite)
  end::uuid;
$$;

create or replace function tests.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
$$;

create or replace function tests.login(p_name text) returns void language sql as $$
  select tests.login(tests.uid(p_name));
$$;

create or replace function tests.logout() returns void language sql as $$
  select set_config('request.jwt.claims', '', false);
$$;

-- Local wall-clock time at the venue, N days after the Monday two weeks
-- from now. Far enough ahead for cancellation cutoffs, inside the 90-day
-- booking horizon, and always on a known weekday.
create or replace function tests.slot(p_days_after_monday int, p_hhmm text) returns timestamptz
language sql stable as $$
  select ((date_trunc('week', now() at time zone 'Asia/Manila') + interval '14 days')::date
          + p_days_after_monday + p_hhmm::time) at time zone 'Asia/Manila';
$$;

create or replace function tests.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end;
$$;

create or replace function tests.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok - %', p_label;
end;
$$;

-- Runs p_sql and expects it to fail with p_sqlstate (NULL = any error).
create or replace function tests.throws(p_sql text, p_sqlstate text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_sqlstate is null or sqlstate = p_sqlstate then
      raise notice 'ok - % [% %]', p_label, sqlstate, sqlerrm;
      return;
    end if;
    raise exception 'FAIL: % (expected SQLSTATE %, got %: %)', p_label, p_sqlstate, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (expected SQLSTATE %, but the statement succeeded)', p_label, p_sqlstate;
end;
$$;

-- Runs p_sql and expects it to succeed.
create or replace function tests.lives(p_sql text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise notice 'ok - %', p_label;
exception when others then
  raise exception 'FAIL: % (% %)', p_label, sqlstate, sqlerrm;
end;
$$;

-- Runs p_sql and returns the number of rows it affected. RLS filters writes
-- silently, so "0 rows" is how a forbidden UPDATE/DELETE shows up.
create or replace function tests.affected(p_sql text) returns bigint language plpgsql as $$
declare
  n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on all functions in schema tests to anon, authenticated, service_role;
