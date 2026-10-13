/**
 * Booking schemas and the TypeScript mirrors ↔ the real booking engine:
 *   * estimateCourtPrice        ≡ public.quote_court_booking (incl. a DST change)
 *   * checkSlotAgainstCourt     ≡ app.tg_bookings_guard slot rules
 *   * Zod-valid requests/submissions/reviews are accepted under RLS
 *   * real database errors map to the intended DomainError codes
 */
import { describe, expect, it } from "vitest";
import {
  acceptedPaymentMethods,
  canPlayerCancel,
  checkSlotAgainstCourt,
  createBookingRequestSchema,
  describeBooking,
  estimateCourtPrice,
  mapDatabaseError,
  paymentReviewSchema,
  paymentSubmissionSchema,
  toBookingInsert,
  toCancellationUpdate,
  toPaymentReviewUpdate,
  toPaymentSubmissionUpdate,
  toZonedParts,
  addDaysToDate,
  zonedTimeToInstant,
  type CourtSlotRules,
  type RateRulePricing,
} from "../../src/domain";
import type { Row } from "../../src/db";
import {
  LOC,
  createUser,
  createdRow,
  insertSql,
  probe,
  run,
  seedLocations,
  tryRun,
  uniqueGcashRef,
  updateSql,
  useContractDb,
  type Db,
} from "./harness";

const db = useContractDb();

const VENUE = "b0000000-0000-4000-a000-000000000001";
const COURT = "b0000000-0000-4000-a000-000000000002";

/** The Monday at least 8 days from now, in Manila (future, inside the 90-day horizon). */
function nextMonday(): string {
  let d = addDaysToDate(toZonedParts(new Date(), "Asia/Manila").date, 8);
  while (toZonedParts(zonedTimeToInstant(d, "12:00"), "Asia/Manila").dayOfWeek !== 1) d = addDaysToDate(d, 1);
  return d;
}

async function setupVenue(db: Db, timezone = "Asia/Manila") {
  await seedLocations(db);
  const owner = await createUser(db, "Olivia Owner");
  const player = await createUser(db, "Alice Player");
  const coach = await createUser(db, "Carlos Coach");
  await db.exec(
    `insert into public.coach_profiles (profile_id, sports_coached, hourly_rate, verified_status) values ($1, '{PICKLEBALL}', 850.50, 'VERIFIED')`,
    [coach],
  );
  await run(
    db,
    insertSql("venues", {
      id: VENUE,
      owner_id: owner,
      name: "Contract Hub",
      municipality_code: LOC.municipality,
      barangay_code: LOC.barangay,
      address: "1 Contract Street",
      gcash_account_name: "Olivia",
      gcash_number: "+639170000001",
      timezone,
      // Admin-verified: front-desk bookings on behalf of players need it (Step 3).
      verification_status: "VERIFIED",
      max_active_holds_per_player: 50,
    }),
  );
  await run(
    db,
    insertSql("courts", {
      id: COURT,
      venue_id: VENUE,
      name: "Court 1",
      sport: "PICKLEBALL",
      surface_type: "ACRYLIC",
      hourly_rate: 400,
      lights_fee_per_hour: 100.25,
    }),
  );
  await db.exec(
    `insert into public.court_rate_rules (court_id, label, days_of_week, start_time, end_time, hourly_rate, priority) values
       ($1, 'Weeknight peak', '{1,2,3,4,5}', '17:00', '22:00', 600, 10),
       ($1, 'Weekend', '{0,6}', '00:00', '24:00', 700.75, 20),
       ($1, 'Early bird', '{1,2,3,4,5,6,0}', '06:00', '08:00', 333.33, 30)`,
    [COURT],
  );
  await db.exec(
    `insert into public.venue_operating_hours (venue_id, day_of_week, opens_at, closes_at) select $1, d, '06:00', '24:00' from generate_series(0, 6) d`,
    [VENUE],
  );
  return { owner, player, coach };
}

/** Rows exactly as PostgREST would return them (row_to_json: numbers, ISO strings). */
async function loadPricing(db: Db) {
  const [court] = await db.exec<{ j: Row<"courts"> }>(
    `select row_to_json(c) as j from public.courts c where id = $1`,
    [COURT],
  );
  const rules = await db.exec<{ j: RateRulePricing }>(
    `select row_to_json(r) as j from public.court_rate_rules r where court_id = $1`,
    [COURT],
  );
  const [venue] = await db.exec<{ j: Row<"venues"> }>(
    `select row_to_json(v) as j from public.venues v where id = $1`,
    [VENUE],
  );
  return { court: court!.j, rules: rules.map((r) => r.j), venue: venue!.j };
}

