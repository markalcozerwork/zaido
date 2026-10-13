/**
 * Court booking reservations: request, quote, availability, payment
 * submission and review, cancellation, and the UI view of a booking's state.
 *
 * Trust model:
 *   * Requests never carry amounts or statuses. The schemas are strict, so a
 *     client can't mass-assign `total_amount` or `booking_status`. Postgres
 *     prices the booking and sets its state (see app.tg_bookings_guard).
 *   * `checkSlotAgainstCourt` mirrors the database slot rules for instant
 *     feedback. The database still enforces them, plus the exclusion
 *     constraint that makes double-booking impossible.
 */
import { z } from "zod";
import type { InsertRow, Row, RpcArgs, RpcReturns, UpdateRow } from "../db";
import { paymentMethodSchema, type PaymentMethod } from "./enums";
import { GUARD_CODES, type DomainError, type GuardCode } from "./errors";
import { LIMITS } from "./limits";
import { formatPeso, pesoAmountSchema } from "./money";
import { compact } from "./object";
import {
  instantSchema,
  isValidInstant,
  line,
  minutesSinceMidnight,
  optionalLine,
  optionalParagraphs,
  phPhoneSchema,
  storagePathSchema,
  uuidSchema,
} from "./primitives";
import { addDaysToDate, addMinutes, isOnMinuteGrid, minutesBetween, toZonedParts } from "./time";

// -----------------------------------------------------------------------------
// Payment reference numbers
// -----------------------------------------------------------------------------
export type EwalletMethod = Exclude<PaymentMethod, "CASH_ON_COURT">;

/** Strip the spaces people copy from receipts ("1009 876 543210") and upper-case. */
export const normalizePaymentRef = (raw: string): string => raw.replace(/\s+/g, "").toUpperCase();

/**
 * Per-channel format checks, stricter than the database's generic
 * `^[A-Za-z0-9-]{6,40}$` so typos are caught before the venue has to reject.
 * GCash reference numbers are 13 digits. Maya and bank references vary, so
 * they use the generic rule.
 */
export const PAYMENT_REF_RULES: Record<EwalletMethod, { pattern: RegExp; hint: string }> = {
  GCASH: { pattern: /^\d{13}$/, hint: "GCash reference numbers have 13 digits, e.g. 1009 876 543210." },
  MAYA: { pattern: /^[A-Z0-9]{6,40}$/, hint: "Copy the reference ID from your Maya receipt." },
  BANK_TRANSFER: { pattern: /^[A-Z0-9-]{6,40}$/, hint: "Copy the reference number from your bank receipt." },
};

export function paymentRefIssue(method: PaymentMethod, ref: string): string | null {
  if (method === "CASH_ON_COURT") return "Cash bookings don't need a reference number.";
  const rule = PAYMENT_REF_RULES[method];
  return rule.pattern.test(ref) && LIMITS.paymentRef.pattern.test(ref) ? null : rule.hint;
}

const paymentRefSchema = z.string({ error: "Enter the reference number." }).overwrite(normalizePaymentRef);

// -----------------------------------------------------------------------------
// Booking request (player)
// -----------------------------------------------------------------------------
export interface BookingRequestOptions {
  /** Clock injection for tests and for server-side "now". */
  now?: () => Date;
}

const bookingRequestFields = {
  court_id: uuidSchema,
  start_time: instantSchema,
  end_time: instantSchema,
  coach_id: uuidSchema.optional(),
  payment_method: paymentMethodSchema,
  /** Optional at booking time: players may paste the GCash/Maya reference right away. */
  payment_ref_no: paymentRefSchema.optional(),
  player_count: z
    .number()
    .int()
    .min(LIMITS.booking.playerCount.min)
    .max(LIMITS.booking.playerCount.max)
    .optional(),
  notes: optionalParagraphs(500),
};

type RequestShape = {
  start_time: string;
  end_time: string;
  payment_method: PaymentMethod;
  payment_ref_no?: string | undefined;
};

