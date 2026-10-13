-- =============================================================================
-- Bookings: double-booking prevention, pricing integrity, payment lifecycle,
-- permissions, hold expiry, audit trail.
-- Court 1 = 20000000-…-0001, Court 2 = 20000000-…-0002 (venue 10000000-…-0001)
-- =============================================================================
\set ON_ERROR_STOP 1
\set c1 '''20000000-0000-4000-a000-000000000001'''
\set c2 '''20000000-0000-4000-a000-000000000002'''
reset role;
set role authenticated;

-- -----------------------------------------------------------------------------
-- Create + server-side pricing
-- -----------------------------------------------------------------------------
select tests.login('alice');

insert into public.bookings (id, court_id, booked_by, start_time, end_time, payment_method,
                             court_amount, total_amount, booking_status, payment_status)
values ('30000000-0000-4000-a000-000000000001', :c1, tests.uid('alice'),
        tests.slot(0, '10:00'), tests.slot(0, '11:00'), 'GCASH',
        1, 1, 'CONFIRMED', 'PAID');   -- tampered amounts and statuses

select tests.eq((select total_amount from public.bookings where id = '30000000-0000-4000-a000-000000000001'), 400.00::numeric(10,2),
                'client-supplied amount ignored; server price applied');
select tests.eq((select booking_status::text || '/' || payment_status::text from public.bookings
                  where id = '30000000-0000-4000-a000-000000000001'), 'PENDING_PAYMENT/UNPAID',
                'client cannot create a pre-confirmed or pre-paid booking');
select tests.ok((select payment_due_at between now() + interval '29 minutes' and now() + interval '31 minutes'
                   from public.bookings where id = '30000000-0000-4000-a000-000000000001'),
                'e-wallet hold expires after the venue payment window (30 min)');
select tests.ok((select reference_code ~ '^RH-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$' from public.bookings
                  where id = '30000000-0000-4000-a000-000000000001'),
                'human-friendly reference code generated');
select tests.eq((select venue_id from public.bookings where id = '30000000-0000-4000-a000-000000000001'),
                '10000000-0000-4000-a000-000000000001'::uuid, 'venue_id derived from the court');

-- -----------------------------------------------------------------------------
-- THE double-booking guarantee
-- -----------------------------------------------------------------------------
select tests.login('bob');
select tests.throws(format($$ insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
                              values (%L, tests.uid('bob'), tests.slot(0, '10:30'), tests.slot(0, '11:30'), 'GCASH') $$, :c1),
                    '23P01', 'overlapping booking on the same court rejected by exclusion constraint');
select tests.throws(format($$ insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
                              values (%L, tests.uid('bob'), tests.slot(0, '09:00'), tests.slot(0, '12:00'), 'GCASH') $$, :c1),
                    '23P01', 'enclosing booking rejected');

insert into public.bookings (id, court_id, booked_by, start_time, end_time, payment_method)
values ('30000000-0000-4000-a000-000000000002', :c1, tests.uid('bob'), tests.slot(0, '11:00'), tests.slot(0, '12:00'), 'GCASH');
select tests.ok(true, 'back-to-back booking accepted ([start, end) is half-open)');

insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
values (:c2, tests.uid('bob'), tests.slot(0, '10:00'), tests.slot(0, '11:00'), 'GCASH');
select tests.ok(true, 'same time on a different court accepted');

-- -----------------------------------------------------------------------------
-- Slot rules
-- -----------------------------------------------------------------------------
select tests.throws(format($$ insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
                              values (%L, tests.uid('bob'), tests.slot(1, '10:10'), tests.slot(1, '11:10'), 'GCASH') $$, :c1),
                    '23514', 'off the 15-minute grid rejected');
select tests.throws(format($$ insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
                              values (%L, tests.uid('bob'), tests.slot(1, '10:15'), tests.slot(1, '11:15'), 'GCASH') $$, :c1),
                    '23514', 'off the court''s 30-minute increment rejected');
select tests.throws(format($$ insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
                              values (%L, tests.uid('bob'), tests.slot(1, '10:00'), tests.slot(1, '10:30'), 'GCASH') $$, :c1),
                    '23514', 'shorter than the court minimum rejected');
