/**
 * Payment proof (player) and verification (venue staff). Each action is one
 * UPDATE through RLS; the bookings guard decides who may make which payment
 * transition, rejects late or locked proofs and foreign receipts, and stamps
 * who verified what and when.
 */
import {
  paymentReviewSchema,
  paymentSubmissionSchema,
  receiptAttachSchema,
  toPaymentReviewUpdate,
  toPaymentSubmissionUpdate,
  toReceiptAttachUpdate,
  validate,
  type ActionResult,
} from "../../domain";
import type { UpdateRow } from "../../db";
import type { DbClient } from "../db-client";
import type { BookingRow } from "./create";
import type { ServerDeps } from "./deps";
import { callWithRetry } from "./transport";

/** The player sends their GCash/Maya/bank reference (receipt optional, can follow later). */
export async function submitPaymentProof(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<BookingRow>> {
  const v = validate(paymentSubmissionSchema, input);
  if (!v.ok) return v;
  // Matching the method keeps the reference format check honest.
  return updateBooking(client, v.data.booking_id, toPaymentSubmissionUpdate(v.data), deps, {
    payment_method: v.data.payment_method,
  });
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
    payment_status: "AWAITING_VERIFICATION",
  });
}

/** Venue staff: approve or reject a proof, record cash collected, or record a refund. */
export async function reviewPayment(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<BookingRow>> {
  const v = validate(paymentReviewSchema, input);
  if (!v.ok) return v;
  // No status filter: the guard's state machine rejects invalid transitions,
  // and a retried APPROVE after a lost response is a harmless PAID → PAID.
  const filter =
    v.data.decision === "MARK_CASH_COLLECTED" ? ({ payment_method: "CASH_ON_COURT" } as const) : {};
  return updateBooking(client, v.data.booking_id, toPaymentReviewUpdate(v.data), deps, filter);
}

export type VerificationItem = Pick<
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
> & {
  player: { id: string; full_name: string } | null;
  court: { name: string } | null;
  /** The booking was cancelled after the money was sent: the venue settles (refunds) it. */
  settleOnly: boolean;
};

/**
 * Proofs waiting for the venue, oldest first. Includes bookings cancelled
 * while their payment was still under review: the money arrived, so the venue
 * must still verify and refund it.
 */
export async function listVerificationQueue(
  client: DbClient,
  venueId: string,
  deps: ServerDeps = {},
): Promise<ActionResult<VerificationItem[]>> {
  type Raw = Omit<VerificationItem, "settleOnly">;
  const res = await callWithRetry<Raw[]>(
    (signal) =>
      client
        .from("bookings")
        .select(
          "id, reference_code, court_id, start_time, end_time, booking_status, payment_method, payment_status, " +
            "payment_ref_no, payment_receipt_url, payment_submitted_at, total_amount, walk_in_name, " +
            "player:profiles!bookings_booked_by_fkey(id, full_name), court:courts!bookings_court_id_fkey(name)",
        )
        .eq("venue_id", venueId)
        .eq("payment_status", "AWAITING_VERIFICATION")
        .order("payment_submitted_at", { ascending: true })
        .limit(200)
        .abortSignal(signal)
        .retry(false)
        .overrideTypes<Raw[], { merge: false }>(),
    deps.retry,
  );
  if (!res.ok) return res;
  return { ok: true, data: res.data.map((b) => ({ ...b, settleOnly: b.booking_status === "CANCELLED" })) };
}

export async function updateBooking(
  client: DbClient,
  bookingId: string,
  patch: UpdateRow<"bookings">,
  deps: ServerDeps,
  expect: Partial<Pick<BookingRow, "payment_method" | "payment_status">> = {},
): Promise<ActionResult<BookingRow>> {
  const res = await callWithRetry<BookingRow | null>((signal) => {
    let q = client.from("bookings").update(patch).eq("id", bookingId);
    if (expect.payment_method) q = q.eq("payment_method", expect.payment_method);
    if (expect.payment_status) q = q.eq("payment_status", expect.payment_status);
    return q.select("*").abortSignal(signal).retry(false).maybeSingle();
  }, deps.retry);
  if (!res.ok) return res;
  if (!res.data) {
    // RLS hid it, it doesn't exist, or it's not in the expected state (e.g. already reviewed).
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "This booking can't be updated right now. Refresh to see its latest status.",
        retryable: false,
      },
    };
  }
  return { ok: true, data: res.data };
}
