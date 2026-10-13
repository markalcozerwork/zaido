/**
 * createBooking end to end: supabase-js → PostgREST 13 → create_booking under
 * RLS, with real concurrency (separate HTTP requests on separate connections).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addDaysToDate, toZonedParts, zonedTimeToInstant } from "../../src/domain";
import { createBooking, quoteBooking, rebookExpiredHold } from "../../src/server/bookings";
import { clientAs, createUser, createVenue, gcashRef, loseResponses, sql } from "./support";

const day = (n: number) => addDaysToDate(toZonedParts(new Date(), "Asia/Manila").date, n);
const slot = (date: string, from: string, minutes = 60) => {
  const start = zonedTimeToInstant(date, from);
  return {
    start_time: start.toISOString(),
    end_time: new Date(start.getTime() + minutes * 60_000).toISOString(),
  };
};

describe("createBooking through PostgREST", () => {
  it("creates a hold priced by the database, stamped with the caller", async () => {
    const { courtId } = await createVenue();
    const playerId = await createUser("Ana Player");
    const player = clientAs(playerId);
    const times = slot(day(7), "18:00", 90);

    const res = await createBooking(player, {
      court_id: courtId,
      ...times,
      payment_method: "GCASH",
      player_count: 4,
      idempotency_key: randomUUID(),
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const quote = await quoteBooking(player, { court_id: courtId, ...times });
    expect(quote.ok && quote.data.total_amount).toBe(res.data.total_amount);
    expect(res.data).toMatchObject({
      booked_by: playerId,
      created_by: playerId,
      booking_status: "PENDING_PAYMENT",
      payment_status: "UNPAID",
      player_count: 4,
    });
    const dueIn = (new Date(res.data.payment_due_at!).getTime() - Date.now()) / 60_000;
    expect(dueIn).toBeGreaterThan(28);
    expect(dueIn).toBeLessThanOrEqual(30);
  });

  it("10 players racing for one slot: exactly 1 booking, 9 clean SLOT_TAKEN", async () => {
    const { courtId } = await createVenue();
    const players = await Promise.all(Array.from({ length: 10 }, (_, i) => createUser(`Racer ${i}`)));
    const times = slot(day(8), "19:00");
    const results = await Promise.all(
      players.map((id) =>
        createBooking(clientAs(id), {
          court_id: courtId,
          ...times,
          payment_method: "CASH_ON_COURT",
          idempotency_key: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const losers = results.filter((r) => !r.ok);
    expect(losers.map((r) => !r.ok && r.error.code)).toEqual(Array(9).fill("SLOT_TAKEN"));
    expect(losers.every((r) => !r.ok && r.error.message.startsWith("Sorry, that time was just booked"))).toBe(
      true,
    );
    const [{ n }] = (await sql<{ n: number }>(
      `select count(*)::int as n from public.bookings where court_id = $1 and booking_status <> 'CANCELLED'`,
      [courtId],
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it("a double-tapped checkout (5 concurrent calls, one key) creates one booking and returns it to every call", async () => {
    const { courtId } = await createVenue();
    const playerId = await createUser("Double Tapper");
    const key = randomUUID();
    const request = {
      court_id: courtId,
      ...slot(day(9), "07:00"),
      payment_method: "GCASH",
      idempotency_key: key,
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createBooking(clientAs(playerId), request)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => r.ok && r.data.id)).size).toBe(1);
    const rows = await sql(`select id from public.bookings where created_by = $1 and idempotency_key = $2`, [
      playerId,
      key,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("survives a lost response: the retry returns the booking that was created", async () => {
    const { courtId } = await createVenue();
    const playerId = await createUser("Weak Signal");
    const network = loseResponses((url) => url.includes("/rpc/create_booking"));
    const flaky = clientAs(playerId, { wrapFetch: network.wrap });
    const key = randomUUID();
    const res = await createBooking(
      flaky,
      { court_id: courtId, ...slot(day(9), "09:00"), payment_method: "GCASH", idempotency_key: key },
      { retry: { baseDelayMs: 10 } },
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const rows = await sql<{ id: string }>(
      `select id from public.bookings where created_by = $1 and idempotency_key = $2`,
      [playerId, key],
    );
    expect(rows.map((r) => r.id)).toEqual([res.ok && res.data.id]);
    expect(network.state).toEqual({ lost: 1, calls: 2 });
  });

  it("reusing a checkout key for a different slot is IDEMPOTENCY_KEY_REUSED", async () => {
    const { courtId } = await createVenue();
    const player = clientAs(await createUser());
    const key = randomUUID();
    const base = { court_id: courtId, payment_method: "GCASH", idempotency_key: key };
    expect((await createBooking(player, { ...base, ...slot(day(10), "08:00") })).ok).toBe(true);
    expect(await createBooking(player, { ...base, ...slot(day(10), "10:00") })).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_KEY_REUSED" },
    });
  });

  it("booking your own slot again with a new key says SLOT_ALREADY_YOURS and points at the booking", async () => {
    const { courtId } = await createVenue();
    const player = clientAs(await createUser());
    const times = slot(day(10), "12:00");
    const first = await createBooking(player, {
      court_id: courtId,
      ...times,
      payment_method: "GCASH",
      idempotency_key: randomUUID(),
    });
    expect(first.ok).toBe(true);
    const again = await createBooking(player, {
      court_id: courtId,
      ...times,
      payment_method: "GCASH",
      idempotency_key: randomUUID(),
    });
    expect(again).toMatchObject({
      ok: false,
      error: {
        code: "SLOT_ALREADY_YOURS",
        field: "start_time",
        meta: { bookingId: first.ok && first.data.id },
      },
    });
  });

  it("replaying a checkout whose hold expired says HOLD_EXPIRED; rebooking with the reference works", async () => {
    const { courtId } = await createVenue();
    const playerId = await createUser("Late Payer");
    const player = clientAs(playerId);
    const key = randomUUID();
    const request = {
      court_id: courtId,
      ...slot(day(11), "16:00"),
      payment_method: "GCASH",
      idempotency_key: key,
    };
    const first = await createBooking(player, request);
    if (!first.ok) throw new Error(JSON.stringify(first));
    await sql(`update public.bookings set payment_due_at = now() - interval '10 minutes' where id = $1`, [
      first.data.id,
    ]);
    await sql(`select app.expire_unpaid_bookings()`);

    expect(await createBooking(player, request)).toMatchObject({
      ok: false,
      error: { code: "HOLD_EXPIRED", meta: { bookingId: first.data.id } },
    });

    const rebooked = await rebookExpiredHold(player, {
      booking_id: first.data.id,
      payment_ref_no: gcashRef(),
      idempotency_key: randomUUID(),
    });
    expect(rebooked.ok, JSON.stringify(rebooked)).toBe(true);
    expect(rebooked.ok && rebooked.data).toMatchObject({
      start_time: first.data.start_time,
      payment_status: "AWAITING_VERIFICATION",
    });
  });

  it("anonymous visitors cannot book", async () => {
    const { courtId } = await createVenue();
    const res = await createBooking(clientAs(null), {
      court_id: courtId,
      ...slot(day(7), "10:00"),
      payment_method: "GCASH",
      idempotency_key: randomUUID(),
    });
    expect(res).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("HOLD_LIMIT_REACHED once a player holds the venue's maximum of unpaid slots", async () => {
    const { courtId } = await createVenue({ venue: { max_active_holds_per_player: 2 } });
    const player = clientAs(await createUser("Squatter"));
    const book = (from: string) =>
      createBooking(player, {
        court_id: courtId,
        ...slot(day(12), from),
        payment_method: "GCASH",
        idempotency_key: randomUUID(),
      });
    expect((await book("08:00")).ok).toBe(true);
    expect((await book("10:00")).ok).toBe(true);
    expect(await book("12:00")).toMatchObject({ ok: false, error: { code: "HOLD_LIMIT_REACHED" } });
  });

  it("PAY_FIRST for an e-wallet slot that starts inside the payment window; fine with the reference", async () => {
    const { courtId } = await createVenue({ hours: false, venue: { is_open_24h: true } });
    const player = clientAs(await createUser("Last Minute"));
    const start = new Date(Math.ceil((Date.now() + 5 * 60_000) / 1_800_000) * 1_800_000);
    const times = {
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + 3_600_000).toISOString(),
    };
    expect(
      await createBooking(player, {
        court_id: courtId,
        ...times,
        payment_method: "GCASH",
        idempotency_key: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { code: "PAY_FIRST", field: "payment_ref_no" } });
    const paid = await createBooking(player, {
      court_id: courtId,
      ...times,
      payment_method: "GCASH",
      payment_ref_no: gcashRef(),
      idempotency_key: randomUUID(),
    });
    expect(paid.ok && paid.data.payment_status).toBe("AWAITING_VERIFICATION");
  });
});
