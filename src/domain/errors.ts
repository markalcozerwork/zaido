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
  | "SLOT_ALREADY_YOURS"
  | "COACH_UNAVAILABLE"
  | "PAYMENT_REF_ALREADY_USED"
  | "EVENT_FULL"
  | "RULE_VIOLATION"
  | "CONFLICT"
  | "INVALID_REFERENCE"
  | "FORBIDDEN"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "BOOKING_CANCELLED"
  | "RETRYABLE"
  | "ABORTED"
  | "UNKNOWN"
  // Business rules raised by the database as "CODE: message" (see GUARD_CODES).
  | GuardCode;

/**
 * Codes the SQL guards put in front of their messages ("VENUE_CLOSED: The
 * venue is closed…"). PostgREST forwards only code/message/details/hint, so
 * the prefix is the stable contract between SQL and TypeScript. Each maps to
 * the form field the UI should highlight.
 */
export const GUARD_CODES = {
  SLOT_IN_PAST: "start_time",
  TOO_SOON: "start_time",
  BEYOND_HORIZON: "start_time",
  OFF_INCREMENT: "start_time",
  DURATION_OUT_OF_RANGE: "end_time",
  VENUE_CLOSED: "start_time",
  VENUE_HOURS_NOT_SET: "start_time",
  COURT_CLOSED: "start_time",
  COURT_INACTIVE: "court_id",
  PAYMENT_METHOD_UNAVAILABLE: "payment_method",
  PAY_FIRST: "payment_ref_no",
  HOLD_LIMIT_REACHED: undefined,
  HOLD_EXPIRED: "payment_ref_no",
  PAYMENT_LOCKED: "payment_ref_no",
  RECEIPT_INVALID: "receipt_path",
  CANCELLATION_CUTOFF: undefined,
  CANCELLATION_CLOSED: undefined,
  IDEMPOTENCY_KEY_REUSED: undefined,
  COURT_RESERVED_FOR_EVENT: undefined,
  COURT_BOOKING_REQUIRED: "booking_id",
  COURT_BOOKING_UNAVAILABLE: "booking_id",
  COACH_CONFIRMATION_REQUIRED: "coach_id",
  // Step 4: chat
  NOT_A_PARTICIPANT: undefined,
  MESSAGING_UNAVAILABLE: undefined,
  RATE_LIMITED: "text",
  MESSAGE_EMPTY: "text",
  INVALID_MEDIA: "media_path",
  MEDIA_EXPIRED: "media_path",
  REPLY_NOT_IN_CHANNEL: "reply_to_id",
  MESSAGE_DELETED: undefined,
  EDIT_WINDOW_PASSED: "text",
  CHANNEL_ARCHIVED: undefined,
} as const satisfies Record<string, string | undefined>;

export type GuardCode = keyof typeof GUARD_CODES;

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
  /**
   * Extra machine data: the caller's existing booking for SLOT_ALREADY_YOURS,
   * seconds to wait for RATE_LIMITED.
   */
  meta?: { bookingId?: string; retryAfterSeconds?: number };
}

