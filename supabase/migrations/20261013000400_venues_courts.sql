-- =============================================================================
-- RacketHub · 0400 · Venues, staff, opening hours, courts, rate matrix
-- =============================================================================

-- -----------------------------------------------------------------------------
-- venues
-- -----------------------------------------------------------------------------
create table public.venues (
  id                         uuid primary key default gen_random_uuid(),
  owner_id                   uuid not null references public.profiles (id) on delete restrict,
  name                       text not null,
  description                text,
  municipality_code          text not null references public.ph_municipalities (code) on update cascade,
  barangay_code              text not null,
  address                    text not null,
  latitude                   numeric(9,6),
  longitude                  numeric(9,6),
  contact_number             text,
  contact_email              extensions.citext,
  amenities                  public.venue_amenity[] not null default '{}',
  photo_urls                 text[] not null default '{}',

  -- Manual e-wallet payment channels shown to players at checkout.
  gcash_account_name         text,
  gcash_number               text,
  maya_account_name          text,
  maya_number                text,
  bank_transfer_details      text,
  accepts_cash_on_court      boolean not null default true,
  -- true: a cash booking is CONFIRMED straight away (pay on arrival).
  -- false: the venue confirms cash bookings by hand.
  auto_confirm_cash_bookings boolean not null default true,
  -- How long an unpaid e-wallet hold blocks the slot before it auto-expires.
  payment_window_minutes     smallint not null default 30,
  -- Players can cancel a CONFIRMED booking up to this many hours before start.
  cancellation_cutoff_hours  smallint not null default 24,

  -- IANA zone used for every local-time rule (rates, hours, lights). Kept per
  -- venue so the platform can grow beyond PH without a schema change.
  timezone                   text not null default 'Asia/Manila',
  verification_status        public.verification_status not null default 'UNVERIFIED',
  is_active                  boolean not null default true,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint venues_name_length        check (char_length(btrim(name)) between 2 and 120),
  constraint venues_address_length     check (char_length(btrim(address)) between 5 and 300),
  constraint venues_description_length check (description is null or char_length(description) <= 4000),
  constraint venues_lat_range          check (latitude  is null or latitude  between -90  and 90),
  constraint venues_lng_range          check (longitude is null or longitude between -180 and 180),
  constraint venues_coords_pair        check ((latitude is null) = (longitude is null)),
  -- PH landline (+632xxxxxxxx, +63xxxxxxxxx) or mobile (+639xxxxxxxxx), E.164.
  constraint venues_contact_number     check (contact_number is null or contact_number ~ '^\+63[0-9]{9,10}$'),
  constraint venues_gcash_number       check (gcash_number is null or gcash_number ~ '^\+639[0-9]{9}$'),
  constraint venues_maya_number        check (maya_number  is null or maya_number  ~ '^\+639[0-9]{9}$'),
  constraint venues_gcash_pair         check ((gcash_number is null) = (gcash_account_name is null)),
  constraint venues_maya_pair          check ((maya_number  is null) = (maya_account_name  is null)),
  constraint venues_amenities_distinct check (app.is_distinct_array(amenities)),
  constraint venues_photos_max         check (cardinality(photo_urls) <= 20),
  constraint venues_payment_window     check (payment_window_minutes between 5 and 1440),
  constraint venues_cancellation_cutoff check (cancellation_cutoff_hours between 0 and 168),
  constraint venues_barangay_fk foreign key (municipality_code, barangay_code)
    references public.ph_barangays (municipality_code, code) on update cascade
);

create index venues_owner_idx                 on public.venues (owner_id);
create index venues_location_idx              on public.venues (municipality_code, barangay_code) where is_active;
create index venues_amenities_gin_idx         on public.venues using gin (amenities);
create index venues_coords_idx                on public.venues (latitude, longitude) where latitude is not null;

create trigger venues_set_updated_at
  before update on public.venues
  for each row execute function app.tg_set_updated_at();

alter table public.venues enable row level security;

