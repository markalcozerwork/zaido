-- =============================================================================
-- Identity, privacy, venues, courts, pricing. Builds the shared fixtures.
-- =============================================================================
\set ON_ERROR_STOP 1
reset role;
select tests.logout();

-- -----------------------------------------------------------------------------
-- Sign-up provisioning
-- -----------------------------------------------------------------------------
insert into auth.users (id, email, phone, raw_user_meta_data) values
  (tests.uid('olivia'), 'olivia@example.ph', '639170000001', '{"full_name": "Olivia Owner"}'),
  (tests.uid('alice'),  'alice@example.ph',  '639170000002', '{"full_name": "Alice Santos"}'),
  (tests.uid('bob'),    'bob@example.ph',    '639170000003', '{"full_name": "Bob Reyes"}'),
  (tests.uid('carlos'), 'carlos@example.ph', '639170000004', '{"full_name": "Carlos Coach"}'),
  (tests.uid('mia'),    'mia@example.ph',    null,           '{"name": "Mia Desk"}'),
  (tests.uid('dave'),   'd@example.ph',      'not-a-phone',  '{}');

select tests.eq((select count(*) from public.profiles)::int, 6, 'sign-up provisions a profile per auth user');
select tests.eq((select phone from public.profile_contacts where profile_id = tests.uid('alice')), '+639170000002',
                'Supabase phone normalised to E.164');
select tests.eq((select full_name from public.profiles where id = tests.uid('dave')), 'New Player',
                'too-short derived name falls back to a placeholder');
select tests.ok((select phone is null from public.profile_contacts where profile_id = tests.uid('dave')),
                'malformed phone is skipped instead of failing sign-up');

-- -----------------------------------------------------------------------------
-- Players, coaches, privilege escalation
-- -----------------------------------------------------------------------------
set role authenticated;
select tests.login('alice');

insert into public.player_profiles (profile_id, sport, skill_level, rating_system, rating, dupr_id)
values (tests.uid('alice'), 'PICKLEBALL', 'INTERMEDIATE', 'DUPR', 3.512, 'ABC123');
select tests.eq((select rating from public.player_profiles where profile_id = tests.uid('alice')), 3.512::numeric(5,3),
                'DUPR rating stored with 3-decimal precision');

select tests.throws($$ insert into public.player_profiles (profile_id, sport, rating_system, rating)
                       values (tests.uid('alice'), 'TENNIS', 'DUPR', 3.5) $$,
                    '23514', 'DUPR rating rejected for tennis');
select tests.throws($$ insert into public.player_profiles (profile_id, sport) values (tests.uid('bob'), 'BADMINTON') $$,
                    '42501', 'cannot create a player profile for someone else');
select tests.throws($$ insert into public.platform_admins (profile_id) values (tests.uid('alice')) $$,
                    '42501', 'cannot self-grant platform admin');
select tests.eq((select count(*) from public.profile_contacts where profile_id = tests.uid('olivia'))::int, 0,
                'strangers cannot read contact details');
select tests.eq((select count(*) from public.profile_contacts where profile_id = tests.uid('alice'))::int, 1,
                'own contact details are visible');
select tests.eq(tests.affected($$ update public.profiles set full_name = 'Hacked' where id = tests.uid('bob') $$), 0::bigint,
                'cannot edit someone else''s profile');

select tests.login('carlos');
select tests.throws($$ insert into public.coach_profiles (profile_id, sports_coached, hourly_rate, verified_status)
                       values (tests.uid('carlos'), '{PICKLEBALL}', 800, 'VERIFIED') $$,
                    '42501', 'coaches cannot self-verify on insert');
insert into public.coach_profiles (profile_id, sports_coached, hourly_rate, offers_group_clinics, verified_status)
values (tests.uid('carlos'), '{PICKLEBALL}', 800, true, 'PENDING');
select tests.throws($$ update public.coach_profiles set verified_status = 'VERIFIED' where profile_id = tests.uid('carlos') $$,
                    '42501', 'coaches cannot self-verify on update');