select tests.throws(format($$ insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
                              values (%L, tests.uid('bob'), tests.slot(1, '05:00'), tests.slot(1, '06:00'), 'GCASH') $$, :c1),
                    '23514', 'outside opening hours rejected');
select tests.throws(format($$ insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
                              values (%L, tests.uid('bob'), now() - interval '1 day', now() - interval '23 hours', 'GCASH') $$, :c1),
                    null, 'past slot rejected');
select tests.throws(format($$ insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
                              values (%L, tests.uid('bob'), tests.slot(1, '10:00'), tests.slot(1, '11:00'), 'MAYA') $$, :c1),
                    '23514', 'payment channel the venue has not set up rejected');
select tests.throws(format($$ insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
                              values (%L, tests.uid('alice'), tests.slot(1, '10:00'), tests.slot(1, '11:00'), 'GCASH') $$, :c1),
                    '42501', 'cannot book on someone else''s behalf');

-- Late-night slot that runs until closing at 24:00.
insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
values (:c1, tests.uid('bob'), tests.slot(2, '23:00'), tests.slot(3, '00:00'), 'GCASH');
select tests.ok(true, 'slot ending exactly at a 24:00 closing time accepted');

-- -----------------------------------------------------------------------------
-- Visibility & availability
-- -----------------------------------------------------------------------------
select tests.eq((select count(*) from public.bookings where booked_by = tests.uid('alice'))::int, 0,
                'players cannot see other players'' bookings');
select tests.eq(tests.affected($$ update public.bookings set notes = 'mine now' where id = '30000000-0000-4000-a000-000000000001' $$),
                0::bigint, 'players cannot modify other players'' bookings');
select tests.eq(
  (select string_agg(to_char(s.start_time at time zone 'Asia/Manila', 'HH24:MI') || '-' || s.is_mine::text, ',' order by s.start_time)
     from public.get_court_busy_slots(:c1, tests.slot(0, '00:00'), tests.slot(1, '00:00')) s),
  '10:00-false,11:00-true', 'busy-slot RPC exposes ranges only, flags the caller''s own');

-- -----------------------------------------------------------------------------
-- Booker permissions & payment submission
-- -----------------------------------------------------------------------------
select tests.login('alice');
select tests.throws($$ update public.bookings set booking_status = 'CONFIRMED' where id = '30000000-0000-4000-a000-000000000001' $$,
                    '42501', 'booker cannot confirm their own booking');
select tests.throws($$ update public.bookings set total_amount = 0, court_amount = 0 where id = '30000000-0000-4000-a000-000000000001' $$,
                    '42501', 'booker cannot change amounts');
select tests.throws($$ update public.bookings set start_time = start_time + interval '1 hour', end_time = end_time + interval '1 hour'
                        where id = '30000000-0000-4000-a000-000000000001' $$,
                    '42501', 'booker cannot reschedule');
select tests.throws($$ update public.bookings set payment_status = 'PAID' where id = '30000000-0000-4000-a000-000000000001' $$,
                    '42501', 'booker cannot mark a booking paid');
select tests.throws($$ update public.bookings set payment_verified_by = tests.uid('alice') where id = '30000000-0000-4000-a000-000000000001' $$,
                    '42501', 'audit stamp columns are not client-writable');
select tests.throws($$ delete from public.bookings where id = '30000000-0000-4000-a000-000000000001' $$,
                    '42501', 'bookings can never be deleted by users');

-- The receipt must be uploaded to the booking's own folder before it's submitted (Step 3 rule).
insert into storage.objects (bucket_id, name) values ('payment-receipts', '30000000-0000-4000-a000-000000000001/receipt.jpg');
update public.bookings
   set payment_ref_no = '1009876543210', payment_receipt_url = '30000000-0000-4000-a000-000000000001/receipt.jpg',
       payment_status = 'AWAITING_VERIFICATION'
 where id = '30000000-0000-4000-a000-000000000001';
select tests.ok((select payment_submitted_at is not null from public.bookings where id = '30000000-0000-4000-a000-000000000001'),
                'submitting a GCash reference stamps payment_submitted_at');

-- One GCash transaction cannot pay for two bookings.
select tests.login('bob');
select tests.throws($$ update public.bookings set payment_ref_no = '1009876543210', payment_status = 'AWAITING_VERIFICATION'
                        where id = '30000000-0000-4000-a000-000000000002' $$,
                    '23505', 'reusing another booking''s GCash reference rejected');

