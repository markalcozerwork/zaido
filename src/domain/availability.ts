/**
 * The availability grid: for one court and one venue-local day, every start
 * time the court offers, with
 *   * occupancy: what is at that time right now (free, held, booked, mine, closed);
 *   * fit: whether the selected duration can be booked from there, and if not,
 *     the exact code the database would raise (same order as the guard);
 *   * maxBookableMinutes: the longest booking that fits from there;
 *   * price: the server-side price for a fitting slot (estimateCourtPrice mirror).
 *
 * Pure: the server loads the context and busy ranges (get_court_busy_slots)
 * and calls `buildDaySlots`. A grid verdict is a prediction; create_booking
 * remains the only authority (the PostgREST integration tests compare every
 * verdict with the real insert outcome).
 */
import { z } from "zod";
import type { Row } from "../db";
import {
  acceptedPaymentMethods,
  isBeyondHorizon,
  isWithinOperatingHours,
  rangesOverlap,
  type BusyKind,
  type CourtSlotRules,
} from "./booking";
import { estimateCourtPrice, type PriceBreakdown, type RateRulePricing } from "./court";
import type { DomainErrorCode } from "./errors";
import { LIMITS } from "./limits";
import { isoDateSchema, uuidSchema } from "./primitives";
import { addDaysToDate, addMinutes, toZonedParts, zonedTimeToInstant } from "./time";

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------
export type CourtContextRow = Pick<
  Row<"courts">,
  | "id"
  | "venue_id"
  | "name"
  | "sport"
  | "is_active"
  | "hourly_rate"
  | "lights_fee_per_hour"
  | "lights_from"
  | "lights_until"
  | "slot_increment_minutes"
  | "min_booking_minutes"
  | "max_booking_minutes"
>;

export type VenueContextRow = Pick<
  Row<"venues">,
  | "id"
  | "name"
  | "timezone"
  | "is_active"
  | "verification_status"
  | "accepts_cash_on_court"
  | "gcash_number"
  | "maya_number"
  | "bank_transfer_details"
  | "auto_confirm_cash_bookings"
  | "payment_window_minutes"
  | "cancellation_cutoff_hours"
  | "min_lead_minutes"
  | "booking_horizon_days"
  | "is_open_24h"
  | "max_active_holds_per_player"
>;

export type OperatingHoursRow = Pick<Row<"venue_operating_hours">, "day_of_week" | "opens_at" | "closes_at">;
export type ClosureRow = Pick<Row<"court_closures">, "starts_at" | "ends_at" | "reason">;

/** Everything about a court the booking rules depend on (one PostgREST round trip). */
export interface CourtBookingContext {
  court: CourtContextRow;
  venue: VenueContextRow;
  operatingHours: readonly OperatingHoursRow[];
  rateRules: readonly RateRulePricing[];
}

export function toSlotRules(
  ctx: CourtBookingContext,
  closures: ReadonlyArray<Pick<ClosureRow, "starts_at" | "ends_at">> = [],
): CourtSlotRules {
  return {
    timezone: ctx.venue.timezone,
    slot_increment_minutes: ctx.court.slot_increment_minutes,
    min_booking_minutes: ctx.court.min_booking_minutes,
    max_booking_minutes: ctx.court.max_booking_minutes,
    court_is_active: ctx.court.is_active,
    venue_is_active: ctx.venue.is_active,
    operating_hours: ctx.operatingHours,
    is_open_24h: ctx.venue.is_open_24h,
    accepted_payment_methods: acceptedPaymentMethods(ctx.venue),
    min_lead_minutes: ctx.venue.min_lead_minutes,
    booking_horizon_days: ctx.venue.booking_horizon_days,
    payment_window_minutes: ctx.venue.payment_window_minutes,
    closures,
  };
}

/** A row of get_court_busy_slots / get_venue_busy_slots. */
export interface BusyRange {
  start_time: string;
  end_time: string;
  kind: BusyKind | string;
  is_mine: boolean;
  booking_id: string | null;
  held_until: string | null;
  reason: string | null;
}