/** Shape rules every booking request shares: order, 15-minute grid, 12-hour cap, reference format. */
function checkRequestShape(b: RequestShape, ctx: z.RefinementCtx): boolean {
  // Malformed instants are already reported by the field schema.
  if (!isValidInstant(b.start_time) || !isValidInstant(b.end_time)) return false;
  const start = new Date(b.start_time);
  const end = new Date(b.end_time);
  const grid = LIMITS.booking.gridMinutes;

  if (end <= start) {
    ctx.addIssue({ code: "custom", path: ["end_time"], message: "End time must be after start time." });
  } else {
    if (!isOnMinuteGrid(start, grid) || !isOnMinuteGrid(end, grid)) {
      ctx.addIssue({
        code: "custom",
        path: ["start_time"],
        message: "Bookings start and end on 15-minute marks.",
      });
    }
    if (minutesBetween(start, end) > LIMITS.booking.maxDurationMinutes) {
      ctx.addIssue({
        code: "custom",
        path: ["end_time"],
        message: "A single booking can be at most 12 hours.",
      });
    }
  }

  if (b.payment_ref_no !== undefined) {
    const problem = paymentRefIssue(b.payment_method, b.payment_ref_no);
    if (problem) ctx.addIssue({ code: "custom", path: ["payment_ref_no"], message: problem });
  }
  return true;
}

/**
 * Platform-wide time sanity for player requests. Venue rules (lead time, the
 * day-based horizon in venue time, hours, closures) are checked against the
 * court with `checkSlotAgainstCourt`, so this ceiling sits one day beyond the
 * longest horizon a venue can set and never rejects what the venue accepts.
 */
function checkRequestTime(b: RequestShape, now: Date, ctx: z.RefinementCtx) {
  const start = new Date(b.start_time);
  if (start < now) {
    ctx.addIssue({ code: "custom", path: ["start_time"], message: "That time has already passed." });
  } else if (start > addMinutes(now, (LIMITS.booking.maxAdvanceDays + 1) * 24 * 60)) {
    ctx.addIssue({
      code: "custom",
      path: ["start_time"],
      message: `Bookings open up to ${LIMITS.booking.maxAdvanceDays} days ahead.`,
    });
  }
}

export function createBookingRequestSchema({ now = () => new Date() }: BookingRequestOptions = {}) {
  return z.strictObject(bookingRequestFields).superRefine((b, ctx) => {
    if (checkRequestShape(b, ctx)) checkRequestTime(b, now(), ctx);
  });
}

export const bookingRequestSchema = createBookingRequestSchema();
export type BookingRequestInput = z.input<typeof bookingRequestSchema>;
export type BookingRequest = z.output<typeof bookingRequestSchema>;

/**
 * What the create-booking server action accepts: the request plus the
 * checkout's idempotency key. The client generates the key once per checkout
 * (crypto.randomUUID()) and reuses it on every retry and double-tap, so a
 * lost response can never create a second booking.
 *
 * Shape only: time rules (past, lead time, horizon) are the database's, so
 * the action returns the same typed code (SLOT_IN_PAST, TOO_SOON, …) the
 * availability grid predicts. The form schema above keeps them for instant
 * feedback.
 */
export const bookingActionSchema = z
  .strictObject({ ...bookingRequestFields, idempotency_key: uuidSchema })
  .superRefine((b, ctx) => {
    checkRequestShape(b, ctx);
  });
export type BookingActionInput = z.input<typeof bookingActionSchema>;
export type BookingAction = z.output<typeof bookingActionSchema>;

/**
 * Front-desk bookings (venue staff). The database decides who counts as staff
 * and skips the player-only slot rules for them (past, lead time, horizon,
 * hours, closures), so only shape is checked here.
 *   * `booked_by`: book in a registered player's name (verified venues only,
 *     never with a coach).
 *   * `walk_in_name` / `walk_in_phone`: a player without an account; the
 *     booking stays in the staff member's name.
 *   * `discount_amount`: off the court and lights amount, never the coach fee.
 *   * `mark_paid`: payment collected at the desk now (confirms the booking).
 */
