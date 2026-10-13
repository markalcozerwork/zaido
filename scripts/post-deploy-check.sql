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

  -- Chat topics (Step 4): two receive policies and the typing send policy.
  foreach t in array array['chat topics: members receive', 'chat typing: members send', 'user chat topic: owner receives'] loop
    if to_regclass('realtime.messages') is not null
       and not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = t) then
      missing := array_append(missing, format('policy "%s" on realtime.messages', t));
    end if;
  end loop;
  if exists (select 1 from pg_policies
              where schemaname = 'realtime' and tablename = 'messages' and cmd in ('INSERT', 'ALL')
                and policyname <> 'chat typing: members send') then
    missing := array_append(missing, 'NO client-send policy on realtime.messages other than chat typing');
  end if;
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and tablename in ('chat_messages', 'chat_participants')) then
    missing := array_append(missing, 'chat tables OUT of publication supabase_realtime (chat uses Broadcast)');
  end if;
  foreach t in array array['chat_messages_10_guard', 'chat_messages_20_sequence', 'chat_messages_80_after',
                           'chat_participants_10_defaults', 'chat_participants_20_guard', 'chat_participants_80_hints',
                           'chat_channels_80_hints', 'chat_channels_81_deleted'] loop
    if not exists (select 1 from pg_trigger where tgname = t and not tgisinternal and tgenabled <> 'D') then
      missing := array_append(missing, format('enabled trigger %s', t));
    end if;
  end loop;
  if exists (select 1 from pg_proc
              where oid in ('public.send_chat_message'::regproc, 'app.tg_chat_messages_guard'::regproc,
                            'app.tg_chat_participants_guard'::regproc)
                and prosecdef) then
    missing := array_append(missing, 'send_chat_message and the chat guards as SECURITY INVOKER');
  end if;
  if exists (select 1 from public.chat_channels c
              where c.last_seq <> coalesce((select max(m.seq) from public.chat_messages m where m.channel_id = c.id), 0)) then
    missing := array_append(missing, 'chat_channels.last_seq = max(chat_messages.seq) for every channel');
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
    foreach t in array array['rh-expire-unpaid-bookings', 'rh-complete-past-bookings', 'rh-archive-event-channels'] loop
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