export interface CoachAvailabilityInput {
  hourlyRate: number;
  /** get_coach_busy_slots over the same window. */
  busy: ReadonlyArray<{ start_time: string; end_time: string }>;
  /** coach_availability rows. None = available any time (as in the database). */
  windows: ReadonlyArray<{ day_of_week: number; start_time: string; end_time: string }>;
}

export const availabilityQuerySchema = z.strictObject({
  court_id: uuidSchema,
  /** Venue-local calendar date. */
  date: isoDateSchema,
  duration_minutes: z
    .number()
    .int()
    .min(LIMITS.booking.gridMinutes)
    .max(LIMITS.booking.maxDurationMinutes)
    .multipleOf(LIMITS.booking.gridMinutes, { error: "Durations go in 15-minute steps." }),
  coach_id: uuidSchema.optional(),
});

export type AvailabilityQuery = z.output<typeof availabilityQuerySchema>;

export const venueAvailabilityQuerySchema = availabilityQuerySchema
  .omit({ court_id: true, coach_id: true })
  .extend({ venue_id: uuidSchema });

export type VenueAvailabilityQuery = z.output<typeof venueAvailabilityQuerySchema>;

// -----------------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------------
export type Occupancy = "FREE" | "HELD" | "BOOKED" | "MINE" | "CLOSED";

export const SLOT_FITS = [
  "OK",
  "COURT_INACTIVE",
  "SLOT_IN_PAST",
  "TOO_SOON",
  "BEYOND_HORIZON",
  "OFF_INCREMENT",
  "DURATION_OUT_OF_RANGE",
  "VENUE_HOURS_NOT_SET",
  "VENUE_CLOSED",
  /** Starts inside opening hours but the duration runs past closing. */
  "RUNS_PAST_CLOSING",
  "COURT_CLOSED",
  "COACH_UNAVAILABLE",
  "SLOT_ALREADY_YOURS",
  "SLOT_TAKEN",
] as const;

export type SlotFit = (typeof SLOT_FITS)[number];

/** The DomainError code create_booking returns for a slot with this fit. */
export const FIT_ERROR_CODE: Record<Exclude<SlotFit, "OK">, DomainErrorCode> = {
  COURT_INACTIVE: "COURT_INACTIVE",
  SLOT_IN_PAST: "SLOT_IN_PAST",
  TOO_SOON: "TOO_SOON",
  BEYOND_HORIZON: "BEYOND_HORIZON",
  OFF_INCREMENT: "OFF_INCREMENT",
  DURATION_OUT_OF_RANGE: "DURATION_OUT_OF_RANGE",
  VENUE_HOURS_NOT_SET: "VENUE_HOURS_NOT_SET",
  VENUE_CLOSED: "VENUE_CLOSED",
  RUNS_PAST_CLOSING: "VENUE_CLOSED",
  COURT_CLOSED: "COURT_CLOSED",
  COACH_UNAVAILABLE: "COACH_UNAVAILABLE",
  SLOT_ALREADY_YOURS: "SLOT_ALREADY_YOURS",
  SLOT_TAKEN: "SLOT_TAKEN",
};

export interface DaySlot {
  start: string;
  end: string;
  /** What occupies [start, start + increment) now. */
  occupancy: Occupancy;
  /** Can [start, end) be booked? "OK" or the reason it can't. */
  fit: SlotFit;
  /** E-wallet bookings for this slot need the reference number up front (PAY_FIRST). */
  payFirst: boolean;
  /** Longest bookable length from `start` (0 = none). */
  maxBookableMinutes: number;
  /** For HELD: when the hold lets go unless paid (null = until the venue decides). */
  heldUntil: string | null;
  /** For MINE: the caller's booking at this time. */
  myBookingId: string | null;
  /** For CLOSED: why. */
  closureReason: string | null;
  /** Only when fit is OK; includes the coach fee. */
  price: PriceBreakdown | null;
}