export const staffBookingSchema = z
  .strictObject({
    ...bookingRequestFields,
    idempotency_key: uuidSchema,
    booked_by: uuidSchema.optional(),
    walk_in_name: optionalLine(LIMITS.booking.walkInName.min, LIMITS.booking.walkInName.max),
    walk_in_phone: phPhoneSchema.optional(),
    discount_amount: pesoAmountSchema().optional(),
    mark_paid: z.boolean().optional(),
  })
  .superRefine((b, ctx) => {
    checkRequestShape(b, ctx);
    if (b.walk_in_phone !== undefined && b.walk_in_name === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["walk_in_name"],
        message: "Add the walk-in player's name with their number.",
      });
    }
    if (b.booked_by !== undefined && (b.walk_in_name !== undefined || b.walk_in_phone !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["walk_in_name"],
        message: "Book either for a registered player or for a walk-in, not both.",
      });
    }
    if (b.booked_by !== undefined && b.coach_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["coach_id"],
        message: "Coach sessions can only be booked by the player.",
      });
    }
  });

export type StaffBookingInput = z.input<typeof staffBookingSchema>;
export type StaffBooking = z.output<typeof staffBookingSchema>;

/** Columns the database owns on insert (price, state, stamps, identity). */
type ServerOwnedBookingColumns =
  | "id"
  | "reference_code"
  | "venue_id"
  | "time_range"
  | "court_amount"
  | "lights_amount"
  | "coach_amount"
  | "discount_amount"
  | "total_amount"
  | "booking_status"
  | "payment_status"
  | "payment_due_at"
  | "payment_submitted_at"
  | "payment_verified_at"
  | "payment_verified_by"
  | "payment_rejection_reason"
  | "confirmed_at"
  | "cancelled_at"
  | "cancelled_by"
  | "cancellation_reason"
  | "completed_at"
  | "created_at"
  | "updated_at";

/**
 * What a player's booking insert may contain. `court_amount`, `total_amount`
 * and `venue_id` are NOT NULL in the table but filled by the BEFORE INSERT
 * guard, so this deliberately isn't assignable to the generated Insert type.
 * Step 3 sends it through a server action/RPC.
 */
export type PlayerBookingInsert = Omit<InsertRow<"bookings">, ServerOwnedBookingColumns>;

export function toBookingInsert(bookedBy: string, req: BookingRequest): PlayerBookingInsert {
  return compact({
    court_id: req.court_id,
    booked_by: bookedBy,
    coach_id: req.coach_id,
    start_time: req.start_time,
    end_time: req.end_time,
    payment_method: req.payment_method,
    payment_ref_no: req.payment_ref_no,
    player_count: req.player_count,
    notes: req.notes,
  });
}

// -----------------------------------------------------------------------------
// Quotes & availability (RPC inputs)
// -----------------------------------------------------------------------------
export const quoteRequestSchema = z
  .strictObject({
    court_id: uuidSchema,
    start_time: instantSchema,
    end_time: instantSchema,
    coach_id: uuidSchema.optional(),
  })
  .refine(
    (q) =>
      !isValidInstant(q.start_time) ||
      !isValidInstant(q.end_time) ||
      new Date(q.end_time) > new Date(q.start_time),
    {
      error: "End time must be after start time.",
      path: ["end_time"],
    },
  );

export type BookingQuote = RpcReturns<"quote_court_booking">[number];

export function toQuoteArgs(q: z.output<typeof quoteRequestSchema>): RpcArgs<"quote_court_booking"> {
  return compact({
    p_court_id: q.court_id,
    p_start: q.start_time,
    p_end: q.end_time,
    p_coach_id: q.coach_id,
  });
}

export const busySlotsQuerySchema = z
  .strictObject({ court_id: uuidSchema, from: instantSchema, to: instantSchema })
  .refine((q) => !isValidInstant(q.from) || !isValidInstant(q.to) || new Date(q.to) > new Date(q.from), {
    error: "Invalid range.",
    path: ["to"],
  })
  .refine(
    (q) =>
      !isValidInstant(q.from) ||
      !isValidInstant(q.to) ||
      minutesBetween(new Date(q.from), new Date(q.to)) <= 31 * 24 * 60,
    {
      error: "Range is limited to 31 days.",
      path: ["to"],
    },
  );

/**
 * One busy range on a court. `kind`: BOOKED (confirmed or payment under
 * review), HOLD (unpaid; frees itself at `held_until` unless paid; null =
 * held until the venue decides, e.g. unconfirmed cash) or CLOSED (a court
 * closure, with its `reason`). `is_mine` / `booking_id` only for the caller's
 * own player bookings.
 */
