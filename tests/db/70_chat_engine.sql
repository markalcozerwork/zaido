-- =============================================================================
-- Step 4: chat engine. Ordering and idempotency, read markers and unread
-- counts, inbox, private DM opening, blocks, rate limit, media lifecycle,
-- reports, message pages, realtime hints and topic authorization, archive,
-- membership fixes, account deletion, club deletion.
-- =============================================================================
\set ON_ERROR_STOP 1
reset role;

\set ana  '00000000-0000-4000-a000-000000000701'
\set ben  '00000000-0000-4000-a000-000000000702'
\set cora '00000000-0000-4000-a000-000000000703'
\set dan  '00000000-0000-4000-a000-000000000704'
\set adi  '00000000-0000-4000-a000-000000000705'
\set fay  '00000000-0000-4000-a000-000000000706'
\set gus  '00000000-0000-4000-a000-000000000707'

insert into auth.users (id, email, raw_user_meta_data) values
  (:'ana',  'ana@chat.example.ph',  '{"full_name": "Ana Lim"}'),
  (:'ben',  'ben@chat.example.ph',  '{"full_name": "Ben Cruz"}'),
  (:'cora', 'cora@chat.example.ph', '{"full_name": "Cora Admin"}'),
  (:'dan',  'dan@chat.example.ph',  '{"full_name": "Dan Stranger"}'),
  (:'adi',  'adi@chat.example.ph',  '{"full_name": "Adi Platform"}'),
  (:'fay',  'fay@chat.example.ph',  '{"full_name": "Fay Fast"}'),
  (:'gus',  'gus@chat.example.ph',  '{"full_name": "Gus Gone"}');
insert into public.platform_admins (profile_id) values (:'adi');

-- "Error text of a statement": SQLSTATE, message, and hint if any.
create or replace function tests.error_of(p_sql text) returns text language plpgsql as $$
declare
  v_state text; v_msg text; v_hint text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
    return v_state || ' ' || v_msg || coalesce(' [hint ' || nullif(v_hint, '') || ']', '');
  end;
  return null;
end;
$$;

-- Realtime authorizes a private join by SELECTing realtime.messages with
-- realtime.topic set, and a client send by INSERTing as the user.
create or replace function tests.can_join(p_topic text) returns boolean language plpgsql as $$
begin
  perform set_config('realtime.topic', p_topic, true);
  return exists (select 1 from realtime.messages where event = 'chat-probe');
end;
$$;

create or replace function tests.can_send(p_topic text) returns boolean language plpgsql as $$
begin
  perform set_config('realtime.topic', p_topic, true);
  insert into realtime.messages (topic, extension, payload, event, private)
  values (p_topic, 'broadcast', '{}', 'typing', true);
  raise exception using errcode = 'P0001', message = 'sent';
exception
  when sqlstate 'P0001' then return true;
  when insufficient_privilege then return false;
end;
$$;

-- Hints written since a mark.
create or replace function tests.hints(p_since bigint, p_topic text, p_event text) returns bigint
language sql stable security definer set search_path = '' as $$
  select count(*) from realtime.messages m where m.id > p_since and m.topic = p_topic and m.event = p_event;
$$;

grant execute on all functions in schema tests to anon, authenticated, service_role;
insert into realtime.messages (topic, extension, payload, event, private)
values ('probe', 'broadcast', '{}', 'chat-probe', true);

-- A public club: Cora (admin), Ana, Ben.
set role authenticated;
select tests.login(:'cora'::uuid);
insert into public.clubs (id, name, slug, sport, municipality_code)
values ('40000000-0000-4000-a000-000000000070', 'Chat Test Club', 'chat-test-club', 'PICKLEBALL', '9900100000');
select tests.login(:'ana'::uuid);
insert into public.club_members (club_id, profile_id) values ('40000000-0000-4000-a000-000000000070', :'ana');
select tests.login(:'ben'::uuid);
insert into public.club_members (club_id, profile_id) values ('40000000-0000-4000-a000-000000000070', :'ben');
reset role;
select id as club from public.chat_channels where type = 'CLUB' and club_id = '40000000-0000-4000-a000-000000000070' \gset
set role authenticated;

-- -----------------------------------------------------------------------------
-- 1. Send: seq/rev, trimming, idempotent replays, key reuse
-- -----------------------------------------------------------------------------
select tests.login(:'ana'::uuid);
select id as m1, seq as m1_seq, rev as m1_rev, message_text as m1_text
  from public.send_chat_message(:'club', 'c0000000-0000-4000-a000-000000000001', E'  First!\n ') \gset
select id as m2 from public.send_chat_message(:'club', 'c0000000-0000-4000-a000-000000000002', 'Second') \gset
select id as m3 from public.send_chat_message(:'club', 'c0000000-0000-4000-a000-000000000003', 'Third') \gset
select tests.eq(:'m1_text'::text, 'First!', 'message text is trimmed');
select tests.eq((select string_agg(seq || '/' || rev, ',' order by seq) from public.chat_messages where channel_id = :'club'),
                '1/1,2/2,3/3', 'messages get gapless per-channel seq and rev');
