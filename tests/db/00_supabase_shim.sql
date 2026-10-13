-- =============================================================================
-- TEST-ONLY: emulate the parts of a Supabase Postgres instance that the
-- migrations depend on (roles, auth.uid(), storage schema, realtime
-- publication, default privileges), so the migrations can be applied and
-- tested on vanilla PostgreSQL 15+ in CI.
--
-- NEVER run this against a real Supabase project.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon          nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role  nologin noinherit bypassrls; end if;
  -- PostgREST logs in as `authenticator` and switches to the JWT's role, as on Supabase.
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'authenticator';
  end if;
end;
$$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;

grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;

-- Supabase grants API roles everything on new public objects by default; the
-- migrations are written to narrow this down, so emulate it faithfully.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text unique,
  phone               text unique,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(current_setting('request.jwt.claim.sub', true),
             (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')),
    '')::uuid
$$;

create or replace function auth.role() returns text language sql stable as $$
  select coalesce(current_setting('request.jwt.claim.role', true),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))
$$;

grant execute on all functions in schema auth to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id                  text primary key,
  name                text not null unique,
  owner               uuid,
  public              boolean default false,
  file_size_limit     bigint,
  allowed_mime_types  text[],
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create table if not exists storage.objects (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text references storage.buckets (id),
  name        text,
  owner       uuid,
  metadata    jsonb,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end;
$$;

grant select on storage.buckets to anon, authenticated;
grant all on storage.objects to anon, authenticated, service_role;
grant execute on all functions in schema storage to anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Realtime "broadcast from database" emulation, matching hosted Supabase:
--   * realtime.send() adds an "id" to the payload, sets realtime.topic for the
--     insert, writes realtime.messages, and never fails the caller (errors
--     become WARNINGs, as in the real function).
--   * anon / authenticated have table privileges on realtime.messages, as on
--     hosted, so RLS POLICIES decide who may receive (SELECT) or send
--     (INSERT). A trigger that forgets SECURITY DEFINER then loses its
--     broadcast to RLS, exactly as it would in production.
--   * Realtime authorises a private-channel join by setting realtime.topic and
--     SELECTing a probe row as the joining role; tests emulate that.
-- -----------------------------------------------------------------------------
create schema if not exists realtime;
grant usage on schema realtime to anon, authenticated, service_role;

create table if not exists realtime.messages (
  id           bigint generated always as identity primary key,
  topic        text not null,
  extension    text not null,
  payload      jsonb,
  event        text,
  private      boolean default true,
  inserted_at  timestamptz not null default now()
);
alter table realtime.messages enable row level security;
grant select, insert, update on realtime.messages to anon, authenticated, service_role;

create or replace function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')::text
$$;

create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language plpgsql as $$
declare
  final_payload jsonb := case when payload ? 'id' then payload
                              else jsonb_set(payload, '{id}', to_jsonb(gen_random_uuid())) end;
begin
  perform set_config('realtime.topic', topic, true);
  insert into realtime.messages (payload, event, topic, private, extension)
  values (final_payload, event, topic, private, 'broadcast');
exception when others then
  raise warning 'ErrorSendingBroadcastMessage: %', sqlerrm;
end;
$$;

grant execute on function realtime.topic() to anon, authenticated, service_role;
