import { describe, expect, it } from "vitest";
import {
  coachAvailabilitySchema,
  coachProfileSchema,
  onboardingSchema,
  playerSportProfileSchema,
  toOnboardingWrites,
  type OnboardingInput,
} from "./onboarding";

const PROFILE_ID = "00000000-0000-4000-a000-000000000002";

const base = (overrides: Partial<OnboardingInput> = {}): OnboardingInput => ({
  roles: ["PLAYER"],
  profile: {
    full_name: "  Alice   Santos ",
    municipality_code: "9900100000",
    barangay_code: "9900100001",
  },
  contact: { phone: "0917 123 4567" },
  player_sports: [{ sport: "PICKLEBALL", skill_level: "INTERMEDIATE", rating_system: "DUPR", rating: 3.512 }],
  ...overrides,
});

const messagesAt = (result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) => Object.fromEntries((result.error?.issues ?? []).map((i) => [i.path.join("."), i.message]));

describe("onboardingSchema", () => {
  it("accepts a player and normalises the input", () => {
    const data = onboardingSchema.parse(base());
    expect(data.profile.full_name).toBe("Alice Santos");
    expect(data.contact.phone).toBe("+639171234567");
  });

  it("supports the hybrid Player + Coach role", () => {
    const result = onboardingSchema.safeParse(
      base({
        roles: ["PLAYER", "COACH"],
        coach: { sports_coached: ["PICKLEBALL"], hourly_rate: 800 },
        coach_availability: [{ day_of_week: 1, start_time: "06:00", end_time: "09:00", sport: "PICKLEBALL" }],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("requires sports for players and a coach profile for coaches", () => {
    const issues = messagesAt(
      onboardingSchema.safeParse(base({ roles: ["PLAYER", "COACH"], player_sports: [] })),
    );
    expect(issues).toMatchObject({
      player_sports: "Add at least one sport you play.",
      coach: "Tell players about your coaching.",
    });
  });

  it("rejects role/data mismatches and duplicate sports", () => {
    expect(messagesAt(onboardingSchema.safeParse(base({ roles: ["VENUE_OWNER"] })))).toMatchObject({
      player_sports: "Choose the Player role to add the sports you play.",
    });
    const dup = base({
      player_sports: [
        { sport: "TENNIS", skill_level: "BEGINNER" },
        { sport: "TENNIS", skill_level: "ADVANCED" },
      ],
    });
    expect(messagesAt(onboardingSchema.safeParse(dup))).toMatchObject({
      "player_sports.1.sport": "You already added Tennis.",
    });
  });

  it("rejects availability for a sport the coach doesn't teach", () => {
    const result = onboardingSchema.safeParse(
      base({
        roles: ["COACH"],
        player_sports: undefined,
        coach: { sports_coached: ["TENNIS"], hourly_rate: 800 },
        coach_availability: [{ day_of_week: 1, start_time: "06:00", end_time: "09:00", sport: "BADMINTON" }],
      }),
    );
    expect(messagesAt(result)).toMatchObject({
      "coach_availability.0.sport": "Badminton isn't one of the sports you coach.",
    });
  });

  it("rejects unknown keys (no mass assignment of privileged columns)", () => {
    const sneaky = { ...base(), is_platform_admin: true } as unknown;
    expect(onboardingSchema.safeParse(sneaky).success).toBe(false);
    const sneakyCoach = { sports_coached: ["TENNIS"], hourly_rate: 500, verified_status: "VERIFIED" };
    expect(coachProfileSchema.safeParse(sneakyCoach).success).toBe(false);
  });
});

describe("playerSportProfileSchema mirrors the player_profiles CHECKs", () => {
  it.each([
    [{ sport: "PICKLEBALL", skill_level: "ADVANCED", rating_system: "DUPR", rating: 8 }, true],
    [{ sport: "PICKLEBALL", skill_level: "ADVANCED", rating_system: "DUPR", rating: 8.001 }, false],
    [{ sport: "PICKLEBALL", skill_level: "ADVANCED", rating_system: "DUPR", rating: 3.5125 }, false],
    [{ sport: "TENNIS", skill_level: "ADVANCED", rating_system: "DUPR", rating: 4 }, false],
    [{ sport: "TENNIS", skill_level: "ADVANCED", rating_system: "UTR", rating: 16.5 }, true],
    [{ sport: "BADMINTON", skill_level: "BEGINNER", rating_system: "NTRP", rating: 3 }, false],
    [{ sport: "BADMINTON", skill_level: "BEGINNER", rating: 3 }, false],
    [{ sport: "TENNIS", skill_level: "BEGINNER", dupr_id: "ABC123" }, false],
    [{ sport: "PICKLEBALL", skill_level: "BEGINNER", dupr_id: " abc 123 " }, true],
  ])("%j → %s", (input, ok) => {
    expect(playerSportProfileSchema.safeParse(input).success).toBe(ok);
  });

  it("normalises DUPR IDs to upper case (the DB unique index is case-insensitive)", () => {
    expect(
      playerSportProfileSchema.parse({ sport: "PICKLEBALL", skill_level: "BEGINNER", dupr_id: "ab12cd" })
        .dupr_id,
    ).toBe("AB12CD");
  });
});

describe("coach rules", () => {
  it("requires at least one offering and a group rate for clinics", () => {
    expect(
      messagesAt(
        coachProfileSchema.safeParse({ sports_coached: ["TENNIS"], hourly_rate: 500, offers_private: false }),
      ),
    ).toMatchObject({ offers_private: "Offer private sessions, group clinics, or both." });
    expect(
      messagesAt(
        coachProfileSchema.safeParse({
          sports_coached: ["TENNIS"],
          hourly_rate: 500,
          offers_group_clinics: true,
        }),
      ),
    ).toMatchObject({ group_rate_per_pax: "Set a per-player rate for group clinics." });
  });

  it("rejects overlapping availability on the same weekday (DB exclusion constraint)", () => {
    const result = coachAvailabilitySchema.safeParse([
      { day_of_week: 2, start_time: "06:00", end_time: "10:00" },
      { day_of_week: 2, start_time: "09:30", end_time: "11:00", sport: "TENNIS" },
      { day_of_week: 3, start_time: "09:30", end_time: "11:00" },
      { day_of_week: 2, start_time: "10:00", end_time: "12:00" },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual(["1.start_time", "3.start_time"]);
  });
});

describe("toOnboardingWrites", () => {
  it("maps a hybrid player/coach submission onto table payloads", () => {
    const data = onboardingSchema.parse(
      base({
        roles: ["PLAYER", "COACH"],
        coach: { sports_coached: ["PICKLEBALL"], hourly_rate: 800, request_verification: true },
        coach_availability: [{ day_of_week: 6, start_time: "07:00", end_time: "10:00" }],
      }),
    );
    const writes = toOnboardingWrites(PROFILE_ID, data, new Date("2026-10-13T00:00:00Z"));

    expect(writes.profile).toMatchObject({
      full_name: "Alice Santos",
      display_name: null,
      is_player: true,
      is_coach: true,
      is_venue_owner: false,
      onboarding_completed_at: "2026-10-13T00:00:00.000Z",
    });
    expect(writes.contact).toEqual({
      profile_id: PROFILE_ID,
      phone: "+639171234567",
      birth_date: null,
      emergency_contact_name: null,
      emergency_contact_phone: null,
    });
    expect(writes.playerProfiles).toEqual([
      {
        profile_id: PROFILE_ID,
        sport: "PICKLEBALL",
        skill_level: "INTERMEDIATE",
        rating_system: "DUPR",
        rating: 3.512,
      },
    ]);
    // Omitted fields stay omitted so the DB defaults apply; verification goes to PENDING, never VERIFIED.
    expect(writes.coachProfile).toEqual({
      profile_id: PROFILE_ID,
      sports_coached: ["PICKLEBALL"],
      hourly_rate: 800,
      verified_status: "PENDING",
    });
    expect(writes.coachAvailability).toEqual([
      { coach_id: PROFILE_ID, day_of_week: 6, start_time: "07:00", end_time: "10:00" },
    ]);
  });
});
