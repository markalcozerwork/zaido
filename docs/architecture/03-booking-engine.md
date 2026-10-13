# RacketHub · Step 3 · Booking concurrency engine

> How a court gets booked without ever being sold twice: one idempotent RPC
> that Postgres fully controls, typed refusals the UI can act on, an
> availability grid that predicts the database's answer for every start
> time, front-desk tools, and live slot updates over private Realtime
> channels.

| | |
|---|---|
| Database | `supabase/migrations/20261013001000_booking_engine.sql` |
| Server actions | `src/server/bookings/` (server-only; every action takes the caller's Supabase client) |
| Shared logic | `src/domain/availability.ts`, `booking.ts`, `errors.ts`, `realtime.ts` |
| Client | `src/client/court-slots.ts` (Realtime subscription) |
| Tests | SQL suite + concurrency races (`npm run db:verify`) · unit (`npm test`) · contract (`npm run test:contract`) · integration through a real PostgREST 13 (`npm run test:integration`) |

---

## 1. The flow

```
 player                       server action                  Postgres (RLS + guards)
 ──────                       ─────────────                  ───────────────────────
 open day view  ────────────▶ getDayAvailability ──────────▶ get_court_busy_slots   (times only)
                ◀──────────── DaySlot[] (occupancy, fit, price)
 subscribe court:<id>:slots ◀─────────────── broadcast on every change (hint → refetch)
 tap 18:00, 90 min, GCash
   key = randomUUID() once ─▶ createBooking ───── retry ───▶ create_booking(…, key)
                ◀──────────── booking (PENDING_PAYMENT, due 18:30) or typed refusal
 send GCash, paste ref ─────▶ submitPaymentProof ─────────▶ UPDATE (guard checks hold alive)
 attach screenshot (later) ─▶ attachReceipt
 venue staff ───────────────▶ reviewPayment APPROVE ──────▶ PAID → CONFIRMED
```

Nothing above trusts the client: prices, statuses, deadlines, who booked and
who verified are all set by the guard trigger. TypeScript only shapes requests
and predicts answers.

## 2. `create_booking`: the only way in

```sql
public.create_booking(p_court_id, p_start, p_end, p_payment_method,
                      p_idempotency_key, p_coach_id, p_payment_ref_no, p_player_count, p_notes,
                      -- front desk only:
                      p_booked_by, p_walk_in_name, p_walk_in_phone, p_discount_amount, p_mark_paid)
  returns public.bookings
```

* **SECURITY INVOKER.** RLS and every guard rule apply as the caller. A
  DEFINER version would bypass them all; the schema lint fails if anyone
  changes that, or adds an isolation-level override.
* **Idempotent per checkout.** The client makes one key per checkout and sends
  it on every retry and double-tap. Keys are scoped to the actor
  (`created_by`), so a staff walk-in can never collide with a player's key.
  * Twins with the same key queue on an advisory lock
    (`rackethub:idem:<actor>:<key>`), taken before anything else. The second
    one finds the first's row instead of tripping the hold cap or the slot
    constraint. Lock order is always idempotency → hold cap → rows/indexes.
  * A replay returns the original booking, whatever its status. TypeScript
    turns a cancelled replay into `HOLD_EXPIRED` or `BOOKING_CANCELLED`.
  * The same key for a different booking is `IDEMPOTENCY_KEY_REUSED`.
* **Plain INSERT plus an exception handler, not `ON CONFLICT`.** Speculative
  insertion deadlocked when two inserts clashed on the exclusion constraints
  (seen in the concurrency races). The handler re-checks the key. Failing
  that, if the caller already holds an overlapping booking on that court, it
  raises `SLOT_ALREADY_YOURS`, with that booking's id in `HINT`. Otherwise it
  re-raises the original error.
* **Must run under READ COMMITTED** (PostgREST's default). Twin detection
  relies on each statement seeing the latest commits.

## 3. The rules and their codes

Business rules raise `"CODE: human message"`. PostgREST forwards `code`,
`message`, `details` and `hint`, but **not** the constraint name, so the
prefix is the stable contract. `mapDatabaseError()` strips it and returns the
code, the text and the form field. A contract test scrapes every prefix from
the function sources and fails if TypeScript doesn't know it.

| Code | Raised when | Applies to |
|---|---|---|
| `COURT_INACTIVE` | court or venue switched off | players |
| `SLOT_IN_PAST` | start < now | players; coach sessions for staff too |
| `TOO_SOON` | start < now + `min_lead_minutes` | players |
| `BEYOND_HORIZON` | venue-local start **date** > today + `booking_horizon_days` (a whole day opens at local midnight) | players; coach sessions for staff too |
| `OFF_INCREMENT` · `DURATION_OUT_OF_RANGE` | court increment / min–max length | players |
| `VENUE_CLOSED` | any 15-minute slice outside opening hours | players |
| `VENUE_HOURS_NOT_SET` | no hours published and not `is_open_24h` | players |
| `COURT_CLOSED` | overlaps a `court_closures` row (court or venue-wide) | players |
| `COACH_UNAVAILABLE` | outside the coach's weekly windows, or the coach ledger clashes | everyone except trusted jobs |
| `PAYMENT_METHOD_UNAVAILABLE` | venue hasn't set that channel up | everyone |
| `PAY_FIRST` | unpaid e-wallet slot starting inside the payment window | players |
| `HOLD_LIMIT_REACHED` | ≥ `max_active_holds_per_player` unpaid holds at this venue | players |
| `SLOT_TAKEN` | `bookings_no_court_overlap` (exclusion constraint) | everyone, always |
| `SLOT_ALREADY_YOURS` | the overlapping booking is the caller's own | everyone |
| `HOLD_EXPIRED` | proof sent after due + grace | players |
| `PAYMENT_LOCKED` · `RECEIPT_INVALID` | proof edits after verification; receipt not this booking's own uploaded file | players |
| `CANCELLATION_CLOSED` · `CANCELLATION_CUTOFF` | cancel after start; cancel inside the cutoff once confirmed **or** money sent | players |
| `COURT_RESERVED_FOR_EVENT` | cancel/move a booking a live event is using | non-trusted |
| `COURT_BOOKING_REQUIRED` · `COURT_BOOKING_UNAVAILABLE` · `COACH_CONFIRMATION_REQUIRED` | event publishing rules (§6) | organisers |
| `IDEMPOTENCY_KEY_REUSED` | §2 | everyone |

Venue staff (owner, managers) skip the player-only rules. They may record a
session that already started or happened outside hours. The coach's time is
never theirs to give away, though, and overlaps are refused for everyone.

## 4. Holds, grace and expiry

* An unpaid e-wallet booking holds its slot until `payment_due_at`
  (`now + payment_window_minutes`, default 30), **plus a 5-minute grace**
  (`app.hold_grace()`). Every place that asks "is this hold alive?" uses the
  same boundary: the sweeps, the busy RPCs, the hold cap, late proofs and the
  broadcasts. So the grid, the guard and the cron job always agree.
* **Expiry** happens three ways, and none of them blocks bookings:
  1. inline, in the guard, for the holds that overlap *this* booking
     (court or coach), locked in id order;
  2. the per-minute cron sweep `app.expire_unpaid_bookings()`, which uses
     `FOR UPDATE SKIP LOCKED`, so it never waits on, or deadlocks with,
     live bookings;
  3. when an event goes live over the coach's dead hold.
* **Late payment.** A proof after due + grace is `HOLD_EXPIRED`, because the
  slot may already be resold. `rebookExpiredHold()` books the same slot again
  with the reference attached. If someone else took it, the player gets
  `SLOT_TAKEN` and settles with the venue (claim records are Step 5).
* **Hold cap.** Per player per venue, counted under an advisory lock on the
  booker, so N parallel checkouts can't all slip under the cap (concurrency
  race 9).
* **Pay first.** A last-minute e-wallet slot whose window would end after
  play starts needs the reference up front. Otherwise the court could be
  resold mid-game.

## 5. Coaches: one ledger, one constraint

`app.coach_commitments(source_kind, source_id, coach_id, time_range)` has an
`EXCLUDE (coach_id =, time_range &&)` constraint. DEFINER AFTER triggers on
`bookings` and `events` keep it in sync.

* **Why a ledger, not lock-then-check:** an exclusion constraint sees
  uncommitted and committed rows whatever the snapshot or RLS. A
  `SELECT … EXISTS` after an advisory lock misses clashes under REPEATABLE
  READ (the snapshot predates the lock). Under RLS it can't even see a
  private clinic. Concurrency race 5 runs the clash under REPEATABLE READ.
* **What counts:**
  * a booking with a coach that isn't cancelled;
  * an event, once it is SCHEDULED or IN_PROGRESS **and the coach accepted**
    (`coach_confirmed_at`).

  Naming a coach blocks nothing until they confirm, which closes a
  denial-of-service by naming. Moving a confirmed event resets the
  acceptance, unless the coach makes the move.
* **Covered events.** A clinic run on its coach's own court booking adds no
  second row: the booking already commits the coach for its whole range. If
  that booking is cancelled anyway (by a trusted actor), the event's own row
  comes back.
* **Sweeps can't abort.** A status flip that leaves the commitment unchanged
  (CONFIRMED → COMPLETED, SCHEDULED → IN_PROGRESS) skips the ledger. So a
  clash that predates the ledger never aborts the multi-row cron statements.
  Such clashes are reported as warnings by the migration's backfill.

## 6. Events that use a court

An event on a court must link a booking that is the organiser's own, on the
same court, covering the event, and CONFIRMED once the event is live. A DEFINER
trigger writes `bookings.reserved_for_event_id`. From then on:

* concurrent "publish the event" and "cancel the booking" serialise on the
  booking row, so there is no write skew (race 6, under READ COMMITTED and
  REPEATABLE READ);
* the booking can't be cancelled or moved (`COURT_RESERVED_FOR_EVENT`) until
  the event is cancelled or completed, which releases it;
* expiry never touches reserved bookings.

## 7. Front desk

| Need | How |
|---|---|
| Walk-in without an account | `walk_in_name` / `walk_in_phone` on a booking in the staff member's name. Never shown as the staff member's "mine"; staff can fix typos |
| Booking for a registered player | `p_booked_by`, only at **verified** venues and never with a coach. `created_by` records who did it, and contact visibility only counts bookings players made themselves |
| Cash collected now | `p_mark_paid`: one INSERT, CONFIRMED + PAID, verification stamped, no payment window |
| Discount | staff only; off court + lights, never the coach's fee |
| Move a booking | `rescheduleBooking` (same venue; overlaps refused) |
| Typhoon signal, maintenance | `court_closures` (one court or the whole venue, ≤ 31 days). The creator is stamped by the database, any staff member can edit, and changes are broadcast |
| Verification queue | `listVerificationQueue`: proofs oldest first, **including bookings cancelled after paying** (the venue still has to settle or refund them) |

## 8. The availability grid

`buildDaySlots()` (pure) returns, for each start time of a venue-local day:

* **occupancy** of that increment: `FREE`, `HELD` (with `heldUntil`),
  `BOOKED`, `MINE` (with `myBookingId`) or `CLOSED` (with the reason);
* **fit** of the chosen duration: `OK` or the code `create_booking` would
  return, checked in the guard's order (`RUNS_PAST_CLOSING` maps to
  `VENUE_CLOSED`);