export type BusySlot = RpcReturns<"get_court_busy_slots">[number];
export type VenueBusySlot = RpcReturns<"get_venue_busy_slots">[number];
export type BusyKind = "BOOKED" | "HOLD" | "CLOSED";

export function toBusySlotsArgs(q: z.output<typeof busySlotsQuerySchema>): RpcArgs<"get_court_busy_slots"> {
  return { p_court_id: q.court_id, p_from: q.from, p_to: q.to };
}

// -----------------------------------------------------------------------------
// Slot pre-check (mirror of the database guard's slot rules)
// -----------------------------------------------------------------------------
export interface CourtSlotRules {
  timezone: string;
  slot_increment_minutes: number;
  min_booking_minutes: number;
  max_booking_minutes: number;
  court_is_active: boolean;
  venue_is_active: boolean;
  /** Venue-local weekly windows. Empty = no published hours (see `is_open_24h`). */
  operating_hours: ReadonlyArray<{ day_of_week: number; opens_at: string; closes_at: string }>;
  /** Without hours, players can book only when the venue is explicitly open 24/7. */
  is_open_24h: boolean;
  accepted_payment_methods: readonly PaymentMethod[];
  min_lead_minutes: number;
  /** Calendar days ahead in venue time: a whole day opens at local midnight. */
  booking_horizon_days: number;
  payment_window_minutes: number;
  /** Closures affecting this court (venue-wide ones included). */
  closures: ReadonlyArray<{ starts_at: string; ends_at: string }>;
}

/** The guard codes `checkSlotAgainstCourt` can predict, in the order the guard raises them. */
export const SLOT_ISSUE_CODES = [
  "COURT_INACTIVE",
  "SLOT_IN_PAST",
  "TOO_SOON",
  "BEYOND_HORIZON",
  "OFF_INCREMENT",
  "DURATION_OUT_OF_RANGE",
  "VENUE_CLOSED",
  "VENUE_HOURS_NOT_SET",
  "COURT_CLOSED",
  "PAYMENT_METHOD_UNAVAILABLE",
  "PAY_FIRST",
] as const satisfies readonly GuardCode[];

export type SlotIssueCode = (typeof SLOT_ISSUE_CODES)[number];

export interface SlotIssue {
  code: SlotIssueCode;
  /** Same text the database raises (after the "CODE: " prefix). */
  message: string;
}

/** A slot issue as the DomainError the database would have produced. */
export function slotIssueToError(issue: SlotIssue): DomainError {
  const field = GUARD_CODES[issue.code];
  return { code: issue.code, message: issue.message, retryable: false, ...(field ? { field } : {}) };
}

/** Payment methods a venue row has set up (same rule as the guard). */
export function acceptedPaymentMethods(
  venue: Pick<
    Row<"venues">,
    "accepts_cash_on_court" | "gcash_number" | "maya_number" | "bank_transfer_details"
  >,
): PaymentMethod[] {
  const methods: PaymentMethod[] = [];
  if (venue.gcash_number) methods.push("GCASH");
  if (venue.maya_number) methods.push("MAYA");
  if (venue.bank_transfer_details) methods.push("BANK_TRANSFER");
  if (venue.accepts_cash_on_court) methods.push("CASH_ON_COURT");
  return methods;
}

/**
 * Same algorithm as app.is_within_operating_hours: every 15-minute slice must
 * sit inside a window. No windows → true (whether that means "open" is the
 * caller's call: see `is_open_24h`).
 */
export function isWithinOperatingHours(
  start: Date,
  end: Date,
  rules: Pick<CourtSlotRules, "timezone" | "operating_hours">,
): boolean {
  if (rules.operating_hours.length === 0) return true;
  const slice = LIMITS.booking.gridMinutes;
  for (let t = start; t < end; t = addMinutes(t, slice)) {
    const local = toZonedParts(t, rules.timezone);
    const covered = rules.operating_hours.some(
      (h) =>
        h.day_of_week === local.dayOfWeek &&
        local.minuteOfDay >= minutesSinceMidnight(h.opens_at) &&
        local.minuteOfDay + slice <= minutesSinceMidnight(h.closes_at),
    );
    if (!covered) return false;
  }
  return true;
}