async function slotRules(db: Db): Promise<CourtSlotRules> {
  const { court, venue } = await loadPricing(db);
  const hours = await db.exec<{ day_of_week: number; opens_at: string; closes_at: string }>(
    `select day_of_week, opens_at::text, closes_at::text from public.venue_operating_hours where venue_id = $1`,
    [VENUE],
  );
  return {
    timezone: venue.timezone,
    slot_increment_minutes: court.slot_increment_minutes,
    min_booking_minutes: court.min_booking_minutes,
    max_booking_minutes: court.max_booking_minutes,
    court_is_active: court.is_active,
    venue_is_active: venue.is_active,
    operating_hours: hours,
    accepted_payment_methods: acceptedPaymentMethods(venue),
  };
}

const quote = async (db: Db, start: Date, end: Date, coach?: string) => {
  const [q] = await db.exec<Record<string, string>>(
    `select court_amount::float8, lights_amount::float8, coach_amount::float8, total_amount::float8
       from public.quote_court_booking($1, $2, $3, $4)`,
    [COURT, start.toISOString(), end.toISOString(), coach ?? null],
  );
  return q;
};

describe("estimateCourtPrice ≡ quote_court_booking", () => {
  it("agrees on every slot of a week (rates, overlapping rules, lights, centavo rounding)", async () => {
    await setupVenue(db);
    const { court, rules } = await loadPricing(db);
    const monday = nextMonday();
    let compared = 0;
    for (let day = 0; day < 7; day++) {
      const date = addDaysToDate(monday, day);
      for (const from of ["00:00", "05:45", "06:00", "07:30", "16:45", "17:00", "21:30", "22:00", "23:15"]) {
        for (const minutes of [15, 60, 105, 240]) {
          const start = zonedTimeToInstant(date, from);
          const end = new Date(start.getTime() + minutes * 60_000);
          const ts = estimateCourtPrice({ court, rules, start, end, timeZone: "Asia/Manila" });
          expect(ts, `${date} ${from} +${minutes}m`).toEqual({ ...(await quote(db, start, end)) });
          compared++;
        }
      }
    }
    expect(compared).toBe(7 * 9 * 4);
  });

  it("agrees with a coach add-on", async () => {
    const { coach } = await setupVenue(db);
    const { court, rules } = await loadPricing(db);
    const start = zonedTimeToInstant(nextMonday(), "18:00");
    const end = new Date(start.getTime() + 75 * 60_000);
    expect(
      estimateCourtPrice({ court, rules, start, end, timeZone: "Asia/Manila", coachHourlyRate: 850.5 }),
    ).toEqual({
      ...(await quote(db, start, end, coach)),
    });
  });

  it("agrees across a daylight-saving change for a non-PH venue", async () => {
    await setupVenue(db, "America/New_York");
    const { court, rules } = await loadPricing(db);
    // US clocks fall back at 02:00 on Sunday 2026-11-01.
    for (const [date, from, minutes] of [
      ["2026-10-31", "22:00", 360],
      ["2026-11-01", "00:30", 240],
      ["2026-11-01", "05:00", 120],
    ] as const) {
      const start = zonedTimeToInstant(date, from, "America/New_York");
      const end = new Date(start.getTime() + minutes * 60_000);
      expect(
        estimateCourtPrice({ court, rules, start, end, timeZone: "America/New_York" }),
        `${date} ${from}`,
      ).toEqual({
        ...(await quote(db, start, end)),
      });
    }
  });
});

