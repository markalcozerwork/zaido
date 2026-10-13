-- =============================================================================
-- Clubs, membership rules, events, RSVP capacity, waitlist, rotation queue.
-- =============================================================================
\set ON_ERROR_STOP 1
reset role;
set role authenticated;

-- -----------------------------------------------------------------------------
-- Clubs
-- -----------------------------------------------------------------------------
select tests.login('carlos');
insert into public.clubs (id, name, slug, sport, municipality_code, barangay_code)
values ('40000000-0000-4000-a000-000000000001', 'Kapitolyo Picklers', 'kapitolyo-picklers', 'PICKLEBALL', '9900100000', '9900100001');

select tests.eq((select role::text from public.club_members
                  where club_id = '40000000-0000-4000-a000-000000000001' and profile_id = tests.uid('carlos')),
                'ADMIN', 'club creator becomes ADMIN');
select tests.eq((select count(*) from public.chat_channels c join public.chat_participants p on p.channel_id = c.id
                  where c.type = 'CLUB' and c.club_id = '40000000-0000-4000-a000-000000000001')::int,
                1, 'club chat channel created with the creator in it');
select tests.throws($$ insert into public.clubs (name, slug, sport, municipality_code) values ('Bad Slug', 'Bad Slug!', 'TENNIS', '9900100000') $$,
                    '23514', 'club slugs must be URL-safe');

select tests.login('alice');
insert into public.club_members (club_id, profile_id) values ('40000000-0000-4000-a000-000000000001', tests.uid('alice'));
select tests.ok(true, 'anyone can join a public club');
select tests.ok(exists (select 1 from public.chat_participants p join public.chat_channels c on c.id = p.channel_id
                         where c.club_id = '40000000-0000-4000-a000-000000000001' and p.profile_id = tests.uid('alice')),
                'joining a club adds you to its chat');
select tests.throws($$ insert into public.club_members (club_id, profile_id) values ('40000000-0000-4000-a000-000000000001', tests.uid('dave')) $$,
                    '42501', 'members cannot add other people');
select tests.eq(tests.affected($$ update public.club_members set role = 'ADMIN'
                                   where club_id = '40000000-0000-4000-a000-000000000001' and profile_id = tests.uid('alice') $$),
                0::bigint, 'members cannot promote themselves');

select tests.login('carlos');
select tests.throws($$ delete from public.club_members
                        where club_id = '40000000-0000-4000-a000-000000000001' and profile_id = tests.uid('carlos') $$,
                    '23514', 'the last admin cannot leave');
select tests.throws($$ update public.club_members set role = 'COACH'
                        where club_id = '40000000-0000-4000-a000-000000000001' and profile_id = tests.uid('alice') $$,
                    '23514', 'COACH role requires a coach profile');

-- Private (invite-only) club
select tests.login('olivia');
insert into public.clubs (id, name, slug, sport, municipality_code, is_private)
values ('40000000-0000-4000-a000-000000000002', 'Olivia''s Dawn Patrol', 'dawn-patrol', 'PICKLEBALL', '9900100000', true);
-- supabase-js `.insert().select()` issues INSERT … RETURNING; creators must see their new rows.
select tests.lives($$ insert into public.clubs (name, slug, sport, municipality_code, is_private)
                      values ('Returning Check', 'returning-check', 'TENNIS', '9900100000', true) returning id $$,
                   'creator can INSERT … RETURNING a private club');
select tests.lives($$ insert into public.events (organizer_id, municipality_code, title, sport, event_type, status,
                                                 start_time, end_time, max_participants)
                      values (tests.uid('olivia'), '9900100000', 'Draft Social', 'TENNIS', 'OPEN_PLAY', 'DRAFT',
                              tests.slot(4, '08:00'), tests.slot(4, '10:00'), 4) returning id $$,
                   'organiser can INSERT … RETURNING a draft event');
select tests.lives($$ insert into public.venues (owner_id, name, municipality_code, barangay_code, address, is_active)
                      values (tests.uid('olivia'), 'Soft Launch Courts', '9900100000', '9900100002', 'Somewhere in Pasig', false)
                      returning id $$,
                   'owner can INSERT … RETURNING an inactive venue');
select tests.login('alice');
select tests.eq((select count(*) from public.clubs where id = '40000000-0000-4000-a000-000000000002')::int, 0,
                'private clubs are hidden from non-members');
select tests.throws($$ insert into public.club_members (club_id, profile_id) values ('40000000-0000-4000-a000-000000000002', tests.uid('alice')) $$,
                    '42501', 'private clubs are invite-only');

