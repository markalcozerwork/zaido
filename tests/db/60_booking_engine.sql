-- =============================================================================
-- Step 3 booking engine: create_booking idempotency, on-behalf & walk-ins,
-- hold cap, late proofs, receipts, coach ledger + consent, event court
-- reservations, busy-slot RPCs, realtime broadcasts.
-- Venue 10000000-…-0001 (VERIFIED in 20_), courts c1/c2. Saturday = tests.slot(5, …).
-- =============================================================================
\set ON_ERROR_STOP 1
\set c1 '''20000000-0000-4000-a000-000000000001'''
\set c2 '''20000000-0000-4000-a000-000000000002'''
reset role;

-- A fresh player with no history, and an outsider venue owned by dave.
insert into auth.users (id, email, phone, raw_user_meta_data) values
  ('00000000-0000-4000-a000-000000000007', 'erin@example.ph', '639170000007', '{"full_name": "Erin Cruz"}');
insert into public.venues (id, owner_id, name, municipality_code, barangay_code, address)
values ('10000000-0000-4000-a000-000000000066', tests.uid('dave'), 'Dave''s Backyard Court', '9900100000', '9900100003', '3 Ugong Road, Pasig');
insert into public.courts (id, venue_id, name, sport, surface_type, hourly_rate)
values ('20000000-0000-4000-a000-000000000066', '10000000-0000-4000-a000-000000000066', 'Backyard', 'PICKLEBALL', 'CONCRETE', 100);

set role authenticated;

-- -----------------------------------------------------------------------------
-- create_booking: idempotent per checkout
-- -----------------------------------------------------------------------------
select tests.login('alice');
select id as b1 from public.create_booking(:c1, tests.slot(5, '06:00'), tests.slot(5, '07:00'), 'GCASH',
                                          p_idempotency_key => 'aaaaaaaa-0000-4000-a000-000000000001') \gset
select tests.eq((select created_by from public.bookings where id = :'b1'), tests.uid('alice'), 'created_by is stamped with the caller');
select tests.eq((select id from public.create_booking(:c1, tests.slot(5, '06:00'), tests.slot(5, '07:00'), 'GCASH',
                                                     p_idempotency_key => 'aaaaaaaa-0000-4000-a000-000000000001')),
                :'b1'::uuid, 'a retry with the same key returns the same booking (no SLOT_TAKEN for your own hold)');
select tests.throws($$ select * from public.create_booking('20000000-0000-4000-a000-000000000001', tests.slot(5, '07:00'), tests.slot(5, '08:00'),
                                                         'GCASH', p_idempotency_key => 'aaaaaaaa-0000-4000-a000-000000000001') $$,
                    '22023', 'reusing a key for a different slot is rejected');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(5, '06:30'), tests.slot(5, '07:30'), 'GCASH') $$, :c1),
                    '23P01', 'without a key, an overlapping booking is still SLOT_TAKEN');
select tests.eq((select count(*) from public.bookings where created_by = tests.uid('alice') and idempotency_key = 'aaaaaaaa-0000-4000-a000-000000000001')::int,
                1, 'exactly one row exists for the key');

select tests.login('bob');
select tests.ok((select id from public.create_booking(:c2, tests.slot(5, '06:00'), tests.slot(5, '07:00'), 'GCASH',
                                                     p_idempotency_key => 'aaaaaaaa-0000-4000-a000-000000000001')) <> :'b1'::uuid,
                'idempotency keys are scoped per user');

reset role;
set role anon;
select tests.logout();
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(5, '09:00'), tests.slot(5, '10:00'), 'GCASH') $$, :c1),
                    '42501', 'anon cannot call create_booking');
reset role;
set role authenticated;

-- -----------------------------------------------------------------------------
-- On-behalf bookings and walk-ins
-- -----------------------------------------------------------------------------
select tests.login('dave');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(5, '10:00'), tests.slot(5, '11:00'), 'CASH_ON_COURT',
                                                                 p_booked_by => tests.uid('erin')) $$, '20000000-0000-4000-a000-000000000066'),
                    null, 'an unverified (self-made) venue cannot book in another user''s name');
select tests.eq((select count(*) from public.profile_contacts where profile_id = tests.uid('erin'))::int, 0,
                'so it cannot use that to read their phone number');

select tests.login('mia');
select id as walkin from public.create_booking(:c2, tests.slot(5, '08:00'), tests.slot(5, '09:00'), 'CASH_ON_COURT',
                                               p_walk_in_name => 'Mang Jun', p_walk_in_phone => '+639181234567') \gset
select tests.eq((select booked_by::text || '/' || walk_in_name from public.bookings where id = :'walkin'),
                tests.uid('mia')::text || '/Mang Jun', 'front desk records a walk-in without an account');
select id as onbehalf from public.create_booking(:c2, tests.slot(5, '09:00'), tests.slot(5, '10:00'), 'CASH_ON_COURT',
                                                 p_booked_by => tests.uid('erin')) \gset
