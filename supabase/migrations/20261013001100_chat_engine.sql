-- =============================================================================
-- RacketHub · 1100 · Real-time chat engine (Step 4)
-- =============================================================================
-- Builds on 0800 (channels, derived membership, guard). What this adds:
--
--  1. ORDER: every message gets a per-channel `seq` (position) and `rev` (last
--     change), assigned under the channel row lock, which is held until commit.
--     Within a channel, seq order is commit order and seq has no gaps. A client
--     that synced "rev > my cursor" can't miss a message, unlike created_at
--     (= transaction start, so a slower sender commits "in the past").
--     History pages are keyset on (channel_id, seq).
--  2. UNREAD: unread = channel.last_seq - participant.last_read_seq, so it costs
--     nothing to compute. Markers only move forward and are clamped to
--     last_seq. Joiners start caught up.
--  3. SEND: public.send_chat_message is idempotent per (sender, client_id), so a
--     retry after a lost response returns the same message. It mirrors
--     create_booking: advisory lock, lookup, then a plain INSERT. Never
--     INSERT ... ON CONFLICT here: BEFORE triggers would already have bumped the
--     counter for the skipped row, leaving a gap and a phantom unread message.
--  4. TRUST: guards stay SECURITY INVOKER (app.is_trusted_context() is true
--     inside DEFINER code, so a DEFINER guard would trust everyone). The counter
--     work is a separate DEFINER trigger that never asks who is calling. Trigger
--     names fix the order: *_10_guard validates before *_20_sequence locks the
--     channel row.
--  5. REALTIME (Broadcast from Database, payloads are hints only, never content):
--       chat:<channel_id>         receive-only for participants and moderators
--                                 `message` {channel_id, message_id, seq, rev, op, sender_id, created_at}
--                                 `read`    {channel_id, profile_id, last_read_seq}  (DMs only)
--                                 `channel` {channel_id, reason}
--       chat:<channel_id>:typing  participants send and receive `typing` (client-sent)
--       user:<profile_id>:chat    receive-only for that user
--                                 `inbox`   {channel_id, reason, ...}: DM messages, own
--                                           joins/leaves (not DMs), own marker/mute moves
--     Clients refetch through RLS-checked RPCs, so a missed, repeated or
--     reordered hint can't leave them wrong. A removed member keeps no content
--     access; until Realtime re-authorizes (token refresh), they see at most
--     metadata. The chat tables leave the Postgres Changes publication: per-
--     subscriber RLS on every change doesn't scale to club-sized channels.
--     Groups cost one realtime.send per message. A DM costs three (channel topic
--     + both user topics). Each realtime.send is a subtransaction, so bulk paths
--     (cascades, the archive job) send nothing and clients resync instead.
--  6. BLOCKS: public.profile_blocks. A block between the two people stops DM
--     sends, edits, typing, uploads and read receipts both ways, with the same
--     neutral message on both sides.
--  7. MEDIA: objects are named <channel>/<sender>/<client_id>.<ext>. Once
--     referenced they can't be swapped. Deleted or moderated media stops being
--     readable at once and is queued for purge. Unsent uploads are swept after
--     a day.
--  8. REPORTS: public.chat_reports + report_chat_message() (snapshot of the
--     message) for app-store UGC rules; DMs have no moderator.
--  9. FIXES to 0800: account deletion no longer fails on the guard (FK null-outs
--     pass), a replaced organiser/coach leaves the event chat, opening a DM is
--     invisible to the other person until the first message, and ex-members may
--     still delete their own messages.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Columns, backfill, constraints
-- -----------------------------------------------------------------------------
alter table public.chat_channels
  add column last_seq bigint not null default 0,
  add column last_rev bigint not null default 0;
-- Every message updates its channel row. Spare room lets those updates stay HOT.
alter table public.chat_channels set (fillfactor = 80);

alter table public.chat_messages
  add column seq          bigint,
  add column rev          bigint,
  add column client_id    uuid not null default gen_random_uuid(),
  add column media_kind   text,
  add column media_width  integer,
  add column media_height integer;

-- -1 = "not set": the insert trigger replaces it with the channel's last_seq.
alter table public.chat_participants
  add column last_read_seq bigint not null default -1;

