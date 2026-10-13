/**
 * Shared Zod building blocks. Each one normalises user input (whitespace,
 * phone formats, letter case) before validating, so the data written to
 * Postgres is canonical.
 */
import { z } from "zod";

export const uuidSchema = z.uuid({ error: "Invalid id." });

// -----------------------------------------------------------------------------
// Text
// -----------------------------------------------------------------------------
/** Trim and collapse internal whitespace (names, titles, labels). */
export const squish = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Trim and normalise line endings, keeping paragraphs (bios, descriptions). */
const tidyMultiline = (value: string): string => value.replace(/\r\n?/g, "\n").trim();

/** Required single-line text, length measured after squishing (matches `char_length(btrim(x))`). */
export function line(min: number, max: number) {
  return z
    .string({ error: "Required." })
    .overwrite(squish)
    .min(min, { error: min <= 1 ? "Required." : `Must be at least ${min} characters.` })
    .max(max, { error: `Must be at most ${max} characters.` });
}

/** Optional single-line text. Blank input becomes `undefined`. */
export function optionalLine(min: number, max: number) {
  return z
    .string()
    .overwrite(squish)
    .refine((v) => v === "" || v.length >= min, { error: `Must be at least ${min} characters.` })
    .refine((v) => v.length <= max, { error: `Must be at most ${max} characters.` })
    .transform((v) => (v === "" ? undefined : v))
    .optional();
}

/** Optional multi-line text. Blank input becomes `undefined`. */
export function optionalParagraphs(max: number) {
  return z
    .string()
    .overwrite(tidyMultiline)
    .max(max, { error: `Must be at most ${max} characters.` })
    .transform((v) => (v === "" ? undefined : v))
    .optional();
}

// -----------------------------------------------------------------------------
// Philippine phone numbers → E.164 (+63…)
// -----------------------------------------------------------------------------
export const PH_MOBILE_PATTERN = /^\+639\d{9}$/;
/** Mobile (+639XXXXXXXXX) or landline (+632XXXXXXXX, +63XXXXXXXXX). Matches the venues CHECK. */
export const PH_PHONE_PATTERN = /^\+63\d{9,10}$/;

/**
 * Accepts the ways Filipinos actually type numbers:
 * "0917 123 4567", "(0917) 123-4567", "9171234567", "639171234567",
 * "+63 917 123 4567", "0063 917 123 4567", "(02) 8123 4567".
 * Returns E.164 when the input is recognisable, otherwise the stripped input
 * (which then fails the pattern check).
 */
export function normalizePhilippinePhone(raw: string): string {
  const compact = raw.replace(/[\s().\-]/g, "");
  if (/^\+63\d+$/.test(compact)) return compact;
  if (/^0063\d+$/.test(compact)) return `+${compact.slice(2)}`;
  if (/^63\d{9,10}$/.test(compact)) return `+${compact}`;
  if (/^0\d+$/.test(compact)) return `+63${compact.slice(1)}`;
  if (/^9\d{9}$/.test(compact)) return `+63${compact}`;
  return compact;
}

export const phMobileSchema = z
  .string({ error: "Enter a mobile number." })
  .overwrite(normalizePhilippinePhone)
  .regex(PH_MOBILE_PATTERN, { error: "Enter a PH mobile number, e.g. 0917 123 4567." });

export const phPhoneSchema = z
  .string({ error: "Enter a phone number." })
  .overwrite(normalizePhilippinePhone)
  .regex(PH_PHONE_PATTERN, {
    error: "Enter a PH mobile or landline number, e.g. 0917 123 4567 or (02) 8123 4567.",
  });

/** "+639171234567" → "0917 123 4567" (how numbers are written locally). */
export function formatPhilippineMobile(e164: string): string {
  if (!PH_MOBILE_PATTERN.test(e164)) return e164;
  const local = `0${e164.slice(3)}`;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

// -----------------------------------------------------------------------------
// Locations, e-mail, URLs, storage paths, dates
// -----------------------------------------------------------------------------
/** PSGC (Philippine Standard Geographic Code), 9- or 10-digit. */
export const psgcCodeSchema = z
  .string({ error: "Pick a location from the list." })
  .trim()
  .regex(/^\d{9,10}$/, { error: "Pick a location from the list." });

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Enter a valid e-mail address." }));

export const httpsUrlSchema = z.url({ protocol: /^https$/, error: "Enter a secure (https) link." });

/**
 * Supabase Storage object path inside a bucket, e.g. "<uuid>/receipt-1.jpg".
 * No leading slash, no "..", and only conservative characters.
 */
export const storagePathSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.\-]{0,254}$/, { error: "Invalid file path." })
  .refine((p) => !p.split("/").includes(".."), { error: "Invalid file path." });

/** Calendar date "YYYY-MM-DD". */
export const isoDateSchema = z.iso.date({ error: "Use the date format YYYY-MM-DD." });

/**
 * An absolute instant with an explicit offset ("2026-10-19T18:00:00+08:00" or
 * "…Z"). Normalised to UTC ISO. Offset-less strings are rejected because
 * they're ambiguous.
 */
export const instantSchema = z.iso
  .datetime({ offset: true, error: "Use an ISO date-time with a time zone offset." })
  // Zod still runs overwrites after a failed format check, so never throw on bad input.
  .overwrite((s) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  })
  .refine((s) => !Number.isNaN(new Date(s).getTime()), { error: "That date-time doesn't exist." });

/** True for strings that parse to a real instant (guards cross-field refinements). */
export const isValidInstant = (s: string): boolean => !Number.isNaN(new Date(s).getTime());

// -----------------------------------------------------------------------------
// Time of day
// -----------------------------------------------------------------------------
/** "HH:MM" (24h) or "24:00" for end-of-day. Postgres "HH:MM:00" is accepted and normalised. */
export const TIME_OF_DAY_PATTERN = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)(?::00)?$/;

export const timeOfDaySchema = z
  .string({ error: "Enter a time." })
  .trim()
  .regex(TIME_OF_DAY_PATTERN, { error: "Use 24-hour time, e.g. 06:00 or 21:30." })
  .overwrite((v) => v.slice(0, 5));

/** Same as timeOfDaySchema but rejects "24:00" (for start times). */
export const startTimeOfDaySchema = timeOfDaySchema.refine((v) => v !== "24:00", {
  error: "A start time must be before 24:00.",
});

/** "06:30" → 390, "24:00" → 1440. */
export function minutesSinceMidnight(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

export const dayOfWeekSchema = z
  .number({ error: "Pick a day." })
  .int()
  .min(0, { error: "Pick a day." })
  .max(6, { error: "Pick a day." });

// -----------------------------------------------------------------------------
// Collections
// -----------------------------------------------------------------------------
/** True when the array has no duplicates (by value or by key). */
export function isDistinct<T>(items: readonly T[], key: (item: T) => unknown = (x) => x): boolean {
  return new Set(items.map(key)).size === items.length;
}
