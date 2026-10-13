import { describe, expect, it } from "vitest";
import {
  acceptedPaymentMethods,
  bookingCancellationSchema,
  busySlotsQuerySchema,
  canPlayerCancel,
  checkSlotAgainstCourt,
  createBookingRequestSchema,
  describeBooking,
  paymentReviewSchema,
  paymentSubmissionSchema,
  toBookingInsert,
  toCancellationUpdate,
  toPaymentReviewUpdate,
  toPaymentSubmissionUpdate,
  type CourtSlotRules,
} from "./booking";
import { mapDatabaseError } from "./errors";
import { toFieldErrors, validate } from "./result";
import { zonedTimeToInstant } from "./time";

const NOW = new Date("2026-10-13T00:00:00Z"); // Tue 08:00 in Manila
const COURT = "20000000-0000-4000-a000-000000000001";
const BOOKING = "30000000-0000-4000-a000-000000000001";
const ALICE = "00000000-0000-4000-a000-000000000002";
const schema = createBookingRequestSchema({ now: () => NOW });

const slot = (date: string, from: string, to: string) => ({
  start_time: zonedTimeToInstant(date, from).toISOString(),
  end_time: zonedTimeToInstant(date, to).toISOString(),
});

const request = (over: Record<string, unknown> = {}) => ({
  court_id: COURT,
  ...slot("2026-10-19", "18:00", "19:00"),
  payment_method: "GCASH",
  ...over,
});

const fieldErrors = (input: unknown) => {
  const r = schema.safeParse(input);
  return r.success ? {} : toFieldErrors(r.error);
};

describe("bookingRequestSchema", () => {
  it("accepts offsets and normalises to UTC", () => {
    const r = schema.parse(
      request({ start_time: "2026-10-19T18:00:00+08:00", end_time: "2026-10-19T19:00:00+08:00" }),
    );
    expect(r.start_time).toBe("2026-10-19T10:00:00.000Z");
  });

  it("refuses client-supplied money, statuses and identity (strict object)", () => {
    for (const key of [
      "total_amount",
      "court_amount",
      "booking_status",
      "payment_status",
      "booked_by",
      "venue_id",
      "discount_amount",
    ]) {
      expect(fieldErrors(request({ [key]: 0 }))).toHaveProperty("");
    }
  });

  it.each([
    ["end before start", slot("2026-10-19", "19:00", "18:00"), "end_time"],
    [
      "off the 15-minute grid",
      { start_time: "2026-10-19T10:10:00.000Z", end_time: "2026-10-19T11:10:00.000Z" },
      "start_time",
    ],
    ["longer than 12 hours", slot("2026-10-19", "06:00", "18:15"), "end_time"],
    ["in the past", slot("2026-10-12", "18:00", "19:00"), "start_time"],
    ["beyond 90 days", slot("2027-01-20", "18:00", "19:00"), "start_time"],
  ])("rejects %s", (_label, times, field) => {
    expect(Object.keys(fieldErrors(request(times)))).toContain(field);
  });

  it("validates reference numbers per payment channel", () => {
    expect(schema.parse(request({ payment_ref_no: "1009 876 543210" })).payment_ref_no).toBe("1009876543210");
    expect(fieldErrors(request({ payment_ref_no: "12345" }))).toHaveProperty("payment_ref_no");
    expect(
      fieldErrors(request({ payment_method: "CASH_ON_COURT", payment_ref_no: "1009876543210" })),
    ).toHaveProperty("payment_ref_no");
    expect(
      schema.safeParse(request({ payment_method: "MAYA", payment_ref_no: "a1b2c3d4e5f6" })).success,
    ).toBe(true);
  });

  it("maps to an insert without any server-owned columns", () => {
    const insert = toBookingInsert(ALICE, schema.parse(request({ notes: "  ", player_count: 4 })));
    expect(insert).toEqual({
      court_id: COURT,
      booked_by: ALICE,
      start_time: "2026-10-19T10:00:00.000Z",
      end_time: "2026-10-19T11:00:00.000Z",
      payment_method: "GCASH",
      player_count: 4,
    });
  });
});

