-- =============================================================================
-- RacketHub · 0950 · Storage buckets & object policies
-- =============================================================================
-- Path conventions (the first folder is the authorisation key):
--   avatars/            {profile_id}/{file}                 public
--   venue-media/        {venue_id}/{file}                   public
--   club-media/         {club_id}/{file}                    public
--   payment-receipts/   {booking_id}/{file}                 PRIVATE: booker + venue staff
--   chat-media/         {channel_id}/{sender_id}/{file}     PRIVATE: channel participants
--   coach-credentials/  {profile_id}/{file}                 PRIVATE: coach + platform admins
--
-- Payment receipts are evidence. Once uploaded they can't be overwritten or
-- deleted by end users, so a proof of payment can't be swapped after the
-- venue has looked at it.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars',           'avatars',           true,   2097152, array['image/jpeg', 'image/png', 'image/webp']),
  ('venue-media',       'venue-media',       true,   5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('club-media',        'club-media',        true,   5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('payment-receipts',  'payment-receipts',  false,  5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']),
  ('chat-media',        'chat-media',        false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4']),
  ('coach-credentials', 'coach-credentials', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function app.can_view_booking(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.bookings b
     where b.id = p_booking_id
       and (   b.booked_by = auth.uid()
            or app.is_venue_manager(b.venue_id)
            or app.is_platform_admin())
  );
$$;

-- Only the booker may upload, and only while the payment is still open.
create or replace function app.can_upload_receipt(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.bookings b
     where b.id = p_booking_id
       and b.booked_by = auth.uid()
       and b.booking_status = 'PENDING_PAYMENT'
       and b.payment_method <> 'CASH_ON_COURT'
       and b.payment_status in ('UNPAID', 'REJECTED', 'AWAITING_VERIFICATION')
  );
$$;

grant execute on function app.can_view_booking(uuid)   to authenticated, service_role;
grant execute on function app.can_upload_receipt(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- avatars
-- -----------------------------------------------------------------------------
create policy "avatars: public read"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'avatars');

create policy "avatars: owner writes own folder"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "avatars: owner updates own folder"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "avatars: owner deletes own folder"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- -----------------------------------------------------------------------------
-- venue-media
-- -----------------------------------------------------------------------------
create policy "venue-media: public read"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'venue-media');

create policy "venue-media: venue owner writes"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'venue-media' and app.is_venue_owner(app.try_uuid((storage.foldername(name))[1])));

create policy "venue-media: venue owner updates"
  on storage.objects for update to authenticated
  using (bucket_id = 'venue-media' and app.is_venue_owner(app.try_uuid((storage.foldername(name))[1])));

create policy "venue-media: venue owner deletes"
  on storage.objects for delete to authenticated
  using (bucket_id = 'venue-media' and app.is_venue_owner(app.try_uuid((storage.foldername(name))[1])));

-- -----------------------------------------------------------------------------
-- club-media
-- -----------------------------------------------------------------------------
create policy "club-media: public read"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'club-media');

create policy "club-media: club admin writes"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'club-media' and app.is_club_admin(app.try_uuid((storage.foldername(name))[1])));

create policy "club-media: club admin updates"
  on storage.objects for update to authenticated
  using (bucket_id = 'club-media' and app.is_club_admin(app.try_uuid((storage.foldername(name))[1])));

create policy "club-media: club admin deletes"
  on storage.objects for delete to authenticated
  using (bucket_id = 'club-media' and app.is_club_admin(app.try_uuid((storage.foldername(name))[1])));

-- -----------------------------------------------------------------------------
-- payment-receipts (private, append-only for end users)
-- -----------------------------------------------------------------------------
create policy "payment-receipts: booker and venue staff read"
  on storage.objects for select to authenticated
  using (bucket_id = 'payment-receipts' and app.can_view_booking(app.try_uuid((storage.foldername(name))[1])));

create policy "payment-receipts: booker uploads while payment is open"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-receipts' and app.can_upload_receipt(app.try_uuid((storage.foldername(name))[1])));
-- No UPDATE / DELETE policies: receipts are immutable evidence.

-- -----------------------------------------------------------------------------
-- chat-media (private)
-- -----------------------------------------------------------------------------
create policy "chat-media: participants read"
  on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and app.is_channel_participant(app.try_uuid((storage.foldername(name))[1])));

create policy "chat-media: participants upload into their own sender folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and app.is_channel_participant(app.try_uuid((storage.foldername(name))[1]))
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "chat-media: sender deletes own uploads"
  on storage.objects for delete to authenticated
  using (bucket_id = 'chat-media' and (storage.foldername(name))[2] = (select auth.uid())::text);

-- -----------------------------------------------------------------------------
-- coach-credentials (private)
-- -----------------------------------------------------------------------------
create policy "coach-credentials: coach and admins read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'coach-credentials'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or app.is_platform_admin())
  );

create policy "coach-credentials: coach uploads own"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'coach-credentials' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "coach-credentials: coach deletes own"
  on storage.objects for delete to authenticated
  using (bucket_id = 'coach-credentials' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Close the PUBLIC execute default on everything this migration defined in app.*
revoke execute on all functions in schema app from public;
