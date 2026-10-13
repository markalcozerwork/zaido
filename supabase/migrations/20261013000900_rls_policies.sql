-- =============================================================================
-- RacketHub · 0900 · Row Level Security policies & privilege hardening
-- =============================================================================
-- Each table already has RLS enabled (deny-by-default) from its own
-- migration. This file adds every policy in one place so the access matrix
-- can be reviewed as a unit.
--
-- How the layers split the work:
--   * Policies answer "may this person touch this ROW at all?"
--   * Guard triggers answer "may this person make THIS change?" (state
--     machines, column-level rules), which RLS can't express.
--   * GRANTs remove whole capabilities (TRUNCATE, writes to system-managed
--     tables, columns that must never be client-written).
--
-- Policies call auth.uid() as `(select auth.uid())`, so Postgres evaluates it
-- once per statement (initPlan) instead of once per row.
-- Policies that anon can hit only call functions granted to anon.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Cross-domain helpers
-- -----------------------------------------------------------------------------

-- Who may read someone's phone / birth date / emergency contact (RA 10173:
-- the access must be proportionate to a legitimate purpose).
create or replace function app.can_view_contact(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
       p_profile_id = auth.uid()
    or app.is_platform_admin()
    -- A venue sees the contact details of people who booked with it.
    or exists (
         select 1
           from public.bookings b
           join public.venues v on v.id = b.venue_id
           left join public.venue_managers vm on vm.venue_id = v.id and vm.profile_id = auth.uid()
          where b.booked_by = p_profile_id
            and b.booking_status <> 'CANCELLED'
            and (v.owner_id = auth.uid() or vm.profile_id is not null))
    -- Coach ↔ student on a live booking.
    or exists (
         select 1 from public.bookings b
          where b.booking_status <> 'CANCELLED'
            and (   (b.coach_id = auth.uid() and b.booked_by = p_profile_id)
                 or (b.booked_by = auth.uid() and b.coach_id = p_profile_id)))
    -- Organisers (and coaches / club admins) of an event the person has an RSVP for.
    or exists (
         select 1 from public.event_attendees a
          where a.profile_id = p_profile_id
            and a.status in ('REGISTERED', 'CHECKED_IN', 'WAITLISTED')
            and app.is_event_manager(a.event_id))
  );
$$;

create or replace function app.is_court_owner(p_court_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.courts c join public.venues v on v.id = c.venue_id
     where c.id = p_court_id and v.owner_id = auth.uid()
  );
$$;

grant execute on function app.can_view_contact(uuid) to authenticated, service_role;
grant execute on function app.is_court_owner(uuid)   to authenticated, service_role;

-- =============================================================================
-- Reference data
-- =============================================================================
create policy "ph_regions: public read"        on public.ph_regions        for select to anon, authenticated using (true);
create policy "ph_provinces: public read"      on public.ph_provinces      for select to anon, authenticated using (true);
create policy "ph_municipalities: public read" on public.ph_municipalities for select to anon, authenticated using (true);
create policy "ph_barangays: public read"      on public.ph_barangays      for select to anon, authenticated using (true);

-- =============================================================================
-- Identity
-- =============================================================================
create policy "profiles: members can read"
  on public.profiles for select to authenticated
  using (true);

create policy "profiles: insert own"
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()) or app.is_platform_admin())
  with check (id = (select auth.uid()) or app.is_platform_admin());

create policy "profile_contacts: owner and legitimate counterparties read"
  on public.profile_contacts for select to authenticated
  using (app.can_view_contact(profile_id));

create policy "profile_contacts: insert own"
  on public.profile_contacts for insert to authenticated
  with check (profile_id = (select auth.uid()));

create policy "profile_contacts: update own"
  on public.profile_contacts for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

create policy "profile_contacts: delete own"
  on public.profile_contacts for delete to authenticated
  using (profile_id = (select auth.uid()));

create policy "platform_admins: self and admins read"
  on public.platform_admins for select to authenticated
  using (profile_id = (select auth.uid()) or app.is_platform_admin());

create policy "player_profiles: members can read"
  on public.player_profiles for select to authenticated
  using (true);

