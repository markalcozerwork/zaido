/**
 * Onboarding schemas ↔ profiles / player_profiles / coach_profiles /
 * coach_availability, executed as the signed-in user under RLS.
 */
import { describe, expect, it } from "vitest";
import {
  coachAvailabilitySchema,
  coachProfileSchema,
  mapDatabaseError,
  onboardingSchema,
  playerSportProfileSchema,
  profileBasicsSchema,
  contactDetailsSchema,
  toCoachAvailabilityInsert,
  toCoachProfileInsert,
  toOnboardingWrites,
  toPlayerProfileInsert,
  type OnboardingInput,
} from "../../src/domain";
import {
  LOC,
  createUser,
  insertSql,
  makeCoach,
  run,
  seedLocations,
  tryRun,
  updateSql,
  useContractDb,
  type Db,
  type Statement,
} from "./harness";

const db = useContractDb();

const fullOnboarding = (): OnboardingInput => ({
  roles: ["PLAYER", "COACH", "VENUE_OWNER"],
  profile: {
    full_name: "A".repeat(120),
    display_name: "D".repeat(40),
    bio: "b".repeat(1000),
    municipality_code: LOC.municipality,
    barangay_code: LOC.barangay,
    dominant_hand: "LEFT",
  },
  contact: {
    phone: "0918 765 4321",
    birth_date: "1990-02-28",
    emergency_contact_name: "Mama Santos",
    emergency_contact_phone: "0917 000 9999",
  },
  player_sports: [
    {
      sport: "PICKLEBALL",
      skill_level: "PRO",
      rating_system: "DUPR",
      rating: 8,
      dupr_id: "zz9999",
      years_playing: 80,
    },
    { sport: "TENNIS", skill_level: "BEGINNER", rating_system: "UTR", rating: 1 },
    { sport: "BADMINTON", skill_level: "ADVANCED", rating_system: "SELF_ASSESSED", rating: 10 },
    { sport: "TABLE_TENNIS", skill_level: "INTERMEDIATE", play_style: "SINGLES" },
  ],
  coach: {
    sports_coached: ["PICKLEBALL", "TENNIS", "BADMINTON", "TABLE_TENNIS"],
    hourly_rate: 100_000,
    group_rate_per_pax: 0,
    offers_group_clinics: true,
    bio: "c".repeat(2000),
    credentials: Array.from({ length: 20 }, (_, i) => `Certificate ${i + 1}`),
    years_experience: 80,
    request_verification: true,
  },
  coach_availability: [
    { day_of_week: 0, start_time: "00:00", end_time: "24:00" },
    { day_of_week: 1, start_time: "06:00", end_time: "09:00", sport: "TENNIS" },
    { day_of_week: 1, start_time: "09:00", end_time: "12:00", sport: "PICKLEBALL" },
  ],
});

/** Applies OnboardingWrites exactly as a server action would, as the user. */
async function applyOnboarding(db: Db, userId: string, input: OnboardingInput) {
  const w = toOnboardingWrites(userId, onboardingSchema.parse(input));
  await db.asUser(userId);
  const steps = [
    updateSql("profiles", w.profile, { id: userId }),
    {
      sql: `insert into public.profile_contacts (profile_id, phone, birth_date, emergency_contact_name, emergency_contact_phone)
            values ($1, $2, $3, $4, $5)
            on conflict (profile_id) do update set phone = excluded.phone, birth_date = excluded.birth_date,
              emergency_contact_name = excluded.emergency_contact_name, emergency_contact_phone = excluded.emergency_contact_phone
            returning *`,
      params: [
        w.contact.profile_id,
        w.contact.phone,
        w.contact.birth_date,
        w.contact.emergency_contact_name,
        w.contact.emergency_contact_phone,
      ],
    },
    ...w.playerProfiles.map((p) => insertSql("player_profiles", p)),
    ...(w.coachProfile ? [insertSql("coach_profiles", w.coachProfile)] : []),
    ...w.coachAvailability.map((a) => insertSql("coach_availability", a)),
  ];
  for (const st of steps) {
    const r = await tryRun(db, st);
    if (!r.ok) return r;
  }
  await db.asAdmin();
  return { ok: true as const };
}

describe("soundness: everything onboarding accepts, the database accepts", () => {
  it("a maximal hybrid submission (every limit at its boundary) is stored as-is", async () => {
    await seedLocations(db);
    const user = await createUser(db);
    expect(await applyOnboarding(db, user, fullOnboarding())).toEqual({ ok: true });

    const [profile] = await db.exec(
      `select p.is_player, p.is_coach, p.is_venue_owner, c.phone, cp.verified_status,
              (select count(*)::int from public.player_profiles where profile_id = p.id) as sports,
              (select count(*)::int from public.coach_availability where coach_id = p.id) as windows
         from public.profiles p
         join public.profile_contacts c on c.profile_id = p.id
         join public.coach_profiles cp on cp.profile_id = p.id
        where p.id = $1`,
      [user],
    );
    expect(profile).toEqual({
      is_player: true,
      is_coach: true,
      is_venue_owner: true,
      phone: "+639187654321",
      verified_status: "PENDING",
      sports: 4,
      windows: 3,
    });
  });
});

