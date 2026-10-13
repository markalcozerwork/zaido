-- =============================================================================
-- Chat (DM / club / event) privacy & moderation, storage object policies.
-- =============================================================================
\set ON_ERROR_STOP 1
reset role;
set role authenticated;

-- -----------------------------------------------------------------------------
-- Direct messages
-- -----------------------------------------------------------------------------
select tests.login('alice');
select public.get_or_create_direct_channel(tests.uid('bob')) as dm \gset
select tests.eq(public.get_or_create_direct_channel(tests.uid('bob')), :'dm'::uuid, 'DM get-or-create is idempotent');
select tests.login('bob');
select tests.eq(public.get_or_create_direct_channel(tests.uid('alice')), :'dm'::uuid, 'both sides converge on the same DM thread');
select tests.throws($$ select public.get_or_create_direct_channel(tests.uid('bob')) $$, '22023', 'cannot DM yourself');

select tests.login('alice');
insert into public.chat_messages (channel_id, sender_id, message_text)
values (:'dm', tests.uid('bob'), 'Singles tomorrow 6am?');   -- tries to spoof Bob as the sender
select tests.eq((select sender_id from public.chat_messages where channel_id = :'dm'), tests.uid('alice'),
                'sender is always the authenticated user (spoofing ignored)');
select tests.ok((select last_message_at is not null from public.chat_channels where id = :'dm'::uuid),
                'channel last_message_at bumped for inbox ordering');

select tests.login('bob');
select tests.eq((select message_text from public.chat_messages where channel_id = :'dm'), 'Singles tomorrow 6am?',
                'recipient reads the DM');
select tests.eq(tests.affected(format($$ update public.chat_messages set message_text = 'edited by bob' where channel_id = %L $$, :'dm')),
                0::bigint, 'cannot edit someone else''s message');

select tests.login('dave');
select tests.eq((select count(*) from public.chat_messages where channel_id = :'dm')::int, 0, 'outsiders cannot read a DM');
select tests.eq((select count(*) from public.chat_channels where id = :'dm'::uuid)::int, 0, 'outsiders cannot even see the DM exists');
select tests.throws(format($$ insert into public.chat_messages (channel_id, message_text) values (%L, 'hi') $$, :'dm'),
                    '42501', 'outsiders cannot post into a DM');
select tests.throws(format($$ insert into public.chat_participants (channel_id, profile_id) values (%L, tests.uid('dave')) $$, :'dm'),
                    '42501', 'cannot self-join a channel');

select tests.login('alice');
update public.chat_messages set message_text = 'Singles tomorrow 6:30am?' where channel_id = :'dm';
select tests.ok((select edited_at is not null from public.chat_messages where channel_id = :'dm'), 'edits are marked');
update public.chat_messages set deleted_at = now() where channel_id = :'dm';
select tests.eq((select coalesce(message_text, '∅') || '/' || (deleted_by = tests.uid('alice'))::text
                   from public.chat_messages where channel_id = :'dm'),
                '∅/true', 'soft delete wipes the content and records who deleted it');
select tests.throws(format($$ update public.chat_messages set message_text = 'undo' where channel_id = %L $$, :'dm'),
                    '23514', 'deleted messages stay deleted');
select tests.throws(format($$ update public.chat_participants set joined_at = now() where channel_id = %L $$, :'dm'),
                    '42501', 'only read marker / mute are user-writable on participants');
update public.chat_participants set last_read_at = now(), is_muted = true where channel_id = :'dm' and profile_id = tests.uid('alice');
select tests.ok(true, 'users update their own read marker and mute');

-- -----------------------------------------------------------------------------
-- Club chat moderation
-- -----------------------------------------------------------------------------
select c.id as club_chat from public.chat_channels c where c.type = 'CLUB' and c.club_id = '40000000-0000-4000-a000-000000000001' \gset
insert into public.chat_messages (id, channel_id, message_text)
values ('60000000-0000-4000-a000-000000000001', :'club_chat', 'Anyone selling a used paddle?');
select tests.login('carlos');
update public.chat_messages set deleted_at = now() where id = '60000000-0000-4000-a000-000000000001';
select tests.eq((select deleted_by from public.chat_messages where id = '60000000-0000-4000-a000-000000000001'), tests.uid('carlos'),
                'club admins can moderate (soft-delete) club chat');
select tests.login('dave');
select tests.eq((select count(*) from public.chat_messages where channel_id = :'club_chat')::int, 0,
                'non-members cannot read club chat');

-- Leaving the club revokes chat access immediately.
select tests.login('alice');
delete from public.club_members where club_id = '40000000-0000-4000-a000-000000000001' and profile_id = tests.uid('alice');
select tests.eq((select count(*) from public.chat_messages
                  where channel_id = :'club_chat' and sender_id is distinct from tests.uid('alice'))::int, 0,
                'leaving a club removes access to its chat history');
-- [Step 4] Except your own messages, so you can still delete them.
select tests.eq((select count(*) from public.chat_messages
                  where channel_id = :'club_chat' and sender_id = tests.uid('alice'))::int, 1,
                'ex-members still see (only) their own messages');

-- -----------------------------------------------------------------------------
-- Storage: payment receipts (private, append-only), avatars
-- -----------------------------------------------------------------------------
select tests.login('bob');
insert into storage.objects (bucket_id, name)
values ('payment-receipts', '30000000-0000-4000-a000-000000000002/gcash-1.jpg');
select tests.ok(true, 'booker uploads a receipt into their booking folder');
select tests.throws($$ insert into storage.objects (bucket_id, name)
                       values ('payment-receipts', '30000000-0000-4000-a000-000000000001/fake.jpg') $$,
                    '42501', 'cannot upload into someone else''s booking folder');
select tests.throws($$ insert into storage.objects (bucket_id, name) values ('payment-receipts', 'not-a-uuid/x.jpg') $$,
                    '42501', 'malformed receipt paths are denied, not errors');
select tests.eq(tests.affected($$ delete from storage.objects where bucket_id = 'payment-receipts' $$), 0::bigint,
                'receipts cannot be deleted (evidence)');
select tests.eq(tests.affected($$ update storage.objects set name = name || '.bak' where bucket_id = 'payment-receipts' $$), 0::bigint,
                'receipts cannot be overwritten (evidence)');

select tests.login('mia');
select tests.eq((select count(*) from storage.objects
                  where bucket_id = 'payment-receipts' and name like '30000000-0000-4000-a000-000000000002/%')::int, 1,
                'venue front desk can open receipts for their venue');
select tests.login('dave');
select tests.eq((select count(*) from storage.objects where bucket_id = 'payment-receipts')::int, 0,
                'other users cannot see receipts');

select tests.login('alice');
select tests.throws($$ insert into storage.objects (bucket_id, name)
                       values ('payment-receipts', '30000000-0000-4000-a000-000000000001/late.jpg') $$,
                    '42501', 'no receipt uploads after the booking is confirmed');
insert into storage.objects (bucket_id, name) values ('avatars', tests.uid('alice')::text || '/me.webp');
select tests.throws(format($$ insert into storage.objects (bucket_id, name) values ('avatars', %L) $$, tests.uid('bob')::text || '/me.webp'),
                    '42501', 'cannot write into another user''s avatar folder');
reset role;
