import { describe, expect, it } from "vitest";
import {
  availabilityQuerySchema,
  buildDaySlots,
  busyFetchWindow,
  FIT_ERROR_CODE,
  formatSlotRange,
  nextRefreshAt,
  type BusyRange,
  type CourtBookingContext,
  type DaySlot,
} from "./availability";
import { estimateCourtPrice } from "./court";
import { zonedTimeToInstant } from "./time";

const NOW = new Date("2026-10-13T00:00:00Z"); // Tue 08:00 Manila
const MONDAY = "2026-10-19";

const ctx: CourtBookingContext = {
  court: {
    id: "20000000-0000-4000-a000-000000000001",
    venue_id: "10000000-0000-4000-a000-000000000001",
    name: "Court 1",
    sport: "PICKLEBALL",
    is_active: true,
    hourly_rate: 400,
    lights_fee_per_hour: 100,
    lights_from: "18:00:00",
    lights_until: "06:00:00",
    slot_increment_minutes: 30,
    min_booking_minutes: 60,
    max_booking_minutes: 240,
  },
  venue: {
    id: "10000000-0000-4000-a000-000000000001",
    name: "Kapitolyo Pickleball Hub",
    timezone: "Asia/Manila",
    is_active: true,
    verification_status: "VERIFIED",
    accepts_cash_on_court: true,
    gcash_number: "+639170000001",
    maya_number: null,
    bank_transfer_details: null,
    auto_confirm_cash_bookings: true,
    payment_window_minutes: 30,
    cancellation_cutoff_hours: 24,
    min_lead_minutes: 0,
    booking_horizon_days: 90,
    is_open_24h: false,
    max_active_holds_per_player: 3,
  },
  operatingHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    day_of_week: d,
    opens_at: "06:00:00",
    closes_at: "24:00:00",
  })),
  rateRules: [],
};

const at = (time: string, date = MONDAY) => zonedTimeToInstant(date, time).toISOString();
const busy = (from: string, to: string, over: Partial<BusyRange> = {}): BusyRange => ({
  start_time: at(from),
  end_time: at(to),
  kind: "BOOKED",
  is_mine: false,
  booking_id: null,
  held_until: null,
  reason: null,
  ...over,
});

function grid(over: Partial<Parameters<typeof buildDaySlots>[0]> = {}): Map<string, DaySlot> {
  const slots = buildDaySlots({ ctx, busy: [], date: MONDAY, durationMinutes: 60, now: NOW, ...over });
  const tz = (over.ctx ?? ctx).venue.timezone;
  return new Map(slots.map((s) => [formatSlotRange(s.start, s.start, tz).slice(0, 5), s]));
}