select tests.eq((select created_by from public.bookings where id = :'onbehalf'), tests.uid('mia'),
                'verified venue staff can book for a registered player (created_by = staff)');
select tests.eq((select count(*) from public.profile_contacts where profile_id = tests.uid('erin'))::int, 0,
                'a booking staff made for a player does not expose the player''s contacts');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(5, '11:00'), tests.slot(5, '12:00'), 'CASH_ON_COURT',
                                                                 p_booked_by => tests.uid('erin'),
                                                                 p_coach_id => tests.uid('carlos')) $$, :c2),
                    '42501', 'staff cannot book a coach on a player''s behalf');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(5, '11:00'), tests.slot(5, '12:00'), 'CASH_ON_COURT',
                                                                 p_discount_amount => 5000) $$, :c2),
                    '23514', 'a discount cannot exceed the court amount');

select tests.login('alice');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(5, '12:00'), tests.slot(5, '13:00'), 'CASH_ON_COURT',
                                                                 p_walk_in_name => 'Fake Walk-in') $$, :c2),
                    '42501', 'players cannot record walk-ins');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(5, '12:00'), tests.slot(5, '13:00'), 'CASH_ON_COURT',
                                                                 p_discount_amount => 100) $$, :c2),
                    '42501', 'players cannot give themselves a discount');
select tests.eq((select discount_amount from public.bookings where booked_by = tests.uid('alice') and start_time = tests.slot(5, '12:00')),
                null::numeric(10,2), '(the discounted booking was not created)');

-- -----------------------------------------------------------------------------
-- Hold cap, late proofs, receipts
-- -----------------------------------------------------------------------------
reset role;
update public.venues set max_active_holds_per_player = 2 where id = '10000000-0000-4000-a000-000000000001';
set role authenticated;
select tests.login('erin');
select id as erin_hold from public.create_booking(:c1, tests.slot(5, '14:00'), tests.slot(5, '15:00'), 'GCASH') \gset
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(5, '15:00'), tests.slot(5, '16:00'), 'GCASH') $$, :c1),
                    '23514', 'HOLD_LIMIT_REACHED once a player holds the venue''s cap (2, incl. the staff booking for Erin)');
reset role;
update public.venues set max_active_holds_per_player = 10 where id = '10000000-0000-4000-a000-000000000001';
-- Simulate the payment window passing before the sweeper ran.
update public.bookings set payment_due_at = now() - interval '10 minutes' where id = :'erin_hold';   -- past due + grace
set role authenticated;
select tests.login('erin');
select tests.throws(format($$ update public.bookings set payment_ref_no = '9000000000001', payment_status = 'AWAITING_VERIFICATION' where id = %L $$, :'erin_hold'),
                    '23514', 'a proof submitted after the window (and grace) closed is rejected (HOLD_EXPIRED)');

select tests.login('alice');
insert into storage.objects (bucket_id, name) values ('payment-receipts', :'b1' || '/gcash-1.jpg');
select tests.throws(format($$ update public.bookings set payment_ref_no = '9000000000002', payment_status = 'AWAITING_VERIFICATION',
                                     payment_receipt_url = '30000000-0000-4000-a000-000000000001/receipt.jpg' where id = %L $$, :'b1'),
                    '23514', 'a receipt from another booking''s folder is rejected');
select tests.throws(format($$ update public.bookings set payment_ref_no = '9000000000002', payment_status = 'AWAITING_VERIFICATION',
                                     payment_receipt_url = %L where id = %L $$, :'b1' || '/never-uploaded.jpg', :'b1'),
                    '23514', 'a receipt path that was never uploaded is rejected');
update public.bookings set payment_ref_no = '9000000000002', payment_status = 'AWAITING_VERIFICATION', payment_receipt_url = :'b1' || '/gcash-1.jpg'
 where id = :'b1';
select tests.ok(true, 'the booking''s own uploaded receipt is accepted');

-- -----------------------------------------------------------------------------
-- Coach ledger + consent
-- -----------------------------------------------------------------------------
select tests.login('alice');
select id as coached from public.create_booking(:c1, tests.slot(5, '10:00'), tests.slot(5, '11:00'), 'GCASH', p_coach_id => tests.uid('carlos')) \gset
reset role;
select tests.eq((select count(*) from app.coach_commitments where source_id = :'coached')::int, 1, 'a coached booking claims the coach in the ledger');
set role authenticated;

-- Someone names Carlos in an event: no effect until Carlos accepts.
select tests.login('dave');
select tests.throws($$ insert into public.events (organizer_id, coach_id, municipality_code, title, sport, event_type, start_time, end_time, max_participants)
                       values (tests.uid('dave'), tests.uid('carlos'), '9900100000', 'Fake clinic', 'PICKLEBALL', 'CLINIC',
                               tests.slot(5, '16:00'), tests.slot(5, '20:00'), 8) $$,
                    '23514', 'an event naming a coach cannot be published before the coach accepts');
