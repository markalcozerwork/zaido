-- =============================================================================
-- RacketHub · 0700 · Events: open play, clinics, tournaments; RSVPs & queue
-- =============================================================================
-- Capacity is enforced under a row lock on the event, so concurrent RSVPs
-- can't overfill it:
--
--   * Every attendee write first takes `SELECT … FOR UPDATE` on its event row,
--     which serialises RSVPs per event (other events are unaffected).
--   * The seat counters live ON that event row and are updated in the same
--     transaction. Under READ COMMITTED the next writer re-reads the
--     committed counter after the lock is released. Under REPEATABLE READ /
--     SERIALIZABLE it gets a serialization failure (40001) and retries. No
--     isolation level can overbook.
--   * When the event is full, a new RSVP becomes WAITLISTED instead of failing
--     (or fails with EVENT_FULL when the waitlist is disabled or full).
--   * Freeing a seat (cancel, removal, raising max_participants) promotes the
--     longest-waiting WAITLISTED attendee automatically, first in, first out.
-- =============================================================================

create table public.events (
  id                     uuid primary key default gen_random_uuid(),
  club_id                uuid references public.clubs (id) on delete cascade,
  venue_id               uuid references public.venues (id) on delete set null,
  court_id               uuid,
  booking_id             uuid references public.bookings (id) on delete set null,
  organizer_id           uuid not null references public.profiles (id) on delete restrict,
  coach_id               uuid references public.coach_profiles (profile_id) on delete restrict,

  title                  text not null,
  description            text,
  sport                  public.sport not null,
  event_type             public.event_type not null,
  tournament_format      public.tournament_format,
  rotation_format        public.rotation_format not null default 'NONE',
  min_skill_level        public.skill_level,
  max_skill_level        public.skill_level,

  -- Where, for discovery. Taken from the venue when there is one; set
  -- directly for unregistered spots (e.g. a barangay covered court).
  municipality_code      text references public.ph_municipalities (code) on update cascade,
  barangay_code          text,
  location_text          text,

  start_time             timestamptz not null,
  end_time               timestamptz not null,
  registration_deadline  timestamptz,

  max_participants       smallint not null,
  waitlist_enabled       boolean not null default true,
  waitlist_capacity      smallint,                  -- NULL = unlimited
  registered_count       smallint not null default 0,  -- REGISTERED + CHECKED_IN (trigger-maintained)
  waitlisted_count       smallint not null default 0,  -- WAITLISTED (trigger-maintained)

  fee_per_pax            numeric(10,2) not null default 0,
  is_private             boolean not null default false,
  status                 public.event_status not null default 'SCHEDULED',
  cancelled_at           timestamptz,
  cancellation_reason    text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint events_court_venue_fk foreign key (venue_id, court_id)
    references public.courts (venue_id, id) on delete set null (court_id),
  constraint events_barangay_fk foreign key (municipality_code, barangay_code)
    references public.ph_barangays (municipality_code, code) on update cascade,

  constraint events_title_length        check (char_length(btrim(title)) between 3 and 120),
  constraint events_description_length  check (description is null or char_length(description) <= 4000),
  constraint events_time_order          check (end_time > start_time),
  constraint events_max_duration        check (end_time - start_time <= interval '7 days'),
  constraint events_registration_deadline check (registration_deadline is null or registration_deadline <= end_time),
  constraint events_court_needs_venue   check (court_id is null or venue_id is not null),
  constraint events_has_location        check (venue_id is not null or municipality_code is not null),
  constraint events_tournament_format   check ((event_type = 'TOURNAMENT') = (tournament_format is not null)),
  constraint events_clinic_needs_coach  check (event_type <> 'CLINIC' or coach_id is not null),
  constraint events_private_needs_club  check (not is_private or club_id is not null),
  constraint events_skill_range         check (min_skill_level is null or max_skill_level is null or min_skill_level <= max_skill_level),
  constraint events_max_participants    check (max_participants between 2 and 512),
  constraint events_waitlist_capacity   check (waitlist_capacity is null or waitlist_capacity between 1 and 512),
  constraint events_fee                 check (fee_per_pax between 0 and 100000),
  constraint events_registered_count    check (registered_count between 0 and max_participants),
  constraint events_waitlisted_count    check (waitlisted_count >= 0
                                               and (waitlist_capacity is null or waitlisted_count <= waitlist_capacity)),
  constraint events_cancelled_stamp     check ((status = 'CANCELLED') = (cancelled_at is not null))
);