// -----------------------------------------------------------------------------
// Grid
// -----------------------------------------------------------------------------
/**
 * The busy window to fetch for a day: local midnight to the next local
 * midnight plus the longest booking that can start that day (late slots end
 * after midnight).
 */
export function busyFetchWindow(
  date: string,
  timeZone: string,
  extraMinutes: number,
): { from: Date; to: Date } {
  return {
    from: zonedTimeToInstant(date, "00:00", timeZone),
    to: addMinutes(zonedTimeToInstant(addDaysToDate(date, 1), "00:00", timeZone), extraMinutes),
  };
}

/** Earliest moment a hold in `busy` lets go: the grid should refetch then. */
export function nextRefreshAt(busy: readonly BusyRange[], now: Date): Date | null {
  let next: Date | null = null;
  for (const b of busy) {
    if (b.kind !== "HOLD" || !b.held_until) continue;
    const t = new Date(b.held_until);
    if (t > now && (!next || t < next)) next = t;
  }
  return next;
}

/** A hold past its `held_until` is dead: the database expires it when someone books over it. */
const isAlive = (b: BusyRange, now: Date): boolean =>
  !(b.kind === "HOLD" && b.held_until !== null && new Date(b.held_until) <= now);

/** Mirror of app.is_within_coach_availability (every 15-minute slice inside a window). */
export function isWithinCoachWindows(
  start: Date,
  end: Date,
  windows: CoachAvailabilityInput["windows"],
  timeZone: string,
): boolean {
  if (windows.length === 0) return true;
  return isWithinOperatingHours(start, end, {
    timezone: timeZone,
    operating_hours: windows.map((w) => ({
      day_of_week: w.day_of_week,
      opens_at: w.start_time,
      closes_at: w.end_time,
    })),
  });
}

interface Cell {
  start: Date;
  end: Date;
  inHours: boolean;
  closure: BusyRange | undefined;
  mine: BusyRange | undefined;
  others: BusyRange[];
  coachOk: boolean;
}

export interface BuildDaySlotsInput {
  ctx: CourtBookingContext;
  /** Busy ranges for this court over `busyFetchWindow(date, tz, ≥ durationMinutes)`. */
  busy: readonly BusyRange[];
  coach?: CoachAvailabilityInput | undefined;
  /** Venue-local "YYYY-MM-DD". */
  date: string;
  durationMinutes: number;
  /** Server clock. */
  now: Date;
  /**
   * "player": every guard rule. "staff": the rules the database applies to
   * venue staff (overlaps and the coach's time); staff may book outside hours,
   * during closures and in the past (e.g. recording a walk-in).
   */
  mode?: "player" | "staff";
}

