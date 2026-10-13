-- =============================================================================
-- Post-deploy check for a real Supabase project (read-only).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/post-deploy-check.sql
--
-- The migrations skip Realtime and pg_cron setup on databases that lack them
-- (local Postgres, CI), with only a warning. On a deployed project a missing
-- piece is silent breakage (e.g. no receive policy = private slot channels
-- receive nothing), so this check fails loudly instead.
-- =============================================================================
do $$
declare
  missing text[] := '{}';
  t text;
begin
  -- Realtime: broadcast from the database, receive-only policy, publication.
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    missing := array_append(missing, 'function realtime.send(jsonb,text,text,boolean)');
  end if;
  if to_regclass('realtime.messages') is null then
    missing := array_append(missing, 'table realtime.messages');
  elsif not exists (select 1 from pg_policies
                     where schemaname = 'realtime' and tablename = 'messages'
                       and policyname = 'court slot topics are receivable' and cmd = 'SELECT') then
    missing := array_append(missing, 'policy "court slot topics are receivable" on realtime.messages');
  elsif exists (select 1 from pg_policies
                 where schemaname = 'realtime' and tablename = 'messages'
                   and cmd in ('INSERT', 'ALL') and 'anon' = any (roles)) then
    missing := array_append(missing, 'NO anon INSERT policy on realtime.messages (clients must not send)');
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bookings') then
    missing := array_append(missing, 'public.bookings in publication supabase_realtime');
  end if;

  -- Booking-engine triggers.
  foreach t in array array['bookings_guard', 'bookings_35_release_event', 'bookings_40_coach_commitments', 'bookings_50_broadcast_slots',
                           'events_guard', 'events_30_reserve_booking', 'events_40_coach_commitments',
                           'court_closures_stamp', 'court_closures_broadcast'] loop
    if not exists (select 1 from pg_trigger where tgname = t and not tgisinternal and tgenabled <> 'D') then
      missing := array_append(missing, format('enabled trigger %s', t));
    end if;
  end loop;

  -- Scheduled jobs (pg_cron).
  if to_regclass('cron.job') is null then
    missing := array_append(missing, 'extension pg_cron');
  else
    foreach t in array array['rh-expire-unpaid-bookings', 'rh-complete-past-bookings'] loop
      if not exists (select 1 from cron.job where jobname = t and active) then
        missing := array_append(missing, format('active cron job %s', t));
      end if;
    end loop;
  end if;

  -- The booking RPC must keep running as the caller.
  if (select prosecdef from pg_proc where oid = to_regprocedure(
        'public.create_booking(uuid,timestamptz,timestamptz,public.payment_method,uuid,uuid,text,smallint,text,uuid,text,text,numeric,boolean)')) is distinct from false then
    missing := array_append(missing, 'public.create_booking as SECURITY INVOKER');
  end if;

  if cardinality(missing) > 0 then
    raise exception 'Post-deploy check FAILED. Missing or wrong: %', array_to_string(missing, '; ');
  end if;
  raise notice 'Post-deploy check passed.';
end;
$$;
