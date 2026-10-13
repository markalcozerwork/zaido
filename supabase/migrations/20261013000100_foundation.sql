-- =============================================================================
-- RacketHub · 0100 · Foundation: extensions, private schema, enum types, utils
-- =============================================================================
-- Conventions every later migration follows:
--
--   * Tables live in `public` so the Supabase Data API can reach them. Every
--     table enables RLS in the SAME migration that creates it, so nothing is
--     ever exposed without policies (deny-by-default until 0900 adds them).
--   * Internal helpers live in the `app` schema, which is NOT exposed through
--     the Data API. All functions pin `search_path = ''` and use fully
--     qualified names, which closes search-path hijacking and satisfies the
--     Supabase linter.
--   * Instants are always `timestamptz`. Local-time rules (rates, opening
--     hours, lights) are evaluated in the venue's IANA time zone, which
--     defaults to Asia/Manila.
--   * Money is numeric(10,2) in Philippine pesos. Never float.
--   * Guard triggers let "trusted" contexts through (service_role, postgres,
--     pg_cron, and SECURITY DEFINER internals). They run the full rule set
--     only for end-user roles (anon, authenticated). See app.is_trusted_context().
-- =============================================================================

create schema if not exists extensions;

create extension if not exists pgcrypto   with schema extensions;  -- gen_random_bytes()
create extension if not exists btree_gist with schema extensions;  -- uuid "=" inside GiST exclusion constraints
create extension if not exists citext     with schema extensions;  -- case-insensitive e-mail

-- -----------------------------------------------------------------------------
-- Private schema for helpers, trigger functions and jobs.
-- -----------------------------------------------------------------------------
create schema if not exists app;
comment on schema app is
  'RacketHub internals: RLS helpers, trigger functions, scheduled jobs. Not exposed via the Data API.';

revoke all on schema app from public;
-- RLS policies call app.* helpers while running as the requesting role, so
-- those roles need USAGE. EXECUTE is granted per function, and only to the
-- helpers that policies actually call.
grant usage on schema app to anon, authenticated, service_role;
-- Postgres gives PUBLIC EXECUTE on every new function, and a per-schema
-- `ALTER DEFAULT PRIVILEGES ... REVOKE` can't take that back (per-schema
-- defaults only ever ADD to the global ones). So every migration that creates
-- app.* functions ends with an explicit
--   revoke execute on all functions in schema app from public;
-- and tests/db/15_schema_lint.sql fails the build if one is missed.

-- -----------------------------------------------------------------------------
-- Enum types. These live in `public` so `supabase gen types` emits them as
-- TypeScript string unions for the Zod schemas in Step 2.
-- -----------------------------------------------------------------------------
create type public.sport as enum ('PICKLEBALL', 'BADMINTON', 'TENNIS', 'TABLE_TENNIS');

-- Coarse skill bucket used for every sport. Numeric ratings (DUPR/NTRP/UTR)
-- are stored alongside it in player_profiles.
create type public.skill_level as enum ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'PRO');
create type public.rating_system as enum ('DUPR', 'NTRP', 'UTR', 'SELF_ASSESSED');
create type public.play_style as enum ('SINGLES', 'DOUBLES', 'BOTH');
create type public.dominant_hand as enum ('RIGHT', 'LEFT', 'AMBIDEXTROUS');

create type public.verification_status as enum ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

create type public.court_surface as enum (
  'TARAFLEX', 'WOOD', 'CONCRETE', 'ACRYLIC', 'ASPHALT', 'SYNTHETIC_GRASS', 'CLAY', 'RUBBER'
);

create type public.venue_amenity as enum (
  'LIGHTS', 'PARKING', 'SHOWERS', 'LOCKERS', 'RESTROOMS', 'AIRCON', 'DRINKING_WATER',
  'CANTEEN', 'PRO_SHOP', 'RACKET_RENTAL', 'PADDLE_RENTAL', 'BALL_SALES', 'SHUTTLE_SALES',
  'WIFI', 'SEATING', 'FIRST_AID', 'WHEELCHAIR_ACCESS', 'COVERED_WAITING_AREA'
);

create type public.payment_method as enum ('GCASH', 'MAYA', 'BANK_TRANSFER', 'CASH_ON_COURT');

-- UNPAID                → nothing submitted yet (or cash still to be collected on court)
-- AWAITING_VERIFICATION → player submitted a reference no. and/or receipt; the venue must verify it
-- PAID                  → verified by the venue (or cash collected)
-- REJECTED              → the venue rejected the submitted proof; the player may resubmit
-- REFUNDED              → money returned after a cancellation
create type public.payment_status as enum ('UNPAID', 'AWAITING_VERIFICATION', 'PAID', 'REJECTED', 'REFUNDED');