-- Discovery feed: upcoming events near me for my sport.
create index events_discovery_idx on public.events (municipality_code, sport, start_time)
  where status = 'SCHEDULED' and not is_private;
create index events_club_start_idx      on public.events (club_id, start_time) where club_id is not null;
create index events_organizer_start_idx on public.events (organizer_id, start_time desc);
create index events_venue_start_idx     on public.events (venue_id, start_time) where venue_id is not null;
create index events_coach_start_idx     on public.events (coach_id, start_time) where coach_id is not null;
create index events_booking_idx         on public.events (booking_id) where booking_id is not null;

create trigger events_set_updated_at
  before update on public.events
  for each row execute function app.tg_set_updated_at();

alter table public.events enable row level security;

-- -----------------------------------------------------------------------------
-- event_attendees
-- -----------------------------------------------------------------------------
create table public.event_attendees (
  event_id         uuid not null references public.events (id) on delete cascade,
  profile_id       uuid not null references public.profiles (id) on delete cascade,
  status           public.attendee_status not null default 'REGISTERED',
  registered_at    timestamptz not null default now(),
  waitlisted_at    timestamptz,     -- FIFO key for promotion
  promoted_at      timestamptz,
  checked_in_at    timestamptz,
  cancelled_at     timestamptz,
  amount_due       numeric(10,2) not null default 0,
  payment_method   public.payment_method,
  payment_status   public.payment_status not null default 'UNPAID',
  payment_ref_no   text,
  notes            text,
  updated_at       timestamptz not null default now(),

  primary key (event_id, profile_id),

  constraint event_attendees_waitlist_stamp   check ((status = 'WAITLISTED') = (waitlisted_at is not null)),
  constraint event_attendees_checkin_stamp    check (status <> 'CHECKED_IN' or checked_in_at is not null),
  constraint event_attendees_cancel_stamp     check ((status = 'CANCELLED') = (cancelled_at is not null)),
  constraint event_attendees_amount_due       check (amount_due between 0 and 100000),
  constraint event_attendees_payment_ref      check (payment_ref_no is null or payment_ref_no ~ '^[A-Za-z0-9-]{6,40}$'),
  constraint event_attendees_notes_length     check (notes is null or char_length(notes) <= 500)
);

create index event_attendees_profile_idx  on public.event_attendees (profile_id, status);
create index event_attendees_waitlist_idx on public.event_attendees (event_id, waitlisted_at, registered_at)
  where status = 'WAITLISTED';

create trigger event_attendees_set_updated_at
  before update on public.event_attendees
  for each row execute function app.tg_set_updated_at();

alter table public.event_attendees enable row level security;

-- -----------------------------------------------------------------------------
-- event_queue_entries: live paddle/racket rotation board
-- -----------------------------------------------------------------------------
-- One row per present player. WAITING rows are served FIFO by queued_at.
-- Moving off court bumps games_played and sends the player to the back of the
-- line, which drives 4-in/4-out and 2-in/2-out rotations.
create table public.event_queue_entries (
  event_id      uuid not null,
  profile_id    uuid not null,
  queue_state   public.queue_state not null default 'WAITING',
  court_label   text,
  queued_at     timestamptz not null default now(),
  games_played  smallint not null default 0,
  updated_at    timestamptz not null default now(),

  primary key (event_id, profile_id),
  -- Only attendees can be in the queue. Removing the attendee removes the entry.
  foreign key (event_id, profile_id)
    references public.event_attendees (event_id, profile_id) on delete cascade,

  constraint event_queue_court_label check (queue_state <> 'ON_COURT' or court_label is not null),
  constraint event_queue_court_label_length check (court_label is null or char_length(court_label) between 1 and 30),
  constraint event_queue_games_played check (games_played between 0 and 1000)
);