-- -----------------------------------------------------------------------------
-- venue_managers: front-desk staff the owner delegates to
-- -----------------------------------------------------------------------------
-- Owners configure the venue, courts and rates. Managers run day-to-day
-- operations: confirming bookings, verifying GCash/Maya payments, marking
-- cash as collected.
create table public.venue_managers (
  venue_id    uuid not null references public.venues (id) on delete cascade,
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  added_by    uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (venue_id, profile_id)
);

create index venue_managers_profile_idx on public.venue_managers (profile_id);
create index venue_managers_added_by_idx on public.venue_managers (added_by) where added_by is not null;

alter table public.venue_managers enable row level security;

create or replace function app.is_venue_owner(p_venue_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.venues v where v.id = p_venue_id and v.owner_id = auth.uid()
  );
$$;

-- Owner OR delegated manager: may run bookings and verify payments.
create or replace function app.is_venue_manager(p_venue_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.venues v where v.id = p_venue_id and v.owner_id = auth.uid()
  ) or exists (
    select 1 from public.venue_managers m where m.venue_id = p_venue_id and m.profile_id = auth.uid()
  );
$$;

grant execute on function app.is_venue_owner(uuid)   to authenticated, service_role;
grant execute on function app.is_venue_manager(uuid) to authenticated, service_role;

-- Owners can't hand their venue to someone else, or self-verify. Only a
-- platform admin can reassign ownership or verify a venue. Creating a venue
-- also flips the owner's is_venue_owner role flag on.
create or replace function app.tg_venues_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not app.is_valid_timezone(new.timezone) then
    raise exception using errcode = '22023', message = format('Unknown time zone: %s', new.timezone);
  end if;

  if app.is_trusted_context() or app.is_platform_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.verification_status := 'UNVERIFIED';
  else
    if new.owner_id is distinct from old.owner_id then
      raise exception using errcode = '42501', message = 'Venue ownership can only be transferred by RacketHub support.';
    end if;
    if new.verification_status is distinct from old.verification_status
       and not (new.verification_status = 'PENDING' and old.verification_status in ('UNVERIFIED', 'REJECTED')) then
      raise exception using errcode = '42501', message = 'Venues can only be submitted for verification by their owner.';
    end if;
  end if;
  return new;
end;
$$;

create trigger venues_guard
  before insert or update on public.venues
  for each row execute function app.tg_venues_guard();

create or replace function app.tg_venues_flag_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles p set is_venue_owner = true
   where p.id = new.owner_id and not p.is_venue_owner;
  return new;
end;
$$;

create trigger venues_flag_owner
  after insert or update of owner_id on public.venues
  for each row execute function app.tg_venues_flag_owner();

-- -----------------------------------------------------------------------------
-- venue_operating_hours: weekly opening windows (several per day allowed)
-- -----------------------------------------------------------------------------
-- A venue open past midnight is modelled as two rows, e.g. Fri 16:00–24:00
-- and Sat 00:00–02:00. A venue with NO rows counts as open 24/7.
create table public.venue_operating_hours (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references public.venues (id) on delete cascade,
  day_of_week  smallint not null,
  opens_at     time not null,
  closes_at    time not null,
  hours        public.timerange generated always as (public.timerange(opens_at, closes_at, '[)')) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint venue_operating_hours_dow   check (day_of_week between 0 and 6),
  constraint venue_operating_hours_order check (closes_at > opens_at),
  constraint venue_operating_hours_no_overlap
    exclude using gist (venue_id with =, day_of_week with =, hours with &&)
);

create trigger venue_operating_hours_set_updated_at
  before update on public.venue_operating_hours
  for each row execute function app.tg_set_updated_at();

alter table public.venue_operating_hours enable row level security;

