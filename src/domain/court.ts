/**
 * Courts, the peak/off-peak rate matrix, and a client-side price estimator
 * that mirrors `public.quote_court_booking`. The contract tests compare the
 * two, and the database still recomputes the price on every insert.
 */
import { z } from "zod";
import type { InsertRow, Row, UpdateRow } from "../db";
import { courtSurfaceSchema, sportSchema } from "./enums";
import { DB_DEFAULTS, LIMITS } from "./limits";
import { addPesos, fromCentavos, pesoAmountSchema, toCentavos } from "./money";
import { compact } from "./object";
import {
  dayOfWeekSchema,
  isDistinct,
  isoDateSchema,
  line,
  minutesSinceMidnight,
  optionalParagraphs,
  startTimeOfDaySchema,
  timeOfDaySchema,
  uuidSchema,
} from "./primitives";
import { toZonedParts } from "./time";

// -----------------------------------------------------------------------------
// Courts
// -----------------------------------------------------------------------------
export const slotIncrementSchema = z.union(
  LIMITS.court.slotIncrements.map((n) => z.literal(n)),
  {
    error: "Choose 15, 30 or 60 minutes.",
  },
);

const courtFields = {
  name: line(LIMITS.court.name.min, LIMITS.court.name.max),
  sport: sportSchema,
  surface_type: courtSurfaceSchema,
  is_indoor: z.boolean().optional(),
  hourly_rate: pesoAmountSchema(),
  lights_fee_per_hour: pesoAmountSchema().optional(),
  lights_from: startTimeOfDaySchema.optional(),
  lights_until: startTimeOfDaySchema.optional(),
  slot_increment_minutes: slotIncrementSchema.optional(),
  min_booking_minutes: z.number().int().positive().optional(),
  max_booking_minutes: z.number().int().positive().optional(),
  max_players: z.number().int().min(LIMITS.court.maxPlayers.min).max(LIMITS.court.maxPlayers.max).optional(),
  sort_order: z.number().int().min(0).max(999).optional(),
  notes: optionalParagraphs(500),
  is_active: z.boolean().optional(),
};

interface DurationShape {
  slot_increment_minutes?: number | undefined;
  min_booking_minutes?: number | undefined;
  max_booking_minutes?: number | undefined;
}

/** Mirrors the courts_min_booking / courts_max_booking CHECKs (unset fields use the DB defaults). */
export function courtDurationIssues(v: DurationShape): Array<{ path: keyof DurationShape; message: string }> {
  const inc = v.slot_increment_minutes ?? DB_DEFAULTS.court.slot_increment_minutes;
  const min = v.min_booking_minutes ?? DB_DEFAULTS.court.min_booking_minutes;
  const max = v.max_booking_minutes ?? DB_DEFAULTS.court.max_booking_minutes;
  const issues: Array<{ path: keyof DurationShape; message: string }> = [];
  if (min < inc || min % inc !== 0) {
    issues.push({
      path: "min_booking_minutes",
      message: `Minimum length must be a multiple of ${inc} minutes.`,
    });
  }
  if (max < min) {
    issues.push({
      path: "max_booking_minutes",
      message: "Maximum length can't be shorter than the minimum.",
    });
  } else if (max > LIMITS.court.maxBookingMinutes || max % inc !== 0) {
    issues.push({
      path: "max_booking_minutes",
      message: `Maximum length must be a multiple of ${inc} minutes, up to 12 hours.`,
    });
  }
  return issues;
}

export const courtCreateSchema = z
  .strictObject({ venue_id: uuidSchema, ...courtFields })
  .superRefine((v, ctx) => {
    for (const issue of courtDurationIssues(v))
      ctx.addIssue({ code: "custom", ...issue, path: [issue.path] });
  });

/** PATCH semantics. Re-check `courtDurationIssues` against the merged row on the server. */
export const courtUpdateSchema = z
  .strictObject(courtFields)
  .partial()
  .extend({
    max_players: courtFields.max_players.nullable(),
    notes: courtFields.notes.nullable(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({ code: "custom", path: [], message: "Nothing to update." });
    }
  });

export type CourtCreate = z.output<typeof courtCreateSchema>;
export type CourtUpdate = z.output<typeof courtUpdateSchema>;

export function toCourtInsert(c: CourtCreate): InsertRow<"courts"> {
  return compact({ ...c });
}

export function toCourtUpdate(c: CourtUpdate): UpdateRow<"courts"> {
  return compact({ ...c });
}

// -----------------------------------------------------------------------------
// Rate rules
// -----------------------------------------------------------------------------
const rateRuleFields = {
  label: line(LIMITS.rateRule.label.min, LIMITS.rateRule.label.max),
  days_of_week: z
    .array(dayOfWeekSchema)
    .min(1, { error: "Pick at least one day." })
    .max(7)
    .refine((d) => isDistinct(d), { error: "Each day can only be picked once." }),
  start_time: startTimeOfDaySchema,
  end_time: timeOfDaySchema,
  hourly_rate: pesoAmountSchema(),
  /** Higher wins when rules overlap (e.g. a holiday rule over "Weekend"). */
  priority: z.number().int().min(0).max(1000).optional(),
  valid_from: isoDateSchema.optional(),
  valid_until: isoDateSchema.optional(),
  is_active: z.boolean().optional(),
};

