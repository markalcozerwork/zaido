/**
 * User onboarding: choose roles (Player, Coach, both, Court owner), set up the
 * public profile and private contact details, add per-sport player profiles,
 * and, for coaches, the coaching profile and weekly availability.
 *
 * Club organising isn't a role flag: any user can start a club.
 */
import { z } from "zod";
import type { InsertRow, UpdateRow } from "../db";
import {
  DAY_OF_WEEK_LABELS,
  RATING_RANGES,
  RATING_SYSTEMS_BY_SPORT,
  RATING_SYSTEM_LABELS,
  SPORT_LABELS,
  dominantHandSchema,
  playStyleSchema,
  ratingSystemSchema,
  skillLevelSchema,
  sportSchema,
} from "./enums";
import { DB_DEFAULTS, LIMITS } from "./limits";
import { pesoAmountSchema } from "./money";
import { compact } from "./object";
import {
  dayOfWeekSchema,
  httpsUrlSchema,
  isDistinct,
  isoDateSchema,
  line,
  minutesSinceMidnight,
  optionalLine,
  optionalParagraphs,
  phMobileSchema,
  psgcCodeSchema,
  startTimeOfDaySchema,
  storagePathSchema,
  timeOfDaySchema,
} from "./primitives";
import { findWeeklyOverlaps } from "./schedule";
import { DEFAULT_TIME_ZONE, toZonedParts } from "./time";

// -----------------------------------------------------------------------------
// Roles
// -----------------------------------------------------------------------------
export const ONBOARDING_ROLES = ["PLAYER", "COACH", "VENUE_OWNER"] as const;
export const onboardingRoleSchema = z.enum(ONBOARDING_ROLES);
export type OnboardingRole = z.infer<typeof onboardingRoleSchema>;

export const ONBOARDING_ROLE_LABELS: Record<OnboardingRole, string> = {
  PLAYER: "Player",
  COACH: "Coach",
  VENUE_OWNER: "Court owner / facility manager",
};

export const rolesSchema = z
  .array(onboardingRoleSchema)
  .min(1, { error: "Choose at least one role." })
  .refine((roles) => isDistinct(roles), { error: "Each role can only be chosen once." });

// -----------------------------------------------------------------------------
// Public profile & private contact details
// -----------------------------------------------------------------------------
export const profileBasicsSchema = z.strictObject({
  full_name: line(LIMITS.person.fullName.min, LIMITS.person.fullName.max),
  display_name: optionalLine(LIMITS.person.displayName.min, LIMITS.person.displayName.max),
  avatar_url: z.union([storagePathSchema, httpsUrlSchema]).optional(),
  bio: optionalParagraphs(LIMITS.person.bio.max),
  municipality_code: psgcCodeSchema,
  barangay_code: psgcCodeSchema,
  dominant_hand: dominantHandSchema.optional(),
});

const MIN_BIRTH_DATE = "1900-01-01";

export const contactDetailsSchema = z
  .strictObject({
    phone: phMobileSchema,
    birth_date: isoDateSchema
      .refine((d) => d >= MIN_BIRTH_DATE && d <= toZonedParts(new Date(), DEFAULT_TIME_ZONE).date, {
        error: "Enter a real birth date.",
      })
      .optional(),
    emergency_contact_name: optionalLine(2, 120),
    emergency_contact_phone: phMobileSchema.optional(),
  })
  .superRefine((c, ctx) => {
    if ((c.emergency_contact_name === undefined) !== (c.emergency_contact_phone === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [c.emergency_contact_name === undefined ? "emergency_contact_name" : "emergency_contact_phone"],
        message: "Give both a name and a number for your emergency contact, or neither.",
      });
    }
    if (c.emergency_contact_phone !== undefined && c.emergency_contact_phone === c.phone) {
      ctx.addIssue({
        code: "custom",
        path: ["emergency_contact_phone"],
        message: "Your emergency contact needs a different number from yours.",
      });
    }
  });

// -----------------------------------------------------------------------------
// Player: one profile per sport
// -----------------------------------------------------------------------------
const decimalPlaces = (n: number) => (String(n).split(".")[1] ?? "").length;

