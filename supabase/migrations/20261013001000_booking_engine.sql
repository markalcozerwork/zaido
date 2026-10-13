-- =============================================================================
-- RacketHub · 1000 · Booking engine
-- =============================================================================
-- Step 3 hardens booking creation for a concurrent, mobile, partly-hostile world:
--
--   1. public.create_booking(): the one entry point the app uses. Idempotent
--      per checkout via INSERT … ON CONFLICT on (created_by, idempotency_key).
--   2. Coach commitments ledger: app.coach_commitments holds one row per live
--      coached booking and per coach-confirmed clinic/event, behind an
--      EXCLUDE constraint. Exclusion checks see committed AND in-flight rows
--      whatever the isolation level and regardless of RLS, so a coach can't
--      be double-booked across courts, venues, bookings and events. (A
--      lock-then-SELECT design fails under REPEATABLE READ and is blind under
--      RLS.)
--   3. Coach consent: an event only reserves a coach once the coach confirms
--      (events.coach_confirmed_at), so nobody can block a coach with fake events.
--   4. Event court reservations: an event published on a court must link a
--      CONFIRMED booking of its organiser. The link is written ONTO the
--      booking row (bookings.reserved_for_event_id) by an UPDATE, so a
--      concurrent cancel/reschedule of that booking serialises on the row
--      lock (READ COMMITTED) or fails with 40001 (REPEATABLE READ). Never
--      write skew.
--   5. Abuse limits: per-player active-hold cap per venue, late payment
--      proofs rejected, receipts must be the booking's own uploaded file,
--      on-behalf bookings only at verified venues and never with a coach,
--      walk-ins without accounts via walk_in_name/phone.
--   6. Realtime: every change in a court's busy-ness is broadcast on the
--      PRIVATE topic court:<id>:slots. Receive-only RLS on realtime.messages
--      means clients can't spoof slot events. Payloads carry times only.
--
-- Errors raised for business rules use "CODE: human message" so the TS layer
-- can map them (src/domain/errors.ts) while showing the human text.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------
alter table public.bookings
  add column created_by            uuid references public.profiles (id) on delete set null,
  add column idempotency_key       uuid,
  add column walk_in_name          text,
  add column walk_in_phone         text,
  add column reserved_for_event_id uuid references public.events (id) on delete set null,
  add constraint bookings_walk_in_name_length check (walk_in_name is null or char_length(btrim(walk_in_name)) between 2 and 120),
  add constraint bookings_walk_in_phone_format check (walk_in_phone is null or walk_in_phone ~ '^\+63[0-9]{9,10}$'),
  add constraint bookings_walk_in_phone_needs_name check (walk_in_phone is null or walk_in_name is not null);

comment on column public.bookings.created_by is 'Who created the row (the player, or venue staff for walk-ins). Stamped by the guard.';
comment on column public.bookings.idempotency_key is 'Client-generated per checkout attempt; retries with the same key return the same booking.';
comment on column public.bookings.reserved_for_event_id is 'Set by the events trigger while a scheduled event uses this booking''s court time.';

update public.bookings set created_by = booked_by where created_by is null;

-- Keyed by the ACTOR, so a staff walk-in can never collide with a player's own key.
create unique index bookings_idempotency_key on public.bookings (created_by, idempotency_key)
  where idempotency_key is not null;
create index bookings_created_by_idx on public.bookings (created_by) where created_by is not null;
create unique index bookings_reserved_for_event_key on public.bookings (reserved_for_event_id)
  where reserved_for_event_id is not null;

alter table public.events
  add column coach_confirmed_at timestamptz;

comment on column public.events.coach_confirmed_at is
  'Set when the named coach accepts. Only then does the event reserve the coach''s time.';

-- Events created before Step 3 were trusted as-is.
update public.events set coach_confirmed_at = created_at where coach_id is not null and coach_confirmed_at is null;

alter table public.venues
  add column max_active_holds_per_player smallint not null default 3,
  add column min_lead_minutes            smallint not null default 0,
  add column booking_horizon_days        smallint not null default 90,
  add column is_open_24h                 boolean  not null default false,
  add constraint venues_max_active_holds   check (max_active_holds_per_player between 1 and 50),
  add constraint venues_min_lead_minutes   check (min_lead_minutes between 0 and 1440),
  add constraint venues_booking_horizon    check (booking_horizon_days between 1 and 90);

comment on column public.venues.max_active_holds_per_player is
  'Most unpaid holds (pending e-wallet or unpaid cash) one player may have at this venue at once.';
comment on column public.venues.min_lead_minutes is 'Players must book at least this many minutes before the start.';
comment on column public.venues.booking_horizon_days is 'Players can book up to this many calendar days ahead (venue-local dates).';
comment on column public.venues.is_open_24h is
  'Explicit 24/7 flag. Without it, a venue that has not published opening hours takes no player bookings.';

-- Venues that never set hours were bookable around the clock before this
-- migration; keep them that way. New venues must set hours or opt in.
update public.venues v set is_open_24h = true
 where not exists (select 1 from public.venue_operating_hours h where h.venue_id = v.id);

-- How long after payment_due_at an unpaid hold is really dead. Every place
-- that decides "is this hold still alive?" uses this one value (sweeps, busy
-- slots, hold cap, late proofs), so the grid and the guard always agree.
create or replace function app.hold_grace()
returns interval
language sql
immutable
parallel safe
set search_path = ''
as $$ select interval '5 minutes' $$;

-- -----------------------------------------------------------------------------
-- Court closures: typhoon signals, maintenance, barangay events
-- -----------------------------------------------------------------------------
create table public.court_closures (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references public.venues (id) on delete cascade,
  court_id    uuid,                         -- NULL = every court at the venue
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text not null,
  created_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint court_closures_court_fk foreign key (venue_id, court_id)
    references public.courts (venue_id, id) on delete cascade,
  constraint court_closures_order check (ends_at > starts_at),
  constraint court_closures_max_length check (ends_at - starts_at <= interval '31 days'),
  constraint court_closures_reason_length check (char_length(btrim(reason)) between 3 and 200)
);

create index court_closures_lookup_idx on public.court_closures using gist (venue_id, tstzrange(starts_at, ends_at, '[)'));
create index court_closures_created_by_idx on public.court_closures (created_by) where created_by is not null;

alter table public.court_closures enable row level security;

create policy "court_closures: public read"
  on public.court_closures for select to anon, authenticated
  using (exists (select 1 from public.venues v where v.id = venue_id));

create policy "court_closures: venue staff manage"
  on public.court_closures for all to authenticated
  using (app.is_venue_manager(venue_id))
  with check (app.is_venue_manager(venue_id));

-- Who created a closure is recorded by the database, never taken from the client.
create or replace function app.tg_court_closures_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not app.is_trusted_context() then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
      new.created_at := old.created_at;
    end if;
  end if;
  return new;
end;
$$;

create trigger court_closures_stamp
  before insert or update on public.court_closures
  for each row execute function app.tg_court_closures_stamp();

revoke truncate, references, trigger on public.court_closures from anon, authenticated;
revoke insert, update, delete on public.court_closures from anon;

create or replace function app.court_is_closed(p_court_id uuid, p_venue_id uuid, p_start timestamptz, p_end timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.court_closures k
     where k.venue_id = p_venue_id
       and (k.court_id is null or k.court_id = p_court_id)
       and tstzrange(k.starts_at, k.ends_at, '[)') && tstzrange(p_start, p_end, '[)')
  );
$$;

-- -----------------------------------------------------------------------------
-- 2. Read helpers used by the guards (SECURITY DEFINER: RLS-independent, return
--    only what the rule needs)
-- -----------------------------------------------------------------------------
drop function if exists app.court_booking_rules(uuid);

