#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Real concurrency tests: N separate database sessions released at the same
# instant. Proves the guarantees hold under true parallelism, not just
# sequentially.
#
#   1. N racers book pairwise-overlapping ranges on one court
#      → exactly 1 wins, N-1 fail with 23P01 (exclusion_violation).
#   2. N racers RSVP to an event capped at 5 (READ COMMITTED)
#      → exactly 5 REGISTERED, N-5 WAITLISTED, counters == actual rows.
#   3. Same as 2 under REPEATABLE READ
#      → never more than 5 seats; the losers get 40001 (retryable) or the
#        waitlist; counters == actual rows.
#   Step 3:
#   4. one checkout double-tapped N times → 1 booking, every call the same id
#   5. coached bookings vs clinics for one coach (REPEATABLE READ) → 1 commitment
#   6. publish an event vs cancel its booking (RC + RR) → no write skew
#   7. N players through create_booking → 1 booked, N-1 clean SLOT_TAKEN
#   8. double-tap at hold cap - 1 → no false HOLD_LIMIT_REACHED
#   9. N checkouts by one player at a 2-hold venue → exactly 2
#  10. publish an event vs the venue moving its booking (RC + RR) → no write skew
#   Step 4 (chat):
#  11. N senders into one channel, half of them slow → gapless seq; a poller
#      syncing by seq sees every message, one syncing by created_at may not
#  12. one message double-tapped N times → 1 row, every call the same id
#  13. 40 parallel sends by one person across 4 chats → exactly the rate limit
#  14. two devices moving one read marker at once → the highest wins
#  15. both people opening their DM at once → one thread
#  16. senders, editors and deleters racing while a member syncs by rev through
#      get_chat_messages → the member ends with every change, at its final rev
# -----------------------------------------------------------------------------
set -euo pipefail

DB="${RH_TEST_DB:-rackethub_test}"
N="${RH_RACE_N:-24}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