insert into public.events (id, organizer_id, coach_id, municipality_code, title, sport, event_type, status, start_time, end_time, max_participants)
values ('50000000-0000-4000-a000-000000000061', tests.uid('dave'), tests.uid('carlos'), '9900100000', 'Fake clinic', 'PICKLEBALL', 'CLINIC', 'DRAFT',
        tests.slot(5, '16:00'), tests.slot(5, '20:00'), 8);
select tests.throws($$ update public.events set coach_confirmed_at = now() where id = '50000000-0000-4000-a000-000000000061' $$,
                    '42501', 'only the coach can accept');
select tests.login('bob');
select tests.ok((select id is not null from public.create_booking(:c2, tests.slot(5, '17:00'), tests.slot(5, '18:00'), 'GCASH',
                                                                 p_coach_id => tests.uid('carlos'))),
                'an unconfirmed event does not block the coach (no denial-of-service by naming a coach)');

-- Olivia drafts a clinic overlapping Alice's coached booking; Carlos accepting it must clash.
select tests.login('olivia');
insert into public.events (id, organizer_id, coach_id, municipality_code, title, sport, event_type, status, start_time, end_time, max_participants)
values ('50000000-0000-4000-a000-000000000062', tests.uid('olivia'), tests.uid('carlos'), '9900100000', 'Beginner clinic', 'PICKLEBALL', 'CLINIC', 'DRAFT',
        tests.slot(5, '10:30'), tests.slot(5, '12:00'), 8);
select tests.login('carlos');
update public.events set coach_confirmed_at = now() where id = '50000000-0000-4000-a000-000000000062';
select tests.login('olivia');
select tests.throws($$ update public.events set status = 'SCHEDULED' where id = '50000000-0000-4000-a000-000000000062' $$,
                    '23P01', 'publishing a clinic that overlaps the coach''s booking is COACH_UNAVAILABLE');

-- A non-overlapping clinic: published, then it blocks bookings by players who cannot even see it.
insert into public.events (id, organizer_id, coach_id, municipality_code, title, sport, event_type, status, start_time, end_time, max_participants)
values ('50000000-0000-4000-a000-000000000063', tests.uid('olivia'), tests.uid('carlos'), '9900100000', 'Drills clinic', 'PICKLEBALL', 'CLINIC', 'DRAFT',
        tests.slot(5, '12:00'), tests.slot(5, '14:00'), 8);
select tests.login('carlos');
update public.events set coach_confirmed_at = now() where id = '50000000-0000-4000-a000-000000000063';
select tests.login('olivia');
update public.events set status = 'SCHEDULED' where id = '50000000-0000-4000-a000-000000000063';
select tests.login('erin');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(5, '13:00'), tests.slot(5, '14:00'), 'CASH_ON_COURT',
                                                                 p_coach_id => tests.uid('carlos')) $$, :c2),
                    '23P01', 'a booking overlapping the coach''s confirmed clinic is COACH_UNAVAILABLE (checked RLS-independently)');

-- Moving a confirmed coached event needs the coach again.
select tests.login('olivia');
select tests.throws($$ update public.events set start_time = start_time + interval '30 minutes', end_time = end_time + interval '30 minutes'
                        where id = '50000000-0000-4000-a000-000000000063' $$,
                    '23514', 'rescheduling a published coached event resets the coach''s acceptance');
select tests.login('carlos');
update public.events set start_time = start_time + interval '30 minutes', end_time = end_time + interval '30 minutes'
 where id = '50000000-0000-4000-a000-000000000063';
select tests.ok(true, 'the coach can reschedule their own published clinic');

-- Cancelling the clinic releases the coach.
update public.events set status = 'CANCELLED' where id = '50000000-0000-4000-a000-000000000063';
select tests.login('erin');
select tests.ok((select id is not null from public.create_booking(:c2, tests.slot(5, '13:00'), tests.slot(5, '14:00'), 'CASH_ON_COURT',
                                                                 p_coach_id => tests.uid('carlos'))),
                'after the clinic is cancelled the coach is bookable again');

-- Published availability is respected.
reset role;
insert into public.coach_availability (coach_id, day_of_week, start_time, end_time) values (tests.uid('carlos'), 1, '06:00', '09:00');
set role authenticated;
select tests.login('alice');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(5, '18:00'), tests.slot(5, '19:00'), 'GCASH',
                                                                 p_coach_id => tests.uid('carlos')) $$, :c1),
                    '23514', 'booking a coach outside their published availability is rejected');
reset role;
delete from public.coach_availability where coach_id = tests.uid('carlos');
set role authenticated;

-- -----------------------------------------------------------------------------
-- Event court reservations
-- -----------------------------------------------------------------------------
-- Booking …040 holds Court 2 for Carlos's open play (published in 40_).
select tests.login('carlos');
select tests.throws($$ update public.bookings set booking_status = 'CANCELLED' where id = '30000000-0000-4000-a000-000000000040' $$,
                    '23514', 'the court booking of a live event cannot be cancelled (COURT_RESERVED_FOR_EVENT)');