select tests.eq((select last_seq || '/' || last_rev from public.chat_channels where id = :'club'), '3/3',
                'the channel counters follow');

select tests.eq((select id from public.send_chat_message(:'club', 'c0000000-0000-4000-a000-000000000001', 'First!')), :'m1'::uuid,
                'a replay returns the same message');
select public.send_chat_message(:'club', 'c0000000-0000-4000-a000-000000000001', 'First!');
select public.send_chat_message(:'club', 'c0000000-0000-4000-a000-000000000001', '  First!');
select tests.eq((select last_seq from public.chat_channels where id = :'club'), 3::bigint,
                'replays leave no gap: last_seq is unchanged after 3 more replays');
select tests.ok(tests.error_of(format($$ select public.send_chat_message(%L, 'c0000000-0000-4000-a000-000000000001', 'Something else') $$, :'club'))
                  like '22023 IDEMPOTENCY_KEY_REUSED:%',
                'a key reused for different text is refused');
select public.get_or_create_direct_channel(:'ben') as dm \gset
select tests.ok(tests.error_of(format($$ select public.send_chat_message(%L, 'c0000000-0000-4000-a000-000000000001', 'First!') $$, :'dm'))
                  like '22023 IDEMPOTENCY_KEY_REUSED:%',
                'a key reused in another conversation is refused');
select tests.eq((select last_seq from public.chat_channels where id = :'dm'), 0::bigint,
                '…and that conversation''s counter did not move');
select tests.ok(tests.error_of(format($$ insert into public.chat_messages (channel_id, client_id, message_text)
                                         values (%L, 'c0000000-0000-4000-a000-000000000001', 'dup') $$, :'club'))
                  like '23505 %', 'a direct duplicate insert fails on the key');
select tests.eq((select last_seq from public.chat_channels where id = :'club'), 3::bigint,
                '…and its counter bump rolled back with it');
select tests.ok(tests.error_of(format($$ select public.send_chat_message(%L, gen_random_uuid(), E' \n ') $$, :'club'))
                  like '23514 MESSAGE_EMPTY:%', 'blank messages are refused');
select tests.ok(tests.error_of(format($$ insert into public.chat_messages (channel_id, sender_id, message_text, seq, rev)
                                         values (%L, %L, 'spoof', 99, 99) $$, :'club', :'ben')) is null,
                'a direct insert with spoofed sender and counters goes through…');
select tests.eq((select sender_id::text || ' ' || seq || '/' || rev from public.chat_messages where message_text = 'spoof'),
                :'ana' || ' 4/4', '…as the caller, with server-assigned seq/rev');

-- -----------------------------------------------------------------------------
-- 2. Edits and deletes: rev moves, seq never does
-- -----------------------------------------------------------------------------
select tests.login(:'ana'::uuid);
update public.chat_messages set message_text = 'Second (edited)' where id = :'m2';
select tests.eq((select seq || '/' || rev || '/' || (edited_at is not null) from public.chat_messages where id = :'m2'),
                '2/5/true', 'an edit gets a new rev and keeps its seq');
select tests.eq((select last_seq || '/' || last_rev from public.chat_channels where id = :'club'), '4/5',
                'an edit moves last_rev, not last_seq');
update public.chat_messages set message_text = 'Second (edited)' where id = :'m2';
select tests.eq((select rev from public.chat_messages where id = :'m2'), 5::bigint, 'a no-op edit gets no new rev');
select tests.ok(tests.error_of(format($$ update public.chat_messages set message_text = '  ' where id = %L $$, :'m2'))
                  like '23514 MESSAGE_EMPTY:%', 'an edit can''t empty a message');
select tests.throws(format($$ update public.chat_messages set media_url = 'x' where id = %L $$, :'m2'), '42501',
                    'only text and deleted_at are writable');

select tests.login(:'ben'::uuid);
select tests.eq(tests.affected(format($$ update public.chat_messages set message_text = 'hijack' where id = %L $$, :'m2')),
                0::bigint, 'members can''t edit others'' messages');
select tests.login(:'cora'::uuid);
update public.chat_messages set deleted_at = now() where id = :'m3';
select tests.eq((select coalesce(message_text, '∅') || ' ' || rev || ' ' || (deleted_by = :'cora'::uuid)::text
                   from public.chat_messages where id = :'m3'),
                '∅ 6 true', 'the club admin moderates: content wiped, new rev, deleted_by recorded');
select tests.login(:'ana'::uuid);
select tests.ok(tests.error_of(format($$ update public.chat_messages set message_text = 'undo' where id = %L $$, :'m3'))
                  like '23514 MESSAGE_DELETED:%', 'deleted messages stay deleted');

reset role;
insert into public.chat_messages (channel_id, sender_id, message_text, created_at)
values (:'club', :'ana', 'From a while ago', now() - interval '20 minutes')
returning id as m_old \gset
set role authenticated;
select tests.login(:'ana'::uuid);
select tests.ok(tests.error_of(format($$ update public.chat_messages set message_text = 'too late' where id = %L $$, :'m_old'))
                  like '23514 EDIT_WINDOW_PASSED:%', 'edits close after the window');
