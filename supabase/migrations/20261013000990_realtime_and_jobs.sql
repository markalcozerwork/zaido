-- =============================================================================
-- RacketHub · 0990 · Realtime publication & scheduled jobs
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Realtime (Postgres Changes). Realtime applies each table's SELECT policy
-- per subscriber, so these tables stream only what the user may see.
--   chat_messages       → live chat in all three tiers
--   chat_participants   → unread badges / read receipts
--   events              → live "8/12 going" counters
--   event_attendees     → RSVP list and waitlist promotions
--   event_queue_entries → on-court paddle rotation board
--   bookings            → venue dashboard (staff only see their venue)
-- Public slot availability for OTHER players' bookings can't flow through
-- Postgres Changes, because RLS hides those rows. Step 3 adds a Realtime
-- Broadcast topic per court that carries only time ranges.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not found; skipping realtime setup.';
    return;
  end if;
  foreach t in array array[
    'chat_messages', 'chat_participants', 'events', 'event_attendees', 'event_queue_entries', 'bookings'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- Full old-row images let the rotation board and RSVP list diff UPDATEs
-- client-side. With RLS on, Realtime still sends only primary keys for DELETEs.
alter table public.event_queue_entries replica identity full;
alter table public.event_attendees     replica identity full;

-- -----------------------------------------------------------------------------
-- Scheduled jobs (pg_cron). Enable pg_cron under Database → Extensions in
-- the Supabase dashboard. On databases without it, this block only logs a
-- notice. Correctness never depends on the sweeper: new bookings clear stale
-- holds on their court inline (see app.tg_bookings_guard).
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available; skipping job scheduling.';
    return;
  end if;

  create extension if not exists pg_cron;

  perform cron.schedule('rh-expire-unpaid-bookings',  '* * * * *',    'select app.expire_unpaid_bookings()');
  perform cron.schedule('rh-complete-past-bookings',  '*/15 * * * *', 'select app.complete_finished_bookings()');
  perform cron.schedule('rh-archive-event-channels',  '17 3 * * *',   'select app.archive_finished_event_channels()');
end;
$$;