select tests.login('mia');
select tests.throws($$ update public.bookings set start_time = start_time + interval '1 hour', end_time = end_time + interval '1 hour'
                        where id = '30000000-0000-4000-a000-000000000040' $$,
                    '23514', 'venue staff cannot move it out from under the event either');
select tests.throws($$ update public.bookings set reserved_for_event_id = null where id = '30000000-0000-4000-a000-000000000040' $$,
                    '42501', 'the reservation link itself is not client-writable');

-- Linking rules.
select tests.login('alice');
select tests.throws(format($$ insert into public.events (organizer_id, venue_id, court_id, booking_id, title, sport, event_type, start_time, end_time, max_participants)
                              values (tests.uid('alice'), '10000000-0000-4000-a000-000000000001', %L, %L, 'Pending-court social', 'PICKLEBALL',
                                      'OPEN_PLAY', tests.slot(5, '06:00'), tests.slot(5, '07:00'), 4) $$, :c1, :'b1'),
                    '23514', 'a live event cannot sit on an unpaid (pending) booking');
select tests.throws(format($$ insert into public.events (organizer_id, venue_id, court_id, booking_id, title, sport, event_type, start_time, end_time, max_participants)
                              values (tests.uid('alice'), '10000000-0000-4000-a000-000000000001', %L, %L, 'Borrowed court', 'PICKLEBALL',
                                      'OPEN_PLAY', tests.slot(5, '09:00'), tests.slot(5, '10:00'), 4) $$, :c2, :'onbehalf'),
                    '23514', 'an event cannot borrow someone else''s booking');

-- An expired hold linked to a DRAFT event never jams the expiry sweep.
select id as draft_hold from public.create_booking(:c1, tests.slot(5, '20:00'), tests.slot(5, '21:00'), 'GCASH') \gset
insert into public.events (id, organizer_id, venue_id, court_id, booking_id, title, sport, event_type, status, start_time, end_time, max_participants)
values ('50000000-0000-4000-a000-000000000064', tests.uid('alice'), '10000000-0000-4000-a000-000000000001', :c1, :'draft_hold',
        'Draft social on a hold', 'PICKLEBALL', 'OPEN_PLAY', 'DRAFT', tests.slot(5, '20:00'), tests.slot(5, '21:00'), 4);
reset role;
update public.bookings set payment_due_at = now() - interval '10 minutes' where id in (:'draft_hold', :'erin_hold');
select tests.ok(app.expire_unpaid_bookings() >= 2, 'the sweep expires holds, including one linked to a draft event');
select tests.eq((select booking_status::text from public.bookings where id = :'draft_hold'), 'CANCELLED', 'the linked draft hold was released');
set role authenticated;
select tests.login('alice');
select tests.throws($$ update public.events set status = 'SCHEDULED' where id = '50000000-0000-4000-a000-000000000064' $$,
                    '23514', 'and the draft can no longer be published on the cancelled booking');

-- Cancelling the event releases the court booking.
select tests.login('carlos');
update public.events set status = 'CANCELLED' where id = '50000000-0000-4000-a000-000000000001';
select tests.eq((select reserved_for_event_id from public.bookings where id = '30000000-0000-4000-a000-000000000040'), null::uuid,
                'cancelling the event releases its court booking');
update public.bookings set booking_status = 'CANCELLED' where id = '30000000-0000-4000-a000-000000000040';
select tests.ok(true, 'and then the organiser can cancel the booking');

-- -----------------------------------------------------------------------------
-- Busy-slot RPCs and broadcasts
-- -----------------------------------------------------------------------------
reset role;
set role anon;
select tests.logout();
select tests.ok((select count(*) from public.get_court_busy_slots(:c2, tests.slot(5, '00:00'), tests.slot(6, '00:00')) where held_until is not null) >= 1,
                'busy slots report when an unpaid hold frees itself (held_until)');
select tests.ok((select count(*) from public.get_coach_busy_slots(tests.uid('carlos'), tests.slot(5, '00:00'), tests.slot(6, '00:00'))) >= 2,
                'anyone can see when a coach is busy (times only)');
reset role;

select tests.eq((select count(*) from realtime.messages where topic = 'court:' || :c1 || ':slots' and private
                   and payload ->> 'start_time' is not null)::int > 0, true, 'slot changes are broadcast on the private court topic');
select tests.ok(not exists (select 1 from realtime.messages where payload ?| array['booked_by', 'created_by', 'total_amount', 'payment_ref_no']),
                'broadcast payloads carry no identities or money');
select tests.ok(exists (select 1 from realtime.messages where topic = 'court:' || :c1 || ':slots'
                         and payload ->> 'busy' = 'false' and (payload ->> 'start_time')::timestamptz = tests.slot(5, '20:00')),
                'expiry of a hold is broadcast as busy=false');
