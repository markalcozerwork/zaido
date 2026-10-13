/**
 * Database error → typed domain error.
 *
 * Postgres reports integrity failures with a SQLSTATE plus, for constraint
 * violations, the constraint name in the message. The guard triggers raise
 * human-readable messages, which are safe to show. System messages (RLS,
 * constraint names, permission denied) are replaced with friendly text so
 * internals never leak to the UI.
 */
export type DomainErrorCode =
  | "VALIDATION_FAILED"
  | "SLOT_TAKEN"
  | "COACH_UNAVAILABLE"
  | "PAYMENT_REF_ALREADY_USED"
  | "EVENT_FULL"
  | "RULE_VIOLATION"
  | "CONFLICT"
  | "INVALID_REFERENCE"
  | "FORBIDDEN"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "RETRYABLE"
  | "UNKNOWN";

export interface DomainError {
  code: DomainErrorCode;
  /** Safe to show to the user. */
  message: string;
  /** Form field to attach the message to, when known. */
  field?: string;
  /** True when the same request may succeed if retried (serialization failure, deadlock). */
  retryable: boolean;
  /** Original SQLSTATE / PostgREST code, for logs. */
  cause?: string;
}

/** The shape of PostgrestError (supabase-js) and node-postgres DatabaseError. */
export interface DatabaseErrorLike {
  code?: string | undefined;
  message?: string | undefined;
  details?: string | null | undefined;
  hint?: string | null | undefined;
  constraint?: string | undefined;
}

/** Specific constraints with a dedicated code, message and form field. */
const CONSTRAINTS: Record<string, Omit<DomainError, "retryable" | "cause">> = {
  bookings_no_court_overlap: {
    code: "SLOT_TAKEN",
    message: "Sorry, that time was just booked by someone else. Please pick another slot.",
    field: "start_time",
  },
  bookings_no_coach_overlap: {
    code: "COACH_UNAVAILABLE",
    message: "That coach is already booked at this time.",
    field: "coach_id",
  },
  bookings_payment_ref_unique: {
    code: "PAYMENT_REF_ALREADY_USED",
    message: "This reference number was already used for another booking. Double-check your receipt.",
    field: "payment_ref_no",
  },
  bookings_quarter_hour_grid: {
    code: "RULE_VIOLATION",
    message: "Bookings start and end on 15-minute marks.",
    field: "start_time",
  },
  bookings_rejection_reason: {
    code: "VALIDATION_FAILED",
    message: "Give the player a reason for the rejection.",
    field: "reason",
  },
  coach_availability_no_overlap: {
    code: "CONFLICT",
    message: "Overlaps another availability window.",
    field: "start_time",
  },
  venue_operating_hours_no_overlap: {
    code: "CONFLICT",
    message: "Overlaps another opening window.",
    field: "opens_at",
  },
  courts_venue_name_key: {
    code: "CONFLICT",
    message: "This venue already has a court with that name.",
    field: "name",
  },
  clubs_slug_key: { code: "CONFLICT", message: "That club link is already taken.", field: "slug" },
  profile_contacts_phone_key: {
    code: "CONFLICT",
    message: "That mobile number is already registered.",
    field: "phone",
  },
  player_profiles_dupr_id_key: {
    code: "CONFLICT",
    message: "That DUPR ID is linked to another player.",
    field: "dupr_id",
  },
  profiles_barangay_fk: {
    code: "INVALID_REFERENCE",
    message: "That barangay isn't in the selected city/municipality.",
    field: "barangay_code",
  },
  venues_barangay_fk: {
    code: "INVALID_REFERENCE",
    message: "That barangay isn't in the selected city/municipality.",
    field: "barangay_code",
  },
};

/** Messages Postgres writes itself. Anything else with these codes came from our guards and is user-facing. */
const SYSTEM_MESSAGE =
  /violates (check|exclusion|foreign key|unique|not-null|row-level security)|permission denied|duplicate key|conflicting key|null value in column/i;

function constraintName(err: DatabaseErrorLike): string | undefined {
  if (err.constraint) return err.constraint;
  const text = `${err.message ?? ""} ${err.details ?? ""}`;
  return /constraint "([^"]+)"/.exec(text)?.[1] ?? /index "([^"]+)"/.exec(text)?.[1];
}

const humanMessage = (err: DatabaseErrorLike, fallback: string): string =>
  err.message && !SYSTEM_MESSAGE.test(err.message) ? err.message : fallback;

export function mapDatabaseError(err: DatabaseErrorLike): DomainError {
  const code = err.code ?? "";
  const known = constraintName(err);
  const base = { retryable: false, cause: code || undefined };

  if (known && CONSTRAINTS[known]) return { ...base, ...CONSTRAINTS[known] };

  switch (code) {
    case "23P01":
      return { ...base, code: "CONFLICT", message: "That overlaps with something already scheduled." };
    case "23505":
      return { ...base, code: "CONFLICT", message: "That already exists." };
    case "23503":
      return {
        ...base,
        code: "INVALID_REFERENCE",
        message: "Something you picked no longer exists. Refresh and try again.",
      };
    case "23514":
    case "23502":
      if (err.message?.startsWith("EVENT_FULL")) {
        return { ...base, code: "EVENT_FULL", message: err.message.replace(/^EVENT_FULL:\s*/, "") };
      }
      return { ...base, code: "RULE_VIOLATION", message: humanMessage(err, "That change isn't allowed.") };
    case "22023":
    case "22P02":
    case "22007":
    case "22008":
      return {
        ...base,
        code: "VALIDATION_FAILED",
        message: humanMessage(err, "Some of the details are invalid."),
      };
    case "42501":
      return {
        ...base,
        code: "FORBIDDEN",
        message: humanMessage(err, "You don't have permission to do that."),
      };
    case "P0002":
    case "PGRST116":
      return { ...base, code: "NOT_FOUND", message: humanMessage(err, "We couldn't find that.") };
    case "40001":
    case "40P01":
      return {
        ...base,
        code: "RETRYABLE",
        message: "We're handling a lot of requests. Please try again.",
        retryable: true,
      };
    case "PGRST301":
    case "PGRST302":
      return { ...base, code: "UNAUTHENTICATED", message: "Please sign in again." };
    default:
      return { ...base, code: "UNKNOWN", message: "Something went wrong. Please try again." };
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    "retryable" in value
  );
}