describe("completeness: boundaries the database rejects are rejected by Zod first", () => {
  /**
   * Each case: a Zod input that must fail, and the raw DB write that the
   * database must reject. If Zod accepted it, the user would hit an opaque
   * database error instead of a field error.
   */
  type Case = { name: string; zod: () => boolean; db: (user: string) => Statement };
  const player = { sport: "PICKLEBALL", skill_level: "BEGINNER" } as const;
  const coach = { sports_coached: ["TENNIS"], hourly_rate: 500 } as const;
  const basics = { full_name: "Ok Name", municipality_code: LOC.municipality, barangay_code: LOC.barangay };

  const cases: Case[] = [
    {
      name: "full_name longer than 120",
      zod: () => profileBasicsSchema.safeParse({ ...basics, full_name: "x".repeat(121) }).success,
      db: (u) => updateSql("profiles", { full_name: "x".repeat(121) }, { id: u }),
    },
    {
      name: "full_name of 1 character (after trim)",
      zod: () => profileBasicsSchema.safeParse({ ...basics, full_name: "  x  " }).success,
      db: (u) => updateSql("profiles", { full_name: "  x  " }, { id: u }),
    },
    {
      name: "display_name longer than 40",
      zod: () => profileBasicsSchema.safeParse({ ...basics, display_name: "x".repeat(41) }).success,
      db: (u) => updateSql("profiles", { display_name: "x".repeat(41) }, { id: u }),
    },
    {
      name: "bio longer than 1000",
      zod: () => profileBasicsSchema.safeParse({ ...basics, bio: "x".repeat(1001) }).success,
      db: (u) => updateSql("profiles", { bio: "x".repeat(1001) }, { id: u }),
    },
    {
      name: "malformed mobile number",
      zod: () => contactDetailsSchema.safeParse({ phone: "0917 123 456" }).success,
      db: (u) => updateSql("profile_contacts", { phone: "+63917123456" }, { profile_id: u }),
    },
    {
      name: "DUPR above 8.000",
      zod: () =>
        playerSportProfileSchema.safeParse({ ...player, rating_system: "DUPR", rating: 8.001 }).success,
      db: (u) =>
        insertSql("player_profiles", { profile_id: u, ...player, rating_system: "DUPR", rating: 8.001 }),
    },
    {
      name: "NTRP below 1.0",
      zod: () =>
        playerSportProfileSchema.safeParse({
          sport: "TENNIS",
          skill_level: "BEGINNER",
          rating_system: "NTRP",
          rating: 0.5,
        }).success,
      db: (u) =>
        insertSql("player_profiles", {
          profile_id: u,
          sport: "TENNIS",
          skill_level: "BEGINNER",
          rating_system: "NTRP",
          rating: 0.5,
        }),
    },
    {
      name: "DUPR rating on tennis",
      zod: () =>
        playerSportProfileSchema.safeParse({
          sport: "TENNIS",
          skill_level: "BEGINNER",
          rating_system: "DUPR",
          rating: 4,
        }).success,
      db: (u) =>
        insertSql("player_profiles", {
          profile_id: u,
          sport: "TENNIS",
          skill_level: "BEGINNER",
          rating_system: "DUPR",
          rating: 4,
        }),
    },
    {
      name: "rating without a rating system",
      zod: () => playerSportProfileSchema.safeParse({ ...player, rating: 4 }).success,
      db: (u) => insertSql("player_profiles", { profile_id: u, ...player, rating: 4 }),
    },
    {
      name: "DUPR ID on badminton",
      zod: () =>
        playerSportProfileSchema.safeParse({ sport: "BADMINTON", skill_level: "BEGINNER", dupr_id: "ABC123" })
          .success,
      db: (u) =>
        insertSql("player_profiles", {
          profile_id: u,
          sport: "BADMINTON",
          skill_level: "BEGINNER",
          dupr_id: "ABC123",
        }),
    },
    {
      name: "years_playing above 80",
      zod: () => playerSportProfileSchema.safeParse({ ...player, years_playing: 81 }).success,
      db: (u) => insertSql("player_profiles", { profile_id: u, ...player, years_playing: 81 }),
    },
    {
      name: "coach hourly rate above ₱100,000",
      zod: () => coachProfileSchema.safeParse({ ...coach, hourly_rate: 100_000.01 }).success,
      db: (u) => insertSql("coach_profiles", { profile_id: u, ...coach, hourly_rate: 100_000.01 }),
    },
    {
      name: "coach lists a sport twice",
      zod: () => coachProfileSchema.safeParse({ ...coach, sports_coached: ["TENNIS", "TENNIS"] }).success,
      db: (u) =>
        insertSql("coach_profiles", { profile_id: u, ...coach, sports_coached: ["TENNIS", "TENNIS"] }),
    },
    {
      name: "coach offers nothing",
      zod: () => coachProfileSchema.safeParse({ ...coach, offers_private: false }).success,
      db: (u) => insertSql("coach_profiles", { profile_id: u, ...coach, offers_private: false }),
    },
    {
      name: "coach bio longer than 2000",
      zod: () => coachProfileSchema.safeParse({ ...coach, bio: "x".repeat(2001) }).success,
      db: (u) => insertSql("coach_profiles", { profile_id: u, ...coach, bio: "x".repeat(2001) }),
    },
    {
      name: "availability ending before it starts",
      zod: () =>
        coachAvailabilitySchema.safeParse([{ day_of_week: 1, start_time: "10:00", end_time: "09:00" }])
          .success,
      db: (u) =>
        insertSql("coach_availability", {
          coach_id: u,
          day_of_week: 1,
          start_time: "10:00",
          end_time: "09:00",
        }),
    },
    {
      name: "availability on day 7",
      zod: () =>
        coachAvailabilitySchema.safeParse([{ day_of_week: 7, start_time: "09:00", end_time: "10:00" }])
          .success,
      db: (u) =>
        insertSql("coach_availability", {
          coach_id: u,
          day_of_week: 7,
          start_time: "09:00",
          end_time: "10:00",
        }),
    },
  ];

  it.each(cases)("$name", async ({ zod, db: dbWrite }) => {
    await seedLocations(db);
    const user = await createUser(db);
    const write = dbWrite(user);
    if (write.sql.includes("coach_availability")) await makeCoach(db, user);

    const dbResult = await tryRun(db, write);
    expect(dbResult.ok, "the database must reject this case (otherwise the case is meaningless)").toBe(false);
    expect(zod(), "Zod must reject what the database rejects").toBe(false);
  });

  it("overlapping coach availability (exclusion constraint) is caught by Zod", async () => {
    await seedLocations(db);
    const user = await createUser(db);
    await makeCoach(db, user);
    const windows = [
      { day_of_week: 2, start_time: "06:00", end_time: "10:00" },
      { day_of_week: 2, start_time: "09:30", end_time: "11:00" },
    ];
    await run(db, insertSql("coach_availability", toCoachAvailabilityInsert(user, windows[0]!)));
    const r = await tryRun(db, insertSql("coach_availability", toCoachAvailabilityInsert(user, windows[1]!)));
    expect(r).toMatchObject({ ok: false, code: "23P01" });
    expect(coachAvailabilitySchema.safeParse(windows).success).toBe(false);
  });
});