q()  { psql -X -q --no-psqlrc -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
qa() { q -At "$@"; }
racer() { printf '00000000-0000-4000-b000-%012d' "$1"; }
fail() { echo "  ✘ $*"; exit 1; }

# --- fixtures ----------------------------------------------------------------
q >/dev/null <<SQL
insert into auth.users (id, email)
select ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, 'racer' || g || '@example.ph'
  from generate_series(1, $N) g
on conflict do nothing;

insert into public.events (id, organizer_id, venue_id, title, sport, event_type, start_time, end_time, max_participants)
values ('50000000-0000-4000-a000-000000000098', tests.uid('carlos'), '10000000-0000-4000-a000-000000000001',
        'Race Social RC', 'PICKLEBALL', 'OPEN_PLAY', tests.slot(5, '14:00'), tests.slot(5, '16:00'), 5),
       ('50000000-0000-4000-a000-000000000099', tests.uid('carlos'), '10000000-0000-4000-a000-000000000001',
        'Race Social RR', 'PICKLEBALL', 'OPEN_PLAY', tests.slot(5, '16:00'), tests.slot(5, '18:00'), 5)
on conflict do nothing;
SQL

# Everyone sleeps until the same instant, then fires.
start_at() { qa -c "select extract(epoch from clock_timestamp() + interval '2 seconds')"; }
barrier()  { echo "select pg_sleep(greatest(0, $1 - extract(epoch from clock_timestamp())))"; }

# --- 1. court double-booking race ---------------------------------------------
GO="$(start_at)"
ranges=("'07:00','08:00'" "'07:30','08:30'" "'07:00','09:00'")
for i in $(seq 1 "$N"); do
  r="${ranges[$(( i % 3 ))]}"
  IFS=, read -r s e <<<"$r"
  ( set +e
    q -c "set role authenticated" -c "select tests.login('$(racer "$i")'::uuid)" -c "$(barrier "$GO")" \
      -c "insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method)
          values ('20000000-0000-4000-a000-000000000002', '$(racer "$i")', tests.slot(6, $s), tests.slot(6, $e), 'GCASH')" \
      >"$WORK/book.$i.out" 2>&1; echo $? >"$WORK/book.$i.rc" ) &
done
wait

wins=0; excl=0
for i in $(seq 1 "$N"); do
  if [[ "$(cat "$WORK/book.$i.rc")" == 0 ]]; then wins=$(( wins + 1 ))
  elif grep -q 'bookings_no_court_overlap' "$WORK/book.$i.out"; then excl=$(( excl + 1 ))
  else sed 's/^/    /' "$WORK/book.$i.out"; fi
done
live=$(qa -c "select count(*) from public.bookings
               where court_id = '20000000-0000-4000-a000-000000000002' and booking_status <> 'CANCELLED'
                 and time_range && tstzrange(tests.slot(6, '07:00'), tests.slot(6, '09:00'))")
[[ "$wins" -eq 1 && "$excl" -eq $(( N - 1 )) && "$live" -eq 1 ]] \
  || fail "booking race: wins=$wins exclusion_failures=$excl live_rows=$live (N=$N)"
echo "  ok - $N parallel sessions raced for one slot: 1 booked, $excl rejected with 23P01, 1 row in the table"

# --- 2. RSVP race, READ COMMITTED ---------------------------------------------
GO="$(start_at)"
for i in $(seq 1 "$N"); do
  ( set +e
    q -c "set role authenticated" -c "select tests.login('$(racer "$i")'::uuid)" -c "$(barrier "$GO")" \
      -c "insert into public.event_attendees (event_id, profile_id)
          values ('50000000-0000-4000-a000-000000000098', '$(racer "$i")')" \
      >"$WORK/rc.$i.out" 2>&1; echo $? >"$WORK/rc.$i.rc" ) &
done
wait

ok_rsvps=0
for i in $(seq 1 "$N"); do
  if [[ "$(cat "$WORK/rc.$i.rc")" == 0 ]]; then ok_rsvps=$(( ok_rsvps + 1 )); else sed 's/^/    /' "$WORK/rc.$i.out"; fi
done
read -r reg wait_ cnt_reg cnt_wait < <(qa -F ' ' -c "
  select count(*) filter (where a.status in ('REGISTERED', 'CHECKED_IN')),
         count(*) filter (where a.status = 'WAITLISTED'),
         max(e.registered_count), max(e.waitlisted_count)
    from public.events e left join public.event_attendees a on a.event_id = e.id
   where e.id = '50000000-0000-4000-a000-000000000098'")
[[ "$ok_rsvps" -eq "$N" && "$reg" -eq 5 && "$wait_" -eq $(( N - 5 )) && "$cnt_reg" -eq 5 && "$cnt_wait" -eq $(( N - 5 )) ]] \
  || fail "RSVP race (RC): ok=$ok_rsvps registered=$reg waitlisted=$wait_ counters=$cnt_reg/$cnt_wait"
echo "  ok - $N parallel RSVPs for 5 seats: 5 registered, $wait_ waitlisted, counters match rows"

# --- 3. RSVP race, REPEATABLE READ, with client retry on 40001 -------------
# Under REPEATABLE READ the losers of the event-row lock get SQLSTATE 40001.
# Real clients (the Step 3 service) retry those. With retries, the outcome
# must converge to exactly the READ COMMITTED result.
GO="$(start_at)"
for i in $(seq 1 "$N"); do
  ( set +e
    for attempt in $(seq 1 60); do
      sync_sql="select 1"; [[ $attempt -eq 1 ]] && sync_sql="$(barrier "$GO")"
      q -c "set role authenticated" -c "select tests.login('$(racer "$i")'::uuid)" -c "$sync_sql" \
        -c "begin isolation level repeatable read" \
        -c "insert into public.event_attendees (event_id, profile_id)
            values ('50000000-0000-4000-a000-000000000099', '$(racer "$i")')" \
        -c "commit" >"$WORK/rr.$i.out" 2>&1
      rc=$?
      if [[ $rc -eq 0 ]] || ! grep -q 'could not serialize' "$WORK/rr.$i.out"; then
        echo "$rc $attempt" >"$WORK/rr.$i.rc"; exit 0
      fi
      sleep "0.0$(( RANDOM % 9 + 1 ))"
    done
    echo "99 60" >"$WORK/rr.$i.rc" ) &
done
wait

retries=0; other_err=0
for i in $(seq 1 "$N"); do
  read -r rc attempts <"$WORK/rr.$i.rc"
  retries=$(( retries + attempts - 1 ))
  if [[ "$rc" != 0 ]]; then other_err=$(( other_err + 1 )); sed 's/^/    /' "$WORK/rr.$i.out"; fi
done
read -r reg wait_ cnt_reg cnt_wait < <(qa -F ' ' -c "
  select count(*) filter (where a.status in ('REGISTERED', 'CHECKED_IN')),
         count(*) filter (where a.status = 'WAITLISTED'),
         max(e.registered_count), max(e.waitlisted_count)
    from public.events e left join public.event_attendees a on a.event_id = e.id
   where e.id = '50000000-0000-4000-a000-000000000099'")
[[ "$other_err" -eq 0 && "$reg" -eq 5 && "$wait_" -eq $(( N - 5 )) && "$cnt_reg" -eq 5 && "$cnt_wait" -eq $(( N - 5 )) ]] \
  || fail "RSVP race (RR): registered=$reg waitlisted=$wait_ counters=$cnt_reg/$cnt_wait retries=$retries other_errors=$other_err"
echo "  ok - REPEATABLE READ: $retries serialization retries (40001), converged to 5 registered / $wait_ waitlisted, counters match rows"

# =============================================================================
# Step 3 races
# =============================================================================
q >/dev/null <<SQL
-- Extra courts so coach races are decided by the coach ledger, not by court overlaps.
insert into public.courts (id, venue_id, name, sport, surface_type, hourly_rate)
select ('20000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid, '10000000-0000-4000-a000-000000000001',
       'Race Court ' || g, 'PICKLEBALL', 'ACRYLIC', 400
  from generate_series(1, 12) g
on conflict do nothing;
SQL
race_court() { printf '20000000-0000-4000-c000-%012d' "$1"; }

# --- 4. Double-tap: same user, same idempotency key, N concurrent sessions -----
KEY="bbbbbbbb-0000-4000-a000-$(printf '%012d' 4)"
GO="$(start_at)"
for i in $(seq 1 "$N"); do
  ( set +e
    q -At -c "set role authenticated" -c "select tests.login('alice')" -c "$(barrier "$GO")" \
      -c "select id from public.create_booking('$(race_court 1)', tests.slot(4, '08:00'), tests.slot(4, '09:00'), 'GCASH', p_idempotency_key => '$KEY')" \
      >"$WORK/idem.$i.out" 2>&1; echo $? >"$WORK/idem.$i.rc" ) &
done
wait
ids=$(for i in $(seq 1 "$N"); do [[ "$(cat "$WORK/idem.$i.rc")" == 0 ]] && grep -E '^[0-9a-f-]{36}$' "$WORK/idem.$i.out"; done | sort -u)
okcalls=$(for i in $(seq 1 "$N"); do cat "$WORK/idem.$i.rc"; done | grep -cx 0 || true)
rows=$(qa -c "select count(*) from public.bookings where idempotency_key = '$KEY'")
[[ "$okcalls" -eq "$N" && "$(echo "$ids" | wc -l)" -eq 1 && "$rows" -eq 1 ]] \
  || { for i in $(seq 1 "$N"); do sed 's/^/    /' "$WORK/idem.$i.out"; done | sort | uniq -c | head; fail "idempotency race: ok=$okcalls distinct_ids=$(echo "$ids" | wc -l) rows=$rows"; }
echo "  ok - $N concurrent double-taps with one key: all $N calls succeeded, 1 booking, every call got the same id"

# --- 5. Coach ledger race under REPEATABLE READ --------------------------------
# Half the sessions book the coach on DIFFERENT courts, the other half are the
# coach publishing overlapping clinics. Only the coach ledger can stop them.
GO="$(start_at)"
for i in $(seq 1 12); do
  if (( i % 2 )); then
    sql="select id from public.create_booking('$(race_court "$i")', tests.slot(4, '18:00'), tests.slot(4, '19:00'), 'CASH_ON_COURT', p_coach_id => tests.uid('carlos'))"
    who="'$(racer "$i")'::uuid"
  else
    sql="insert into public.events (organizer_id, coach_id, municipality_code, title, sport, event_type, start_time, end_time, max_participants) values (tests.uid('carlos'), tests.uid('carlos'), '9900100000', 'Race clinic $i', 'PICKLEBALL', 'CLINIC', tests.slot(4, '18:30'), tests.slot(4, '19:30'), 6)"
    who="'carlos'"
  fi
  ( set +e
    q -c "set role authenticated" -c "select tests.login($who)" -c "$(barrier "$GO")" \
      -c "begin isolation level repeatable read" -c "$sql" -c "commit" >"$WORK/coach.$i.out" 2>&1; echo $? >"$WORK/coach.$i.rc" ) &
done
wait
read -r ledger live_b live_e < <(qa -F ' ' -c "
  select (select count(*) from app.coach_commitments
           where coach_id = tests.uid('carlos') and time_range && tstzrange(tests.slot(4, '18:00'), tests.slot(4, '19:30'))),
         (select count(*) from public.bookings
           where coach_id = tests.uid('carlos') and booking_status <> 'CANCELLED'
             and time_range && tstzrange(tests.slot(4, '18:00'), tests.slot(4, '19:30'))),
         (select count(*) from public.events
           where coach_id = tests.uid('carlos') and status in ('SCHEDULED', 'IN_PROGRESS') and coach_confirmed_at is not null
             and tstzrange(start_time, end_time) && tstzrange(tests.slot(4, '18:00'), tests.slot(4, '19:30')))")
unexpected=$(for i in $(seq 1 12); do [[ "$(cat "$WORK/coach.$i.rc")" == 0 ]] || grep -LE 'COACH_UNAVAILABLE|could not serialize|bookings_no_coach_overlap|deadlock detected' "$WORK/coach.$i.out"; done | wc -l)
deadlocks=$(grep -l 'deadlock detected' "$WORK"/coach.*.out 2>/dev/null | wc -l || true)
if ! [[ "$ledger" -eq 1 && $(( live_b + live_e )) -eq 1 && "$unexpected" -eq 0 ]]; then
  for i in $(seq 1 12); do [[ "$(cat "$WORK/coach.$i.rc")" == 0 ]] || sed "s/^/    [$i] /" "$WORK/coach.$i.out"; done
  fail "coach race (RR): ledger=$ledger live_bookings=$live_b live_events=$live_e unexpected_errors=$unexpected"
fi
echo "  ok - REPEATABLE READ: 6 coached bookings on 6 courts vs 6 clinics for one coach → exactly 1 commitment survives, ledger == live rows ($deadlocks retryable deadlocks)"

# --- 6. Event link vs booking cancel (write-skew check), RC and RR -------------
q >/dev/null <<SQL
insert into public.bookings (id, court_id, booked_by, created_by, start_time, end_time, payment_method)
select ('30000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid, ('20000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid,
       ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid,
       tests.slot(3, '10:00'), tests.slot(3, '12:00'), 'CASH_ON_COURT'
  from generate_series(1, 12) g;
insert into public.events (id, organizer_id, venue_id, court_id, booking_id, title, sport, event_type, status, start_time, end_time, max_participants)
select ('50000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid, ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid,
       '10000000-0000-4000-a000-000000000001', ('20000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid,
       ('30000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid, 'Link race ' || g, 'PICKLEBALL', 'OPEN_PLAY', 'DRAFT',
       tests.slot(3, '10:00'), tests.slot(3, '12:00'), 4
  from generate_series(1, 12) g;
SQL
GO="$(start_at)"
for i in $(seq 1 12); do
  iso=$([[ $i -le 6 ]] && echo "read committed" || echo "repeatable read")
  for side in publish cancel; do
    if [[ $side == publish ]]; then
      sql="update public.events set status = 'SCHEDULED' where id = '$(printf '50000000-0000-4000-c000-%012d' "$i")'"
    else
      sql="update public.bookings set booking_status = 'CANCELLED' where id = '$(printf '30000000-0000-4000-c000-%012d' "$i")'"
    fi
    ( set +e
      q -c "set role authenticated" -c "select tests.login('$(racer "$i")'::uuid)" -c "$(barrier "$GO")" \
        -c "begin isolation level $iso" -c "$sql" -c "commit" >"$WORK/link.$i.$side.out" 2>&1; echo $? >"$WORK/link.$i.$side.rc" ) &
  done
done
wait
skew=$(qa -c "
  select count(*) from public.events e join public.bookings b on b.id = e.booking_id
   where e.id::text like '50000000-0000-4000-c000-%'
     and e.status = 'SCHEDULED' and (b.booking_status = 'CANCELLED' or b.reserved_for_event_id is distinct from e.id)")
published=$(qa -c "select count(*) from public.events where id::text like '50000000-0000-4000-c000-%' and status = 'SCHEDULED'")
[[ "$skew" -eq 0 ]] || fail "link vs cancel: $skew live events sit on cancelled or unreserved bookings"
echo "  ok - 12 publish-vs-cancel races (6 READ COMMITTED, 6 REPEATABLE READ): $published published, $(( 12 - published )) cancelled, 0 live events on a cancelled booking"

# --- 7. The production path: N players, distinct keys, one slot, via create_booking
GO="$(start_at)"
for i in $(seq 1 "$N"); do
  ( set +e
    q -At -c "set role authenticated" -c "select tests.login('$(racer "$i")'::uuid)" -c "$(barrier "$GO")" \
      -c "select id from public.create_booking('$(race_court 2)', tests.slot(4, '20:00'), tests.slot(4, '21:00'), 'GCASH', p_idempotency_key => gen_random_uuid())" \
      >"$WORK/rpc.$i.out" 2>&1; echo $? >"$WORK/rpc.$i.rc" ) &
done
wait
wins=0; taken=0; other=0
for i in $(seq 1 "$N"); do
  if [[ "$(cat "$WORK/rpc.$i.rc")" == 0 ]]; then wins=$(( wins + 1 ))
  elif grep -q 'bookings_no_court_overlap' "$WORK/rpc.$i.out"; then taken=$(( taken + 1 ))
  else other=$(( other + 1 )); sed 's/^/    /' "$WORK/rpc.$i.out" | grep -E 'ERROR|DETAIL' | head -2; fi
done
[[ "$wins" -eq 1 && "$taken" -eq $(( N - 1 )) && "$other" -eq 0 ]] || fail "create_booking race: wins=$wins slot_taken=$taken other=$other"
echo "  ok - $N players through create_booking (distinct keys) for one slot: 1 booked, $taken clean SLOT_TAKEN, 0 deadlocks"

# --- 8/9. Hold cap under concurrency -------------------------------------------
# A venue that allows 2 unpaid holds per player.
q >/dev/null <<SQL
insert into auth.users (id, email) values
  ('00000000-0000-4000-b000-000000000901', 'capper1@example.ph'),
  ('00000000-0000-4000-b000-000000000902', 'capper2@example.ph')
on conflict do nothing;
insert into public.venues (id, owner_id, name, municipality_code, barangay_code, address, gcash_account_name, gcash_number,
                           is_open_24h, verification_status, max_active_holds_per_player)
values ('10000000-0000-4000-c000-000000000009', tests.uid('olivia'), 'Cap Courts', '9900100000', '9900100002',
        '9 Cap Street, Pasig', 'Olivia O.', '+639170000001', true, 'VERIFIED', 2)
on conflict do nothing;
insert into public.courts (id, venue_id, name, sport, surface_type, hourly_rate)
values ('20000000-0000-4000-c000-000000000901', '10000000-0000-4000-c000-000000000009', 'Cap 1', 'PICKLEBALL', 'ACRYLIC', 300)
on conflict do nothing;
SQL
CAPC='20000000-0000-4000-c000-000000000901'
# 8. capper1 already holds cap-1 slots, then double-taps one checkout N times.
q >/dev/null -c "set role authenticated" -c "select tests.login('00000000-0000-4000-b000-000000000901'::uuid)" \
  -c "select id from public.create_booking('$CAPC', tests.slot(9, '06:00'), tests.slot(9, '07:00'), 'GCASH', p_idempotency_key => gen_random_uuid())"
KEY="bbbbbbbb-0000-4000-a000-$(printf '%012d' 8)"
GO="$(start_at)"
for i in $(seq 1 "$N"); do
  ( set +e
    q -At -c "set role authenticated" -c "select tests.login('00000000-0000-4000-b000-000000000901'::uuid)" -c "$(barrier "$GO")" \
      -c "select id from public.create_booking('$CAPC', tests.slot(9, '08:00'), tests.slot(9, '09:00'), 'GCASH', p_idempotency_key => '$KEY')" \
      >"$WORK/cap.$i.out" 2>&1; echo $? >"$WORK/cap.$i.rc" ) &
done
wait
ids=$(for i in $(seq 1 "$N"); do [[ "$(cat "$WORK/cap.$i.rc")" == 0 ]] && grep -E '^[0-9a-f-]{36}$' "$WORK/cap.$i.out"; done | sort -u)
okcalls=$(for i in $(seq 1 "$N"); do cat "$WORK/cap.$i.rc"; done | grep -cx 0 || true)
capped=$(grep -l 'HOLD_LIMIT_REACHED' "$WORK"/cap.*.out 2>/dev/null | wc -l || true)
[[ "$okcalls" -eq "$N" && "$(echo "$ids" | wc -l)" -eq 1 && "$capped" -eq 0 ]] \
  || { for i in $(seq 1 "$N"); do sed 's/^/    /' "$WORK/cap.$i.out"; done | sort | uniq -c | head; fail "cap double-tap: ok=$okcalls ids=$(echo "$ids" | wc -l) capped=$capped"; }
echo "  ok - $N double-taps of one checkout at hold cap - 1: all succeeded with one id, none tripped HOLD_LIMIT_REACHED"

# 9. capper2 (no holds) fires N different checkouts for N different slots at once.
GO="$(start_at)"
for i in $(seq 1 "$N"); do
  ( set +e
    q -At -c "set role authenticated" -c "select tests.login('00000000-0000-4000-b000-000000000902'::uuid)" -c "$(barrier "$GO")" \
      -c "select id from public.create_booking('$CAPC', tests.slot(10, '00:00') + make_interval(hours => $i), tests.slot(10, '00:00') + make_interval(hours => $i + 1), 'GCASH', p_idempotency_key => gen_random_uuid())" \
      >"$WORK/cap2.$i.out" 2>&1; echo $? >"$WORK/cap2.$i.rc" ) &
done
wait
okcalls=$(for i in $(seq 1 "$N"); do cat "$WORK/cap2.$i.rc"; done | grep -cx 0 || true)
capped=$(grep -l 'HOLD_LIMIT_REACHED' "$WORK"/cap2.*.out 2>/dev/null | wc -l || true)
held=$(qa -c "select count(*) from public.bookings where booked_by = '00000000-0000-4000-b000-000000000902' and booking_status = 'PENDING_PAYMENT'")
[[ "$okcalls" -eq 2 && "$capped" -eq $(( N - 2 )) && "$held" -eq 2 ]] \
  || { for i in $(seq 1 "$N"); do sed 's/^/    /' "$WORK/cap2.$i.out"; done | sort | uniq -c | head; fail "hold cap race: ok=$okcalls capped=$capped held=$held"; }
echo "  ok - $N simultaneous checkouts by one player at a 2-hold venue: exactly 2 holds, $capped HOLD_LIMIT_REACHED"

# --- 10. Event link vs venue reschedule (write-skew check), RC and RR -----------
# Staff move booking B while its organiser publishes event E on it. Either the
# move goes first and the publish fails (B no longer covers E), or the publish
# goes first and the move is refused: never a live event on court time it
# doesn't hold.
q >/dev/null <<SQL
insert into public.bookings (id, court_id, booked_by, created_by, start_time, end_time, payment_method)
select ('30000000-0000-4000-c000-' || lpad((100 + g)::text, 12, '0'))::uuid, ('20000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid,
       ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid,
       tests.slot(3, '14:00'), tests.slot(3, '16:00'), 'CASH_ON_COURT'
  from generate_series(1, 12) g;
insert into public.events (id, organizer_id, venue_id, court_id, booking_id, title, sport, event_type, status, start_time, end_time, max_participants)
select ('50000000-0000-4000-c000-' || lpad((100 + g)::text, 12, '0'))::uuid, ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid,
       '10000000-0000-4000-a000-000000000001', ('20000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid,
       ('30000000-0000-4000-c000-' || lpad((100 + g)::text, 12, '0'))::uuid, 'Move race ' || g, 'PICKLEBALL', 'OPEN_PLAY', 'DRAFT',
       tests.slot(3, '14:00'), tests.slot(3, '16:00'), 4
  from generate_series(1, 12) g;
SQL
GO="$(start_at)"
for i in $(seq 1 12); do
  iso=$([[ $i -le 6 ]] && echo "read committed" || echo "repeatable read")
  b="$(printf '30000000-0000-4000-c000-%012d' $(( 100 + i )))"
  e="$(printf '50000000-0000-4000-c000-%012d' $(( 100 + i )))"
  ( set +e   # the venue moves the booking 4 hours later, holding the row lock for a moment
    q -c "set role authenticated" -c "select tests.login('mia')" -c "$(barrier "$GO")" \
      -c "begin isolation level $iso" \
      -c "update public.bookings set start_time = start_time + interval '4 hours', end_time = end_time + interval '4 hours' where id = '$b'" \
      -c "select pg_sleep(0.4)" -c "commit" >"$WORK/move.$i.staff.out" 2>&1 ) &
  ( set +e   # the organiser publishes the event a moment later
    q -c "set role authenticated" -c "select tests.login('$(racer "$i")'::uuid)" -c "$(barrier "$GO")" -c "select pg_sleep(0.1)" \
      -c "begin isolation level $iso" -c "update public.events set status = 'SCHEDULED' where id = '$e'" -c "commit" \
      >"$WORK/move.$i.org.out" 2>&1 ) &
done
wait
skew=$(qa -c "
  select count(*) from public.events e join public.bookings b on b.id = e.booking_id
   where e.id::text like '50000000-0000-4000-c000-0000000001%'
     and e.status = 'SCHEDULED'
     and not (b.booking_status = 'CONFIRMED' and b.reserved_for_event_id = e.id and b.court_id = e.court_id
              and b.time_range @> tstzrange(e.start_time, e.end_time, '[)'))")
published=$(qa -c "select count(*) from public.events where id::text like '50000000-0000-4000-c000-0000000001%' and status = 'SCHEDULED'")
[[ "$skew" -eq 0 ]] || { sed 's/^/    /' "$WORK"/move.1.*.out | head; fail "link vs reschedule: $skew live events on court time their booking no longer holds"; }
echo "  ok - 12 publish-vs-reschedule races (6 READ COMMITTED, 6 REPEATABLE READ): $published published, 0 live events on court time they don't hold"

# --- Step 4: chat -----------------------------------------------------------------
CHAT_CLUB='40000000-0000-4000-c000-000000000001'
q >/dev/null <<SQL
insert into public.clubs (id, name, slug, sport, municipality_code, created_by)
values ('$CHAT_CLUB', 'Race Chat Club', 'race-chat-club', 'PICKLEBALL', '9900100000', '$(racer 1)');
insert into public.club_members (club_id, profile_id)
select '$CHAT_CLUB', ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid from generate_series(2, $N) g
on conflict do nothing;
SQL
CHAT=$(qa -c "select id from public.chat_channels where type = 'CLUB' and club_id = '$CHAT_CLUB'")

# 11. Sixteen senders; the odd ones start their transaction early and send late,
# so their created_at (transaction start) is older than messages that commit
# before them. A poller keeps two cursors while they race.
GO="$(start_at)"
( set +e
  q >"$WORK/poll.out" 2>&1 <<SQL
$(barrier "$GO");
create temp table seen_seq (id uuid primary key);
create temp table seen_at  (id uuid primary key);
do \$\$
declare
  v_seq bigint := 0;
  v_at  timestamptz := '-infinity';
  r     record;
  v_end timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    for r in select m.id, m.seq from public.chat_messages m where m.channel_id = '$CHAT' and m.seq > v_seq order by m.seq loop
      insert into seen_seq values (r.id) on conflict do nothing;
      v_seq := r.seq;
    end loop;
    for r in select m.id, m.created_at from public.chat_messages m where m.channel_id = '$CHAT' and m.created_at > v_at order by m.created_at loop
      insert into seen_at values (r.id) on conflict do nothing;
      v_at := r.created_at;
    end loop;
    exit when clock_timestamp() > v_end;
    perform pg_sleep(0.01);
  end loop;
end;
\$\$;
select 'SEEN ' || (select count(*) from seen_seq) || ' ' || (select count(*) from seen_at);
SQL
) &
for i in $(seq 1 16); do
  ( set +e
    if (( i % 2 )); then
      q -c "set role authenticated" -c "select tests.login('$(racer "$i")'::uuid)" -c "$(barrier "$GO")" \
        -c "begin" -c "select now()" -c "select pg_sleep(0.3)" \
        -c "select seq from public.send_chat_message('$CHAT', gen_random_uuid(), 'slow $i')" -c "commit" \
        >"$WORK/send.$i.out" 2>&1
    else
      q -c "set role authenticated" -c "select tests.login('$(racer "$i")'::uuid)" -c "$(barrier "$GO")" -c "select pg_sleep(0.1)" \
        -c "select seq from public.send_chat_message('$CHAT', gen_random_uuid(), 'fast $i')" \
        >"$WORK/send.$i.out" 2>&1
    fi; echo $? >"$WORK/send.$i.rc" ) &
done
wait
okcalls=$(for i in $(seq 1 16); do cat "$WORK/send.$i.rc"; done | grep -cx 0 || true)
shape=$(qa -c "select count(*) || ' ' || min(seq) || '-' || max(seq) || ' ' || count(distinct seq) || ' ' || bool_and(rev = seq)
                 || ' ' || (select last_seq from public.chat_channels where id = '$CHAT')
                 from public.chat_messages where channel_id = '$CHAT'")
read -r _ by_seq by_at < <(grep -E '^ *SEEN ' "$WORK/poll.out" | sed 's/^ *//') || true
[[ "$okcalls" -eq 16 && "$shape" == "16 1-16 16 true 16" && "${by_seq:-0}" -eq 16 ]] \
  || { sed 's/^/    /' "$WORK/poll.out" "$WORK"/send.1.out | head -20; fail "chat ordering: ok=$okcalls shape='$shape' seen_by_seq=${by_seq:-?} seen_by_created_at=${by_at:-?}"; }
echo "  ok - 16 racing senders (8 slow): seq 1-16 without gaps; a seq cursor saw all 16, a created_at cursor saw ${by_at}"

# 12. One message double-tapped N times.
KEY='cccccccc-0000-4000-a000-000000000012'
GO="$(start_at)"
for i in $(seq 1 "$N"); do
  ( set +e
    q -At -c "set role authenticated" -c "select tests.login('$(racer 17)'::uuid)" -c "$(barrier "$GO")" \
      -c "select id from public.send_chat_message('$CHAT', '$KEY', 'Game at 6?')" >"$WORK/tap.$i.out" 2>&1
    echo $? >"$WORK/tap.$i.rc" ) &
done
wait
okcalls=$(for i in $(seq 1 "$N"); do cat "$WORK/tap.$i.rc"; done | grep -cx 0 || true)
ids=$(for i in $(seq 1 "$N"); do grep -E '^[0-9a-f-]{36}$' "$WORK/tap.$i.out"; done | sort -u | wc -l)
rows=$(qa -c "select count(*) || ' ' || (select last_seq from public.chat_channels where id = '$CHAT') from public.chat_messages where channel_id = '$CHAT'")
[[ "$okcalls" -eq "$N" && "$ids" -eq 1 && "$rows" == "17 17" ]] \
  || { for i in $(seq 1 "$N"); do sed 's/^/    /' "$WORK/tap.$i.out"; done | sort | uniq -c | head; fail "send double-tap: ok=$okcalls ids=$ids rows/last_seq=$rows"; }
echo "  ok - $N double-taps of one message: 1 row, every call got its id, no gap in seq"

# 13. 40 parallel sends by one person across 4 DMs: the limit holds under concurrency.
SPAMMER="$(racer 24)"
DMS=()
for j in 20 21 22 23; do
  DMS+=("$(q -At -c "set role authenticated" -c "select tests.login('$SPAMMER'::uuid)" \
             -c "select public.get_or_create_direct_channel('$(racer "$j")')" | grep -E '^[0-9a-f-]{36}$')")
done
GO="$(start_at)"
for i in $(seq 1 40); do
  ( set +e
    q -At -c "set role authenticated" -c "select tests.login('$SPAMMER'::uuid)" -c "$(barrier "$GO")" \
      -c "select seq from public.send_chat_message('${DMS[$(( i % 4 ))]}', gen_random_uuid(), 'buy paddles $i')" >"$WORK/spam.$i.out" 2>&1
    echo $? >"$WORK/spam.$i.rc" ) &
done
wait
okcalls=$(for i in $(seq 1 40); do cat "$WORK/spam.$i.rc"; done | grep -cx 0 || true)
limited=$(grep -l 'RATE_LIMITED' "$WORK"/spam.*.out 2>/dev/null | wc -l || true)
limit=$(qa -c "select app.chat_rate_limit_count()")
[[ "$okcalls" -eq "$limit" && "$limited" -eq $(( 40 - limit )) ]] \
  || { for i in $(seq 1 40); do sed 's/^/    /' "$WORK/spam.$i.out"; done | sort | uniq -c | head; fail "rate limit race: ok=$okcalls limited=$limited (limit $limit)"; }
echo "  ok - 40 parallel sends across 4 chats by one person: exactly $limit accepted, $limited RATE_LIMITED"

# 14. Two devices of racer 2 move the club read marker to different positions at
# once. The highest position goes first and the lower ones race in after it, so a
# last-writer-wins regression would always end below the maximum.
GO="$(start_at)"
for i in $(seq 1 12); do
  target=$(( (i * 7) % 17 )); delay=$([[ $target -eq 16 ]] && echo 0 || echo 0.2)
  ( set +e
    q -c "set role authenticated" -c "select tests.login('$(racer 2)'::uuid)" -c "$(barrier "$GO")" -c "select pg_sleep($delay)" \
      -c "select public.mark_chat_read('$CHAT', $target)" >"$WORK/mark.$i.out" 2>&1 ) &
done
wait
marker=$(qa -c "select last_read_seq from public.chat_participants where channel_id = '$CHAT' and profile_id = '$(racer 2)'")
want=$(for i in $(seq 1 12); do echo $(( (i * 7) % 17 )); done | sort -n | tail -1)
own=$(qa -c "select coalesce(max(seq), 0) from public.chat_messages where channel_id = '$CHAT' and sender_id = '$(racer 2)'")
(( want < own )) && want=$own
[[ "$marker" -eq "$want" ]] || { sed 's/^/    /' "$WORK"/mark.1.out; fail "read marker race: marker=$marker, expected $want"; }
echo "  ok - 12 simultaneous read-marker moves from two devices: the highest position ($marker) won"

# 15. Both people open their DM at the same moment, many times over.
GO="$(start_at)"
for i in $(seq 1 "$N"); do
  me=$(( i % 2 ? 18 : 19 )); other=$(( i % 2 ? 19 : 18 ))
  ( set +e
    q -At -c "set role authenticated" -c "select tests.login('$(racer "$me")'::uuid)" -c "$(barrier "$GO")" \
      -c "select public.get_or_create_direct_channel('$(racer "$other")')" >"$WORK/dm.$i.out" 2>&1 ) &
done
wait
ids=$(for i in $(seq 1 "$N"); do grep -E '^[0-9a-f-]{36}$' "$WORK/dm.$i.out"; done | sort -u | wc -l)
threads=$(qa -c "select count(*) from public.chat_channels where type = 'DIRECT'
                   and dm_profile_low = least('$(racer 18)'::uuid, '$(racer 19)'::uuid)
                   and dm_profile_high = greatest('$(racer 18)'::uuid, '$(racer 19)'::uuid)")
[[ "$ids" -eq 1 && "$threads" -eq 1 ]] || { sed 's/^/    /' "$WORK"/dm.1.out; fail "DM open race: ids=$ids threads=$threads"; }
echo "  ok - $N simultaneous DM opens by both people: one thread, one id"

# 16. Racers 3-10 send, racers 11-16 edit their race-11 message (holding the row
# for a moment), racers 1-2 delete theirs, while racer 20 syncs by rev through
# get_chat_messages under RLS, the way the app does.
START_REV=$(qa -c "select last_rev from public.chat_channels where id = '$CHAT'")
GO="$(start_at)"
( set +e
  q >"$WORK/revpoll.out" 2>&1 <<SQL
set role authenticated;
select tests.login('$(racer 20)'::uuid);
$(barrier "$GO");
create temp table seen (id uuid primary key, rev bigint, body text, deleted boolean);
do \$\$
declare
  v_cursor bigint := $START_REV;
  v_page   jsonb;
  v_end    timestamptz := clock_timestamp() + interval '2.5 seconds';
  v_more   boolean;
  m        jsonb;
begin
  loop
    loop
      v_page := public.get_chat_messages('$CHAT', p_after_rev => v_cursor, p_limit => 3);
      for m in select * from jsonb_array_elements(v_page -> 'messages') loop
        insert into seen values ((m ->> 'id')::uuid, (m ->> 'rev')::bigint, m ->> 'text', m ->> 'deleted_at' is not null)
        on conflict (id) do update set rev = excluded.rev, body = excluded.body, deleted = excluded.deleted
          where seen.rev < excluded.rev;
        v_cursor := greatest(v_cursor, (m ->> 'rev')::bigint);
      end loop;
      v_more := (v_page ->> 'has_more')::boolean;
      if not v_more then
        v_cursor := greatest(v_cursor, (v_page ->> 'last_rev')::bigint);
        exit;
      end if;
    end loop;
    exit when clock_timestamp() > v_end;
    perform pg_sleep(0.01);
  end loop;
end;
\$\$;
reset role;
select 'MISSED ' || count(*) from public.chat_messages c left join seen s on s.id = c.id
 where c.channel_id = '$CHAT' and c.rev > $START_REV
   and (s.id is null or s.rev <> c.rev or s.body is distinct from c.message_text or s.deleted <> (c.deleted_at is not null));
SQL
) &
for i in $(seq 3 10); do
  ( set +e
    q -c "set role authenticated" -c "select tests.login('$(racer "$i")'::uuid)" -c "$(barrier "$GO")" -c "select pg_sleep(0.$(( i % 5 )))" \
      -c "select seq from public.send_chat_message('$CHAT', gen_random_uuid(), 'race 16 from $i')" >"$WORK/r16s.$i.out" 2>&1 ) &
done
for i in $(seq 11 16); do
  ( set +e
    q -c "set role authenticated" -c "select tests.login('$(racer "$i")'::uuid)" -c "$(barrier "$GO")" -c "begin" \
      -c "update public.chat_messages set message_text = 'edited by $i' where channel_id = '$CHAT' and sender_id = '$(racer "$i")' and seq <= 16" \
      -c "select pg_sleep(0.3)" -c "commit" >"$WORK/r16e.$i.out" 2>&1 ) &
done
for i in 1 2; do
  ( set +e
    q -c "set role authenticated" -c "select tests.login('$(racer "$i")'::uuid)" -c "$(barrier "$GO")" -c "select pg_sleep(0.2)" \
      -c "update public.chat_messages set deleted_at = now() where channel_id = '$CHAT' and sender_id = '$(racer "$i")' and seq <= 16" \
      >"$WORK/r16d.$i.out" 2>&1 ) &
done
wait
changed=$(qa -c "select count(*) from public.chat_messages where channel_id = '$CHAT' and rev > $START_REV")
revs=$(qa -c "select (max(rev) = (select last_rev from public.chat_channels where id = '$CHAT'))::text from public.chat_messages where channel_id = '$CHAT'")
missed=$(grep -E '^ *MISSED ' "$WORK/revpoll.out" | sed 's/[^0-9]//g' || true)
[[ "$changed" -eq 16 && "$revs" == "true" && "${missed:-x}" == "0" ]] \
  || { sed 's/^/    /' "$WORK/revpoll.out" "$WORK"/r16e.11.out | head -20; fail "rev sync race: changed=$changed max_rev_ok=$revs missed=${missed:-?}"; }
echo "  ok - 8 sends, 6 slow edits and 2 deletes raced a member syncing by rev: all 16 changes seen at their final rev"