describe("buildDaySlots", () => {
  it("offers every increment of the local day; late slots may end after midnight", () => {
    const slots = buildDaySlots({ ctx, busy: [], date: MONDAY, durationMinutes: 60, now: NOW });
    expect(slots).toHaveLength(48);
    expect(slots[0]!.start).toBe(at("00:00"));
    expect(slots.at(-1)!.end).toBe(at("00:30", "2026-10-20"));
  });

  it("respects opening hours: before opening, ends exactly at closing, runs past closing", () => {
    const g = grid();
    expect(g.get("05:00")!.fit).toBe("VENUE_CLOSED");
    expect(g.get("05:30")!.fit).toBe("VENUE_CLOSED");
    expect(g.get("06:00")!.fit).toBe("OK");
    expect(g.get("23:00")!.fit).toBe("OK");
    expect(g.get("23:30")!.fit).toBe("RUNS_PAST_CLOSING");
    expect(FIT_ERROR_CODE.RUNS_PAST_CLOSING).toBe("VENUE_CLOSED");
  });

  it("separates what occupies a time from whether the chosen duration fits there", () => {
    const g = grid({ busy: [busy("18:00", "19:00")] });
    expect(g.get("18:00")).toMatchObject({ occupancy: "BOOKED", fit: "SLOT_TAKEN", price: null });
    // Free at 17:30, but a 60-minute booking would run into 18:00.
    expect(g.get("17:30")).toMatchObject({ occupancy: "FREE", fit: "SLOT_TAKEN" });
    expect(g.get("17:00")).toMatchObject({ occupancy: "FREE", fit: "OK", maxBookableMinutes: 60 });
    expect(g.get("19:00")).toMatchObject({ fit: "OK", maxBookableMinutes: 240 });
  });

  it("shows live holds with their expiry, and treats dead holds as free", () => {
    const live = busy("10:00", "11:00", { kind: "HOLD", held_until: "2026-10-13T00:20:00Z" });
    const dead = busy("12:00", "13:00", { kind: "HOLD", held_until: "2026-10-12T23:59:00Z" });
    const g = grid({ busy: [live, dead] });
    expect(g.get("10:00")).toMatchObject({
      occupancy: "HELD",
      fit: "SLOT_TAKEN",
      heldUntil: "2026-10-13T00:20:00Z",
    });
    expect(g.get("12:00")).toMatchObject({ occupancy: "FREE", fit: "OK", heldUntil: null });
    expect(nextRefreshAt([live, dead], NOW)?.toISOString()).toBe("2026-10-13T00:20:00.000Z");
    expect(nextRefreshAt([dead], NOW)).toBeNull();
  });

  it("an unconfirmed cash hold (no expiry) stays held", () => {
    const g = grid({ busy: [busy("10:00", "11:00", { kind: "HOLD" })] });
    expect(g.get("10:00")).toMatchObject({ occupancy: "HELD", heldUntil: null, fit: "SLOT_TAKEN" });
  });

  it("recognises the caller's own booking (SLOT_ALREADY_YOURS, with its id)", () => {
    const mine = busy("20:00", "21:00", {
      is_mine: true,
      booking_id: "30000000-0000-4000-a000-000000000001",
    });
    const g = grid({ busy: [mine] });
    expect(g.get("20:00")).toMatchObject({
      occupancy: "MINE",
      fit: "SLOT_ALREADY_YOURS",
      myBookingId: "30000000-0000-4000-a000-000000000001",
    });
    expect(FIT_ERROR_CODE.SLOT_ALREADY_YOURS).toBe("SLOT_ALREADY_YOURS");
  });

  it("shows closures with their reason", () => {
    const g = grid({ busy: [busy("15:00", "17:00", { kind: "CLOSED", reason: "Typhoon Signal No. 2" })] });
    expect(g.get("15:00")).toMatchObject({
      occupancy: "CLOSED",
      fit: "COURT_CLOSED",
      closureReason: "Typhoon Signal No. 2",
    });
    expect(g.get("14:30")!.fit).toBe("COURT_CLOSED");
    expect(g.get("17:00")!.fit).toBe("OK");
  });

  it("applies time rules against the server clock (today: past, pay-first flag)", () => {
    const g = grid({ date: "2026-10-13" });
    expect(g.get("07:30")!.fit).toBe("SLOT_IN_PAST");
    expect(g.get("08:00")).toMatchObject({ fit: "OK", payFirst: true });
    expect(g.get("08:30")).toMatchObject({ fit: "OK", payFirst: false });
    expect(g.get("07:30")!.maxBookableMinutes).toBe(0);
  });

  it("applies the venue's lead time and day-based horizon", () => {
    const lead = { ...ctx, venue: { ...ctx.venue, min_lead_minutes: 120 } };
    expect(grid({ ctx: lead, date: "2026-10-13" }).get("09:30")!.fit).toBe("TOO_SOON");
    expect(grid({ ctx: lead, date: "2026-10-13" }).get("10:00")!.fit).toBe("OK");
    const horizon = { ...ctx, venue: { ...ctx.venue, booking_horizon_days: 2 } };
    expect(grid({ ctx: horizon, date: "2026-10-15" }).get("23:00")!.fit).toBe("OK");
    expect(grid({ ctx: horizon, date: "2026-10-16" }).get("06:00")!.fit).toBe("BEYOND_HORIZON");
  });

  it("without hours a venue is bookable only when explicitly open 24/7", () => {
    const noHours = { ...ctx, operatingHours: [] };
    expect(grid({ ctx: noHours }).get("03:00")!.fit).toBe("VENUE_HOURS_NOT_SET");
    const allDay = { ...noHours, venue: { ...ctx.venue, is_open_24h: true } };
    expect(grid({ ctx: allDay }).get("03:00")).toMatchObject({ fit: "OK", maxBookableMinutes: 240 });
  });

  it("checks durations: off-increment and out-of-range lengths", () => {
    expect(grid({ durationMinutes: 45 }).get("10:00")!.fit).toBe("OFF_INCREMENT");
    expect(grid({ durationMinutes: 30 }).get("10:00")!.fit).toBe("DURATION_OUT_OF_RANGE");
    expect(grid({ durationMinutes: 270 }).get("10:00")!.fit).toBe("DURATION_OUT_OF_RANGE");
    expect(() => grid({ durationMinutes: 10_000 })).toThrow(RangeError);
  });

  it("maxBookableMinutes stops at closing, at the court maximum, and is 0 below the minimum", () => {
    const g = grid();
    expect(g.get("06:00")!.maxBookableMinutes).toBe(240);
    expect(g.get("22:30")!.maxBookableMinutes).toBe(90);
    expect(g.get("23:30")!.maxBookableMinutes).toBe(0);
  });

  it("prices only fitting slots, exactly like estimateCourtPrice (lights after 18:00)", () => {
    const slot = grid().get("17:30")!;
    expect(slot.price).toEqual(
      estimateCourtPrice({
        court: ctx.court,
        rules: [],
        start: new Date(slot.start),
        end: new Date(slot.end),
        timeZone: "Asia/Manila",
      }),
    );
    expect(slot.price).toMatchObject({ court_amount: 400, lights_amount: 50, total_amount: 450 });
  });

  it("with a coach: availability windows, existing commitments, and the coach fee", () => {
    const coach = {
      hourlyRate: 800,
      windows: [{ day_of_week: 1, start_time: "06:00:00", end_time: "12:00:00" }],
      busy: [{ start_time: at("09:00"), end_time: at("10:00") }],
    };
    const g = grid({ coach });
    expect(g.get("13:00")!.fit).toBe("COACH_UNAVAILABLE");
    expect(g.get("11:30")!.fit).toBe("COACH_UNAVAILABLE"); // runs past the window
    expect(g.get("09:00")!.fit).toBe("COACH_UNAVAILABLE");
    expect(g.get("07:00")).toMatchObject({ fit: "OK", maxBookableMinutes: 120 });
    expect(g.get("07:00")!.price).toMatchObject({ court_amount: 400, coach_amount: 800, total_amount: 1200 });
  });

  it("staff mode follows the rules the database applies to venue staff", () => {
    const today = (t: string) => at(t, "2026-10-13");
    const mine = {
      ...busy("18:00", "19:00", { is_mine: true }),
      start_time: today("18:00"),
      end_time: today("19:00"),
    };
    const g = grid({ mode: "staff", date: "2026-10-13", busy: [mine] });
    expect(g.get("07:00")!.fit).toBe("OK"); // past: recording a session that already happened
    expect(g.get("05:00")!.fit).toBe("OK"); // outside hours
    expect(g.get("18:00")!.fit).toBe("SLOT_TAKEN"); // overlaps still count, "mine" included
  });

  it("handles a 25-hour DST day in a non-Manila venue", () => {
    const ny = {
      ...ctx,
      venue: { ...ctx.venue, timezone: "America/New_York", is_open_24h: true },
      operatingHours: [],
    };
    const slots = buildDaySlots({ ctx: ny, busy: [], date: "2026-11-01", durationMinutes: 60, now: NOW });
    expect(slots).toHaveLength(50);
    expect(slots.every((s) => s.fit === "OK")).toBe(true);
  });
});

describe("busyFetchWindow", () => {
  it("covers the local day plus the longest booking that can start on it", () => {
    const w = busyFetchWindow(MONDAY, "Asia/Manila", 240);
    expect(w.from.toISOString()).toBe("2026-10-18T16:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-10-19T20:00:00.000Z");
  });
});

describe("availabilityQuerySchema", () => {
  const ok = { court_id: ctx.court.id, date: MONDAY, duration_minutes: 90 };
  it.each([
    ["an absurd duration", { duration_minutes: 10_000_000 }],
    ["a duration off the 15-minute grid", { duration_minutes: 50 }],
    ["a bad date", { date: "2026-02-30" }],
    ["unknown keys", { now: "2020-01-01T00:00:00Z" }],
  ])("rejects %s before any work is done", (_label, over) => {
    expect(availabilityQuerySchema.safeParse({ ...ok, ...over }).success).toBe(false);
  });
  it("accepts a normal query", () => {
    expect(availabilityQuerySchema.parse(ok)).toEqual(ok);
  });
});