* `maxBookableMinutes`, `payFirst`, and the database's price when it fits
  (coach fee included).

The integration suite books **every start** of a day through PostgREST and
checks the outcome equals the grid's verdict. It does this for:

* regular hours with others' bookings, a hold, the player's own booking and a
  closure;
* hours that run past midnight;
* a venue with no hours, and a 24/7 venue;
* today, with past slots and a lead time;
* a coach with weekly windows and a session elsewhere;
* front-desk mode;
* a 25-hour daylight-saving day in a non-PH venue.

Practical notes:

* The busy window is local midnight → next midnight + the longest booking, so
  late slots that end after midnight see what they'd overlap.
* Dead holds (past `held_until`) count as free. `refreshAt` is the next hold
  expiry, so the UI refetches then even with no message.
* Compare instants, not strings: PostgREST returns `…+00:00` while
  `toISOString()` gives `…Z`. Use `sameInstant()`.

## 9. Realtime

| | |
|---|---|
| Topic | `court:<court_id>:slots`, **private** |
| Event | `slot_changed` |
| Payload | `{court_id, start_time, end_time, busy, held_until}` + Realtime's own `id` |
| Sent by | DEFINER AFTER triggers on bookings (insert, delete, moves, status or payment changes, new hold expiry) and court closures (old range free, new range busy) |
| Who can receive | anyone (`SELECT` policy on `realtime.messages` for `court:%:slots`) |
| Who can send | no client: there is no INSERT policy, so topics can't be spoofed |

