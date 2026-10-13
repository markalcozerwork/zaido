/**
 * Venue (facility) registration and settings, opening hours.
 */
import { z } from "zod";
import type { InsertRow, UpdateRow } from "../db";
import { DAY_OF_WEEK_LABELS, venueAmenitySchema } from "./enums";
import { DB_DEFAULTS, LIMITS } from "./limits";
import { compact } from "./object";
import {
  dayOfWeekSchema,
  emailSchema,
  httpsUrlSchema,
  isDistinct,
  line,
  minutesSinceMidnight,
  optionalParagraphs,
  phMobileSchema,
  phPhoneSchema,
  psgcCodeSchema,
  startTimeOfDaySchema,
  storagePathSchema,
  timeOfDaySchema,
} from "./primitives";
import { findWeeklyOverlaps } from "./schedule";
import { isValidTimeZone } from "./time";

/** Rough bounding box of the Philippine archipelago (catches swapped lat/lng). */
export const PHILIPPINES_BOUNDS = { minLat: 4.2, maxLat: 21.3, minLng: 116.0, maxLng: 127.1 } as const;

export const ewalletAccountSchema = z.strictObject({
  account_name: line(2, 80),
  number: phMobileSchema,
});

export const geoPointSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/** Field shapes with no refinements or defaults, so `.partial()` works for updates. */
const venueFields = {
  name: line(LIMITS.venue.name.min, LIMITS.venue.name.max),
  description: optionalParagraphs(LIMITS.venue.description.max),
  municipality_code: psgcCodeSchema,
  barangay_code: psgcCodeSchema,
  address: line(LIMITS.venue.address.min, LIMITS.venue.address.max),
  location: geoPointSchema.optional(),
  contact_number: phPhoneSchema.optional(),
  contact_email: emailSchema.optional(),
  amenities: z
    .array(venueAmenitySchema)
    .refine((a) => isDistinct(a), { error: "Each amenity can only be listed once." })
    .optional(),
  photo_urls: z
    .array(z.union([storagePathSchema, httpsUrlSchema]))
    .max(LIMITS.venue.photos.max, { error: `Add at most ${LIMITS.venue.photos.max} photos.` })
    .optional(),
  gcash: ewalletAccountSchema.optional(),
  maya: ewalletAccountSchema.optional(),
  bank_transfer_details: optionalParagraphs(500),
  accepts_cash_on_court: z.boolean().optional(),
  auto_confirm_cash_bookings: z.boolean().optional(),
  payment_window_minutes: z
    .number()
    .int()
    .min(LIMITS.venue.paymentWindowMinutes.min, { error: "Give players at least 5 minutes to pay." })
    .max(LIMITS.venue.paymentWindowMinutes.max, { error: "A payment window can be at most 24 hours." })
    .optional(),
  cancellation_cutoff_hours: z
    .number()
    .int()
    .min(LIMITS.venue.cancellationCutoffHours.min)
    .max(LIMITS.venue.cancellationCutoffHours.max, {
      error: "The cancellation cutoff can be at most 7 days.",
    })
    .optional(),
  timezone: z.string().refine(isValidTimeZone, { error: "Unknown time zone." }).optional(),
  // Booking policy (Step 3)
  min_lead_minutes: z
    .number()
    .int()
    .min(LIMITS.venue.minLeadMinutes.min)
    .max(LIMITS.venue.minLeadMinutes.max, { error: "The minimum lead time can be at most 24 hours." })
    .optional(),
  booking_horizon_days: z
    .number()
    .int()
    .min(LIMITS.venue.bookingHorizonDays.min, { error: "Let players book at least 1 day ahead." })
    .max(LIMITS.venue.bookingHorizonDays.max, { error: "Bookings can open at most 90 days ahead." })
    .optional(),
  max_active_holds_per_player: z
    .number()
    .int()
    .min(LIMITS.venue.maxActiveHoldsPerPlayer.min, { error: "Allow at least 1 unpaid booking." })
    .max(LIMITS.venue.maxActiveHoldsPerPlayer.max, { error: "Allow at most 50 unpaid bookings." })
    .optional(),
  /** Without opening hours a venue takes no player bookings unless it is explicitly open 24/7. */
  is_open_24h: z.boolean().optional(),
};