/** Day-based horizon, like the guard: the venue-local start date vs today + N days. */
export function isBeyondHorizon(start: Date, now: Date, timeZone: string, horizonDays: number): boolean {
  return toZonedParts(start, timeZone).date > addDaysToDate(toZonedParts(now, timeZone).date, horizonDays);
}

/** Half-open [a1, a2) ∩ [b1, b2) ≠ ∅ (Postgres `&&` on '[)' ranges). */
export const rangesOverlap = (a1: Date, a2: Date, b1: Date, b2: Date): boolean => a1 < b2 && b1 < a2;

export function isCourtClosed(start: Date, end: Date, rules: Pick<CourtSlotRules, "closures">): boolean {
  return rules.closures.some((c) => rangesOverlap(start, end, new Date(c.starts_at), new Date(c.ends_at)));
}

const PAYMENT_METHOD_UNAVAILABLE_TEXT: Record<PaymentMethod, string> = {
  CASH_ON_COURT: "This venue does not accept cash on court.",
  GCASH: "This venue has not set up GCash payments.",
  MAYA: "This venue has not set up Maya payments.",
  BANK_TRANSFER: "This venue has not set up bank transfers.",
};

/**
 * Mirror of the guard's player rules for a new booking, in the guard's order
 * (the first issue is what the database would raise). The database still
 * decides; this gives instant feedback and saves a round trip.
 */
export function checkSlotAgainstCourt(
  req: Pick<BookingRequest, "start_time" | "end_time" | "payment_method"> & {
    payment_ref_no?: string | undefined;
  },
  rules: CourtSlotRules,
  now: Date = new Date(),
): SlotIssue[] {
  const issues: SlotIssue[] = [];
  const start = new Date(req.start_time);
  const end = new Date(req.end_time);
  const minutes = minutesBetween(start, end);
  const inc = rules.slot_increment_minutes;

  if (!rules.court_is_active || !rules.venue_is_active) {
    issues.push({ code: "COURT_INACTIVE", message: "This court is not accepting bookings." });
  }
  if (start < now) {
    issues.push({ code: "SLOT_IN_PAST", message: "That time has already started. Pick another slot." });
  }
  if (start < addMinutes(now, rules.min_lead_minutes)) {
    issues.push({
      code: "TOO_SOON",
      message: `This venue takes bookings at least ${rules.min_lead_minutes} minutes ahead.`,
    });
  }
  if (isBeyondHorizon(start, now, rules.timezone, rules.booking_horizon_days)) {
    issues.push({
      code: "BEYOND_HORIZON",
      message: `This venue takes bookings up to ${rules.booking_horizon_days} days ahead.`,
    });
  }
  if (toZonedParts(start, rules.timezone).minuteOfDay % inc !== 0 || minutes % inc !== 0) {
    issues.push({ code: "OFF_INCREMENT", message: `This court books in ${inc}-minute increments.` });
  }
  if (minutes < rules.min_booking_minutes || minutes > rules.max_booking_minutes) {
    issues.push({
      code: "DURATION_OUT_OF_RANGE",
      message: `Booking length must be between ${rules.min_booking_minutes} and ${rules.max_booking_minutes} minutes.`,
    });
  }
  if (rules.operating_hours.length > 0) {
    if (!isWithinOperatingHours(start, end, rules)) {
      issues.push({ code: "VENUE_CLOSED", message: "The venue is closed during part of the selected time." });
    }
  } else if (!rules.is_open_24h) {
    issues.push({
      code: "VENUE_HOURS_NOT_SET",
      message: "This venue hasn't published its opening hours yet.",
    });
  }
  if (isCourtClosed(start, end, rules)) {
    issues.push({ code: "COURT_CLOSED", message: "The court is closed during part of the selected time." });
  }
  if (!rules.accepted_payment_methods.includes(req.payment_method)) {
    issues.push({
      code: "PAYMENT_METHOD_UNAVAILABLE",
      message: PAYMENT_METHOD_UNAVAILABLE_TEXT[req.payment_method],
    });
  }
  if (needsPaymentFirst(start, req.payment_method, req.payment_ref_no, rules.payment_window_minutes, now)) {
    issues.push({
      code: "PAY_FIRST",
      message: `This slot starts within ${rules.payment_window_minutes} minutes. Send the payment first, then book with your reference number.`,
    });
  }
  return issues;
}