describe("rules only the database can check surface as typed field errors", () => {
  it("barangay outside the municipality → INVALID_REFERENCE on barangay_code", async () => {
    await seedLocations(db);
    const user = await createUser(db);
    const input = profileBasicsSchema.parse({
      full_name: "Juan Dela Cruz",
      municipality_code: LOC.municipality,
      barangay_code: LOC.otherBarangay,
    });
    await db.asUser(user);
    const r = await tryRun(db, updateSql("profiles", input, { id: user }));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(mapDatabaseError(r)).toMatchObject({ code: "INVALID_REFERENCE", field: "barangay_code" });
  });

  it("a second account with the same DUPR ID → CONFLICT on dupr_id", async () => {
    await seedLocations(db);
    const [a, b] = [await createUser(db), await createUser(db)];
    const p = playerSportProfileSchema.parse({
      sport: "PICKLEBALL",
      skill_level: "ADVANCED",
      dupr_id: "dupr42",
    });
    await run(db, insertSql("player_profiles", toPlayerProfileInsert(a, p)));
    await db.asUser(b);
    const r = await tryRun(
      db,
      insertSql("player_profiles", toPlayerProfileInsert(b, { ...p, dupr_id: "DUPR42" })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(mapDatabaseError(r)).toMatchObject({ code: "CONFLICT", field: "dupr_id" });
  });

  it("a coach cannot smuggle VERIFIED through the mapper", async () => {
    await seedLocations(db);
    const user = await createUser(db);
    const row = toCoachProfileInsert(
      user,
      coachProfileSchema.parse({ sports_coached: ["TENNIS"], hourly_rate: 500, request_verification: true }),
    );
    await db.asUser(user);
    const r = await tryRun(db, insertSql("coach_profiles", row));
    expect(r.ok && r.rows[0]?.verified_status).toBe("PENDING");
  });
});