interface VenuePaymentShape {
  accepts_cash_on_court?: boolean | null | undefined;
  gcash?: unknown;
  maya?: unknown;
  bank_transfer_details?: string | null | undefined;
}

/** A venue must offer at least one way to pay (cash counts unless switched off). */
export function venueHasPaymentChannel(v: VenuePaymentShape): boolean {
  return Boolean(
    (v.accepts_cash_on_court ?? DB_DEFAULTS.venue.accepts_cash_on_court) ||
    v.gcash ||
    v.maya ||
    v.bank_transfer_details,
  );
}

function isInsidePhilippines(p: { latitude: number; longitude: number }): boolean {
  const b = PHILIPPINES_BOUNDS;
  return (
    p.latitude >= b.minLat && p.latitude <= b.maxLat && p.longitude >= b.minLng && p.longitude <= b.maxLng
  );
}

function checkLocation(
  location: { latitude: number; longitude: number } | null | undefined,
  timezone: string | undefined,
  ctx: z.RefinementCtx,
) {
  if (
    location &&
    (timezone ?? DB_DEFAULTS.venue.timezone) === "Asia/Manila" &&
    !isInsidePhilippines(location)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["location"],
      message:
        "These coordinates are outside the Philippines. Check that latitude and longitude aren't swapped.",
    });
  }
}

export const venueCreateSchema = z.strictObject(venueFields).superRefine((v, ctx) => {
  if (!venueHasPaymentChannel(v)) {
    ctx.addIssue({
      code: "custom",
      path: ["accepts_cash_on_court"],
      message: "Turn on at least one way to pay: cash on court, GCash, Maya or bank transfer.",
    });
  }
  checkLocation(v.location, v.timezone, ctx);
});

/**
 * PATCH semantics: omitted = unchanged, `null` = clear. The server action must
 * re-check `venueHasPaymentChannel` against the merged row.
 */
export const venueUpdateSchema = z
  .strictObject(venueFields)
  .partial()
  .extend({
    description: venueFields.description.nullable(),
    location: geoPointSchema.nullable().optional(),
    contact_number: phPhoneSchema.nullable().optional(),
    contact_email: emailSchema.nullable().optional(),
    gcash: ewalletAccountSchema.nullable().optional(),
    maya: ewalletAccountSchema.nullable().optional(),
    bank_transfer_details: venueFields.bank_transfer_details.nullable(),
    is_active: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({ code: "custom", path: [], message: "Nothing to update." });
    }
    checkLocation(v.location, v.timezone, ctx);
  });

export type VenueCreate = z.output<typeof venueCreateSchema>;
export type VenueUpdate = z.output<typeof venueUpdateSchema>;

export function toVenueInsert(ownerId: string, v: VenueCreate): InsertRow<"venues"> {
  return compact({
    owner_id: ownerId,
    name: v.name,
    description: v.description,
    municipality_code: v.municipality_code,
    barangay_code: v.barangay_code,
    address: v.address,
    latitude: v.location?.latitude,
    longitude: v.location?.longitude,
    contact_number: v.contact_number,
    contact_email: v.contact_email,
    amenities: v.amenities,
    photo_urls: v.photo_urls,
    gcash_account_name: v.gcash?.account_name,
    gcash_number: v.gcash?.number,
    maya_account_name: v.maya?.account_name,
    maya_number: v.maya?.number,
    bank_transfer_details: v.bank_transfer_details,
    accepts_cash_on_court: v.accepts_cash_on_court,
    auto_confirm_cash_bookings: v.auto_confirm_cash_bookings,
    payment_window_minutes: v.payment_window_minutes,
    cancellation_cutoff_hours: v.cancellation_cutoff_hours,
    timezone: v.timezone,
    min_lead_minutes: v.min_lead_minutes,
    booking_horizon_days: v.booking_horizon_days,
    max_active_holds_per_player: v.max_active_holds_per_player,
    is_open_24h: v.is_open_24h,
  });
}