export function buildDaySlots(input: BuildDaySlotsInput): DaySlot[] {
  const { ctx, busy, coach, date, durationMinutes, now } = input;
  const staff = input.mode === "staff";
  const { court, venue } = ctx;
  const tz = venue.timezone;
  const inc = court.slot_increment_minutes;

  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes <= 0 ||
    durationMinutes > LIMITS.booking.maxDurationMinutes
  ) {
    throw new RangeError(`durationMinutes must be 1..${LIMITS.booking.maxDurationMinutes}`);
  }

  const hasHours = ctx.operatingHours.length > 0;
  const rules = { timezone: tz, operating_hours: ctx.operatingHours };
  const alive = busy.filter((b) => isAlive(b, now));
  const maxLength = staff ? LIMITS.booking.maxDurationMinutes : court.max_booking_minutes;

  // Cells of one increment from local midnight to the end of the longest booking that can start today.
  const { from: dayStart } = busyFetchWindow(date, tz, 0);
  const dayEnd = zonedTimeToInstant(addDaysToDate(date, 1), "00:00", tz);
  const lastEnd = addMinutes(dayEnd, Math.max(durationMinutes, maxLength));
  const cells: Cell[] = [];
  for (let t = dayStart; t < lastEnd; t = addMinutes(t, inc)) {
    const end = addMinutes(t, inc);
    const overlapping = alive.filter((b) =>
      rangesOverlap(t, end, new Date(b.start_time), new Date(b.end_time)),
    );
    cells.push({
      start: t,
      end,
      inHours: hasHours ? isWithinOperatingHours(t, end, rules) : venue.is_open_24h,
      closure: overlapping.find((b) => b.kind === "CLOSED"),
      mine: overlapping.find((b) => b.kind !== "CLOSED" && b.is_mine),
      others: overlapping.filter((b) => b.kind !== "CLOSED" && !b.is_mine),
      coachOk:
        !coach ||
        (isWithinCoachWindows(t, end, coach.windows, tz) &&
          !coach.busy.some((c) => rangesOverlap(t, end, new Date(c.start_time), new Date(c.end_time)))),
    });
  }

  const slots: DaySlot[] = [];
  for (let i = 0; i < cells.length && cells[i]!.start < dayEnd; i++) {
    const cell = cells[i]!;
    // Starts follow the venue-local increment grid (the guard checks minute-of-day).
    if (toZonedParts(cell.start, tz).minuteOfDay % inc !== 0) continue;

    const start = cell.start;
    const end = addMinutes(start, durationMinutes);
    const fit = slotFit({ staff, ctx, start, end, alive, durationMinutes, now, coach, hasHours });

    slots.push({
      start: start.toISOString(),
      end: end.toISOString(),
      occupancy: occupancyOf(cell),
      fit,
      // Staff skip pay-first, except for a coach's time (player rules apply to it).
      payFirst: (!staff || coach !== undefined) && start < addMinutes(now, venue.payment_window_minutes),
      maxBookableMinutes: maxBookable({ staff, ctx, cells, i, maxLength, now, coach }),
      heldUntil: heldUntilOf(cell),
      myBookingId: cell.mine?.booking_id ?? null,
      closureReason: cell.closure?.reason ?? null,
      price:
        fit === "OK"
          ? estimateCourtPrice({
              court,
              rules: ctx.rateRules,
              start,
              end,
              timeZone: tz,
              ...(coach ? { coachHourlyRate: coach.hourlyRate } : {}),
            })
          : null,
    });
  }
  return slots;
}

function occupancyOf(cell: Cell): Occupancy {
  if (cell.mine) return "MINE";
  if (cell.closure) return "CLOSED";
  if (cell.others.some((b) => b.kind === "BOOKED")) return "BOOKED";
  if (cell.others.length > 0) return "HELD";
  return "FREE";
}

function heldUntilOf(cell: Cell): string | null {
  if (cell.mine || cell.closure || cell.others.length === 0 || cell.others.some((b) => b.kind === "BOOKED")) {
    return null;
  }
  if (cell.others.some((b) => b.held_until === null)) return null;
  return cell.others.map((b) => b.held_until!).reduce((a, b) => (new Date(a) >= new Date(b) ? a : b));
}

/** Rules about the start time alone (checked before anything about the range). */
function startFit(
  staff: boolean,
  ctx: CourtBookingContext,
  start: Date,
  now: Date,
  coached: boolean,
): SlotFit {
  const { court, venue } = ctx;
  if (!staff) {
    if (!court.is_active || !venue.is_active) return "COURT_INACTIVE";
    if (start < now) return "SLOT_IN_PAST";
    if (start < addMinutes(now, venue.min_lead_minutes)) return "TOO_SOON";
    if (isBeyondHorizon(start, now, venue.timezone, venue.booking_horizon_days)) return "BEYOND_HORIZON";
  } else if (coached) {
    // Staff skip the slot rules, but the guard's coach rules still apply, in this order.
    if (venue.verification_status !== "VERIFIED") return "COACH_UNAVAILABLE";
    if (start < now) return "SLOT_IN_PAST";
    if (isBeyondHorizon(start, now, venue.timezone, venue.booking_horizon_days)) return "BEYOND_HORIZON";
  }
  return "OK";
}

