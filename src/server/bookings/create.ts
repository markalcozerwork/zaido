/**
 * Creating bookings. Postgres is the authority: `public.create_booking`
 * (SECURITY INVOKER, so RLS and every guard rule apply as the caller) prices
 * the slot, enforces the rules, and the exclusion constraints make a double
 * booking impossible. This layer validates the request shape, sends it with
 * the checkout's idempotency key, retries transient failures with the SAME
 * key, and turns the outcome into an ActionResult.
 *
 * No pre-check round trip: the database answers with the same typed codes the
 * availability grid predicts (SLOT_TAKEN, PAY_FIRST, VENUE_CLOSED, …), and the
 * UI only offers slots the grid marked OK.
 */
import { z } from "zod";
import {
  bookingActionSchema,
  uuidSchema,
  holdEndsAt,
  staffBookingSchema,
  validate,
  type ActionResult,
  type BookingAction,
  type DomainError,
  type StaffBooking,
} from "../../domain";
import type { Row, RpcArgs } from "../../db";
import { compact } from "../../domain/object";
import type { DbClient } from "../db-client";
import type { ServerDeps } from "../deps";
import { callWithRetry } from "../transport";

export type BookingRow = Row<"bookings">;

/** A player books a court (optionally with a coach) for themselves. */
export async function createBooking(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<BookingRow>> {
  const v = validate(bookingActionSchema, input);
  if (!v.ok) return v;
  return send(client, toCreateArgs(v.data), deps);
}

/** Venue staff book at the front desk: for a registered player, a walk-in, or themselves. */
export async function createStaffBooking(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<BookingRow>> {
  const v = validate(staffBookingSchema, input);
  if (!v.ok) return v;
  return send(client, toStaffCreateArgs(v.data), deps);
}

export function toCreateArgs(b: BookingAction): RpcArgs<"create_booking"> {
  // Omitted (not null) arguments take the function's defaults.
  return compact({
    p_court_id: b.court_id,
    p_start: b.start_time,
    p_end: b.end_time,
    p_payment_method: b.payment_method,
    p_idempotency_key: b.idempotency_key,
    p_coach_id: b.coach_id,
    p_payment_ref_no: b.payment_ref_no,
    p_player_count: b.player_count,
    p_notes: b.notes,
  });
}

export function toStaffCreateArgs(b: StaffBooking): RpcArgs<"create_booking"> {
  return compact({
    ...toCreateArgs(b),
    p_booked_by: b.booked_by,
    p_walk_in_name: b.walk_in_name,
    p_walk_in_phone: b.walk_in_phone,
    p_discount_amount: b.discount_amount,
    p_mark_paid: b.mark_paid,
  });
}

async function send(
  client: DbClient,
  args: RpcArgs<"create_booking">,
  deps: ServerDeps,
): Promise<ActionResult<BookingRow>> {
  const res = await callWithRetry<BookingRow>(
    (signal) => client.rpc("create_booking", args).abortSignal(signal).retry(false),
    deps.retry,
  );
  if (!res.ok) return res;
  // A replay returns the original booking whatever happened to it since.
  const replayError = cancelledReplay(res.data);
  return replayError ? { ok: false, error: replayError } : { ok: true, data: res.data };
}

/** The key's booking exists but is no longer live: say why instead of returning a dead booking. */
function cancelledReplay(b: BookingRow): DomainError | null {
  if (b.booking_status !== "CANCELLED") return null;
  if (b.cancellation_reason === "PAYMENT_WINDOW_EXPIRED") {
    return {
      code: "HOLD_EXPIRED",
      message:
        "Your hold on this slot has ended. If you already paid, book again with your reference number.",
      field: "payment_ref_no",
      retryable: false,
      meta: { bookingId: b.id },
    };
  }
  return {
    code: "BOOKING_CANCELLED",
    message: "This booking was cancelled. Start a new booking to play at this time.",
    retryable: false,
    meta: { bookingId: b.id },
  };
}

/**
 * "I paid after my hold expired": book the same slot again, this time with the
 * reference number (so it goes straight to payment review). If someone else
 * took the slot meanwhile, the player gets SLOT_TAKEN and contacts the venue
 * about the payment.
 */
export const rebookRequestSchema = z.strictObject({
  booking_id: uuidSchema,
  payment_ref_no: z.string().trim().min(6).max(40),
  idempotency_key: uuidSchema,
});

export async function rebookExpiredHold(
  client: DbClient,
  rawInput: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<BookingRow>> {
  const v = validate(rebookRequestSchema, rawInput);
  if (!v.ok) return v;
  const input = v.data;
  const now = (deps.now ?? (() => new Date()))();
  const old = await callWithRetry<BookingRow | null>(
    (signal) =>
      client
        .from("bookings")
        .select("*")
        .eq("id", input.booking_id)
        .abortSignal(signal)
        .retry(false)
        .maybeSingle(),
    deps.retry,
  );
  if (!old.ok) return old;
  const b = old.data;
  const expired =
    b &&
    ((b.booking_status === "CANCELLED" && b.cancellation_reason === "PAYMENT_WINDOW_EXPIRED") ||
      (b.booking_status === "PENDING_PAYMENT" &&
        (b.payment_status === "UNPAID" || b.payment_status === "REJECTED") &&
        b.payment_due_at !== null &&
        holdEndsAt(b.payment_due_at) <= now));
  if (!b || !expired) {
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: "There's no expired booking to rebook.", retryable: false },
    };
  }
  return createBooking(
    client,
    compact({
      court_id: b.court_id,
      start_time: b.start_time,
      end_time: b.end_time,
      payment_method: b.payment_method,
      coach_id: b.coach_id ?? undefined,
      player_count: b.player_count ?? undefined,
      notes: b.notes ?? undefined,
      payment_ref_no: input.payment_ref_no,
      idempotency_key: input.idempotency_key,
    }),
    deps,
  );
}
