/**
 * Regression tests for the Step 3 implementation review, end to end through
 * PostgREST (ids refer to the review findings in docs/architecture/03-booking-engine.md §14).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addDaysToDate, sameInstant, toZonedParts, zonedTimeToInstant } from "../../src/domain";
import {
  cancelBooking,
  createBooking,
  createClosure,
  createStaffBooking,
  getDayAvailability,
  listMyBookings,
  listMyCoachSessions,
  listVerificationQueue,
  rebookExpiredHold,
  reviewPayment,
  submitPaymentProof,
  switchPaymentMethod,
} from "../../src/server/bookings";
import { clientAs, createCoach, createUser, createVenue, gcashRef, sql } from "./support";

const day = (n: number) => addDaysToDate(toZonedParts(new Date(), "Asia/Manila").date, n);
const slot = (date: string, from: string, minutes = 60) => {
  const start = zonedTimeToInstant(date, from);
  return {
    start_time: start.toISOString(),
    end_time: new Date(start.getTime() + minutes * 60_000).toISOString(),
  };
};
const key = () => ({ idempotency_key: randomUUID() });

async function holdWithProof(playerId: string, courtId: string, date: string, from: string) {
  const player = clientAs(playerId);
  const b = await createBooking(player, {
    court_id: courtId,
    ...slot(date, from),
    payment_method: "GCASH",
    ...key(),
  });
  if (!b.ok) throw new Error(JSON.stringify(b.error));
  const ref = gcashRef();
  const s = await submitPaymentProof(player, {
    booking_id: b.data.id,
    payment_method: "GCASH",
    payment_ref_no: ref,
  });
  if (!s.ok) throw new Error(JSON.stringify(s.error));
  return { booking: s.data, ref };
}

describe("payment review is bound to the proof the reviewer saw (C2, T1)", () => {
  it("a stale Approve after a Reject, or for a swapped reference, changes nothing", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Proof Owner");
    const { booking, ref } = await holdWithProof(playerId, fx.courtId, day(6), "08:00");
    const staffA = clientAs(fx.ownerId);
    const staffB = clientAs(fx.ownerId);

    // The player can't swap the reference while the venue is checking it.
    expect(
      await submitPaymentProof(clientAs(playerId), {
        booking_id: booking.id,
        payment_method: "GCASH",
        payment_ref_no: gcashRef(),
      }),
    ).toMatchObject({ ok: false, error: { code: "PAYMENT_LOCKED" } });

    const rejected = await reviewPayment(staffA, {
      decision: "REJECT",
      booking_id: booking.id,
      payment_ref_no: ref,
      reason: "No such transfer in GCash",
    });
    expect(rejected.ok && rejected.data.payment_status).toBe("REJECTED");
    expect(
      await reviewPayment(staffB, { decision: "APPROVE", booking_id: booking.id, payment_ref_no: ref }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    // After the rejection the player sends a new reference; an Approve for the old one still does nothing.
    const fresh = gcashRef();
    await submitPaymentProof(clientAs(playerId), {
      booking_id: booking.id,
      payment_method: "GCASH",
      payment_ref_no: fresh,
    });
    expect(
      await reviewPayment(staffB, { decision: "APPROVE", booking_id: booking.id, payment_ref_no: ref }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const [row] = await sql<{ payment_status: string }>(
      `select payment_status from public.bookings where id = $1`,
      [booking.id],
    );
    expect(row!.payment_status).toBe("AWAITING_VERIFICATION");
  });
});

describe("the coach grid only offers coaches the database will book (T2, S3)", () => {
  it.each([
    ["a coach of another sport", { sports: "{TENNIS}" }],
    ["a clinics-only coach", { offersPrivate: false }],
  ])("%s is not offered", async (_label, opts) => {
    const fx = await createVenue({ venue: { verification_status: "VERIFIED" } });
    const coachId = await createCoach([], opts);
    const res = await getDayAvailability(clientAs(await createUser()), {
      court_id: fx.courtId,
      date: day(6),
      duration_minutes: 60,
      coach_id: coachId,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "NOT_FOUND", field: "coach_id" } });
  });

  it("a coach isn't offered to themselves", async () => {
    const fx = await createVenue({ venue: { verification_status: "VERIFIED" } });
    const coachId = await createCoach();
    const res = await getDayAvailability(
      clientAs(coachId),
      { court_id: fx.courtId, date: day(6), duration_minutes: 60, coach_id: coachId },
      {},
      { viewerId: coachId },
    );
    expect(res.ok).toBe(false);
  });

  it("at an unverified venue every coached slot is COACH_UNAVAILABLE, matching the database", async () => {
    const fx = await createVenue();
    const coachId = await createCoach();
    const player = clientAs(await createUser());
    const grid = await getDayAvailability(player, {
      court_id: fx.courtId,
      date: day(6),
      duration_minutes: 60,
      coach_id: coachId,
    });
    expect(
      grid.ok &&
        grid.data.slots.find((s) => s.start === zonedTimeToInstant(day(6), "10:00").toISOString())?.fit,
    ).toBe("COACH_UNAVAILABLE");
    expect(
      await createBooking(player, {
        court_id: fx.courtId,
        ...slot(day(6), "10:00"),
        payment_method: "CASH_ON_COURT",
        coach_id: coachId,
        ...key(),
      }),
    ).toMatchObject({ ok: false, error: { code: "COACH_UNAVAILABLE" } });
  });
});

describe("sessions and inputs (T3, T9)", () => {
  it("an expired session asks the user to sign in again", async () => {
    const fx = await createVenue();
    const userId = await createUser();
    const res = await createBooking(clientAs(userId, { expired: true }), {
      court_id: fx.courtId,
      ...slot(day(6), "12:00"),
      payment_method: "GCASH",
      ...key(),
    });
    expect(res).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  it("malformed ids are refused without echoing them back", async () => {
    const player = clientAs(await createUser());
    const rebook = await rebookExpiredHold(player, {
      booking_id: "1 or 1=1",
      payment_ref_no: gcashRef(),
      ...key(),
    });
    expect(rebook).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(JSON.stringify(rebook)).not.toContain("1 or 1=1");
    expect(await listVerificationQueue(player, "abc")).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
  });
});

describe('staff never get "yours" (T4, P13)', () => {
  it("a walk-in over another walk-in, or an on-behalf booking over the player's own, is SLOT_TAKEN like the staff grid says", async () => {
    const fx = await createVenue({ venue: { verification_status: "VERIFIED" } });
    const desk = clientAs(fx.ownerId);
    const first = await createStaffBooking(desk, {
      court_id: fx.courtId,
      ...slot(day(5), "09:00"),
      payment_method: "CASH_ON_COURT",
      walk_in_name: "Mang Jun",
      ...key(),
    });
    expect(first.ok).toBe(true);
    const grid = await getDayAvailability(
      desk,
      { court_id: fx.courtId, date: day(5), duration_minutes: 60 },
      {},
      { mode: "staff" },
    );
    expect(
      grid.ok &&
        grid.data.slots.find((s) => s.start === zonedTimeToInstant(day(5), "09:30").toISOString())?.fit,
    ).toBe("SLOT_TAKEN");
    expect(
      await createStaffBooking(desk, {
        court_id: fx.courtId,
        ...slot(day(5), "09:30"),
        payment_method: "CASH_ON_COURT",
        walk_in_name: "Aling Nena",
        ...key(),
      }),
    ).toMatchObject({ ok: false, error: { code: "SLOT_TAKEN" } });

    const playerId = await createUser("Regular");
    await createBooking(clientAs(playerId), {
      court_id: fx.courtId,
      ...slot(day(5), "12:00"),
      payment_method: "CASH_ON_COURT",
      ...key(),
    });
    expect(
      await createStaffBooking(desk, {
        court_id: fx.courtId,
        ...slot(day(5), "12:00"),
        payment_method: "CASH_ON_COURT",
        booked_by: playerId,
        ...key(),
      }),
    ).toMatchObject({ ok: false, error: { code: "SLOT_TAKEN" } });
  });
});

describe("a retried checkout keeps what the player added (T5)", () => {
  it("the same key with a reference now attached records the reference", async () => {
    const fx = await createVenue();
    const player = clientAs(await createUser());
    const request = { court_id: fx.courtId, ...slot(day(7), "08:00"), payment_method: "GCASH", ...key() };
    expect((await createBooking(player, request)).ok).toBe(true);
    const ref = gcashRef();
    const retried = await createBooking(player, { ...request, payment_ref_no: ref });
    expect(retried.ok && [retried.data.payment_status, retried.data.payment_ref_no]).toEqual([
      "AWAITING_VERIFICATION",
      ref,
    ]);
  });
});

describe("late payments and holds (P1, P2, S1)", () => {
  it("a proof after the sweep cancelled the hold is HOLD_EXPIRED, and the rebook path works", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Weak Signal");
    const player = clientAs(playerId);
    const b = await createBooking(player, {
      court_id: fx.courtId,
      ...slot(day(7), "10:00"),
      payment_method: "GCASH",
      ...key(),
    });
    if (!b.ok) throw new Error(JSON.stringify(b.error));
    await sql(`update public.bookings set payment_due_at = now() - interval '10 minutes' where id = $1`, [
      b.data.id,
    ]);
    await sql(`select app.expire_unpaid_bookings()`);
    const ref = gcashRef();
    expect(
      await submitPaymentProof(player, {
        booking_id: b.data.id,
        payment_method: "GCASH",
        payment_ref_no: ref,
      }),
    ).toMatchObject({ ok: false, error: { code: "HOLD_EXPIRED" } });
    const mine = await listMyBookings(player, { userId: playerId, scope: "past" });
    expect(mine.ok && mine.data.find((m) => m.id === b.data.id)?.view.nextAction).toBe("REBOOK");
    const rebooked = await rebookExpiredHold(player, {
      booking_id: b.data.id,
      payment_ref_no: ref,
      ...key(),
    });
    expect(rebooked.ok && rebooked.data.payment_status).toBe("AWAITING_VERIFICATION");
  });

  it("venues that confirm cash by hand: requests show as held, sit in the inbox, and staff confirm them", async () => {
    const fx = await createVenue({ venue: { auto_confirm_cash_bookings: false } });
    const player = clientAs(await createUser("Cash Player"));
    const req = await createBooking(player, {
      court_id: fx.courtId,
      ...slot(day(7), "18:00"),
      payment_method: "CASH_ON_COURT",
      ...key(),
    });
    if (!req.ok) throw new Error(JSON.stringify(req.error));
    expect(req.data.booking_status).toBe("PENDING_PAYMENT");

    const anon = await getDayAvailability(clientAs(null), {
      court_id: fx.courtId,
      date: day(7),
      duration_minutes: 60,
    });
    expect(anon.ok && anon.data.slots.find((s) => sameInstant(s.start, req.data.start_time))).toMatchObject({
      occupancy: "HELD",
      heldUntil: null,
      fit: "SLOT_TAKEN",
    });
    const desk = clientAs(fx.ownerId);
    const inbox = await listVerificationQueue(desk, fx.venueId);
    expect(inbox.ok && inbox.data.map((i) => [i.id, i.kind])).toEqual([[req.data.id, "CASH_REQUEST"]]);
    const confirmed = await reviewPayment(desk, {
      decision: "CONFIRM_CASH_REQUEST",
      booking_id: req.data.id,
    });
    expect(confirmed.ok && confirmed.data.booking_status).toBe("CONFIRMED");
  });
});

describe("refunds (P5, P6)", () => {
  it("a paid booking cancelled by the player shows up as a refund to make; REFUND settles it", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Changed Plans");
    const { booking, ref } = await holdWithProof(playerId, fx.courtId, day(9), "08:00");
    const desk = clientAs(fx.ownerId);
    await reviewPayment(desk, { decision: "APPROVE", booking_id: booking.id, payment_ref_no: ref });
    const cancelled = await cancelBooking(clientAs(playerId), { booking_id: booking.id });
    expect(cancelled).toMatchObject({ ok: true, data: { refundDue: true } });

    const inbox = await listVerificationQueue(desk, fx.venueId);
    expect(inbox.ok && inbox.data.find((i) => i.id === booking.id)?.kind).toBe("REFUND_DUE");
    const refunded = await reviewPayment(desk, { decision: "REFUND", booking_id: booking.id });
    expect(refunded.ok && refunded.data.payment_status).toBe("REFUNDED");
    const after = await listVerificationQueue(desk, fx.venueId);
    expect(after.ok && after.data.some((i) => i.id === booking.id)).toBe(false);
  });

  it("refunding a confirmed booking before play cancels it", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Rained Out");
    const { booking, ref } = await holdWithProof(playerId, fx.courtId, day(9), "10:00");
    const desk = clientAs(fx.ownerId);
    await reviewPayment(desk, { decision: "APPROVE", booking_id: booking.id, payment_ref_no: ref });
    const refunded = await reviewPayment(desk, { decision: "REFUND", booking_id: booking.id });
    expect(refunded.ok && [refunded.data.booking_status, refunded.data.payment_status]).toEqual([
      "CANCELLED",
      "REFUNDED",
    ]);
  });
});

describe("staff and coaches act on bookings (P3, P9, P10)", () => {
  it("the venue cancelling a booking a live event uses cancels the event too", async () => {
    const fx = await createVenue();
    const organiserId = await createUser("Organiser");
    const b = await createBooking(clientAs(organiserId), {
      court_id: fx.courtId,
      ...slot(day(10), "18:00", 120),
      payment_method: "CASH_ON_COURT",
      ...key(),
    });
    if (!b.ok) throw new Error(JSON.stringify(b.error));
    const ev = await clientAs(organiserId)
      .from("events")
      .insert({
        venue_id: fx.venueId,
        court_id: fx.courtId,
        booking_id: b.data.id,
        organizer_id: organiserId,
        title: "Open play",
        sport: "PICKLEBALL",
        event_type: "OPEN_PLAY",
        status: "SCHEDULED",
        start_time: b.data.start_time,
        end_time: b.data.end_time,
        max_participants: 12,
      })
      .select("id")
      .single();
    expect(ev.error).toBeNull();
    const closure = await createClosure(clientAs(fx.ownerId), {
      venue_id: fx.venueId,
      starts_at: zonedTimeToInstant(day(10), "00:00").toISOString(),
      ends_at: zonedTimeToInstant(day(11), "00:00").toISOString(),
      reason: "Typhoon Signal No. 3",
    });
    expect(closure.ok && closure.data.affected.map((a) => a.id)).toEqual([b.data.id]);
    const cancelled = await cancelBooking(clientAs(fx.ownerId), {
      booking_id: b.data.id,
      reason: "Typhoon Signal No. 3",
    });
    expect(cancelled.ok).toBe(true);
    const [event] = await sql<{ status: string; cancellation_reason: string }>(
      `select status, cancellation_reason from public.events where id = $1`,
      [ev.data!.id],
    );
    expect(event).toEqual({ status: "CANCELLED", cancellation_reason: "Typhoon Signal No. 3" });
  });

  it("a coach sees their sessions and can cancel one", async () => {
    const fx = await createVenue({ venue: { verification_status: "VERIFIED" } });
    const coachId = await createCoach();
    const b = await createBooking(clientAs(await createUser("Student")), {
      court_id: fx.courtId,
      ...slot(day(8), "07:00"),
      payment_method: "CASH_ON_COURT",
      coach_id: coachId,
      ...key(),
    });
    if (!b.ok) throw new Error(JSON.stringify(b.error));
    const coach = clientAs(coachId);
    const sessions = await listMyCoachSessions(coach, { userId: coachId, scope: "upcoming" });
    expect(sessions.ok && sessions.data.map((s) => [s.id, s.player?.full_name])).toEqual([
      [b.data.id, "Student"],
    ]);
    const cancelled = await cancelBooking(coach, { booking_id: b.data.id, reason: "Sick" });
    expect(
      cancelled.ok && [cancelled.data.booking.booking_status, cancelled.data.booking.cancellation_reason],
    ).toEqual(["CANCELLED", "Sick"]);
  });

  it("a player can switch a GCash hold to cash; the desk records cash handed over for a GCash hold", async () => {
    const fx = await createVenue();
    const player = clientAs(await createUser());
    const a = await createBooking(player, {
      court_id: fx.courtId,
      ...slot(day(8), "09:00"),
      payment_method: "GCASH",
      ...key(),
    });
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    const switched = await switchPaymentMethod(player, {
      booking_id: a.data.id,
      payment_method: "CASH_ON_COURT",
    });
    expect(switched.ok && [switched.data.payment_method, switched.data.booking_status]).toEqual([
      "CASH_ON_COURT",
      "CONFIRMED",
    ]);
    expect(
      await switchPaymentMethod(player, { booking_id: a.data.id, payment_method: "MAYA" }),
    ).toMatchObject({
      ok: false,
    });

    const b = await createBooking(player, {
      court_id: fx.courtId,
      ...slot(day(8), "11:00"),
      payment_method: "GCASH",
      ...key(),
    });
    if (!b.ok) throw new Error(JSON.stringify(b.error));
    const cash = await reviewPayment(clientAs(fx.ownerId), {
      decision: "MARK_CASH_COLLECTED",
      booking_id: b.data.id,
    });
    expect(cash.ok && [cash.data.payment_method, cash.data.payment_status, cash.data.booking_status]).toEqual(
      ["CASH_ON_COURT", "PAID", "CONFIRMED"],
    );
  });
});

describe("busy RPCs need an id (S2)", () => {
  it("no id → no rows, for anonymous callers too", async () => {
    const anon = clientAs(null);
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const res = await anon.rpc("get_venue_busy_slots", {
      p_venue_id: null as unknown as string,
      p_from: from,
      p_to: to,
    });
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });
});
