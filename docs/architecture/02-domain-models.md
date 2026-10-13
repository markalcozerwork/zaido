# RacketHub · Step 2 · TypeScript models & Zod schemas

> The typed boundary between clients and the database: generated table types,
> Zod schemas for every input in onboarding, venue/court setup and booking,
> pure helpers the UI and server actions share, and the mapping from Postgres
> errors to typed domain errors.

| | |
|---|---|
| Code | `src/db` (generated types), `src/domain` (schemas, mappers, helpers) |
| Stack | TypeScript 6.0.3 (strict) · Zod 4.6.7 · Vitest 5 · all pinned exactly |
| Unit tests | 156 (`npm test`), including a fuzz test that no schema ever throws |
| Contract tests | 62 (`npm run test:contract`): Zod and the TS mirrors run against the real Postgres from Step 1 |
| CI | typecheck · format · unit tests · migrations + SQL tests · stale-types check · contract tests on Postgres 15 and 17 |

---

## 1. Layout

| Module | What it holds |
|---|---|
| `src/db/database.types.ts` | **Generated** from the migrations by `npm run db:types` (Supabase CLI). CI fails if it's stale |
| `src/db/index.ts` | `Row<'bookings'>`, `InsertRow<…>`, `UpdateRow<…>`, `DbEnum<…>`, `RpcArgs<…>`/`RpcReturns<…>` |
| `domain/enums.ts` | `z.enum`s built from the generated `Constants`, plus UI labels |
| `domain/primitives.ts` | PH mobile/landline → E.164, PSGC codes, text squishing, instants, `HH:MM`/`24:00`, storage paths |
| `domain/money.ts` | ₱ amounts in integer centavos, `formatPeso()` → `₱1,250.50` |
| `domain/time.ts` | Venue wall-clock ↔ instant conversion (Intl, DST-correct), zoned parts |
| `domain/onboarding.ts` | Roles (Player / Coach / both / Court owner), profile, private contacts, per-sport player profiles, coach profile + availability |
| `domain/venue.ts` | Venue create/update with GCash/Maya/bank/cash channels, opening hours |
| `domain/court.ts` | Courts, rate rules (peak/weekend), `estimateCourtPrice()` |
| `domain/booking.ts` | Booking request, quote/availability RPC args, slot pre-check, payment proof and review, cancellation, `describeBooking()` |
| `domain/errors.ts` | `mapDatabaseError()`: SQLSTATE + constraint → `DomainError` |
| `domain/result.ts` | `ActionResult<T>` and `validate()` for server actions |
| `domain/limits.ts` | Every length/range limit and column default mirrored from SQL (contract-tested) |

## 2. Design rules

1. **The database schema is the source of truth for types.** Enum values come
   from the generated `Constants`, never from hand-written lists. Label maps
   are typed `Record<Enum, string>`, so adding an enum value in a migration
   makes `tsc` fail until the UI has a label for it.
2. **Strict objects everywhere.** Unknown keys are rejected, which blocks mass
   assignment. A booking request has *no* amount, status or `booked_by`
   field. Sending `total_amount`, `booking_status`, `verified_status`,
   `owner_id` or `is_platform_admin` is a validation error, and the database
   would ignore or reject them anyway.
3. **Normalise, then validate.** `"(0917) 123-4567"` → `+639171234567`;
   `"  Juan   dela Cruz "` → `"Juan dela Cruz"` (length measured like SQL
   `char_length(btrim())`); GCash refs lose the receipt's spaces; DUPR IDs are
   upper-cased (the unique index is case-insensitive); instants become UTC ISO;
   Postgres `"06:00:00"` becomes `"06:00"`.
