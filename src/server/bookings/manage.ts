/**
 * After booking: cancel (player, the booked coach, or venue staff), reschedule
 * (venue staff), "My bookings", a coach's sessions, and court closures (venue
 * staff).
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
import type { ServerDeps } from "../deps";
import { updateBooking } from "./payments";
import { callWithRetry } from "../transport";

export interface CancelOutcome {
  booking: BookingRow;
  /** Money was sent for this booking: the venue owes the player a refund. */
  refundDue: boolean;
}

/**
 * Cancel a booking. The guard decides who may: the player (never after start;
 * the venue's cutoff once paid or under review, lifted while the court is
 * closed), the booked coach (before start), or venue staff (any time; a live
 * event using the booking is cancelled with it).
 */
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

export type CoachSession = BookingRow & {
  court: { id: string; name: string; venue: Pick<Row<"venues">, "id" | "name" | "timezone"> } | null;
  player: { id: string; full_name: string } | null;
};

/** A coach's own sessions (bookings players made with them), so they can prepare or cancel. */
export async function listMyCoachSessions(
  client: DbClient,
  input: { userId: string; scope: "upcoming" | "past" },
  deps: ServerDeps = {},
): Promise<ActionResult<CoachSession[]>> {
  if (!uuidSchema.safeParse(input.userId).success) {
    return {
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Please sign in again.", retryable: false },
    };
  }
  const now = (deps.now ?? (() => new Date()))();
  const res = await callWithRetry<CoachSession[]>((signal) => {
    let q = client
      .from("bookings")
      .select(
        "*, court:courts!bookings_court_id_fkey(id, name, venue:venues!courts_venue_id_fkey(id, name, timezone)), " +
          "player:profiles!bookings_booked_by_fkey(id, full_name)",
      )
      .eq("coach_id", input.userId);
    q =
      input.scope === "upcoming"
        ? q
            .gt("end_time", now.toISOString())
            .in("booking_status", ["PENDING_PAYMENT", "CONFIRMED"])
            .order("start_time", { ascending: true })
        : q
            .or(`end_time.lte.${now.toISOString()},booking_status.in.(CANCELLED,COMPLETED)`)
            .order("start_time", { ascending: false });
    return q.limit(100).abortSignal(signal).retry(false).overrideTypes<CoachSession[], { merge: false }>();
  }, deps.retry);
  return res;
}

// -----------------------------------------------------------------------------
// Court closures (venue staff)
// -----------------------------------------------------------------------------
export type AffectedBooking = Pick<
  BookingRow,
  | "id"
  | "reference_code"
  | "court_id"
  | "start_time"
  | "end_time"
  | "booking_status"
  | "payment_status"
  | "walk_in_name"
> & { player: { id: string; full_name: string } | null };

export interface ClosureOutcome {
  closure: Row<"court_closures">;
  /**
   * Live bookings inside the closure: players can no longer pay for them and may cancel
   * whatever the cutoff; staff should contact them, cancel and refund (bulk cancel is Step 5).
   */
  affected: AffectedBooking[];
}

export async function createClosure(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<ClosureOutcome>> {
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
  if (!res.ok) return res;
  const closure = res.data;
  const affected = await callWithRetry<AffectedBooking[]>((signal) => {
    let q = client
      .from("bookings")
      .select(
        "id, reference_code, court_id, start_time, end_time, booking_status, payment_status, walk_in_name, " +
          "player:profiles!bookings_booked_by_fkey(id, full_name)",
      )
      .eq("venue_id", closure.venue_id)
      .in("booking_status", ["PENDING_PAYMENT", "CONFIRMED"])
      .lt("start_time", closure.ends_at)
      .gt("end_time", closure.starts_at);
    if (closure.court_id) q = q.eq("court_id", closure.court_id);
    return q
      .order("start_time", { ascending: true })
      .abortSignal(signal)
      .retry(false)
      .overrideTypes<AffectedBooking[], { merge: false }>();
  }, deps.retry);
  // The closure exists either way; a failed lookup just leaves the list empty for a refresh.
  return { ok: true, data: { closure, affected: affected.ok ? affected.data : [] } };
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
