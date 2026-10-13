-- =============================================================================
-- RacketHub · 0500 · Court bookings: zero double-booking, guarded lifecycle
-- =============================================================================
-- Integrity layers, from the bottom up:
--
--   1. EXCLUDE USING gist (court_id WITH =, time_range WITH &&) WHERE not
--      cancelled. Postgres itself refuses any two live bookings whose
--      half-open ranges [start, end) overlap on the same court. This holds
--      under any concurrency: the second of two racing transactions blocks
--      on the first and then fails with SQLSTATE 23P01
--      (exclusion_violation), which the API layer maps to "slot just taken".
--      Back-to-back slots (10:00–11:00, then 11:00–12:00) don't overlap,
--      because the ranges are half-open.
--   2. A second exclusion constraint does the same for coaches, so a coach
--      can't be sold for two overlapping court bookings.
--   3. CHECK constraints pin amounts, timestamps and payment-state invariants.
--   4. A BEFORE trigger enforces the booking and payment state machines, who
--      may change which column, the slot rules (grid, min/max duration,
--      opening hours), and recomputes the price server-side, so clients
--      can't tamper with amounts.
--   5. Every state change is appended to booking_status_history (audit trail).
--
-- time_range is tstzrange rather than tsrange on purpose. The columns are
-- timestamptz (absolute instants), and a timestamptz→timestamp cast depends
-- on the session TimeZone, so it isn't IMMUTABLE and can't be used in a
-- generated column or an index. tstzrange is the correct, immutable [start,
-- end) range here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Config lookup that ignores RLS, so the guard can see venue rules even after
-- a venue is hidden (e.g. deactivated while a player still holds a booking).
-- Returns configuration only, never PII.
-- -----------------------------------------------------------------------------
create or replace function app.court_booking_rules(p_court_id uuid)
returns table (
  venue_id                    uuid,
  venue_is_active             boolean,
  court_is_active             boolean,
  sport                       public.sport,
  timezone                    text,
  slot_increment_minutes      smallint,
  min_booking_minutes         smallint,
  max_booking_minutes         smallint,
  payment_window_minutes      smallint,
  cancellation_cutoff_hours   smallint,
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
  select v.id, v.is_active, c.is_active, c.sport, v.timezone,
         c.slot_increment_minutes, c.min_booking_minutes, c.max_booking_minutes,
         v.payment_window_minutes, v.cancellation_cutoff_hours,
         v.accepts_cash_on_court, v.auto_confirm_cash_bookings,
         v.gcash_number is not null, v.maya_number is not null, v.bank_transfer_details is not null,
         exists (select 1 from public.venue_operating_hours h where h.venue_id = v.id)
    from public.courts c
    join public.venues v on v.id = c.venue_id
   where c.id = p_court_id;
$$;

-- Is every 15-minute slice of [p_start, p_end) inside an opening window of the
-- venue, evaluated in the venue's local time? Venues with no hours count as
-- open 24/7. Overnight bookings work when the venue models the overnight
-- window as two rows (… – 24:00, then 00:00 – …).
create or replace function app.is_within_operating_hours(p_venue_id uuid, p_start timestamptz, p_end timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.venue_operating_hours h where h.venue_id = p_venue_id)
      or not exists (
           select 1
             from public.venues v
            cross join lateral generate_series(p_start, p_end - interval '15 minutes', interval '15 minutes') as gs
            cross join lateral (select gs at time zone v.timezone as ts) as loc
            where v.id = p_venue_id
              and not exists (
                select 1
                  from public.venue_operating_hours h
                 where h.venue_id = p_venue_id
                   and h.day_of_week = extract(dow from loc.ts)::smallint
                   and loc.ts::time >= h.opens_at
                   -- Compare as intervals since midnight: `time` arithmetic would
                   -- wrap 23:45 + 15 min to 00:00, while closes_at may be '24:00'.
                   and (loc.ts::time - time '00:00') + interval '15 minutes' <= (h.closes_at - time '00:00')
              )
         );
$$;

grant execute on function app.court_booking_rules(uuid)                                    to authenticated, service_role;
grant execute on function app.is_within_operating_hours(uuid, timestamptz, timestamptz)    to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- bookings
-- -----------------------------------------------------------------------------
create table public.bookings (
  id                        uuid primary key default gen_random_uuid(),
  reference_code            text not null default app.generate_booking_reference(),
  court_id                  uuid not null references public.courts (id) on delete restrict,
  -- Denormalised from the court (and kept in sync by the guard) so RLS and the
  -- venue dashboards don't need a join. The composite FK proves consistency.
  venue_id                  uuid not null,
  booked_by                 uuid not null references public.profiles (id) on delete restrict,
  coach_id                  uuid references public.coach_profiles (profile_id) on delete restrict,

  start_time                timestamptz not null,
  end_time                  timestamptz not null,
  time_range                tstzrange generated always as (tstzrange(start_time, end_time, '[)')) stored,
  player_count              smallint,

  -- Amounts in PHP. The guard fills these from quote_court_booking().
  court_amount              numeric(10,2) not null,
  lights_amount             numeric(10,2) not null default 0,
  coach_amount              numeric(10,2) not null default 0,
  discount_amount           numeric(10,2) not null default 0,
  total_amount              numeric(10,2) not null,

  payment_method            public.payment_method not null,
  payment_status            public.payment_status not null default 'UNPAID',
  payment_ref_no            text,
  payment_receipt_url       text,    -- object path in the private `payment-receipts` bucket
  payment_due_at            timestamptz,
  payment_submitted_at      timestamptz,
  payment_verified_at       timestamptz,
  payment_verified_by       uuid references public.profiles (id) on delete set null,
  payment_rejection_reason  text,

  booking_status            public.booking_status not null default 'PENDING_PAYMENT',
  confirmed_at              timestamptz,
  cancelled_at              timestamptz,
  cancelled_by              uuid references public.profiles (id) on delete set null,
  cancellation_reason       text,
  completed_at              timestamptz,
  notes                     text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint bookings_reference_code_key unique (reference_code),
  constraint bookings_court_venue_fk foreign key (venue_id, court_id)
    references public.courts (venue_id, id) on delete restrict,

  -- Time sanity -----------------------------------------------------------------
  constraint bookings_time_order check (end_time > start_time),
  constraint bookings_quarter_hour_grid check (
        extract(epoch from start_time)::bigint % 900 = 0
    and extract(epoch from end_time)::bigint   % 900 = 0
  ),
  constraint bookings_max_duration check (end_time - start_time <= interval '12 hours'),
  constraint bookings_player_count check (player_count is null or player_count between 1 and 64),

  -- Money -----------------------------------------------------------------------
  constraint bookings_amounts_non_negative check (
    court_amount >= 0 and lights_amount >= 0 and coach_amount >= 0 and discount_amount >= 0 and total_amount >= 0
  ),
  constraint bookings_total_consistent check (
    total_amount = court_amount + lights_amount + coach_amount - discount_amount
  ),
  constraint bookings_coach_amount_needs_coach check (coach_id is not null or coach_amount = 0),

  -- Payment invariants ------------------------------------------------------------
  -- GCash refs are 13 digits and Maya refs 12 characters; this allows other
  -- wallets and banks while rejecting junk.
  constraint bookings_payment_ref_format check (payment_ref_no is null or payment_ref_no ~ '^[A-Za-z0-9-]{6,40}$'),
  constraint bookings_cash_has_no_ref check (
    payment_method <> 'CASH_ON_COURT' or (payment_ref_no is null and payment_receipt_url is null)
  ),
  constraint bookings_submission_complete check (
    payment_status <> 'AWAITING_VERIFICATION'
    or (payment_method <> 'CASH_ON_COURT' and payment_ref_no is not null and payment_submitted_at is not null)
  ),
  constraint bookings_verified_stamp check (
    payment_status not in ('PAID', 'REJECTED') or payment_verified_at is not null
  ),
  constraint bookings_rejection_reason check (
    payment_status <> 'REJECTED' or payment_rejection_reason is not null
  ),

  -- Booking-status invariants -----------------------------------------------------
  -- Only paid bookings are confirmed. The one exception is cash-on-court,
  -- where the money changes hands at the venue.
  constraint bookings_confirmed_requires_payment check (
       booking_status <> 'CONFIRMED'
    or payment_status = 'PAID'
    or (payment_method = 'CASH_ON_COURT' and payment_status = 'UNPAID')
  ),
  constraint bookings_completed_requires_payment check (booking_status <> 'COMPLETED' or payment_status = 'PAID'),
  constraint bookings_confirmed_stamp check (booking_status not in ('CONFIRMED', 'COMPLETED') or confirmed_at is not null),
  constraint bookings_completed_stamp check (booking_status <> 'COMPLETED' or completed_at is not null),
  constraint bookings_cancelled_stamp check ((booking_status = 'CANCELLED') = (cancelled_at is not null)),
  constraint bookings_refund_only_after_cancel check (payment_status <> 'REFUNDED' or booking_status = 'CANCELLED'),

  -- THE double-booking guarantee ----------------------------------------------------
  constraint bookings_no_court_overlap
    exclude using gist (court_id with =, time_range with &&)
    where (booking_status <> 'CANCELLED'),

  -- A coach can't be booked into two overlapping sessions.
  constraint bookings_no_coach_overlap
    exclude using gist (coach_id with =, time_range with &&)
    where (coach_id is not null and booking_status <> 'CANCELLED')
);

comment on constraint bookings_no_court_overlap on public.bookings is
  'Zero double-booking: no two non-cancelled bookings on one court may have overlapping [start_time, end_time) ranges.';

-- One e-wallet transaction can't pay for two bookings, so a single GCash
-- screenshot can't be reused. Rejected submissions don't count, so a
-- legitimate owner can still use a reference someone else typed by mistake.
create unique index bookings_payment_ref_unique
  on public.bookings (payment_method, upper(payment_ref_no))
  where payment_ref_no is not null and payment_status <> 'REJECTED';

create index bookings_booked_by_start_idx      on public.bookings (booked_by, start_time desc);
create index bookings_venue_start_idx          on public.bookings (venue_id, start_time);
create index bookings_coach_start_idx          on public.bookings (coach_id, start_time) where coach_id is not null;
create index bookings_verification_queue_idx   on public.bookings (venue_id, payment_submitted_at)
  where payment_status = 'AWAITING_VERIFICATION';
create index bookings_expiry_sweep_idx         on public.bookings (payment_due_at)
  where booking_status = 'PENDING_PAYMENT';
create index bookings_completion_sweep_idx     on public.bookings (end_time)
  where booking_status = 'CONFIRMED';
-- Actor columns: keep profile deletion (ON DELETE SET NULL) from scanning the table.
create index bookings_cancelled_by_idx         on public.bookings (cancelled_by) where cancelled_by is not null;
create index bookings_payment_verified_by_idx  on public.bookings (payment_verified_by) where payment_verified_by is not null;

alter table public.bookings enable row level security;

-- -----------------------------------------------------------------------------
-- booking_status_history: append-only audit trail
-- -----------------------------------------------------------------------------
create table public.booking_status_history (
  id                   bigint generated always as identity primary key,
  booking_id           uuid not null references public.bookings (id) on delete cascade,
  from_booking_status  public.booking_status,
  to_booking_status    public.booking_status not null,
  from_payment_status  public.payment_status,
  to_payment_status    public.payment_status not null,
  payment_ref_no       text,
  total_amount         numeric(10,2) not null,
  changed_by           uuid references public.profiles (id) on delete set null,
  reason               text,
  created_at           timestamptz not null default now()
);

create index booking_status_history_booking_idx on public.booking_status_history (booking_id, created_at);
create index booking_status_history_changed_by_idx on public.booking_status_history (changed_by) where changed_by is not null;

alter table public.booking_status_history enable row level security;

-- -----------------------------------------------------------------------------
-- Expire unpaid holds. Called by pg_cron every minute (0990), and
-- opportunistically for one court right before each new booking, so a stale
-- hold never blocks a paying player.
-- -----------------------------------------------------------------------------
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
   where b.booking_status = 'PENDING_PAYMENT'
     and b.payment_status in ('UNPAID', 'REJECTED')
     and b.payment_due_at is not null
     and b.payment_due_at <= now()
     and (p_court_id is null or b.court_id = p_court_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Mark paid, confirmed bookings COMPLETED once they have ended.
create or replace function app.complete_finished_bookings()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.bookings b
     set booking_status = 'COMPLETED'
   where b.booking_status = 'CONFIRMED'
     and b.payment_status = 'PAID'
     and b.end_time <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function app.expire_unpaid_bookings(uuid) to authenticated, service_role;
grant execute on function app.complete_finished_bookings() to service_role;

-- -----------------------------------------------------------------------------
-- The guard
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
  v_booker_editable constant text[] := array[
    'payment_ref_no', 'payment_receipt_url', 'payment_status', 'booking_status',
    'cancellation_reason', 'notes', 'player_count', 'updated_at', 'time_range'
  ];
begin
  select * into r from app.court_booking_rules(new.court_id);
  if not found then
    raise exception using errcode = 'P0002', message = 'Court not found.';
  end if;

  -- Always derive the venue from the court; never trust the client.
  new.venue_id := r.venue_id;
  v_manager    := v_trusted or app.is_venue_manager(r.venue_id);

  -- ===========================================================================
  -- UPDATE: immutables, terminal states, who-may-touch-what
  -- ===========================================================================
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.reference_code <> old.reference_code
       or new.booked_by <> old.booked_by or new.created_at <> old.created_at then
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

    if v_slot_changed then
      if not v_manager then
        raise exception using errcode = '42501', message = 'Only the venue can reschedule a booking. Cancel and rebook instead.';
      end if;
      if new.court_id <> old.court_id and r.venue_id <> old.venue_id then
        raise exception using errcode = '42501', message = 'A booking cannot be moved to another venue.';
      end if;
    end if;

    -- Stamp columns are owned by this trigger. End users can't forge them.
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

    -- The booker (not a venue manager) may only touch a small set of columns.
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

      if (new.payment_ref_no is distinct from old.payment_ref_no
          or new.payment_receipt_url is distinct from old.payment_receipt_url)
         and not (old.payment_status in ('UNPAID', 'REJECTED', 'AWAITING_VERIFICATION')
                  and new.payment_status = 'AWAITING_VERIFICATION') then
        raise exception using errcode = '42501', message = 'Payment details are locked once the venue has verified them.';
      end if;

      if new.booking_status is distinct from old.booking_status then
        if new.booking_status <> 'CANCELLED' then
          raise exception using errcode = '42501', message = 'Players can only cancel a booking.';
        end if;
        if old.booking_status = 'CONFIRMED'
           and now() > old.start_time - make_interval(hours => r.cancellation_cutoff_hours) then
          raise exception using errcode = '23514',
            message = format('Confirmed bookings can only be cancelled up to %s hour(s) before start. Please contact the venue.',
                             r.cancellation_cutoff_hours);
        end if;
      end if;
    end if;
  end if;

  -- ===========================================================================
  -- Slot rules (new bookings and reschedules)
  -- ===========================================================================
  if tg_op = 'INSERT' or v_slot_changed then
    if not v_manager then
      if not (r.venue_is_active and r.court_is_active) then
        raise exception using errcode = '23514', message = 'This court is not accepting bookings.';
      end if;
      if new.start_time < now() then
        raise exception using errcode = '23514', message = 'Cannot book a slot in the past.';
      end if;
      if new.start_time > now() + interval '90 days' then
        raise exception using errcode = '23514', message = 'Bookings open at most 90 days ahead.';
      end if;

      v_minutes     := extract(epoch from (new.end_time - new.start_time))::integer / 60;
      v_local_start := new.start_time at time zone r.timezone;
      if (extract(hour from v_local_start)::integer * 60 + extract(minute from v_local_start)::integer)
           % r.slot_increment_minutes <> 0
         or v_minutes % r.slot_increment_minutes <> 0 then
        raise exception using errcode = '23514',
          message = format('This court books in %s-minute increments.', r.slot_increment_minutes);
      end if;
      if v_minutes < r.min_booking_minutes or v_minutes > r.max_booking_minutes then
        raise exception using errcode = '23514',
          message = format('Booking length must be between %s and %s minutes.', r.min_booking_minutes, r.max_booking_minutes);
      end if;
      if r.has_operating_hours
         and not app.is_within_operating_hours(r.venue_id, new.start_time, new.end_time) then
        raise exception using errcode = '23514', message = 'The venue is closed during part of the selected time.';
      end if;
      if new.coach_id is not null and new.coach_id = new.booked_by then
        raise exception using errcode = '23514', message = 'You cannot book yourself as the coach.';
      end if;
    end if;
  end if;

  -- ===========================================================================
  -- INSERT: initial state and server-side pricing
  -- ===========================================================================
  if tg_op = 'INSERT' then
    -- Clear any stale hold on this court before the exclusion constraint runs.
    perform app.expire_unpaid_bookings(new.court_id);

    if not v_trusted then
      new.payment_verified_at := null;
      new.payment_verified_by := null;
      new.confirmed_at        := null;
      new.cancelled_at        := null;
      new.cancelled_by        := null;
      new.completed_at        := null;
      new.payment_submitted_at := null;
    end if;

    -- Payment-channel availability
    if new.payment_method = 'CASH_ON_COURT' and not r.accepts_cash_on_court then
      raise exception using errcode = '23514', message = 'This venue does not accept cash on court.';
    elsif new.payment_method = 'GCASH' and not r.accepts_gcash then
      raise exception using errcode = '23514', message = 'This venue has not set up GCash payments.';
    elsif new.payment_method = 'MAYA' and not r.accepts_maya then
      raise exception using errcode = '23514', message = 'This venue has not set up Maya payments.';
    elsif new.payment_method = 'BANK_TRANSFER' and not r.accepts_bank_transfer then
      raise exception using errcode = '23514', message = 'This venue has not set up bank transfers.';
    end if;

    select * into q from public.quote_court_booking(new.court_id, new.start_time, new.end_time, new.coach_id);

    if not v_manager then
      -- Players always pay list price, computed here.
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
      -- Venue staff may override amounts (discounts, comps, maintenance blocks).
      new.court_amount    := coalesce(new.court_amount,  q.court_amount);
      new.lights_amount   := coalesce(new.lights_amount, q.lights_amount);
      new.coach_amount    := coalesce(new.coach_amount,  q.coach_amount);
      new.discount_amount := coalesce(new.discount_amount, 0);
      new.total_amount    := coalesce(new.total_amount,
                                      new.court_amount + new.lights_amount + new.coach_amount - new.discount_amount);
      if new.booking_status = 'PENDING_PAYMENT' and new.payment_method <> 'CASH_ON_COURT' then
        new.payment_due_at := coalesce(new.payment_due_at, now() + make_interval(mins => r.payment_window_minutes));
      end if;
    end if;

    -- Cash on court: no payment window. Players and front desk alike follow
    -- the venue's auto-confirm setting.
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

  -- Verifying the payment of a pending booking confirms it in the same step.
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

  -- A rejected proof restarts the payment window so the player can resubmit.
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

-- Fires before bookings_set_updated_at (triggers run in name order).
create trigger bookings_guard
  before insert or update on public.bookings
  for each row execute function app.tg_bookings_guard();

create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function app.tg_set_updated_at();

create or replace function app.tg_bookings_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     or new.booking_status is distinct from old.booking_status
     or new.payment_status is distinct from old.payment_status
     or new.total_amount   is distinct from old.total_amount
     or new.time_range     is distinct from old.time_range then
    insert into public.booking_status_history (
      booking_id, from_booking_status, to_booking_status,
      from_payment_status, to_payment_status, payment_ref_no, total_amount, changed_by, reason
    ) values (
      new.id,
      case when tg_op = 'UPDATE' then old.booking_status end, new.booking_status,
      case when tg_op = 'UPDATE' then old.payment_status end, new.payment_status,
      new.payment_ref_no, new.total_amount, auth.uid(),
      case
        when new.booking_status = 'CANCELLED' then new.cancellation_reason
        when new.payment_status = 'REJECTED'  then new.payment_rejection_reason
        when tg_op = 'UPDATE' and new.time_range is distinct from old.time_range then 'RESCHEDULED'
      end
    );
  end if;
  return null;
end;
$$;

create trigger bookings_audit
  after insert or update on public.bookings
  for each row execute function app.tg_bookings_audit();

-- -----------------------------------------------------------------------------
-- Public availability: busy ranges WITHOUT who booked them
-- -----------------------------------------------------------------------------
-- RLS hides other people's bookings (amounts, names, refs), but the calendar
-- still has to grey out taken slots. This SECURITY DEFINER RPC returns only
-- the time ranges, plus whether the caller holds each one.
create or replace function public.get_court_busy_slots(
  p_court_id  uuid,
  p_from      timestamptz,
  p_to        timestamptz
)
returns table (start_time timestamptz, end_time timestamptz, is_mine boolean)
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
    select b.start_time, b.end_time, coalesce(b.booked_by = auth.uid(), false)
      from public.bookings b
     where b.court_id = p_court_id
       and b.booking_status <> 'CANCELLED'
       and b.time_range && tstzrange(p_from, p_to, '[)')
       -- Expired holds the sweeper hasn't reached yet already count as free
       -- (the insert path clears them before the exclusion check).
       and not (b.booking_status = 'PENDING_PAYMENT'
                and b.payment_status in ('UNPAID', 'REJECTED')
                and b.payment_due_at <= now())
     order by b.start_time;
end;
$$;

revoke all on function public.get_court_busy_slots(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_court_busy_slots(uuid, timestamptz, timestamptz) to anon, authenticated, service_role;

-- Close the PUBLIC execute default on everything this migration defined in app.*
revoke execute on all functions in schema app from public;
