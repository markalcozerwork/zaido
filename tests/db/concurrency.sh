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