create function app.court_booking_rules(p_court_id uuid)
returns table (
  venue_id                    uuid,
  venue_is_active             boolean,
  venue_is_verified           boolean,
  court_is_active             boolean,
  sport                       public.sport,
  timezone                    text,
  slot_increment_minutes      smallint,
  min_booking_minutes         smallint,
  max_booking_minutes         smallint,
  payment_window_minutes      smallint,
  cancellation_cutoff_hours   smallint,
  max_active_holds_per_player smallint,
  min_lead_minutes            smallint,
  booking_horizon_days        smallint,
  is_open_24h                 boolean,
  accepts_cash_on_court       boolean,
  auto_confirm_cash_bookings  boolean,
  accepts_gcash               boolean,
  accepts_maya                boolean,
  accepts_bank_transfer       boolean,
  has_operating_hours         boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.is_active, v.verification_status = 'VERIFIED', c.is_active, c.sport, v.timezone,
         c.slot_increment_minutes, c.min_booking_minutes, c.max_booking_minutes,
         v.payment_window_minutes, v.cancellation_cutoff_hours, v.max_active_holds_per_player,
         v.min_lead_minutes, v.booking_horizon_days, v.is_open_24h,
         v.accepts_cash_on_court, v.auto_confirm_cash_bookings,
         v.gcash_number is not null, v.maya_number is not null, v.bank_transfer_details is not null,
         exists (select 1 from public.venue_operating_hours h where h.venue_id = v.id)
    from public.courts c
    join public.venues v on v.id = c.venue_id
   where c.id = p_court_id;
$$;

-- Does [p_start, p_end) fit inside the coach's published weekly availability,
-- read in the venue's local time? A coach with no windows is available anytime.
create or replace function app.is_within_coach_availability(
  p_coach_id uuid, p_start timestamptz, p_end timestamptz, p_timezone text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.coach_availability a where a.coach_id = p_coach_id)
      or not exists (
           select 1
             from generate_series(p_start, p_end - interval '15 minutes', interval '15 minutes') as gs
            cross join lateral (select gs at time zone p_timezone as ts) as loc
            where not exists (
              select 1 from public.coach_availability a
               where a.coach_id = p_coach_id
                 and a.day_of_week = extract(dow from loc.ts)::smallint
                 and loc.ts::time >= a.start_time
                 and (loc.ts::time - time '00:00') + interval '15 minutes' <= (a.end_time - time '00:00')
            )
         );
$$;

-- The receipt object must exist in the private payment-receipts bucket. Skipped
-- on databases without Supabase Storage.
create or replace function app.receipt_exists(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if to_regclass('storage.objects') is null then
    return true;
  end if;
  return exists (select 1 from storage.objects o where o.bucket_id = 'payment-receipts' and o.name = p_path);
end;
$$;

-- What the events guard needs to know about a booking it is asked to link.
create or replace function app.booking_link_info(p_booking_id uuid)
returns table (booked_by uuid, court_id uuid, time_range tstzrange, booking_status public.booking_status, reserved_for_event_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select b.booked_by, b.court_id, b.time_range, b.booking_status, b.reserved_for_event_id
    from public.bookings b where b.id = p_booking_id;
$$;

-- -----------------------------------------------------------------------------
-- 3. Hold expiry: narrow, ordered, never blocking
-- -----------------------------------------------------------------------------
-- Inline path: only holds that overlap the new booking on its court, or the
-- coach's time when a coach is attached. Rows are locked in id order to avoid
-- deadlocks between concurrent bookings.
create or replace function app.expire_overlapping_holds(
  p_court_id uuid, p_coach_id uuid, p_start timestamptz, p_end timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.bookings b
     set booking_status      = 'CANCELLED',
         cancellation_reason = 'PAYMENT_WINDOW_EXPIRED',
         cancelled_by        = null
   where b.id in (
     select x.id
       from public.bookings x
      where x.booking_status = 'PENDING_PAYMENT'
        and x.payment_status in ('UNPAID', 'REJECTED')
        and x.payment_due_at <= now() - app.hold_grace()
        and x.reserved_for_event_id is null
        and x.time_range && tstzrange(p_start, p_end, '[)')
        and (x.court_id = p_court_id or (p_coach_id is not null and x.coach_id = p_coach_id))
      order by x.id
        for update
   );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Cron path: everything due, skipping rows another transaction holds (they're
-- retried next minute), so the sweep never blocks or deadlocks with bookings.
create or replace function app.expire_unpaid_bookings(p_court_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.bookings b
     set booking_status      = 'CANCELLED',
         cancellation_reason = 'PAYMENT_WINDOW_EXPIRED',
         cancelled_by        = null
   where b.id in (
     select x.id
       from public.bookings x
      where x.booking_status = 'PENDING_PAYMENT'
        and x.payment_status in ('UNPAID', 'REJECTED')
        and x.payment_due_at is not null
        and x.payment_due_at <= now() - app.hold_grace()
        and x.reserved_for_event_id is null
        and (p_court_id is null or x.court_id = p_court_id)
      order by x.id
        for update skip locked
   );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. The bookings guard (replaces 0500's; every Step 3 addition marked [Step 3])
-- -----------------------------------------------------------------------------
create or replace function app.tg_bookings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  r                 record;
  q                 record;
  v_actor           uuid    := auth.uid();
  v_trusted         boolean := app.is_trusted_context() or app.is_platform_admin();
  v_manager         boolean;
  v_slot_changed    boolean;
  v_local_start     timestamp;
  v_minutes         integer;
  v_active_holds    integer;
  v_booker_editable constant text[] := array[
    'payment_ref_no', 'payment_receipt_url', 'payment_status', 'booking_status',
    'cancellation_reason', 'notes', 'player_count', 'updated_at', 'time_range'
  ];
begin
  select * into r from app.court_booking_rules(new.court_id);
  if not found then
    raise exception using errcode = 'P0002', message = 'Court not found.';
  end if;

  new.venue_id := r.venue_id;
  v_manager    := v_trusted or app.is_venue_manager(r.venue_id);

  -- ===========================================================================
  -- UPDATE: immutables, terminal states, who-may-touch-what
  -- ===========================================================================
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.reference_code <> old.reference_code
       or new.booked_by <> old.booked_by or new.created_at <> old.created_at
       or new.created_by is distinct from old.created_by
       or new.idempotency_key is distinct from old.idempotency_key then
      raise exception using errcode = '42501', message = 'Booking identity fields are immutable.';
    end if;

    v_slot_changed := new.court_id   is distinct from old.court_id
                   or new.start_time is distinct from old.start_time
                   or new.end_time   is distinct from old.end_time
                   or new.coach_id   is distinct from old.coach_id;

    if old.booking_status in ('CANCELLED', 'COMPLETED')
       and (new.booking_status <> old.booking_status or v_slot_changed) then
      raise exception using errcode = '23514',
        message = format('A %s booking cannot be reopened or rescheduled.', lower(old.booking_status::text));
    end if;

    -- [Step 3] The event-reservation link is owned by the events trigger.
    if new.reserved_for_event_id is distinct from old.reserved_for_event_id and not app.is_trusted_context() then
      raise exception using errcode = '42501', message = 'Event links are managed through the event.';
    end if;
    -- [Step 3] A booking that holds the court for a live event can't be cancelled or moved.
    if old.reserved_for_event_id is not null and not v_trusted
       and (v_slot_changed or new.booking_status = 'CANCELLED') then
      raise exception using errcode = '23514',
        message = 'COURT_RESERVED_FOR_EVENT: This booking holds the court for an event. Cancel or move the event first.';
    end if;

    if v_slot_changed then
      if not v_manager then
        raise exception using errcode = '42501', message = 'Only the venue can reschedule a booking. Cancel and rebook instead.';
      end if;
      if new.court_id <> old.court_id and r.venue_id <> old.venue_id then
        raise exception using errcode = '42501', message = 'A booking cannot be moved to another venue.';
      end if;
    end if;

    if not app.is_trusted_context() then
      new.payment_submitted_at := old.payment_submitted_at;
      new.payment_verified_at  := old.payment_verified_at;
      new.payment_verified_by  := old.payment_verified_by;
      new.confirmed_at         := old.confirmed_at;
      new.cancelled_at         := old.cancelled_at;
      new.cancelled_by         := old.cancelled_by;
      new.completed_at         := old.completed_at;
      new.payment_due_at       := old.payment_due_at;
    end if;

    if not v_manager then
      if (to_jsonb(new) - v_booker_editable) is distinct from (to_jsonb(old) - v_booker_editable) then
        raise exception using errcode = '42501',
          message = 'You can only submit payment details, edit notes, or cancel this booking.';
      end if;

      if new.payment_status is distinct from old.payment_status
         and not (new.payment_status = 'AWAITING_VERIFICATION'
                  and old.payment_status in ('UNPAID', 'REJECTED')
                  and old.booking_status = 'PENDING_PAYMENT') then
        raise exception using errcode = '42501', message = 'Only the venue can verify, reject or refund a payment.';
      end if;

      -- [Step 3] Proof arriving after the hold (plus grace) expired would revive a slot others already see as free.
      if new.payment_status = 'AWAITING_VERIFICATION' and old.payment_status in ('UNPAID', 'REJECTED')
         and old.payment_due_at is not null and old.payment_due_at <= now() - app.hold_grace() then
        raise exception using errcode = '23514',
          message = 'HOLD_EXPIRED: Your hold on this slot has ended. If you already paid, book again with your reference number.';
      end if;

      if (new.payment_ref_no is distinct from old.payment_ref_no
          or new.payment_receipt_url is distinct from old.payment_receipt_url)
         and not (old.payment_status in ('UNPAID', 'REJECTED', 'AWAITING_VERIFICATION')
                  and new.payment_status = 'AWAITING_VERIFICATION') then
        raise exception using errcode = '42501', message = 'PAYMENT_LOCKED: Payment details are locked once the venue has verified them.';
      end if;

      if new.booking_status is distinct from old.booking_status then
        if new.booking_status <> 'CANCELLED' then
          raise exception using errcode = '42501', message = 'Players can only cancel a booking.';
        end if;
        -- [Step 3] Never after the session started.
        if now() >= old.start_time then
          raise exception using errcode = '23514',
            message = 'CANCELLATION_CLOSED: This booking has already started. Please contact the venue.';
        end if;
        -- [Step 3] The cutoff also applies once money has been sent, verified or not.
        if (old.booking_status = 'CONFIRMED' or old.payment_status = 'AWAITING_VERIFICATION')
           and now() > old.start_time - make_interval(hours => r.cancellation_cutoff_hours) then
          raise exception using errcode = '23514',
            message = format('CANCELLATION_CUTOFF: Bookings can only be cancelled up to %s hour(s) before start. Please contact the venue.',
                             r.cancellation_cutoff_hours);
        end if;
      end if;
    end if;

    -- [Step 3] A receipt must be this booking's own uploaded file (no reusing an old screenshot).
    if new.payment_receipt_url is distinct from old.payment_receipt_url and new.payment_receipt_url is not null
       and not app.is_trusted_context()
       and (split_part(new.payment_receipt_url, '/', 1) <> new.id::text
            or new.payment_receipt_url !~ '^[^/]+/[^/]+$'
            or not app.receipt_exists(new.payment_receipt_url)) then
      raise exception using errcode = '23514',
        message = 'RECEIPT_INVALID: Upload the receipt for this booking before submitting it.';
    end if;
  end if;

  -- ===========================================================================
  -- [Step 3] Who the booking is for (INSERT)
  -- ===========================================================================
  if tg_op = 'INSERT' then
    if not app.is_trusted_context() then
      new.created_by            := v_actor;
      new.reserved_for_event_id := null;
      new.payment_receipt_url   := null;   -- proofs are submitted after the booking exists
    else
      new.created_by := coalesce(new.created_by, v_actor, new.booked_by);
    end if;

    if not v_trusted then
      if new.booked_by <> v_actor then
        if not v_manager then
          raise exception using errcode = '42501', message = 'You can only book for yourself.';
        end if;
        if not r.venue_is_verified then
          raise exception using errcode = '42501',
            message = 'Only verified venues can book on behalf of a player. Record a walk-in instead.';
        end if;
        if new.coach_id is not null then
          raise exception using errcode = '42501', message = 'Coach sessions must be booked by the player.';
        end if;
      end if;
      if (new.walk_in_name is not null or new.walk_in_phone is not null)
         and not (v_manager and new.booked_by = v_actor) then
        raise exception using errcode = '42501', message = 'Only venue staff can record walk-ins.';
      end if;
      if not v_manager and coalesce(new.discount_amount, 0) <> 0 then
        raise exception using errcode = '42501', message = 'Only venue staff can apply discounts.';
      end if;
    end if;
  end if;

  -- ===========================================================================
  -- Slot rules (new bookings and reschedules)
  -- ===========================================================================
  if tg_op = 'INSERT' or v_slot_changed then
    if not v_manager then
      if not (r.venue_is_active and r.court_is_active) then
        raise exception using errcode = '23514', message = 'COURT_INACTIVE: This court is not accepting bookings.';
      end if;
      if new.start_time < now() then
        raise exception using errcode = '23514', message = 'SLOT_IN_PAST: That time has already started. Pick another slot.';
      end if;
      if new.start_time < now() + make_interval(mins => r.min_lead_minutes) then
        raise exception using errcode = '23514',
          message = format('TOO_SOON: This venue takes bookings at least %s minutes ahead.', r.min_lead_minutes);
      end if;
      -- Day-based horizon in venue time: a whole day opens at local midnight.
      if (new.start_time at time zone r.timezone)::date > (now() at time zone r.timezone)::date + r.booking_horizon_days then
        raise exception using errcode = '23514',
          message = format('BEYOND_HORIZON: This venue takes bookings up to %s days ahead.', r.booking_horizon_days);
      end if;

      v_minutes     := extract(epoch from (new.end_time - new.start_time))::integer / 60;
      v_local_start := new.start_time at time zone r.timezone;
      if (extract(hour from v_local_start)::integer * 60 + extract(minute from v_local_start)::integer)
           % r.slot_increment_minutes <> 0
         or v_minutes % r.slot_increment_minutes <> 0 then
        raise exception using errcode = '23514',
          message = format('OFF_INCREMENT: This court books in %s-minute increments.', r.slot_increment_minutes);
      end if;
      if v_minutes < r.min_booking_minutes or v_minutes > r.max_booking_minutes then
        raise exception using errcode = '23514',
          message = format('DURATION_OUT_OF_RANGE: Booking length must be between %s and %s minutes.', r.min_booking_minutes, r.max_booking_minutes);
      end if;
      if r.has_operating_hours then
        if not app.is_within_operating_hours(r.venue_id, new.start_time, new.end_time) then
          raise exception using errcode = '23514', message = 'VENUE_CLOSED: The venue is closed during part of the selected time.';
        end if;
      elsif not r.is_open_24h then
        raise exception using errcode = '23514',
          message = 'VENUE_HOURS_NOT_SET: This venue hasn''t published its opening hours yet.';
      end if;
      if app.court_is_closed(new.court_id, r.venue_id, new.start_time, new.end_time) then
        raise exception using errcode = '23514', message = 'COURT_CLOSED: The court is closed during part of the selected time.';
      end if;
    end if;

    -- [Step 3] Coach rules apply to venue staff too: the coach's time isn't theirs to give away.
    if new.coach_id is not null and not app.is_trusted_context() then
      if new.coach_id = new.booked_by then
        raise exception using errcode = '23514', message = 'You cannot book yourself as the coach.';
      end if;
      if new.start_time < now()
         or (new.start_time at time zone r.timezone)::date > (now() at time zone r.timezone)::date + r.booking_horizon_days then
        raise exception using errcode = '23514', message = 'BEYOND_HORIZON: Coach sessions follow the venue''s booking horizon.';
      end if;
      if not app.is_within_coach_availability(new.coach_id, new.start_time, new.end_time, r.timezone) then
        raise exception using errcode = '23514',
          message = 'COACH_UNAVAILABLE: The coach isn''t available at that time. Check their schedule.';
      end if;
    end if;
  end if;

  -- ===========================================================================
  -- INSERT: initial state, limits and server-side pricing
  -- ===========================================================================
  if tg_op = 'INSERT' then
    -- [Step 3] Clear only expired holds that would collide with THIS booking (court or coach).
    perform app.expire_overlapping_holds(new.court_id, new.coach_id, new.start_time, new.end_time);

    if not v_trusted then
      new.payment_verified_at  := null;
      new.payment_verified_by  := null;
      new.confirmed_at         := null;
      new.cancelled_at         := null;
      new.cancelled_by         := null;
      new.completed_at         := null;
      new.payment_submitted_at := null;
    end if;

    if new.payment_method = 'CASH_ON_COURT' and not r.accepts_cash_on_court then
      raise exception using errcode = '23514', message = 'PAYMENT_METHOD_UNAVAILABLE: This venue does not accept cash on court.';
    elsif new.payment_method = 'GCASH' and not r.accepts_gcash then
      raise exception using errcode = '23514', message = 'PAYMENT_METHOD_UNAVAILABLE: This venue has not set up GCash payments.';
    elsif new.payment_method = 'MAYA' and not r.accepts_maya then
      raise exception using errcode = '23514', message = 'PAYMENT_METHOD_UNAVAILABLE: This venue has not set up Maya payments.';
    elsif new.payment_method = 'BANK_TRANSFER' and not r.accepts_bank_transfer then
      raise exception using errcode = '23514', message = 'PAYMENT_METHOD_UNAVAILABLE: This venue has not set up bank transfers.';
    end if;

    -- [Step 3] Pay first for last-minute e-wallet slots: an unpaid hold that
    -- would only expire after the start lets the court be resold mid-game.
    if not v_manager and new.payment_method <> 'CASH_ON_COURT' and new.payment_ref_no is null
       and new.start_time < now() + make_interval(mins => r.payment_window_minutes) then
      raise exception using errcode = '23514',
        message = format('PAY_FIRST: This slot starts within %s minutes. Send the payment first, then book with your reference number.',
                         r.payment_window_minutes);
    end if;

    -- [Step 3] Hold cap: one player can't squat a venue's courts with unpaid holds.
    if not v_manager then
      perform pg_advisory_xact_lock(hashtextextended('rackethub:holds:' || new.booked_by::text, 0));
      select count(*) into v_active_holds
        from public.bookings b
       where b.booked_by = new.booked_by
         and b.venue_id = r.venue_id
         and b.end_time > now()
         and (   (b.booking_status = 'PENDING_PAYMENT'
                  and not (b.payment_status in ('UNPAID', 'REJECTED') and b.payment_due_at <= now() - app.hold_grace()))
              or (b.booking_status = 'CONFIRMED' and b.payment_status = 'UNPAID'));
      if v_active_holds >= r.max_active_holds_per_player then
        raise exception using errcode = '23514',
          message = format('HOLD_LIMIT_REACHED: You already have %s unpaid booking(s) at this venue. Pay or cancel one first.',
                           v_active_holds);
      end if;
    end if;

    select * into q from public.quote_court_booking(new.court_id, new.start_time, new.end_time, new.coach_id);

    if not v_manager then
      new.court_amount    := q.court_amount;
      new.lights_amount   := q.lights_amount;
      new.coach_amount    := q.coach_amount;
      new.discount_amount := 0;
      new.total_amount    := q.total_amount;

      new.booking_status  := 'PENDING_PAYMENT';
      new.payment_status  := case
                               when new.payment_method <> 'CASH_ON_COURT' and new.payment_ref_no is not null
                                 then 'AWAITING_VERIFICATION'::public.payment_status
                               else 'UNPAID'::public.payment_status
                             end;
      new.payment_rejection_reason := null;

      if new.payment_method <> 'CASH_ON_COURT' then
        new.payment_due_at := now() + make_interval(mins => r.payment_window_minutes);
      end if;
    else
      -- Venue staff may discount or comp court time; [Step 3] never the coach's fee.
      new.court_amount    := coalesce(new.court_amount,  q.court_amount);
      new.lights_amount   := coalesce(new.lights_amount, q.lights_amount);
      new.coach_amount    := case when app.is_trusted_context() then coalesce(new.coach_amount, q.coach_amount) else q.coach_amount end;
      new.discount_amount := coalesce(new.discount_amount, 0);
      if new.discount_amount > new.court_amount + new.lights_amount then
        raise exception using errcode = '23514', message = 'A discount cannot exceed the court and lights amount.';
      end if;
      new.total_amount    := case when app.is_trusted_context() then coalesce(new.total_amount,
                                      new.court_amount + new.lights_amount + new.coach_amount - new.discount_amount)
                                  else new.court_amount + new.lights_amount + new.coach_amount - new.discount_amount end;
      if new.booking_status = 'PENDING_PAYMENT' and new.payment_method <> 'CASH_ON_COURT' and new.payment_status <> 'PAID' then
        new.payment_due_at := coalesce(new.payment_due_at, now() + make_interval(mins => r.payment_window_minutes));
      end if;
    end if;

    if new.payment_method = 'CASH_ON_COURT' then
      new.payment_due_at := null;
      if new.booking_status = 'PENDING_PAYMENT' and new.payment_status = 'UNPAID' and r.auto_confirm_cash_bookings then
        new.booking_status := 'CONFIRMED';
      end if;
    end if;
  end if;

  -- ===========================================================================
  -- State machines (all actors, trusted included)
  -- ===========================================================================
  if tg_op = 'UPDATE' and new.payment_status is distinct from old.payment_status then
    if not (
         (old.payment_status = 'UNPAID'                and new.payment_status in ('AWAITING_VERIFICATION', 'PAID'))
      or (old.payment_status = 'AWAITING_VERIFICATION' and new.payment_status in ('PAID', 'REJECTED'))
      or (old.payment_status = 'REJECTED'              and new.payment_status in ('AWAITING_VERIFICATION', 'PAID'))
      or (old.payment_status = 'PAID'                  and new.payment_status = 'REFUNDED')
    ) then
      raise exception using errcode = '23514',
        message = format('Invalid payment transition %s → %s.', old.payment_status, new.payment_status);
    end if;
  end if;

  if tg_op = 'UPDATE' and new.booking_status is distinct from old.booking_status then
    if not (
         (old.booking_status = 'PENDING_PAYMENT' and new.booking_status in ('CONFIRMED', 'CANCELLED'))
      or (old.booking_status = 'CONFIRMED'       and new.booking_status in ('COMPLETED', 'CANCELLED'))
    ) then
      raise exception using errcode = '23514',
        message = format('Invalid booking transition %s → %s.', old.booking_status, new.booking_status);
    end if;
    if new.booking_status = 'COMPLETED' and not app.is_trusted_context() and now() < new.start_time then
      raise exception using errcode = '23514', message = 'A booking cannot be completed before it starts.';
    end if;
  end if;

  if new.payment_status = 'PAID'
     and (tg_op = 'INSERT' or old.payment_status <> 'PAID')
     and new.booking_status = 'PENDING_PAYMENT' then
    new.booking_status := 'CONFIRMED';
  end if;

  if new.booking_status = 'CONFIRMED' and new.payment_status <> 'PAID'
     and not (new.payment_method = 'CASH_ON_COURT' and new.payment_status = 'UNPAID') then
    raise exception using errcode = '23514', message = 'Verify the payment before confirming this booking.';
  end if;

  -- ===========================================================================
  -- Stamps
  -- ===========================================================================
  if new.payment_status = 'AWAITING_VERIFICATION'
     and (tg_op = 'INSERT' or old.payment_status <> 'AWAITING_VERIFICATION'
          or new.payment_ref_no is distinct from old.payment_ref_no
          or new.payment_receipt_url is distinct from old.payment_receipt_url) then
    new.payment_submitted_at     := now();
    new.payment_rejection_reason := null;
  end if;

  if new.payment_status in ('PAID', 'REJECTED')
     and (tg_op = 'INSERT' or old.payment_status is distinct from new.payment_status) then
    new.payment_verified_at := coalesce(case when app.is_trusted_context() then new.payment_verified_at end, now());
    new.payment_verified_by := case when app.is_trusted_context() then coalesce(new.payment_verified_by, v_actor) else v_actor end;
  end if;

  if new.payment_status = 'REJECTED' and tg_op = 'UPDATE' and old.payment_status <> 'REJECTED' then
    new.payment_due_at := now() + make_interval(mins => r.payment_window_minutes);
  end if;

  if new.booking_status in ('CONFIRMED', 'COMPLETED') and new.confirmed_at is null then
    new.confirmed_at := now();
  end if;
  if new.booking_status = 'COMPLETED' and new.completed_at is null then
    new.completed_at := now();
  end if;
  if new.booking_status = 'CANCELLED' and (tg_op = 'INSERT' or old.booking_status <> 'CANCELLED') then
    new.cancelled_at := now();
    if not app.is_trusted_context() then
      new.cancelled_by := v_actor;
    end if;
    new.cancellation_reason := coalesce(new.cancellation_reason, 'CANCELLED_BY_USER');
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. The events guard (replaces 0700's; Step 3 additions marked)
-- -----------------------------------------------------------------------------
create or replace function app.tg_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_trusted  boolean := app.is_trusted_context() or app.is_platform_admin();
  v_link     record;
  v_venue    record;
  v_live     boolean := new.status in ('SCHEDULED', 'IN_PROGRESS');
begin
  if new.venue_id is not null
     and (tg_op = 'INSERT' or new.venue_id is distinct from old.venue_id) then
    select v.municipality_code, v.barangay_code into v_venue from public.venues v where v.id = new.venue_id;
    new.municipality_code := coalesce(v_venue.municipality_code, new.municipality_code);
    new.barangay_code     := case when v_venue.municipality_code is not null then v_venue.barangay_code else new.barangay_code end;
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not (
         (old.status = 'DRAFT'       and new.status in ('SCHEDULED', 'CANCELLED'))
      or (old.status = 'SCHEDULED'   and new.status in ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'))
      or (old.status = 'IN_PROGRESS' and new.status in ('COMPLETED', 'CANCELLED'))
    ) then
      raise exception using errcode = '23514',
        message = format('Invalid event transition %s → %s.', old.status, new.status);
    end if;
    if new.status = 'DRAFT' and old.registered_count + old.waitlisted_count > 0 then
      raise exception using errcode = '23514', message = 'An event with RSVPs cannot go back to draft.';
    end if;
    if new.status = 'CANCELLED' then
      new.cancelled_at := now();
    end if;
  end if;

  if tg_op = 'UPDATE' and new.max_participants < old.registered_count then
    raise exception using errcode = '23514',
      message = format('%s players are already registered; the cap cannot go below that.', old.registered_count);
  end if;

  if v_trusted then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.organizer_id     := auth.uid();
    new.registered_count := 0;
    new.waitlisted_count := 0;
    new.cancelled_at     := null;
    if new.status not in ('DRAFT', 'SCHEDULED') then
      raise exception using errcode = '23514', message = 'New events start as DRAFT or SCHEDULED.';
    end if;
    if new.start_time < now() then
      raise exception using errcode = '23514', message = 'Events must start in the future.';
    end if;
    if new.club_id is not null and coalesce(app.club_role_of(new.club_id)::text, '') not in ('ADMIN', 'COACH') then
      raise exception using errcode = '42501', message = 'Only club admins and club coaches can create club events.';
    end if;
  else
    if new.organizer_id <> old.organizer_id or new.club_id is distinct from old.club_id then
      raise exception using errcode = '42501', message = 'The organiser and club of an event cannot be changed.';
    end if;
    new.registered_count := old.registered_count;
    new.waitlisted_count := old.waitlisted_count;
    if old.status in ('COMPLETED', 'CANCELLED') then
      raise exception using errcode = '23514', message = 'Finished or cancelled events are read-only.';
    end if;
  end if;

  if new.coach_id is not null
     and (tg_op = 'INSERT' or new.coach_id is distinct from old.coach_id)
     and not exists (
       select 1 from public.coach_profiles cp
        where cp.profile_id = new.coach_id
          and cp.verified_status = 'VERIFIED'
          and new.sport = any (cp.sports_coached)
     ) then
    raise exception using errcode = '23514', message = 'Clinics must be led by a verified coach of this sport.';
  end if;

  -- [Step 3] Coach consent. Naming a coach, or moving the event, needs the coach to (re)confirm.
  if new.coach_id is null then
    new.coach_confirmed_at := null;
  elsif tg_op = 'INSERT' or new.coach_id is distinct from old.coach_id
        or new.start_time <> old.start_time or new.end_time <> old.end_time then
    new.coach_confirmed_at := case when new.coach_id = auth.uid() then now() end;
  elsif new.coach_confirmed_at is distinct from old.coach_confirmed_at then
    if new.coach_id <> auth.uid() then
      raise exception using errcode = '42501', message = 'Only the coach can accept or decline.';
    end if;
    new.coach_confirmed_at := case when new.coach_confirmed_at is not null then now() end;
  end if;
  if v_live and new.coach_id is not null and new.coach_confirmed_at is null then
    raise exception using errcode = '23514',
      message = 'COACH_CONFIRMATION_REQUIRED: The coach has to accept before this event can be published.';
  end if;

  -- [Step 3] A live event on a court must sit on the organiser's own confirmed booking.
  if v_live and new.court_id is not null and new.booking_id is null then
    raise exception using errcode = '23514',
      message = 'COURT_BOOKING_REQUIRED: Book and pay for the court before publishing an event on it.';
  end if;

  if new.booking_id is not null
     and (tg_op = 'INSERT'
          or new.booking_id is distinct from old.booking_id
          or new.court_id   is distinct from old.court_id
          or new.venue_id   is distinct from old.venue_id
          or new.start_time <> old.start_time or new.end_time <> old.end_time
          or new.status     is distinct from old.status) then
    select * into v_link from app.booking_link_info(new.booking_id);
    if not found
       or v_link.booked_by <> new.organizer_id
       or v_link.court_id is distinct from new.court_id
       or not (v_link.time_range @> tstzrange(new.start_time, new.end_time, '[)'))
       or v_link.booking_status = 'CANCELLED'
       or (v_live and v_link.booking_status <> 'CONFIRMED' and v_link.booking_status <> 'COMPLETED')
       or (v_link.reserved_for_event_id is not null and v_link.reserved_for_event_id <> new.id) then
      raise exception using errcode = '23514',
        message = 'COURT_BOOKING_UNAVAILABLE: Link a confirmed booking of yours that covers the event on the same court.';
    end if;
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Event ↔ booking reservation (written onto the booking row)
-- -----------------------------------------------------------------------------
create or replace function app.tg_events_reserve_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_live_new boolean := tg_op <> 'DELETE' and new.status in ('SCHEDULED', 'IN_PROGRESS') and new.booking_id is not null;
  v_was_live boolean := tg_op <> 'INSERT' and old.status in ('SCHEDULED', 'IN_PROGRESS') and old.booking_id is not null;
begin
  -- Release the old reservation.
  if v_was_live and (not v_live_new or new.booking_id is distinct from old.booking_id) then
    update public.bookings b set reserved_for_event_id = null
     where b.id = old.booking_id and b.reserved_for_event_id = old.id;
  end if;

  -- Take the new one. The UPDATE row-locks the booking: a concurrent cancel or
  -- reschedule either waits and then sees the reservation (READ COMMITTED) or
  -- fails with 40001 (REPEATABLE READ). There's no window for write skew.
  if v_live_new and (not v_was_live or new.booking_id is distinct from old.booking_id) then
    update public.bookings b set reserved_for_event_id = new.id
     where b.id = new.booking_id
       and b.booking_status = 'CONFIRMED'
       and b.reserved_for_event_id is null;
    if not found and not exists (
      select 1 from public.bookings b where b.id = new.booking_id and b.reserved_for_event_id = new.id
    ) then
      raise exception using errcode = '23514',
        message = 'COURT_BOOKING_UNAVAILABLE: That court booking is no longer confirmed or is already used by another event.';
    end if;
  end if;
  return null;
end;
$$;

create trigger events_30_reserve_booking
  after insert or update of booking_id, status on public.events
  for each row execute function app.tg_events_reserve_booking();

-- -----------------------------------------------------------------------------
-- 7. Coach commitments ledger
-- -----------------------------------------------------------------------------
create table app.coach_commitments (
  source_kind  text not null,
  source_id    uuid not null,
  coach_id     uuid not null,
  time_range   tstzrange not null,
  primary key (source_kind, source_id),
  constraint coach_commitments_source_kind check (source_kind in ('BOOKING', 'EVENT')),
  constraint coach_commitments_no_overlap exclude using gist (coach_id with =, time_range with &&)
);

revoke all on app.coach_commitments from public;
comment on table app.coach_commitments is
  'Every live claim on a coach''s time (coached bookings, coach-confirmed events). The EXCLUDE constraint is the single source of truth for coach double-booking.';

-- One function decides what a source's ledger row should be, from the current
-- table state; the triggers just ask it to re-sync the sources they touched.
--   BOOKING: live while not cancelled. Always keeps its row, including when it
--            is the court booking of its own coach's event.
--   EVENT:   live once SCHEDULED/IN_PROGRESS with the coach's confirmation,
--            unless its linked booking already commits the same coach over
--            the whole event (the booking's row covers it).
create or replace function app.sync_coach_commitment(p_kind text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_coach   uuid;
  v_range   tstzrange;
  v_current app.coach_commitments;
begin
  if p_kind = 'BOOKING' then
    select b.coach_id, b.time_range into v_coach, v_range
      from public.bookings b
     where b.id = p_id and b.coach_id is not null and b.booking_status <> 'CANCELLED';
  else
    select e.coach_id, tstzrange(e.start_time, e.end_time, '[)') into v_coach, v_range
      from public.events e
     where e.id = p_id
       and e.coach_id is not null
       and e.coach_confirmed_at is not null
       and e.status in ('SCHEDULED', 'IN_PROGRESS')
       and not exists (
             select 1 from public.bookings b
              where b.id = e.booking_id
                and b.coach_id = e.coach_id
                and b.booking_status <> 'CANCELLED'
                and b.time_range @> tstzrange(e.start_time, e.end_time, '[)'));
  end if;

  select * into v_current from app.coach_commitments c where c.source_kind = p_kind and c.source_id = p_id;

  -- Unchanged: touch nothing, so sweeps that only flip statuses never re-check
  -- (and never trip over) clashes left over from before the ledger existed.
  if v_current.source_id is not null and v_current.coach_id = v_coach and v_current.time_range = v_range then
    return;
  end if;

  if v_current.source_id is not null then
    delete from app.coach_commitments c where c.source_kind = p_kind and c.source_id = p_id;
  end if;
  if v_coach is null then
    return;
  end if;

  -- An event going live over the coach's dead-but-unswept hold must not fail.
  -- (Bookings already expire overlapping holds in the guard.)
  if p_kind = 'EVENT' then
    perform app.expire_overlapping_holds(null, v_coach, lower(v_range), upper(v_range));
  end if;

  begin
    insert into app.coach_commitments (source_kind, source_id, coach_id, time_range)
    values (p_kind, p_id, v_coach, v_range);
  exception when exclusion_violation then
    -- Re-raise without the DETAIL (which would expose the coach's other commitment).
    raise exception using errcode = '23P01', constraint = 'coach_commitments_no_overlap',
      message = 'COACH_UNAVAILABLE: This coach is already booked at that time.';
  end;
end;
$$;

create or replace function app.tg_sync_coach_commitments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid := case when tg_op = 'DELETE' then old.id else new.id end;
  v_event uuid;
begin
  -- Status flips that leave the commitment as it was (CONFIRMED → COMPLETED,
  -- SCHEDULED → IN_PROGRESS) skip the ledger entirely, so the multi-row sweeps
  -- never re-check, or abort on, a clash that predates the ledger.
  if tg_op = 'UPDATE' then
    if tg_table_name = 'bookings' then
      if new.coach_id is not distinct from old.coach_id
         and new.start_time = old.start_time and new.end_time = old.end_time
         and (new.booking_status = 'CANCELLED') = (old.booking_status = 'CANCELLED') then
        return null;
      end if;
    elsif new.coach_id is not distinct from old.coach_id
          and new.start_time = old.start_time and new.end_time = old.end_time
          and new.booking_id is not distinct from old.booking_id
          and (new.coach_confirmed_at is null) = (old.coach_confirmed_at is null)
          and (new.status in ('SCHEDULED', 'IN_PROGRESS')) = (old.status in ('SCHEDULED', 'IN_PROGRESS')) then
      return null;
    end if;
  end if;

  if tg_table_name = 'bookings' then
    perform app.sync_coach_commitment('BOOKING', v_id);
    -- The event this booking covers may need its own row back (booking
    -- cancelled or moved by a trusted actor), or no longer need it.
    v_event := case when tg_op = 'DELETE' then old.reserved_for_event_id else new.reserved_for_event_id end;
    if v_event is not null then
      perform app.sync_coach_commitment('EVENT', v_event);
    end if;
  else
    perform app.sync_coach_commitment('EVENT', v_id);
  end if;
  return null;
end;
$$;

-- AFTER triggers see the final row (after every BEFORE guard rewrote it).
-- reserved_for_event_id is not in the list: linking never changes a booking's
-- own commitment, and the event side re-syncs itself on booking_id changes.
create trigger bookings_40_coach_commitments
  after insert or update of coach_id, start_time, end_time, booking_status or delete
  on public.bookings
  for each row execute function app.tg_sync_coach_commitments();

create trigger events_40_coach_commitments
  after insert or update of coach_id, coach_confirmed_at, start_time, end_time, status, booking_id or delete
  on public.events
  for each row execute function app.tg_sync_coach_commitments();

-- Backfill from existing data. Clashes that already exist are reported, not fatal.
do $$
declare
  rec record;
begin
  for rec in
    select 'BOOKING' as kind, b.id, b.coach_id, b.time_range from public.bookings b
     where b.coach_id is not null and b.booking_status <> 'CANCELLED'
    union all
    select 'EVENT', e.id, e.coach_id, tstzrange(e.start_time, e.end_time, '[)') from public.events e
     where e.coach_id is not null and e.coach_confirmed_at is not null and e.status in ('SCHEDULED', 'IN_PROGRESS')
       and not exists (select 1 from public.bookings b
                        where b.id = e.booking_id and b.coach_id = e.coach_id and b.booking_status <> 'CANCELLED'
                          and b.time_range @> tstzrange(e.start_time, e.end_time, '[)'))
  loop
    begin
      insert into app.coach_commitments (source_kind, source_id, coach_id, time_range)
      values (rec.kind, rec.id, rec.coach_id, rec.time_range)
      on conflict (source_kind, source_id) do nothing;
    exception when exclusion_violation then
      raise warning 'Existing coach clash left unresolved: % %', rec.kind, rec.id;
    end;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Contact visibility: only bookings the player made themselves count
-- -----------------------------------------------------------------------------
create or replace function app.can_view_contact(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
       p_profile_id = auth.uid()
    or app.is_platform_admin()
    or exists (
         select 1
           from public.bookings b
           join public.venues v on v.id = b.venue_id
           left join public.venue_managers vm on vm.venue_id = v.id and vm.profile_id = auth.uid()
          where b.booked_by = p_profile_id
            and b.created_by = b.booked_by
            and b.booking_status <> 'CANCELLED'
            and (v.owner_id = auth.uid() or vm.profile_id is not null))
    or exists (
         select 1 from public.bookings b
          where b.booking_status <> 'CANCELLED'
            and b.created_by = b.booked_by
            and (   (b.coach_id = auth.uid() and b.booked_by = p_profile_id)
                 or (b.booked_by = auth.uid() and b.coach_id = p_profile_id)))
    or exists (
         select 1 from public.event_attendees a
          where a.profile_id = p_profile_id
            and a.status in ('REGISTERED', 'CHECKED_IN', 'WAITLISTED')
            and app.is_event_manager(a.event_id))
  );
$$;

-- -----------------------------------------------------------------------------
-- 9. create_booking(): the app's single entry point
-- -----------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: RLS and every guard rule apply to the caller.
-- (Making it DEFINER would make the guard treat every caller as trusted.)
-- Under REPEATABLE READ a twin that commits after our snapshot is reported as
-- the original conflict; the TS layer then looks the key up in a new
-- transaction (see src/server/bookings).
create or replace function public.create_booking(
  p_court_id        uuid,
  p_start           timestamptz,
  p_end             timestamptz,
  p_payment_method  public.payment_method,
  p_idempotency_key uuid     default null,
  p_coach_id        uuid     default null,
  p_payment_ref_no  text     default null,
  p_player_count    smallint default null,
  p_notes           text     default null,
  p_booked_by       uuid     default null,
  p_walk_in_name    text     default null,
  p_walk_in_phone   text     default null,
  p_discount_amount numeric  default null,
  p_mark_paid       boolean  default false
)
returns public.bookings
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := auth.uid();
  v_row    public.bookings;
  v_mine   uuid;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'Sign in to book a court.';
  end if;
  -- Cash collected at the desk right now: staff only.
  if p_mark_paid and not app.is_venue_manager((select r.venue_id from app.court_booking_rules(p_court_id) r)) then
    raise exception using errcode = '42501', message = 'Only venue staff can mark a booking as paid.';
  end if;

  -- Fast path for a retry whose first attempt already committed. Twins with the
  -- same key queue on this lock (taken before the guard's hold-cap lock, so the
  -- order is always idempotency → holds → rows) and the second one finds the
  -- first's row instead of tripping the hold cap or the slot constraint.
  if p_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('rackethub:idem:' || v_actor::text || ':' || p_idempotency_key::text, 0));
    select * into v_row from public.bookings b
     where b.created_by = v_actor and b.idempotency_key = p_idempotency_key;
  end if;

  if v_row.id is null then
    -- Plain INSERT, not INSERT … ON CONFLICT: ON CONFLICT switches to
    -- speculative insertion, and two speculative inserts that clash on the
    -- court/coach exclusion constraints can deadlock on each other's
    -- speculative tokens (seen in tests/db/concurrency.sh). Instead, a twin
    -- with the same key is detected after the fact.
    begin
      insert into public.bookings (
        court_id, booked_by, coach_id, start_time, end_time, payment_method, payment_ref_no,
        player_count, notes, idempotency_key, walk_in_name, walk_in_phone, discount_amount, payment_status
      ) values (
        p_court_id, coalesce(p_booked_by, v_actor), p_coach_id, p_start, p_end, p_payment_method, p_payment_ref_no,
        p_player_count, p_notes, p_idempotency_key, p_walk_in_name, p_walk_in_phone, p_discount_amount,
        case when p_mark_paid then 'PAID' else 'UNPAID' end::public.payment_status
      )
      returning * into v_row;
      return v_row;
    exception when unique_violation or exclusion_violation then
      -- A concurrent twin with our key committed first: under READ COMMITTED this
      -- fresh statement sees it. Anything else is a genuine conflict and is
      -- re-raised unchanged (constraint name intact for the TS error mapping).
      if p_idempotency_key is not null then
        select * into v_row from public.bookings b
         where b.created_by = v_actor and b.idempotency_key = p_idempotency_key;
      end if;
      if v_row.id is null then
        -- "Taken" by the caller's own live booking (e.g. a retry with a new key):
        -- say so, instead of blaming someone else.
        select b.id into v_mine from public.bookings b
         where b.court_id = p_court_id and b.booked_by = coalesce(p_booked_by, v_actor)
           and b.booking_status <> 'CANCELLED'
           and b.time_range && tstzrange(p_start, p_end, '[)')
         limit 1;
        if v_mine is not null then
          raise exception using errcode = '23P01', hint = v_mine::text,
            message = 'SLOT_ALREADY_YOURS: You already have this court at that time.';
        end if;
        raise;
      end if;
    end;
  end if;

  -- Replay: the key must describe the same booking.
  if v_row.court_id <> p_court_id or v_row.start_time <> p_start or v_row.end_time <> p_end
     or v_row.payment_method <> p_payment_method
     or v_row.coach_id is distinct from p_coach_id
     or v_row.booked_by <> coalesce(p_booked_by, v_actor) then
    raise exception using errcode = '22023',
      message = 'IDEMPOTENCY_KEY_REUSED: This checkout was already used for a different booking. Start a new checkout.';
  end if;
  return v_row;
end;
$$;

revoke all on function public.create_booking(uuid, timestamptz, timestamptz, public.payment_method, uuid, uuid, text, smallint, text, uuid, text, text, numeric, boolean) from public, anon;
grant execute on function public.create_booking(uuid, timestamptz, timestamptz, public.payment_method, uuid, uuid, text, smallint, text, uuid, text, text, numeric, boolean) to authenticated, service_role;

comment on function public.create_booking is
  'Creates a court booking as the caller (RLS + guard rules apply). Idempotent per p_idempotency_key: a retry returns the original booking (whatever its current status), a mismatched replay raises IDEMPOTENCY_KEY_REUSED.';

-- -----------------------------------------------------------------------------
-- 10. Availability RPCs (times only, no identities)
-- -----------------------------------------------------------------------------
drop function if exists public.get_court_busy_slots(uuid, timestamptz, timestamptz);

-- Shared core. Times only, plus details about the caller's OWN bookings.
--   kind = 'BOOKED' (confirmed or awaiting verification), 'HOLD' (unpaid, frees
--          itself at held_until unless paid) or 'CLOSED' (court closure)
--   is_mine / booking_id only for the caller's own player bookings (never walk-ins)
create or replace function app.busy_slots(p_venue_id uuid, p_court_id uuid, p_from timestamptz, p_to timestamptz)
returns table (court_id uuid, start_time timestamptz, end_time timestamptz, kind text,
               is_mine boolean, booking_id uuid, held_until timestamptz, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception using errcode = '22023', message = 'Invalid range.';
  end if;
  if p_to - p_from > interval '31 days' then
    raise exception using errcode = '22023', message = 'Range is limited to 31 days.';
  end if;

  return query
    select b.court_id, b.start_time, b.end_time,
           case when b.booking_status = 'PENDING_PAYMENT' and b.payment_status in ('UNPAID', 'REJECTED')
                then 'HOLD' else 'BOOKED' end,
           coalesce(b.booked_by = auth.uid() and b.walk_in_name is null, false),
           case when b.booked_by = auth.uid() and b.walk_in_name is null then b.id end,
           case when b.booking_status = 'PENDING_PAYMENT' and b.payment_status in ('UNPAID', 'REJECTED')
                then b.payment_due_at + app.hold_grace() end,
           null::text
      from public.bookings b
     where (p_court_id is null or b.court_id = p_court_id)
       and (p_venue_id is null or b.venue_id = p_venue_id)
       and b.booking_status <> 'CANCELLED'
       and b.time_range && tstzrange(p_from, p_to, '[)')
       and not (b.booking_status = 'PENDING_PAYMENT'
                and b.payment_status in ('UNPAID', 'REJECTED')
                and b.payment_due_at <= now() - app.hold_grace())
    union all
    select c.id, k.starts_at, k.ends_at, 'CLOSED', false, null::uuid, null::timestamptz, k.reason
      from public.court_closures k
      join public.courts c on c.venue_id = k.venue_id and (k.court_id is null or k.court_id = c.id)
     where (p_court_id is null or c.id = p_court_id)
       and (p_venue_id is null or k.venue_id = p_venue_id)
       and tstzrange(k.starts_at, k.ends_at, '[)') && tstzrange(p_from, p_to, '[)')
     order by 1, 2;
end;
$$;

create function public.get_court_busy_slots(p_court_id uuid, p_from timestamptz, p_to timestamptz)
returns table (start_time timestamptz, end_time timestamptz, kind text, is_mine boolean, booking_id uuid,
               held_until timestamptz, reason text)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.start_time, s.end_time, s.kind, s.is_mine, s.booking_id, s.held_until, s.reason
    from app.busy_slots(null, p_court_id, p_from, p_to) s;
$$;

-- All courts of a venue in one call ("any court free at 7pm?").
create or replace function public.get_venue_busy_slots(p_venue_id uuid, p_from timestamptz, p_to timestamptz)
returns table (court_id uuid, start_time timestamptz, end_time timestamptz, kind text, is_mine boolean,
               booking_id uuid, held_until timestamptz, reason text)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from app.busy_slots(p_venue_id, null, p_from, p_to);
$$;

revoke all on function public.get_court_busy_slots(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_court_busy_slots(uuid, timestamptz, timestamptz) to anon, authenticated, service_role;
revoke all on function public.get_venue_busy_slots(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_venue_busy_slots(uuid, timestamptz, timestamptz) to anon, authenticated, service_role;

-- A coach's busy time (live coached bookings + confirmed events), times only.
create or replace function public.get_coach_busy_slots(
  p_coach_id  uuid,
  p_from      timestamptz,
  p_to        timestamptz
)
returns table (start_time timestamptz, end_time timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception using errcode = '22023', message = 'Invalid range.';
  end if;
  if p_to - p_from > interval '31 days' then
    raise exception using errcode = '22023', message = 'Range is limited to 31 days.';
  end if;

  return query
    select lower(c.time_range), upper(c.time_range)
      from app.coach_commitments c
      left join public.bookings b on c.source_kind = 'BOOKING' and b.id = c.source_id
     where c.coach_id = p_coach_id
       and c.time_range && tstzrange(p_from, p_to, '[)')
       and not (b.id is not null
                and b.booking_status = 'PENDING_PAYMENT'
                and b.payment_status in ('UNPAID', 'REJECTED')
                and b.payment_due_at <= now() - app.hold_grace())
     order by 1;
end;
$$;

revoke all on function public.get_coach_busy_slots(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_coach_busy_slots(uuid, timestamptz, timestamptz) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 11. Realtime: private, receive-only slot topics
-- -----------------------------------------------------------------------------
create or replace function app.tg_broadcast_court_slots()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_busy boolean := tg_op <> 'INSERT' and old.booking_status <> 'CANCELLED';
  v_new_busy boolean := tg_op <> 'DELETE' and new.booking_status <> 'CANCELLED';
  v_moved    boolean := tg_op = 'UPDATE'
                        and (new.court_id <> old.court_id or new.start_time <> old.start_time or new.end_time <> old.end_time);
  -- held_until changes (paid, proof submitted, proof rejected → new window):
  -- the slot stays busy but its kind/expiry changed, so re-announce it.
  v_old_held timestamptz := case when tg_op <> 'INSERT' and old.booking_status = 'PENDING_PAYMENT'
                                      and old.payment_status in ('UNPAID', 'REJECTED')
                                 then old.payment_due_at + app.hold_grace() end;
  v_new_held timestamptz := case when tg_op <> 'DELETE' and new.booking_status = 'PENDING_PAYMENT'
                                      and new.payment_status in ('UNPAID', 'REJECTED')
                                 then new.payment_due_at + app.hold_grace() end;
begin
  -- Runs on every Supabase project. Test databases without Realtime skip it.
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;

  if v_old_busy and (not v_new_busy or v_moved) then
    perform realtime.send(
      jsonb_build_object('court_id', old.court_id, 'start_time', old.start_time, 'end_time', old.end_time, 'busy', false),
      'slot_changed', 'court:' || old.court_id || ':slots', true);
  end if;
  if v_new_busy and (not v_old_busy or v_moved or v_old_held is distinct from v_new_held) then
    perform realtime.send(
      jsonb_build_object('court_id', new.court_id, 'start_time', new.start_time, 'end_time', new.end_time, 'busy', true,
                         'held_until', v_new_held),
      'slot_changed', 'court:' || new.court_id || ':slots', true);
  end if;
  return null;
end;
$$;

create trigger bookings_50_broadcast_slots
  after insert or update of court_id, start_time, end_time, booking_status, payment_status, payment_due_at or delete on public.bookings
  for each row execute function app.tg_broadcast_court_slots();

-- Closures change availability too; notify every affected court's topic.
create or replace function app.tg_broadcast_closures()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    for c in
      select ct.id from public.courts ct where ct.venue_id = old.venue_id and (old.court_id is null or ct.id = old.court_id)
    loop
      perform realtime.send(
        jsonb_build_object('court_id', c.id, 'start_time', old.starts_at, 'end_time', old.ends_at, 'busy', false),
        'slot_changed', 'court:' || c.id || ':slots', true);
    end loop;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    for c in
      select ct.id from public.courts ct where ct.venue_id = new.venue_id and (new.court_id is null or ct.id = new.court_id)
    loop
      perform realtime.send(
        jsonb_build_object('court_id', c.id, 'start_time', new.starts_at, 'end_time', new.ends_at, 'busy', true),
        'slot_changed', 'court:' || c.id || ':slots', true);
    end loop;
  end if;
  return null;
end;
$$;

create trigger court_closures_broadcast
  after insert or update or delete on public.court_closures
  for each row execute function app.tg_broadcast_closures();

-- Anyone may RECEIVE court slot broadcasts. There's no INSERT policy, so no
-- client can SEND (spoof) on these topics.
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists "court slot topics are receivable" on realtime.messages';
    execute $p$
      create policy "court slot topics are receivable"
        on realtime.messages for select to anon, authenticated
        using (realtime.messages.extension = 'broadcast' and realtime.topic() like 'court:%:slots')
    $p$;
  else
    raise warning 'realtime.messages not found; skipping the broadcast authorization policy. Clients will not receive slot updates.';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. Privileges
-- -----------------------------------------------------------------------------
-- New columns that must never be client-writable after insert are already
-- outside the column-level UPDATE grant from 0900. Helpers called from
-- invoker guards need EXECUTE for the API roles.
grant execute on function app.court_booking_rules(uuid) to authenticated, service_role;
grant execute on function app.is_within_coach_availability(uuid, timestamptz, timestamptz, text) to authenticated, service_role;
grant execute on function app.receipt_exists(text) to authenticated, service_role;
grant execute on function app.booking_link_info(uuid) to authenticated, service_role;
grant execute on function app.expire_overlapping_holds(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function app.expire_unpaid_bookings(uuid) to service_role;
grant execute on function app.hold_grace() to anon, authenticated, service_role;
grant execute on function app.court_is_closed(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function app.busy_slots(uuid, uuid, timestamptz, timestamptz) to anon, authenticated, service_role;
grant execute on function app.is_venue_manager(uuid) to authenticated, service_role;
revoke execute on function app.expire_unpaid_bookings(uuid) from authenticated;

-- Coaches confirm their events by updating this one column.
grant update (coach_confirmed_at) on public.events to authenticated;
-- Staff fix walk-in typos (the guard keeps players out of these columns).
grant update (walk_in_name, walk_in_phone) on public.bookings to authenticated;

-- Close the PUBLIC execute default on everything this migration defined in app.*
revoke execute on all functions in schema app from public;