-- -----------------------------------------------------------------------------
-- Events & capacity
-- -----------------------------------------------------------------------------
select tests.login('alice');
select tests.throws($$ insert into public.events (club_id, organizer_id, title, sport, event_type, start_time, end_time, max_participants)
                       values ('40000000-0000-4000-a000-000000000001', tests.uid('alice'), 'Rogue Social', 'PICKLEBALL', 'OPEN_PLAY',
                               tests.slot(2, '18:00'), tests.slot(2, '21:00'), 8) $$,
                    '42501', 'plain members cannot create club events');

select tests.login('carlos');
insert into public.events (id, club_id, venue_id, court_id, organizer_id, title, sport, event_type, rotation_format,
                           start_time, end_time, max_participants, fee_per_pax)
values ('50000000-0000-4000-a000-000000000001', '40000000-0000-4000-a000-000000000001',
        '10000000-0000-4000-a000-000000000001', '20000000-0000-4000-a000-000000000002',
        tests.uid('carlos'), 'Wednesday Night Open Play', 'PICKLEBALL', 'OPEN_PLAY', 'FOUR_IN_FOUR_OUT',
        tests.slot(2, '18:00'), tests.slot(2, '21:00'), 2, 150);
select tests.eq((select municipality_code from public.events where id = '50000000-0000-4000-a000-000000000001'), '9900100000',
                'event location inherited from venue');
select tests.throws($$ insert into public.events (organizer_id, venue_id, court_id, title, sport, event_type, start_time, end_time, max_participants)
                       values (tests.uid('carlos'), '10000000-0000-4000-a000-000000000001', '20000000-0000-4000-a000-000000000099',
                               'Ghost court', 'PICKLEBALL', 'OPEN_PLAY', tests.slot(2, '18:00'), tests.slot(2, '21:00'), 4) $$,
                    '23503', 'court must belong to the event venue');
select tests.throws($$ insert into public.events (organizer_id, municipality_code, title, sport, event_type, start_time, end_time, max_participants)
                       values (tests.uid('carlos'), '9900100000', 'Clinic w/o coach', 'PICKLEBALL', 'CLINIC',
                               tests.slot(2, '08:00'), tests.slot(2, '10:00'), 6) $$,
                    '23514', 'clinics require a coach');

select tests.login('alice');
insert into public.event_attendees (event_id, profile_id) values ('50000000-0000-4000-a000-000000000001', tests.uid('alice'));
select tests.login('bob');
insert into public.event_attendees (event_id, profile_id) values ('50000000-0000-4000-a000-000000000001', tests.uid('bob'));
select tests.login('dave');
insert into public.event_attendees (event_id, profile_id, status) values ('50000000-0000-4000-a000-000000000001', tests.uid('dave'), 'CHECKED_IN');

select tests.eq((select status::text from public.event_attendees
                  where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('dave')),
                'WAITLISTED', 'third RSVP on a 2-player cap is waitlisted automatically (and cannot self check-in)');
select tests.eq((select registered_count || '/' || waitlisted_count from public.events where id = '50000000-0000-4000-a000-000000000001'),
                '2/1', 'event counters track seats and waitlist');
select tests.eq((select amount_due from public.event_attendees
                  where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('alice')),
                150.00::numeric(10,2), 'fee per pax copied onto the RSVP');

-- Event chat: seat holders + organiser only.
select tests.eq((select string_agg(pr.full_name, ', ' order by pr.full_name)
                   from public.chat_participants p
                   join public.chat_channels c on c.id = p.channel_id
                   join public.profiles pr on pr.id = p.profile_id
                  where c.type = 'EVENT' and c.event_id = '50000000-0000-4000-a000-000000000001'),
                null::text, 'waitlisted players cannot read the event chat roster');

select tests.login('bob');
select tests.eq((select string_agg(pr.full_name, ', ' order by pr.full_name)
                   from public.chat_participants p
                   join public.chat_channels c on c.id = p.channel_id
                   join public.profiles pr on pr.id = p.profile_id
                  where c.type = 'EVENT' and c.event_id = '50000000-0000-4000-a000-000000000001'),
                'Alice Santos, Bob Reyes, Carlos Coach', 'event chat = organiser + registered players');

-- Bob drops out → Dave promoted, chat membership follows.
update public.event_attendees set status = 'CANCELLED'
 where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('bob');
select tests.login('dave');
select tests.eq((select status::text from public.event_attendees
                  where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('dave')),
                'REGISTERED', 'cancellation promotes the first waitlisted player');
select tests.ok((select promoted_at is not null from public.event_attendees
                  where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('dave')),
                'promotion is timestamped');
select tests.eq((select count(*) from public.chat_participants p join public.chat_channels c on c.id = p.channel_id
                  where c.event_id = '50000000-0000-4000-a000-000000000001' and p.profile_id in (tests.uid('dave'), tests.uid('bob')))::int,
                1, 'promoted player joins the event chat; the dropout leaves it');