export const courtRateRuleSchema = z
  .strictObject({ court_id: uuidSchema, ...rateRuleFields })
  .superRefine((r, ctx) => {
    if (minutesSinceMidnight(r.end_time) <= minutesSinceMidnight(r.start_time)) {
      ctx.addIssue({ code: "custom", path: ["end_time"], message: "End time must be after start time." });
    }
    if (r.valid_from && r.valid_until && r.valid_until < r.valid_from) {
      ctx.addIssue({
        code: "custom",
        path: ["valid_until"],
        message: "The end date can't be before the start date.",
      });
    }
  });

export type CourtRateRule = z.output<typeof courtRateRuleSchema>;

export function toRateRuleInsert(r: CourtRateRule): InsertRow<"court_rate_rules"> {
  return compact({ ...r });
}

/** One-tap presets for the venue setup screen. */
export const RATE_RULE_PRESETS = {
  weeknightPeak: (hourly_rate: number) => ({
    label: "Weeknight peak",
    days_of_week: [1, 2, 3, 4, 5],
    start_time: "17:00",
    end_time: "22:00",
    hourly_rate,
    priority: 10,
  }),
  weekend: (hourly_rate: number) => ({
    label: "Weekend",
    days_of_week: [0, 6],
    start_time: "00:00",
    end_time: "24:00",
    hourly_rate,
    priority: 20,
  }),
} as const;

// -----------------------------------------------------------------------------
// Price estimator (mirror of public.quote_court_booking)
// -----------------------------------------------------------------------------
export type CourtPricing = Pick<
  Row<"courts">,
  "hourly_rate" | "lights_fee_per_hour" | "lights_from" | "lights_until"
>;
export type RateRulePricing = Pick<
  Row<"court_rate_rules">,
  | "id"
  | "days_of_week"
  | "start_time"
  | "end_time"
  | "hourly_rate"
  | "priority"
  | "valid_from"
  | "valid_until"
  | "is_active"
  | "created_at"
>;

export interface PriceBreakdown {
  court_amount: number;
  lights_amount: number;
  coach_amount: number;
  total_amount: number;
}

/** SQL app.time_in_daily_window: [from, until), wrapping past midnight when from > until. */
export function isInDailyWindow(minuteOfDay: number, from: string, until: string): boolean {
  const f = minutesSinceMidnight(from);
  const u = minutesSinceMidnight(until);
  if (f === u) return true;
  return f < u ? minuteOfDay >= f && minuteOfDay < u : minuteOfDay >= f || minuteOfDay < u;
}

function ruleRank(a: RateRulePricing, b: RateRulePricing): number {
  return b.priority - a.priority || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id);
}

/**
 * Prices [start, end) in 15-minute slices of venue-local time, exactly like
 * the database. Use for instant UI quotes; the insert path recomputes
 * server-side.
 */
export function estimateCourtPrice(input: {
  court: CourtPricing;
  rules: readonly RateRulePricing[];
  start: Date;
  end: Date;
  timeZone: string;
  coachHourlyRate?: number;
}): PriceBreakdown {
  const { court, start, end, timeZone } = input;
  const sliceMs = LIMITS.booking.gridMinutes * 60_000;
  const rules = input.rules.filter((r) => r.is_active).toSorted(ruleRank);

  let courtCentavos = 0;
  let lightsCentavos = 0;
  for (let t = start.getTime(); t < end.getTime(); t += sliceMs) {
    const local = toZonedParts(new Date(t), timeZone);
    const rule = rules.find(
      (r) =>
        r.days_of_week.includes(local.dayOfWeek) &&
        local.minuteOfDay >= minutesSinceMidnight(r.start_time) &&
        local.minuteOfDay < minutesSinceMidnight(r.end_time) &&
        (r.valid_from === null || local.date >= r.valid_from) &&
        (r.valid_until === null || local.date <= r.valid_until),
    );
    // Rates are whole centavos; a quarter-hour of a rate can carry 0.25 centavo,
    // so accumulate in quarter-centavos and round once at the end, like SQL.
    courtCentavos += toCentavos(rule?.hourly_rate ?? court.hourly_rate);
    if (isInDailyWindow(local.minuteOfDay, court.lights_from, court.lights_until)) {
      lightsCentavos += toCentavos(court.lights_fee_per_hour);
    }
  }

  const court_amount = fromCentavos(Math.round(courtCentavos / 4));
  const lights_amount = fromCentavos(Math.round(lightsCentavos / 4));
  const hours = (end.getTime() - start.getTime()) / 3_600_000;
  const coach_amount = fromCentavos(Math.round(toCentavos(input.coachHourlyRate ?? 0) * hours));
  return {
    court_amount,
    lights_amount,
    coach_amount,
    total_amount: addPesos(court_amount, lights_amount, coach_amount),
  };
}