select tests.throws($$ insert into public.coach_profiles (profile_id, sports_coached, hourly_rate)
                       values (tests.uid('alice'), '{TENNIS,TENNIS}', 500) $$,
                    null, 'duplicate sports rejected / cannot create for others');
select tests.ok((select is_coach from public.profiles where id = tests.uid('carlos')), 'is_coach flag synced from coach profile');

-- A platform admin verifies the coach (service-role context here).
reset role;
update public.coach_profiles set verified_status = 'VERIFIED' where profile_id = tests.uid('carlos');
select tests.ok((select verified_at is not null from public.coach_profiles where profile_id = tests.uid('carlos')),
                'verification stamps verified_at');

-- Editing credentials of a verified coach sends the profile back to review.
set role authenticated;
select tests.login('carlos');
update public.coach_profiles set credentials = '{"PPR Level 1"}' where profile_id = tests.uid('carlos');
select tests.eq((select verified_status::text from public.coach_profiles where profile_id = tests.uid('carlos')), 'PENDING',
                'changing credentials on a verified profile triggers re-review');
reset role;
update public.coach_profiles set verified_status = 'VERIFIED' where profile_id = tests.uid('carlos');

-- -----------------------------------------------------------------------------
-- Venue, staff, hours, courts, rate matrix
-- -----------------------------------------------------------------------------
set role authenticated;
select tests.login('olivia');

insert into public.venues (id, owner_id, name, municipality_code, barangay_code, address,
                           contact_number, gcash_account_name, gcash_number, amenities, verification_status)
values ('10000000-0000-4000-a000-000000000001', tests.uid('olivia'), 'Kapitolyo Pickleball Hub',
        '9900100000', '9900100001', '12 East Capitol Drive, Kapitolyo, Pasig',
        '+639170000001', 'Olivia O.', '+639170000001', '{LIGHTS,PARKING,PADDLE_RENTAL}', 'VERIFIED');

select tests.eq((select verification_status::text from public.venues where id = '10000000-0000-4000-a000-000000000001'),
                'UNVERIFIED', 'venues cannot self-verify');
select tests.ok((select is_venue_owner from public.profiles where id = tests.uid('olivia')), 'is_venue_owner flag set');

select tests.throws($$ insert into public.venues (owner_id, name, municipality_code, barangay_code, address)
                       values (tests.uid('olivia'), 'Wrong Barangay', '9900100000', '9904340101', 'Somewhere in Pasig') $$,
                    '23503', 'barangay must belong to the selected municipality');
select tests.throws($$ insert into public.venues (owner_id, name, municipality_code, barangay_code, address, timezone)
                       values (tests.uid('olivia'), 'Bad TZ', '9900100000', '9900100001', 'Somewhere in Pasig', 'Mars/Olympus') $$,
                    '22023', 'unknown venue time zone rejected');
select tests.throws($$ insert into public.venues (owner_id, name, municipality_code, barangay_code, address)
                       values (tests.uid('alice'), 'Not mine', '9900100000', '9900100001', 'Somewhere in Pasig') $$,
                    '42501', 'cannot create a venue owned by someone else');

-- Open 06:00–24:00 daily.
insert into public.venue_operating_hours (venue_id, day_of_week, opens_at, closes_at)
select '10000000-0000-4000-a000-000000000001', d, '06:00', '24:00' from generate_series(0, 6) as d;
select tests.throws($$ insert into public.venue_operating_hours (venue_id, day_of_week, opens_at, closes_at)
                       values ('10000000-0000-4000-a000-000000000001', 1, '20:00', '22:00') $$,
                    '23P01', 'overlapping opening windows rejected');

insert into public.courts (id, venue_id, name, sport, surface_type, is_indoor, hourly_rate, lights_fee_per_hour)
values ('20000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001', 'Court 1', 'PICKLEBALL', 'ACRYLIC', false, 400, 100),
       ('20000000-0000-4000-a000-000000000002', '10000000-0000-4000-a000-000000000001', 'Court 2', 'PICKLEBALL', 'ACRYLIC', false, 400, 100);

