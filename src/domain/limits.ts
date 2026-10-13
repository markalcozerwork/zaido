/**
 * Numeric and length limits that mirror the database CHECK constraints in
 * `supabase/migrations`. The contract tests (`tests/contract`) run boundary
 * values through both Zod and Postgres, so a drift on either side fails CI.
 */
export const LIMITS = {
  money: { max: 100_000 }, // rates and fees, PHP
  person: { fullName: { min: 2, max: 120 }, displayName: { min: 2, max: 40 }, bio: { max: 1_000 } },
  coach: { bio: { max: 2_000 }, sports: { min: 1, max: 4 }, years: { max: 80 }, credentials: { max: 20 } },
  player: { years: { max: 80 } },
  venue: {
    name: { min: 2, max: 120 },
    address: { min: 5, max: 300 },
    description: { max: 4_000 },
    photos: { max: 20 },
    paymentWindowMinutes: { min: 5, max: 1_440 },
    cancellationCutoffHours: { min: 0, max: 168 },
    minLeadMinutes: { min: 0, max: 1_440 },
    bookingHorizonDays: { min: 1, max: 90 },
    maxActiveHoldsPerPlayer: { min: 1, max: 50 },
  },
  court: {
    name: { min: 1, max: 60 },
    slotIncrements: [15, 30, 60] as const,
    maxBookingMinutes: 720,
    maxPlayers: { min: 1, max: 64 },
  },
  rateRule: { label: { min: 1, max: 60 } },
  booking: {
    gridMinutes: 15,
    maxDurationMinutes: 12 * 60,
    maxAdvanceDays: 90,
    playerCount: { min: 1, max: 64 },
    /** app.hold_grace(): how long after payment_due_at an unpaid hold still holds the slot. */
    holdGraceMinutes: 5,
    walkInName: { min: 2, max: 120 },
  },
  closure: { reason: { min: 3, max: 200 }, maxDays: 31 },
  paymentRef: { pattern: /^[A-Za-z0-9-]{6,40}$/ },
} as const;

/**
 * Column defaults as declared in the migrations. Input schemas leave these
 * fields optional and the insert mappers omit them, so the database default
 * applies. Validation that depends on a defaulted value uses these constants.
 * Contract tests assert they still match the database.
 */
export const DB_DEFAULTS = {
  coach: {
    offers_private: true,
    offers_group_clinics: false,
  },
  player: {
    play_style: "BOTH",
    skill_level: "BEGINNER",
  },
  venue: {
    timezone: "Asia/Manila",
    accepts_cash_on_court: true,
    auto_confirm_cash_bookings: true,
    payment_window_minutes: 30,
    cancellation_cutoff_hours: 24,
    max_active_holds_per_player: 3,
    min_lead_minutes: 0,
    booking_horizon_days: 90,
    is_open_24h: false,
  },
  court: {
    slot_increment_minutes: 30,
    min_booking_minutes: 60,
    max_booking_minutes: 240,
    lights_fee_per_hour: 0,
    lights_from: "18:00",
    lights_until: "06:00",
    is_indoor: false,
  },
} as const;
