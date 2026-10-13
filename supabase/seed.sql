-- =============================================================================
-- RacketHub · DEV SEED (run by `supabase db reset`, never in production)
-- =============================================================================
-- A tiny location fixture so the cascading Region → Province → City →
-- Barangay dropdowns work on a fresh local stack.
--
-- ⚠ The codes below are PLACEHOLDERS in the 99xxxxxxxx range, which the PSGC
--   doesn't use. Production loads the official PSA PSGC file through a
--   service-role import. Do not ship these codes.
-- =============================================================================

insert into public.ph_regions (code, name, short_name) values
  ('9900000000', 'National Capital Region', 'NCR'),
  ('9904000000', 'CALABARZON',              'Region IV-A')
on conflict (code) do nothing;

insert into public.ph_provinces (code, region_code, name) values
  ('9904340000', '9904000000', 'Laguna')
on conflict (code) do nothing;

insert into public.ph_municipalities (code, region_code, province_code, name, is_city) values
  ('9900100000', '9900000000', null,         'City of Pasig',      true),
  ('9900200000', '9900000000', null,         'Quezon City',        true),
  ('9904340100', '9904000000', '9904340000', 'City of Santa Rosa', true),
  ('9904340200', '9904000000', '9904340000', 'Los Baños',          false)
on conflict (code) do nothing;

insert into public.ph_barangays (code, municipality_code, name) values
  ('9900100001', '9900100000', 'Kapitolyo'),
  ('9900100002', '9900100000', 'San Antonio'),
  ('9900100003', '9900100000', 'Ugong'),
  ('9900200001', '9900200000', 'Teachers Village East'),
  ('9900200002', '9900200000', 'Loyola Heights'),
  ('9904340101', '9904340100', 'Balibago'),
  ('9904340102', '9904340100', 'Tagapo'),
  ('9904340201', '9904340200', 'Batong Malake')
on conflict (code) do nothing;