Payloads are **hints**. `subscribeToCourtSlots()` debounces bursts into one
`onInvalidate(range)` and the UI refetches. It never applies `busy` directly,
so lost, duplicated or reordered messages can't corrupt the grid. Every
(re)join fires `onResync` (refetch everything). supabase-js returns the same
channel object per topic, so a reference-counted registry shares one channel
between components and leaves only when the last one unsubscribes. The topic,
event and private flag live in `src/domain/realtime.ts`. A contract test
checks them against the trigger's source.

## 10. Server actions

| Action | Who | Notes |
|---|---|---|
| `getDayAvailability`, `getVenueDayAvailability`, `quoteBooking` | anyone | the coach grid needs a signed-in user (coach data is members-only) |
| `createBooking`, `rebookExpiredHold` | player | idempotency key required |
| `submitPaymentProof`, `attachReceipt`, `cancelBooking`, `listMyBookings` | player | cancel returns `refundDue` |
| `createStaffBooking`, `reviewPayment`, `listVerificationQueue`, `rescheduleBooking`, `createClosure`, `deleteClosure` | venue staff (enforced by the database) | |

**Transport.** postgrest-js retries only GET/HEAD/OPTIONS. Its retries are
turned off (`.retry(false)`), and every call goes through `callWithRetry`
instead:

* **Retried:** no response (status 0: network loss or per-attempt timeout),
  502/503/504/520, PostgREST connection/pool/schema-cache errors, and
  rolled-back transactions (`40001`, `40P01`).
* **Backoff:** full jitter, up to 4 attempts within a 10-second budget. The
  caller's `AbortSignal` is honoured.
* **Why it's safe:** every booking write is idempotent. `create_booking`
  replays by key, and updates set absolute values. Closures are the
  exception (an insert without a key), so they are not retried. The
  integration suite drops the response of a committed `create_booking` and
  checks that the retry returns the same booking, with one row.

`now` is always the server clock (`ServerDeps.now`), never request input.

## 11. What the tests prove

| Suite | Highlights |
|---|---|
| SQL (`tests/db/60_booking_engine.sql`) | every rule above · idempotency · on-behalf/walk-in privacy · ledger incl. covered clinics and pre-ledger clashes · event reservations · busy RPCs · broadcasts (incl. hold re-announcement, closure edits) · Realtime receive/send authorization |
| Concurrency (`tests/db/concurrency.sh`) | 24-way slot race → 1 row · 24 double-taps, one key → 1 booking, same id · coach race under REPEATABLE READ → 1 commitment · publish-vs-cancel (RC and RR) → 0 skew · 24 players via `create_booking` → 1 booked, 23 clean `SLOT_TAKEN`, 0 deadlocks · double-tap at hold cap − 1 → no false `HOLD_LIMIT_REACHED` · 24 checkouts at a 2-hold venue → exactly 2 |
| Schema lint | anon can call only the busy/quote RPCs · `create_booking` stays INVOKER with no isolation override · triggers installed · ledger unreadable · receive policy present |
| Contract | guard ≡ `checkSlotAgainstCourt` on hours, increments, lead time, horizon, pay-first, closures (same first code) · hold grace · realtime constants · every SQL prefix known to TypeScript · venue policy limits and defaults |
| Integration (PostgREST 13, real JWTs) | §8 parity · 10-player race · lost response · payments, queue, cancellations, front desk, closures, My bookings · the error contract on the wire |

## 12. Operations

* **Cron** (from Step 1): `expire_unpaid_bookings` every minute,
  `complete_finished_bookings` every 15 minutes.
* **After deploying**, run `scripts/post-deploy-check.sql` against the
  project. It checks that `realtime.send` exists, the receive policy is in
  place and the booking-engine triggers are installed. Without the policy,
  private channels silently receive nothing.
* **Migration backfills:**
  * `created_by = booked_by`;
  * `coach_confirmed_at = created_at` for existing coached events;
  * `is_open_24h = true` for venues that never published hours (they were
    bookable around the clock before);
  * coach ledger rows. Pre-existing clashes are reported as warnings, not
    fatal.

## 13. Limitations and what's next

| Item | Where |
|---|---|
| A live coached event can only be moved by its coach (a time change needs their acceptance) | by design |
| Late-payment claim records (money arrived after the slot was resold) | Step 5 |
| Per-IP / per-device rate limiting (edge/WAF); the hold cap protects each venue meanwhile | Step 5 |
| No-show / check-in, bulk cancel, front-desk day sheet export, multi-day summary | Step 5 |
| End-to-end Realtime delivery against a live Supabase Realtime server (the SQL side and the client registry are tested separately) | before launch |
