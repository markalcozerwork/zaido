/**
 * The availability grid is a prediction; create_booking is the authority.
 * For every start time of a day, the grid's verdict must equal what actually
 * happens when that slot is booked through PostgREST: "OK" → the booking is
 * created at the grid's price; otherwise the exact DomainError code.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  addDaysToDate,
  FIT_ERROR_CODE,
  toZonedParts,
  zonedTimeToInstant,
  type DaySlot,
  type SlotFit,
} from "../../src/domain";
import {
  createBooking,
  createStaffBooking,
  getDayAvailability,
  getVenueDayAvailability,
} from "../../src/server/bookings";
import { clientAs, createCoach, createUser, createVenue, sql, type VenueFixture } from "./support";

const MANILA = "Asia/Manila";
const today = (tz = MANILA) => toZonedParts(new Date(), tz).date;
const day = (n: number, tz = MANILA) => addDaysToDate(today(tz), n);
/** The next date (≥ 3 days out) falling on `dow` (0 = Sunday) in Manila. */
function nextWeekday(dow: number): string {
  let d = day(3);
  while (toZonedParts(zonedTimeToInstant(d, "12:00"), MANILA).dayOfWeek !== dow) d = addDaysToDate(d, 1);
  return d;
}

interface CheckOptions {
  date: string;
  durationMinutes: number;
  playerId?: string;
  coachId?: string;
  staff?: boolean;
  /** Instants near which the server and database clocks could disagree (now, now + lead). */
  boundaries?: Date[];
}

/** Book every slot of the grid and compare. Returns how often each verdict occurred. */
async function gridMatchesReality(
  fx: VenueFixture,
  o: CheckOptions,
): Promise<Partial<Record<SlotFit, number>>> {
  const actor = o.staff ? fx.ownerId : (o.playerId ?? (await createUser("Grid Checker")));
  const client = clientAs(actor);
  const grid = await getDayAvailability(
    client,
    { court_id: fx.courtId, date: o.date, duration_minutes: o.durationMinutes, coach_id: o.coachId },
    {},
    { mode: o.staff ? "staff" : "player" },
  );
  if (!grid.ok) throw new Error(JSON.stringify(grid.error));

  const seen: Partial<Record<SlotFit, number>> = {};
  const near = (s: DaySlot) =>
    (o.boundaries ?? []).some((b) => Math.abs(new Date(s.start).getTime() - b.getTime()) < 120_000);
  for (const s of grid.data.slots) {
    if (near(s)) continue;
    const request = {
      court_id: fx.courtId,
      start_time: s.start,
      end_time: s.end,
      payment_method: "CASH_ON_COURT" as const,
      coach_id: o.coachId,
      idempotency_key: randomUUID(),
    };
    const res = o.staff ? await createStaffBooking(client, request) : await createBooking(client, request);
    const actual = res.ok ? "OK" : res.error.code;
    const expected = s.fit === "OK" ? "OK" : FIT_ERROR_CODE[s.fit];
    expect(actual, `${o.date} ${toZonedParts(s.start, grid.data.timezone).time} (${s.fit})`).toBe(expected);
    if (res.ok) {
      if (!o.staff) expect(res.data.total_amount, "grid price = charged price").toBe(s.price!.total_amount);
      // Free the slot again (trusted context) so the next start is judged on the fixture alone.
      await sql(`update public.bookings set booking_status = 'CANCELLED' where id = $1`, [res.data.id]);
    }
    seen[s.fit] = (seen[s.fit] ?? 0) + 1;
  }
  return seen;
}

async function bookAs(
  userId: string,
  fx: VenueFixture,
  date: string,
  from: string,
  to: string,
  method = "CASH_ON_COURT",
) {
  const res = await createBooking(clientAs(userId), {
    court_id: fx.courtId,
    start_time: zonedTimeToInstant(date, from).toISOString(),
    end_time: zonedTimeToInstant(date, to).toISOString(),
    payment_method: method,
    idempotency_key: randomUUID(),
  });
  if (!res.ok) throw new Error(`fixture booking failed: ${JSON.stringify(res.error)}`);
  return res.data;
}

