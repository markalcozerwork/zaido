-- =============================================================================
-- RacketHub · 0300 · Identity: profiles, contacts, player & coach profiles
-- =============================================================================
-- Hybrid role model: ONE account can be a player, a coach, a venue owner and
-- a club organiser all at once. The flags on `profiles` drive the role
-- switcher in the UI. Sport-specific detail lives in child tables.
--
-- Privacy (RA 10173, the Data Privacy Act of 2012): the phone number sits in
-- `profile_contacts`, not `profiles`. `profiles` is readable by any signed-in
-- user (names and avatars appear in rosters, chats and leaderboards), while
-- contact details are visible only to people with a concrete reason to call
-- you: your venue for a booking, your coach or student, the organiser of an
-- event you joined. Splitting the table keeps those rules in plain RLS, with
-- no SECURITY DEFINER views or column-level SELECT grants to get wrong.
--
-- Platform admin rights live in their own table (`platform_admins`), which
-- end users can never write, so privilege escalation via profile UPDATE is
-- impossible by construction.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id                       uuid primary key references auth.users (id) on delete cascade,
  full_name                text not null,
  display_name             text,
  avatar_url               text,
  bio                      text,
  municipality_code        text references public.ph_municipalities (code) on update cascade on delete set null,
  barangay_code            text,
  dominant_hand            public.dominant_hand,
  is_player                boolean not null default true,
  is_coach                 boolean not null default false,
  is_venue_owner           boolean not null default false,
  onboarding_completed_at  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint profiles_full_name_length    check (char_length(btrim(full_name)) between 2 and 120),
  constraint profiles_display_name_length check (display_name is null or char_length(btrim(display_name)) between 2 and 40),
  constraint profiles_bio_length          check (bio is null or char_length(bio) <= 1000),
  constraint profiles_has_a_role          check (is_player or is_coach or is_venue_owner),
  constraint profiles_barangay_needs_municipality check (barangay_code is null or municipality_code is not null),
  -- The barangay must belong to the chosen municipality.
  constraint profiles_barangay_fk foreign key (municipality_code, barangay_code)
    references public.ph_barangays (municipality_code, code) on update cascade
);

create index profiles_municipality_barangay_idx on public.profiles (municipality_code, barangay_code);
create index profiles_coaches_idx on public.profiles (municipality_code) where is_coach;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function app.tg_set_updated_at();

alter table public.profiles enable row level security;

comment on table public.profiles is
  'Public-facing identity (name, avatar, home barangay, role flags). Readable by any signed-in user.';

-- -----------------------------------------------------------------------------
-- profile_contacts: private PII
-- -----------------------------------------------------------------------------
create table public.profile_contacts (
  profile_id               uuid primary key references public.profiles (id) on delete cascade,
  -- E.164 PH mobile number: +639XXXXXXXXX
  phone                    text,
  birth_date               date,
  emergency_contact_name   text,
  emergency_contact_phone  text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint profile_contacts_phone_format check (phone is null or phone ~ '^\+639[0-9]{9}$'),
  constraint profile_contacts_emergency_phone_format
    check (emergency_contact_phone is null or emergency_contact_phone ~ '^\+639[0-9]{9}$'),
  constraint profile_contacts_birth_date_sane
    check (birth_date is null or birth_date between date '1900-01-01' and date '2100-01-01'),
  constraint profile_contacts_phone_key unique (phone)
);

create trigger profile_contacts_set_updated_at
  before update on public.profile_contacts
  for each row execute function app.tg_set_updated_at();

alter table public.profile_contacts enable row level security;

comment on table public.profile_contacts is
  'Private contact details (RA 10173). Visible only to the owner and to counterparties with a legitimate need; see app.can_view_contact().';

-- -----------------------------------------------------------------------------
-- platform_admins: written only by service_role / SQL editor
-- -----------------------------------------------------------------------------
create table public.platform_admins (
  profile_id  uuid primary key references public.profiles (id) on delete cascade,
  granted_at  timestamptz not null default now(),
  notes       text
);

alter table public.platform_admins enable row level security;

create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins pa where pa.profile_id = auth.uid()
  );
$$;

