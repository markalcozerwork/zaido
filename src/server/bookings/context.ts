/**
 * Loads what the booking rules need about a court (or all courts of a venue)
 * in ONE PostgREST request each, with embedded venue, opening hours and rate
 * rules. Everything read here is public (anon-readable) data.
 */
import type {
  ActionResult,
  ClosureRow,
  CourtBookingContext,
  CourtContextRow,
  OperatingHoursRow,
  RateRulePricing,
  VenueContextRow,
} from "../../domain";
import type { DbClient } from "../db-client";
import { callWithRetry, type RetryOptions } from "./transport";

const COURT_COLUMNS =
  "id, venue_id, name, sport, is_active, hourly_rate, lights_fee_per_hour, lights_from, lights_until, " +
  "slot_increment_minutes, min_booking_minutes, max_booking_minutes";
const VENUE_COLUMNS =
  "id, name, timezone, is_active, verification_status, accepts_cash_on_court, gcash_number, maya_number, " +
  "bank_transfer_details, auto_confirm_cash_bookings, payment_window_minutes, cancellation_cutoff_hours, " +
  "min_lead_minutes, booking_horizon_days, is_open_24h, max_active_holds_per_player";
const HOURS_COLUMNS = "day_of_week, opens_at, closes_at";
const RATE_COLUMNS =
  "id, days_of_week, start_time, end_time, hourly_rate, priority, valid_from, valid_until, is_active, created_at";

// FK hints: courts ↔ venues are also linked through court_closures, so the
// embed must name the direct relationship.
const COURT_CONTEXT_SELECT =
  `${COURT_COLUMNS}, ` +
  `venue:venues!courts_venue_id_fkey(${VENUE_COLUMNS}, hours:venue_operating_hours(${HOURS_COLUMNS})), ` +
  `rate_rules:court_rate_rules(${RATE_COLUMNS})`;

const VENUE_CONTEXT_SELECT =
  `${VENUE_COLUMNS}, hours:venue_operating_hours(${HOURS_COLUMNS}), ` +
  `courts:courts!courts_venue_id_fkey(${COURT_COLUMNS}, rate_rules:court_rate_rules(${RATE_COLUMNS}))`;

type CourtContextResponse = CourtContextRow & {
  venue: (VenueContextRow & { hours: OperatingHoursRow[] }) | null;
  rate_rules: RateRulePricing[];
};

type VenueContextResponse = VenueContextRow & {
  hours: OperatingHoursRow[];
  courts: Array<CourtContextRow & { rate_rules: RateRulePricing[] }>;
};

export interface LoadOptions {
  retry?: RetryOptions;
}

export async function loadCourtBookingContext(
  client: DbClient,
  courtId: string,
  opts: LoadOptions = {},
): Promise<ActionResult<CourtBookingContext>> {
  const res = await callWithRetry<CourtContextResponse>(
    (signal) =>
      client
        .from("courts")
        .select(COURT_CONTEXT_SELECT)
        .eq("id", courtId)
        .abortSignal(signal)
        .retry(false)
        .maybeSingle()
        .overrideTypes<CourtContextResponse, { merge: false }>(),
    opts.retry,
  );
  if (!res.ok) return res;
  if (!res.data || !res.data.venue) return notFound("That court isn't available.");
  const { venue, rate_rules, ...court } = res.data;
  const { hours, ...venueRow } = venue;
  return { ok: true, data: { court, venue: venueRow, operatingHours: hours, rateRules: rate_rules } };
}

/** Every court of a venue (inactive ones included, so the grid can say so). */
export async function loadVenueBookingContexts(
  client: DbClient,
  venueId: string,
  opts: LoadOptions = {},
): Promise<ActionResult<CourtBookingContext[]>> {
  const res = await callWithRetry<VenueContextResponse>(
    (signal) =>
      client
        .from("venues")
        .select(VENUE_CONTEXT_SELECT)
        .eq("id", venueId)
        .abortSignal(signal)
        .retry(false)
        .maybeSingle()
        .overrideTypes<VenueContextResponse, { merge: false }>(),
    opts.retry,
  );
  if (!res.ok) return res;
  if (!res.data) return notFound("That venue isn't available.");
  const { hours, courts, ...venue } = res.data;
  return {
    ok: true,
    data: courts
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map(({ rate_rules, ...court }) => ({ court, venue, operatingHours: hours, rateRules: rate_rules })),
  };
}

/** Closures touching [from, to) for one court (venue-wide closures included). */
export async function loadClosures(
  client: DbClient,
  ctx: CourtBookingContext,
  from: Date,
  to: Date,
  opts: LoadOptions = {},
): Promise<ActionResult<ClosureRow[]>> {
  const res = await callWithRetry<ClosureRow[]>(
    (signal) =>
      client
        .from("court_closures")
        .select("starts_at, ends_at, reason")
        .eq("venue_id", ctx.venue.id)
        .or(`court_id.is.null,court_id.eq.${ctx.court.id}`)
        .lt("starts_at", to.toISOString())
        .gt("ends_at", from.toISOString())
        .abortSignal(signal)
        .retry(false),
    opts.retry,
  );
  return res.ok ? { ok: true, data: res.data ?? [] } : res;
}

function notFound(message: string): ActionResult<never> {
  return { ok: false, error: { code: "NOT_FOUND", message, retryable: false } };
}