-- Bob rejoins → back of the waitlist.
select tests.login('bob');
update public.event_attendees set status = 'REGISTERED'
 where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('bob');
select tests.eq((select status::text from public.event_attendees
                  where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('bob')),
                'WAITLISTED', 're-joining a full event lands on the waitlist');
select tests.throws($$ update public.event_attendees set status = 'REGISTERED'
                        where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('bob') $$,
                    '42501', 'waitlisted players cannot jump the queue');
select tests.eq(tests.affected($$ update public.events set max_participants = 50 where id = '50000000-0000-4000-a000-000000000001' $$),
                0::bigint, 'attendees cannot change the cap');

-- Organiser raises the cap → automatic promotion.
select tests.login('carlos');
update public.events set max_participants = 3 where id = '50000000-0000-4000-a000-000000000001';
select tests.eq((select registered_count || '/' || waitlisted_count from public.events where id = '50000000-0000-4000-a000-000000000001'),
                '3/0', 'raising the cap promotes from the waitlist');
select tests.throws($$ update public.events set max_participants = 2 where id = '50000000-0000-4000-a000-000000000001' $$,
                    '23514', 'cap cannot drop below the registered count');
select tests.throws($$ update public.events set registered_count = 0 where id = '50000000-0000-4000-a000-000000000001' $$,
                    '42501', 'counters are not client-writable');

-- Waitlist disabled + full → EVENT_FULL.
update public.events set waitlist_enabled = false where id = '50000000-0000-4000-a000-000000000001';
select tests.login('olivia');
select tests.throws($$ insert into public.event_attendees (event_id, profile_id) values ('50000000-0000-4000-a000-000000000001', tests.uid('olivia')) $$,
                    '23514', 'full event without a waitlist rejects new RSVPs');

-- -----------------------------------------------------------------------------
-- Private club events
-- -----------------------------------------------------------------------------
select tests.login('olivia');
insert into public.events (id, club_id, organizer_id, municipality_code, title, sport, event_type,
                           start_time, end_time, max_participants, is_private)
values ('50000000-0000-4000-a000-000000000002', '40000000-0000-4000-a000-000000000002', tests.uid('olivia'), '9900100000',
        'Members-only Doubles', 'PICKLEBALL', 'OPEN_PLAY', tests.slot(3, '06:00'), tests.slot(3, '08:00'), 8, true);
select tests.login('alice');
select tests.eq((select count(*) from public.events where id = '50000000-0000-4000-a000-000000000002')::int, 0,
                'private club events are invisible to outsiders');
select tests.throws($$ insert into public.event_attendees (event_id, profile_id) values ('50000000-0000-4000-a000-000000000002', tests.uid('alice')) $$,
                    '42501', 'outsiders cannot RSVP to a private event by guessing its id');
reset role;
set role anon;
select tests.logout();
select tests.eq((select count(*) from public.events)::int, 1, 'anon sees only public events');
reset role;
set role authenticated;

-- -----------------------------------------------------------------------------
-- Paddle rotation queue
-- -----------------------------------------------------------------------------
select tests.login('alice');
insert into public.event_queue_entries (event_id, profile_id) values ('50000000-0000-4000-a000-000000000001', tests.uid('alice'));
select tests.throws($$ update public.event_queue_entries set queue_state = 'ON_COURT', court_label = 'A'
                        where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('alice') $$,
                    '42501', 'players cannot put themselves on court');
select tests.throws($$ insert into public.event_queue_entries (event_id, profile_id)
                       values ('50000000-0000-4000-a000-000000000001', tests.uid('dave')) $$,
                    '42501', 'players cannot queue other people');
update public.event_queue_entries set queue_state = 'RESTING'
 where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('alice');
select tests.ok(true, 'players can mark themselves resting');

select tests.login('carlos');
update public.event_queue_entries set queue_state = 'ON_COURT', court_label = 'Court 2'
 where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('alice');
update public.event_queue_entries set queue_state = 'WAITING'
 where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('alice');
select tests.eq((select games_played || ':' || coalesce(court_label, '-') from public.event_queue_entries
                  where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('alice')),
                '1:-', 'coming off court counts a game and clears the court');

select tests.login('alice');
update public.event_attendees set status = 'CANCELLED'
 where event_id = '50000000-0000-4000-a000-000000000001' and profile_id = tests.uid('alice');
select tests.eq((select count(*) from public.event_queue_entries where profile_id = tests.uid('alice'))::int, 0,
                'cancelling an RSVP removes the player from the rotation board');
reset role;