export const playerSportProfileSchema = z
  .strictObject({
    sport: sportSchema,
    skill_level: skillLevelSchema,
    play_style: playStyleSchema.optional(),
    rating_system: ratingSystemSchema.optional(),
    rating: z.number({ error: "Enter your rating as a number." }).optional(),
    dupr_id: z
      .string()
      .overwrite((v) => v.replace(/\s+/g, "").toUpperCase())
      .regex(/^[A-Z0-9]{4,20}$/, { error: "DUPR IDs are 4–20 letters and digits." })
      .optional(),
    years_playing: z.number().int().min(0).max(LIMITS.player.years.max).optional(),
  })
  .superRefine((p, ctx) => {
    if ((p.rating === undefined) !== (p.rating_system === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [p.rating === undefined ? "rating" : "rating_system"],
        message: "Enter both the rating system and your rating, or leave both blank.",
      });
      return;
    }
    if (p.rating_system === undefined || p.rating === undefined) return;

    if (!RATING_SYSTEMS_BY_SPORT[p.sport].includes(p.rating_system)) {
      ctx.addIssue({
        code: "custom",
        path: ["rating_system"],
        message: `${RATING_SYSTEM_LABELS[p.rating_system]} isn't used for ${SPORT_LABELS[p.sport]}.`,
      });
      return;
    }
    const { min, max } = RATING_RANGES[p.rating_system];
    if (p.rating < min || p.rating > max || decimalPlaces(p.rating) > 3) {
      ctx.addIssue({
        code: "custom",
        path: ["rating"],
        message: `${RATING_SYSTEM_LABELS[p.rating_system]} ratings go from ${min} to ${max} (up to 3 decimals).`,
      });
    }
  })
  .superRefine((p, ctx) => {
    if (p.dupr_id !== undefined && p.sport !== "PICKLEBALL") {
      ctx.addIssue({ code: "custom", path: ["dupr_id"], message: "A DUPR ID only applies to pickleball." });
    }
  });

// -----------------------------------------------------------------------------
// Coach
// -----------------------------------------------------------------------------
export const coachProfileSchema = z
  .strictObject({
    sports_coached: z
      .array(sportSchema)
      .min(LIMITS.coach.sports.min, { error: "Pick at least one sport you coach." })
      .max(LIMITS.coach.sports.max)
      .refine((s) => isDistinct(s), { error: "Each sport can only be listed once." }),
    hourly_rate: pesoAmountSchema(),
    group_rate_per_pax: pesoAmountSchema().optional(),
    bio: optionalParagraphs(LIMITS.coach.bio.max),
    credentials: z
      .array(line(2, 120))
      .max(LIMITS.coach.credentials.max, {
        error: `List at most ${LIMITS.coach.credentials.max} credentials.`,
      })
      .optional(),
    years_experience: z.number().int().min(0).max(LIMITS.coach.years.max).optional(),
    offers_private: z.boolean().optional(),
    offers_group_clinics: z.boolean().optional(),
    /** Ask RacketHub admins to verify the profile (UNVERIFIED → PENDING). */
    request_verification: z.boolean().optional(),
  })
  .superRefine((c, ctx) => {
    const offersPrivate = c.offers_private ?? DB_DEFAULTS.coach.offers_private;
    const offersGroup = c.offers_group_clinics ?? DB_DEFAULTS.coach.offers_group_clinics;
    if (!offersPrivate && !offersGroup) {
      ctx.addIssue({
        code: "custom",
        path: ["offers_private"],
        message: "Offer private sessions, group clinics, or both.",
      });
    }
    if (offersGroup && c.group_rate_per_pax === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["group_rate_per_pax"],
        message: "Set a per-player rate for group clinics.",
      });
    }
  });

export const availabilityWindowSchema = z
  .strictObject({
    day_of_week: dayOfWeekSchema,
    start_time: startTimeOfDaySchema,
    end_time: timeOfDaySchema,
    sport: sportSchema.optional(),
  })
  .refine((w) => minutesSinceMidnight(w.end_time) > minutesSinceMidnight(w.start_time), {
    error: "End time must be after start time.",
    path: ["end_time"],
  });

export const coachAvailabilitySchema = z
  .array(availabilityWindowSchema)
  .max(70, { error: "That's too many availability windows." })
  .superRefine((windows, ctx) => {
    const overlaps = findWeeklyOverlaps(
      windows.map((w) => ({ day_of_week: w.day_of_week, start: w.start_time, end: w.end_time })),
    );
    for (const [, later] of overlaps) {
      const day = DAY_OF_WEEK_LABELS[windows[later]!.day_of_week];
      ctx.addIssue({
        code: "custom",
        path: [later, "start_time"],
        message: `Overlaps another ${day} window.`,
      });
    }
  });

// -----------------------------------------------------------------------------
// The whole onboarding submission
// -----------------------------------------------------------------------------
export const onboardingSchema = z
  .strictObject({
    roles: rolesSchema,
    profile: profileBasicsSchema,
    contact: contactDetailsSchema,
    player_sports: z.array(playerSportProfileSchema).max(4).optional(),
    coach: coachProfileSchema.optional(),
    coach_availability: coachAvailabilitySchema.optional(),
  })
  .superRefine((v, ctx) => {
    const isPlayer = v.roles.includes("PLAYER");
    const isCoach = v.roles.includes("COACH");
    const sports = v.player_sports ?? [];

    if (isPlayer && sports.length === 0) {
      ctx.addIssue({ code: "custom", path: ["player_sports"], message: "Add at least one sport you play." });
    }
    if (!isPlayer && sports.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["player_sports"],
        message: "Choose the Player role to add the sports you play.",
      });
    }
    const seen = new Set<string>();
    sports.forEach((p, i) => {
      if (seen.has(p.sport)) {
        ctx.addIssue({
          code: "custom",
          path: ["player_sports", i, "sport"],
          message: `You already added ${SPORT_LABELS[p.sport]}.`,
        });
      }
      seen.add(p.sport);
    });

    if (isCoach && !v.coach) {
      ctx.addIssue({ code: "custom", path: ["coach"], message: "Tell players about your coaching." });
    }
    if (!isCoach && (v.coach || (v.coach_availability?.length ?? 0) > 0)) {
      ctx.addIssue({ code: "custom", path: ["coach"], message: "Choose the Coach role to set up coaching." });
    }
    v.coach_availability?.forEach((w, i) => {
      if (w.sport && v.coach && !v.coach.sports_coached.includes(w.sport)) {
        ctx.addIssue({
          code: "custom",
          path: ["coach_availability", i, "sport"],
          message: `${SPORT_LABELS[w.sport]} isn't one of the sports you coach.`,
        });
      }
    });
  });

