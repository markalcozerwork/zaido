/**
 * Venue / court / rate-rule / opening-hours schemas ↔ the database, plus
 * DB_DEFAULTS ↔ the actual column defaults.
 */
import { describe, expect, it } from "vitest";
import {
  DB_DEFAULTS,
  VENUE_AMENITY_LABELS,
  courtCreateSchema,
  courtRateRuleSchema,
  operatingHoursSchema,
  sameHoursEveryDay,
  toCourtInsert,
  toOperatingHoursInserts,
  toRateRuleInsert,
  toVenueInsert,
  toVenueUpdate,
  venueCreateSchema,
  venueUpdateSchema,
  type VenueAmenity,
} from "../../src/domain";
import {
  LOC,
  createUser,
  insertSql,
  run,
  seedLocations,
  tryRun,
  updateSql,
  useContractDb,
  type Statement,
} from "./harness";

const db = useContractDb();

const VENUE_ID = "a0000000-0000-4000-a000-000000000001";
const COURT_ID = "a0000000-0000-4000-a000-000000000002";

const venueInput = {
  name: "V".repeat(120),
  description: "d".repeat(4000),
  municipality_code: LOC.municipality,
  barangay_code: LOC.barangay,
  address: "A".repeat(300),
  location: { latitude: 14.5715, longitude: 121.0614 },
  contact_number: "(02) 8123 4567",
  contact_email: "  Desk@Example.PH ",
  amenities: Object.keys(VENUE_AMENITY_LABELS) as VenueAmenity[],
  photo_urls: Array.from({ length: 20 }, (_, i) => `${VENUE_ID}/photo-${i}.webp`),
  gcash: { account_name: "Olivia O.", number: "0917 000 0001" },
  maya: { account_name: "Olivia O.", number: "0917 000 0002" },
  bank_transfer_details: "BPI 1234-5678-90, Olivia O.",
  accepts_cash_on_court: false,
  auto_confirm_cash_bookings: false,
  payment_window_minutes: 1440,
  cancellation_cutoff_hours: 168,
  timezone: "Asia/Manila",
  min_lead_minutes: 1440,
  booking_horizon_days: 90,
  max_active_holds_per_player: 50,
  is_open_24h: true,
};

async function ownerWithVenue() {
  await seedLocations(db);
  const owner = await createUser(db, "Olivia Owner");
  await db.asUser(owner);
  const r = await tryRun(
    db,
    insertSql("venues", { id: VENUE_ID, ...toVenueInsert(owner, venueCreateSchema.parse(venueInput)) }),
  );
  if (!r.ok) throw new Error(`venue fixture failed: ${r.message}`);
  return owner;
}

describe("soundness", () => {
  it("a maximal venue, its courts, rates and hours are accepted as the owner (RLS on)", async () => {
    await ownerWithVenue();

    const courts = [
      {
        name: "C".repeat(60),
        sport: "PICKLEBALL",
        surface_type: "ACRYLIC",
        hourly_rate: 100_000,
        lights_fee_per_hour: 100_000,
        slot_increment_minutes: 15,
        min_booking_minutes: 15,
        max_booking_minutes: 720,
        max_players: 64,
        sort_order: 999,
        is_indoor: true,
        lights_from: "00:00",
        lights_until: "23:45",
        notes: "n".repeat(500),
      },
      { name: "Court 2", sport: "BADMINTON", surface_type: "TARAFLEX", hourly_rate: 0 },
      {
        name: "Court 3",
        sport: "TENNIS",
        surface_type: "CLAY",
        hourly_rate: 350.75,
        slot_increment_minutes: 60,
        min_booking_minutes: 60,
        max_booking_minutes: 60,
      },
    ];
    for (const [i, c] of courts.entries()) {
      const row = toCourtInsert(courtCreateSchema.parse({ venue_id: VENUE_ID, ...c }));
      const r = await tryRun(db, insertSql("courts", i === 0 ? { id: COURT_ID, ...row } : row));
      expect(r, c.name).toMatchObject({ ok: true });
    }

    const rule = courtRateRuleSchema.parse({
      court_id: COURT_ID,
      label: "L".repeat(60),
      days_of_week: [0, 1, 2, 3, 4, 5, 6],
      start_time: "00:00",
      end_time: "24:00",
      hourly_rate: 100_000,
      priority: 1000,
      valid_from: "2026-01-01",
      valid_until: "2026-01-01",
    });
    expect(await tryRun(db, insertSql("court_rate_rules", toRateRuleInsert(rule)))).toMatchObject({
      ok: true,
    });

    const hours = operatingHoursSchema.parse([
      ...sameHoursEveryDay("06:00", "12:00"),
      ...sameHoursEveryDay("12:00", "24:00"),
      { day_of_week: 6, opens_at: "00:00", closes_at: "02:00" },
    ]);
    for (const h of toOperatingHoursInserts(VENUE_ID, hours)) {
      expect(await tryRun(db, insertSql("venue_operating_hours", h))).toMatchObject({ ok: true });
    }
  });

  it("PATCH updates (including clearing pairs with null) are accepted", async () => {
    await ownerWithVenue();
    const patch = toVenueUpdate(
      venueUpdateSchema.parse({
        gcash: null,
        location: null,
        contact_email: null,
        accepts_cash_on_court: true,
        name: "Renamed Hub",
      }),
    );
    const r = await tryRun(db, updateSql("venues", patch, { id: VENUE_ID }));
    expect(r.ok && r.rows[0]).toMatchObject({
      gcash_number: null,
      gcash_account_name: null,
      latitude: null,
      name: "Renamed Hub",
    });
  });
});

