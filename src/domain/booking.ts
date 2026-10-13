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
import { PAYMENT_METHOD_LABELS, paymentMethodSchema, type PaymentMethod } from "./enums";
import { LIMITS } from "./limits";
import { formatPeso } from "./money";
import { compact } from "./object";
import {
  instantSchema,
  isValidInstant,
  line,
  minutesSinceMidnight,
  optionalLine,
  optionalParagraphs,
  storagePathSchema,
  uuidSchema,
} from "./primitives";
import { addMinutes, isOnMinuteGrid, minutesBetween, toZonedParts } from "./time";

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

export function createBookingRequestSchema({ now = () => new Date() }: BookingRequestOptions = {}) {
  return z.strictObject(bookingRequestFields).superRefine((b, ctx) => {
    // Malformed instants are already reported by the field schema.
    if (!isValidInstant(b.start_time) || !isValidInstant(b.end_time)) return;
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

    const t = now();
    if (start < t) {
      ctx.addIssue({ code: "custom", path: ["start_time"], message: "That time has already passed." });
    } else if (start > addMinutes(t, LIMITS.booking.maxAdvanceDays * 24 * 60)) {
      ctx.addIssue({
        code: "custom",
        path: ["start_time"],
        message: `Bookings open up to ${LIMITS.booking.maxAdvanceDays} days ahead.`,
      });
    }

    if (b.payment_ref_no !== undefined) {
      const problem = paymentRefIssue(b.payment_method, b.payment_ref_no);
      if (problem) ctx.addIssue({ code: "custom", path: ["payment_ref_no"], message: problem });
    }
  });
}

export const bookingRequestSchema = createBookingRequestSchema();
export type BookingRequestInput = z.input<typeof bookingRequestSchema>;
export type BookingRequest = z.output<typeof bookingRequestSchema>;

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

export type BusySlot = RpcReturns<"get_court_busy_slots">[number];

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
  /** Empty = open 24/7, as in the database. */
  operating_hours: ReadonlyArray<{ day_of_week: number; opens_at: string; closes_at: string }>;
  accepted_payment_methods: readonly PaymentMethod[];
}

export type SlotIssueCode =
  | "COURT_UNAVAILABLE"
  | "OFF_INCREMENT"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "VENUE_CLOSED"
  | "PAYMENT_METHOD_UNAVAILABLE";

export interface SlotIssue {
  code: SlotIssueCode;
  message: string;
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

/** Same algorithm as app.is_within_operating_hours: every 15-minute slice must sit inside a window. */
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

export function checkSlotAgainstCourt(
  req: Pick<BookingRequest, "start_time" | "end_time" | "payment_method">,
  rules: CourtSlotRules,
): SlotIssue[] {
  const issues: SlotIssue[] = [];
  const start = new Date(req.start_time);
  const end = new Date(req.end_time);
  const minutes = minutesBetween(start, end);
  const inc = rules.slot_increment_minutes;

  if (!rules.court_is_active || !rules.venue_is_active) {
    issues.push({ code: "COURT_UNAVAILABLE", message: "This court is not accepting bookings." });
  }
  if (toZonedParts(start, rules.timezone).minuteOfDay % inc !== 0 || minutes % inc !== 0) {
    issues.push({ code: "OFF_INCREMENT", message: `This court books in ${inc}-minute increments.` });
  }
  if (minutes < rules.min_booking_minutes) {
    issues.push({ code: "TOO_SHORT", message: `Book at least ${rules.min_booking_minutes} minutes.` });
  }
  if (minutes > rules.max_booking_minutes) {
    issues.push({ code: "TOO_LONG", message: `Book at most ${rules.max_booking_minutes} minutes.` });
  }
  if (!isWithinOperatingHours(start, end, rules)) {
    issues.push({ code: "VENUE_CLOSED", message: "The venue is closed during part of the selected time." });
  }
  if (!rules.accepted_payment_methods.includes(req.payment_method)) {
    issues.push({
      code: "PAYMENT_METHOD_UNAVAILABLE",
      message: `This venue doesn't accept ${PAYMENT_METHOD_LABELS[req.payment_method]}.`,
    });
  }
  return issues;
}

// -----------------------------------------------------------------------------
// Payment proof submission (player) and review (venue staff)
// -----------------------------------------------------------------------------
export const RECEIPT_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "heic", "pdf"] as const;

export const paymentSubmissionSchema = z
  .strictObject({
    booking_id: uuidSchema,
    /** The booking's method: selects the reference format. Must match the booking (checked server-side). */
    payment_method: z.enum(["GCASH", "MAYA", "BANK_TRANSFER"]),
    payment_ref_no: paymentRefSchema,
    /** Object path in the private `payment-receipts` bucket: "<booking_id>/<file>". */
    receipt_path: storagePathSchema,
  })
  .superRefine((p, ctx) => {
    const problem = paymentRefIssue(p.payment_method, p.payment_ref_no);
    if (problem) ctx.addIssue({ code: "custom", path: ["payment_ref_no"], message: problem });

    const [folder, file, ...rest] = p.receipt_path.split("/");
    const ext = file?.split(".").pop()?.toLowerCase() ?? "";
    if (
      folder !== p.booking_id ||
      !file ||
      rest.length > 0 ||
      !(RECEIPT_EXTENSIONS as readonly string[]).includes(ext)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["receipt_path"],
        message: "Upload the receipt as a photo or PDF for this booking.",
      });
    }
  });

export type PaymentSubmission = z.output<typeof paymentSubmissionSchema>;

export function toPaymentSubmissionUpdate(p: PaymentSubmission): UpdateRow<"bookings"> {
  return {
    payment_ref_no: p.payment_ref_no,
    payment_receipt_url: p.receipt_path,
    payment_status: "AWAITING_VERIFICATION",
  };
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
      if (b.payment_due_at && new Date(b.payment_due_at) <= now) {
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

/** Mirrors the guard: pending → always; confirmed → only before the venue's cutoff. */
export function canPlayerCancel(
  b: Pick<Row<"bookings">, "booking_status" | "start_time">,
  cancellationCutoffHours: number,
  now: Date = new Date(),
): boolean {
  if (b.booking_status === "PENDING_PAYMENT") return true;
  if (b.booking_status !== "CONFIRMED") return false;
  return now <= addMinutes(new Date(b.start_time), -cancellationCutoffHours * 60);
}