select tests.eq((select seq from public.chat_messages where id = :'m_old'), 5::bigint,
                'a trusted insert still gets the next seq');

-- -----------------------------------------------------------------------------
-- 3. Read markers and unread counts
-- -----------------------------------------------------------------------------
select tests.login(:'ben'::uuid);
select tests.eq((select unread_count from public.get_chat_inbox() where channel_id = :'club'), 5::bigint,
                'unread = last_seq - marker (5 messages since Ben joined)');
select tests.eq((select last_read_seq || ' ' || unread_count from public.mark_chat_read(:'club', 2)), '2 3',
                'mark_chat_read moves the marker and returns what is left');
select tests.eq((select last_read_seq from public.mark_chat_read(:'club', 1)), 2::bigint, 'markers never move back');
select tests.eq((select last_read_seq || ' ' || unread_count from public.mark_chat_read(:'club', 999)), '5 0',
                'markers are clamped to the last message');
update public.chat_participants set last_read_seq = 1 where channel_id = :'club' and profile_id = :'ben';
update public.chat_participants set last_read_seq = 999 where channel_id = :'club' and profile_id = :'ben';
select tests.eq((select last_read_seq from public.get_chat_inbox() where channel_id = :'club'), 5::bigint,
                'direct marker updates obey the same rules');
select tests.ok(tests.error_of(format($$ select public.mark_chat_read(%L, null) $$, :'club')) like '22023 %',
                'mark_chat_read needs an explicit position');
select tests.throws($$ select last_read_seq from public.chat_participants $$, '42501',
                    'co-members can''t read each other''s read markers');
select tests.throws($$ select is_muted from public.chat_participants $$, '42501',
                    '…or mute state');
select tests.eq((select count(*) from public.chat_participants where channel_id = :'club')::int, 3,
                'members still see who is in the chat');
select tests.login(:'dan'::uuid);
select tests.ok(tests.error_of(format($$ select public.mark_chat_read(%L, 1) $$, :'club')) like '42501 NOT_A_PARTICIPANT:%',
                'outsiders have no marker to move');

-- Joiners start caught up, also when they re-join.
select tests.login(:'fay'::uuid);
insert into public.club_members (club_id, profile_id) values ('40000000-0000-4000-a000-000000000070', :'fay');
select tests.eq((select unread_count from public.get_chat_inbox() where channel_id = :'club'), 0::bigint,
                'a new member starts with nothing unread');
delete from public.club_members where club_id = '40000000-0000-4000-a000-000000000070' and profile_id = :'fay';
select tests.login(:'ana'::uuid);
select public.send_chat_message(:'club', 'c0000000-0000-4000-a000-000000000005', 'While Fay was away');
select tests.login(:'fay'::uuid);
insert into public.club_members (club_id, profile_id) values ('40000000-0000-4000-a000-000000000070', :'fay');
select tests.eq((select unread_count from public.get_chat_inbox() where channel_id = :'club'), 0::bigint,
                'a re-joining member starts caught up too');

-- -----------------------------------------------------------------------------
-- 4. Inbox
-- -----------------------------------------------------------------------------
select tests.login(:'ana'::uuid);
select tests.eq((select count(*) from public.get_chat_inbox())::int, 1,
                'an unsent DM is not in the inbox (only the club is)');
select tests.eq((select title || ' | ' || last_message_sender_name || ': ' || last_message_snippet
                   from public.get_chat_inbox() where channel_id = :'club'),
                'Chat Test Club | Ana Lim: While Fay was away', 'club row: title and last message preview');
select tests.login(:'ben'::uuid);
select tests.ok(tests.error_of(format($$ select public.send_chat_message(%L, gen_random_uuid(), 'hi') $$, :'dm'))
                  like '42501 NOT_A_PARTICIPANT:%', 'a DM someone else opened is not yours until you open it too');
select tests.eq(public.get_or_create_direct_channel(:'ana'), :'dm'::uuid, 'opening it from the other side finds the same thread');
select public.send_chat_message(:'dm', 'c0000000-0000-4000-a000-000000000101', 'Laro tayo bukas?');
select tests.login(:'ana'::uuid);
select tests.eq((select string_agg(channel_type::text, ',' order by activity_at desc) from public.get_chat_inbox()),
                'DIRECT,CLUB', 'most recent activity first');
select tests.eq((select title || ' ' || partner_id::text || ' ' || unread_count || ' ' || can_send
                   from public.get_chat_inbox() where channel_id = :'dm'),
                'Ben Cruz ' || :'ben' || ' 1 true', 'DM row: partner name, unread, can send');
select activity_at as cur_at, channel_id as cur_id from public.get_chat_inbox(1) \gset
select tests.eq((select channel_id from public.get_chat_inbox(1, :'cur_at', :'cur_id')), :'club'::uuid,
                'keyset paging returns the next conversation');
select tests.eq((select count(*) from public.get_chat_inbox(30, null, null, false, array[:'club'::uuid]))::int, 1,
                'p_channel_ids fetches just those conversations');