/** The shape of PostgrestError (supabase-js) and node-postgres DatabaseError. */
export interface DatabaseErrorLike {
  /** HTTP status of the PostgREST response; 0 when the request never got one (network, abort). */
  status?: number | undefined;
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
  coach_commitments_no_overlap: {
    code: "COACH_UNAVAILABLE",
    message: "That coach is already booked at this time.",
    field: "coach_id",
  },
  bookings_reserved_for_event_key: {
    code: "COURT_BOOKING_UNAVAILABLE",
    message: "That court booking is already used by another event.",
    field: "booking_id",
  },
  bookings_idempotency_key: {
    code: "CONFLICT",
    message: "This checkout is still being processed. Please wait a moment and refresh.",
  },
  bookings_walk_in_name_length: {
    code: "VALIDATION_FAILED",
    message: "Enter the walk-in player's name (2–120 characters).",
    field: "walk_in_name",
  },
  bookings_walk_in_phone_format: {
    code: "VALIDATION_FAILED",
    message: "Enter a Philippine number, e.g. 0917 123 4567.",
    field: "walk_in_phone",
  },
  bookings_walk_in_phone_needs_name: {
    code: "VALIDATION_FAILED",
    message: "Add the walk-in player's name with their number.",
    field: "walk_in_name",
  },
  venues_max_active_holds: {
    code: "VALIDATION_FAILED",
    message: "Allow between 1 and 50 unpaid bookings per player.",
    field: "max_active_holds_per_player",
  },
  venues_min_lead_minutes: {
    code: "VALIDATION_FAILED",
    message: "The minimum lead time must be between 0 and 1,440 minutes.",
    field: "min_lead_minutes",
  },
  venues_booking_horizon: {
    code: "VALIDATION_FAILED",
    message: "Bookings can open between 1 and 90 days ahead.",
    field: "booking_horizon_days",
  },
  court_closures_order: {
    code: "VALIDATION_FAILED",
    message: "A closure must end after it starts.",
    field: "ends_at",
  },
  court_closures_max_length: {
    code: "VALIDATION_FAILED",
    message: "A closure can last at most 31 days. Add another one for longer.",
    field: "ends_at",
  },
  court_closures_reason_length: {
    code: "VALIDATION_FAILED",
    message: "Give a reason (3–200 characters).",
    field: "reason",
  },
  bookings_notes_length: {
    code: "VALIDATION_FAILED",
    message: "Notes can be at most 500 characters.",
    field: "notes",
  },
  bookings_cancellation_reason_length: {
    code: "VALIDATION_FAILED",
    message: "Keep the reason under 300 characters.",
    field: "reason",
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
  // Step 4: chat
  chat_messages_text_length: {
    code: "VALIDATION_FAILED",
    message: "Messages can be at most 4,000 characters.",
    field: "text",
  },
  chat_messages_media_url_key: {
    code: "INVALID_MEDIA",
    message: "That photo is already attached to another message.",
    field: "media_path",
  },
  chat_messages_sender_client_key: {
    code: "CONFLICT",
    message: "This message is still being sent. Please wait a moment.",
  },
  profile_blocks_pkey: { code: "CONFLICT", message: "You already blocked this player." },
  profile_blocks_not_self: { code: "VALIDATION_FAILED", message: "You can't block yourself." },
  chat_reports_note_length: {
    code: "VALIDATION_FAILED",
    message: "Keep the note under 500 characters.",
    field: "note",
  },
  chat_reports_resolution_note_length: {
    code: "VALIDATION_FAILED",
    message: "Keep the note under 500 characters.",
    field: "resolution_note",
  },
};

/** Messages Postgres writes itself. Anything else with these codes came from our guards and is user-facing. */
const SYSTEM_MESSAGE =
  /violates (check|exclusion|foreign key|unique|not-null|row-level security)|permission denied|duplicate key|conflicting key|null value in column|invalid input (syntax|value)|out of range|malformed|does not exist/i;

function constraintName(err: DatabaseErrorLike): string | undefined {
  if (err.constraint) return err.constraint;
  const text = `${err.message ?? ""} ${err.details ?? ""}`;
  return /constraint "([^"]+)"/.exec(text)?.[1] ?? /index "([^"]+)"/.exec(text)?.[1];
}

const humanMessage = (err: DatabaseErrorLike, fallback: string): string =>
  err.message && !SYSTEM_MESSAGE.test(err.message) ? err.message : fallback;

const PREFIXED = /^([A-Z][A-Z_]+):\s+(.*)$/s;

export function mapDatabaseError(err: DatabaseErrorLike): DomainError {
  const code = err.code ?? "";
  const known = constraintName(err);
  const base = { retryable: false, cause: code || undefined };

  // "CODE: human message" raised by a guard: stable code, prefix stripped.
  const prefixed = err.message ? PREFIXED.exec(err.message) : null;
  if (prefixed) {
    const [, tag, text] = prefixed as unknown as [string, string, string];
    if (tag === "COACH_UNAVAILABLE")
      return { ...base, code: "COACH_UNAVAILABLE", message: text, field: "coach_id" };
    if (tag === "EVENT_FULL") return { ...base, code: "EVENT_FULL", message: text };
    if (tag === "SLOT_ALREADY_YOURS") {
      return {
        ...base,
        code: "SLOT_ALREADY_YOURS",
        message: text,
        field: "start_time",
        ...(err.hint ? { meta: { bookingId: err.hint } } : {}),
      };
    }
    if (tag === "RATE_LIMITED") {
      const wait = Number(err.hint);
      return {
        ...base,
        code: "RATE_LIMITED",
        message: text,
        field: "text",
        ...(Number.isFinite(wait) && wait > 0 ? { meta: { retryAfterSeconds: wait } } : {}),
      };
    }
    if (tag in GUARD_CODES) {
      const field = GUARD_CODES[tag as GuardCode];
      return { ...base, code: tag as GuardCode, message: text, ...(field ? { field } : {}) };
    }
  }

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
    // JWT invalid (301), anonymous access off (302), claims rejected, e.g. expired (303).
    case "PGRST301":
    case "PGRST302":
    case "PGRST303":
      return { ...base, code: "UNAUTHENTICATED", message: "Please sign in again." };
    default:
      return { ...base, code: "UNKNOWN", message: "Something went wrong. Please try again." };
  }
}

/**
 * Failures where sending the SAME request again may succeed: the request never
 * got a response (network, timeout: status 0), the gateway or PostgREST's pool
 * was momentarily unavailable, or Postgres rolled the transaction back
 * (serialization failure, deadlock). Only safe for idempotent requests, which
 * every booking action is (create_booking via its idempotency key; updates set
 * absolute values).
 */
export function isTransientError(err: DatabaseErrorLike): boolean {
  if (err.status === 0) return true;
  if (err.status === undefined && err.code === "") return true;
  if (err.status !== undefined && [502, 503, 504, 520].includes(err.status)) return true;
  return ["PGRST000", "PGRST001", "PGRST002", "PGRST003", "40001", "40P01"].includes(err.code ?? "");
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