create index event_queue_board_idx on public.event_queue_entries (event_id, queue_state, queued_at);

create trigger event_queue_entries_set_updated_at
  before update on public.event_queue_entries
  for each row execute function app.tg_set_updated_at();

alter table public.event_queue_entries enable row level security;

-- -----------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER: callable from policies without recursion)
-- -----------------------------------------------------------------------------

-- Organiser, coach of a clinic, or admin of the owning club.
create or replace function app.is_event_manager(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.events e
     where e.id = p_event_id
       and (   e.organizer_id = auth.uid()
            or e.coach_id     = auth.uid()
            or (e.club_id is not null and exists (
                  select 1 from public.club_members m
                   where m.club_id = e.club_id and m.profile_id = auth.uid() and m.role = 'ADMIN')))
  );
$$;

-- Holds a seat (REGISTERED or CHECKED_IN).
create or replace function app.is_event_participant(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.event_attendees a
     where a.event_id = p_event_id and a.profile_id = auth.uid()
       and a.status in ('REGISTERED', 'CHECKED_IN')
  );
$$;

-- Single source of truth for event visibility, shared by the events and
-- event_attendees policies:
--   * public, club-less events      → everyone (anon included)
--   * events of a public club       → everyone, unless the event is private
--   * private events / private club → club members only
--   * the organiser, coach and anyone with an attendee row always see it
create or replace function app.can_view_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.events e
      left join public.clubs c on c.id = e.club_id
     where e.id = p_event_id
       and (
             (e.status <> 'DRAFT' and not e.is_private and (c.id is null or not c.is_private))
          or (auth.uid() is not null and (
                 e.organizer_id = auth.uid()
              or e.coach_id     = auth.uid()
              or (e.status <> 'DRAFT' and c.id is not null and exists (
                    select 1 from public.club_members m where m.club_id = c.id and m.profile_id = auth.uid()))
              or exists (select 1 from public.event_attendees a where a.event_id = e.id and a.profile_id = auth.uid())
              or (c.id is not null and exists (
                    select 1 from public.club_members m
                     where m.club_id = c.id and m.profile_id = auth.uid() and m.role = 'ADMIN'))
             ))
       )
  );
$$;

grant execute on function app.is_event_manager(uuid)     to authenticated, service_role;
grant execute on function app.is_event_participant(uuid) to authenticated, service_role;
grant execute on function app.can_view_event(uuid)       to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- events guard
-- -----------------------------------------------------------------------------
create or replace function app.tg_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_trusted  boolean := app.is_trusted_context() or app.is_platform_admin();
  v_booking  record;
  v_venue    record;
begin
  -- Location defaults from the venue.
  if new.venue_id is not null
     and (tg_op = 'INSERT' or new.venue_id is distinct from old.venue_id) then
    select v.municipality_code, v.barangay_code into v_venue from public.venues v where v.id = new.venue_id;
    new.municipality_code := coalesce(v_venue.municipality_code, new.municipality_code);
    new.barangay_code     := case when v_venue.municipality_code is not null then v_venue.barangay_code else new.barangay_code end;
  end if;

  -- Status machine (everyone) ------------------------------------------------------
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

  -- End-user rules -----------------------------------------------------------------
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
    -- Counters are owned by the attendee triggers.
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

  -- A linked court booking must belong to the organiser (or their venue) and
  -- cover the whole event on the same court.
  if new.booking_id is not null
     and (tg_op = 'INSERT' or new.booking_id is distinct from old.booking_id
          or new.start_time <> old.start_time or new.end_time <> old.end_time) then
    select b.* into v_booking from public.bookings b where b.id = new.booking_id;
    if not found
       or v_booking.booking_status = 'CANCELLED'
       or (v_booking.booked_by <> auth.uid() and not app.is_venue_manager(v_booking.venue_id))
       or v_booking.court_id is distinct from new.court_id
       or not (v_booking.time_range @> tstzrange(new.start_time, new.end_time, '[)')) then
      raise exception using errcode = '23514',
        message = 'The linked booking must be yours, active, on the same court, and cover the event time.';
    end if;
  end if;

  return new;