select tests.ok(tests.error_of(format($$ select * from public.get_chat_inbox(10, %L) $$, :'cur_at')) like '22023 %',
                'half a cursor is refused');
select tests.eq((select unread_messages || '/' || unread_channels from public.get_chat_unread_summary()), '1/1',
                'unread summary for the tab badge');
update public.chat_participants set is_muted = true where channel_id = :'dm' and profile_id = :'ana';
select tests.eq((select unread_messages || '/' || unread_channels from public.get_chat_unread_summary()), '0/0',
                'muted conversations leave the badge');
select tests.ok((select is_muted from public.get_chat_inbox() where channel_id = :'dm'), 'the inbox shows the mute');
update public.chat_participants set is_muted = false where channel_id = :'dm' and profile_id = :'ana';

-- Joining a quiet, long-existing chat puts it on top (activity = join time).
select tests.login(:'cora'::uuid);
insert into public.clubs (id, name, slug, sport, municipality_code)
values ('40000000-0000-4000-a000-000000000071', 'Quiet Old Club', 'quiet-old-club', 'TENNIS', '9900100000');
reset role;
select id as quiet from public.chat_channels where type = 'CLUB' and club_id = '40000000-0000-4000-a000-000000000071' \gset
update public.chat_channels set created_at = now() - interval '60 days' where id = :'quiet';
set role authenticated;
select tests.login(:'ana'::uuid);
insert into public.club_members (club_id, profile_id) values ('40000000-0000-4000-a000-000000000071', :'ana');
select tests.eq((select channel_id from public.get_chat_inbox(1)), :'quiet'::uuid,
                'a just-joined quiet chat sorts first');

-- -----------------------------------------------------------------------------
-- 5. Opening a DM is private until the first message
-- -----------------------------------------------------------------------------
reset role;
select coalesce(max(id), 0) as h0 from realtime.messages \gset
set role authenticated;
select tests.login(:'dan'::uuid);
select public.get_or_create_direct_channel(:'ana') as dm2 \gset
select tests.login(:'ana'::uuid);
select tests.eq((select count(*) from public.chat_channels where id = :'dm2')::int, 0,
                'the other person can''t see a DM someone merely opened');
select tests.eq(tests.hints(:h0, 'user:' || :'ana' || ':chat', 'inbox'), 0::bigint, '…and gets no hint about it');
select tests.login(:'dan'::uuid);
select tests.eq((select count(*) from public.get_chat_inbox() where channel_id = :'dm2')::int, 0,
                'the opener''s inbox doesn''t list it either');
select id as dan_m1 from public.send_chat_message(:'dm2', 'c0000000-0000-4000-a000-000000000201', 'Hi Ana, need a partner?') \gset
select tests.login(:'ana'::uuid);
select tests.eq((select unread_count || ' ' || title from public.get_chat_inbox() where channel_id = :'dm2'), '1 Dan Stranger',
                'the first message brings the DM to the other person, unread');
select tests.eq(tests.hints(:h0, 'user:' || :'ana' || ':chat', 'inbox'), 1::bigint, '…with one inbox hint');
select tests.eq((select public.get_or_create_direct_channel(:'dan')), :'dm2'::uuid, 'both sides converge on one thread');

-- -----------------------------------------------------------------------------
-- 6. Blocks
-- -----------------------------------------------------------------------------
select tests.login(:'ana'::uuid);
insert into public.profile_blocks (blocked_id) values (:'dan');
select tests.login(:'dan'::uuid);
select tests.ok(tests.error_of(format($$ select public.send_chat_message(%L, gen_random_uuid(), 'hello?') $$, :'dm2'))
                  like '42501 MESSAGING_UNAVAILABLE:%', 'the blocked person can''t send');
select tests.ok(tests.error_of(format($$ update public.chat_messages set message_text = 'edited' where id = %L $$, :'dan_m1'))
                  like '42501 MESSAGING_UNAVAILABLE:%', '…or edit');
select tests.eq((select count(*) from public.profile_blocks)::int, 0, '…and can''t see the block');
select tests.eq((select public.get_or_create_direct_channel(:'ana')), :'dm2'::uuid, 'an existing DM still opens');
select tests.eq((select blocked_by_me::text || ' ' || can_send from public.get_chat_inbox() where channel_id = :'dm2'),
                'false false', 'the inbox says you can''t send, not why');
select tests.ok(not tests.can_join('chat:' || :'dm2' || ':typing'), 'no typing channel across a block');
select tests.ok(not tests.can_send('chat:' || :'dm2' || ':typing'), '…in either direction');
reset role;
select coalesce(max(id), 0) as h1 from realtime.messages \gset
set role authenticated;
select tests.login(:'ana'::uuid);
select tests.ok(tests.error_of(format($$ select public.send_chat_message(%L, gen_random_uuid(), 'go away') $$, :'dm2'))
                  like '42501 MESSAGING_UNAVAILABLE:%', 'the blocker can''t send either');