create policy "player_profiles: manage own"
  on public.player_profiles for all to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

create policy "coach_profiles: members can read"
  on public.coach_profiles for select to authenticated
  using (true);

create policy "coach_profiles: insert own"
  on public.coach_profiles for insert to authenticated
  with check (profile_id = (select auth.uid()));

create policy "coach_profiles: update own or admin"
  on public.coach_profiles for update to authenticated
  using (profile_id = (select auth.uid()) or app.is_platform_admin())
  with check (profile_id = (select auth.uid()) or app.is_platform_admin());

create policy "coach_profiles: delete own"
  on public.coach_profiles for delete to authenticated
  using (profile_id = (select auth.uid()));

create policy "coach_availability: members can read"
  on public.coach_availability for select to authenticated
  using (true);

create policy "coach_availability: coach manages own"
  on public.coach_availability for all to authenticated
  using (coach_id = (select auth.uid()))
  with check (coach_id = (select auth.uid()));

-- =============================================================================
-- Venues & courts
-- =============================================================================
create policy "venues: public read active"
  on public.venues for select to anon
  using (is_active);

-- owner_id is checked inline (not only via app.is_venue_manager) because
-- INSERT … RETURNING, the supabase-js `.insert().select()` pattern, evaluates
-- SELECT policies before the new row is visible to SECURITY DEFINER lookups.
-- The same applies to clubs.created_by and events.organizer_id below.
create policy "venues: members read active, staff read own"
  on public.venues for select to authenticated
  using (is_active or owner_id = (select auth.uid()) or app.is_venue_manager(id) or app.is_platform_admin());

create policy "venues: owners create"
  on public.venues for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "venues: owner updates"
  on public.venues for update to authenticated
  using (owner_id = (select auth.uid()) or app.is_platform_admin())
  with check (owner_id = (select auth.uid()) or app.is_platform_admin());

create policy "venues: owner deletes"
  on public.venues for delete to authenticated
  using (owner_id = (select auth.uid()) or app.is_platform_admin());

create policy "venue_managers: owner, the manager, admins read"
  on public.venue_managers for select to authenticated
  using (profile_id = (select auth.uid()) or app.is_venue_owner(venue_id) or app.is_platform_admin());

create policy "venue_managers: owner adds"
  on public.venue_managers for insert to authenticated
  with check (app.is_venue_owner(venue_id));

create policy "venue_managers: owner removes, manager resigns"
  on public.venue_managers for delete to authenticated
  using (app.is_venue_owner(venue_id) or profile_id = (select auth.uid()));

create policy "venue_operating_hours: public read"
  on public.venue_operating_hours for select to anon, authenticated
  using (exists (select 1 from public.venues v where v.id = venue_id));

create policy "venue_operating_hours: owner manages"
  on public.venue_operating_hours for all to authenticated
  using (app.is_venue_owner(venue_id))
  with check (app.is_venue_owner(venue_id));

create policy "courts: public read active"
  on public.courts for select to anon
  using (is_active and exists (select 1 from public.venues v where v.id = venue_id));

create policy "courts: members read active, staff read own"
  on public.courts for select to authenticated
  using ((is_active and exists (select 1 from public.venues v where v.id = venue_id))
         or app.is_venue_manager(venue_id));

create policy "courts: owner manages"
  on public.courts for all to authenticated
  using (app.is_venue_owner(venue_id))
  with check (app.is_venue_owner(venue_id));

create policy "court_rate_rules: public read"
  on public.court_rate_rules for select to anon, authenticated
  using (exists (select 1 from public.courts c where c.id = court_id));

create policy "court_rate_rules: owner manages"
  on public.court_rate_rules for all to authenticated
  using (app.is_court_owner(court_id))
  with check (app.is_court_owner(court_id));

-- =============================================================================
-- Bookings
-- =============================================================================
-- Other people's bookings are invisible. Availability comes from
-- public.get_court_busy_slots(), which exposes only time ranges.
create policy "bookings: booker, coach, venue staff read"
  on public.bookings for select to authenticated
  using (
       booked_by = (select auth.uid())
    or coach_id  = (select auth.uid())
    or app.is_venue_manager(venue_id)
    or app.is_platform_admin()
  );