-- -----------------------------------------------------------------------------
-- Venue staff verification
-- -----------------------------------------------------------------------------
select tests.login('mia');
select tests.eq((select count(*) from public.bookings where venue_id = '10000000-0000-4000-a000-000000000001' and payment_status = 'AWAITING_VERIFICATION')::int,
                1, 'front desk sees the verification queue');
update public.bookings set payment_status = 'PAID' where id = '30000000-0000-4000-a000-000000000001';
select tests.eq((select booking_status::text || '/' || payment_verified_by::text from public.bookings
                  where id = '30000000-0000-4000-a000-000000000001'),
                'CONFIRMED/' || tests.uid('mia')::text, 'verifying payment auto-confirms and records the verifier');

-- Rejection restarts the payment window; the player can resubmit.
select tests.login('bob');
update public.bookings set payment_ref_no = '2000000000001', payment_status = 'AWAITING_VERIFICATION'
 where id = '30000000-0000-4000-a000-000000000002';
select tests.login('mia');
select tests.throws($$ update public.bookings set payment_status = 'REJECTED' where id = '30000000-0000-4000-a000-000000000002' $$,
                    '23514', 'rejection requires a reason');
update public.bookings set payment_status = 'REJECTED', payment_rejection_reason = 'Reference not found in GCash history'
 where id = '30000000-0000-4000-a000-000000000002';
select tests.login('bob');
update public.bookings set payment_ref_no = '2000000000002', payment_status = 'AWAITING_VERIFICATION'
 where id = '30000000-0000-4000-a000-000000000002';
select tests.eq((select payment_status::text from public.bookings where id = '30000000-0000-4000-a000-000000000002'),
                'AWAITING_VERIFICATION', 'player can resubmit after a rejection');

-- -----------------------------------------------------------------------------
-- Cancellation rules & terminal states
-- -----------------------------------------------------------------------------
select tests.login('alice');
insert into public.bookings (id, court_id, booked_by, start_time, end_time, payment_method)
values ('30000000-0000-4000-a000-000000000003', :c2, tests.uid('alice'), tests.slot(3, '08:00'), tests.slot(3, '09:00'), 'GCASH');
update public.bookings set booking_status = 'CANCELLED' where id = '30000000-0000-4000-a000-000000000003';
select tests.eq((select cancelled_by from public.bookings where id = '30000000-0000-4000-a000-000000000003'), tests.uid('alice'),
                'cancellation records who cancelled');
select tests.throws($$ update public.bookings set booking_status = 'PENDING_PAYMENT' where id = '30000000-0000-4000-a000-000000000003' $$,
                    '23514', 'cancelled bookings cannot be reopened');

select tests.login('bob');
insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
values (:c2, tests.uid('bob'), tests.slot(3, '08:00'), tests.slot(3, '09:00'), 'GCASH');
select tests.ok(true, 'a cancelled booking frees its slot immediately');

-- A confirmed booking inside the 24h cutoff cannot be cancelled by the player.
-- (Created by the front desk, which may book walk-ins at any hour.)
select tests.login('mia');
insert into public.bookings (id, court_id, booked_by, start_time, end_time, payment_method)
values ('30000000-0000-4000-a000-000000000004', :c2, tests.uid('alice'),
        date_trunc('hour', now()) + interval '2 hours', date_trunc('hour', now()) + interval '3 hours', 'CASH_ON_COURT');
select tests.eq((select booking_status::text from public.bookings where id = '30000000-0000-4000-a000-000000000004'), 'CONFIRMED',
                'cash-on-court booking auto-confirms at this venue');
select tests.login('alice');
select tests.throws($$ update public.bookings set booking_status = 'CANCELLED' where id = '30000000-0000-4000-a000-000000000004' $$,
                    '23514', 'player cannot cancel a confirmed booking inside the cutoff');

-- -----------------------------------------------------------------------------
-- Stale holds never block paying players
-- -----------------------------------------------------------------------------
reset role;
insert into public.bookings (id, court_id, booked_by, start_time, end_time, payment_method, payment_due_at)
values ('30000000-0000-4000-a000-000000000005', :c2, tests.uid('dave'), tests.slot(4, '10:00'), tests.slot(4, '11:00'),
        'GCASH', now() - interval '10 minutes');   -- past due + grace