select public.mark_chat_read(:'dm2', 1);
select tests.eq(tests.hints(:h1, 'chat:' || :'dm2', 'read'), 0::bigint, 'no read receipts across a block');
select tests.eq((select blocked_by_me::text || ' ' || can_send || ' ' || coalesce(partner_last_read_seq::text, 'hidden')
                   from public.get_chat_inbox() where channel_id = :'dm2'),
                'true false hidden', 'the blocker''s inbox: blocked by me, partner''s marker hidden');
select tests.login(:'ben'::uuid);
insert into public.profile_blocks (blocked_id) values (:'dan');
select tests.login(:'dan'::uuid);
select tests.ok(tests.error_of(format($$ select public.get_or_create_direct_channel(%L) $$, :'ben'))
                  like '42501 MESSAGING_UNAVAILABLE:%', 'no new thread with someone who blocked you');
select tests.throws(format($$ insert into storage.objects (bucket_id, name, owner) values ('chat-media', %L, %L) $$,
                           :'dm2' || '/' || :'dan' || '/c0000000-0000-4000-a000-000000000299.jpg', :'dan'),
                    '42501', 'no uploads into a blocked DM');
select tests.login(:'ana'::uuid);
delete from public.profile_blocks where blocked_id = :'dan';
select tests.login(:'dan'::uuid);
select tests.ok(tests.error_of(format($$ select public.send_chat_message(%L, gen_random_uuid(), 'Thanks!') $$, :'dm2')) is null,
                'unblocking reopens the conversation');

-- -----------------------------------------------------------------------------
-- 7. Rate limit
-- -----------------------------------------------------------------------------
select tests.login(:'fay'::uuid);
select count(public.send_chat_message(:'club', gen_random_uuid(), 'spam ' || g)) from generate_series(1, 20) g;
select tests.ok(tests.error_of(format($$ select public.send_chat_message(%L, gen_random_uuid(), 'one more') $$, :'club'))
                  ~ '^23514 RATE_LIMITED: .* \[hint [0-9]+\]$',
                'the 21st message in 30 seconds is refused, with a retry-after hint');

-- -----------------------------------------------------------------------------
-- 8. Media: named after the message key, readable only while live
-- -----------------------------------------------------------------------------
select tests.login(:'ana'::uuid);
\set photo_key 'c0000000-0000-4000-a000-000000000301'
select :'club' || '/' || :'ana' || '/' || :'photo_key' || '.jpg' as photo \gset
select tests.throws(format($$ insert into storage.objects (bucket_id, name, owner) values ('chat-media', %L, %L) $$,
                           :'club' || '/' || :'ana' || '/holiday.jpg', :'ana'),
                    '42501', 'uploads must be named <channel>/<me>/<message key>.<ext>');
insert into storage.objects (bucket_id, name, owner, metadata)
values ('chat-media', :'photo', :'ana', '{"mimetype": "image/jpeg"}');
select tests.ok(tests.error_of(format($$ select public.send_chat_message(%L, gen_random_uuid(), null, %L) $$, :'club', :'photo'))
                  like '23514 INVALID_MEDIA:%', 'media must belong to this message''s key');
select tests.ok(tests.error_of(format($$ select public.send_chat_message(%L, 'c0000000-0000-4000-a000-000000000302', null, %L) $$,
                                      :'club', :'club' || '/' || :'ana' || '/c0000000-0000-4000-a000-000000000302.jpg'))
                  like '23514 INVALID_MEDIA:%', 'media must be uploaded first');
select id as photo_msg, media_kind || ' ' || coalesce(media_width::text, 'null') || 'x' || media_height as photo_shape
  from public.send_chat_message(:'club', :'photo_key', null, :'photo', null, 0, 1600) \gset
select tests.eq(:'photo_shape'::text, 'IMAGE nullx1600',
                'a photo message: kind from the upload, impossible sizes dropped');
select tests.login(:'ben'::uuid);
select tests.eq((select count(*) from storage.objects where name = :'photo')::int, 1, 'members can open the photo');
select tests.login(:'dan'::uuid);
select tests.eq((select count(*) from storage.objects where name = :'photo')::int, 0, 'outsiders can''t');
select tests.login(:'ana'::uuid);
select tests.eq(tests.affected(format($$ delete from storage.objects where name = %L $$, :'photo')), 0::bigint,
                'a sent photo can''t be deleted (and swapped) under the message');
update public.chat_messages set deleted_at = now() where id = :'photo_msg';
select tests.login(:'ben'::uuid);
select tests.eq((select count(*) from storage.objects where name = :'photo')::int, 0,
                'once the message is deleted, members can''t open the photo');
select tests.login(:'ana'::uuid);
select tests.eq((select count(*) from storage.objects where name = :'photo')::int, 1, 'the uploader still can');
reset role;
select tests.eq((select count(*) from app.chat_media_purge where path = :'photo')::int, 1, 'the object is queued for purge');
set role service_role;
select tests.ok(:'photo' in (select public.claim_chat_media_purge(10)), 'the purge job claims it');
select tests.eq(public.complete_chat_media_purge(array[:'photo']), 1, '…and clears it from the queue when done');
set role authenticated;
select tests.login(:'ana'::uuid);
select tests.eq(tests.affected(format($$ delete from storage.objects where name = %L $$, :'photo')), 1::bigint,
                'the uploader may delete an object no message shows');