grant execute on function app.is_platform_admin() to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- player_profiles: one row per (player, sport)
-- -----------------------------------------------------------------------------
create table public.player_profiles (
  profile_id     uuid not null references public.profiles (id) on delete cascade,
  sport          public.sport not null,
  skill_level    public.skill_level not null default 'BEGINNER',
  rating_system  public.rating_system,
  rating         numeric(5,3),
  dupr_id        text,
  play_style     public.play_style not null default 'BOTH',
  years_playing  smallint,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  primary key (profile_id, sport),

  constraint player_profiles_rating_pair check ((rating is null) = (rating_system is null)),
  -- Each rating system is only meaningful for its own sport.
  constraint player_profiles_rating_system_matches_sport check (
       rating_system is null
    or rating_system = 'SELF_ASSESSED'
    or (rating_system = 'DUPR' and sport = 'PICKLEBALL')
    or (rating_system in ('NTRP', 'UTR') and sport = 'TENNIS')
  ),
  constraint player_profiles_rating_range check (
       rating is null
    or (rating_system = 'DUPR'          and rating between 2.000 and 8.000)
    or (rating_system = 'NTRP'          and rating between 1.000 and 7.000)
    or (rating_system = 'UTR'           and rating between 1.000 and 16.500)
    or (rating_system = 'SELF_ASSESSED' and rating between 1.000 and 10.000)
  ),
  constraint player_profiles_dupr_id check (
    dupr_id is null or (sport = 'PICKLEBALL' and dupr_id ~ '^[A-Za-z0-9]{4,20}$')
  ),
  constraint player_profiles_years_playing check (years_playing is null or years_playing between 0 and 80)
);

-- "Find intermediate pickleball players" style queries.
create index player_profiles_sport_skill_idx on public.player_profiles (sport, skill_level);
create unique index player_profiles_dupr_id_key on public.player_profiles (upper(dupr_id)) where dupr_id is not null;

create trigger player_profiles_set_updated_at
  before update on public.player_profiles
  for each row execute function app.tg_set_updated_at();

alter table public.player_profiles enable row level security;

-- -----------------------------------------------------------------------------
-- coach_profiles: 1:1 with profiles for users who coach
-- -----------------------------------------------------------------------------
create table public.coach_profiles (
  profile_id            uuid primary key references public.profiles (id) on delete cascade,
  sports_coached        public.sport[] not null,
  hourly_rate           numeric(10,2) not null,
  group_rate_per_pax    numeric(10,2),
  bio                   text,
  credentials           text[] not null default '{}',
  years_experience      smallint,
  offers_private        boolean not null default true,
  offers_group_clinics  boolean not null default false,
  verified_status       public.verification_status not null default 'UNVERIFIED',
  verified_at           timestamptz,
  verified_by           uuid references public.profiles (id) on delete set null,
  verification_notes    text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint coach_profiles_sports_nonempty  check (cardinality(sports_coached) between 1 and 4),
  constraint coach_profiles_sports_distinct  check (app.is_distinct_array(sports_coached)),
  constraint coach_profiles_hourly_rate      check (hourly_rate between 0 and 100000),
  constraint coach_profiles_group_rate       check (group_rate_per_pax is null or group_rate_per_pax between 0 and 100000),
  constraint coach_profiles_offers_something check (offers_private or offers_group_clinics),
  constraint coach_profiles_years_experience check (years_experience is null or years_experience between 0 and 80),
  constraint coach_profiles_bio_length       check (bio is null or char_length(bio) <= 2000),
  constraint coach_profiles_verified_stamp   check (verified_status <> 'VERIFIED' or verified_at is not null)
);

create index coach_profiles_sports_gin_idx on public.coach_profiles using gin (sports_coached);
create index coach_profiles_verified_idx   on public.coach_profiles (verified_status);
create index coach_profiles_verified_by_idx on public.coach_profiles (verified_by) where verified_by is not null;

create trigger coach_profiles_set_updated_at
  before update on public.coach_profiles
  for each row execute function app.tg_set_updated_at();

alter table public.coach_profiles enable row level security;

-- Coaches may move themselves UNVERIFIED/REJECTED → PENDING (submit for
-- review) and nothing else. Only platform admins (or trusted contexts) can
-- set VERIFIED/REJECTED. Editing credentials or sports on a VERIFIED profile
-- sends it back to PENDING so admins review the change.
create or replace function app.tg_coach_profiles_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.is_trusted_context() or app.is_platform_admin() then
    if new.verified_status in ('VERIFIED', 'REJECTED')
       and new.verified_status is distinct from coalesce(old.verified_status, 'UNVERIFIED') then
      new.verified_at := now();
      new.verified_by := coalesce(auth.uid(), new.verified_by);
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.verified_status not in ('UNVERIFIED', 'PENDING') then
      raise exception using errcode = '42501', message = 'Coaches cannot self-verify.';
    end if;
    new.verified_at := null;
    new.verified_by := null;
    new.verification_notes := null;
    return new;
  end if;

  -- UPDATE by the coach themself.
  if new.verified_by is distinct from old.verified_by
     or new.verified_at is distinct from old.verified_at
     or new.verification_notes is distinct from old.verification_notes then
    raise exception using errcode = '42501', message = 'Verification fields are managed by RacketHub admins.';
  end if;

  if new.verified_status is distinct from old.verified_status
     and not (new.verified_status = 'PENDING' and old.verified_status in ('UNVERIFIED', 'REJECTED')) then
    raise exception using errcode = '42501', message = 'Coaches can only submit their profile for verification.';
  end if;

  if old.verified_status = 'VERIFIED'
     and (new.credentials is distinct from old.credentials
          or new.sports_coached is distinct from old.sports_coached) then
    new.verified_status := 'PENDING';
    new.verified_at := null;
    new.verified_by := null;
  end if;

  return new;