describe("checkSlotAgainstCourt (mirror of the DB guard)", () => {
  const rules: CourtSlotRules = {
    timezone: "Asia/Manila",
    slot_increment_minutes: 30,
    min_booking_minutes: 60,
    max_booking_minutes: 240,
    court_is_active: true,
    venue_is_active: true,
    operating_hours: [1, 2, 3, 4, 5, 6, 0].map((d) => ({
      day_of_week: d,
      opens_at: "06:00:00",
      closes_at: "24:00:00",
    })),
    accepted_payment_methods: ["GCASH", "CASH_ON_COURT"],
  };
  const codes = (
    times: { start_time: string; end_time: string },
    method: "GCASH" | "MAYA" = "GCASH",
    r = rules,
  ) => checkSlotAgainstCourt({ ...times, payment_method: method }, r).map((i) => i.code);

  it.each([
    ["valid", slot("2026-10-19", "18:00", "19:00"), []],
    ["ends exactly at 24:00 closing", slot("2026-10-19", "23:00", "24:00"), []],
    ["off increment", slot("2026-10-19", "18:15", "19:15"), ["OFF_INCREMENT"]],
    ["too short", slot("2026-10-19", "18:00", "18:30"), ["TOO_SHORT"]],
    ["too long", slot("2026-10-19", "10:00", "14:30"), ["TOO_LONG"]],
    ["before opening", slot("2026-10-19", "05:00", "06:00"), ["VENUE_CLOSED"]],
    [
      "crosses midnight into closed hours",
      {
        start_time: zonedTimeToInstant("2026-10-19", "23:30").toISOString(),
        end_time: zonedTimeToInstant("2026-10-20", "00:30").toISOString(),
      },
      ["VENUE_CLOSED"],
    ],
  ] as const)("%s", (_label, times, expected) => {
    expect(codes(times)).toEqual(expected);
  });

  it("flags unavailable payment methods and inactive courts", () => {
    expect(codes(slot("2026-10-19", "18:00", "19:00"), "MAYA")).toEqual(["PAYMENT_METHOD_UNAVAILABLE"]);
    expect(
      codes(slot("2026-10-19", "18:00", "19:00"), "GCASH", { ...rules, court_is_active: false }),
    ).toEqual(["COURT_UNAVAILABLE"]);
  });

  it("treats a venue with no hours as open 24/7", () => {
    expect(codes(slot("2026-10-19", "03:00", "04:00"), "GCASH", { ...rules, operating_hours: [] })).toEqual(
      [],
    );
  });

  it("derives accepted methods from the venue row", () => {
    expect(
      acceptedPaymentMethods({
        accepts_cash_on_court: true,
        gcash_number: "+639170000001",
        maya_number: null,
        bank_transfer_details: null,
      }),
    ).toEqual(["GCASH", "CASH_ON_COURT"]);
  });
});