set role authenticated;
select tests.throws($$ insert into realtime.messages (topic, extension, payload, event) values ('court:x:slots', 'broadcast', '{}', 'slot_changed') $$,
                    '42501', 'clients cannot write (spoof) broadcast messages: RLS has no INSERT policy');
reset role;

-- =============================================================================
-- Step 3, round 2: timing rules, closures, typed outcomes, staff tools,
-- Realtime authorization
-- =============================================================================
-- A 24/7 test venue with 15-minute slots, so time-relative rules don't depend
-- on when the suite runs.
insert into public.venues (id, owner_id, name, municipality_code, barangay_code, address, gcash_account_name, gcash_number,
                           is_open_24h, verification_status, max_active_holds_per_player)
values ('10000000-0000-4000-a000-000000000077', tests.uid('olivia'), 'Night Owl Courts', '9900100000', '9900100002',
        '7 Night Owl Street, Pasig', 'Olivia O.', '+639170000001', true, 'VERIFIED', 20);
insert into public.courts (id, venue_id, name, sport, surface_type, hourly_rate, slot_increment_minutes, min_booking_minutes)
values ('20000000-0000-4000-a000-000000000077', '10000000-0000-4000-a000-000000000077', 'Owl 1', 'PICKLEBALL', 'ACRYLIC', 300, 15, 60);
\set owl '''20000000-0000-4000-a000-000000000077'''
-- 15-45 minutes from now, on the 15-minute grid: inside the 30-minute payment window.
select date_bin('15 minutes', now(), timestamptz '2000-01-01') + interval '30 minutes' as soon \gset

set role authenticated;
select tests.login('alice');
select tests.throws(format($$ select * from public.create_booking(%L, %L::timestamptz, %L::timestamptz + interval '1 hour', 'GCASH') $$, :owl, :'soon', :'soon'),
                    '23514', 'PAY_FIRST: an unpaid e-wallet hold may not start inside its own payment window');
select id as paid_first from public.create_booking(:owl, :'soon'::timestamptz, :'soon'::timestamptz + interval '1 hour', 'GCASH',
                                                   p_payment_ref_no => '9100000000001') \gset
select tests.eq((select payment_status::text from public.bookings where id = :'paid_first'), 'AWAITING_VERIFICATION',
                'paying first (reference attached) books a last-minute slot');
select tests.throws(format($$ select * from public.create_booking(%L, %L::timestamptz, %L::timestamptz + interval '1 hour', 'GCASH',
                                                                 p_idempotency_key => gen_random_uuid(), p_payment_ref_no => '9100000000002') $$,
                           :owl, :'soon', :'soon'),
                    '23P01', 'booking your own slot again with a new key says SLOT_ALREADY_YOURS, not "taken by someone"');
select tests.ok(exists (select 1 from public.get_court_busy_slots(:owl, :'soon'::timestamptz, :'soon'::timestamptz + interval '1 hour')
                         where is_mine and booking_id = :'paid_first'::uuid and kind = 'BOOKED'),
                'busy slots identify the caller''s own booking (id included) as BOOKED once paid-in');

reset role;
update public.venues set min_lead_minutes = 120, booking_horizon_days = 7 where id = '10000000-0000-4000-a000-000000000077';
set role authenticated;
select tests.throws(format($$ select * from public.create_booking(%L, %L::timestamptz + interval '1 hour', %L::timestamptz + interval '2 hours', 'CASH_ON_COURT') $$,
                           :owl, :'soon', :'soon'),
                    '23514', 'TOO_SOON: the venue''s minimum lead time applies');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(0, '10:00'), tests.slot(0, '11:00'), 'CASH_ON_COURT') $$, :owl),
                    '23514', 'BEYOND_HORIZON: the venue''s day-based booking horizon applies');
reset role;
update public.venues set min_lead_minutes = 0, booking_horizon_days = 90, is_open_24h = false where id = '10000000-0000-4000-a000-000000000077';
set role authenticated;
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(0, '03:00'), tests.slot(0, '04:00'), 'CASH_ON_COURT') $$, :owl),
                    '23514', 'VENUE_HOURS_NOT_SET: no published hours and not marked 24/7 means no player bookings');
reset role;
update public.venues set is_open_24h = true where id = '10000000-0000-4000-a000-000000000077';

-- Grace: a proof a couple of minutes late is still accepted.
insert into public.bookings (id, court_id, booked_by, start_time, end_time, payment_method, payment_due_at)
values ('30000000-0000-4000-a000-000000000077', :owl, tests.uid('bob'), tests.slot(3, '20:00'), tests.slot(3, '21:00'), 'GCASH',
        now() - interval '2 minutes');
set role authenticated;
select tests.login('bob');
update public.bookings set payment_ref_no = '9100000000003', payment_status = 'AWAITING_VERIFICATION'
 where id = '30000000-0000-4000-a000-000000000077';
select tests.ok(true, 'a proof within the 5-minute grace after the due time is accepted');