export function toVenueUpdate(patch: VenueUpdate): UpdateRow<"venues"> {
  const pair = <T>(
    value: { account_name: string; number: string } | null | undefined,
    pick: (a: { account_name: string; number: string }) => T,
  ) => (value === undefined ? undefined : value === null ? null : pick(value));

  return compact({
    name: patch.name,
    description: patch.description,
    municipality_code: patch.municipality_code,
    barangay_code: patch.barangay_code,
    address: patch.address,
    latitude: patch.location === undefined ? undefined : (patch.location?.latitude ?? null),
    longitude: patch.location === undefined ? undefined : (patch.location?.longitude ?? null),
    contact_number: patch.contact_number,
    contact_email: patch.contact_email,
    amenities: patch.amenities,
    photo_urls: patch.photo_urls,
    gcash_account_name: pair(patch.gcash, (a) => a.account_name),
    gcash_number: pair(patch.gcash, (a) => a.number),
    maya_account_name: pair(patch.maya, (a) => a.account_name),
    maya_number: pair(patch.maya, (a) => a.number),
    bank_transfer_details: patch.bank_transfer_details,
    accepts_cash_on_court: patch.accepts_cash_on_court,
    auto_confirm_cash_bookings: patch.auto_confirm_cash_bookings,
    payment_window_minutes: patch.payment_window_minutes,
    cancellation_cutoff_hours: patch.cancellation_cutoff_hours,
    timezone: patch.timezone,
    min_lead_minutes: patch.min_lead_minutes,
    booking_horizon_days: patch.booking_horizon_days,
    max_active_holds_per_player: patch.max_active_holds_per_player,
    is_open_24h: patch.is_open_24h,
    is_active: patch.is_active,
  });
}

// -----------------------------------------------------------------------------
// Opening hours (a venue with no rows takes player bookings only if is_open_24h)
// -----------------------------------------------------------------------------
export const operatingWindowSchema = z
  .strictObject({
    day_of_week: dayOfWeekSchema,
    opens_at: startTimeOfDaySchema,
    closes_at: timeOfDaySchema,
  })
  .refine((w) => minutesSinceMidnight(w.closes_at) > minutesSinceMidnight(w.opens_at), {
    error: "Closing time must be after opening time. For past midnight, add the next day from 00:00.",
    path: ["closes_at"],
  });

export const operatingHoursSchema = z
  .array(operatingWindowSchema)
  .max(28, { error: "That's too many opening windows." })
  .superRefine((windows, ctx) => {
    const overlaps = findWeeklyOverlaps(
      windows.map((w) => ({ day_of_week: w.day_of_week, start: w.opens_at, end: w.closes_at })),
    );
    for (const [, later] of overlaps) {
      ctx.addIssue({
        code: "custom",
        path: [later, "opens_at"],
        message: `Overlaps another ${DAY_OF_WEEK_LABELS[windows[later]!.day_of_week]} window.`,
      });
    }
  });

export type OperatingWindow = z.output<typeof operatingWindowSchema>;

/** The common case: same hours every day, e.g. 06:00–24:00. */
export function sameHoursEveryDay(opens_at: string, closes_at: string): OperatingWindow[] {
  return [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({ day_of_week, opens_at, closes_at }));
}

export function toOperatingHoursInserts(
  venueId: string,
  windows: readonly OperatingWindow[],
): InsertRow<"venue_operating_hours">[] {
  return windows.map((w) => ({ venue_id: venueId, ...w }));
}
