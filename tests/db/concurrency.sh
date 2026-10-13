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