select tests.throws($$ select public.claim_chat_media_purge(10) $$, '42501', 'users can''t run the purge job');

-- -----------------------------------------------------------------------------
-- 9. Reports
-- -----------------------------------------------------------------------------
select tests.login(:'ben'::uuid);
select public.report_chat_message(:'m1', 'SPAM', 'Posts this everywhere') as rep \gset
select tests.eq(public.report_chat_message(:'m1', 'SPAM'), :'rep'::uuid, 'reporting twice returns the same report');
select tests.eq((select snapshot_text || ' / ' || status from public.chat_reports where id = :'rep'), 'First! / OPEN',
                'the report keeps a snapshot of the message');
select tests.login(:'ana'::uuid);
select tests.throws(format($$ select public.report_chat_message(%L, 'SPAM') $$, :'m1'), '22023', 'you can''t report yourself');
select tests.eq((select count(*) from public.chat_reports)::int, 0, 'the reported person can''t see the report');
select tests.login(:'dan'::uuid);
select tests.throws(format($$ select public.report_chat_message(%L, 'SPAM') $$, :'m1'), '42501',
                    'only people who can see a message can report it');
select tests.login(:'adi'::uuid);
update public.chat_reports set status = 'ACTIONED', resolution_note = 'Warned' where id = :'rep';
select tests.eq((select (resolved_by = :'adi'::uuid)::text || ' ' || (resolved_at is not null) from public.chat_reports where id = :'rep'),
                'true true', 'platform admins resolve reports (stamped)');
select tests.login(:'ben'::uuid);
select tests.eq(tests.affected(format($$ update public.chat_reports set status = 'DISMISSED' where id = %L $$, :'rep')),
                0::bigint, 'reporters can''t resolve their own reports');

-- -----------------------------------------------------------------------------
-- 10. Message pages and sync
-- -----------------------------------------------------------------------------
select tests.login(:'ben'::uuid);
select id as reply from public.send_chat_message(:'club', 'c0000000-0000-4000-a000-000000000401', 'Agreed', null, :'m1') \gset
select public.get_chat_messages(:'club') as page \gset
select tests.eq((:'page'::jsonb ->> 'last_seq')::bigint, (select last_seq from public.chat_channels where id = :'club'),
                'a page carries the channel''s last_seq from the same snapshot');
select tests.ok((select bool_and((a ->> 'seq')::bigint < (b ->> 'seq')::bigint)
                   from jsonb_array_elements(:'page'::jsonb -> 'messages') with ordinality x(a, i)
                   join jsonb_array_elements(:'page'::jsonb -> 'messages') with ordinality y(b, j) on j = i + 1),
                'messages come oldest first');
select tests.eq((select m -> 'reply_to' ->> 'snippet' from jsonb_array_elements(:'page'::jsonb -> 'messages') m
                  where m ->> 'id' = :'reply'), 'First!', 'replies carry a preview of the quoted message');
select tests.eq((select count(*) from jsonb_array_elements(:'page'::jsonb -> 'messages') m
                  where m ->> 'client_id' is not null and m -> 'sender' ->> 'id' <> :'ben')::int, 0,
                'other people''s message keys are not exposed');
select tests.ok((select (m ->> 'deleted_by_moderator')::boolean from jsonb_array_elements(:'page'::jsonb -> 'messages') m
                  where m ->> 'id' = :'m3'), 'moderator deletions are labelled');
select tests.eq((select (p ->> 'has_more') || ' ' || jsonb_array_length(p -> 'messages')
                   from (select public.get_chat_messages(:'club', p_limit => 2) as p) x), 'true 2',
                'p_limit pages, with has_more');
select tests.eq((select (p -> 'messages' -> 0 ->> 'seq') from (select public.get_chat_messages(:'club', p_before_seq => 3, p_limit => 1) as p) x),
                '2', 'p_before_seq walks back');
select (public.get_chat_messages(:'club') ->> 'last_rev') as cursor \gset
select tests.login(:'ana'::uuid);
update public.chat_messages set message_text = 'First! (edited)' where id = :'m1';
select tests.login(:'ben'::uuid);
select tests.eq((select string_agg(m ->> 'text', ',') from jsonb_array_elements(public.get_chat_messages(:'club', p_after_rev => :'cursor') -> 'messages') m),
                'First! (edited)', 'p_after_rev catches up on edits made since the cursor');
select tests.ok(tests.error_of(format($$ select public.get_chat_messages(%L, 1, 1) $$, :'club')) like '22023 %',
                'one paging mode at a time');
select tests.login(:'dan'::uuid);
select tests.ok(tests.error_of(format($$ select public.get_chat_messages(%L) $$, :'club')) like '42501 NOT_A_PARTICIPANT:%',
                'outsiders get no pages');
select tests.ok(tests.error_of(format($$ select * from public.list_chat_participants(%L) $$, :'club')) like '42501 %',
                '…and no member list');