-- Backfill with every user trigger off (the old guard refuses to touch
-- soft-deleted rows, and the new triggers don't exist yet).
alter table public.chat_messages     disable trigger user;
alter table public.chat_participants disable trigger user;
alter table public.chat_channels     disable trigger user;

with ordered as (
  select m.id, row_number() over (partition by m.channel_id order by m.created_at, m.id) as n
    from public.chat_messages m
)
update public.chat_messages m
   set seq = o.n, rev = o.n,
       media_kind = case when m.media_url is null then null
                         when m.media_url ~* '\.mp4$' then 'VIDEO' else 'IMAGE' end
  from ordered o
 where o.id = m.id;

update public.chat_channels c
   set last_seq = x.max_seq, last_rev = x.max_seq
  from (select channel_id, max(seq) as max_seq from public.chat_messages group by channel_id) x
 where x.channel_id = c.id;

update public.chat_participants p
   set last_read_seq = coalesce((select max(m.seq) from public.chat_messages m
                                  where m.channel_id = p.channel_id and m.created_at <= p.last_read_at), 0);

alter table public.chat_messages     enable trigger user;
alter table public.chat_participants enable trigger user;
alter table public.chat_channels     enable trigger user;

alter table public.chat_messages
  alter column seq set not null,
  alter column rev set not null,
  add constraint chat_messages_channel_seq_key   unique (channel_id, seq),
  add constraint chat_messages_channel_rev_key   unique (channel_id, rev),
  add constraint chat_messages_sender_client_key unique (sender_id, client_id),
  add constraint chat_messages_media_kind_check  check (media_kind in ('IMAGE', 'VIDEO')),
  add constraint chat_messages_media_shape       check ((media_url is null) = (media_kind is null)),
  add constraint chat_messages_media_dimensions  check (
    (media_width is null or media_width between 1 and 10000)
    and (media_height is null or media_height between 1 and 10000));

alter table public.chat_participants
  add constraint chat_participants_last_read_seq_check check (last_read_seq >= 0);

-- A media object belongs to exactly one live message.
create unique index chat_messages_media_url_key on public.chat_messages (media_url) where media_url is not null;
-- Pagination moves to (channel_id, seq); the rate limit reads (sender_id, created_at).
drop index public.chat_messages_channel_created_idx;
drop index public.chat_messages_sender_idx;
create index chat_messages_sender_created_idx on public.chat_messages (sender_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 2. Limits (one place; the contract tests read these)
-- -----------------------------------------------------------------------------
create or replace function app.chat_edit_window() returns interval
language sql immutable set search_path = '' as $$ select interval '15 minutes' $$;

create or replace function app.chat_rate_limit_count() returns integer
language sql immutable set search_path = '' as $$ select 20 $$;

create or replace function app.chat_rate_limit_window() returns interval
language sql immutable set search_path = '' as $$ select interval '30 seconds' $$;

-- -----------------------------------------------------------------------------
-- 3. Blocks, reports, media purge queue
-- -----------------------------------------------------------------------------
create table public.profile_blocks (
  blocker_id  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  blocked_id  uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint profile_blocks_not_self check (blocker_id <> blocked_id)
);
create index profile_blocks_blocked_idx on public.profile_blocks (blocked_id);
alter table public.profile_blocks enable row level security;

-- The blocked person can't see the block (no policy matches them).
create policy "profile_blocks: own list"
  on public.profile_blocks for select to authenticated
  using (blocker_id = (select auth.uid()));
create policy "profile_blocks: block someone"
  on public.profile_blocks for insert to authenticated
  with check (blocker_id = (select auth.uid()));
create policy "profile_blocks: unblock"
  on public.profile_blocks for delete to authenticated
  using (blocker_id = (select auth.uid()));

create type public.chat_report_reason as enum ('SPAM', 'HARASSMENT', 'HATE', 'SEXUAL_CONTENT', 'VIOLENCE', 'SCAM', 'OTHER');
create type public.chat_report_status as enum ('OPEN', 'ACTIONED', 'DISMISSED');

create table public.chat_reports (
  id                   uuid primary key default gen_random_uuid(),
  reporter_id          uuid references public.profiles (id) on delete set null,
  message_id           uuid references public.chat_messages (id) on delete set null,
  channel_id           uuid references public.chat_channels (id) on delete set null,
  reported_profile_id  uuid references public.profiles (id) on delete set null,
  reason               public.chat_report_reason not null,
  note                 text,
  -- What the reporter saw, kept even if the sender deletes the message.
  snapshot_text        text,
  snapshot_media_path  text,
  status               public.chat_report_status not null default 'OPEN',
  resolved_by          uuid references public.profiles (id) on delete set null,
  resolved_at          timestamptz,
  resolution_note      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint chat_reports_note_length            check (note is null or char_length(note) <= 500),
  constraint chat_reports_resolution_note_length check (resolution_note is null or char_length(resolution_note) <= 500),
  constraint chat_reports_resolution_shape       check ((status = 'OPEN') = (resolved_at is null))
);
create unique index chat_reports_once_per_message on public.chat_reports (reporter_id, message_id)
  where reporter_id is not null and message_id is not null;
create index chat_reports_open_idx      on public.chat_reports (created_at) where status = 'OPEN';
create index chat_reports_message_idx   on public.chat_reports (message_id) where message_id is not null;
create index chat_reports_channel_idx   on public.chat_reports (channel_id) where channel_id is not null;
create index chat_reports_reported_idx  on public.chat_reports (reported_profile_id) where reported_profile_id is not null;
create index chat_reports_resolver_idx  on public.chat_reports (resolved_by) where resolved_by is not null;
create index chat_reports_media_idx     on public.chat_reports (snapshot_media_path) where snapshot_media_path is not null;

create trigger chat_reports_set_updated_at
  before update on public.chat_reports
  for each row execute function app.tg_set_updated_at();

create or replace function app.tg_chat_reports_resolve()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'OPEN' then
      new.resolved_by := null;
      new.resolved_at := null;
    else
      new.resolved_by := auth.uid();
      new.resolved_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger chat_reports_resolve
  before update on public.chat_reports
  for each row execute function app.tg_chat_reports_resolve();

alter table public.chat_reports enable row level security;

create policy "chat_reports: reporters see their own, admins see all"
  on public.chat_reports for select to authenticated
  using (reporter_id = (select auth.uid()) or app.is_platform_admin());
create policy "chat_reports: admins resolve"
  on public.chat_reports for update to authenticated
  using (app.is_platform_admin())
  with check (app.is_platform_admin());

-- Media paths whose objects must be removed through the Storage API (a
-- service-role job; see claim_chat_media_purge).
create table app.chat_media_purge (
  path       text primary key,
  queued_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 4. Helpers (SECURITY DEFINER where they read rows the caller can't)
-- -----------------------------------------------------------------------------
-- A block in either direction between the two people of a DM.
create or replace function app.dm_is_blocked(p_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.chat_channels c
      join public.profile_blocks b
        on (b.blocker_id = c.dm_profile_low  and b.blocked_id = c.dm_profile_high)
        or (b.blocker_id = c.dm_profile_high and b.blocked_id = c.dm_profile_low)
     where c.id = p_channel_id and c.type = 'DIRECT'
  );
$$;

-- A non-deleted message shows this object.
create or replace function app.chat_media_is_live(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.chat_messages m where m.media_url = p_path and m.deleted_at is null);
$$;

-- The uploaded object's MIME type; NULL when no such object exists.
create or replace function app.chat_media_mimetype(p_path text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mime text;
begin
  if to_regclass('storage.objects') is null then
    return null;
  end if;
  select coalesce(o.metadata ->> 'mimetype', '') into v_mime
    from storage.objects o
   where o.bucket_id = 'chat-media' and o.name = p_path;
  return v_mime;
end;
$$;

-- Sends by one person in the rate window, and seconds until the oldest of the
-- last N leaves it.
create or replace function app.chat_rate_status(p_sender uuid, out sent integer, out retry_after integer)
language sql
stable
security definer
set search_path = ''
as $$
  with recent as (
    select m.created_at
      from public.chat_messages m
     where m.sender_id = p_sender and m.created_at > now() - app.chat_rate_limit_window()
     order by m.created_at desc
     limit app.chat_rate_limit_count()
  )
  select count(*)::integer,
         greatest(1, ceil(extract(epoch from (min(created_at) + app.chat_rate_limit_window() - now()))))::integer
    from recent;
$$;

-- realtime.send when Realtime exists (test databases without it skip). Never
-- granted to API roles; only the DEFINER triggers below call it.
create or replace function app.chat_send(p_topic text, p_event text, p_payload jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('rackethub.chat_bulk', true), '') = 'on'
     or to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return;
  end if;
  perform realtime.send(p_payload, p_event, p_topic, true);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Message guard (SECURITY INVOKER: it must see the real caller)
-- -----------------------------------------------------------------------------
create or replace function app.tg_chat_messages_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_trusted  boolean := app.is_trusted_context();
  v_me       uuid := auth.uid();
  v_mime     text;
  v_rate     record;
  v_nullout  boolean;
begin
  if tg_op = 'INSERT' then
    if not v_trusted then
      new.sender_id  := v_me;
      new.created_at := now();
      new.edited_at  := null;
      new.deleted_at := null;
      new.deleted_by := null;
      -- Validation before the sequence trigger locks the channel row, so
      -- outsiders and spammers never hold it.
      if v_me is null or not app.is_channel_participant(new.channel_id) then
        raise exception using errcode = '42501',
          message = 'NOT_A_PARTICIPANT: You''re not in this conversation.';
      end if;
      if app.dm_is_blocked(new.channel_id) then
        raise exception using errcode = '42501',
          message = 'MESSAGING_UNAVAILABLE: You can''t send messages in this conversation.';
      end if;
      -- One sender's sends queue on this lock, so parallel requests can't all
      -- slip under the limit. Lock order: idempotency → rate → channel row.
      perform pg_advisory_xact_lock(hashtextextended('rackethub:chat-rate:' || v_me::text, 0));
      select * into v_rate from app.chat_rate_status(v_me);
      if v_rate.sent >= app.chat_rate_limit_count() then
        raise exception using errcode = '23514',
          message = 'RATE_LIMITED: You''re sending messages too quickly. Wait a few seconds and try again.',
          hint = v_rate.retry_after::text;
      end if;
    end if;

    new.message_text := nullif(btrim(new.message_text, E' \t\r\n'), '');
    if new.message_text is null and new.media_url is null then
      raise exception using errcode = '23514', message = 'MESSAGE_EMPTY: Type a message or attach a photo.';
    end if;

    if new.media_url is not null then
      if not v_trusted then
        -- The object is named after this message's idempotency key, in the
        -- sender's own folder of this channel.
        if new.media_url !~ ('^' || new.channel_id::text || '/' || v_me::text || '/'
                             || new.client_id::text || '\.(jpe?g|png|webp|gif|mp4)$') then
          raise exception using errcode = '23514',
            message = 'INVALID_MEDIA: Upload the photo or video for this message first.';
        end if;
        v_mime := app.chat_media_mimetype(new.media_url);
        if v_mime is null then
          raise exception using errcode = '23514',
            message = 'INVALID_MEDIA: Upload the photo or video for this message first.';
        end if;
        new.media_kind := case when v_mime like 'video/%' or new.media_url ~ '\.mp4$' then 'VIDEO' else 'IMAGE' end;
      else
        new.media_kind := coalesce(new.media_kind,
                                   case when new.media_url ~* '\.mp4$' then 'VIDEO' else 'IMAGE' end);
      end if;
      -- Layout hints from the client; out-of-range values are dropped, not errors.
      if new.media_width  not between 1 and 10000 then new.media_width  := null; end if;
      if new.media_height not between 1 and 10000 then new.media_height := null; end if;
    else
      new.media_kind := null;
      new.media_width := null;
      new.media_height := null;
    end if;

    if new.reply_to_id is not null and not exists (
      select 1 from public.chat_messages m where m.id = new.reply_to_id and m.channel_id = new.channel_id
    ) then
      raise exception using errcode = '23514',
        message = 'REPLY_NOT_IN_CHANNEL: You can only reply to a message in this conversation.';
    end if;
    return new;
  end if;

  -- UPDATE ---------------------------------------------------------------------
  -- Foreign keys clearing sender_id / deleted_by / reply_to_id (account or
  -- message deletion) must always pass, even on soft-deleted rows.
  v_nullout := v_trusted
    and (new.sender_id   is not distinct from old.sender_id   or new.sender_id   is null)
    and (new.deleted_by  is not distinct from old.deleted_by  or new.deleted_by  is null)
    and (new.reply_to_id is not distinct from old.reply_to_id or new.reply_to_id is null)
    and (new.id, new.channel_id, new.message_text, new.media_url, new.media_kind, new.media_width, new.media_height,
         new.edited_at, new.deleted_at, new.created_at, new.seq, new.rev, new.client_id)
        is not distinct from
        (old.id, old.channel_id, old.message_text, old.media_url, old.media_kind, old.media_width, old.media_height,
         old.edited_at, old.deleted_at, old.created_at, old.seq, old.rev, old.client_id);
  if v_nullout then
    return new;
  end if;

  if new.id <> old.id or new.channel_id <> old.channel_id or new.sender_id is distinct from old.sender_id
     or new.created_at <> old.created_at or new.reply_to_id is distinct from old.reply_to_id
     or new.seq <> old.seq or new.client_id <> old.client_id then
    raise exception using errcode = '42501', message = 'Only the message text can be edited.';
  end if;
  if old.deleted_at is not null then
    raise exception using errcode = '23514', message = 'MESSAGE_DELETED: This message was deleted.';
  end if;

  if new.deleted_at is not null then
    -- Soft delete: keep the row (threads, seq, reports) but drop the content.
    if not v_trusted and old.sender_id is distinct from v_me and not app.is_channel_moderator(old.channel_id) then
      raise exception using errcode = '42501', message = 'You can only delete your own messages.';
    end if;
    new.deleted_at   := now();
    new.deleted_by   := case when v_trusted then coalesce(new.deleted_by, v_me) else v_me end;
    new.message_text := null;
    new.media_url    := null;
    new.media_kind   := null;
    new.media_width  := null;
    new.media_height := null;
    new.edited_at    := old.edited_at;
    return new;
  end if;

  -- Edit
  if not v_trusted then
    if old.sender_id is distinct from v_me then
      raise exception using errcode = '42501', message = 'You can only edit your own messages.';
    end if;
    if not app.is_channel_participant(old.channel_id) then
      raise exception using errcode = '42501', message = 'NOT_A_PARTICIPANT: You''re not in this conversation.';
    end if;
    if app.dm_is_blocked(old.channel_id) then
      raise exception using errcode = '42501',
        message = 'MESSAGING_UNAVAILABLE: You can''t send messages in this conversation.';
    end if;
    if now() > old.created_at + app.chat_edit_window() then
      raise exception using errcode = '23514',
        message = 'EDIT_WINDOW_PASSED: Messages can only be edited within 15 minutes of sending.';
    end if;
    if new.media_url is distinct from old.media_url or new.deleted_by is distinct from old.deleted_by
       or new.media_kind is distinct from old.media_kind or new.media_width is distinct from old.media_width
       or new.media_height is distinct from old.media_height then
      raise exception using errcode = '42501', message = 'Only the message text can be edited.';
    end if;
  end if;
  new.message_text := nullif(btrim(new.message_text, E' \t\r\n'), '');
  if new.message_text is null and new.media_url is null then
    raise exception using errcode = '23514', message = 'MESSAGE_EMPTY: A message can''t be empty. Delete it instead.';
  end if;
  if new.message_text is distinct from old.message_text then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

alter trigger chat_messages_guard on public.chat_messages rename to chat_messages_10_guard;

-- -----------------------------------------------------------------------------
-- 6. Sequence trigger (SECURITY DEFINER; never consults the caller's trust)
-- -----------------------------------------------------------------------------
create or replace function app.tg_chat_messages_sequence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel  record;
  v_rev      bigint;
begin
  if tg_op = 'INSERT' then
    select c.type, c.is_archived, c.last_seq, c.dm_profile_low, c.dm_profile_high
      into v_channel
      from public.chat_channels c
     where c.id = new.channel_id
       for no key update;
    if not found then
      return new;   -- the foreign key reports it
    end if;
    if v_channel.is_archived then
      raise exception using errcode = '23514',
        message = 'CHANNEL_ARCHIVED: This conversation is closed to new messages.';
    end if;
    -- Opening a DM adds only the opener. The other person joins with the
    -- first message, which is unread for them.
    if v_channel.type = 'DIRECT' then
      insert into public.chat_participants (channel_id, profile_id, last_read_seq)
      select new.channel_id, x.profile_id, v_channel.last_seq
        from unnest(array[v_channel.dm_profile_low, v_channel.dm_profile_high]) as x (profile_id)
      on conflict do nothing;
    end if;
    update public.chat_channels c
       set last_seq        = c.last_seq + 1,
           last_rev        = c.last_rev + 1,
           last_message_at = greatest(coalesce(c.last_message_at, '-infinity'::timestamptz), new.created_at)
     where c.id = new.channel_id
    returning c.last_seq, c.last_rev into new.seq, new.rev;
    return new;
  end if;

  -- UPDATE: only visible changes get a new revision. FK null-outs don't, so
  -- deleting an account takes no channel locks.
  new.seq := old.seq;
  if new.message_text is not distinct from old.message_text
     and new.media_url is not distinct from old.media_url
     and new.deleted_at is not distinct from old.deleted_at then
    new.rev := old.rev;
    return new;
  end if;
  update public.chat_channels c
     set last_rev = c.last_rev + 1
   where c.id = new.channel_id
     and (new.deleted_at is not null or not c.is_archived)   -- deletes stay possible in closed chats
  returning c.last_rev into v_rev;
  if v_rev is null then
    raise exception using errcode = '23514',
      message = 'CHANNEL_ARCHIVED: This conversation is closed. Messages can no longer be edited.';
  end if;
  new.rev := v_rev;
  return new;
end;
$$;

create trigger chat_messages_20_sequence
  before insert or update on public.chat_messages
  for each row execute function app.tg_chat_messages_sequence();

-- -----------------------------------------------------------------------------
-- 7. After a message: sender's marker, media purge, hints
-- -----------------------------------------------------------------------------
drop trigger chat_messages_touch_channel on public.chat_messages;
drop function app.tg_chat_messages_touch_channel();

create or replace function app.tg_chat_messages_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_op       text;
  v_channel  record;
  v_hint     jsonb;
begin
  if tg_op = 'INSERT' then
    -- The sender has read up to their own message. Quiet: the message hint
    -- already tells their other devices.
    perform set_config('rackethub.chat_quiet', 'on', true);
    update public.chat_participants p
       set last_read_seq = greatest(p.last_read_seq, new.seq),
           last_read_at  = greatest(p.last_read_at, now())
     where p.channel_id = new.channel_id and p.profile_id = new.sender_id;
    perform set_config('rackethub.chat_quiet', 'off', true);
    v_op := 'INSERT';
  else
    if new.rev = old.rev then
      return null;   -- no visible change
    end if;
    if new.deleted_at is not null and old.deleted_at is null then
      v_op := 'DELETE';
      if old.media_url is not null then
        insert into app.chat_media_purge (path) values (old.media_url) on conflict do nothing;
      end if;
    else
      v_op := 'UPDATE';
    end if;
  end if;

  v_hint := jsonb_build_object(
    'channel_id', new.channel_id, 'message_id', new.id, 'seq', new.seq, 'rev', new.rev,
    'op', v_op, 'sender_id', new.sender_id, 'created_at', new.created_at);
  perform app.chat_send('chat:' || new.channel_id, 'message', v_hint);

  select c.type, c.dm_profile_low, c.dm_profile_high into v_channel
    from public.chat_channels c where c.id = new.channel_id;
  if v_channel.type = 'DIRECT' then
    v_hint := v_hint || jsonb_build_object('reason', 'message');
    perform app.chat_send('user:' || v_channel.dm_profile_low  || ':chat', 'inbox', v_hint);
    perform app.chat_send('user:' || v_channel.dm_profile_high || ':chat', 'inbox', v_hint);
  end if;
  return null;
end;
$$;

create trigger chat_messages_80_after
  after insert or update on public.chat_messages
  for each row execute function app.tg_chat_messages_after();

-- -----------------------------------------------------------------------------
-- 8. Participants: start caught up, forward-only markers, hints
-- -----------------------------------------------------------------------------
create or replace function app.tg_chat_participants_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.last_read_seq < 0 then
    select c.last_seq into new.last_read_seq from public.chat_channels c where c.id = new.channel_id;
    new.last_read_seq := coalesce(new.last_read_seq, 0);
  end if;
  return new;
end;
$$;

create trigger chat_participants_10_defaults
  before insert on public.chat_participants
  for each row execute function app.tg_chat_participants_defaults();

-- SECURITY INVOKER. Users may only move their marker (forward, up to the last
-- message) and mute. last_read_at is always the server's clock.
create or replace function app.tg_chat_participants_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_last bigint;
begin
  if app.is_trusted_context() then
    return new;
  end if;
  if new.channel_id <> old.channel_id or new.profile_id <> old.profile_id or new.joined_at <> old.joined_at then
    raise exception using errcode = '42501', message = 'Only the read marker and mute can be changed.';
  end if;
  select c.last_seq into v_last from public.chat_channels c where c.id = new.channel_id;
  new.last_read_seq := greatest(old.last_read_seq,
                                least(coalesce(new.last_read_seq, old.last_read_seq), coalesce(v_last, old.last_read_seq)));
  new.last_read_at  := case when new.last_read_seq > old.last_read_seq then now() else old.last_read_at end;
  return new;
end;
$$;

create trigger chat_participants_20_guard
  before update on public.chat_participants
  for each row execute function app.tg_chat_participants_guard();

create or replace function app.tg_chat_participants_hints()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row      public.chat_participants := case when tg_op = 'DELETE' then old else new end;
  v_type     public.channel_type;
begin
  if coalesce(current_setting('rackethub.chat_bulk', true), '') = 'on' then
    return null;
  end if;
  select c.type into v_type from public.chat_channels c where c.id = v_row.channel_id;
  if not found then
    return null;   -- the channel itself is being deleted
  end if;

  if tg_op = 'UPDATE' then
    if coalesce(current_setting('rackethub.chat_quiet', true), '') = 'on'
       or (new.last_read_seq = old.last_read_seq and new.is_muted = old.is_muted) then
      return null;
    end if;
    perform app.chat_send('user:' || new.profile_id || ':chat', 'inbox', jsonb_build_object(
      'channel_id', new.channel_id,
      'reason', case when new.last_read_seq <> old.last_read_seq then 'read' else 'muted' end,
      'last_read_seq', new.last_read_seq, 'is_muted', new.is_muted));
    -- Read receipts exist in DMs only, and never across a block.
    if v_type = 'DIRECT' and new.last_read_seq > old.last_read_seq and not app.dm_is_blocked(new.channel_id) then
      perform app.chat_send('chat:' || new.channel_id, 'read', jsonb_build_object(
        'channel_id', new.channel_id, 'profile_id', new.profile_id, 'last_read_seq', new.last_read_seq));
    end if;
    return null;
  end if;

  -- Joins and leaves. A DM appears with its first message instead, and a
  -- deleted account has nobody left to tell.
  if v_type = 'DIRECT' or not exists (select 1 from public.profiles p where p.id = v_row.profile_id) then
    return null;
  end if;
  perform app.chat_send('user:' || v_row.profile_id || ':chat', 'inbox', jsonb_build_object(
    'channel_id', v_row.channel_id, 'reason', case when tg_op = 'INSERT' then 'joined' else 'left' end));
  return null;
end;
$$;

create trigger chat_participants_80_hints
  after insert or delete or update of last_read_seq, is_muted on public.chat_participants
  for each row execute function app.tg_chat_participants_hints();

-- -----------------------------------------------------------------------------
-- 9. Channels: rename / archive / club chat deleted
-- -----------------------------------------------------------------------------
create or replace function app.tg_chat_channels_hints()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform app.chat_send('chat:' || old.id, 'channel', jsonb_build_object('channel_id', old.id, 'reason', 'deleted'));
  else
    perform app.chat_send('chat:' || new.id, 'channel', jsonb_build_object(
      'channel_id', new.id,
      'reason', case when new.is_archived and not old.is_archived then 'archived' else 'updated' end));
  end if;
  return null;
end;
$$;

-- Only real changes: every message also updates this row (counters).
create trigger chat_channels_80_hints
  after update of title, is_archived on public.chat_channels
  for each row
  when (old.title is distinct from new.title or old.is_archived is distinct from new.is_archived)
  execute function app.tg_chat_channels_hints();

-- Club chats are announced when deleted. Event chats go with their event
-- (rare; clients drop them on the next inbox fetch), DMs with an account.
create trigger chat_channels_81_deleted
  after delete on public.chat_channels
  for each row
  when (old.type = 'CLUB')
  execute function app.tg_chat_channels_hints();

-- The daily archive job sends no hints (one subtransaction per channel).
create or replace function app.archive_finished_event_channels()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform set_config('rackethub.chat_bulk', 'on', true);
  update public.chat_channels c
     set is_archived = true
    from public.events e
   where c.type = 'EVENT' and c.event_id = e.id and not c.is_archived
     and (   e.end_time < now() - interval '7 days'
          or (e.status = 'CANCELLED' and e.cancelled_at < now() - interval '7 days'));
  get diagnostics v_count = row_count;
  perform set_config('rackethub.chat_bulk', 'off', true);
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Membership sync fixes (0800)
-- -----------------------------------------------------------------------------
-- Deleting a club cascades to its channel (and so its participants). Skip the
-- per-member deletes then: one statement per member would be pure overhead.
create or replace function app.tg_club_members_sync_chat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.chat_participants (channel_id, profile_id)
    select c.id, new.profile_id from public.chat_channels c
     where c.type = 'CLUB' and c.club_id = new.club_id
    on conflict do nothing;
  elsif exists (select 1 from public.clubs c where c.id = old.club_id) then
    delete from public.chat_participants p
     using public.chat_channels c
     where c.type = 'CLUB' and c.club_id = old.club_id
       and p.channel_id = c.id and p.profile_id = old.profile_id;
  end if;
  return null;
end;
$$;

-- A replaced organiser or coach leaves the event chat unless they still hold
-- a seat or the other role.
create or replace function app.tg_events_sync_chat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel_id uuid;
begin
  if tg_op = 'INSERT' then
    insert into public.chat_channels (type, event_id, title)
    values ('EVENT', new.id, new.title)
    returning id into v_channel_id;

    insert into public.chat_participants (channel_id, profile_id)
    select v_channel_id, x.profile_id
      from (select new.organizer_id as profile_id
            union select new.coach_id
            union select a.profile_id from public.event_attendees a
                   where a.event_id = new.id and a.status in ('REGISTERED', 'CHECKED_IN')) x
     where x.profile_id is not null
    on conflict do nothing;
    return null;
  end if;

  select c.id into v_channel_id from public.chat_channels c where c.type = 'EVENT' and c.event_id = new.id;
  if v_channel_id is null then
    return null;
  end if;
  insert into public.chat_participants (channel_id, profile_id)
  select v_channel_id, x.profile_id
    from (select new.organizer_id as profile_id union select new.coach_id) x
   where x.profile_id is not null
  on conflict do nothing;

  delete from public.chat_participants p
   where p.channel_id = v_channel_id
     and p.profile_id in (old.organizer_id, old.coach_id)
     and p.profile_id is distinct from new.organizer_id
     and p.profile_id is distinct from new.coach_id
     and not exists (select 1 from public.event_attendees a
                      where a.event_id = new.id and a.profile_id = p.profile_id
                        and a.status in ('REGISTERED', 'CHECKED_IN'));

  if new.title is distinct from old.title then
    update public.chat_channels set title = new.title where id = v_channel_id;
  end if;
  return null;
end;
$$;

create or replace function app.tg_event_attendees_sync_chat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id  uuid := coalesce(new.event_id, old.event_id);
  v_profile   uuid := coalesce(new.profile_id, old.profile_id);
  v_had_seat  boolean := tg_op <> 'INSERT' and old.status in ('REGISTERED', 'CHECKED_IN');
  v_has_seat  boolean := tg_op <> 'DELETE' and new.status in ('REGISTERED', 'CHECKED_IN');
begin
  if v_has_seat and not v_had_seat then
    insert into public.chat_participants (channel_id, profile_id)
    select c.id, v_profile from public.chat_channels c where c.type = 'EVENT' and c.event_id = v_event_id
    on conflict do nothing;
  elsif v_had_seat and not v_has_seat then
    -- Organisers and coaches keep their seat in the chat. A deleted event
    -- takes its channel (and participants) with it.
    delete from public.chat_participants p
     using public.chat_channels c, public.events e
     where c.type = 'EVENT' and c.event_id = v_event_id and e.id = v_event_id
       and p.channel_id = c.id and p.profile_id = v_profile
       and v_profile is distinct from e.organizer_id
       and v_profile is distinct from e.coach_id;
  end if;
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 11. Direct messages: opening is private until the first message
-- -----------------------------------------------------------------------------
create or replace function public.get_or_create_direct_channel(p_other_profile_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me          uuid := auth.uid();
  v_low         uuid;
  v_high        uuid;
  v_channel_id  uuid;
begin
  if v_me is null then
    raise exception using errcode = '42501', message = 'Sign in to send messages.';
  end if;
  if p_other_profile_id is null or p_other_profile_id = v_me then
    raise exception using errcode = '22023', message = 'Pick someone else to message.';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_other_profile_id) then
    raise exception using errcode = 'P0002', message = 'That player does not exist.';
  end if;

  v_low  := least(v_me, p_other_profile_id);
  v_high := greatest(v_me, p_other_profile_id);

  select c.id into v_channel_id
    from public.chat_channels c
   where c.type = 'DIRECT' and c.dm_profile_low = v_low and c.dm_profile_high = v_high;

  if v_channel_id is null then
    -- Either side's block stops a new thread. An existing one still opens
    -- (to read it, or to unblock), but sending is refused.
    if exists (select 1 from public.profile_blocks b
                where (b.blocker_id = v_me and b.blocked_id = p_other_profile_id)
                   or (b.blocker_id = p_other_profile_id and b.blocked_id = v_me)) then
      raise exception using errcode = '42501',
        message = 'MESSAGING_UNAVAILABLE: You can''t send messages to this player.';
    end if;
    -- Race-safe get-or-create: concurrent callers converge on one row.
    insert into public.chat_channels (type, dm_profile_low, dm_profile_high)
    values ('DIRECT', v_low, v_high)
    on conflict (dm_profile_low, dm_profile_high) where type = 'DIRECT' do nothing
    returning id into v_channel_id;
    if v_channel_id is null then
      select c.id into v_channel_id
        from public.chat_channels c
       where c.type = 'DIRECT' and c.dm_profile_low = v_low and c.dm_profile_high = v_high;
    end if;
  end if;

  -- Only the opener joins now; the other person joins with the first message.
  insert into public.chat_participants (channel_id, profile_id)
  values (v_channel_id, v_me)
  on conflict do nothing;

  return v_channel_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 12. Send (SECURITY INVOKER: RLS + the guard decide)
-- -----------------------------------------------------------------------------
create or replace function public.send_chat_message(
  p_channel_id    uuid,
  p_client_id     uuid,
  p_text          text    default null,
  p_media_path    text    default null,
  p_reply_to_id   uuid    default null,
  p_media_width   integer default null,
  p_media_height  integer default null
)
returns public.chat_messages
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_row  public.chat_messages;
begin
  if v_me is null then
    raise exception using errcode = '42501', message = 'NOT_A_PARTICIPANT: Sign in to send messages.';
  end if;
  if p_channel_id is null or p_client_id is null then
    raise exception using errcode = '22023', message = 'A conversation and a message key are required.';
  end if;

  -- Same key from this sender: one at a time, then a lookup. A retry after a
  -- lost response returns the message the first attempt created.
  perform pg_advisory_xact_lock(hashtextextended('rackethub:chat-idem:' || v_me::text || ':' || p_client_id::text, 0));
  select * into v_row from public.chat_messages m where m.sender_id = v_me and m.client_id = p_client_id;

  if not found then
    begin
      insert into public.chat_messages (channel_id, client_id, message_text, media_url, reply_to_id, media_width, media_height)
      values (p_channel_id, p_client_id, p_text, p_media_path, p_reply_to_id, p_media_width, p_media_height)
      returning * into v_row;
      return v_row;
    exception when unique_violation then
      -- A twin committed between the lookup and the insert (the advisory lock
      -- makes this rare). Any other unique violation is re-raised.
      select * into v_row from public.chat_messages m where m.sender_id = v_me and m.client_id = p_client_id;
      if not found then
        raise;
      end if;
    end;
  end if;

  -- Replay: the same message, unless it was edited or deleted since.
  if v_row.channel_id <> p_channel_id
     or (v_row.deleted_at is null and v_row.edited_at is null
         and (   v_row.message_text is distinct from nullif(btrim(p_text, E' \t\r\n'), '')
              or v_row.media_url    is distinct from p_media_path
              or v_row.reply_to_id  is distinct from p_reply_to_id)) then
    raise exception using errcode = '22023',
      message = 'IDEMPOTENCY_KEY_REUSED: This message key was already used for a different message.';
  end if;
  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- 13. Read markers
-- -----------------------------------------------------------------------------
-- p_up_to_seq is required: the client passes the highest seq it actually
-- showed (or the last_seq of a fully rendered page), never "whatever is
-- latest", so a message arriving as the user leaves is still unread.
create or replace function public.mark_chat_read(p_channel_id uuid, p_up_to_seq bigint)
returns table (channel_id uuid, last_read_seq bigint, unread_count bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me    uuid := auth.uid();
  v_last  bigint;
  v_seq   bigint;
begin
  if v_me is null then
    raise exception using errcode = '42501', message = 'NOT_A_PARTICIPANT: Sign in to read messages.';
  end if;
  if p_channel_id is null or p_up_to_seq is null or p_up_to_seq < 0 then
    raise exception using errcode = '22023', message = 'A conversation and a message position are required.';
  end if;
  -- No row lock on the channel (lock order: channel before participant).
  select c.last_seq into v_last from public.chat_channels c where c.id = p_channel_id;
  update public.chat_participants p
     set last_read_seq = greatest(p.last_read_seq, least(p_up_to_seq, coalesce(v_last, 0))),
         last_read_at  = case when least(p_up_to_seq, coalesce(v_last, 0)) > p.last_read_seq then now()
                              else p.last_read_at end
   where p.channel_id = p_channel_id and p.profile_id = v_me
  returning p.last_read_seq into v_seq;
  if not found then
    raise exception using errcode = '42501', message = 'NOT_A_PARTICIPANT: You''re not in this conversation.';
  end if;
  return query select p_channel_id, v_seq, greatest(coalesce(v_last, 0) - v_seq, 0);
end;
$$;

-- Badge for the chat tab: unread messages and conversations, muted and closed
-- ones excluded. (Counts include deleted messages and, in groups, messages
-- from people the reader blocked; the client hides those.)
create or replace function public.get_chat_unread_summary()
returns table (unread_messages bigint, unread_channels bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(greatest(c.last_seq - p.last_read_seq, 0)), 0)::bigint,
         count(*) filter (where c.last_seq > p.last_read_seq)::bigint
    from public.chat_participants p
    join public.chat_channels c on c.id = p.channel_id
   where p.profile_id = auth.uid()
     and not p.is_muted
     and not c.is_archived;
$$;

-- -----------------------------------------------------------------------------
-- 14. Inbox (SECURITY DEFINER, restricted to the caller's own channels)
-- -----------------------------------------------------------------------------
create or replace function public.get_chat_inbox(
  p_limit            integer     default 30,
  p_before_activity  timestamptz default null,
  p_before_channel   uuid        default null,
  p_archived         boolean     default false,
  p_channel_ids      uuid[]      default null
)
returns table (
  channel_id               uuid,
  channel_type             public.channel_type,
  title                    text,
  image_url                text,
  club_id                  uuid,
  event_id                 uuid,
  event_start_time         timestamptz,
  event_status             public.event_status,
  partner_id               uuid,
  partner_last_read_seq    bigint,
  is_archived              boolean,
  is_muted                 boolean,
  can_send                 boolean,
  blocked_by_me            boolean,
  last_seq                 bigint,
  last_read_seq            bigint,
  unread_count             bigint,
  activity_at              timestamptz,
  last_message_id          uuid,
  last_message_seq         bigint,
  last_message_sender_id   uuid,
  last_message_sender_name text,
  last_message_snippet     text,
  last_message_media_kind  text,
  last_message_is_deleted  boolean,
  last_message_created_at  timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
rows 30
as $$
#variable_conflict use_column
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception using errcode = '42501', message = 'Sign in to see your chats.';
  end if;
  if (p_before_activity is null) <> (p_before_channel is null) then
    raise exception using errcode = '22023', message = 'Pass both cursor fields or neither.';
  end if;
  if p_channel_ids is not null and cardinality(p_channel_ids) > 50 then
    raise exception using errcode = '22023', message = 'Ask for at most 50 conversations at a time.';
  end if;

  return query
  with page as materialized (
    select c.id, c.type, c.title, c.club_id, c.event_id, c.dm_profile_low, c.dm_profile_high,
           c.is_archived, c.last_seq, p.is_muted, p.last_read_seq,
           greatest(coalesce(c.last_message_at, c.created_at), p.joined_at) as activity_at
      from public.chat_participants p
      join public.chat_channels c on c.id = p.channel_id
     where p.profile_id = v_me
       and (p_channel_ids is null or c.id = any (p_channel_ids))
       and (p_channel_ids is not null or c.is_archived = coalesce(p_archived, false))
       and not (c.type = 'DIRECT' and c.last_seq = 0)   -- an unsent DM isn't a conversation yet
       and (p_before_activity is null
            or (greatest(coalesce(c.last_message_at, c.created_at), p.joined_at), c.id)
               < (p_before_activity, p_before_channel))
     order by 12 desc, c.id desc
     limit least(greatest(coalesce(p_limit, 30), 1), 50)
  )
  select pg.id,
         pg.type,
         case pg.type when 'CLUB'  then cl.name
                      when 'EVENT' then ev.title
                      else coalesce(pp.display_name, pp.full_name) end,
         case pg.type when 'CLUB'  then cl.logo_url
                      when 'DIRECT' then pp.avatar_url end,
         pg.club_id,
         pg.event_id,
         ev.start_time,
         ev.status,
         partner.id,
         case when bl.any_block then null else pm.last_read_seq end,
         pg.is_archived,
         pg.is_muted,
         not pg.is_archived and not coalesce(bl.any_block, false),
         coalesce(bl.by_me, false),
         pg.last_seq,
         pg.last_read_seq,
         greatest(pg.last_seq - pg.last_read_seq, 0),
         pg.activity_at,
         lm.id,
         lm.seq,
         lm.sender_id,
         coalesce(sp.display_name, sp.full_name),
         case when lm.deleted_at is null then left(lm.message_text, 140) end,
         lm.media_kind,
         lm.deleted_at is not null,
         lm.created_at
    from page pg
    left join lateral (
      select m.id, m.seq, m.sender_id, m.message_text, m.media_kind, m.deleted_at, m.created_at
        from public.chat_messages m
       where m.channel_id = pg.id
       order by m.seq desc
       limit 1
    ) lm on true
    left join public.profiles sp on sp.id = lm.sender_id
    left join public.clubs    cl on cl.id = pg.club_id
    left join public.events   ev on ev.id = pg.event_id
    left join lateral (
      select case when pg.dm_profile_low = v_me then pg.dm_profile_high else pg.dm_profile_low end as id
       where pg.type = 'DIRECT'
    ) partner on true
    left join public.profiles pp on pp.id = partner.id
    left join public.chat_participants pm on pm.channel_id = pg.id and pm.profile_id = partner.id
    left join lateral (
      select bool_or(b.blocker_id = v_me) as by_me, count(*) > 0 as any_block
        from public.profile_blocks b
       where partner.id is not null
         and ((b.blocker_id = v_me and b.blocked_id = partner.id)
              or (b.blocker_id = partner.id and b.blocked_id = v_me))
    ) bl on true
   order by pg.activity_at desc, pg.id desc;
end;
$$;

-- -----------------------------------------------------------------------------
-- 15. Messages (SECURITY INVOKER: RLS decides; one snapshot for rows + cursor)
-- -----------------------------------------------------------------------------
-- Exactly one mode:
--   (none)        latest page             seq descending, returned ascending
--   p_before_seq  older history           seq < before
--   p_after_seq   newer history / unread  seq > after, ascending
--   p_after_rev   catch-up sync           rev > after, ascending by rev
-- last_seq / last_rev come from the same snapshot as the rows: seed the sync
-- cursor with the FIRST page's last_rev and never move it from older pages.
create or replace function public.get_chat_messages(
  p_channel_id  uuid,
  p_before_seq  bigint  default null,
  p_after_seq   bigint  default null,
  p_after_rev   bigint  default null,
  p_limit       integer default 50
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_chan   record;
  v_ids    uuid[];
  v_more   boolean;
  v_rows   jsonb;
begin
  if num_nonnulls(p_before_seq, p_after_seq, p_after_rev) > 1 then
    raise exception using errcode = '22023', message = 'Choose one of before_seq, after_seq or after_rev.';
  end if;
  select c.id, c.last_seq, c.last_rev into v_chan from public.chat_channels c where c.id = p_channel_id;
  if not found then
    raise exception using errcode = '42501', message = 'NOT_A_PARTICIPANT: You''re not in this conversation.';
  end if;

  if p_after_rev is not null then
    select array_agg(x.id order by x.rev) into v_ids from (
      select m.id, m.rev from public.chat_messages m
       where m.channel_id = p_channel_id and m.rev > p_after_rev
       order by m.rev limit v_limit + 1) x;
  elsif p_after_seq is not null then
    select array_agg(x.id order by x.seq) into v_ids from (
      select m.id, m.seq from public.chat_messages m
       where m.channel_id = p_channel_id and m.seq > p_after_seq
       order by m.seq limit v_limit + 1) x;
  else
    select array_agg(x.id order by x.seq desc) into v_ids from (
      select m.id, m.seq from public.chat_messages m
       where m.channel_id = p_channel_id and (p_before_seq is null or m.seq < p_before_seq)
       order by m.seq desc limit v_limit + 1) x;
  end if;

  v_ids  := coalesce(v_ids, '{}');
  v_more := cardinality(v_ids) > v_limit;
  v_ids  := v_ids[1:v_limit];

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'channel_id', m.channel_id,
           'seq', m.seq,
           'rev', m.rev,
           'client_id', case when m.sender_id = v_me then m.client_id end,
           'sender', case when m.sender_id is null then null
                          else jsonb_build_object('id', s.id, 'name', coalesce(s.display_name, s.full_name),
                                                  'avatar_url', s.avatar_url) end,
           'text', m.message_text,
           'media', case when m.media_url is null then null
                         else jsonb_build_object('path', m.media_url, 'kind', m.media_kind,
                                                 'width', m.media_width, 'height', m.media_height) end,
           'reply_to', case when m.reply_to_id is null then null
                            else jsonb_build_object(
                              'id', r.id, 'seq', r.seq, 'sender_id', r.sender_id,
                              'sender_name', coalesce(rs.display_name, rs.full_name),
                              'snippet', case when r.deleted_at is null then left(r.message_text, 140) end,
                              'media_kind', r.media_kind,
                              'is_deleted', r.deleted_at is not null) end,
           'created_at', m.created_at,
           'edited_at', m.edited_at,
           'deleted_at', m.deleted_at,
           'deleted_by_moderator', m.deleted_at is not null and m.deleted_by is distinct from m.sender_id)
         order by case when p_after_rev is not null then m.rev else m.seq end), '[]'::jsonb)
    into v_rows
    from public.chat_messages m
    left join public.profiles s       on s.id = m.sender_id
    left join public.chat_messages r  on r.id = m.reply_to_id
    left join public.profiles rs      on rs.id = r.sender_id
   where m.id = any (v_ids);

  return jsonb_build_object(
    'channel_id', p_channel_id,
    'last_seq', v_chan.last_seq,
    'last_rev', v_chan.last_rev,
    'has_more', v_more,
    'messages', v_rows);
end;
$$;

-- Members of a conversation (participants and moderators may list), keyset by
-- profile id. No read markers or mute state: those are private.
create or replace function public.list_chat_participants(
  p_channel_id     uuid,
  p_after_profile  uuid    default null,
  p_limit          integer default 100
)
returns table (profile_id uuid, display_name text, avatar_url text, role text, joined_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (app.is_channel_participant(p_channel_id) or app.is_channel_moderator(p_channel_id)) then
    raise exception using errcode = '42501', message = 'NOT_A_PARTICIPANT: You''re not in this conversation.';
  end if;
  return query
  select p.profile_id,
         coalesce(pr.display_name, pr.full_name),
         pr.avatar_url,
         case when e.organizer_id = p.profile_id then 'ORGANIZER'
              when e.coach_id = p.profile_id then 'COACH'
              when cm.role = 'ADMIN' then 'ADMIN'
              else 'MEMBER' end,
         p.joined_at
    from public.chat_participants p
    join public.chat_channels c on c.id = p.channel_id
    join public.profiles pr on pr.id = p.profile_id
    left join public.events e on e.id = c.event_id
    left join public.club_members cm on cm.club_id = c.club_id and cm.profile_id = p.profile_id
   where p.channel_id = p_channel_id
     and (p_after_profile is null or p.profile_id > p_after_profile)
   order by p.profile_id
   limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

-- -----------------------------------------------------------------------------
-- 16. Reports
-- -----------------------------------------------------------------------------
create or replace function public.report_chat_message(
  p_message_id  uuid,
  p_reason      public.chat_report_reason,
  p_note        text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me   uuid := auth.uid();
  v_msg  public.chat_messages;
  v_id   uuid;
begin
  if v_me is null then
    raise exception using errcode = '42501', message = 'Sign in to report a message.';
  end if;
  select * into v_msg from public.chat_messages m where m.id = p_message_id;
  -- Same answer whether the message doesn't exist or isn't visible to you.
  if not found or not (app.is_channel_participant(v_msg.channel_id) or app.is_channel_moderator(v_msg.channel_id)) then
    raise exception using errcode = '42501', message = 'NOT_A_PARTICIPANT: You can''t report this message.';
  end if;
  if v_msg.sender_id = v_me then
    raise exception using errcode = '22023', message = 'You can''t report your own message.';
  end if;
  if p_reason is null then
    raise exception using errcode = '22023', message = 'Choose a reason.';
  end if;

  insert into public.chat_reports (reporter_id, message_id, channel_id, reported_profile_id, reason, note,
                                   snapshot_text, snapshot_media_path)
  values (v_me, v_msg.id, v_msg.channel_id, v_msg.sender_id, p_reason, nullif(btrim(p_note), ''),
          v_msg.message_text, v_msg.media_url)
  on conflict (reporter_id, message_id) where reporter_id is not null and message_id is not null do nothing
  returning id into v_id;
  if v_id is null then
    select r.id into v_id from public.chat_reports r where r.reporter_id = v_me and r.message_id = v_msg.id;
  end if;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 17. Media purge (service role job)
-- -----------------------------------------------------------------------------
-- Paths to remove through the Storage API: media of deleted messages, and
-- uploads never sent after a day. Paths an open report holds are kept as
-- evidence. Idempotent: a path claimed twice is removed twice, harmlessly.
create or replace function public.claim_chat_media_purge(p_limit integer default 100)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  (select q.path
     from app.chat_media_purge q
    where not app.chat_media_is_live(q.path)
      and not exists (select 1 from public.chat_reports r where r.snapshot_media_path = q.path and r.status = 'OPEN')
    order by q.queued_at
    limit least(greatest(coalesce(p_limit, 100), 1), 1000));
  if to_regclass('storage.objects') is not null then
    return query execute $q$
      select o.name
        from storage.objects o
       where o.bucket_id = 'chat-media'
         and o.created_at < now() - interval '1 day'
         and not exists (select 1 from public.chat_messages m where m.media_url = o.name)
         and not exists (select 1 from app.chat_media_purge q where q.path = o.name)
         and not exists (select 1 from public.chat_reports r where r.snapshot_media_path = o.name and r.status = 'OPEN')
       order by o.created_at
       limit $1 $q$
    using least(greatest(coalesce(p_limit, 100), 1), 1000);
  end if;
end;
$$;

create or replace function public.complete_chat_media_purge(p_paths text[])
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (delete from app.chat_media_purge q where q.path = any (p_paths) returning 1)
  select count(*)::integer from gone;
$$;

-- -----------------------------------------------------------------------------
-- 18. RLS and privileges
-- -----------------------------------------------------------------------------
-- Ex-members can still find (and delete) their own messages.
drop policy "chat_messages: participants and moderators read" on public.chat_messages;
create policy "chat_messages: participants, moderators and the sender read"
  on public.chat_messages for select to authenticated
  using (app.is_channel_participant(channel_id) or app.is_channel_moderator(channel_id)
         or sender_id = (select auth.uid()));

-- Co-members see who is in a chat, not when each person last read it or
-- whether they muted it (get_chat_inbox returns the caller's own state and,
-- in DMs, the partner's marker).
revoke select on public.chat_participants from authenticated;
grant select (channel_id, profile_id, joined_at) on public.chat_participants to authenticated;
grant update (last_read_seq) on public.chat_participants to authenticated;

-- Message columns stay as granted in 0900 (message_text, deleted_at). The new
-- ones are server-owned.

revoke all on public.profile_blocks, public.chat_reports from anon;
revoke update, truncate, references, trigger on public.profile_blocks from authenticated;
revoke insert on public.profile_blocks from authenticated;
grant insert (blocker_id, blocked_id) on public.profile_blocks to authenticated;
revoke insert, delete, truncate, references, trigger on public.chat_reports from authenticated;
revoke update on public.chat_reports from authenticated;
grant update (status, resolution_note) on public.chat_reports to authenticated;
revoke all on app.chat_media_purge from public, anon, authenticated;

-- Storage: media of deleted messages stops being readable at once; a sent
-- object can't be deleted and re-uploaded with other content.
drop policy "chat-media: participants read" on storage.objects;
create policy "chat-media: participants read live media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-media'
    and (app.is_channel_participant(app.try_uuid((storage.foldername(name))[1]))
         or app.is_channel_moderator(app.try_uuid((storage.foldername(name))[1])))
    and ((storage.foldername(name))[2] = (select auth.uid())::text or app.chat_media_is_live(name))
  );

drop policy "chat-media: participants upload into their own sender folder" on storage.objects;
create policy "chat-media: participants upload into their own sender folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif|mp4)$'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and app.is_channel_participant(app.try_uuid((storage.foldername(name))[1]))
    and not app.dm_is_blocked(app.try_uuid((storage.foldername(name))[1]))
  );

drop policy "chat-media: sender deletes own uploads" on storage.objects;
create policy "chat-media: uploader deletes unsent uploads"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'chat-media'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and not app.chat_media_is_live(name)
  );

-- -----------------------------------------------------------------------------
-- 19. Realtime: leave Postgres Changes; topic policies for Broadcast
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['chat_messages', 'chat_participants'] loop
    if exists (select 1 from pg_publication_tables
                where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end;
$$;

-- Topic ids are matched exactly (anchored regex, try_uuid), so a malformed
-- topic is simply denied and other topics' joins can't error here.
do $$
begin
  if to_regclass('realtime.messages') is null then
    raise warning 'realtime.messages not found; skipping chat topic policies. Chat will not receive live updates.';
    return;
  end if;
  execute 'drop policy if exists "chat topics: members receive" on realtime.messages';
  execute 'drop policy if exists "chat typing: members send" on realtime.messages';
  execute 'drop policy if exists "user chat topic: owner receives" on realtime.messages';

  execute $p$
    create policy "chat topics: members receive"
      on realtime.messages for select to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and realtime.topic() ~ '^chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:typing)?$'
        and (
          (realtime.topic() !~ ':typing$'
           and (app.is_channel_participant(app.try_uuid(substr(realtime.topic(), 6, 36)))
                or app.is_channel_moderator(app.try_uuid(substr(realtime.topic(), 6, 36)))))
          or (realtime.topic() ~ ':typing$'
              and app.is_channel_participant(app.try_uuid(substr(realtime.topic(), 6, 36)))
              and not app.dm_is_blocked(app.try_uuid(substr(realtime.topic(), 6, 36))))
        )
      )
  $p$;

  -- The only client-sendable chat topic. chat:<id> itself has no INSERT
  -- policy, so nobody can forge message/read/channel events.
  execute $p$
    create policy "chat typing: members send"
      on realtime.messages for insert to authenticated
      with check (
        realtime.messages.extension = 'broadcast'
        and realtime.topic() ~ '^chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:typing$'
        and app.is_channel_participant(app.try_uuid(substr(realtime.topic(), 6, 36)))
        and not app.dm_is_blocked(app.try_uuid(substr(realtime.topic(), 6, 36)))
      )
  $p$;

  execute $p$
    create policy "user chat topic: owner receives"
      on realtime.messages for select to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and realtime.topic() = 'user:' || (select auth.uid())::text || ':chat'
      )
  $p$;
end;
$$;

-- -----------------------------------------------------------------------------
-- 20. Function privileges
-- -----------------------------------------------------------------------------
-- Helpers the INVOKER guard, policies and RPCs call as the user.
grant execute on function app.dm_is_blocked(uuid)        to authenticated, service_role;
grant execute on function app.chat_media_is_live(text)   to authenticated, service_role;
grant execute on function app.chat_media_mimetype(text)  to authenticated, service_role;
grant execute on function app.chat_rate_status(uuid)     to authenticated, service_role;
grant execute on function app.chat_edit_window()         to authenticated, service_role;
grant execute on function app.chat_rate_limit_count()    to authenticated, service_role;
grant execute on function app.chat_rate_limit_window()   to authenticated, service_role;

revoke all on function public.send_chat_message(uuid, uuid, text, text, uuid, integer, integer) from public, anon;
revoke all on function public.mark_chat_read(uuid, bigint)                                     from public, anon;
revoke all on function public.get_chat_unread_summary()                                        from public, anon;
revoke all on function public.get_chat_inbox(integer, timestamptz, uuid, boolean, uuid[])      from public, anon;
revoke all on function public.get_chat_messages(uuid, bigint, bigint, bigint, integer)         from public, anon;
revoke all on function public.list_chat_participants(uuid, uuid, integer)                      from public, anon;
revoke all on function public.report_chat_message(uuid, public.chat_report_reason, text)       from public, anon;
revoke all on function public.claim_chat_media_purge(integer)                                  from public, anon, authenticated;
revoke all on function public.complete_chat_media_purge(text[])                                from public, anon, authenticated;

grant execute on function public.send_chat_message(uuid, uuid, text, text, uuid, integer, integer) to authenticated, service_role;
grant execute on function public.mark_chat_read(uuid, bigint)                                     to authenticated, service_role;
grant execute on function public.get_chat_unread_summary()                                        to authenticated, service_role;
grant execute on function public.get_chat_inbox(integer, timestamptz, uuid, boolean, uuid[])      to authenticated, service_role;
grant execute on function public.get_chat_messages(uuid, bigint, bigint, bigint, integer)         to authenticated, service_role;
grant execute on function public.list_chat_participants(uuid, uuid, integer)                      to authenticated, service_role;
grant execute on function public.report_chat_message(uuid, public.chat_report_reason, text)       to authenticated, service_role;
grant execute on function public.claim_chat_media_purge(integer)                                  to service_role;
grant execute on function public.complete_chat_media_purge(text[])                                to service_role;

-- Close the PUBLIC execute default on everything this migration defined in app.*
-- (the explicit grants above are to roles, so they survive).
revoke execute on all functions in schema app from public;
