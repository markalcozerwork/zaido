-- =============================================================================
-- RacketHub · 0800 · 3-tier real-time messaging: CLUB · EVENT · DIRECT
-- =============================================================================
-- Channel membership is DERIVED, not self-service:
--   CLUB   → one per club, created with the club. Participants mirror club_members.
--   EVENT  → one per event, created with the event. Participants are the
--            organiser, the coach, and attendees holding a seat (REGISTERED /
--            CHECKED_IN). Waitlisted and cancelled players are removed.
--   DIRECT → one per unordered pair of people, created on demand via
--            get_or_create_direct_channel(). The pair is stored in canonical
--            order (low < high) behind a unique index, so two people can never
--            end up with two DM threads.
--
-- RLS on chat_messages then reduces to "is the caller a participant of the
-- channel?", a primary-key lookup. Supabase Realtime evaluates that same
-- policy for each subscriber, so the same rule covers live delivery.
-- =============================================================================

create table public.chat_channels (
  id               uuid primary key default gen_random_uuid(),
  type             public.channel_type not null,
  club_id          uuid references public.clubs (id) on delete cascade,
  event_id         uuid references public.events (id) on delete cascade,
  dm_profile_low   uuid references public.profiles (id) on delete cascade,
  dm_profile_high  uuid references public.profiles (id) on delete cascade,
  title            text,
  is_archived      boolean not null default false,
  last_message_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Exactly the right parent for each channel type.
  constraint chat_channels_shape check (
    case type
      when 'CLUB'   then club_id is not null and event_id is null
                         and dm_profile_low is null and dm_profile_high is null
      when 'EVENT'  then event_id is not null and club_id is null
                         and dm_profile_low is null and dm_profile_high is null
      when 'DIRECT' then dm_profile_low is not null and dm_profile_high is not null
                         and dm_profile_low < dm_profile_high
                         and club_id is null and event_id is null
    end
  ),
  constraint chat_channels_title_length check (title is null or char_length(title) <= 80)
);

create unique index chat_channels_club_key   on public.chat_channels (club_id)  where type = 'CLUB';
create unique index chat_channels_event_key  on public.chat_channels (event_id) where type = 'EVENT';
create unique index chat_channels_direct_key on public.chat_channels (dm_profile_low, dm_profile_high) where type = 'DIRECT';
create index chat_channels_dm_high_idx       on public.chat_channels (dm_profile_high) where type = 'DIRECT';

create trigger chat_channels_set_updated_at
  before update on public.chat_channels
  for each row execute function app.tg_set_updated_at();

alter table public.chat_channels enable row level security;

-- -----------------------------------------------------------------------------
create table public.chat_participants (
  channel_id    uuid not null references public.chat_channels (id) on delete cascade,
  profile_id    uuid not null references public.profiles (id) on delete cascade,
  last_read_at  timestamptz not null default now(),
  is_muted      boolean not null default false,
  joined_at     timestamptz not null default now(),
  primary key (channel_id, profile_id)
);

-- "My inbox": every channel I'm in.
create index chat_participants_profile_idx on public.chat_participants (profile_id, channel_id);

alter table public.chat_participants enable row level security;

-- -----------------------------------------------------------------------------
create table public.chat_messages (
  id            uuid primary key default gen_random_uuid(),
  channel_id    uuid not null references public.chat_channels (id) on delete cascade,
  sender_id     uuid references public.profiles (id) on delete set null,
  message_text  text,
  media_url     text,     -- object path in the private `chat-media` bucket
  reply_to_id   uuid references public.chat_messages (id) on delete set null,
  edited_at     timestamptz,
  deleted_at    timestamptz,
  deleted_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),

  constraint chat_messages_has_content check (
    deleted_at is not null
    or nullif(btrim(coalesce(message_text, '')), '') is not null
    or media_url is not null
  ),
  constraint chat_messages_text_length check (message_text is null or char_length(message_text) <= 4000)
);

-- Pagination: newest first within a channel (keyset on created_at, id).
create index chat_messages_channel_created_idx on public.chat_messages (channel_id, created_at desc, id desc);
create index chat_messages_sender_idx          on public.chat_messages (sender_id);
create index chat_messages_reply_to_idx        on public.chat_messages (reply_to_id) where reply_to_id is not null;
create index chat_messages_deleted_by_idx      on public.chat_messages (deleted_by) where deleted_by is not null;

alter table public.chat_messages enable row level security;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function app.is_channel_participant(p_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.chat_participants p
     where p.channel_id = p_channel_id and p.profile_id = auth.uid()
  );
$$;

-- Club admins moderate club chat. Organisers, coaches and club admins
-- moderate event chat. DMs have no moderators.
create or replace function app.is_channel_moderator(p_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.chat_channels c
     where c.id = p_channel_id
       and (   (c.type = 'CLUB'  and app.is_club_admin(c.club_id))
            or (c.type = 'EVENT' and app.is_event_manager(c.event_id)))
  );
$$;

grant execute on function app.is_channel_participant(uuid) to authenticated, service_role;
grant execute on function app.is_channel_moderator(uuid)   to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Channel lifecycle (SECURITY DEFINER: end users never write channels or
-- participants directly)
-- -----------------------------------------------------------------------------
create or replace function app.tg_clubs_create_chat_channel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel_id uuid;
begin
  insert into public.chat_channels (type, club_id, title)
  values ('CLUB', new.id, new.name)
  returning id into v_channel_id;

  -- Backfill whoever is already a member, so the result doesn't depend on
  -- the order AFTER INSERT triggers fire in.
  insert into public.chat_participants (channel_id, profile_id)
  select v_channel_id, m.profile_id from public.club_members m where m.club_id = new.id
  on conflict do nothing;
  return null;