end;
$$;

create trigger coach_profiles_guard
  before insert or update on public.coach_profiles
  for each row execute function app.tg_coach_profiles_guard();

-- Keep the role flags on `profiles` in sync with the child tables, so the
-- role switcher never shows "Coach" without a coach profile behind it.
create or replace function app.tg_sync_profile_role_flags()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'player_profiles' then
    update public.profiles p set is_player = true
     where p.id = new.profile_id and not p.is_player;
  elsif tg_table_name = 'coach_profiles' then
    if tg_op = 'INSERT' then
      update public.profiles p set is_coach = true
       where p.id = new.profile_id and not p.is_coach;
    elsif tg_op = 'DELETE' then
      -- Keep profiles_has_a_role satisfied when someone stops coaching.
      update public.profiles p
         set is_coach = false,
             is_player = p.is_player or not p.is_venue_owner
       where p.id = old.profile_id;
      return old;
    end if;
  end if;
  return new;
end;
$$;

create trigger player_profiles_sync_role_flags
  after insert on public.player_profiles
  for each row execute function app.tg_sync_profile_role_flags();

create trigger coach_profiles_sync_role_flags
  after insert or delete on public.coach_profiles
  for each row execute function app.tg_sync_profile_role_flags();

-- -----------------------------------------------------------------------------
-- coach_availability: recurring weekly availability windows
-- -----------------------------------------------------------------------------
create table public.coach_availability (
  id           uuid primary key default gen_random_uuid(),
  coach_id     uuid not null references public.coach_profiles (profile_id) on delete cascade,
  -- 0 = Sunday … 6 = Saturday, matching extract(dow from …)
  day_of_week  smallint not null,
  start_time   time not null,
  end_time     time not null,   -- '24:00' is allowed and means midnight
  sport        public.sport,    -- NULL = any sport the coach teaches
  hours        public.timerange generated always as (public.timerange(start_time, end_time, '[)')) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint coach_availability_dow  check (day_of_week between 0 and 6),
  constraint coach_availability_order check (end_time > start_time),
  -- A coach can't publish overlapping windows on the same weekday.
  constraint coach_availability_no_overlap
    exclude using gist (coach_id with =, day_of_week with =, hours with &&)
);

create trigger coach_availability_set_updated_at
  before update on public.coach_availability
  for each row execute function app.tg_set_updated_at();

alter table public.coach_availability enable row level security;

-- -----------------------------------------------------------------------------
-- Auto-provision a profile when a Supabase Auth user signs up.
-- -----------------------------------------------------------------------------
-- The onboarding flow (Step 2) fills in the rest. This trigger only makes
-- sure the FK target exists from the first request on. It deliberately never
-- fails sign-up: a phone number that's malformed or already claimed is just
-- skipped.
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name  text;
  v_phone text;
begin
  v_name := btrim(coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    split_part(coalesce(new.email, ''), '@', 1)
  ));
  if v_name is null or char_length(v_name) < 2 then
    v_name := 'New Player';
  end if;

  insert into public.profiles (id, full_name, avatar_url)
  values (new.id, left(v_name, 120), new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;

  -- Supabase stores phones without the leading '+'.
  v_phone := case
    when new.phone ~ '^639[0-9]{9}$'    then '+' || new.phone
    when new.phone ~ '^\+639[0-9]{9}$' then new.phone
  end;

  insert into public.profile_contacts (profile_id, phone)
  values (
    new.id,
    case when v_phone is not null
          and not exists (select 1 from public.profile_contacts c where c.phone = v_phone)
         then v_phone end
  )
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- On hosted Supabase, GoTrue inserts into auth.users as supabase_auth_admin.
-- The function is SECURITY DEFINER; these grants are belt and braces so the
-- role can always resolve and run it. A failure here would surface as
-- "Database error saving new user" at sign-up.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema app to supabase_auth_admin;
    grant execute on function app.handle_new_auth_user() to supabase_auth_admin;
  end if;
end;
$$;

-- Close the PUBLIC execute default on everything this migration defined in app.*
revoke execute on all functions in schema app from public;