/**
 * An unpaid e-wallet hold that would only expire after the session starts
 * would let the court be resold mid-game, so such slots need the reference
 * number up front.
 */
export function needsPaymentFirst(
  start: Date,
  method: PaymentMethod,
  paymentRefNo: string | undefined,
  paymentWindowMinutes: number,
  now: Date,
): boolean {
  return method !== "CASH_ON_COURT" && !paymentRefNo && start < addMinutes(now, paymentWindowMinutes);
}

// -----------------------------------------------------------------------------
// Payment proof submission (player) and review (venue staff)
// -----------------------------------------------------------------------------
export const RECEIPT_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "heic", "pdf"] as const;

function receiptPathIssue(bookingId: string, path: string): boolean {
  const [folder, file, ...rest] = path.split("/");
  const ext = file?.split(".").pop()?.toLowerCase() ?? "";
  return (
    folder !== bookingId ||
    !file ||
    rest.length > 0 ||
    !(RECEIPT_EXTENSIONS as readonly string[]).includes(ext)
  );
}

const RECEIPT_MESSAGE = "Upload the receipt as a photo or PDF for this booking.";

/**
 * Reference first, receipt optional: on a weak signal the 13-digit reference
 * gets through even when the screenshot upload doesn't. The receipt can be
 * attached later (`receiptAttachSchema`) while the payment is under review.
 */
export const paymentSubmissionSchema = z
  .strictObject({
    booking_id: uuidSchema,
    /** The booking's method: selects the reference format. Must match the booking (checked server-side). */
    payment_method: z.enum(["GCASH", "MAYA", "BANK_TRANSFER"]),
    payment_ref_no: paymentRefSchema,
    /** Object path in the private `payment-receipts` bucket: "<booking_id>/<file>". */
    receipt_path: storagePathSchema.optional(),
  })
  .superRefine((p, ctx) => {
    const problem = paymentRefIssue(p.payment_method, p.payment_ref_no);
    if (problem) ctx.addIssue({ code: "custom", path: ["payment_ref_no"], message: problem });
    if (p.receipt_path !== undefined && receiptPathIssue(p.booking_id, p.receipt_path)) {
      ctx.addIssue({ code: "custom", path: ["receipt_path"], message: RECEIPT_MESSAGE });
    }
  });

export type PaymentSubmission = z.output<typeof paymentSubmissionSchema>;

export function toPaymentSubmissionUpdate(p: PaymentSubmission): UpdateRow<"bookings"> {
  return compact({
    payment_ref_no: p.payment_ref_no,
    payment_receipt_url: p.receipt_path,
    payment_status: "AWAITING_VERIFICATION" as const,
  });
}

export const receiptAttachSchema = z
  .strictObject({ booking_id: uuidSchema, receipt_path: storagePathSchema })
  .superRefine((p, ctx) => {
    if (receiptPathIssue(p.booking_id, p.receipt_path)) {
      ctx.addIssue({ code: "custom", path: ["receipt_path"], message: RECEIPT_MESSAGE });
    }
  });

export type ReceiptAttach = z.output<typeof receiptAttachSchema>;

/** Attaching keeps the payment under review (the guard allows receipts only then). */
export function toReceiptAttachUpdate(p: ReceiptAttach): UpdateRow<"bookings"> {
  return { payment_receipt_url: p.receipt_path, payment_status: "AWAITING_VERIFICATION" };
}

export const paymentReviewSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("APPROVE"), booking_id: uuidSchema }),
  z.strictObject({ decision: z.literal("REJECT"), booking_id: uuidSchema, reason: line(5, 300) }),
  z.strictObject({ decision: z.literal("MARK_CASH_COLLECTED"), booking_id: uuidSchema }),
  z.strictObject({ decision: z.literal("REFUND"), booking_id: uuidSchema }),
]);

export type PaymentReview = z.output<typeof paymentReviewSchema>;

/** Venue-side transitions. The database enforces who may make them and in which states. */
export function toPaymentReviewUpdate(review: PaymentReview): UpdateRow<"bookings"> {
  switch (review.decision) {
    case "APPROVE":
    case "MARK_CASH_COLLECTED":
      return { payment_status: "PAID" };
    case "REJECT":
      return { payment_status: "REJECTED", payment_rejection_reason: review.reason };
    case "REFUND":
      return { payment_status: "REFUNDED" };
  }
}