describe("completeness: what the database rejects, Zod rejects", () => {
  type Case = { name: string; zod: () => boolean; db: () => Statement };
  const v = (over: Record<string, unknown>) => ({ ...venueInput, ...over });
  const venueRow = (over: Record<string, unknown>) => ({
    owner_id: "00000000-0000-4000-a000-00000000ffff",
    name: "Hub",
    municipality_code: LOC.municipality,
    barangay_code: LOC.barangay,
    address: "12 Some Street",
    ...over,
  });
  const court = {
    venue_id: VENUE_ID,
    name: "Court X",
    sport: "PICKLEBALL",
    surface_type: "ACRYLIC",
    hourly_rate: 400,
  };
  const rule = {
    court_id: COURT_ID,
    label: "Peak",
    days_of_week: [1],
    start_time: "17:00",
    end_time: "22:00",
    hourly_rate: 600,
  };

  const cases: Case[] = [
    {
      name: "venue name 121 chars",
      zod: () => venueCreateSchema.safeParse(v({ name: "x".repeat(121) })).success,
      db: () => insertSql("venues", venueRow({ name: "x".repeat(121) })),
    },
    {
      name: "venue address 4 chars",
      zod: () => venueCreateSchema.safeParse(v({ address: "abcd" })).success,
      db: () => insertSql("venues", venueRow({ address: "abcd" })),
    },
    {
      name: "description 4001 chars",
      zod: () => venueCreateSchema.safeParse(v({ description: "x".repeat(4001) })).success,
      db: () => insertSql("venues", venueRow({ description: "x".repeat(4001) })),
    },
    {
      name: "21 photos",
      zod: () => venueCreateSchema.safeParse(v({ photo_urls: Array(21).fill("a/b.jpg") })).success,
      db: () => insertSql("venues", venueRow({ photo_urls: Array(21).fill("a/b.jpg") })),
    },
    {
      name: "duplicate amenity",
      zod: () => venueCreateSchema.safeParse(v({ amenities: ["WIFI", "WIFI"] })).success,
      db: () => insertSql("venues", venueRow({ amenities: ["WIFI", "WIFI"] })),
    },
    {
      name: "payment window 4 minutes",
      zod: () => venueCreateSchema.safeParse(v({ payment_window_minutes: 4 })).success,
      db: () => insertSql("venues", venueRow({ payment_window_minutes: 4 })),
    },
    {
      name: "payment window 1441 minutes",
      zod: () => venueCreateSchema.safeParse(v({ payment_window_minutes: 1441 })).success,
      db: () => insertSql("venues", venueRow({ payment_window_minutes: 1441 })),
    },
    {
      name: "minimum lead time 1441 minutes",
      zod: () => venueCreateSchema.safeParse(v({ min_lead_minutes: 1441 })).success,
      db: () => insertSql("venues", venueRow({ min_lead_minutes: 1441 })),
    },
    {
      name: "booking horizon 0 days",
      zod: () => venueCreateSchema.safeParse(v({ booking_horizon_days: 0 })).success,
      db: () => insertSql("venues", venueRow({ booking_horizon_days: 0 })),
    },
    {
      name: "booking horizon 91 days",
      zod: () => venueCreateSchema.safeParse(v({ booking_horizon_days: 91 })).success,
      db: () => insertSql("venues", venueRow({ booking_horizon_days: 91 })),
    },
    {
      name: "hold cap 0",
      zod: () => venueCreateSchema.safeParse(v({ max_active_holds_per_player: 0 })).success,
      db: () => insertSql("venues", venueRow({ max_active_holds_per_player: 0 })),
    },
    {
      name: "hold cap 51",
      zod: () => venueCreateSchema.safeParse(v({ max_active_holds_per_player: 51 })).success,
      db: () => insertSql("venues", venueRow({ max_active_holds_per_player: 51 })),
    },
    {
      name: "negative lead time",
      zod: () => venueCreateSchema.safeParse(v({ min_lead_minutes: -1 })).success,
      db: () => insertSql("venues", venueRow({ min_lead_minutes: -1 })),
    },
    {
      name: "cancellation cutoff 169 hours",
      zod: () => venueCreateSchema.safeParse(v({ cancellation_cutoff_hours: 169 })).success,
      db: () => insertSql("venues", venueRow({ cancellation_cutoff_hours: 169 })),
    },
    {
      name: "malformed GCash number",
      zod: () => venueCreateSchema.safeParse(v({ gcash: { account_name: "O", number: "12345" } })).success,
      db: () => insertSql("venues", venueRow({ gcash_account_name: "O", gcash_number: "12345" })),
    },
    {
      name: "malformed contact number",
      zod: () => venueCreateSchema.safeParse(v({ contact_number: "8123 4567" })).success,
      db: () => insertSql("venues", venueRow({ contact_number: "+6381234567" })),
    },
    {
      name: "unknown time zone",
      zod: () => venueCreateSchema.safeParse(v({ timezone: "Asia/Atlantis" })).success,
      db: () => insertSql("venues", venueRow({ timezone: "Asia/Atlantis" })),
    },
    {
      name: "latitude above 90",
      zod: () =>
        venueCreateSchema.safeParse(v({ location: { latitude: 90.5, longitude: 121 }, timezone: "UTC" }))
          .success,
      db: () => insertSql("venues", venueRow({ latitude: 90.5, longitude: 121 })),
    },
    {
      name: "court name 61 chars",
      zod: () => courtCreateSchema.safeParse({ ...court, name: "x".repeat(61) }).success,
      db: () => insertSql("courts", { ...court, name: "x".repeat(61) }),
    },
    {
      name: "court rate above ₱100,000",
      zod: () => courtCreateSchema.safeParse({ ...court, hourly_rate: 100_000.5 }).success,
      db: () => insertSql("courts", { ...court, hourly_rate: 100_000.5 }),
    },
    {
      name: "20-minute slot increment",
      zod: () => courtCreateSchema.safeParse({ ...court, slot_increment_minutes: 20 }).success,
      db: () => insertSql("courts", { ...court, slot_increment_minutes: 20 }),
    },
    {
      name: "minimum not a multiple of the increment",
      zod: () => courtCreateSchema.safeParse({ ...court, min_booking_minutes: 45 }).success,
      db: () => insertSql("courts", { ...court, min_booking_minutes: 45 }),
    },
    {
      name: "maximum shorter than default minimum",
      zod: () => courtCreateSchema.safeParse({ ...court, max_booking_minutes: 30 }).success,
      db: () => insertSql("courts", { ...court, max_booking_minutes: 30 }),
    },
    {
      name: "maximum above 12 hours",
      zod: () => courtCreateSchema.safeParse({ ...court, max_booking_minutes: 750 }).success,
      db: () => insertSql("courts", { ...court, max_booking_minutes: 750 }),
    },
    {
      name: "65 players",
      zod: () => courtCreateSchema.safeParse({ ...court, max_players: 65 }).success,
      db: () => insertSql("courts", { ...court, max_players: 65 }),
    },
    {
      name: "rate rule on day 7",
      zod: () => courtRateRuleSchema.safeParse({ ...rule, days_of_week: [7] }).success,
      db: () => insertSql("court_rate_rules", { ...rule, days_of_week: [7] }),
    },
    {
      name: "rate rule with a duplicate day",
      zod: () => courtRateRuleSchema.safeParse({ ...rule, days_of_week: [1, 1] }).success,
      db: () => insertSql("court_rate_rules", { ...rule, days_of_week: [1, 1] }),
    },
    {
      name: "rate rule ending at its start",
      zod: () => courtRateRuleSchema.safeParse({ ...rule, end_time: "17:00" }).success,
      db: () => insertSql("court_rate_rules", { ...rule, end_time: "17:00" }),
    },
    {
      name: "rate rule valid_until before valid_from",
      zod: () =>
        courtRateRuleSchema.safeParse({ ...rule, valid_from: "2026-12-02", valid_until: "2026-12-01" })
          .success,
      db: () =>
        insertSql("court_rate_rules", { ...rule, valid_from: "2026-12-02", valid_until: "2026-12-01" }),
    },
    {
      name: "rate rule label 61 chars",
      zod: () => courtRateRuleSchema.safeParse({ ...rule, label: "x".repeat(61) }).success,
      db: () => insertSql("court_rate_rules", { ...rule, label: "x".repeat(61) }),
    },
    {
      name: "opening window closing before it opens",
      zod: () =>
        operatingHoursSchema.safeParse([{ day_of_week: 1, opens_at: "22:00", closes_at: "02:00" }]).success,
      db: () =>
        insertSql("venue_operating_hours", {
          venue_id: VENUE_ID,
          day_of_week: 1,
          opens_at: "22:00",
          closes_at: "02:00",
        }),
    },
  ];

  it.each(cases)("$name", async ({ zod, db: write }) => {
    await seedLocations(db);
    await db.exec(
      `insert into auth.users (id, email) values ('00000000-0000-4000-a000-00000000ffff', 'cfixture@example.ph') on conflict do nothing`,
    );
    await run(db, insertSql("venues", venueRow({ id: VENUE_ID })));
    await run(db, insertSql("courts", { id: COURT_ID, ...court, name: "Fixture Court" }));

    const dbResult = await tryRun(db, write());
    expect(dbResult.ok, "the database must reject this case").toBe(false);
    expect(zod(), "Zod must reject what the database rejects").toBe(false);
  });

  it("overlapping opening windows (exclusion constraint) are caught by Zod", async () => {
    await ownerWithVenue();
    const windows = [
      { day_of_week: 3, opens_at: "06:00", closes_at: "12:00" },
      { day_of_week: 3, opens_at: "11:00", closes_at: "14:00" },
    ];
    await run(db, insertSql("venue_operating_hours", { venue_id: VENUE_ID, ...windows[0] }));
    expect(
      await tryRun(db, insertSql("venue_operating_hours", { venue_id: VENUE_ID, ...windows[1] })),
    ).toMatchObject({ ok: false, code: "23P01" });
    expect(operatingHoursSchema.safeParse(windows).success).toBe(false);
  });
});

describe("DB_DEFAULTS match the column defaults in the migrations", () => {
  const normalise = (raw: string | null) => {
    if (raw === null) return null;
    const literal = /^'(.*)'::/.exec(raw)?.[1] ?? raw;
    if (literal === "true" || literal === "false") return literal === "true";
    if (/^\d{2}:\d{2}:\d{2}$/.test(literal)) return literal.slice(0, 5);
    if (/^-?\d+(\.\d+)?$/.test(literal)) return Number(literal);
    return literal;
  };

  it.each([
    ["venues", DB_DEFAULTS.venue],
    ["courts", DB_DEFAULTS.court],
    ["coach_profiles", DB_DEFAULTS.coach],
    ["player_profiles", DB_DEFAULTS.player],
  ] as const)("%s", async (table, expected) => {
    const rows = await db.exec<{ column_name: string; column_default: string | null }>(
      `select column_name, column_default from information_schema.columns
        where table_schema = 'public' and table_name = $1 and column_name = any($2)`,
      [table, Object.keys(expected)],
    );
    const actual = Object.fromEntries(rows.map((r) => [r.column_name, normalise(r.column_default)]));
    expect(actual).toEqual(expected);
  });
});