create type public.booking_status as enum ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'COMPLETED');

create type public.club_role as enum ('ADMIN', 'COACH', 'MEMBER');

create type public.event_type as enum ('OPEN_PLAY', 'CLINIC', 'TOURNAMENT');
create type public.tournament_format as enum ('SINGLE_ELIMINATION', 'DOUBLE_ELIMINATION', 'ROUND_ROBIN', 'LADDER');
create type public.rotation_format as enum ('NONE', 'FOUR_IN_FOUR_OUT', 'TWO_IN_TWO_OUT', 'WINNERS_STAY_ON');
create type public.event_status as enum ('DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
create type public.attendee_status as enum ('REGISTERED', 'WAITLISTED', 'CHECKED_IN', 'CANCELLED');
create type public.queue_state as enum ('WAITING', 'ON_COURT', 'RESTING');

create type public.channel_type as enum ('CLUB', 'EVENT', 'DIRECT');

-- Wall-clock range type for recurring weekly windows (opening hours, coach
-- availability, peak-rate rules). Range types get a GiST opclass for free,
-- so these windows can carry exclusion constraints as well.
create type public.timerange as range (subtype = time);

-- -----------------------------------------------------------------------------
-- Generic utilities
-- -----------------------------------------------------------------------------

-- Keeps updated_at current on every UPDATE.
create or replace function app.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- True when the statement is NOT running as an end-user API role. Covers
-- service_role, postgres (migrations, SQL editor, pg_cron), and code inside
-- SECURITY DEFINER functions, where current_user is the function owner. Guard
-- triggers skip end-user rules in these contexts because trusted code applies
-- its own checks.
create or replace function app.is_trusted_context()
returns boolean
language sql
stable
set search_path = ''
as $$
  select current_user not in ('anon', 'authenticated');
$$;

-- CHECK-constraint helper: does the array contain no duplicate elements?
create or replace function app.is_distinct_array(arr anyarray)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select arr is null
      or cardinality(arr) = (select count(distinct x) from unnest(arr) as t(x));
$$;

-- A uuid cast that returns NULL instead of raising. Storage policies parse
-- object paths with it, where a malformed path must deny access, not error.
create or replace function app.try_uuid(value text)
returns uuid
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
begin
  return value::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

-- Is `t` inside the daily window [from, until)? The window may wrap past
-- midnight, e.g. lights from 18:00 until 06:00.
create or replace function app.time_in_daily_window(t time, from_t time, until_t time)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when from_t is null or until_t is null then false
    when from_t = until_t                  then true          -- all day
    when from_t < until_t                  then t >= from_t and t < until_t
    else                                        t >= from_t or  t < until_t
  end;
$$;

-- Human-friendly booking reference: RH-XXXX-XXXX in Crockford-style base32
-- with no 0/O/1/I, so it can be read aloud at a front desk. 32^8 ≈ 1.1e12
-- combinations, and 256 % 32 = 0, so there's no modulo bias.
create or replace function app.generate_booking_reference()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  raw  bytea := extensions.gen_random_bytes(8);
  code text  := '';
begin
  for i in 0..7 loop
    code := code || substr(alphabet, (get_byte(raw, i) % 32) + 1, 1);
  end loop;
  return 'RH-' || substr(code, 1, 4) || '-' || substr(code, 5, 4);
end;
$$;

-- Rejects time zone names Postgres doesn't recognise (used by the venues guard trigger).
create or replace function app.is_valid_timezone(tz text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  perform now() at time zone tz;
  return true;
exception when invalid_parameter_value then
  return false;
end;
$$;

grant execute on function app.tg_set_updated_at()                   to authenticated, service_role;
grant execute on function app.is_trusted_context()                  to anon, authenticated, service_role;
grant execute on function app.is_distinct_array(anyarray)           to anon, authenticated, service_role;
grant execute on function app.try_uuid(text)                        to anon, authenticated, service_role;
grant execute on function app.time_in_daily_window(time, time, time) to anon, authenticated, service_role;
grant execute on function app.generate_booking_reference()          to authenticated, service_role;
grant execute on function app.is_valid_timezone(text)               to authenticated, service_role;

-- Close the PUBLIC execute default on everything this migration defined in app.*
revoke execute on all functions in schema app from public;