end;
$$;

create trigger clubs_create_chat_channel
  after insert on public.clubs
  for each row execute function app.tg_clubs_create_chat_channel();

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
  else
    delete from public.chat_participants p
     using public.chat_channels c
     where c.type = 'CLUB' and c.club_id = old.club_id
       and p.channel_id = c.id and p.profile_id = old.profile_id;
  end if;
  return null;
end;
$$;

create trigger club_members_sync_chat
  after insert or delete on public.club_members
  for each row execute function app.tg_club_members_sync_chat();

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
  else
    select c.id into v_channel_id from public.chat_channels c where c.type = 'EVENT' and c.event_id = new.id;
    insert into public.chat_participants (channel_id, profile_id)
    select v_channel_id, x.profile_id
      from (select new.organizer_id as profile_id union select new.coach_id) x
     where x.profile_id is not null and v_channel_id is not null
    on conflict do nothing;
    if new.title is distinct from old.title then
      update public.chat_channels set title = new.title where id = v_channel_id;
    end if;
  end if;
  return null;
end;
$$;

create trigger events_sync_chat
  after insert or update of organizer_id, coach_id, title on public.events
  for each row execute function app.tg_events_sync_chat();

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
    -- Organisers and coaches keep their seat in the chat.
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

create trigger event_attendees_sync_chat
  after insert or update of status or delete on public.event_attendees
  for each row execute function app.tg_event_attendees_sync_chat();

-- -----------------------------------------------------------------------------
-- Direct messages
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

  insert into public.chat_participants (channel_id, profile_id)
  values (v_channel_id, v_low), (v_channel_id, v_high)
  on conflict do nothing;

  return v_channel_id;
end;
$$;

revoke all on function public.get_or_create_direct_channel(uuid) from public;
grant execute on function public.get_or_create_direct_channel(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Message guard: sender identity, edit window, soft delete, moderation
-- -----------------------------------------------------------------------------
create or replace function app.tg_chat_messages_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_trusted boolean := app.is_trusted_context();
begin
  if tg_op = 'INSERT' then
    if not v_trusted then
      new.sender_id  := auth.uid();
      new.created_at := now();
      new.edited_at  := null;
      new.deleted_at := null;
      new.deleted_by := null;
    end if;
    if exists (select 1 from public.chat_channels c where c.id = new.channel_id and c.is_archived) then
      raise exception using errcode = '23514', message = 'This conversation is archived.';
    end if;
    if new.reply_to_id is not null and not exists (
      select 1 from public.chat_messages m where m.id = new.reply_to_id and m.channel_id = new.channel_id
    ) then
      raise exception using errcode = '23514', message = 'Replies must quote a message from the same conversation.';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.id <> old.id or new.channel_id <> old.channel_id or new.sender_id is distinct from old.sender_id
     or new.created_at <> old.created_at or new.reply_to_id is distinct from old.reply_to_id then
    raise exception using errcode = '42501', message = 'Only the message text can be edited.';
  end if;
  if old.deleted_at is not null then
    raise exception using errcode = '23514', message = 'Deleted messages cannot be changed.';
  end if;

  if new.deleted_at is not null then
    -- Soft delete: keep the row so threads and receipts stay intact, but
    -- drop the content.
    new.deleted_at   := now();
    new.deleted_by   := case when v_trusted then coalesce(new.deleted_by, auth.uid()) else auth.uid() end;
    new.message_text := null;
    new.media_url    := null;
    new.edited_at    := old.edited_at;
    if not v_trusted and old.sender_id is distinct from auth.uid()
       and not app.is_channel_moderator(old.channel_id) then
      raise exception using errcode = '42501', message = 'You can only delete your own messages.';
    end if;
    return new;
  end if;

  -- Edit
  if not v_trusted then
    if old.sender_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'You can only edit your own messages.';
    end if;
    if now() > old.created_at + interval '15 minutes' then
      raise exception using errcode = '23514', message = 'Messages can only be edited within 15 minutes.';
    end if;
    if new.media_url is distinct from old.media_url or new.deleted_by is distinct from old.deleted_by then
      raise exception using errcode = '42501', message = 'Only the message text can be edited.';
    end if;
  end if;
  if new.message_text is distinct from old.message_text then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

create trigger chat_messages_guard
  before insert or update on public.chat_messages
  for each row execute function app.tg_chat_messages_guard();

create or replace function app.tg_chat_messages_touch_channel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.chat_channels c
     set last_message_at = new.created_at
   where c.id = new.channel_id
     and (c.last_message_at is null or c.last_message_at < new.created_at);
  -- The sender has obviously read up to their own message.
  update public.chat_participants p
     set last_read_at = greatest(p.last_read_at, new.created_at)
   where p.channel_id = new.channel_id and p.profile_id = new.sender_id;
  return null;
end;
$$;

create trigger chat_messages_touch_channel
  after insert on public.chat_messages
  for each row execute function app.tg_chat_messages_touch_channel();

-- Archive EVENT channels a week after the event ends or is cancelled. They
-- stay readable but stop accepting new messages ("temporary" event chat).
create or replace function app.archive_finished_event_channels()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.chat_channels c
     set is_archived = true
    from public.events e
   where c.type = 'EVENT' and c.event_id = e.id and not c.is_archived
     and (   e.end_time < now() - interval '7 days'
          or (e.status = 'CANCELLED' and e.cancelled_at < now() - interval '7 days'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function app.archive_finished_event_channels() to service_role;

-- Close the PUBLIC execute default on everything this migration defined in app.*
revoke execute on all functions in schema app from public;