insert into public.court_rate_rules (court_id, label, days_of_week, start_time, end_time, hourly_rate, priority)
values ('20000000-0000-4000-a000-000000000001', 'Weeknight peak', '{1,2,3,4,5}', '17:00', '22:00', 600, 10),
       ('20000000-0000-4000-a000-000000000001', 'Weekend',        '{0,6}',       '00:00', '24:00', 700, 20);

insert into public.venue_managers (venue_id, profile_id) values ('10000000-0000-4000-a000-000000000001', tests.uid('mia'));

select tests.login('alice');
select tests.throws($$ insert into public.courts (venue_id, name, sport, surface_type, hourly_rate)
                       values ('10000000-0000-4000-a000-000000000001', 'Rogue', 'PICKLEBALL', 'CONCRETE', 1) $$,
                    '42501', 'only the owner can add courts');
select tests.eq(tests.affected($$ update public.court_rate_rules set hourly_rate = 1 $$), 0::bigint,
                'players cannot touch rate rules');

select tests.login('mia');
select tests.eq(tests.affected($$ update public.venues set name = 'Mia''s now' $$), 0::bigint,
                'managers cannot edit venue settings');

-- -----------------------------------------------------------------------------
-- Pricing (as anon: quotes are public)
-- -----------------------------------------------------------------------------
reset role;
set role anon;
select tests.logout();

select tests.eq((select count(*) from public.venues)::int, 1, 'anon can browse active venues');
select tests.eq((select count(*) from public.courts)::int, 2, 'anon can browse courts');
select tests.throws($$ select * from public.bookings $$, '42501', 'anon cannot read bookings');
select tests.throws($$ select * from public.profiles $$, '42501', 'anon cannot read profiles');

select tests.eq(
  (select row(q.court_amount, q.lights_amount, q.total_amount)::text
     from public.quote_court_booking('20000000-0000-4000-a000-000000000001', tests.slot(0, '10:00'), tests.slot(0, '11:00')) q),
  '(400.00,0.00,400.00)', 'Mon 10–11: base rate, no lights');

select tests.eq(
  (select row(q.court_amount, q.lights_amount, q.total_amount)::text
     from public.quote_court_booking('20000000-0000-4000-a000-000000000001', tests.slot(0, '17:00'), tests.slot(0, '19:00')) q),
  '(1200.00,100.00,1300.00)', 'Mon 17–19: weeknight peak plus one hour of lights');

select tests.eq(
  (select row(q.court_amount, q.lights_amount, q.total_amount)::text
     from public.quote_court_booking('20000000-0000-4000-a000-000000000001', tests.slot(0, '21:30'), tests.slot(0, '22:30')) q),
  '(500.00,100.00,600.00)', 'Mon 21:30–22:30: rate changes mid-booking (peak → base)');

select tests.eq(
  (select row(q.court_amount, q.lights_amount, q.total_amount)::text
     from public.quote_court_booking('20000000-0000-4000-a000-000000000001', tests.slot(5, '10:00'), tests.slot(5, '11:30')) q),
  '(1050.00,0.00,1050.00)', 'Sat 10–11:30: weekend rule outranks base');

select tests.eq(
  (select row(q.court_amount, q.coach_amount, q.total_amount)::text
     from public.quote_court_booking('20000000-0000-4000-a000-000000000001', tests.slot(0, '10:00'), tests.slot(0, '11:00'),
                                     tests.uid('carlos')) q),
  '(400.00,800.00,1200.00)', 'coach fee add-on priced from the coach''s hourly rate');

select tests.throws($$ select * from public.quote_court_booking('20000000-0000-4000-a000-000000000001',
                                     tests.slot(0, '10:10'), tests.slot(0, '11:00')) $$,
                    '22023', 'quotes reject off-grid times');
reset role;
