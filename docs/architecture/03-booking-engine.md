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
  * A replay that now carries what the first attempt didn't is applied under
    the same rules as a separate update, instead of being dropped:
    * a payment reference (the player paid in the meantime);
    * `p_mark_paid` (the desk took the cash).
  * The same key for a different booking is `IDEMPOTENCY_KEY_REUSED`. So is a
    different reference on the same checkout.
* **Plain INSERT plus an exception handler, not `ON CONFLICT`.** Speculative
  insertion deadlocked when two inserts clashed on the exclusion constraints
  (seen in the concurrency races). The handler re-checks the key. Failing
  that, it raises `SLOT_ALREADY_YOURS`, with that booking's id in `HINT`, only
  when all of the following hold:
  * the court constraint failed;
  * a player is booking for themselves;
  * the overlapping booking is that player's own **live** booking (not a dead
    hold, not a walk-in).

  Otherwise it re-raises the original error, so a reused reference stays
  `PAYMENT_REF_ALREADY_USED` and staff conflicts stay `SLOT_TAKEN`.
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
| `SLOT_IN_PAST` | start < now | players; a new coach-session start for staff too (staff may extend a lesson that already started) |
| `TOO_SOON` | start < now + `min_lead_minutes` | players |
| `BEYOND_HORIZON` | venue-local start **date** > today + `booking_horizon_days` (a whole day opens at local midnight) | players; coach sessions for staff too |
| `OFF_INCREMENT` · `DURATION_OUT_OF_RANGE` | court increment / min–max length | players |
| `VENUE_CLOSED` | any 15-minute slice outside opening hours | players |
| `VENUE_HOURS_NOT_SET` | no hours published and not `is_open_24h` | players |
| `COURT_CLOSED` | overlaps a `court_closures` row (court or venue-wide); also refuses payment proofs for a booking on a closed court | players |
| `COACH_UNAVAILABLE` | the venue isn't verified, outside the coach's weekly windows, or the coach ledger clashes | everyone except trusted jobs |
| `PAYMENT_METHOD_UNAVAILABLE` | venue hasn't set that channel up | everyone |
| `PAY_FIRST` | unpaid e-wallet slot starting inside the payment window | players |
| `HOLD_LIMIT_REACHED` | ≥ `max_active_holds_per_player` unsettled bookings at this venue (unpaid holds, proofs under review, cash requests, pay-at-venue). The message says which and what to do. The venue's own on-behalf entries don't count | players; coached bookings made by staff |
| `SLOT_TAKEN` | `bookings_no_court_overlap` (exclusion constraint) | everyone, always |
| `SLOT_ALREADY_YOURS` | the overlapping booking is the caller's own | everyone |
| `HOLD_EXPIRED` | proof (or method switch) sent after due + grace, whether or not the sweep already cancelled the hold | players |
| `PAYMENT_LOCKED` | a different reference or receipt while the venue is checking the proof, any change once verified, or a method switch after paying | players |
| `RECEIPT_INVALID` | receipt not this booking's own uploaded file | players |
| `CANCELLATION_CLOSED` · `CANCELLATION_CUTOFF` | cancel after start (players and the booked coach); cancel inside the cutoff once confirmed **or** money sent, unless the court is closed then | players |
| `COURT_RESERVED_FOR_EVENT` | organiser cancels/moves a booking a live event uses; staff move it so it no longer covers the event | non-trusted |
| `COURT_BOOKING_REQUIRED` · `COURT_BOOKING_UNAVAILABLE` · `COACH_CONFIRMATION_REQUIRED` | event publishing rules (§6) | organisers |
| `IDEMPOTENCY_KEY_REUSED` | §2 | everyone |

Venue staff (owner, managers) skip the player-only rules. They may record a
session that already started or happened outside hours.

The coach's time is never theirs to give away, though. A coached booking made
by staff follows the player rules: a forced price, no discount, never marked
paid at the desk, pay-first and the hold cap. Coaches are only bookable at
verified venues.

Staff edits keep the insert rules:
* no coach added afterwards;
* the coach's fee can't be edited away;
* a discount stays within court + lights;
* walk-in details only on walk-ins;
* moved or extended bookings are re-priced.

Overlaps are refused for everyone.

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
  slot may already be resold. That holds before and after the sweep cancelled
  the hold, and `describeBooking` then offers `REBOOK`.
  `rebookExpiredHold()` books the same slot again with the reference attached.
  If someone else took it, the player gets `SLOT_TAKEN` and settles with the
  venue (claim records are Step 5).
* **Holds without a deadline.** At venues that confirm cash by hand, a cash
  request stays PENDING with no `payment_due_at`. It never expires on its own.
  It shows as `HOLD` (no `held_until`), counts against the cap, and appears in
  the staff inbox as a `CASH_REQUEST` until the desk confirms or declines it.
  `app.hold_is_dead()` is the single NULL-safe test for "dead hold" used
  everywhere.