export const bookingCancellationSchema = z.strictObject({
  booking_id: uuidSchema,
  reason: optionalLine(3, 300),
});

export function toCancellationUpdate(c: z.output<typeof bookingCancellationSchema>): UpdateRow<"bookings"> {
  return compact({ booking_status: "CANCELLED" as const, cancellation_reason: c.reason });
}

// -----------------------------------------------------------------------------
// UI view of a booking
// -----------------------------------------------------------------------------
export type BookingTone = "success" | "info" | "warning" | "danger" | "neutral";
export type BookingNextAction =
  "PAY" | "RESUBMIT_PAYMENT" | "WAIT_FOR_VERIFICATION" | "PAY_AT_VENUE" | "NONE";

export interface BookingView {
  label: string;
  detail?: string;
  tone: BookingTone;
  nextAction: BookingNextAction;
}

type BookingStateFields = Pick<
  Row<"bookings">,
  | "booking_status"
  | "payment_status"
  | "payment_method"
  | "payment_due_at"
  | "payment_rejection_reason"
  | "cancellation_reason"
  | "total_amount"
>;

const timeFormatter = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  hour: "numeric",
  minute: "2-digit",
});

/** One combined label for booking_status × payment_status. */
export function describeBooking(b: BookingStateFields, now: Date = new Date()): BookingView {
  const cash = b.payment_method === "CASH_ON_COURT";
  switch (b.booking_status) {
    case "CANCELLED":
      if (b.cancellation_reason === "PAYMENT_WINDOW_EXPIRED") {
        return {
          label: "Expired",
          detail: "Payment wasn't received in time.",
          tone: "danger",
          nextAction: "NONE",
        };
      }
      return {
        label: b.payment_status === "REFUNDED" ? "Cancelled · Refunded" : "Cancelled",
        tone: "neutral",
        nextAction: "NONE",
      };
    case "COMPLETED":
      return { label: "Completed", tone: "neutral", nextAction: "NONE" };
    case "CONFIRMED":
      return cash && b.payment_status === "UNPAID"
        ? {
            label: "Confirmed",
            detail: `Pay ${formatPeso(b.total_amount)} at the venue.`,
            tone: "success",
            nextAction: "PAY_AT_VENUE",
          }
        : { label: "Confirmed", tone: "success", nextAction: "NONE" };
    case "PENDING_PAYMENT":
      if (cash) return { label: "Waiting for the venue to confirm", tone: "info", nextAction: "NONE" };
      if (b.payment_status === "AWAITING_VERIFICATION") {
        return {
          label: "Payment under review",
          detail: "The venue is checking your reference number.",
          tone: "info",
          nextAction: "WAIT_FOR_VERIFICATION",
        };
      }
      // The slot is held until the due time plus a short grace (app.hold_grace()).
      if (b.payment_due_at && holdEndsAt(b.payment_due_at) <= now) {
        return { label: "Payment window closed", tone: "danger", nextAction: "NONE" };
      }
      if (b.payment_status === "REJECTED") {
        return {
          label: "Payment rejected",
          detail: b.payment_rejection_reason ?? undefined,
          tone: "danger",
          nextAction: "RESUBMIT_PAYMENT",
        };
      }
      return {
        label: "Awaiting payment",
        detail: b.payment_due_at
          ? `Send ${formatPeso(b.total_amount)} by ${timeFormatter.format(new Date(b.payment_due_at))} to keep this slot.`
          : undefined,
        tone: "warning",
        nextAction: "PAY",
      };
  }
}

/** When an unpaid hold really lets go of the slot: payment_due_at + app.hold_grace(). */
export function holdEndsAt(paymentDueAt: string | Date): Date {
  return addMinutes(new Date(paymentDueAt), LIMITS.booking.holdGraceMinutes);
}

type CancellableFields = Pick<Row<"bookings">, "booking_status" | "payment_status" | "start_time">;

export interface CancellationTerms {
  allowed: boolean;
  /** Money was sent (verified or not), so the venue owes a refund if the player cancels. */
  refundEligible: boolean;
  /** Last moment a player may cancel, when a cutoff applies (confirmed, or payment sent). */
  cutoffAt: string | null;
}