end;
$$;

create trigger events_guard
  before insert or update on public.events
  for each row execute function app.tg_events_guard();

-- -----------------------------------------------------------------------------
-- Waitlist promotion
-- -----------------------------------------------------------------------------
create or replace function app.promote_waitlist(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event     record;
  v_next      uuid;
  v_promoted  integer := 0;
begin
  loop
    select e.registered_count, e.max_participants, e.status
      into v_event
      from public.events e
     where e.id = p_event_id
       for update;
    exit when not found
           or v_event.status not in ('SCHEDULED', 'IN_PROGRESS')
           or v_event.registered_count >= v_event.max_participants;

    select a.profile_id into v_next
      from public.event_attendees a
     where a.event_id = p_event_id and a.status = 'WAITLISTED'
     order by a.waitlisted_at, a.registered_at, a.profile_id
     limit 1
       for update;
    exit when not found;

    update public.event_attendees
       set status = 'REGISTERED'
     where event_id = p_event_id and profile_id = v_next;
    v_promoted := v_promoted + 1;
  end loop;
  return v_promoted;
end;
$$;

grant execute on function app.promote_waitlist(uuid) to service_role;

create or replace function app.tg_events_after_capacity_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.max_participants > old.max_participants
     or (new.status in ('SCHEDULED', 'IN_PROGRESS') and old.status not in ('SCHEDULED', 'IN_PROGRESS')) then
    perform app.promote_waitlist(new.id);
  end if;
  return null;
end;
$$;

create trigger events_after_capacity_change
  after update of max_participants, status on public.events
  for each row execute function app.tg_events_after_capacity_change();

-- -----------------------------------------------------------------------------
-- event_attendees: (10) who-may-do-what guard → (20) capacity → (after) counters
-- -----------------------------------------------------------------------------
create or replace function app.tg_event_attendees_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_event     record;
  v_manager   boolean;
  v_self      boolean;
  v_editable  constant text[] := array['status', 'payment_ref_no', 'payment_status', 'payment_method', 'notes', 'updated_at'];
begin
  -- Transition machine (everyone) --------------------------------------------------
  if tg_op = 'INSERT' then
    if new.status not in ('REGISTERED', 'CHECKED_IN') then
      new.status := 'REGISTERED';   -- capacity trigger decides about the waitlist
    end if;
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not (
         (old.status = 'REGISTERED' and new.status in ('CHECKED_IN', 'CANCELLED'))
      or (old.status = 'CHECKED_IN' and new.status in ('REGISTERED', 'CANCELLED'))
      or (old.status = 'WAITLISTED' and new.status in ('REGISTERED', 'CANCELLED'))
      or (old.status = 'CANCELLED'  and new.status = 'REGISTERED')
    ) then
      raise exception using errcode = '23514',
        message = format('Invalid RSVP transition %s → %s.', old.status, new.status);
    end if;
  end if;

  if tg_op = 'UPDATE' and (new.event_id <> old.event_id or new.profile_id <> old.profile_id) then
    raise exception using errcode = '42501', message = 'An RSVP cannot be moved to another event or person.';
  end if;

  if app.is_trusted_context() or app.is_platform_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- End-user rules -----------------------------------------------------------------
  select e.status, e.start_time, e.end_time, e.registration_deadline, e.fee_per_pax
    into v_event
    from public.events e
   where e.id = coalesce(new.event_id, old.event_id);

  v_manager := app.is_event_manager(coalesce(new.event_id, old.event_id));
  v_self    := coalesce(new.profile_id, old.profile_id) = auth.uid();

  if tg_op = 'DELETE' then
    if not v_manager then
      raise exception using errcode = '42501', message = 'Cancel your RSVP instead of deleting it.';
    end if;
    return old;
  end if;

  if not v_manager and not v_self then
    raise exception using errcode = '42501', message = 'You can only RSVP for yourself.';
  end if;

  -- (Re-)joining needs an open event, before the deadline.
  if not v_manager
     and new.status in ('REGISTERED', 'CHECKED_IN')
     and (tg_op = 'INSERT' or old.status = 'CANCELLED') then
    if v_event.status <> 'SCHEDULED' then
      raise exception using errcode = '23514', message = 'This event is not open for registration.';
    end if;
    if now() >= coalesce(v_event.registration_deadline, v_event.start_time) then
      raise exception using errcode = '23514', message = 'Registration for this event has closed.';
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.amount_due := v_event.fee_per_pax;
    if not v_manager then
      new.status         := 'REGISTERED';
      new.payment_status := case when new.payment_ref_no is not null then 'AWAITING_VERIFICATION'::public.payment_status
                                 else 'UNPAID'::public.payment_status end;
    end if;
    return new;
  end if;

  -- UPDATE by a non-manager (the attendee themself) --------------------------------
  if not v_manager then
    if (to_jsonb(new) - v_editable) is distinct from (to_jsonb(old) - v_editable) then
      raise exception using errcode = '42501', message = 'You can only update your RSVP status, notes or payment reference.';
    end if;
    if new.status is distinct from old.status then
      if old.status = 'WAITLISTED' and new.status = 'REGISTERED' then
        raise exception using errcode = '42501', message = 'Waitlisted players are promoted automatically when a seat frees up.';
      end if;
      if old.status = 'CHECKED_IN' and new.status = 'REGISTERED' then
        raise exception using errcode = '42501', message = 'Ask the organiser to undo a check-in.';
      end if;
      if new.status = 'CHECKED_IN'
         and now() not between v_event.start_time - interval '60 minutes' and v_event.end_time then
        raise exception using errcode = '23514', message = 'Self check-in opens 60 minutes before the event starts.';
      end if;
    end if;
    if new.payment_status is distinct from old.payment_status
       and not (new.payment_status = 'AWAITING_VERIFICATION'
                and old.payment_status in ('UNPAID', 'REJECTED')
                and new.payment_ref_no is not null) then
      raise exception using errcode = '42501', message = 'Only the organiser can verify payments.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function app.tg_event_attendees_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event          record;
  v_takes_seat     boolean;
begin
  v_takes_seat := new.status in ('REGISTERED', 'CHECKED_IN')
              and (tg_op = 'INSERT' or old.status not in ('REGISTERED', 'CHECKED_IN'));

  if v_takes_seat then
    -- Serialises all seat changes for this event.
    select e.max_participants, e.registered_count, e.waitlisted_count,
           e.waitlist_enabled, e.waitlist_capacity
      into v_event
      from public.events e
     where e.id = new.event_id
       for update;

    if v_event.registered_count >= v_event.max_participants then
      if new.status = 'CHECKED_IN' or (tg_op = 'UPDATE' and old.status = 'WAITLISTED') then
        raise exception using errcode = '23514', message = 'EVENT_FULL: no seats left. Raise the player cap first.';
      end if;
      if not v_event.waitlist_enabled
         or (v_event.waitlist_capacity is not null and v_event.waitlisted_count >= v_event.waitlist_capacity) then
        raise exception using errcode = '23514', message = 'EVENT_FULL: this event and its waitlist are full.';
      end if;
      new.status := 'WAITLISTED';
    end if;
  end if;

  -- Stamps.
  if new.status = 'WAITLISTED' and (tg_op = 'INSERT' or old.status <> 'WAITLISTED') then
    new.waitlisted_at := now();
  elsif new.status <> 'WAITLISTED' then
    new.waitlisted_at := null;
  end if;

  if tg_op = 'UPDATE' and old.status = 'WAITLISTED' and new.status = 'REGISTERED' then
    new.promoted_at := now();
  end if;
  if tg_op = 'UPDATE' and old.status = 'CANCELLED' and new.status <> 'CANCELLED' then
    new.registered_at := now();
  end if;

  if new.status = 'CHECKED_IN' then
    new.checked_in_at := coalesce(new.checked_in_at, now());
  elsif tg_op = 'UPDATE' and old.status = 'CHECKED_IN' then
    new.checked_in_at := null;
  end if;

  new.cancelled_at := case when new.status = 'CANCELLED' then coalesce(new.cancelled_at, now()) end;

  return new;
end;
$$;

create or replace function app.tg_event_attendees_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id   uuid := coalesce(new.event_id, old.event_id);
  v_old_seat   boolean := tg_op <> 'INSERT' and old.status in ('REGISTERED', 'CHECKED_IN');
  v_new_seat   boolean := tg_op <> 'DELETE' and new.status in ('REGISTERED', 'CHECKED_IN');
  v_old_wait   boolean := tg_op <> 'INSERT' and old.status = 'WAITLISTED';
  v_new_wait   boolean := tg_op <> 'DELETE' and new.status = 'WAITLISTED';
begin
  if v_old_seat <> v_new_seat or v_old_wait <> v_new_wait then
    update public.events e
       set registered_count = e.registered_count + (v_new_seat::int - v_old_seat::int),
           waitlisted_count = e.waitlisted_count + (v_new_wait::int - v_old_wait::int)
     where e.id = v_event_id;
  end if;

  -- Anyone who no longer holds a seat leaves the rotation board.
  if v_old_seat and not v_new_seat and tg_op = 'UPDATE' then
    delete from public.event_queue_entries q
     where q.event_id = v_event_id and q.profile_id = old.profile_id;
  end if;

  if v_old_seat and not v_new_seat then
    perform app.promote_waitlist(v_event_id);
  end if;

  return null;
end;
$$;

create trigger event_attendees_10_guard
  before insert or update or delete on public.event_attendees
  for each row execute function app.tg_event_attendees_guard();

create trigger event_attendees_20_capacity
  before insert or update on public.event_attendees
  for each row execute function app.tg_event_attendees_capacity();

create trigger event_attendees_after
  after insert or update or delete on public.event_attendees
  for each row execute function app.tg_event_attendees_after();

-- -----------------------------------------------------------------------------
-- event_queue_entries guard
-- -----------------------------------------------------------------------------
create or replace function app.tg_event_queue_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_event_id uuid := coalesce(new.event_id, old.event_id);
begin
  if tg_op in ('INSERT', 'UPDATE') then
    if not exists (
      select 1 from public.event_attendees a
       where a.event_id = new.event_id and a.profile_id = new.profile_id
         and a.status in ('REGISTERED', 'CHECKED_IN')
    ) then
      raise exception using errcode = '23514', message = 'Only registered players can join the rotation queue.';
    end if;

    -- Coming off court counts a game and goes to the back of the line.
    if tg_op = 'UPDATE' and old.queue_state = 'ON_COURT' and new.queue_state <> 'ON_COURT' then
      new.games_played := old.games_played + 1;
      new.court_label  := null;
    end if;
    if new.queue_state = 'WAITING' and (tg_op = 'INSERT' or old.queue_state <> 'WAITING') then
      new.queued_at := now();
    end if;
    if new.queue_state <> 'ON_COURT' then
      new.court_label := null;
    end if;
  end if;

  if app.is_trusted_context() or app.is_platform_admin() or app.is_event_manager(v_event_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- Players manage only their own entry, and only WAITING ↔ RESTING.
  if coalesce(new.profile_id, old.profile_id) <> auth.uid() then
    raise exception using errcode = '42501', message = 'Only the organiser can move other players.';
  end if;
  if tg_op <> 'DELETE' and new.queue_state = 'ON_COURT' then
    raise exception using errcode = '42501', message = 'The organiser assigns players to courts.';
  end if;
  if tg_op = 'UPDATE' and (new.games_played <> old.games_played and old.queue_state <> 'ON_COURT') then
    raise exception using errcode = '42501', message = 'Games played is tracked automatically.';
  end if;
  if tg_op = 'INSERT' then
    new.games_played := 0;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger event_queue_entries_guard
  before insert or update or delete on public.event_queue_entries
  for each row execute function app.tg_event_queue_guard();

-- Close the PUBLIC execute default on everything this migration defined in app.*
revoke execute on all functions in schema app from public;
