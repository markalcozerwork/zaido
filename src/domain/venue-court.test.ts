import { describe, expect, it } from "vitest";
import {
  courtCreateSchema,
  courtRateRuleSchema,
  estimateCourtPrice,
  isInDailyWindow,
  type RateRulePricing,
} from "./court";
import { zonedTimeToInstant } from "./time";
import {
  operatingHoursSchema,
  sameHoursEveryDay,
  toVenueInsert,
  toVenueUpdate,
  venueCreateSchema,
  venueUpdateSchema,
} from "./venue";

const OWNER = "00000000-0000-4000-a000-000000000001";
const VENUE = "10000000-0000-4000-a000-000000000001";
const COURT = "20000000-0000-4000-a000-000000000001";

const venue = {
  name: "Kapitolyo Pickleball Hub",
  municipality_code: "9900100000",
  barangay_code: "9900100001",
  address: "12 East Capitol Drive, Kapitolyo, Pasig",
  gcash: { account_name: "Olivia O.", number: "0917 000 0001" },
  location: { latitude: 14.5715, longitude: 121.0614 },
};

describe("venueCreateSchema", () => {
  it("flattens payment channels and keeps DB defaults out of the insert", () => {
    const insert = toVenueInsert(OWNER, venueCreateSchema.parse(venue));
    expect(insert).toEqual({
      owner_id: OWNER,
      name: "Kapitolyo Pickleball Hub",
      municipality_code: "9900100000",
      barangay_code: "9900100001",
      address: "12 East Capitol Drive, Kapitolyo, Pasig",
      latitude: 14.5715,
      longitude: 121.0614,
      gcash_account_name: "Olivia O.",
      gcash_number: "+639170000001",
    });
  });

  it("catches swapped coordinates for PH venues", () => {
    const r = venueCreateSchema.safeParse({ ...venue, location: { latitude: 121.0614, longitude: 14.5715 } });
    expect(r.success).toBe(false);
    const r2 = venueCreateSchema.safeParse({ ...venue, location: { latitude: 1.3, longitude: 103.8 } });
    expect(r2.error?.issues[0]?.path).toEqual(["location"]);
  });

  it("requires at least one way to pay", () => {
    const r = venueCreateSchema.safeParse({ ...venue, gcash: undefined, accepts_cash_on_court: false });
    expect(r.error?.issues[0]?.path).toEqual(["accepts_cash_on_court"]);
  });

  it("rejects unknown time zones and privileged columns", () => {
    expect(venueCreateSchema.safeParse({ ...venue, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(venueCreateSchema.safeParse({ ...venue, verification_status: "VERIFIED" }).success).toBe(false);
    expect(venueCreateSchema.safeParse({ ...venue, owner_id: OWNER }).success).toBe(false);
  });
});

describe("venueUpdateSchema", () => {
  it("distinguishes omitted (unchanged) from null (clear)", () => {
    expect(toVenueUpdate(venueUpdateSchema.parse({ gcash: null, location: null }))).toEqual({
      gcash_account_name: null,
      gcash_number: null,
      latitude: null,
      longitude: null,
    });
    expect(toVenueUpdate(venueUpdateSchema.parse({ name: "New Name" }))).toEqual({ name: "New Name" });
  });

  it("does not apply defaults on PATCH and rejects empty patches", () => {
    expect(venueUpdateSchema.parse({ is_active: false })).toEqual({ is_active: false });
    expect(venueUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe("operatingHoursSchema", () => {
  it("accepts daily 06:00–24:00 and overnight split windows", () => {
    expect(operatingHoursSchema.safeParse(sameHoursEveryDay("06:00", "24:00")).success).toBe(true);
    expect(
      operatingHoursSchema.safeParse([
        { day_of_week: 5, opens_at: "16:00", closes_at: "24:00" },
        { day_of_week: 6, opens_at: "00:00", closes_at: "02:00" },
      ]).success,
    ).toBe(true);
  });

  it("rejects closing before opening and overlaps", () => {
    expect(
      operatingHoursSchema.safeParse([{ day_of_week: 1, opens_at: "22:00", closes_at: "02:00" }]).success,
    ).toBe(false);
    const r = operatingHoursSchema.safeParse([
      ...sameHoursEveryDay("06:00", "24:00"),
      { day_of_week: 1, opens_at: "20:00", closes_at: "22:00" },
    ]);
    expect(r.error?.issues.map((i) => i.path.join("."))).toEqual(["7.opens_at"]);
  });
});

describe("courtCreateSchema", () => {
  const court = {
    venue_id: VENUE,
    name: "Court 1",
    sport: "PICKLEBALL",
    surface_type: "ACRYLIC",
    hourly_rate: 400,
  };

  it("mirrors the courts duration CHECKs, defaults included", () => {
    expect(courtCreateSchema.safeParse(court).success).toBe(true);
    expect(courtCreateSchema.safeParse({ ...court, min_booking_minutes: 45 }).success).toBe(false); // not /30
    expect(
      courtCreateSchema.safeParse({ ...court, slot_increment_minutes: 15, min_booking_minutes: 45 }).success,
    ).toBe(true);
    expect(courtCreateSchema.safeParse({ ...court, max_booking_minutes: 30 }).success).toBe(false); // < default min 60
    expect(courtCreateSchema.safeParse({ ...court, max_booking_minutes: 750 }).success).toBe(false); // > 12h
    expect(courtCreateSchema.safeParse({ ...court, slot_increment_minutes: 20 }).success).toBe(false);
  });

  it("validates rate rules", () => {
    const rule = {
      court_id: COURT,
      label: "Peak",
      days_of_week: [1, 2],
      start_time: "17:00",
      end_time: "22:00",
      hourly_rate: 600,
    };
    expect(courtRateRuleSchema.safeParse(rule).success).toBe(true);
    expect(courtRateRuleSchema.safeParse({ ...rule, days_of_week: [1, 1] }).success).toBe(false);
    expect(courtRateRuleSchema.safeParse({ ...rule, days_of_week: [7] }).success).toBe(false);
    expect(courtRateRuleSchema.safeParse({ ...rule, end_time: "17:00" }).success).toBe(false);
    expect(
      courtRateRuleSchema.safeParse({ ...rule, valid_from: "2026-12-01", valid_until: "2026-11-30" }).success,
    ).toBe(false);
  });
});

describe("estimateCourtPrice (mirror of quote_court_booking)", () => {
  const court = {
    hourly_rate: 400,
    lights_fee_per_hour: 100,
    lights_from: "18:00:00",
    lights_until: "06:00:00",
  };
  const rule = (over: Partial<RateRulePricing>): RateRulePricing => ({
    id: "r",
    days_of_week: [1, 2, 3, 4, 5],
    start_time: "17:00:00",
    end_time: "22:00:00",
    hourly_rate: 600,
    priority: 10,
    valid_from: null,
    valid_until: null,
    is_active: true,
    created_at: "2026-10-13T00:00:00+00:00",
    ...over,
  });
  const rules = [
    rule({ id: "peak" }),
    rule({
      id: "weekend",
      days_of_week: [0, 6],
      start_time: "00:00:00",
      end_time: "24:00:00",
      hourly_rate: 700,
      priority: 20,
    }),
  ];
  // 2026-10-19 is a Monday.
  const at = (date: string, from: string, to: string) => ({
    start: zonedTimeToInstant(date, from),
    end: zonedTimeToInstant(date, to),
  });

  it.each([
    [
      "Mon 10–11 base",
      at("2026-10-19", "10:00", "11:00"),
      { court_amount: 400, lights_amount: 0, total_amount: 400 },
    ],
    [
      "Mon 17–19 peak + lights",
      at("2026-10-19", "17:00", "19:00"),
      { court_amount: 1200, lights_amount: 100, total_amount: 1300 },
    ],
    [
      "Mon 21:30–22:30 split",
      at("2026-10-19", "21:30", "22:30"),
      { court_amount: 500, lights_amount: 100, total_amount: 600 },
    ],
    [
      "Sat 10–11:30 weekend",
      at("2026-10-24", "10:00", "11:30"),
      { court_amount: 1050, lights_amount: 0, total_amount: 1050 },
    ],
  ])("%s", (_label, slot, expected) => {
    expect(estimateCourtPrice({ court, rules, ...slot, timeZone: "Asia/Manila" })).toMatchObject(expected);
  });

  it("adds the coach fee, ignores inactive rules, and respects validity dates", () => {
    const slot = at("2026-10-19", "10:00", "11:30");
    expect(
      estimateCourtPrice({ court, rules, ...slot, timeZone: "Asia/Manila", coachHourlyRate: 800 }),
    ).toEqual({
      court_amount: 600,
      lights_amount: 0,
      coach_amount: 1200,
      total_amount: 1800,
    });
    const holiday = rule({
      id: "holiday",
      days_of_week: [1],
      start_time: "00:00:00",
      end_time: "24:00:00",
      hourly_rate: 900,
      priority: 50,
      valid_from: "2026-10-19",
      valid_until: "2026-10-19",
    });
    expect(
      estimateCourtPrice({
        court,
        rules: [...rules, holiday],
        ...at("2026-10-19", "10:00", "11:00"),
        timeZone: "Asia/Manila",
      }).court_amount,
    ).toBe(900);
    expect(
      estimateCourtPrice({
        court,
        rules: [...rules, holiday],
        ...at("2026-10-26", "10:00", "11:00"),
        timeZone: "Asia/Manila",
      }).court_amount,
    ).toBe(400);
    expect(
      estimateCourtPrice({
        court,
        rules: [{ ...holiday, is_active: false }],
        ...at("2026-10-19", "10:00", "11:00"),
        timeZone: "Asia/Manila",
      }).court_amount,
    ).toBe(400);
  });

  it("matches the SQL lights window semantics, including wrap past midnight", () => {
    expect(isInDailyWindow(23 * 60, "18:00", "06:00")).toBe(true);
    expect(isInDailyWindow(5 * 60 + 45, "18:00", "06:00")).toBe(true);
    expect(isInDailyWindow(6 * 60, "18:00", "06:00")).toBe(false);
    expect(isInDailyWindow(12 * 60, "08:00", "08:00")).toBe(true);
  });
});