4. **Defaults live in the database.** Create schemas leave defaulted columns
   optional and the mappers drop `undefined`, so Postgres applies its own
   default. Rules that depend on a default (e.g. "cash counts as a payment
   channel unless switched off") read it from `DB_DEFAULTS`, which a contract
   test compares against `information_schema`.
5. **Create vs update.** Update schemas are `.partial()` with no defaults (in
   Zod 4 a default would silently reset a field on PATCH). Omitted means
   unchanged, `null` means clear.
6. **Mappers produce exact table payloads,** typed against the generated
   `Insert`/`Update` types: `toOnboardingWrites()`, `toVenueInsert()`,
   `toCourtInsert()`, `toBookingInsert()`, `toPaymentSubmissionUpdate()`, …
7. **TypeScript mirrors for instant UX, the database for truth.**
   `estimateCourtPrice()`, `checkSlotAgainstCourt()` and `canPlayerCancel()`
   reimplement the SQL rules, so the calendar can show prices and grey out
   invalid slots without a round-trip. Postgres still recomputes the price
   and enforces every rule on write, and contract tests prove both sides agree.

### Stricter than the database (on purpose)

These catch mistakes early. The database accepts everything Zod accepts, but
not the reverse:

| Rule | Why |
|---|---|
| GCash reference = 13 digits | Catches typos before the venue has to reject the payment |
| Coordinates inside the PH bounding box (Asia/Manila venues) | Catches swapped latitude/longitude |
| A venue needs at least one payment channel | A venue nobody can pay can't take bookings |
| Group clinics need a per-player rate | Prevents ₱0 clinics by omission |
| Payment proof needs both a reference and a receipt path in the booking's own folder, with an image or PDF extension | Matches the GCash/Maya verification flow and the Storage policy |
| Emergency contact: name and number together, different from your own | Data quality |

## 3. Errors

`mapDatabaseError()` accepts a supabase-js `PostgrestError` or a node-postgres
error and returns `{ code, message, field?, retryable }`:

| Database signal | `DomainError.code` | Field |
|---|---|---|
| `23P01` on `bookings_no_court_overlap` | `SLOT_TAKEN` | `start_time` |
| `23P01` on `bookings_no_coach_overlap` | `COACH_UNAVAILABLE` | `coach_id` |
| `23505` on `bookings_payment_ref_unique` | `PAYMENT_REF_ALREADY_USED` | `payment_ref_no` |
| `23505` on slug / phone / DUPR ID | `CONFLICT` | the column |
| `23503` on `*_barangay_fk` | `INVALID_REFERENCE` | `barangay_code` |
| `23514` with `EVENT_FULL:` prefix | `EVENT_FULL` | |
| `23514` from a guard trigger | `RULE_VIOLATION` (guard text shown as-is) | |
| `42501` | `FORBIDDEN` | |
| `40001` / `40P01` | `RETRYABLE` (`retryable: true`) | |
| `P0002` / `PGRST116` | `NOT_FOUND` | |

Guard triggers raise human-readable text, and that text is shown to the user.
Messages Postgres writes itself (RLS, constraint names, "permission denied")
are always replaced with friendly text, so internals never reach the UI.

Server actions return `ActionResult<T>`:

```ts
const input = validate(bookingRequestSchema, formData);    // field errors keyed "coach.hourly_rate", "player_sports.0.rating"
if (!input.ok) return input;
const { data, error } = await supabase.rpc(/* Step 3 */);
if (error) return { ok: false, error: mapDatabaseError(error) };
```

## 4. What the tests prove

**Unit tests (156)** cover every schema, normaliser, mapper and mirror. The
robustness test feeds 23 hostile values (NaN, `"2026-13-45T99:00:00Z"`,
`"../../etc/passwd"`, symbols, BigInt, 2 KB of emoji…) to every exported
schema, and to objects whose every field is hostile, and asserts that
`safeParse` never **throws**. It found a real bug: an invalid timestamp made
`instantSchema` throw `RangeError` (a 500 instead of a 400), because Zod 4
still runs `.overwrite()` after a failed format check.

**Contract tests (62)** run inside rolled-back transactions on a real
database, as a signed-in user with RLS and guard triggers active:

* **Soundness:** maximal valid inputs (every length and amount at its limit,
  all four sports, the hybrid Player + Coach + Court-owner account) go through
  the mappers and are stored.
* **Completeness:** for 44 boundary cases the database rejects (lengths,
  rating ranges per system, DUPR on tennis, duplicate sports/days/amenities,
  duration rules, payment-window limits, unknown time zones, overlapping
  windows…), the test first proves Postgres rejects the raw write, then proves
  Zod rejects the input.
* **Mirror parity:** `estimateCourtPrice` equals `quote_court_booking` on 252
  slots of a week (overlapping rules, lights, centavo rounding) plus a coach
  add-on and a US daylight-saving change. `checkSlotAgainstCourt` agrees with
  the booking guard on 120 candidate slots. `canPlayerCancel` agrees with the
  cutoff.
* **End to end:** request → insert (DB-computed price equals the estimate) →
  GCash proof → venue approval → `CONFIRMED`, plus rejection and resubmission.
* **Errors:** real double-booking, reused reference, RLS denial and guard
  rejection map to the documented codes.

Both suites were **mutation-checked**. Raising a name limit to 121 in Zod, or
introducing an off-by-one in the opening-hours mirror, makes them fail with a
message naming the exact case.

## 5. Tooling notes

* **TypeScript 6.0.3, not 7.** TypeScript 7 (the native compiler) ships no JS
  compiler API (`ts.createProgram` is undefined), which Next.js type-checking
  and typescript-eslint still need. Revisit when they support TS 7.
* **Types are generated with `--db-url`, always,** so local and CI output are
  byte-identical. `npm run db:types` defaults to the local Supabase stack
  (`supabase start`, port 54322). Override with `DATABASE_URL`.

```bash
npm run check                # typecheck + format check + unit tests
npm run db:verify            # Step 1 SQL suite (needs PG* env)
npm run db:types             # regenerate src/db/database.types.ts
PGDATABASE=rackethub_test npm run test:contract
```

## 6. Open points

| Item | Note |
|---|---|
| Inserting bookings | ✅ Step 3: bookings are created through the `create_booking` RPC (`src/server/bookings/create.ts`), whose generated `Args` type needs no amounts |
| Maya reference format | Validated with the generic 6–40 alphanumeric rule. Tighten once a real Maya receipt format is confirmed |
| Minimum age | `birth_date` is only checked for being a real past date. A minimum age is a policy decision (minors and RA 10173 consent) |
| Localisation | Labels are English and keyed by enum value, ready for Filipino/Tagalog copy |