-- -----------------------------------------------------------------------------
-- courts
-- -----------------------------------------------------------------------------
create table public.courts (
  id                      uuid primary key default gen_random_uuid(),
  venue_id                uuid not null references public.venues (id) on delete cascade,
  name                    text not null,
  sport                   public.sport not null,
  surface_type            public.court_surface not null,
  is_indoor               boolean not null default false,
  -- Base (off-peak) hourly rate. Peak and weekend pricing come from court_rate_rules.
  hourly_rate             numeric(10,2) not null,
  -- Night-lights surcharge, applied per hour for time inside the lights window.
  lights_fee_per_hour     numeric(10,2) not null default 0,
  lights_from             time not null default '18:00',
  lights_until            time not null default '06:00',
  slot_increment_minutes  smallint not null default 30,
  min_booking_minutes     smallint not null default 60,
  max_booking_minutes     smallint not null default 240,
  max_players             smallint,
  sort_order              smallint not null default 0,
  is_active               boolean not null default true,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint courts_venue_name_key        unique (venue_id, name),
  -- Target for composite FKs that must prove a court belongs to a venue.
  constraint courts_venue_id_id_key       unique (venue_id, id),
  constraint courts_name_length           check (char_length(btrim(name)) between 1 and 60),
  constraint courts_hourly_rate           check (hourly_rate between 0 and 100000),
  constraint courts_lights_fee            check (lights_fee_per_hour between 0 and 100000),
  constraint courts_slot_increment        check (slot_increment_minutes in (15, 30, 60)),
  constraint courts_min_booking           check (min_booking_minutes >= slot_increment_minutes
                                                 and min_booking_minutes % slot_increment_minutes = 0),
  constraint courts_max_booking           check (max_booking_minutes >= min_booking_minutes
                                                 and max_booking_minutes <= 720
                                                 and max_booking_minutes % slot_increment_minutes = 0),
  constraint courts_max_players           check (max_players is null or max_players between 1 and 64)
);

create index courts_venue_sort_idx on public.courts (venue_id, sort_order) where is_active;
create index courts_sport_idx      on public.courts (sport) where is_active;

create trigger courts_set_updated_at
  before update on public.courts
  for each row execute function app.tg_set_updated_at();

alter table public.courts enable row level security;

-- -----------------------------------------------------------------------------
-- court_rate_rules: peak / off-peak / weekend rate matrix
-- -----------------------------------------------------------------------------
-- Pricing is evaluated per 15-minute slice in the venue's local time:
--   1. Collect the active rules for the court whose weekday, time window and
--      validity dates cover the slice.
--   2. The highest `priority` wins. On a tie, the most recently created rule
--      wins.
--   3. No match → courts.hourly_rate.
-- Example: base ₱300; "Weeknight peak" Mon–Fri 17:00–22:00 ₱450 (priority 10);
--          "Weekend" Sat–Sun 00:00–24:00 ₱500 (priority 20).
create table public.court_rate_rules (
  id            uuid primary key default gen_random_uuid(),
  court_id      uuid not null references public.courts (id) on delete cascade,
  label         text not null,
  days_of_week  smallint[] not null,
  start_time    time not null,
  end_time      time not null,
  hourly_rate   numeric(10,2) not null,
  priority      smallint not null default 0,
  valid_from    date,
  valid_until   date,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint court_rate_rules_label_length check (char_length(btrim(label)) between 1 and 60),
  constraint court_rate_rules_days check (
        cardinality(days_of_week) between 1 and 7
    and days_of_week <@ '{0,1,2,3,4,5,6}'::smallint[]
    and app.is_distinct_array(days_of_week)
  ),
  constraint court_rate_rules_order  check (end_time > start_time),
  constraint court_rate_rules_rate   check (hourly_rate between 0 and 100000),
  constraint court_rate_rules_validity check (valid_from is null or valid_until is null or valid_until >= valid_from)
);

create index court_rate_rules_court_idx on public.court_rate_rules (court_id) where is_active;

create trigger court_rate_rules_set_updated_at
  before update on public.court_rate_rules
  for each row execute function app.tg_set_updated_at();

alter table public.court_rate_rules enable row level security;

-- A verified coach's private hourly rate for a sport, or NULL. SECURITY
-- DEFINER so anonymous visitors can get a quote: a coach's published rate is
-- public pricing, even though coach_profiles itself is members-only.
create or replace function app.coach_private_rate(p_coach_id uuid, p_sport public.sport)
returns numeric(10,2)
language sql
stable
security definer
set search_path = ''
as $$
  select cp.hourly_rate
    from public.coach_profiles cp
   where cp.profile_id = p_coach_id
     and cp.verified_status = 'VERIFIED'
     and cp.offers_private
     and p_sport = any (cp.sports_coached);