create policy "bookings: book for yourself, or staff book walk-ins"
  on public.bookings for insert to authenticated
  with check (booked_by = (select auth.uid()) or app.is_venue_manager(venue_id));

create policy "bookings: booker and venue staff update"
  on public.bookings for update to authenticated
  using      (booked_by = (select auth.uid()) or app.is_venue_manager(venue_id) or app.is_platform_admin())
  with check (booked_by = (select auth.uid()) or app.is_venue_manager(venue_id) or app.is_platform_admin());
-- No DELETE policy: bookings are financial records. Cancel instead.

create policy "booking_status_history: visible with its booking"
  on public.booking_status_history for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id));

-- =============================================================================
-- Clubs
-- =============================================================================
create policy "clubs: public clubs are discoverable"
  on public.clubs for select to anon
  using (not is_private);

create policy "clubs: public or my clubs"
  on public.clubs for select to authenticated
  using (not is_private or created_by = (select auth.uid()) or app.is_club_member(id) or app.is_platform_admin());

create policy "clubs: anyone can start a club"
  on public.clubs for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy "clubs: admins update"
  on public.clubs for update to authenticated
  using (app.is_club_admin(id) or app.is_platform_admin())
  with check (app.is_club_admin(id) or app.is_platform_admin());

create policy "clubs: admins delete"
  on public.clubs for delete to authenticated
  using (app.is_club_admin(id) or app.is_platform_admin());

create policy "club_members: roster visible to members (or anyone, if public)"
  on public.club_members for select to authenticated
  using (
       profile_id = (select auth.uid())
    or app.is_club_member(club_id)
    or app.is_club_public(club_id)
    or app.is_platform_admin()
  );

create policy "club_members: join public clubs, admins add"
  on public.club_members for insert to authenticated
  with check (profile_id = (select auth.uid()) or app.is_club_admin(club_id));

create policy "club_members: admins change roles"
  on public.club_members for update to authenticated
  using (app.is_club_admin(club_id))
  with check (app.is_club_admin(club_id));

create policy "club_members: leave, or admins remove"
  on public.club_members for delete to authenticated
  using (profile_id = (select auth.uid()) or app.is_club_admin(club_id));

-- =============================================================================
-- Events
-- =============================================================================
create policy "events: public events are discoverable"
  on public.events for select to anon
  using (app.can_view_event(id));

create policy "events: visible per club/privacy rules"
  on public.events for select to authenticated
  using (
       organizer_id = (select auth.uid())
    or coach_id     = (select auth.uid())
    or app.can_view_event(id)
    or app.is_platform_admin()
  );

create policy "events: organisers create"
  on public.events for insert to authenticated
  with check (organizer_id = (select auth.uid()));

create policy "events: managers update"
  on public.events for update to authenticated
  using (app.is_event_manager(id) or app.is_platform_admin())
  with check (app.is_event_manager(id) or app.is_platform_admin());

create policy "events: organiser deletes an event nobody joined"
  on public.events for delete to authenticated
  using (
    (organizer_id = (select auth.uid()) and registered_count = 0 and waitlisted_count = 0)
    or app.is_platform_admin()
  );

create policy "event_attendees: roster visible with the event"
  on public.event_attendees for select to authenticated
  using (app.can_view_event(event_id) or app.is_platform_admin());

create policy "event_attendees: RSVP yourself, managers add"
  on public.event_attendees for insert to authenticated
  with check (
       (profile_id = (select auth.uid()) and app.can_view_event(event_id))
    or app.is_event_manager(event_id)
  );

create policy "event_attendees: attendee or managers update"
  on public.event_attendees for update to authenticated
  using      (profile_id = (select auth.uid()) or app.is_event_manager(event_id))
  with check (profile_id = (select auth.uid()) or app.is_event_manager(event_id));

create policy "event_attendees: managers remove"
  on public.event_attendees for delete to authenticated
  using (app.is_event_manager(event_id));

