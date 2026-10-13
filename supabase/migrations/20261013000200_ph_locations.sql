-- =============================================================================
-- RacketHub · 0200 · Philippine location reference (PSGC hierarchy)
-- =============================================================================
-- Hyperlocal discovery ("open plays in Brgy. San Antonio") only works when
-- every row points at the same canonical barangay. Free text drifts fast
-- ("Brgy San Antonio" vs "San Antonio, Pasig" vs "Sn. Antonio"), so profiles,
-- venues, clubs and events reference barangays and municipalities by their
-- Philippine Standard Geographic Code (PSGC, published by the PSA).
--
-- These tables also feed the Region → Province → City/Municipality → Barangay
-- cascading dropdowns in the UI. They are read-only for end users and get
-- loaded/refreshed by a service-role import of the PSA PSGC file.
--
-- NCR has no provinces, so ph_municipalities.province_code is nullable and
-- every LGU carries its region_code directly.
-- =============================================================================

create table public.ph_regions (
  code        text primary key,
  name        text not null,
  short_name  text,
  constraint ph_regions_code_format check (code ~ '^[0-9]{9,10}$')
);

create table public.ph_provinces (
  code         text primary key,
  region_code  text not null references public.ph_regions (code) on update cascade on delete restrict,
  name         text not null,
  constraint ph_provinces_code_format check (code ~ '^[0-9]{9,10}$')
);

create table public.ph_municipalities (
  code           text primary key,
  region_code    text not null references public.ph_regions (code)   on update cascade on delete restrict,
  province_code  text          references public.ph_provinces (code) on update cascade on delete restrict,
  name           text not null,
  is_city        boolean not null default false,
  constraint ph_municipalities_code_format check (code ~ '^[0-9]{9,10}$')
);

create table public.ph_barangays (
  code               text primary key,
  municipality_code  text not null references public.ph_municipalities (code) on update cascade on delete restrict,
  name               text not null,
  constraint ph_barangays_code_format check (code ~ '^[0-9]{9,10}$'),
  -- Target for composite FKs (municipality_code, barangay_code) elsewhere,
  -- which guarantee a stored barangay really belongs to the stored municipality.
  constraint ph_barangays_municipality_code_key unique (municipality_code, code)
);

-- Cascading-dropdown lookups: children of a parent, sorted by name.
create index ph_provinces_region_name_idx         on public.ph_provinces (region_code, name);
create index ph_municipalities_province_name_idx  on public.ph_municipalities (province_code, name);
create index ph_municipalities_region_name_idx    on public.ph_municipalities (region_code, name);
create index ph_barangays_municipality_name_idx   on public.ph_barangays (municipality_code, name);

alter table public.ph_regions        enable row level security;
alter table public.ph_provinces      enable row level security;
alter table public.ph_municipalities enable row level security;
alter table public.ph_barangays      enable row level security;
