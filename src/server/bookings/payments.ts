/**
 * Payment proof (player) and verification (venue staff). Each action is one
 * UPDATE through RLS; the bookings guard decides who may make which payment
 * transition, rejects late, locked or closed-court proofs and foreign receipts,
 * and stamps who verified what and when.
 */
import {
  paymentMethodSwitchSchema,
  paymentReviewSchema,
  paymentSubmissionSchema,
  receiptAttachSchema,
  reviewPrecondition,
  toPaymentReviewUpdate,
  toPaymentSubmissionUpdate,
  toReceiptAttachUpdate,
  uuidSchema,
  validate,
  type ActionResult,
} from "../../domain";
import type { UpdateRow } from "../../db";
import type { DbClient } from "../db-client";
import type { BookingRow } from "./create";
import type { ServerDeps } from "./deps";
import { callWithRetry } from "./transport";

/**
 * The player sends their GCash/Maya/bank reference (receipt optional, can
 * follow later). Paying with another e-wallet the venue accepts moves the
 * booking's method with it.
 */
export async function submitPaymentProof(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<BookingRow>> {
  const v = validate(paymentSubmissionSchema, input);
  if (!v.ok) return v;
  return updateBooking(client, v.data.booking_id, toPaymentSubmissionUpdate(v.data), deps);
}

/** Attach the receipt screenshot to a payment that is under review. */
export async function attachReceipt(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<BookingRow>> {
  const v = validate(receiptAttachSchema, input);
  if (!v.ok) return v;
  return updateBooking(client, v.data.booking_id, toReceiptAttachUpdate(v.data), deps, {
    eq: { payment_status: "AWAITING_VERIFICATION" },
  });
}

/** Switch how to pay before paying (e.g. GCash short → Maya, or pay cash at the venue). */
export async function switchPaymentMethod(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<BookingRow>> {
  const v = validate(paymentMethodSwitchSchema, input);
  if (!v.ok) return v;
  return updateBooking(client, v.data.booking_id, { payment_method: v.data.payment_method }, deps);
}

/**
 * Venue staff: approve or reject the proof they checked, record cash collected,
 * confirm a cash request (venues that confirm by hand), or record a refund.
 * Each decision only applies while the booking is still in the state it was
 * made for (see reviewPrecondition): a stale screen can't approve a proof
 * another reviewer rejected, or a reference the player swapped in later.
 */
export async function reviewPayment(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<BookingRow>> {
  const v = validate(paymentReviewSchema, input);
  if (!v.ok) return v;
  return updateBooking(
    client,
    v.data.booking_id,
    toPaymentReviewUpdate(v.data),
    deps,
    reviewPrecondition(v.data),
  );
}

export type InboxKind =
  /** A proof to check. */
  | "PROOF"
  /** Cancelled while the proof was under review: check it, then refund. */
  | "SETTLE"
  /** A cash booking waiting for the venue to confirm (venues that confirm by hand). */
  | "CASH_REQUEST"
  /** Cancelled after it was paid: the venue owes a refund. */
  | "REFUND_DUE";

export type InboxItem = Pick<
  BookingRow,
  | "id"
  | "reference_code"
  | "court_id"
  | "start_time"
  | "end_time"
  | "booking_status"
  | "payment_method"
  | "payment_status"
  | "payment_ref_no"
  | "payment_receipt_url"
  | "payment_submitted_at"
  | "total_amount"
  | "walk_in_name"
  | "cancelled_at"
  | "created_at"
> & {
  player: { id: string; full_name: string } | null;
  court: { name: string } | null;
  kind: InboxKind;
};

export function inboxKind(b: Pick<BookingRow, "booking_status" | "payment_status">): InboxKind {
  if (b.payment_status === "AWAITING_VERIFICATION")
    return b.booking_status === "CANCELLED" ? "SETTLE" : "PROOF";
  if (b.booking_status === "CANCELLED") return "REFUND_DUE";
  return "CASH_REQUEST";
}

/**
 * The venue's inbox, oldest first: proofs to check (including bookings
 * cancelled while their proof was under review), cash requests to confirm or
 * decline, and refunds owed for bookings cancelled after payment.
 */
export async function listVerificationQueue(
  client: DbClient,
  venueId: string,
  deps: ServerDeps = {},
): Promise<ActionResult<InboxItem[]>> {
  if (!uuidSchema.safeParse(venueId).success) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid venue.", retryable: false } };
  }
  type Raw = Omit<InboxItem, "kind">;
  const res = await callWithRetry<Raw[]>(
    (signal) =>
      client
        .from("bookings")
        .select(
          "id, reference_code, court_id, start_time, end_time, booking_status, payment_method, payment_status, " +
            "payment_ref_no, payment_receipt_url, payment_submitted_at, total_amount, walk_in_name, cancelled_at, created_at, " +
            "player:profiles!bookings_booked_by_fkey(id, full_name), court:courts!bookings_court_id_fkey(name)",
        )
        .eq("venue_id", venueId)
        .or(
          "payment_status.eq.AWAITING_VERIFICATION," +
            "and(booking_status.eq.PENDING_PAYMENT,payment_method.eq.CASH_ON_COURT,payment_status.eq.UNPAID)," +
            "and(booking_status.eq.CANCELLED,payment_status.eq.PAID)",
        )
        .order("created_at", { ascending: true })
        .limit(500)
        .abortSignal(signal)
        .retry(false)
        .overrideTypes<Raw[], { merge: false }>(),
    deps.retry,
  );
  if (!res.ok) return res;
  return { ok: true, data: res.data.map((b) => ({ ...b, kind: inboxKind(b) })) };
}

export interface UpdateFilters {
  eq?: Partial<Record<"payment_ref_no" | "payment_method" | "payment_status", string>>;
  in?: Partial<Record<"payment_status" | "booking_status", readonly string[]>>;
}

export async function updateBooking(
  client: DbClient,
  bookingId: string,
  patch: UpdateRow<"bookings">,
  deps: ServerDeps,
  filters: UpdateFilters = {},
): Promise<ActionResult<BookingRow>> {
  if (!uuidSchema.safeParse(bookingId).success) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid booking.", retryable: false } };
  }
  const res = await callWithRetry<BookingRow | null>((signal) => {
    let q = client.from("bookings").update(patch).eq("id", bookingId);
    for (const [col, value] of Object.entries(filters.eq ?? {})) q = q.eq(col, value);
    for (const [col, values] of Object.entries(filters.in ?? {})) q = q.in(col, [...values]);
    return q.select("*").abortSignal(signal).retry(false).maybeSingle();
  }, deps.retry);
  if (!res.ok) return res;
  if (!res.data) {
    // RLS hid it, it doesn't exist, or it's no longer in the state the action was meant for
    // (another reviewer acted, the player changed the proof).
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "This booking changed in the meantime. Refresh to see its latest status.",
        retryable: false,
      },
    };
  }
  return { ok: true, data: res.data };
}