describe("checkSlotAgainstCourt ≡ the database guard (as a player, RLS on)", () => {
  it("accepts and rejects exactly the same candidate slots", async () => {
    const { player } = await setupVenue(db);
    const rules = await slotRules(db);
    await db.asUser(player);

    const monday = nextMonday();
    const saturday = addDaysToDate(monday, 5);
    let agreed = 0;
    for (const date of [monday, saturday]) {
      for (const from of [
        "05:00",
        "05:30",
        "06:00",
        "06:15",
        "06:30",
        "12:00",
        "21:00",
        "22:30",
        "23:00",
        "23:30",
      ]) {
        for (const minutes of [30, 60, 75, 90, 240, 270]) {
          const start = zonedTimeToInstant(date, from);
          const end = new Date(start.getTime() + minutes * 60_000);
          const req = {
            start_time: start.toISOString(),
            end_time: end.toISOString(),
            payment_method: "GCASH" as const,
          };
          const predicted = checkSlotAgainstCourt(req, rules);
          const actual = await probe(
            db,
            insertSql("bookings", { court_id: COURT, booked_by: player, ...req }),
          );
          expect(
            actual.ok,
            `${date} ${from} +${minutes}m → TS says ${JSON.stringify(predicted.map((i) => i.code))}`,
          ).toBe(predicted.length === 0);
          agreed++;
        }
      }
    }
    expect(agreed).toBe(2 * 10 * 6);
  });
});

describe("end-to-end booking flow with the schemas", () => {
  it("request → insert → submit GCash proof → venue approves; amounts match the estimate", async () => {
    const { owner, player } = await setupVenue(db);
    const { court, rules } = await loadPricing(db);
    const start = zonedTimeToInstant(nextMonday(), "18:00");
    const end = new Date(start.getTime() + 90 * 60_000);

    const req = createBookingRequestSchema().parse({
      court_id: COURT,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      payment_method: "GCASH",
      player_count: 4,
    });
    await db.asUser(player);
    const booking = createdRow<Row<"bookings">>(
      await tryRun(db, insertSql("bookings", toBookingInsert(player, req), "row_to_json(bookings) as j")),
    );
    expect(booking.total_amount).toBe(
      estimateCourtPrice({ court, rules, start, end, timeZone: "Asia/Manila" }).total_amount,
    );
    expect(describeBooking(booking)).toMatchObject({ label: "Awaiting payment", nextAction: "PAY" });

    // Step 3: the receipt must exist in the booking's own folder before it's submitted.
    await run(
      db,
      insertSql(
        "storage.objects",
        { bucket_id: "payment-receipts", name: `${booking.id}/gcash.png` },
        "name",
      ),
    );
    const submission = paymentSubmissionSchema.parse({
      booking_id: booking.id,
      payment_method: "GCASH",
      payment_ref_no: uniqueGcashRef(),
      receipt_path: `${booking.id}/gcash.png`,
    });
    const submitted = await tryRun(
      db,
      updateSql("bookings", toPaymentSubmissionUpdate(submission), { id: booking.id }),
    );
    expect(submitted.ok && submitted.rows[0]?.payment_status).toBe("AWAITING_VERIFICATION");

    await db.asAdmin();
    await db.asUser(owner);
    const review = paymentReviewSchema.parse({ decision: "APPROVE", booking_id: booking.id });
    const approved = await tryRun(
      db,
      updateSql("bookings", toPaymentReviewUpdate(review), { id: booking.id }),
    );
    expect(approved.ok && approved.rows[0]).toMatchObject({
      booking_status: "CONFIRMED",
      payment_status: "PAID",
    });
  });

  it("rejection with a reason, then resubmission", async () => {
    const { owner, player } = await setupVenue(db);
    const start = zonedTimeToInstant(nextMonday(), "10:00");
    await db.asUser(player);
    const { id } = createdRow<Row<"bookings">>(
      await tryRun(
        db,
        insertSql(
          "bookings",
          {
            court_id: COURT,
            booked_by: player,
            start_time: start.toISOString(),
            end_time: new Date(start.getTime() + 3_600_000).toISOString(),
            payment_method: "GCASH",
            payment_ref_no: uniqueGcashRef(),
          },
          "row_to_json(bookings) as j",
        ),
      ),
    );
    await db.asAdmin();
    await db.asUser(owner);
    const reject = toPaymentReviewUpdate(
      paymentReviewSchema.parse({
        decision: "REJECT",
        booking_id: id,
        reason: "Reference not found in GCash",
      }),
    );
    expect(await tryRun(db, updateSql("bookings", reject, { id }))).toMatchObject({ ok: true });
    await db.asAdmin();
    await db.asUser(player);
    await run(
      db,
      insertSql("storage.objects", { bucket_id: "payment-receipts", name: `${id}/retry.jpg` }, "name"),
    );
    const resubmit = toPaymentSubmissionUpdate(
      paymentSubmissionSchema.parse({
        booking_id: id,
        payment_method: "GCASH",
        payment_ref_no: uniqueGcashRef(),
        receipt_path: `${id}/retry.jpg`,
      }),
    );
    const r = await tryRun(db, updateSql("bookings", resubmit, { id }));
    expect(r.ok && r.rows[0]?.payment_status).toBe("AWAITING_VERIFICATION");
  });

  it("canPlayerCancel agrees with the guard's cutoff", async () => {
    const { owner, player } = await setupVenue(db);
    await db.asUser(owner);
    // Front desk books a cash walk-in for the player starting in ~2 hours (inside the 24h cutoff)…
    const soon = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 2 * 3_600_000);
    const near = await tryRun(
      db,
      insertSql(
        "bookings",
        {
          court_id: COURT,
          booked_by: player,
          start_time: soon.toISOString(),
          end_time: new Date(soon.getTime() + 3_600_000).toISOString(),
          payment_method: "CASH_ON_COURT",
        },
        "row_to_json(bookings) as j",
      ),
    );
    // …and one next week.
    const far = zonedTimeToInstant(nextMonday(), "12:00");
    const later = await tryRun(
      db,
      insertSql(
        "bookings",
        {
          court_id: COURT,
          booked_by: player,
          start_time: far.toISOString(),
          end_time: new Date(far.getTime() + 3_600_000).toISOString(),
          payment_method: "CASH_ON_COURT",
        },
        "row_to_json(bookings) as j",
      ),
    );
    await db.asAdmin();
    await db.asUser(player);

    for (const created of [near, later]) {
      const b = createdRow<Row<"bookings">>(created);
      expect(b.booking_status).toBe("CONFIRMED");
      const predicted = canPlayerCancel(b, 24);
      const actual = await probe(
        db,
        updateSql("bookings", toCancellationUpdate({ booking_id: b.id, reason: undefined }), { id: b.id }),
      );
      expect(actual.ok, `start ${b.start_time}`).toBe(predicted);
    }
  });
});