* **Reschedules** clear dead holds in the way too, just as new bookings do.
* **Hold cap.** Per player per venue, counted under an advisory lock on the
  booker, so N parallel checkouts can't all slip under the cap (concurrency
  race 9). The refusal names what is pending: unpaid holds, proofs under
  review, cash requests, pay-at-venue bookings.
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
  second row: the booking already commits the coach for its whole range.
* **Lock order.** Every path locks hold rows before ledger rows. When an event
  goes live, the coach's dead holds are expired before its old ledger row is
  replaced, so ledger syncs can't deadlock with bookings.
* **Who can commit a coach:**
  * players, at verified venues;
  * staff, under the player rules (§3).

  The booked coach can cancel a session (before it starts) and lists their
  sessions with `listMyCoachSessions`.
* **Sweeps can't abort.** A status flip that leaves the commitment unchanged
  (CONFIRMED → COMPLETED, SCHEDULED → IN_PROGRESS) skips the ledger. So a
  clash that predates the ledger never aborts the multi-row cron statements.
  Such clashes are reported as warnings by the migration's backfill.

## 6. Events that use a court

An event on a court must link a booking that is the organiser's own, on the
same court, covering the event, and CONFIRMED once the event is live. A DEFINER
trigger writes `bookings.reserved_for_event_id`. From then on:

* concurrent "publish the event" and "cancel or move the booking" serialise
  on the booking row. The reserving UPDATE re-checks the **whole** link (owner,
  court, coverage, CONFIRMED) on the latest row version. So there is no write
  skew: race 6 (cancel) and race 10 (reschedule), under READ COMMITTED and
  REPEATABLE READ;
* the organiser can't cancel or move the booking (`COURT_RESERVED_FOR_EVENT`)
  until the event is cancelled or completed, which releases it;
* venue staff can extend the booking or move it on the same court, as long as
  it still covers the event;
* venue staff can cancel the booking (typhoon, maintenance), and **the event is
  cancelled with it**, with the same reason;
* expiry never touches reserved bookings.

## 7. Front desk

| Need | How |
|---|---|
| Walk-in without an account | `walk_in_name` / `walk_in_phone` on a booking in the staff member's name. Never shown as the staff member's "mine"; staff can fix typos |
| Booking for a registered player | `p_booked_by`, only at **verified** venues and never with a coach. `created_by` records who did it, and contact visibility only counts bookings players made themselves |
| Cash collected now | `p_mark_paid`: one INSERT, CONFIRMED + PAID, verification stamped, no payment window (never for a coach's time) |
| Cash handed over for an e-wallet hold | `reviewPayment` `MARK_CASH_COLLECTED`: the method becomes cash, so the GCash totals reconcile |
| Discount | staff only; off court + lights, never the coach's fee (also on edits) |
| Move or extend a booking | `rescheduleBooking` (same venue; overlaps refused; re-priced) |
| Approve or reject a proof | `reviewPayment` with the reference the reviewer checked. A stale screen (another reviewer acted, the player resubmitted) changes nothing and asks to refresh. Players can't swap a reference under review |
| Refund | `reviewPayment` `REFUND`: before play it cancels the booking, after play it stays completed |
| Cash requests (venues that confirm by hand) | `CONFIRM_CASH_REQUEST`, or decline with `cancelBooking` and a reason |
| Typhoon signal, maintenance | `court_closures` (one court or the whole venue, ≤ 31 days). The creator is stamped by the database, any staff member can edit, and changes are broadcast. `createClosure` returns the live bookings it affects. Players can't pay for those and may cancel whatever the cutoff (bulk cancel is Step 5) |
| Inbox | `listVerificationQueue`, oldest first, with a `kind` per item: `PROOF` to check, `SETTLE` (cancelled while under review), `CASH_REQUEST`, `REFUND_DUE` (cancelled after paying) |

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
* With a coach, only coaches the database would price are offered: verified,
  giving private sessions, coaching the court's sport, at a verified venue,
  and not the viewer. Staff mode flags `payFirst` only for a coach's time.
* The venue view pages the busy RPC below PostgREST's row cap (hosted
  default 1000 rows), so a busy venue can't silently lose its last courts.
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
| `getDayAvailability`, `getVenueDayAvailability`, `quoteBooking` | anyone | the coach grid needs a signed-in user (coach data is members-only); pass `viewerId` from the session |
| `createBooking`, `rebookExpiredHold` | player | idempotency key required |
| `submitPaymentProof`, `attachReceipt`, `switchPaymentMethod`, `cancelBooking`, `listMyBookings` | player | cancel returns `refundDue`; My bookings carries the status label, next action and cancellation terms |
| `listMyCoachSessions`, `cancelBooking` | the booked coach | cancel only, before start |
| `createStaffBooking`, `reviewPayment`, `listVerificationQueue`, `rescheduleBooking`, `cancelBooking`, `createClosure`, `deleteClosure` | venue staff (enforced by the database) | reviews are compare-and-set on what the reviewer saw |

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
| Concurrency (`tests/db/concurrency.sh`) | 24-way slot race → 1 row · 24 double-taps, one key → 1 booking, same id · coach race under REPEATABLE READ → 1 commitment · publish-vs-cancel and publish-vs-reschedule (RC and RR) → 0 skew · 24 players via `create_booking` → 1 booked, 23 clean `SLOT_TAKEN`, 0 deadlocks · double-tap at hold cap − 1 → no false `HOLD_LIMIT_REACHED` · 24 checkouts at a 2-hold venue → exactly 2 |
| Schema lint | anon can call only the busy/quote RPCs · `create_booking` stays INVOKER with no isolation override · triggers installed · ledger unreadable · receive policy present |
| Contract | guard ≡ `checkSlotAgainstCourt` on hours, increments, lead time, horizon, pay-first, closures (same first code) · hold grace · realtime constants · every SQL prefix known to TypeScript · venue policy limits and defaults |
| Integration (PostgREST 13, real JWTs) | §8 parity · 10-player race · lost response · payments, inbox, cancellations, refunds, front desk, closures, coach sessions, My bookings · stale reviews · expired sessions · the error contract on the wire |
| Counts | SQL suite and races: 311 checks · unit 239 · contract 73 · integration 51 |

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
| `cancellationTerms` doesn't know about closures (the database lifts the cutoff while the court is closed; the mirror stays conservative) | Step 5 UI |