set role authenticated;
select tests.login('alice');
insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
values (:c2, tests.uid('alice'), tests.slot(4, '10:00'), tests.slot(4, '11:00'), 'GCASH');
select tests.ok(true, 'expired unpaid hold is swept so the slot can be booked');
reset role;
select tests.eq((select booking_status::text || '/' || cancellation_reason from public.bookings
                  where id = '30000000-0000-4000-a000-000000000005'),
                'CANCELLED/PAYMENT_WINDOW_EXPIRED', 'expired hold cancelled with a machine-readable reason');
set role authenticated;

-- -----------------------------------------------------------------------------
-- Coach can't be double-booked across courts
-- -----------------------------------------------------------------------------
select tests.login('alice');
insert into public.bookings (court_id, booked_by, coach_id, start_time, end_time, payment_method)
values (:c1, tests.uid('alice'), tests.uid('carlos'), tests.slot(1, '14:00'), tests.slot(1, '15:00'), 'GCASH');
select tests.eq((select coach_amount from public.bookings where coach_id = tests.uid('carlos')), 800.00::numeric(10,2),
                'coach fee added to the booking');
select tests.login('bob');
select tests.throws(format($$ insert into public.bookings (court_id, booked_by, coach_id, start_time, end_time, payment_method)
                              values (%L, tests.uid('bob'), tests.uid('carlos'), tests.slot(1, '14:30'), tests.slot(1, '15:30'), 'GCASH') $$, :c2),
                    '23P01', 'coach cannot be booked into two overlapping sessions');
select tests.login('carlos');
select tests.eq((select count(*) from public.bookings)::int, 1, 'coaches see bookings they are hired for');

-- -----------------------------------------------------------------------------
-- Audit trail & contact privacy
-- -----------------------------------------------------------------------------
select tests.login('alice');
select tests.eq(
  (select string_agg(coalesce(from_booking_status::text, '∅') || '>' || to_booking_status::text || ':' ||
                     coalesce(from_payment_status::text, '∅') || '>' || to_payment_status::text, ' | ' order by id)
     from public.booking_status_history where booking_id = '30000000-0000-4000-a000-000000000001'),
  '∅>PENDING_PAYMENT:∅>UNPAID | PENDING_PAYMENT>PENDING_PAYMENT:UNPAID>AWAITING_VERIFICATION | PENDING_PAYMENT>CONFIRMED:AWAITING_VERIFICATION>PAID',
  'every status change is in the audit history');
select tests.throws($$ insert into public.booking_status_history (booking_id, to_booking_status, to_payment_status, total_amount)
                       values ('30000000-0000-4000-a000-000000000001', 'CANCELLED', 'REFUNDED', 0) $$,
                    '42501', 'audit history is append-only by the system');

select tests.login('olivia');
select tests.eq((select phone from public.profile_contacts where profile_id = tests.uid('alice')), '+639170000002',
                'venue owner can reach a player who booked with them');
select tests.login('bob');
select tests.eq((select count(*) from public.profile_contacts where profile_id = tests.uid('alice'))::int, 0,
                'other players still cannot see that phone number');
select tests.login('carlos');
select tests.eq((select count(*) from public.profile_contacts where profile_id = tests.uid('alice'))::int, 1,
                'a hired coach can reach their student');
reset role;

-- -----------------------------------------------------------------------------
-- Backstops hold even for trusted (service-role) code
-- -----------------------------------------------------------------------------
reset role;
select tests.throws(format($$ insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
                              values (%L, tests.uid('dave'), tests.slot(0, '10:30'), tests.slot(0, '11:30'), 'CASH_ON_COURT') $$, :c1),
                    '23P01', 'service role cannot double-book either (constraint, not app logic)');
select tests.throws($$ update public.bookings set start_time = start_time + interval '5 minutes', end_time = end_time + interval '5 minutes'
                        where id = '30000000-0000-4000-a000-000000000002' $$,
                    '23514', 'quarter-hour grid enforced by CHECK for every caller');
select tests.throws($$ update public.bookings set booking_status = 'PENDING_PAYMENT' where id = '30000000-0000-4000-a000-000000000003' $$,
                    '23514', 'terminal states are terminal for the service role too');