export type OnboardingInput = z.input<typeof onboardingSchema>;
export type Onboarding = z.output<typeof onboardingSchema>;
export type PlayerSportProfile = z.output<typeof playerSportProfileSchema>;
export type CoachProfileInput = z.output<typeof coachProfileSchema>;
export type AvailabilityWindow = z.output<typeof availabilityWindowSchema>;

// -----------------------------------------------------------------------------
// Mapping to database writes
// -----------------------------------------------------------------------------
export interface OnboardingWrites {
  /** UPDATE public.profiles SET … WHERE id = :profileId (the row exists from sign-up). */
  profile: UpdateRow<"profiles">;
  /** UPSERT public.profile_contacts ON CONFLICT (profile_id). */
  contact: InsertRow<"profile_contacts">;
  /** UPSERT public.player_profiles ON CONFLICT (profile_id, sport). */
  playerProfiles: InsertRow<"player_profiles">[];
  /** UPSERT public.coach_profiles ON CONFLICT (profile_id), or nothing when not coaching. */
  coachProfile: InsertRow<"coach_profiles"> | null;
  /** Replaces the coach's weekly availability. */
  coachAvailability: InsertRow<"coach_availability">[];
}

export function toPlayerProfileInsert(
  profileId: string,
  p: PlayerSportProfile,
): InsertRow<"player_profiles"> {
  return compact({
    profile_id: profileId,
    sport: p.sport,
    skill_level: p.skill_level,
    play_style: p.play_style,
    rating_system: p.rating_system,
    rating: p.rating,
    dupr_id: p.dupr_id,
    years_playing: p.years_playing,
  });
}

export function toCoachProfileInsert(profileId: string, c: CoachProfileInput): InsertRow<"coach_profiles"> {
  return compact({
    profile_id: profileId,
    sports_coached: c.sports_coached,
    hourly_rate: c.hourly_rate,
    group_rate_per_pax: c.group_rate_per_pax,
    bio: c.bio,
    credentials: c.credentials,
    years_experience: c.years_experience,
    offers_private: c.offers_private,
    offers_group_clinics: c.offers_group_clinics,
    verified_status: c.request_verification ? ("PENDING" as const) : undefined,
  });
}

export function toCoachAvailabilityInsert(
  coachId: string,
  w: AvailabilityWindow,
): InsertRow<"coach_availability"> {
  return compact({
    coach_id: coachId,
    day_of_week: w.day_of_week,
    start_time: w.start_time,
    end_time: w.end_time,
    sport: w.sport,
  });
}

export function toOnboardingWrites(
  profileId: string,
  data: Onboarding,
  completedAt: Date = new Date(),
): OnboardingWrites {
  const isPlayer = data.roles.includes("PLAYER");
  const isCoach = data.roles.includes("COACH");
  const { profile, contact } = data;

  return {
    profile: {
      full_name: profile.full_name,
      display_name: profile.display_name ?? null,
      avatar_url: profile.avatar_url ?? null,
      bio: profile.bio ?? null,
      municipality_code: profile.municipality_code,
      barangay_code: profile.barangay_code,
      dominant_hand: profile.dominant_hand ?? null,
      is_player: isPlayer,
      is_coach: isCoach,
      is_venue_owner: data.roles.includes("VENUE_OWNER"),
      onboarding_completed_at: completedAt.toISOString(),
    },
    contact: {
      profile_id: profileId,
      phone: contact.phone,
      birth_date: contact.birth_date ?? null,
      emergency_contact_name: contact.emergency_contact_name ?? null,
      emergency_contact_phone: contact.emergency_contact_phone ?? null,
    },
    playerProfiles: isPlayer
      ? (data.player_sports ?? []).map((p) => toPlayerProfileInsert(profileId, p))
      : [],
    coachProfile: isCoach && data.coach ? toCoachProfileInsert(profileId, data.coach) : null,
    coachAvailability: isCoach
      ? (data.coach_availability ?? []).map((w) => toCoachAvailabilityInsert(profileId, w))
      : [],
  };
}