describe("payment submission & review", () => {
  const submission = {
    booking_id: BOOKING,
    payment_method: "GCASH",
    payment_ref_no: "1009 876 543210",
    receipt_path: `${BOOKING}/gcash.jpg`,
  };

  it("maps a valid submission to AWAITING_VERIFICATION", () => {
    expect(toPaymentSubmissionUpdate(paymentSubmissionSchema.parse(submission))).toEqual({
      payment_ref_no: "1009876543210",
      payment_receipt_url: `${BOOKING}/gcash.jpg`,
      payment_status: "AWAITING_VERIFICATION",
    });
  });

  it.each([
    [
      "receipt in another booking's folder",
      { receipt_path: `30000000-0000-4000-a000-000000000099/gcash.jpg` },
    ],
    ["unsupported receipt type", { receipt_path: `${BOOKING}/gcash.exe` }],
    ["nested receipt path", { receipt_path: `${BOOKING}/a/b.jpg` }],
    ["cash has no proof flow", { payment_method: "CASH_ON_COURT" }],
    ["short GCash ref", { payment_ref_no: "123456" }],
  ])("rejects %s", (_label, over) => {
    expect(paymentSubmissionSchema.safeParse({ ...submission, ...over }).success).toBe(false);
  });

  it("requires a reason to reject and maps every decision", () => {
    expect(paymentReviewSchema.safeParse({ decision: "REJECT", booking_id: BOOKING }).success).toBe(false);
    expect(
      paymentReviewSchema.safeParse({ decision: "APPROVE", booking_id: BOOKING, reason: "x" }).success,
    ).toBe(false);
    expect(
      toPaymentReviewUpdate(
        paymentReviewSchema.parse({ decision: "REJECT", booking_id: BOOKING, reason: "Ref not found" }),
      ),
    ).toEqual({
      payment_status: "REJECTED",
      payment_rejection_reason: "Ref not found",
    });
    expect(toPaymentReviewUpdate({ decision: "APPROVE", booking_id: BOOKING })).toEqual({
      payment_status: "PAID",
    });
    expect(toPaymentReviewUpdate({ decision: "REFUND", booking_id: BOOKING })).toEqual({
      payment_status: "REFUNDED",
    });
  });

  it("builds cancellation updates", () => {
    expect(
      toCancellationUpdate(bookingCancellationSchema.parse({ booking_id: BOOKING, reason: "" })),
    ).toEqual({
      booking_status: "CANCELLED",
    });
  });

  it("limits availability queries to 31 days", () => {
    expect(
      busySlotsQuerySchema.safeParse({
        court_id: COURT,
        from: "2026-10-01T00:00:00Z",
        to: "2026-11-02T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});

describe("describeBooking / canPlayerCancel", () => {
  const b = {
    booking_status: "PENDING_PAYMENT" as const,
    payment_status: "UNPAID" as const,
    payment_method: "GCASH" as const,
    payment_due_at: "2026-10-13T00:30:00Z",
    payment_rejection_reason: null,
    cancellation_reason: null,
    total_amount: 1300,
  };

  it("labels each combined state", () => {
    expect(describeBooking(b, NOW)).toMatchObject({
      label: "Awaiting payment",
      tone: "warning",
      nextAction: "PAY",
    });
    expect(describeBooking(b, NOW).detail).toBe("Send ₱1,300.00 by 8:30 AM to keep this slot.");
    expect(describeBooking(b, new Date("2026-10-13T00:31:00Z")).label).toBe("Payment window closed");
    expect(describeBooking({ ...b, payment_status: "AWAITING_VERIFICATION" }, NOW).nextAction).toBe(
      "WAIT_FOR_VERIFICATION",
    );
    expect(
      describeBooking({ ...b, payment_status: "REJECTED", payment_rejection_reason: "Wrong amount" }, NOW),
    ).toMatchObject({
      nextAction: "RESUBMIT_PAYMENT",
      detail: "Wrong amount",
    });
    expect(
      describeBooking({ ...b, booking_status: "CONFIRMED", payment_method: "CASH_ON_COURT" }, NOW),
    ).toMatchObject({
      nextAction: "PAY_AT_VENUE",
    });
    expect(
      describeBooking(
        { ...b, booking_status: "CANCELLED", cancellation_reason: "PAYMENT_WINDOW_EXPIRED" },
        NOW,
      ).label,
    ).toBe("Expired");
  });

  it("mirrors the guard's cancellation cutoff", () => {
    const confirmed = { booking_status: "CONFIRMED" as const, start_time: "2026-10-14T00:00:00Z" };
    expect(canPlayerCancel(confirmed, 24, NOW)).toBe(true);
    expect(canPlayerCancel(confirmed, 24, new Date("2026-10-13T00:00:01Z"))).toBe(false);
    expect(canPlayerCancel({ ...confirmed, booking_status: "PENDING_PAYMENT" }, 24, NOW)).toBe(true);
    expect(canPlayerCancel({ ...confirmed, booking_status: "COMPLETED" }, 24, NOW)).toBe(false);
  });
});

describe("mapDatabaseError", () => {
  it.each([
    [
      {
        code: "23P01",
        message: 'conflicting key value violates exclusion constraint "bookings_no_court_overlap"',
      },
      "SLOT_TAKEN",
      "start_time",
    ],
    [
      {
        code: "23P01",
        message: 'conflicting key value violates exclusion constraint "bookings_no_coach_overlap"',
      },
      "COACH_UNAVAILABLE",
      "coach_id",
    ],
    [
      {
        code: "23505",
        message: 'duplicate key value violates unique constraint "bookings_payment_ref_unique"',
      },
      "PAYMENT_REF_ALREADY_USED",
      "payment_ref_no",
    ],
    [
      {
        code: "23503",
        message: 'insert or update on table "venues" violates foreign key constraint "venues_barangay_fk"',
      },
      "INVALID_REFERENCE",
      "barangay_code",
    ],
  ])("maps %j", (err, code, field) => {
    expect(mapDatabaseError(err)).toMatchObject({ code, field, retryable: false });
  });

  it("passes guard messages through but hides system messages", () => {
    expect(
      mapDatabaseError({ code: "23514", message: "The venue is closed during part of the selected time." })
        .message,
    ).toBe("The venue is closed during part of the selected time.");
    expect(
      mapDatabaseError({
        code: "23514",
        message: 'new row for relation "bookings" violates check constraint "bookings_total_consistent"',
      }).message,
    ).toBe("That change isn't allowed.");
    expect(
      mapDatabaseError({
        code: "42501",
        message: 'new row violates row-level security policy for table "bookings"',
      }),
    ).toMatchObject({
      code: "FORBIDDEN",
      message: "You don't have permission to do that.",
    });
  });

  it("recognises EVENT_FULL and retryable failures", () => {
    expect(
      mapDatabaseError({ code: "23514", message: "EVENT_FULL: this event and its waitlist are full." }),
    ).toMatchObject({
      code: "EVENT_FULL",
      message: "this event and its waitlist are full.",
    });
    expect(
      mapDatabaseError({ code: "40001", message: "could not serialize access due to concurrent update" }),
    ).toMatchObject({
      code: "RETRYABLE",
      retryable: true,
    });
    expect(mapDatabaseError({ code: "PGRST116" }).code).toBe("NOT_FOUND");
    expect(mapDatabaseError({}).code).toBe("UNKNOWN");
  });
});

describe("validate()", () => {
  it("returns nested field errors keyed by path", () => {
    const r = validate(schema, request({ court_id: "nope", payment_ref_no: "1" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("VALIDATION_FAILED");
      // Zod 4 keeps evaluating cross-field rules after format errors, so users see everything at once.
      expect(Object.keys(r.fieldErrors ?? {})).toEqual(["court_id", "payment_ref_no"]);
    }
  });
});
