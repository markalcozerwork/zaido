/**
 * After booking, through PostgREST: payment proof and review, the verification
 * queue, cancellations with refund information, front-desk bookings,
 * reschedules, closures, "My bookings", and the error contract on the wire.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addDaysToDate, sameInstant, toZonedParts, zonedTimeToInstant } from "../../src/domain";
import {
  attachReceipt,
  cancelBooking,
  createBooking,
  createClosure,
  createStaffBooking,
  deleteClosure,
  getDayAvailability,
  listMyBookings,
  listVerificationQueue,
  rescheduleBooking,
  reviewPayment,
  submitPaymentProof,
} from "../../src/server/bookings";
import {
  clientAs,
  createCoach,
  createUser,
  createVenue,
  gcashRef,
  sql,
  updateRow,
  uploadReceipt,
} from "./support";

const day = (n: number) => addDaysToDate(toZonedParts(new Date(), "Asia/Manila").date, n);
const slot = (date: string, from: string, minutes = 60) => {
  const start = zonedTimeToInstant(date, from);
  return {
    start_time: start.toISOString(),
    end_time: new Date(start.getTime() + minutes * 60_000).toISOString(),
  };
};

async function hold(playerId: string, courtId: string, date: string, from: string) {
  const res = await createBooking(clientAs(playerId), {
    court_id: courtId,
    ...slot(date, from),
    payment_method: "GCASH",
    idempotency_key: randomUUID(),
  });
  if (!res.ok) throw new Error(JSON.stringify(res.error));
  return res.data;
}

describe("payments", () => {
  it("reference first, receipt later; the venue approves; the booking is confirmed", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Payer");
    const player = clientAs(playerId);
    const b = await hold(playerId, fx.courtId, day(6), "08:00");

    const ref = gcashRef();
    const submitted = await submitPaymentProof(player, {
      booking_id: b.id,
      payment_method: "GCASH",
      payment_ref_no: ref,
    });
    expect(submitted.ok && submitted.data.payment_status).toBe("AWAITING_VERIFICATION");

    // Someone else's folder or a file that was never uploaded is refused.
    expect(
      await attachReceipt(player, { booking_id: b.id, receipt_path: `${b.id}/missing.png` }),
    ).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_INVALID", field: "receipt_path" },
    });
    const path = await uploadReceipt(b.id);
    const attached = await attachReceipt(player, { booking_id: b.id, receipt_path: path });
    expect(attached.ok && attached.data.payment_receipt_url).toBe(path);

    const owner = clientAs(fx.ownerId);
    const queue = await listVerificationQueue(owner, fx.venueId);
    expect(queue.ok && queue.data.map((q) => [q.id, q.player?.id, q.court?.name, q.kind])).toEqual([
      [b.id, playerId, "Court 1", "PROOF"],
    ]);
    // Players can't verify their own payment.
    expect(
      await reviewPayment(player, { decision: "APPROVE", booking_id: b.id, payment_ref_no: ref }),
    ).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    const approved = await reviewPayment(owner, {
      decision: "APPROVE",
      booking_id: b.id,
      payment_ref_no: ref,
    });
    expect(approved.ok && [approved.data.booking_status, approved.data.payment_status]).toEqual([
      "CONFIRMED",
      "PAID",
    ]);
    // A retried approval after a lost response is harmless.
    expect(
      (await reviewPayment(owner, { decision: "APPROVE", booking_id: b.id, payment_ref_no: ref })).ok,
    ).toBe(true);
  });

  it("a rejected proof re-opens the hold with a fresh payment window", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Typo Payer");
    const b = await hold(playerId, fx.courtId, day(6), "10:00");
    const ref = gcashRef();
    await submitPaymentProof(clientAs(playerId), {
      booking_id: b.id,
      payment_method: "GCASH",
      payment_ref_no: ref,
    });
    const rejected = await reviewPayment(clientAs(fx.ownerId), {
      decision: "REJECT",
      booking_id: b.id,
      payment_ref_no: ref,
      reason: "Reference not found in GCash",
    });
    expect(rejected.ok && rejected.data.payment_status).toBe("REJECTED");
    expect(rejected.ok && new Date(rejected.data.payment_due_at!).getTime()).toBeGreaterThan(
      Date.now() + 25 * 60_000,
    );
  });

  it("a proof sent after the hold (plus grace) expired is HOLD_EXPIRED", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Too Late");
    const b = await hold(playerId, fx.courtId, day(6), "12:00");
    await sql(`update public.bookings set payment_due_at = now() - interval '6 minutes' where id = $1`, [
      b.id,
    ]);
    expect(
      await submitPaymentProof(clientAs(playerId), {
        booking_id: b.id,
        payment_method: "GCASH",
        payment_ref_no: gcashRef(),
      }),
    ).toMatchObject({ ok: false, error: { code: "HOLD_EXPIRED", field: "payment_ref_no" } });
  });

  it("cash collected at the venue confirms payment", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Cash Player");
    const res = await createBooking(clientAs(playerId), {
      court_id: fx.courtId,
      ...slot(day(6), "14:00"),
      payment_method: "CASH_ON_COURT",
      idempotency_key: randomUUID(),
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.data.booking_status).toBe("CONFIRMED");
    const collected = await reviewPayment(clientAs(fx.ownerId), {
      decision: "MARK_CASH_COLLECTED",
      booking_id: res.data.id,
    });
    expect(collected.ok && collected.data.payment_status).toBe("PAID");
  });
});

describe("cancellations", () => {
  it("cancelling after paying (before the cutoff) frees the slot, flags the refund, and stays in the venue's queue", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Changed Plans");
    const player = clientAs(playerId);
    const b = await hold(playerId, fx.courtId, day(8), "18:00");
    await submitPaymentProof(player, {
      booking_id: b.id,
      payment_method: "GCASH",
      payment_ref_no: gcashRef(),
    });

    const cancelled = await cancelBooking(player, { booking_id: b.id, reason: "Rain" });
    expect(cancelled).toMatchObject({
      ok: true,
      data: { refundDue: true, booking: { booking_status: "CANCELLED" } },
    });
    const grid = await getDayAvailability(player, {
      court_id: fx.courtId,
      date: day(8),
      duration_minutes: 60,
    });
    expect(grid.ok && grid.data.slots.find((s) => sameInstant(s.start, b.start_time))?.fit).toBe("OK");

    const queue = await listVerificationQueue(clientAs(fx.ownerId), fx.venueId);
    expect(queue.ok && queue.data.find((q) => q.id === b.id)?.kind).toBe("SETTLE");
  });

  it("CANCELLATION_CUTOFF once the payment was sent inside the venue's cutoff", async () => {
    const fx = await createVenue({ hours: false, venue: { is_open_24h: true } });
    const playerId = await createUser("Last Minute Cancel");
    const start = new Date(Math.ceil((Date.now() + 3 * 3_600_000) / 1_800_000) * 1_800_000);
    const res = await createBooking(clientAs(playerId), {
      court_id: fx.courtId,
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + 3_600_000).toISOString(),
      payment_method: "GCASH",
      payment_ref_no: gcashRef(),
      idempotency_key: randomUUID(),
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(await cancelBooking(clientAs(playerId), { booking_id: res.data.id })).toMatchObject({
      ok: false,
      error: { code: "CANCELLATION_CUTOFF" },
    });
  });

  it("a booking that holds the court for a live event can't be cancelled (COURT_RESERVED_FOR_EVENT)", async () => {
    const fx = await createVenue();
    const organiserId = await createUser("Organiser");
    const date = day(9);
    const res = await createBooking(clientAs(organiserId), {
      court_id: fx.courtId,
      ...slot(date, "18:00", 180),
      payment_method: "CASH_ON_COURT",
      idempotency_key: randomUUID(),
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    const organiser = clientAs(organiserId);
    const event = await organiser
      .from("events")
      .insert({
        venue_id: fx.venueId,
        court_id: fx.courtId,
        booking_id: res.data.id,
        organizer_id: organiserId,
        title: "Open play",
        sport: "PICKLEBALL",
        event_type: "OPEN_PLAY",
        status: "SCHEDULED",
        ...{ start_time: res.data.start_time, end_time: res.data.end_time },
        max_participants: 12,
      })
      .select("id")
      .single();
    expect(event.error).toBeNull();
    expect(await cancelBooking(organiser, { booking_id: res.data.id })).toMatchObject({
      ok: false,
      error: { code: "COURT_RESERVED_FOR_EVENT" },
    });
  });
});

describe("front desk", () => {
  it("walk-in paid at the desk: one call, confirmed and paid, never shown as the staff member's own", async () => {
    const fx = await createVenue();
    const owner = clientAs(fx.ownerId);
    const res = await createStaffBooking(owner, {
      court_id: fx.courtId,
      ...slot(day(5), "19:00"),
      payment_method: "CASH_ON_COURT",
      walk_in_name: "Ate Lorna",
      walk_in_phone: "0917 123 4567",
      mark_paid: true,
      idempotency_key: randomUUID(),
    });
    expect(res.ok && res.data).toMatchObject({
      booking_status: "CONFIRMED",
      payment_status: "PAID",
      walk_in_phone: "+639171234567",
    });
    const grid = await getDayAvailability(owner, {
      court_id: fx.courtId,
      date: day(5),
      duration_minutes: 60,
    });
    expect(
      grid.ok && grid.data.slots.find((s) => res.ok && sameInstant(s.start, res.data.start_time))?.occupancy,
    ).toBe("BOOKED");
  });

  it("booking in a registered player's name needs a verified venue", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Phoned In");
    const request = {
      court_id: fx.courtId,
      ...slot(day(5), "07:00"),
      payment_method: "CASH_ON_COURT",
      booked_by: playerId,
      idempotency_key: randomUUID(),
    };
    expect(await createStaffBooking(clientAs(fx.ownerId), request)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    await updateRow("venues", fx.venueId, { verification_status: "VERIFIED" });
    const res = await createStaffBooking(clientAs(fx.ownerId), { ...request, idempotency_key: randomUUID() });
    expect(res.ok && [res.data.booked_by, res.data.created_by]).toEqual([playerId, fx.ownerId]);
    // The player sees it under My bookings.
    const mine = await listMyBookings(clientAs(playerId), { userId: playerId, scope: "upcoming" });
    expect(mine.ok && mine.data.map((m) => m.id)).toEqual([res.ok && res.data.id]);
  });

  it("players can't use front-desk powers", async () => {
    const fx = await createVenue();
    const player = clientAs(await createUser("Wannabe Staff"));
    expect(
      await createStaffBooking(player, {
        court_id: fx.courtId,
        ...slot(day(5), "09:00"),
        payment_method: "CASH_ON_COURT",
        mark_paid: true,
        idempotency_key: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(
      await createStaffBooking(player, {
        court_id: fx.courtId,
        ...slot(day(5), "09:00"),
        payment_method: "CASH_ON_COURT",
        discount_amount: 100,
        idempotency_key: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("staff reschedule a booking; overlaps are refused; players can't", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Moved");
    const res = await createBooking(clientAs(playerId), {
      court_id: fx.courtId,
      ...slot(day(7), "08:00"),
      payment_method: "CASH_ON_COURT",
      idempotency_key: randomUUID(),
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    const other = await createBooking(clientAs(await createUser("In The Way")), {
      court_id: fx.courtId,
      ...slot(day(7), "12:00"),
      payment_method: "CASH_ON_COURT",
      idempotency_key: randomUUID(),
    });
    expect(other.ok).toBe(true);

    expect(
      await rescheduleBooking(clientAs(playerId), { booking_id: res.data.id, ...slot(day(7), "09:00") }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const owner = clientAs(fx.ownerId);
    expect(
      await rescheduleBooking(owner, { booking_id: res.data.id, ...slot(day(7), "12:30") }),
    ).toMatchObject({
      ok: false,
      error: { code: "SLOT_TAKEN" },
    });
    const moved = await rescheduleBooking(owner, { booking_id: res.data.id, ...slot(day(7), "10:00") });
    expect(moved.ok && sameInstant(moved.data.start_time, slot(day(7), "10:00").start_time)).toBe(true);
  });

  it("closures: staff create and delete them; players see COURT_CLOSED; players can't close courts", async () => {
    const fx = await createVenue();
    const owner = clientAs(fx.ownerId);
    const date = day(4);
    const created = await createClosure(owner, {
      venue_id: fx.venueId,
      starts_at: zonedTimeToInstant(date, "06:00").toISOString(),
      ends_at: zonedTimeToInstant(date, "12:00").toISOString(),
      reason: "Typhoon Signal No. 2",
    });
    expect(created.ok && created.data.closure.created_by).toBe(fx.ownerId);
    const playerId = await createUser("Hopeful");
    const player = clientAs(playerId);
    expect(
      await createBooking(player, {
        court_id: fx.courtId,
        ...slot(date, "08:00"),
        payment_method: "GCASH",
        idempotency_key: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { code: "COURT_CLOSED" } });
    expect(
      await createClosure(player, {
        venue_id: fx.venueId,
        starts_at: zonedTimeToInstant(date, "13:00").toISOString(),
        ends_at: zonedTimeToInstant(date, "14:00").toISOString(),
        reason: "Mine now",
      }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    expect(await deleteClosure(owner, created.ok ? created.data.closure.id : "")).toEqual({
      ok: true,
      data: { deleted: true },
    });
    expect(
      (
        await createBooking(player, {
          court_id: fx.courtId,
          ...slot(date, "08:00"),
          payment_method: "GCASH",
          idempotency_key: randomUUID(),
        })
      ).ok,
    ).toBe(true);
  });
});

describe("my bookings", () => {
  it("lists upcoming bookings with status, cancellation terms and the venue's payment details", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Organised");
    const b = await hold(playerId, fx.courtId, day(3), "17:00");
    const mine = await listMyBookings(clientAs(playerId), { userId: playerId, scope: "upcoming" });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    expect(mine.data).toHaveLength(1);
    expect(mine.data[0]).toMatchObject({
      id: b.id,
      view: { label: "Awaiting payment", nextAction: "PAY" },
      cancellation: { allowed: true, refundEligible: false },
      court: { name: "Court 1", venue: { gcash_number: "+639170000001", timezone: "Asia/Manila" } },
    });
    const past = await listMyBookings(clientAs(playerId), { userId: playerId, scope: "past" });
    expect(past.ok && past.data).toEqual([]);
  });
});

describe("the error contract on the wire", () => {
  it("PostgREST forwards code, message and hint (not the constraint field); the prefix carries the code", async () => {
    const fx = await createVenue();
    const playerId = await createUser("Wire");
    const player = clientAs(playerId);
    const b = await hold(playerId, fx.courtId, day(5), "06:00");
    const raw = await player.rpc("create_booking", {
      p_court_id: fx.courtId,
      ...{ p_start: b.start_time, p_end: b.end_time },
      p_payment_method: "GCASH",
      p_idempotency_key: randomUUID(),
    });
    expect(raw.error).toMatchObject({
      code: "23P01",
      message: "SLOT_ALREADY_YOURS: You already have this court at that time.",
      hint: b.id,
    });
    expect(raw.error).not.toHaveProperty("constraint");
  });

  it("a coach committed to a clinic is COACH_UNAVAILABLE for bookings, even to players who can't see the clinic", async () => {
    const coachId = await createCoach();
    const fx = await createVenue();
    const date = day(10);
    const coach = clientAs(coachId);
    const clinic = await coach
      .from("events")
      .insert({
        organizer_id: coachId,
        coach_id: coachId,
        municipality_code: "9700100000",
        title: "Private-ish clinic",
        sport: "PICKLEBALL",
        event_type: "CLINIC",
        status: "DRAFT",
        start_time: zonedTimeToInstant(date, "08:00").toISOString(),
        end_time: zonedTimeToInstant(date, "10:00").toISOString(),
        max_participants: 6,
      })
      .select("id")
      .single();
    expect(clinic.error).toBeNull();
    await coach
      .from("events")
      .update({ coach_confirmed_at: new Date().toISOString() })
      .eq("id", clinic.data!.id);
    const published = await coach
      .from("events")
      .update({ status: "SCHEDULED" })
      .eq("id", clinic.data!.id)
      .select("id");
    expect(published.error).toBeNull();

    const res = await createBooking(clientAs(await createUser("Student")), {
      court_id: fx.courtId,
      ...slot(date, "09:00"),
      payment_method: "CASH_ON_COURT",
      coach_id: coachId,
      idempotency_key: randomUUID(),
    });
    expect(res).toMatchObject({ ok: false, error: { code: "COACH_UNAVAILABLE", field: "coach_id" } });
  });
});