describe("real database errors → DomainError", () => {
  it("double booking → SLOT_TAKEN; reused GCash ref → PAYMENT_REF_ALREADY_USED; RLS → FORBIDDEN; guard text passes through", async () => {
    const { player, coach } = await setupVenue(db);
    const start = zonedTimeToInstant(nextMonday(), "12:00");
    const row = {
      court_id: COURT,
      booked_by: player,
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + 3_600_000).toISOString(),
      payment_method: "GCASH",
      payment_ref_no: uniqueGcashRef(),
    };
    await db.asUser(player);
    expect(await tryRun(db, insertSql("bookings", row))).toMatchObject({ ok: true });

    const overlap = await tryRun(
      db,
      insertSql("bookings", {
        ...row,
        payment_ref_no: undefined,
        start_time: new Date(start.getTime() + 1_800_000).toISOString(),
        end_time: new Date(start.getTime() + 5_400_000).toISOString(),
      }),
    );
    const reused = await tryRun(
      db,
      insertSql("bookings", {
        ...row,
        start_time: new Date(start.getTime() + 7_200_000).toISOString(),
        end_time: new Date(start.getTime() + 10_800_000).toISOString(),
      }),
    );
    const forbidden = await tryRun(
      db,
      insertSql("bookings", {
        ...row,
        payment_ref_no: undefined,
        booked_by: coach,
        start_time: new Date(start.getTime() + 14_400_000).toISOString(),
        end_time: new Date(start.getTime() + 18_000_000).toISOString(),
      }),
    );
    const closed = await tryRun(
      db,
      insertSql("bookings", {
        ...row,
        payment_ref_no: undefined,
        start_time: zonedTimeToInstant(nextMonday(), "05:00").toISOString(),
        end_time: zonedTimeToInstant(nextMonday(), "06:00").toISOString(),
      }),
    );

    const codes = [overlap, reused, forbidden, closed].map((r) => (r.ok ? "ACCEPTED" : mapDatabaseError(r)));
    expect(codes[0]).toMatchObject({ code: "SLOT_TAKEN", field: "start_time" });
    expect(codes[1]).toMatchObject({ code: "PAYMENT_REF_ALREADY_USED", field: "payment_ref_no" });
    expect(codes[2]).toMatchObject({ code: "FORBIDDEN", message: "You can only book for yourself." });
    expect(codes[3]).toMatchObject({
      code: "VENUE_CLOSED",
      field: "start_time",
      message: "The venue is closed during part of the selected time.",
    });
  });
});
