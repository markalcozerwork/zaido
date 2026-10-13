/**
 * Enum schemas and display labels.
 *
 * Every allowed value comes from `Constants`, which is generated from the
 * Postgres enums, so there's no hand-maintained list to drift. Labels are
 * typed `Record<Enum, string>`: when a migration adds an enum value and the
 * types are regenerated, `tsc` fails until a label is written for it.
 */
import { z } from "zod";
import { Constants, type DbEnum } from "../db";

const E = Constants.public.Enums;

export const sportSchema = z.enum(E.sport);
export const skillLevelSchema = z.enum(E.skill_level);
export const ratingSystemSchema = z.enum(E.rating_system);
export const playStyleSchema = z.enum(E.play_style);
export const dominantHandSchema = z.enum(E.dominant_hand);
export const verificationStatusSchema = z.enum(E.verification_status);
export const courtSurfaceSchema = z.enum(E.court_surface);
export const venueAmenitySchema = z.enum(E.venue_amenity);
export const paymentMethodSchema = z.enum(E.payment_method);
export const paymentStatusSchema = z.enum(E.payment_status);
export const bookingStatusSchema = z.enum(E.booking_status);
export const clubRoleSchema = z.enum(E.club_role);
export const eventTypeSchema = z.enum(E.event_type);
export const eventStatusSchema = z.enum(E.event_status);
export const attendeeStatusSchema = z.enum(E.attendee_status);
export const rotationFormatSchema = z.enum(E.rotation_format);
export const tournamentFormatSchema = z.enum(E.tournament_format);
export const queueStateSchema = z.enum(E.queue_state);
export const channelTypeSchema = z.enum(E.channel_type);
export const chatReportReasonSchema = z.enum(E.chat_report_reason);
export const chatReportStatusSchema = z.enum(E.chat_report_status);

export type Sport = DbEnum<"sport">;
export type SkillLevel = DbEnum<"skill_level">;
export type RatingSystem = DbEnum<"rating_system">;
export type PlayStyle = DbEnum<"play_style">;
export type DominantHand = DbEnum<"dominant_hand">;
export type VerificationStatus = DbEnum<"verification_status">;
export type CourtSurface = DbEnum<"court_surface">;
export type VenueAmenity = DbEnum<"venue_amenity">;
export type PaymentMethod = DbEnum<"payment_method">;
export type PaymentStatus = DbEnum<"payment_status">;
export type BookingStatus = DbEnum<"booking_status">;
export type ClubRole = DbEnum<"club_role">;
export type EventType = DbEnum<"event_type">;
export type EventStatus = DbEnum<"event_status">;
export type AttendeeStatus = DbEnum<"attendee_status">;
export type RotationFormat = DbEnum<"rotation_format">;
export type TournamentFormat = DbEnum<"tournament_format">;
export type QueueState = DbEnum<"queue_state">;
export type ChannelType = DbEnum<"channel_type">;
export type ChatReportReason = DbEnum<"chat_report_reason">;
export type ChatReportStatus = DbEnum<"chat_report_status">;

// -----------------------------------------------------------------------------
// Labels (English UI copy; i18n can key off the enum values later)
// -----------------------------------------------------------------------------
export const SPORT_LABELS: Record<Sport, string> = {
  PICKLEBALL: "Pickleball",
  BADMINTON: "Badminton",
  TENNIS: "Tennis",
  TABLE_TENNIS: "Table Tennis",
};

export const SKILL_LEVEL_LABELS: Record<SkillLevel, string> = {
  BEGINNER: "Beginner",
  INTERMEDIATE: "Intermediate",
  ADVANCED: "Advanced",
  PRO: "Pro / Competitive",
};

export const RATING_SYSTEM_LABELS: Record<RatingSystem, string> = {
  DUPR: "DUPR",
  NTRP: "NTRP",
  UTR: "UTR",
  SELF_ASSESSED: "Self-assessed",
};