select tests.login(:'ben'::uuid);
select tests.eq((select string_agg(display_name || ':' || role, ', ' order by display_name) from public.list_chat_participants(:'club')),
                'Ana Lim:MEMBER, Ben Cruz:MEMBER, Cora Admin:ADMIN, Fay Fast:MEMBER', 'member list with roles');

-- -----------------------------------------------------------------------------
-- 11. Realtime hints: metadata only, on the right topics
-- -----------------------------------------------------------------------------
reset role;
select coalesce(max(id), 0) as h2 from realtime.messages \gset
set role authenticated;
select tests.login(:'ana'::uuid);
select id as hm from public.send_chat_message(:'club', gen_random_uuid(), 'Hint check') \gset
reset role;
select tests.eq(tests.hints(:h2, 'chat:' || :'club', 'message'), 1::bigint, 'a group message: one hint on the channel topic');
select tests.eq((select string_agg(k, ',' order by k collate "C") from realtime.messages m, jsonb_object_keys(m.payload) k
                  where m.id > :h2 and m.topic = 'chat:' || :'club' and m.event = 'message'),
                'channel_id,created_at,id,message_id,op,rev,sender_id,seq', 'the hint carries positions, never content');
select tests.eq((select count(*) from realtime.messages where id > :h2 and topic like 'user:%')::bigint, 0::bigint,
                'group messages fan out per channel, not per member');
select tests.eq((select count(*) from realtime.messages where id > :h2 and event in ('read', 'inbox'))::bigint, 0::bigint,
                'the sender''s own marker advance sends no extra hints');
select coalesce(max(id), 0) as h3 from realtime.messages \gset
set role authenticated;
select tests.login(:'ana'::uuid);
select public.mark_chat_read(:'dm', 1);
select public.send_chat_message(:'dm', gen_random_uuid(), 'See you at 6');
select tests.login(:'ben'::uuid);
select public.mark_chat_read(:'club', 999);
reset role;
select tests.eq(tests.hints(:h3, 'user:' || :'ana' || ':chat', 'inbox') || '/' || tests.hints(:h3, 'user:' || :'ben' || ':chat', 'inbox'),
                '2/2', 'DM messages reach both inboxes; marker moves reach my own devices');
select tests.eq(tests.hints(:h3, 'chat:' || :'dm', 'read') || '/' || tests.hints(:h3, 'chat:' || :'club', 'read'), '1/0',
                'read receipts exist in DMs only');
select coalesce(max(id), 0) as h4 from realtime.messages \gset
set role authenticated;
select tests.login(:'fay'::uuid);
delete from public.club_members where club_id = '40000000-0000-4000-a000-000000000070' and profile_id = :'fay';
reset role;
select tests.eq((select payload ->> 'reason' from realtime.messages where id > :h4 and topic = 'user:' || :'fay' || ':chat'),
                'left', 'leaving tells my inbox');

-- Topic authorization (join = SELECT, client send = INSERT).
set role authenticated;
select tests.login(:'ana'::uuid);
select tests.ok(tests.can_join('chat:' || :'club') and tests.can_join('chat:' || :'club' || ':typing')
                and tests.can_join('user:' || :'ana' || ':chat'),
                'members join the channel and typing topics; I join my own user topic');
select tests.ok(not tests.can_join('user:' || :'ben' || ':chat'), 'nobody else''s user topic');
select tests.ok(not tests.can_join('chat:not-a-uuid') and not tests.can_join('chat:' || :'club' || ':typing:x')
                and not tests.can_join('chat:' || upper(:'club')), 'malformed topics are denied, not errors');
select tests.ok(tests.can_join('court:20000000-0000-4000-a000-000000000001:slots'), 'court topics still join');
select tests.ok(tests.can_send('chat:' || :'club' || ':typing'), 'members may send typing events');
select tests.ok(not tests.can_send('chat:' || :'club'), 'nobody can forge message/read/channel events');
select tests.ok(not tests.can_send('user:' || :'ana' || ':chat'), '…or inbox hints');
select tests.login(:'dan'::uuid);
select tests.ok(not tests.can_join('chat:' || :'club') and not tests.can_send('chat:' || :'club' || ':typing'),
                'outsiders can''t join or type');

-- -----------------------------------------------------------------------------
-- 12. Closed (archived) chats
-- -----------------------------------------------------------------------------
reset role;
select coalesce(max(id), 0) as h5 from realtime.messages \gset
update public.chat_channels set is_archived = true where id = :'club';
select tests.eq((select payload ->> 'reason' from realtime.messages where id > :h5 and topic = 'chat:' || :'club' and event = 'channel'),
                'archived', 'closing a chat is announced on its topic');
set role authenticated;
select tests.login(:'ana'::uuid);
select tests.ok(tests.error_of(format($$ select public.send_chat_message(%L, gen_random_uuid(), 'anyone?') $$, :'club'))
                  like '23514 CHANNEL_ARCHIVED:%', 'no new messages in a closed chat');
select tests.ok(tests.error_of(format($$ update public.chat_messages set message_text = 'late edit' where id = %L $$, :'hm'))
                  like '23514 CHANNEL_ARCHIVED:%', 'no edits either');
