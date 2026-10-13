-- =============================================================================
-- RacketHub · 0600 · Clubs & communities
-- =============================================================================
-- Public clubs are discoverable, and anyone can join one as a MEMBER. Private
-- (invite-only) clubs are hidden from non-members, and only club admins can
-- add people to them. Every club always has at least one ADMIN.
-- =============================================================================

create table public.clubs (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  -- Short handle for share links: rackethub.ph/c/<slug>
  slug               text not null,
  description        text,
  sport              public.sport not null,
  municipality_code  text not null references public.ph_municipalities (code) on update cascade,
  barangay_code      text,
  -- Subdivision / village / condo community the club is based in, e.g. "BF Homes".
  subdivision        text,
  is_private         boolean not null default false,
  home_venue_id      uuid references public.venues (id) on delete set null,
  logo_url           text,
  cover_url          text,
  created_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint clubs_slug_key           unique (slug),
  constraint clubs_slug_format        check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 60),
  constraint clubs_name_length        check (char_length(btrim(name)) between 3 and 80),
  constraint clubs_description_length check (description is null or char_length(description) <= 4000),
  constraint clubs_subdivision_length check (subdivision is null or char_length(subdivision) <= 120),
  constraint clubs_barangay_fk foreign key (municipality_code, barangay_code)
    references public.ph_barangays (municipality_code, code) on update cascade
);

create index clubs_discovery_idx on public.clubs (municipality_code, barangay_code, sport) where not is_private;
create index clubs_created_by_idx on public.clubs (created_by);
create index clubs_home_venue_idx on public.clubs (home_venue_id) where home_venue_id is not null;

create trigger clubs_set_updated_at
  before update on public.clubs
  for each row execute function app.tg_set_updated_at();

alter table public.clubs enable row level security;

-- -----------------------------------------------------------------------------
-- club_members
-- -----------------------------------------------------------------------------
create table public.club_members (
  club_id     uuid not null references public.clubs (id) on delete cascade,
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  role        public.club_role not null default 'MEMBER',
  joined_at   timestamptz not null default now(),
  added_by    uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (club_id, profile_id)
);

create index club_members_profile_idx on public.club_members (profile_id);
create index club_members_admins_idx  on public.club_members (club_id) where role = 'ADMIN';
create index club_members_added_by_idx on public.club_members (added_by) where added_by is not null;

create trigger club_members_set_updated_at
  before update on public.club_members
  for each row execute function app.tg_set_updated_at();

alter table public.club_members enable row level security;

-- -----------------------------------------------------------------------------
-- Membership helpers. SECURITY DEFINER so policies on club_members can ask
-- membership questions without recursing into their own RLS.
-- -----------------------------------------------------------------------------
create or replace function app.club_role_of(p_club_id uuid)
returns public.club_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.club_members m
   where m.club_id = p_club_id and m.profile_id = auth.uid();
$$;

create or replace function app.is_club_member(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.club_members m where m.club_id = p_club_id and m.profile_id = auth.uid()
  );
$$;

create or replace function app.is_club_admin(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.club_members m
     where m.club_id = p_club_id and m.profile_id = auth.uid() and m.role = 'ADMIN'
  );
$$;

create or replace function app.is_club_public(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.clubs c where c.id = p_club_id and not c.is_private);
$$;

grant execute on function app.club_role_of(uuid)   to authenticated, service_role;
grant execute on function app.is_club_member(uuid) to authenticated, service_role;
grant execute on function app.is_club_admin(uuid)  to authenticated, service_role;
grant execute on function app.is_club_public(uuid) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Guards
-- -----------------------------------------------------------------------------
create or replace function app.tg_clubs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.is_trusted_context() or app.is_platform_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  elsif new.created_by is distinct from old.created_by then
    raise exception using errcode = '42501', message = 'The club creator cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger clubs_guard
  before insert or update on public.clubs
  for each row execute function app.tg_clubs_guard();

-- The creator becomes the first ADMIN. SECURITY DEFINER because no
-- membership exists yet to authorise the insert.
create or replace function app.tg_clubs_add_creator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null then
    insert into public.club_members (club_id, profile_id, role, added_by)
    values (new.id, new.created_by, 'ADMIN', new.created_by)
    on conflict (club_id, profile_id) do update set role = 'ADMIN';
  end if;
  return null;
end;
$$;

create trigger clubs_add_creator
  after insert on public.clubs
  for each row execute function app.tg_clubs_add_creator();

create or replace function app.tg_club_members_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_row public.club_members;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;

  -- Rules that hold for everyone ---------------------------------------------------
  if tg_op in ('INSERT', 'UPDATE') and new.role = 'COACH'
     and not exists (select 1 from public.coach_profiles cp where cp.profile_id = new.profile_id) then
    raise exception using errcode = '23514', message = 'Only users with a coach profile can hold the COACH role.';
  end if;

  if tg_op = 'UPDATE'
     and (new.club_id <> old.club_id or new.profile_id <> old.profile_id or new.joined_at <> old.joined_at) then
    raise exception using errcode = '42501', message = 'Only the member role can be changed.';
  end if;

  -- Never leave a club without an admin. Skipped when the club itself is
  -- being deleted (the cascade runs after the parent row is gone).
  if tg_op in ('UPDATE', 'DELETE') and old.role = 'ADMIN'
     and (tg_op = 'DELETE' or new.role <> 'ADMIN')
     and exists (select 1 from public.clubs c where c.id = old.club_id)
     and not exists (
       select 1 from public.club_members m
        where m.club_id = old.club_id and m.role = 'ADMIN' and m.profile_id <> old.profile_id
     ) then
    raise exception using errcode = '23514',
      message = 'A club must keep at least one admin. Promote another member first.';
  end if;

  -- End-user rules ---------------------------------------------------------------
  if not (app.is_trusted_context() or app.is_platform_admin() or app.is_club_admin(v_row.club_id)) then
    if tg_op = 'INSERT' then
      if new.profile_id <> auth.uid() then
        raise exception using errcode = '42501', message = 'Only club admins can add other people.';
      end if;
      if not app.is_club_public(new.club_id) then
        raise exception using errcode = '42501', message = 'This club is invite-only.';
      end if;
      if new.role <> 'MEMBER' then
        raise exception using errcode = '42501', message = 'New members join with the MEMBER role.';
      end if;
      new.added_by := auth.uid();
    elsif tg_op = 'UPDATE' then
      raise exception using errcode = '42501', message = 'Only club admins can change roles.';
    elsif old.profile_id <> auth.uid() then
      raise exception using errcode = '42501', message = 'Only club admins can remove other members.';
    end if;
  elsif tg_op = 'INSERT' and not app.is_trusted_context() then
    new.added_by := auth.uid();
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger club_members_guard
  before insert or update or delete on public.club_members
  for each row execute function app.tg_club_members_guard();

-- Close the PUBLIC execute default on everything this migration defined in app.*
revoke execute on all functions in schema app from public;