create policy "event_queue_entries: board visible with the event"
  on public.event_queue_entries for select to authenticated
  using (app.can_view_event(event_id));

create policy "event_queue_entries: self or managers"
  on public.event_queue_entries for all to authenticated
  using      (profile_id = (select auth.uid()) or app.is_event_manager(event_id))
  with check (profile_id = (select auth.uid()) or app.is_event_manager(event_id));

-- =============================================================================
-- Chat
-- =============================================================================
create policy "chat_channels: participants and moderators read"
  on public.chat_channels for select to authenticated
  using (app.is_channel_participant(id) or app.is_channel_moderator(id) or app.is_platform_admin());

create policy "chat_participants: co-participants read"
  on public.chat_participants for select to authenticated
  using (
       profile_id = (select auth.uid())
    or app.is_channel_participant(channel_id)
    or app.is_channel_moderator(channel_id)
  );

create policy "chat_participants: update own read marker / mute"
  on public.chat_participants for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

create policy "chat_messages: participants and moderators read"
  on public.chat_messages for select to authenticated
  using (app.is_channel_participant(channel_id) or app.is_channel_moderator(channel_id));

create policy "chat_messages: participants post as themselves"
  on public.chat_messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and app.is_channel_participant(channel_id));

create policy "chat_messages: sender edits, sender or moderator deletes"
  on public.chat_messages for update to authenticated
  using      (sender_id = (select auth.uid()) or app.is_channel_moderator(channel_id))
  with check (sender_id = (select auth.uid()) or app.is_channel_moderator(channel_id));

-- =============================================================================
-- Privilege hardening
-- =============================================================================
-- Supabase's default privileges grant ALL on new public tables to anon and
-- authenticated, so narrow that down here. TRUNCATE ignores RLS and must go.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- anon is strictly read-only, and only on the public catalogue.
revoke insert, update, delete on all tables in schema public from anon;
revoke select on
  public.profiles, public.profile_contacts, public.platform_admins,
  public.player_profiles, public.coach_profiles, public.coach_availability,
  public.venue_managers, public.bookings, public.booking_status_history,
  public.club_members, public.event_attendees, public.event_queue_entries,
  public.chat_channels, public.chat_participants, public.chat_messages
from anon;

-- System-managed tables: end users never write them directly.
revoke insert, update, delete on
  public.ph_regions, public.ph_provinces, public.ph_municipalities, public.ph_barangays,
  public.platform_admins, public.booking_status_history, public.chat_channels
from authenticated;

-- chat_participants: rows come from triggers / RPCs. Users may only move
-- their read marker or mute a conversation.
revoke insert, update, delete on public.chat_participants from authenticated;
grant update (last_read_at, is_muted) on public.chat_participants to authenticated;

-- chat_messages: soft delete only (deleted_at), and only text is editable.
revoke update, delete on public.chat_messages from authenticated;
grant update (message_text, deleted_at) on public.chat_messages to authenticated;

-- bookings: never deleted by users. Identity, audit stamps and derived
-- columns are not client-writable (the guard trigger owns them).
revoke update, delete on public.bookings from authenticated;
grant update (
  court_id, start_time, end_time, coach_id, player_count,
  court_amount, lights_amount, coach_amount, discount_amount, total_amount,
  payment_ref_no, payment_receipt_url, payment_status, payment_rejection_reason,
  booking_status, cancellation_reason, notes
) on public.bookings to authenticated;

-- events: the RSVP counters are maintained by triggers only.
revoke update on public.events from authenticated;
grant update (
  venue_id, court_id, booking_id, coach_id, title, description, sport, event_type,
  tournament_format, rotation_format, min_skill_level, max_skill_level,
  municipality_code, barangay_code, location_text, start_time, end_time,
  registration_deadline, max_participants, waitlist_enabled, waitlist_capacity,
  fee_per_pax, is_private, status, cancellation_reason
) on public.events to authenticated;

-- RPCs that require a signed-in user.
revoke execute on function public.get_or_create_direct_channel(uuid) from anon;

-- Close the PUBLIC execute default on everything this migration defined in app.*
revoke execute on all functions in schema app from public;