update public.chat_messages set deleted_at = now() where id = :'hm';
select tests.ok((select deleted_at is not null from public.chat_messages where id = :'hm'), 'deleting still works');
reset role;
update public.chat_channels set is_archived = false where id = :'club';

-- The nightly job closes finished event chats silently (no per-channel hints).
insert into public.events (id, organizer_id, municipality_code, title, sport, event_type, start_time, end_time, max_participants)
values ('50000000-0000-4000-a000-000000000070', :'cora', '9900100000', 'Old Social', 'PICKLEBALL', 'OPEN_PLAY',
        now() - interval '10 days', now() - interval '10 days' + interval '2 hours', 8);
select coalesce(max(id), 0) as h6 from realtime.messages \gset
select tests.ok(app.archive_finished_event_channels() >= 1, 'the archive job closes finished event chats');
select tests.eq((select count(*) from realtime.messages where id > :h6)::bigint, 0::bigint, '…without a hint storm');
select tests.ok((select is_archived from public.chat_channels where event_id = '50000000-0000-4000-a000-000000000070'),
                'that event''s chat is closed');

-- -----------------------------------------------------------------------------
-- 13. A replaced organiser leaves the event chat
-- -----------------------------------------------------------------------------
insert into public.events (id, organizer_id, municipality_code, title, sport, event_type, start_time, end_time, max_participants)
values ('50000000-0000-4000-a000-000000000071', :'cora', '9900100000', 'Handover Social', 'PICKLEBALL', 'OPEN_PLAY',
        now() + interval '5 days', now() + interval '5 days 2 hours', 8);
update public.events set organizer_id = :'ana' where id = '50000000-0000-4000-a000-000000000071';
select tests.eq((select string_agg(pr.full_name, ', ' order by pr.full_name)
                   from public.chat_participants p
                   join public.chat_channels c on c.id = p.channel_id
                   join public.profiles pr on pr.id = p.profile_id
                  where c.event_id = '50000000-0000-4000-a000-000000000071'),
                'Ana Lim', 'the new organiser joins and the old one leaves');

-- -----------------------------------------------------------------------------
-- 14. Account deletion works with chat history (FK null-outs pass the guard)
-- -----------------------------------------------------------------------------
set role authenticated;
select tests.login(:'gus'::uuid);
insert into public.club_members (club_id, profile_id) values ('40000000-0000-4000-a000-000000000070', :'gus');
select id as gus_msg from public.send_chat_message(:'club', gen_random_uuid(), 'Bye all') \gset
reset role;
update public.club_members set role = 'ADMIN' where club_id = '40000000-0000-4000-a000-000000000070' and profile_id = :'gus';
set role authenticated;
select tests.login(:'ana'::uuid);
select id as victim from public.send_chat_message(:'club', gen_random_uuid(), 'Moderate me', null, :'gus_msg') \gset
select tests.login(:'gus'::uuid);
update public.chat_messages set deleted_at = now() where id = :'victim';
reset role;
select last_rev as rev_before from public.chat_channels where id = :'club' \gset
select tests.lives(format($$ delete from auth.users where id = %L $$, :'gus'),
                   'a user who sent, replied-to and moderated messages can delete their account');
select tests.eq((select coalesce(sender_id::text, 'gone') || ' ' || coalesce(message_text, '∅') from public.chat_messages where id = :'gus_msg'),
                'gone Bye all', 'their messages stay, without a sender');
select tests.ok((select deleted_by is null and reply_to_id = :'gus_msg'::uuid from public.chat_messages where id = :'victim'),
                'messages they moderated lose deleted_by; replies still point at theirs');
select tests.eq((select last_rev from public.chat_channels where id = :'club'), :'rev_before'::bigint,
                'null-outs take no channel revision (no locks, no hints)');

-- -----------------------------------------------------------------------------
-- 15. Deleting a club: one hint, not one per member
-- -----------------------------------------------------------------------------
select coalesce(max(id), 0) as h7 from realtime.messages \gset
set role authenticated;
select tests.login(:'cora'::uuid);
delete from public.clubs where id = '40000000-0000-4000-a000-000000000071';
reset role;
select tests.eq((select string_agg(event || ':' || coalesce(payload ->> 'reason', ''), ',') from realtime.messages where id > :h7),
                'channel:deleted', 'a deleted club chat sends one "deleted" hint and no per-member hints');

-- -----------------------------------------------------------------------------
-- 16. Structure
-- -----------------------------------------------------------------------------
select tests.ok(not exists (select 1 from pg_publication_tables
                             where pubname = 'supabase_realtime' and tablename in ('chat_messages', 'chat_participants')),
                'chat left Postgres Changes (Broadcast hints instead)');
select tests.ok(not exists (select 1 from public.chat_channels c
                             where c.last_seq <> coalesce((select max(m.seq) from public.chat_messages m where m.channel_id = c.id), 0)
                                or c.last_rev <> coalesce((select max(m.rev) from public.chat_messages m where m.channel_id = c.id), 0)),
                'invariant: every channel''s counters equal its max seq/rev');
reset role;