/**
 * Mirror of the guard's player-cancel rules:
 *   * never once the session has started;
 *   * a confirmed booking, or one whose payment was sent (under review), only
 *     up to the venue's cutoff before start;
 *   * an unpaid hold any time before start.
 */
export function cancellationTerms(
  b: CancellableFields,
  cancellationCutoffHours: number,
  now: Date = new Date(),
): CancellationTerms {
  const start = new Date(b.start_time);
  const live = b.booking_status === "PENDING_PAYMENT" || b.booking_status === "CONFIRMED";
  const moneySent = b.payment_status === "PAID" || b.payment_status === "AWAITING_VERIFICATION";
  const cutoffApplies = b.booking_status === "CONFIRMED" || b.payment_status === "AWAITING_VERIFICATION";
  const cutoff = addMinutes(start, -cancellationCutoffHours * 60);
  const allowed = live && now < start && (!cutoffApplies || now <= cutoff);
  return {
    allowed,
    refundEligible: allowed && moneySent,
    cutoffAt: cutoffApplies ? cutoff.toISOString() : null,
  };
}

export function canPlayerCancel(
  b: CancellableFields,
  cancellationCutoffHours: number,
  now: Date = new Date(),
): boolean {
  return cancellationTerms(b, cancellationCutoffHours, now).allowed;
}

// -----------------------------------------------------------------------------
// Venue staff: reschedules and court closures
// -----------------------------------------------------------------------------
/** Move a booking (venue staff only; the database checks the overlap and who may move it). */
export const bookingRescheduleSchema = z
  .strictObject({
    booking_id: uuidSchema,
    /** Omit to stay on the same court. Moves stay within the venue. */
    court_id: uuidSchema.optional(),
    start_time: instantSchema,
    end_time: instantSchema,
  })
  .superRefine((b, ctx) => {
    if (!isValidInstant(b.start_time) || !isValidInstant(b.end_time)) return;
    const start = new Date(b.start_time);
    const end = new Date(b.end_time);
    if (end <= start) {
      ctx.addIssue({ code: "custom", path: ["end_time"], message: "End time must be after start time." });
    } else if (
      !isOnMinuteGrid(start, LIMITS.booking.gridMinutes) ||
      !isOnMinuteGrid(end, LIMITS.booking.gridMinutes)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["start_time"],
        message: "Bookings start and end on 15-minute marks.",
      });
    } else if (minutesBetween(start, end) > LIMITS.booking.maxDurationMinutes) {
      ctx.addIssue({
        code: "custom",
        path: ["end_time"],
        message: "A single booking can be at most 12 hours.",
      });
    }
  });

export type BookingReschedule = z.output<typeof bookingRescheduleSchema>;

export function toRescheduleUpdate(r: BookingReschedule): UpdateRow<"bookings"> {
  return compact({ court_id: r.court_id, start_time: r.start_time, end_time: r.end_time });
}

/** Typhoon signals, maintenance, barangay events. `court_id` omitted = every court at the venue. */
export const courtClosureSchema = z
  .strictObject({
    venue_id: uuidSchema,
    court_id: uuidSchema.optional(),
    starts_at: instantSchema,
    ends_at: instantSchema,
    reason: line(LIMITS.closure.reason.min, LIMITS.closure.reason.max),
  })
  .superRefine((c, ctx) => {
    if (!isValidInstant(c.starts_at) || !isValidInstant(c.ends_at)) return;
    const start = new Date(c.starts_at);
    const end = new Date(c.ends_at);
    if (end <= start) {
      ctx.addIssue({ code: "custom", path: ["ends_at"], message: "A closure must end after it starts." });
    } else if (minutesBetween(start, end) > LIMITS.closure.maxDays * 24 * 60) {
      ctx.addIssue({
        code: "custom",
        path: ["ends_at"],
        message: `A closure can last at most ${LIMITS.closure.maxDays} days. Add another one for longer.`,
      });
    }
  });

export type CourtClosure = z.output<typeof courtClosureSchema>;

/** created_by is stamped by the database. */
export function toClosureInsert(c: CourtClosure): InsertRow<"court_closures"> {
  return compact({
    venue_id: c.venue_id,
    court_id: c.court_id,
    starts_at: c.starts_at,
    ends_at: c.ends_at,
    reason: c.reason,
  });
}