$$;

grant execute on function app.coach_private_rate(uuid, public.sport) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- quote_court_booking(): the single source of truth for court pricing
-- -----------------------------------------------------------------------------
-- Clients call it as an RPC to show a live quote. The bookings guard trigger
-- (0500) calls it again so a client can't tamper with the amount it submits.
-- SECURITY INVOKER: it only reads tables that are already public.
create or replace function public.quote_court_booking(
  p_court_id  uuid,
  p_start     timestamptz,
  p_end       timestamptz,
  p_coach_id  uuid default null
)
returns table (
  court_amount   numeric(10,2),
  lights_amount  numeric(10,2),
  coach_amount   numeric(10,2),
  total_amount   numeric(10,2)
)
language plpgsql
stable
set search_path = ''
as $$
declare
  c_slice constant interval := interval '15 minutes';
  v_court       public.courts%rowtype;
  v_tz          text;
  v_coach_rate  numeric(10,2);
  v_court_sum   numeric;
  v_lights_sum  numeric;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception using errcode = '22023', message = 'Booking end must be after its start.';
  end if;
  if extract(epoch from p_start)::bigint % 900 <> 0 or extract(epoch from p_end)::bigint % 900 <> 0 then
    raise exception using errcode = '22023', message = 'Booking times must fall on 15-minute boundaries.';
  end if;
  if p_end - p_start > interval '12 hours' then
    raise exception using errcode = '22023', message = 'A single booking cannot exceed 12 hours.';
  end if;

  select c.* into v_court from public.courts c where c.id = p_court_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Court not found.';
  end if;
  select v.timezone into v_tz from public.venues v where v.id = v_court.venue_id;

  with slices as (
    select gs at time zone v_tz as local_ts
      from generate_series(p_start, p_end - c_slice, c_slice) as gs
  )
  select
    sum(coalesce(rule.hourly_rate, v_court.hourly_rate) / 4),
    sum(case
          when app.time_in_daily_window(s.local_ts::time, v_court.lights_from, v_court.lights_until)
          then v_court.lights_fee_per_hour / 4
          else 0
        end)
    into v_court_sum, v_lights_sum
    from slices s
    left join lateral (
      select r.hourly_rate
        from public.court_rate_rules r
       where r.court_id = p_court_id
         and r.is_active
         and extract(dow from s.local_ts)::smallint = any (r.days_of_week)
         and s.local_ts::time >= r.start_time
         and s.local_ts::time <  r.end_time
         and (r.valid_from  is null or s.local_ts::date >= r.valid_from)
         and (r.valid_until is null or s.local_ts::date <= r.valid_until)
       order by r.priority desc, r.created_at desc, r.id
       limit 1
    ) rule on true;

  if p_coach_id is not null then
    v_coach_rate := app.coach_private_rate(p_coach_id, v_court.sport);
    if v_coach_rate is null then
      raise exception using errcode = 'P0002', message = 'Coach not found, not verified, or does not coach this sport privately.';
    end if;
  end if;

  court_amount  := round(v_court_sum, 2);
  lights_amount := round(v_lights_sum, 2);
  coach_amount  := round(coalesce(v_coach_rate, 0) * extract(epoch from (p_end - p_start)) / 3600, 2);
  total_amount  := court_amount + lights_amount + coach_amount;
  return next;
end;
$$;

revoke all on function public.quote_court_booking(uuid, timestamptz, timestamptz, uuid) from public;
grant execute on function public.quote_court_booking(uuid, timestamptz, timestamptz, uuid) to anon, authenticated, service_role;

comment on function public.quote_court_booking(uuid, timestamptz, timestamptz, uuid) is
  'Authoritative price quote for a court booking (court, lights, coach, total) in PHP. Also enforced server-side on insert.';

-- Close the PUBLIC execute default on everything this migration defined in app.*
revoke execute on all functions in schema app from public;
