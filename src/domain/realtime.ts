/**
 * The realtime contract for court availability, shared by the database
 * trigger (app.tg_broadcast_court_slots) and the client subscription. A
 * contract test reads the trigger's source and checks these three values.
 *
 *   * Topic `court:<court_id>:slots`, PRIVATE: only the receive policy on
 *     realtime.messages lets clients join, and with no INSERT policy nobody can
 *     send (spoof) on it.
 *   * Event `slot_changed`.
 *   * Payloads are hints. Clients refetch busy slots on every message instead
 *     of trusting `busy`, so a missed, reordered or duplicated message can't
 *     leave the grid wrong.
 */
import { z } from "zod";
import { instantSchema, uuidSchema } from "./primitives";

export const slotTopic = (courtId: string): string => `court:${courtId}:slots`;
export const SLOT_EVENT = "slot_changed";
export const SLOT_CHANNEL_PRIVATE = true;

/**
 * Loose on purpose: Realtime adds its own keys (e.g. `id`) and future
 * triggers may add more.
 */
export const slotChangedPayloadSchema = z.looseObject({
  court_id: uuidSchema,
  start_time: instantSchema,
  end_time: instantSchema,
  busy: z.boolean(),
  held_until: instantSchema.nullish(),
});

export type SlotChangedPayload = z.output<typeof slotChangedPayloadSchema>;