## 14. Implementation review

After the build, four reviewers (concurrency, security, TypeScript/parity,
product) went through the code, and an adversarial verifier per lens tried to
refute and reproduce each finding on its own database. Of 32 findings, 29
were confirmed (all but one reproduced), and all 32 were addressed, each with
a regression test (`tests/db/60_booking_engine.sql` round 4, `concurrency.sh` race 10,
`tests/integration/review-fixes.test.ts`).

| Finding | Fix |
|---|---|
| C1 publish-vs-reschedule write skew (high) | the reserving UPDATE re-checks the whole link; race 10 |
| C2/T1 a review applied to a proof the reviewer never saw (high) | reference locked while under review; compare-and-set reviews |
| C3 lock-order inversion in the coach ledger | hold rows before ledger rows on every path |
| C4 reschedules blocked by dead holds | reschedules expire dead holds in the way (not the row being moved) |
| C5/T6/T4/P13 misleading `SLOT_ALREADY_YOURS` | only for a player's own live booking and the court constraint |
| S1/P2 deadline-less cash holds invisible and uncapped (high) | NULL-safe `app.hold_is_dead()`; inbox `CASH_REQUEST`; `CONFIRM_CASH_REQUEST` |
| S2 busy RPCs with NULL dumped every venue | exactly one id; STRICT wrappers; hidden venues stay hidden |
| S3 self-made venues could block a coach for free (high) | coaches only at verified venues; staff coach bookings follow player rules |
| S4 staff edits skipped the insert rules | coach, fee, discount, walk-in rules enforced on UPDATE |
| S5 unbounded free text | length constraints; a reason only with a cancel |
| T2 coach grid offered coaches the DB refuses | sport, private sessions, self, verified venue |
| T3 expired session shown as "something went wrong" | PGRST303 → `UNAUTHENTICATED` |
| T5 retried checkout dropped the new reference | replay applies it |
| T7 Cancel offered on an event's court booking | `blockedBy: "EVENT"` |
| T8 venue grid truncated at PostgREST max-rows | paged fetch |
| T9 Postgres text echoed to users | input validation; system messages never shown |
| P1 late proof after the sweep showed FORBIDDEN (high) | `HOLD_EXPIRED` + `REBOOK` |
| P3 staff couldn't clear an event's court booking (typhoon) | staff cancel cascades to the event |
| P5 refunds owed vanished from every list | inbox `REFUND_DUE`; "Refund pending" label |
| P6 refunds failed unless cancelled first | refund cancels (before play) or stays completed (after) |
| P7 reschedules kept the old price | re-priced |
| P9 coaches couldn't cancel or list sessions | coach cancel policy; `listMyCoachSessions` |
| P11 hold-cap message blamed paid bookings | categories in the message; on-behalf entries excluded |
| P12 couldn't extend a running coached lesson | clock checks only for a new start; `SLOT_IN_PAST` code |

The verifiers judged three product findings overstated, because workarounds
exist or the work was deferred:
* **P4:** extending an event's booking;
* **P8:** payments on a closed court;
* **P10:** switching payment method.

Small, tested versions are in anyway, and none of them loosens a rule:
* staff can extend a reserved booking while it still covers the event;
* no payment proofs while the court is closed;
* the method can be switched while nothing has been paid.
