/**
 * After booking: cancel (player), reschedule (venue staff), "My bookings",
 * and court closures (venue staff).
 */
import {
  bookingCancellationSchema,
  bookingRescheduleSchema,
  cancellationTerms,
  courtClosureSchema,
  describeBooking,
  toCancellationUpdate,
  toClosureInsert,
  toRescheduleUpdate,
  uuidSchema,
  validate,
  type ActionResult,
  type BookingView,
  type CancellationTerms,
} from "../../domain";
import type { Row } from "../../db";
import type { DbClient } from "../db-client";
import type { BookingRow } from "./create";
import type { ServerDeps } from "./deps";
import { updateBooking } from "./payments";
import { callWithRetry } from "./transport";

export interface CancelOutcome {
  booking: BookingRow;
  /** Money was sent for this booking: the venue owes the player a refund. */
  refundDue: boolean;
}

/** The guard enforces the rules (never after start; the venue's cutoff once paid or under review). */
export async function cancelBooking(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<CancelOutcome>> {
  const v = validate(bookingCancellationSchema, input);
  if (!v.ok) return v;
  const res = await updateBooking(client, v.data.booking_id, toCancellationUpdate(v.data), deps);
  if (!res.ok) return res;
  const paid = res.data.payment_status === "PAID" || res.data.payment_status === "AWAITING_VERIFICATION";
  return { ok: true, data: { booking: res.data, refundDue: paid } };
}

/** Venue staff move a booking (same venue). Overlaps and permissions are the database's call. */
export async function rescheduleBooking(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<BookingRow>> {
  const v = validate(bookingRescheduleSchema, input);
  if (!v.ok) return v;
  return updateBooking(client, v.data.booking_id, toRescheduleUpdate(v.data), deps);
}

type VenuePaymentInfo = Pick<
  Row<"venues">,
  | "id"
  | "name"
  | "timezone"
  | "cancellation_cutoff_hours"
  | "gcash_account_name"
  | "gcash_number"
  | "maya_account_name"
  | "maya_number"
  | "bank_transfer_details"
>;

export type MyBooking = BookingRow & {
  court: { id: string; name: string; venue: VenuePaymentInfo } | null;
  view: BookingView;
  cancellation: CancellationTerms;
};

/**
 * The player's own bookings (walk-ins they entered as staff excluded), with
 * the combined status label, cancellation terms and the venue's payment
 * details for anything still awaiting payment.
 */
export async function listMyBookings(
  client: DbClient,
  input: { userId: string; scope: "upcoming" | "past" },
  deps: ServerDeps = {},
): Promise<ActionResult<MyBooking[]>> {
  if (!uuidSchema.safeParse(input.userId).success) {
    return {
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Please sign in again.", retryable: false },
    };
  }
  const now = (deps.now ?? (() => new Date()))();
  type Raw = BookingRow & { court: MyBooking["court"] };
  const res = await callWithRetry<Raw[]>((signal) => {
    let q = client
      .from("bookings")
      .select(
        "*, court:courts!bookings_court_id_fkey(id, name, venue:venues!courts_venue_id_fkey(" +
          "id, name, timezone, cancellation_cutoff_hours, gcash_account_name, gcash_number, " +
          "maya_account_name, maya_number, bank_transfer_details))",
      )
      .eq("booked_by", input.userId)
      .is("walk_in_name", null);
    q =
      input.scope === "upcoming"
        ? q
            .gt("end_time", now.toISOString())
            .in("booking_status", ["PENDING_PAYMENT", "CONFIRMED"])
            .order("start_time", { ascending: true })
        : q
            .or(`end_time.lte.${now.toISOString()},booking_status.in.(CANCELLED,COMPLETED)`)
            .order("start_time", { ascending: false });
    return q.limit(100).abortSignal(signal).retry(false).overrideTypes<Raw[], { merge: false }>();
  }, deps.retry);
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((b) => ({
      ...b,
      view: describeBooking(b, now),
      cancellation: cancellationTerms(b, b.court?.venue.cancellation_cutoff_hours ?? 0, now),
    })),
  };
}

// -----------------------------------------------------------------------------
// Court closures (venue staff)
// -----------------------------------------------------------------------------
export async function createClosure(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<Row<"court_closures">>> {
  const v = validate(courtClosureSchema, input);
  if (!v.ok) return v;
  // Not retried on a lost response: a second insert would add a duplicate closure.
  const res = await callWithRetry<Row<"court_closures">>(
    (signal) =>
      client
        .from("court_closures")
        .insert(toClosureInsert(v.data))
        .select("*")
        .abortSignal(signal)
        .retry(false)
        .single(),
    { ...deps.retry, maxAttempts: 1 },
  );
  return res;
}

export async function deleteClosure(
  client: DbClient,
  closureId: string,
  deps: ServerDeps = {},
): Promise<ActionResult<{ deleted: boolean }>> {
  if (!uuidSchema.safeParse(closureId).success) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid id.", retryable: false } };
  }
  const res = await callWithRetry<Array<{ id: string }>>(
    (signal) =>
      client
        .from("court_closures")
        .delete()
        .eq("id", closureId)
        .select("id")
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  return res.ok ? { ok: true, data: { deleted: res.data.length > 0 } } : res;
}
