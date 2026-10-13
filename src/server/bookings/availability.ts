/**
 * Availability grids and quotes. Reads only; safe for anonymous visitors
 * (coach availability needs a signed-in user, like the coach directory).
 */
import {
  addDaysToDate,
  availabilityQuerySchema,
  buildDaySlots,
  busyFetchWindow,
  mapDatabaseError,
  nextRefreshAt,
  quoteRequestSchema,
  toQuoteArgs,
  toZonedParts,
  validate,
  venueAvailabilityQuerySchema,
  LIMITS,
  type ActionResult,
  type BookingQuote,
  type BusyRange,
  type CoachAvailabilityInput,
  type CourtBookingContext,
  type DaySlot,
} from "../../domain";
import type { DbClient } from "../db-client";
import { loadCourtBookingContext, loadVenueBookingContexts } from "./context";
import { callWithRetry } from "./transport";
import type { ServerDeps } from "./deps";

export interface DayAvailability {
  courtId: string;
  courtName: string;
  timezone: string;
  slots: DaySlot[];
  /** Refetch at this time even without a realtime message (an unpaid hold lets go then). */
  refreshAt: string | null;
}

export interface AvailabilityOptions {
  /** "staff" applies the rules the database applies to venue staff (front desk). Decided by the route, never by input. */
  mode?: "player" | "staff";
  /** The signed-in user (from the session), so a coach isn't offered themselves as a coach. */
  viewerId?: string;
}

/** PostgREST's max-rows (Supabase "Max rows", 1000 by default) silently truncates; page below it. */
export const BUSY_PAGE_SIZE = 500;

/** One court, one venue-local day, for the chosen duration (and coach). */
export async function getDayAvailability(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
  opts: AvailabilityOptions = {},
): Promise<ActionResult<DayAvailability>> {
  const q = validate(availabilityQuerySchema, input);
  if (!q.ok) return q;
  const now = (deps.now ?? (() => new Date()))();

  const ctx = await loadCourtBookingContext(client, q.data.court_id, deps);
  if (!ctx.ok) return ctx;
  const dateIssue = checkDate(q.data.date, ctx.data, now);
  if (dateIssue) return dateIssue;

  const window = busyFetchWindow(
    q.data.date,
    ctx.data.venue.timezone,
    fetchExtra(ctx.data, q.data.duration_minutes, opts),
  );
  const [busy, coach] = await Promise.all([
    callWithRetry<BusyRange[]>(
      (signal) =>
        client
          .rpc("get_court_busy_slots", {
            p_court_id: q.data.court_id,
            p_from: window.from.toISOString(),
            p_to: window.to.toISOString(),
          })
          .abortSignal(signal)
          .retry(false),
      deps.retry,
    ),
    q.data.coach_id
      ? loadCoach(client, q.data.coach_id, ctx.data, window, deps, opts)
      : Promise.resolve(undefined),
  ]);
  if (!busy.ok) return busy;
  if (coach && !coach.ok) return coach;

  const slots = buildDaySlots({
    ctx: ctx.data,
    busy: busy.data,
    coach: coach?.data,
    date: q.data.date,
    durationMinutes: q.data.duration_minutes,
    now,
    mode: opts.mode ?? "player",
  });
  return {
    ok: true,
    data: {
      courtId: ctx.data.court.id,
      courtName: ctx.data.court.name,
      timezone: ctx.data.venue.timezone,
      slots,
      refreshAt: nextRefreshAt(busy.data, now)?.toISOString() ?? null,
    },
  };
}

/** Every court of a venue for one day: "any court free at 7pm?" and the front-desk sheet. */
export async function getVenueDayAvailability(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
  opts: AvailabilityOptions = {},
): Promise<ActionResult<DayAvailability[]>> {
  const q = validate(venueAvailabilityQuerySchema, input);
  if (!q.ok) return q;
  const now = (deps.now ?? (() => new Date()))();

  const contexts = await loadVenueBookingContexts(client, q.data.venue_id, deps);
  if (!contexts.ok) return contexts;
  const first = contexts.data[0];
  if (!first) return { ok: true, data: [] };
  const dateIssue = checkDate(q.data.date, first, now);
  if (dateIssue) return dateIssue;

  const extra = Math.max(...contexts.data.map((c) => fetchExtra(c, q.data.duration_minutes, opts)));
  const window = busyFetchWindow(q.data.date, first.venue.timezone, extra);
  // A busy venue can exceed PostgREST's row cap in one day: page until a short page.
  const busy = await fetchAllPages<BusyRange & { court_id: string }>(
    (from, to) => (signal) =>
      client
        .rpc("get_venue_busy_slots", {
          p_venue_id: q.data.venue_id,
          p_from: window.from.toISOString(),
          p_to: window.to.toISOString(),
        })
        .range(from, to)
        .abortSignal(signal)
        .retry(false),
    deps,
  );
  if (!busy.ok) return busy;

  return {
    ok: true,
    data: contexts.data.map((ctx) => {
      const mine = busy.data.filter((b) => b.court_id === ctx.court.id);
      return {
        courtId: ctx.court.id,
        courtName: ctx.court.name,
        timezone: ctx.venue.timezone,
        slots: buildDaySlots({
          ctx,
          busy: mine,
          date: q.data.date,
          durationMinutes: q.data.duration_minutes,
          now,
          mode: opts.mode ?? "player",
        }),
        refreshAt: nextRefreshAt(mine, now)?.toISOString() ?? null,
      };
    }),
  };
}