-- Cancelling: never after start; the cutoff also applies once money was sent.
reset role;
insert into public.bookings (id, court_id, booked_by, start_time, end_time, payment_method)
values ('30000000-0000-4000-a000-000000000078', :owl, tests.uid('alice'),
        date_bin('15 minutes', now(), timestamptz '2000-01-01') - interval '30 minutes',
        date_bin('15 minutes', now(), timestamptz '2000-01-01') + interval '30 minutes', 'CASH_ON_COURT');
insert into public.bookings (id, court_id, booked_by, start_time, end_time, payment_method, payment_ref_no, payment_status)
values ('30000000-0000-4000-a000-000000000079', :owl, tests.uid('alice'),
        date_bin('15 minutes', now(), timestamptz '2000-01-01') + interval '3 hours',
        date_bin('15 minutes', now(), timestamptz '2000-01-01') + interval '4 hours', 'GCASH', '9100000000004',
        'AWAITING_VERIFICATION');
set role authenticated;
select tests.login('alice');
select tests.throws($$ update public.bookings set booking_status = 'CANCELLED' where id = '30000000-0000-4000-a000-000000000078' $$,
                    '23514', 'CANCELLATION_CLOSED: a booking cannot be cancelled once it has started');
select tests.throws($$ update public.bookings set booking_status = 'CANCELLED' where id = '30000000-0000-4000-a000-000000000079' $$,
                    '23514', 'CANCELLATION_CUTOFF also applies to a paid-but-unverified booking');

-- Closures.
select tests.login('mia');
insert into public.court_closures (venue_id, court_id, starts_at, ends_at, reason, created_by)
values ('10000000-0000-4000-a000-000000000001', :c1, tests.slot(6, '15:00'), tests.slot(6, '17:00'), 'Typhoon Signal No. 2', tests.uid('mia'));
select tests.login('alice');
select tests.throws($$ insert into public.court_closures (venue_id, starts_at, ends_at, reason, created_by)
                       values ('10000000-0000-4000-a000-000000000001', tests.slot(6, '15:00'), tests.slot(6, '17:00'), 'Fake', tests.uid('alice')) $$,
                    '42501', 'only venue staff can close courts');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(6, '16:00'), tests.slot(6, '17:00'), 'CASH_ON_COURT') $$, :c1),
                    '23514', 'COURT_CLOSED: no player bookings during a closure');
select tests.eq((select kind || ':' || reason from public.get_court_busy_slots(:c1, tests.slot(6, '00:00'), tests.slot(7, '00:00')) where kind = 'CLOSED'),
                'CLOSED:Typhoon Signal No. 2', 'closures show in availability with their reason');
select tests.ok((select count(distinct court_id) from public.get_venue_busy_slots('10000000-0000-4000-a000-000000000001',
                                                                                  tests.slot(5, '00:00'), tests.slot(7, '00:00'))) >= 2,
                'one call returns busy slots for every court of a venue');

-- Front desk: cash collected now; walk-ins are never "mine".
select tests.login('mia');
select id as cash_now from public.create_booking(:c1, tests.slot(6, '19:00'), tests.slot(6, '20:00'), 'CASH_ON_COURT',
                                                 p_walk_in_name => 'Ate Lorna', p_mark_paid => true) \gset
select tests.eq((select booking_status::text || '/' || payment_status::text from public.bookings where id = :'cash_now'),
                'CONFIRMED/PAID', 'front desk books and marks cash collected in one call');
select tests.ok(not exists (select 1 from public.get_court_busy_slots(:c1, tests.slot(6, '19:00'), tests.slot(6, '20:00')) where is_mine),
                'walk-ins never show as the staff member''s own bookings');
select tests.login('alice');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(6, '20:00'), tests.slot(6, '21:00'), 'CASH_ON_COURT', p_mark_paid => true) $$, :c1),
                    '42501', 'players cannot mark their own booking paid');

