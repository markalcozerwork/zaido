/**
 * Time-zone helpers built on Intl (no dependencies).
 *
 * The database stores instants (timestamptz), while venues think in wall-clock
 * time in their own zone (Asia/Manila by default, UTC+8, no DST). These helpers
 * convert between the two the same way the database does
 * (`ts AT TIME ZONE venue.timezone`). They're DST-correct, so the platform can
 * expand beyond PH.
 */
import { minutesSinceMidnight } from "./primitives";

export const DEFAULT_TIME_ZONE = "Asia/Manila";

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  /** "YYYY-MM-DD" in the zone. */
  date: string;
  /** "HH:MM" in the zone. */
  time: string;
  /** 0 = Sunday … 6 = Saturday, like Postgres `extract(dow …)`. */
  dayOfWeek: number;
  /** Minutes since local midnight. */
  minuteOfDay: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function rawParts(instant: Date, timeZone: string) {
  const out: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(instant)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday ?? ""] ?? 0,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Wall-clock view of an instant in a zone. */
export function toZonedParts(instant: Date | string, timeZone: string = DEFAULT_TIME_ZONE): ZonedParts {
  const p = rawParts(typeof instant === "string" ? new Date(instant) : instant, timeZone);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    dayOfWeek: p.weekday,
    minuteOfDay: p.hour * 60 + p.minute,
  };
}

/** Offset of `timeZone` from UTC at `epochMs`, in minutes (Manila → +480). */
function offsetMinutes(epochMs: number, timeZone: string): number {
  const p = rawParts(new Date(epochMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

/**
 * Wall-clock date + time in a zone → instant.
 * `zonedTimeToInstant("2026-10-19", "18:00")` → 2026-10-19T10:00:00.000Z.
 * "24:00" means midnight at the end of `date`. Local times that don't exist
 * (inside a DST gap) resolve forward, like Postgres.
 */
export function zonedTimeToInstant(date: string, time: string, timeZone: string = DEFAULT_TIME_ZONE): Date {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const minutes = minutesSinceMidnight(time);
  const wallAsUtc = Date.UTC(y, mo - 1, d, 0, minutes);
  const first = wallAsUtc - offsetMinutes(wallAsUtc, timeZone) * 60_000;
  const second = wallAsUtc - offsetMinutes(first, timeZone) * 60_000;
  return new Date(second);
}

/** Same calendar date shifted by `days` ("2026-10-19", 1 → "2026-10-20"). */
export function addDaysToDate(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export const addMinutes = (instant: Date, minutes: number): Date =>
  new Date(instant.getTime() + minutes * 60_000);

export const minutesBetween = (start: Date, end: Date): number =>
  Math.round((end.getTime() - start.getTime()) / 60_000);

/** Is the instant on an N-minute boundary of the UTC epoch? (PH offsets are whole hours.) */
export const isOnMinuteGrid = (instant: Date, minutes: number): boolean =>
  instant.getTime() % (minutes * 60_000) === 0;