/** The database's price for a slot (what create_booking will charge). */
export async function quoteBooking(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<BookingQuote>> {
  const q = validate(quoteRequestSchema, input);
  if (!q.ok) return q;
  const res = await callWithRetry<BookingQuote[]>(
    (signal) => client.rpc("quote_court_booking", toQuoteArgs(q.data)).abortSignal(signal).retry(false),
    deps.retry,
  );
  if (!res.ok) return res;
  const quote = res.data?.[0];
  return quote
    ? { ok: true, data: quote }
    : { ok: false, error: { code: "NOT_FOUND", message: "That court isn't available.", retryable: false } };
}

// -----------------------------------------------------------------------------

/** Late slots run past midnight: fetch far enough to see what they'd overlap. */
function fetchExtra(ctx: CourtBookingContext, durationMinutes: number, opts: AvailabilityOptions): number {
  const longest = opts.mode === "staff" ? LIMITS.booking.maxDurationMinutes : ctx.court.max_booking_minutes;
  return Math.max(durationMinutes, longest);
}

/** Bounded input: yesterday (for late-night sessions) up to the furthest bookable day. */
function checkDate(date: string, ctx: CourtBookingContext, now: Date): ActionResult<never> | null {
  const today = toZonedParts(now, ctx.venue.timezone).date;
  if (date < addDaysToDate(today, -1) || date > addDaysToDate(today, LIMITS.booking.maxAdvanceDays + 1)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Pick a date within the booking window.",
        field: "date",
        retryable: false,
      },
      fieldErrors: { date: ["Pick a date within the booking window."] },
    };
  }
  return null;
}

/**
 * Runs a ranged request page by page (rows from..to inclusive) until a page
 * comes back short. Ordered RPCs make the pages stable.
 */
export async function fetchAllPages<T>(
  page: (
    from: number,
    to: number,
  ) => (
    signal: AbortSignal,
  ) => PromiseLike<{ data: T[] | null; error: { code?: string; message?: string } | null; status: number }>,
  deps: ServerDeps,
  pageSize = BUSY_PAGE_SIZE,
): Promise<ActionResult<T[]>> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const res = await callWithRetry<T[]>(page(from, from + pageSize - 1), deps.retry);
    if (!res.ok) return res;
    const chunk = res.data ?? [];
    rows.push(...chunk);
    if (chunk.length < pageSize) return { ok: true, data: rows };
  }
}

/**
 * The coach's rate, weekly windows and existing commitments. Only coaches the
 * database would price for this court are offered: verified, giving private
 * sessions, coaching this sport, and not the viewer themselves.
 */
async function loadCoach(
  client: DbClient,
  coachId: string,
  ctx: CourtBookingContext,
  window: { from: Date; to: Date },
  deps: ServerDeps,
  opts: AvailabilityOptions,
): Promise<ActionResult<CoachAvailabilityInput>> {
  const [profile, windows, busy] = await Promise.all([
    callWithRetry<{ hourly_rate: number; offers_private: boolean; sports_coached: string[] } | null>(
      (signal) =>
        client
          .from("coach_profiles")
          .select("hourly_rate, offers_private, sports_coached")
          .eq("profile_id", coachId)
          .eq("verified_status", "VERIFIED")
          .abortSignal(signal)
          .retry(false)
          .maybeSingle(),
      deps.retry,
    ),
    callWithRetry<CoachAvailabilityInput["windows"]>(
      (signal) =>
        client
          .from("coach_availability")
          .select("day_of_week, start_time, end_time")
          .eq("coach_id", coachId)
          .abortSignal(signal)
          .retry(false),
      deps.retry,
    ),
    callWithRetry<CoachAvailabilityInput["busy"]>(
      (signal) =>
        client
          .rpc("get_coach_busy_slots", {
            p_coach_id: coachId,
            p_from: window.from.toISOString(),
            p_to: window.to.toISOString(),
          })
          .abortSignal(signal)
          .retry(false),
      deps.retry,
    ),
  ]);
  if (!profile.ok) return profile;
  if (!windows.ok) return windows;
  if (!busy.ok) return busy;
  if (
    !profile.data ||
    !profile.data.offers_private ||
    !profile.data.sports_coached.includes(ctx.court.sport) ||
    coachId === opts.viewerId
  ) {
    return {
      ok: false,
      error: {
        ...mapDatabaseError({ code: "P0002" }),
        message: "That coach isn't available for booking.",
        field: "coach_id",
      },
    };
  }
  return { ok: true, data: { hourlyRate: profile.data.hourly_rate, windows: windows.data, busy: busy.data } };
}