-- -----------------------------------------------------------------------------
-- Realtime authorization (emulating Realtime's private-channel join check)
-- -----------------------------------------------------------------------------
reset role;
select tests.ok(exists (select 1 from realtime.messages where topic = 'court:' || :c1 || ':slots' and payload ? 'id'),
                'broadcast payloads carry the id realtime.send adds (clients must parse loosely)');
insert into realtime.messages (topic, extension, payload, event, private)
values ('court:' || :c1 || ':slots', 'broadcast', '{"probe": true}', 'probe', true),
       ('chat:secret', 'broadcast', '{"probe": true}', 'probe', true);
set role anon;
select set_config('realtime.topic', 'court:' || :c1 || ':slots', false);
select tests.ok(exists (select 1 from realtime.messages where event = 'probe' and topic like 'court:%'),
                'anon may join (receive on) a private court slot topic');
select set_config('realtime.topic', 'chat:secret', false);
select tests.ok(not exists (select 1 from realtime.messages where event = 'probe'),
                'but not on any other private topic');
reset role;
select set_config('realtime.topic', '', false);

-- =============================================================================
-- Step 3, round 3: covered clinics, sweeps vs. old clashes, single-write
-- mark-paid, closures, walk-in edits, hold re-announcements
-- =============================================================================
set role authenticated;

-- A clinic run on its coach's own court booking: the booking commits the coach
-- for its whole range; the event adds nothing, and can still be cancelled.
select tests.login('olivia');
select id as cov_booking from public.create_booking(:c2, tests.slot(8, '09:00'), tests.slot(8, '12:00'), 'CASH_ON_COURT',
                                                    p_coach_id => tests.uid('carlos')) \gset
insert into public.events (id, venue_id, court_id, booking_id, coach_id, organizer_id, title, sport, event_type, status,
                           start_time, end_time, max_participants)
values ('50000000-0000-4000-a000-000000000081', '10000000-0000-4000-a000-000000000001', :c2, :'cov_booking', tests.uid('carlos'),
        tests.uid('olivia'), 'Covered clinic', 'PICKLEBALL', 'CLINIC', 'DRAFT', tests.slot(8, '09:30'), tests.slot(8, '11:30'), 8);
select tests.login('carlos');
update public.events set coach_confirmed_at = now() where id = '50000000-0000-4000-a000-000000000081';
select tests.login('olivia');
update public.events set status = 'SCHEDULED' where id = '50000000-0000-4000-a000-000000000081';
select tests.ok(true, 'a clinic can go live on its own coach''s court booking');
reset role;
select tests.eq((select string_agg(source_kind, ',' order by source_kind) from app.coach_commitments
                  where source_id in (:'cov_booking', '50000000-0000-4000-a000-000000000081')),
                'BOOKING', 'the covering booking holds the coach; the covered event adds no second row');
set role authenticated;
select tests.login('erin');
select tests.throws(format($$ select * from public.create_booking(%L, tests.slot(8, '11:30'), tests.slot(8, '12:30'), 'CASH_ON_COURT',
                                                                 p_coach_id => tests.uid('carlos')) $$, :c1),
                    '23P01', 'the coach stays committed for the part of the booking outside the event');
select tests.login('olivia');
update public.events set status = 'CANCELLED' where id = '50000000-0000-4000-a000-000000000081';
select tests.ok(true, 'the covered clinic can be cancelled');
reset role;
select tests.eq((select count(*) from app.coach_commitments where source_id = :'cov_booking')::int, 1,
                'after the event is cancelled the booking still commits the coach');
select tests.eq((select reserved_for_event_id from public.bookings where id = :'cov_booking'), null::uuid,
                'cancelling the event releases its court booking');

-- A trusted actor cancelling a covering booking puts the event's own row back.
set role authenticated;
select tests.login('olivia');
select id as cov2 from public.create_booking(:c2, tests.slot(8, '14:00'), tests.slot(8, '16:00'), 'CASH_ON_COURT',
                                             p_coach_id => tests.uid('carlos')) \gset
insert into public.events (id, venue_id, court_id, booking_id, coach_id, organizer_id, title, sport, event_type, status,
                           start_time, end_time, max_participants)
values ('50000000-0000-4000-a000-000000000082', '10000000-0000-4000-a000-000000000001', :c2, :'cov2', tests.uid('carlos'),
        tests.uid('olivia'), 'Covered clinic 2', 'PICKLEBALL', 'CLINIC', 'DRAFT', tests.slot(8, '14:00'), tests.slot(8, '16:00'), 8);
select tests.login('carlos');
update public.events set coach_confirmed_at = now() where id = '50000000-0000-4000-a000-000000000082';
select tests.login('olivia');
update public.events set status = 'SCHEDULED' where id = '50000000-0000-4000-a000-000000000082';
reset role;
update public.bookings set booking_status = 'CANCELLED', cancellation_reason = 'VENUE_CANCELLED' where id = :'cov2';
select tests.eq((select string_agg(source_kind, ',') from app.coach_commitments
                  where source_id in (:'cov2', '50000000-0000-4000-a000-000000000082')),
                'EVENT', 'when its covering booking is cancelled, the live event commits the coach itself');

-- A clash that predates the ledger (no ledger row) must not abort the sweeps.
alter table public.bookings disable trigger bookings_40_coach_commitments;
insert into public.bookings (id, court_id, booked_by, coach_id, start_time, end_time, payment_method, booking_status)
values ('30000000-0000-4000-a000-000000000083', :c1, tests.uid('bob'), tests.uid('carlos'),
        tests.slot(8, '14:30'), tests.slot(8, '15:30'), 'CASH_ON_COURT', 'CONFIRMED');
alter table public.bookings enable trigger bookings_40_coach_commitments;
update public.bookings set payment_status = 'PAID', booking_status = 'COMPLETED' where id = '30000000-0000-4000-a000-000000000083';
select tests.ok(true, 'a status flip on an old clashing booking leaves the ledger alone (sweeps cannot abort on it)');

-- An event going live over the coach's dead-but-unswept hold expires the hold.
insert into public.bookings (id, court_id, booked_by, coach_id, start_time, end_time, payment_method, payment_due_at)
values ('30000000-0000-4000-a000-000000000084', :c1, tests.uid('bob'), tests.uid('carlos'),
        tests.slot(8, '18:00'), tests.slot(8, '19:00'), 'GCASH', now() - interval '10 minutes');
insert into public.events (id, coach_id, organizer_id, municipality_code, title, sport, event_type, status, coach_confirmed_at,
                           start_time, end_time, max_participants)
values ('50000000-0000-4000-a000-000000000084', tests.uid('carlos'), tests.uid('carlos'), '9900100000', 'Park clinic',
        'PICKLEBALL', 'CLINIC', 'DRAFT', now(), tests.slot(8, '18:00'), tests.slot(8, '20:00'), 8);
set role authenticated;
select tests.login('carlos');
update public.events set status = 'SCHEDULED' where id = '50000000-0000-4000-a000-000000000084';
reset role;
select tests.eq((select booking_status::text || '/' || cancellation_reason::text from public.bookings where id = '30000000-0000-4000-a000-000000000084'),
                'CANCELLED/PAYMENT_WINDOW_EXPIRED',
                'publishing a clinic over the coach''s expired hold expires the hold instead of failing');

-- A rejected proof re-opens the hold with a new expiry: announced to the grid.
set role authenticated;
select tests.login('olivia');
update public.bookings set payment_status = 'REJECTED', payment_rejection_reason = 'Reference not found'
 where id = '30000000-0000-4000-a000-000000000077';
reset role;
select tests.ok(exists (select 1 from realtime.messages m, public.bookings b
                         where b.id = '30000000-0000-4000-a000-000000000077'
                           and m.topic = 'court:' || b.court_id || ':slots'
                           and (m.payload->>'busy')::boolean
                           and (m.payload->>'held_until')::timestamptz = b.payment_due_at + app.hold_grace()),
                'a rejected proof re-announces the slot as a hold with its new expiry');

-- Front desk mark-paid is one write: one history row, verified, no payment window.
set role authenticated;
select tests.login('mia');
select id as gcash_now from public.create_booking(:c2, tests.slot(6, '19:00'), tests.slot(6, '20:00'), 'GCASH',
                                                  p_walk_in_name => 'Kuya Ben', p_walk_in_phone => '+639171234567',
                                                  p_payment_ref_no => '9100000000099', p_mark_paid => true) \gset
reset role;
select tests.eq((select booking_status::text || '/' || payment_status::text || '/' || (payment_verified_at is not null)::text
                        || '/' || coalesce(payment_due_at::text, 'none')
                   from public.bookings where id = :'gcash_now'),
                'CONFIRMED/PAID/true/none', 'a desk e-wallet payment is confirmed and verified with no payment window');
select tests.eq((select count(*) from public.booking_status_history where booking_id = :'gcash_now')::int, 1,
                'mark-paid writes the booking once (a single history entry)');

-- Walk-in typos: staff fix them, players can't touch them.
set role authenticated;
select tests.login('mia');
update public.bookings set walk_in_name = 'Kuya Benjie' where id = :'gcash_now';
select tests.eq((select walk_in_name from public.bookings where id = :'gcash_now'), 'Kuya Benjie', 'staff can correct a walk-in name');
select tests.login('alice');
select tests.throws(format($$ update public.bookings set walk_in_name = 'Me' where id = %L $$, :'b1'),
                    '42501', 'players cannot set walk-in details');

-- Closures: creator recorded by the database; any staff member can edit; edits are broadcast.
select tests.login('mia');
insert into public.court_closures (id, venue_id, court_id, starts_at, ends_at, reason, created_by)
values ('60000000-0000-4000-a000-000000000085', '10000000-0000-4000-a000-000000000001', :c2,
        tests.slot(8, '06:00'), tests.slot(8, '08:00'), 'Resurfacing', tests.uid('alice'));
select tests.login('olivia');
update public.court_closures set ends_at = tests.slot(8, '08:30'), reason = 'Resurfacing (extended)'
 where id = '60000000-0000-4000-a000-000000000085';
reset role;
select tests.eq((select created_by from public.court_closures where id = '60000000-0000-4000-a000-000000000085'), tests.uid('mia'),
                'a closure''s creator is stamped by the database and survives edits by other staff');
select tests.ok(exists (select 1 from realtime.messages
                         where topic = 'court:' || :c2 || ':slots' and not (payload->>'busy')::boolean
                           and (payload->>'end_time')::timestamptz = tests.slot(8, '08:00'))
                and exists (select 1 from realtime.messages
                             where topic = 'court:' || :c2 || ':slots' and (payload->>'busy')::boolean
                               and (payload->>'end_time')::timestamptz = tests.slot(8, '08:30')),
                'editing a closure announces the old range free and the new range closed');