export const PLAY_STYLE_LABELS: Record<PlayStyle, string> = {
  SINGLES: "Singles",
  DOUBLES: "Doubles",
  BOTH: "Singles & Doubles",
};

export const DOMINANT_HAND_LABELS: Record<DominantHand, string> = {
  RIGHT: "Right-handed",
  LEFT: "Left-handed",
  AMBIDEXTROUS: "Ambidextrous",
};

export const COURT_SURFACE_LABELS: Record<CourtSurface, string> = {
  TARAFLEX: "Taraflex",
  WOOD: "Wood",
  CONCRETE: "Concrete",
  ACRYLIC: "Acrylic",
  ASPHALT: "Asphalt",
  SYNTHETIC_GRASS: "Synthetic grass",
  CLAY: "Clay",
  RUBBER: "Rubber",
};

export const VENUE_AMENITY_LABELS: Record<VenueAmenity, string> = {
  LIGHTS: "Lights (night play)",
  PARKING: "Parking",
  SHOWERS: "Showers",
  LOCKERS: "Lockers",
  RESTROOMS: "Restrooms",
  AIRCON: "Air-conditioned",
  DRINKING_WATER: "Drinking water",
  CANTEEN: "Canteen",
  PRO_SHOP: "Pro shop",
  RACKET_RENTAL: "Racket rental",
  PADDLE_RENTAL: "Paddle rental",
  BALL_SALES: "Balls for sale",
  SHUTTLE_SALES: "Shuttlecocks for sale",
  WIFI: "Wi-Fi",
  SEATING: "Seating",
  FIRST_AID: "First aid",
  WHEELCHAIR_ACCESS: "Wheelchair access",
  COVERED_WAITING_AREA: "Covered waiting area",
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  GCASH: "GCash",
  MAYA: "Maya",
  BANK_TRANSFER: "Bank transfer",
  CASH_ON_COURT: "Cash on court",
};

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  CONFIRMED: "Confirmed",
  CANCELLED: "Cancelled",
  COMPLETED: "Completed",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  UNPAID: "Unpaid",
  AWAITING_VERIFICATION: "Payment under review",
  PAID: "Paid",
  REJECTED: "Payment rejected",
  REFUNDED: "Refunded",
};

export const CHAT_REPORT_REASON_LABELS: Record<ChatReportReason, string> = {
  SPAM: "Spam or scam links",
  HARASSMENT: "Harassment or bullying",
  HATE: "Hate speech",
  SEXUAL_CONTENT: "Sexual content",
  VIOLENCE: "Violence or threats",
  SCAM: "Fraud or fake payments",
  OTHER: "Something else",
};

export const CHAT_REPORT_STATUS_LABELS: Record<ChatReportStatus, string> = {
  OPEN: "Under review",
  ACTIONED: "Action taken",
  DISMISSED: "No action needed",
};

/** Day-of-week numbering used everywhere: 0 = Sunday … 6 = Saturday (Postgres `extract(dow …)`). */
export const DAY_OF_WEEK_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// -----------------------------------------------------------------------------
// Sport-specific rating rules (mirrors player_profiles CHECK constraints)
// -----------------------------------------------------------------------------
export const RATING_SYSTEMS_BY_SPORT: Record<Sport, readonly RatingSystem[]> = {
  PICKLEBALL: ["DUPR", "SELF_ASSESSED"],
  TENNIS: ["NTRP", "UTR", "SELF_ASSESSED"],
  BADMINTON: ["SELF_ASSESSED"],
  TABLE_TENNIS: ["SELF_ASSESSED"],
};

export const RATING_RANGES: Record<RatingSystem, { min: number; max: number }> = {
  DUPR: { min: 2, max: 8 },
  NTRP: { min: 1, max: 7 },
  UTR: { min: 1, max: 16.5 },
  SELF_ASSESSED: { min: 1, max: 10 },
};