describe("grid verdicts ≡ create_booking outcomes", () => {
  it("a regular day: hours, others' bookings and holds, my booking, a closure, closing time", async () => {
    const fx = await createVenue({ venue: { max_active_holds_per_player: 50 } });
    const date = day(5);
    const me = await createUser("Me");
    const other = await createUser("Someone Else");
    await bookAs(other, fx, date, "10:00", "11:00");
    await bookAs(other, fx, date, "13:00", "14:00", "GCASH"); // an unpaid hold
    await bookAs(me, fx, date, "15:00", "16:00");
    await sql(
      `insert into public.court_closures (venue_id, court_id, starts_at, ends_at, reason, created_by) values ($1, $2, $3, $4, 'Resurfacing', $5)`,
      [
        fx.venueId,
        fx.courtId,
        zonedTimeToInstant(date, "18:00"),
        zonedTimeToInstant(date, "19:30"),
        fx.ownerId,
      ],
    );

    for (const durationMinutes of [60, 90]) {
      const seen = await gridMatchesReality(fx, { date, durationMinutes, playerId: me });
      expect(Object.keys(seen).sort()).toEqual(
        [
          "COURT_CLOSED",
          "OK",
          "RUNS_PAST_CLOSING",
          "SLOT_ALREADY_YOURS",
          "SLOT_TAKEN",
          "VENUE_CLOSED",
        ].sort(),
      );
    }
  });

  it("opening hours that run past midnight (Fri 16:00–24:00 + Sat 00:00–02:00)", async () => {
    const fx = await createVenue({
      hours: [
        { day_of_week: 5, opens_at: "16:00", closes_at: "24:00" },
        { day_of_week: 6, opens_at: "00:00", closes_at: "02:00" },
      ],
      venue: { max_active_holds_per_player: 50 },
    });
    const friday = nextWeekday(5);
    // Friday: 16:00–23:30 starts fit (23:00 and 23:30 run into Saturday's early window).
    expect(await gridMatchesReality(fx, { date: friday, durationMinutes: 120 })).toEqual({
      VENUE_CLOSED: 32,
      OK: 16,
    });
    // Saturday: only 00:00 fits a 2-hour slot; 00:30–01:30 run past 02:00.
    expect(await gridMatchesReality(fx, { date: addDaysToDate(friday, 1), durationMinutes: 120 })).toEqual({
      OK: 1,
      RUNS_PAST_CLOSING: 3,
      VENUE_CLOSED: 44,
    });
  });

  it("no published hours: closed unless the venue is explicitly open 24/7", async () => {
    const closed = await createVenue({ hours: false });
    expect(await gridMatchesReality(closed, { date: day(4), durationMinutes: 60 })).toEqual({
      VENUE_HOURS_NOT_SET: 48,
    });
    const open = await createVenue({
      hours: false,
      venue: { is_open_24h: true, max_active_holds_per_player: 50 },
    });
    expect(await gridMatchesReality(open, { date: day(4), durationMinutes: 60 })).toEqual({ OK: 48 });
  });

  it("today: past slots and the venue's lead time", async () => {
    const fx = await createVenue({
      hours: false,
      venue: { is_open_24h: true, min_lead_minutes: 60, max_active_holds_per_player: 50 },
    });
    const now = new Date();
    const seen = await gridMatchesReality(fx, {
      date: today(),
      durationMinutes: 60,
      boundaries: [now, new Date(now.getTime() + 60 * 60_000)],
    });
    // Late in the day every slot may already be past; the verdicts still had to match.
    expect((seen.SLOT_IN_PAST ?? 0) + (seen.TOO_SOON ?? 0) + (seen.OK ?? 0)).toBeGreaterThan(40);
  });

  it("with a coach: availability windows, the coach's other commitments, and the coach fee", async () => {
    const date = day(6);
    const dow = toZonedParts(zonedTimeToInstant(date, "12:00"), MANILA).dayOfWeek;
    const coachId = await createCoach([{ day_of_week: dow, start_time: "06:00", end_time: "12:00" }]);
    const fx = await createVenue({
      venue: { max_active_holds_per_player: 50, verification_status: "VERIFIED" },
    });
    // The coach is busy 09:00–10:00 with another player at another venue.
    const elsewhere = await createVenue({ venue: { verification_status: "VERIFIED" } });
    const res = await createBooking(clientAs(await createUser("Other Student")), {
      court_id: elsewhere.courtId,
      start_time: zonedTimeToInstant(date, "09:00").toISOString(),
      end_time: zonedTimeToInstant(date, "10:00").toISOString(),
      payment_method: "CASH_ON_COURT",
      coach_id: coachId,
      idempotency_key: randomUUID(),
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const seen = await gridMatchesReality(fx, { date, durationMinutes: 60, coachId });
    expect(seen).toEqual({
      VENUE_CLOSED: 12, // 00:00–05:30: the venue's rules come first
      OK: 8, // 06:00–08:00 and 10:00–11:00 starts fit the 06:00–12:00 window
      COACH_UNAVAILABLE: 27, // 08:30–09:30 clash with the other session; 11:30–23:00 leave the window
      RUNS_PAST_CLOSING: 1,
    });
  });

  it("front desk (staff mode): past and after-hours slots are bookable, overlaps are not", async () => {
    const fx = await createVenue();
    const date = today();
    // Someone's session today 12:00–13:00 (inserted directly: it may already be in the past).
    await sql(
      `insert into public.bookings (court_id, booked_by, start_time, end_time, payment_method) values ($1, $2, $3, $4, 'CASH_ON_COURT')`,
      [
        fx.courtId,
        await createUser("Regular"),
        zonedTimeToInstant(date, "12:00"),
        zonedTimeToInstant(date, "13:00"),
      ],
    );
    expect(await gridMatchesReality(fx, { date, durationMinutes: 60, staff: true })).toEqual({
      OK: 45,
      SLOT_TAKEN: 3,
    });
  });

  it("a 25-hour day (US daylight saving ends) books exactly as the grid says", async () => {
    // First Sunday of November in New York, this year or next.
    const year = Number(today().slice(0, 4));
    const firstSunday = (y: number) => {
      let d = `${y}-11-01`;
      while (
        toZonedParts(zonedTimeToInstant(d, "12:00", "America/New_York"), "America/New_York").dayOfWeek !== 0
      )
        d = addDaysToDate(d, 1);
      return d;
    };
    const date = firstSunday(year) > day(1, "America/New_York") ? firstSunday(year) : firstSunday(year + 1);
    if (date > day(89, "America/New_York")) return; // outside every venue's horizon right now
    const fx = await createVenue({
      timezone: "America/New_York",
      hours: false,
      venue: { is_open_24h: true, max_active_holds_per_player: 50 },
    });
    expect(await gridMatchesReality(fx, { date, durationMinutes: 60 })).toEqual({ OK: 50 });
  });

  it("venue view: one call covers every court and agrees with the court view", async () => {
    const fx = await createVenue();
    const date = day(5);
    await bookAs(await createUser("Regular"), fx, date, "18:00", "20:00");
    const player = clientAs(await createUser("Browser"));
    const venue = await getVenueDayAvailability(player, { venue_id: fx.venueId, date, duration_minutes: 60 });
    const court = await getDayAvailability(player, { court_id: fx.courtId, date, duration_minutes: 60 });
    expect(venue.ok && court.ok).toBe(true);
    if (!venue.ok || !court.ok) return;
    expect(venue.data).toHaveLength(1);
    expect(venue.data[0]!.slots).toEqual(court.data.slots);
  });
});