/** The guard's verdict for [start, end), checked against the exact range (not cells). */
function slotFit(a: {
  staff: boolean;
  ctx: CourtBookingContext;
  start: Date;
  end: Date;
  alive: readonly BusyRange[];
  durationMinutes: number;
  now: Date;
  coach: CoachAvailabilityInput | undefined;
  hasHours: boolean;
}): SlotFit {
  const { staff, ctx, start, end, durationMinutes, coach } = a;
  const { court, venue } = ctx;
  const inc = court.slot_increment_minutes;
  const tz = venue.timezone;
  const overlapping = a.alive.filter((b) =>
    rangesOverlap(start, end, new Date(b.start_time), new Date(b.end_time)),
  );

  const first = startFit(staff, ctx, start, a.now, coach !== undefined);
  if (first !== "OK") return first;
  if (!staff) {
    if (durationMinutes % inc !== 0) return "OFF_INCREMENT";
    if (durationMinutes < court.min_booking_minutes || durationMinutes > court.max_booking_minutes) {
      return "DURATION_OUT_OF_RANGE";
    }
    if (a.hasHours) {
      const hours = { timezone: tz, operating_hours: ctx.operatingHours };
      if (!isWithinOperatingHours(start, addMinutes(start, LIMITS.booking.gridMinutes), hours))
        return "VENUE_CLOSED";
      if (!isWithinOperatingHours(start, end, hours)) return "RUNS_PAST_CLOSING";
    } else if (!venue.is_open_24h) {
      return "VENUE_HOURS_NOT_SET";
    }
    if (overlapping.some((b) => b.kind === "CLOSED")) return "COURT_CLOSED";
  }
  // Coaches are bookable only at verified venues, within their weekly windows.
  if (
    coach &&
    (ctx.venue.verification_status !== "VERIFIED" || !isWithinCoachWindows(start, end, coach.windows, tz))
  ) {
    return "COACH_UNAVAILABLE";
  }
  const bookings = overlapping.filter((b) => b.kind !== "CLOSED");
  if (!staff && bookings.some((b) => b.is_mine)) return "SLOT_ALREADY_YOURS";
  if (bookings.length > 0) return "SLOT_TAKEN";
  if (coach?.busy.some((c) => rangesOverlap(start, end, new Date(c.start_time), new Date(c.end_time)))) {
    return "COACH_UNAVAILABLE";
  }
  return "OK";
}

function maxBookable(a: {
  staff: boolean;
  ctx: CourtBookingContext;
  cells: readonly Cell[];
  i: number;
  maxLength: number;
  now: Date;
  coach: CoachAvailabilityInput | undefined;
}): number {
  const { staff, ctx, cells, i, maxLength, coach } = a;
  const inc = ctx.court.slot_increment_minutes;
  if (startFit(staff, ctx, cells[i]!.start, a.now, coach !== undefined) !== "OK") return 0;

  let minutes = 0;
  for (let j = i; j < cells.length && minutes + inc <= maxLength; j++) {
    const c = cells[j]!;
    const free = c.others.length === 0 && !c.mine && c.coachOk;
    if (!free || (!staff && (!c.inHours || c.closure))) break;
    minutes += inc;
  }
  const min = staff ? inc : ctx.court.min_booking_minutes;
  return minutes >= min ? minutes : 0;
}

/** Lengths a player can pick from `start` (min..maxBookable in increments), for the duration picker. */
export function bookableDurations(
  slot: Pick<DaySlot, "maxBookableMinutes">,
  ctx: CourtBookingContext,
): number[] {
  const { slot_increment_minutes: inc, min_booking_minutes: min } = ctx.court;
  const out: number[] = [];
  for (let m = min; m <= slot.maxBookableMinutes; m += inc) out.push(m);
  return out;
}

/** "18:00–19:30" in the venue's time zone ("24:00" for a booking that ends at midnight). */
export function formatSlotRange(start: string | Date, end: string | Date, timeZone: string): string {
  const s = toZonedParts(start, timeZone);
  const e = toZonedParts(end, timeZone);
  return `${s.time}–${e.time === "00:00" && e.date !== s.date ? "24:00" : e.time}`;
}
