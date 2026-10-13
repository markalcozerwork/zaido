/**
 * Live availability for the booking grid (browser/app only; the server never
 * holds sockets).
 *
 * Pattern: subscribe first, then (re)fetch busy slots whenever `onResync`
 * fires: on the first join, on every rejoin after a dropped connection, and
 * right away for a second subscriber on an already-joined court. Each
 * `slot_changed` broadcast is only a hint: `onInvalidate` says which range
 * changed so the UI can refetch (debounced). The payload's `busy` flag is never
 * applied directly, so missed, duplicated or out-of-order messages can't leave
 * the grid wrong. Also refetch at `refreshAt` from the grid and when the app
 * returns to the foreground.
 *
 * supabase-js returns the SAME channel object for the same topic, so two
 * components subscribing to one court must share it: a reference-counted
 * registry joins once and leaves when the last listener unsubscribes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { SLOT_CHANNEL_PRIVATE, SLOT_EVENT, slotChangedPayloadSchema, slotTopic } from "../domain/realtime";
import { noteChannelClosed, noteChannelOpened } from "./realtime-budget";

export type RealtimeClient = Pick<SupabaseClient, "channel" | "removeChannel">;
type Channel = ReturnType<RealtimeClient["channel"]>;

export type SlotChannelStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

export interface CourtSlotListener {
  /** Something changed in `range` (null: unknown range): refetch busy slots. */
  onInvalidate(range: { start: string; end: string } | null): void;
  /** (Re)joined: refetch everything, since messages may have been missed. */
  onResync(): void;
  onStatus?(status: SlotChannelStatus, error?: Error): void;
}

export interface SubscribeOptions {
  /** Collapse a burst of messages (e.g. a venue-wide closure) into one refetch. */
  debounceMs?: number;
}

interface ListenerState {
  listener: CourtSlotListener;
  debounceMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** undefined = nothing pending; null = unknown range pending. */
  pending: { start: string; end: string } | null | undefined;
}

interface Entry {
  channel: Channel;
  listeners: Set<ListenerState>;
  subscribed: boolean;
}

const registries = new WeakMap<RealtimeClient, Map<string, Entry>>();

export function subscribeToCourtSlots(
  client: RealtimeClient,
  courtId: string,
  listener: CourtSlotListener,
  opts: SubscribeOptions = {},
): () => void {
  const topic = slotTopic(courtId);
  let registry = registries.get(client);
  if (!registry) {
    registry = new Map();
    registries.set(client, registry);
  }

  const state: ListenerState = {
    listener,
    debounceMs: opts.debounceMs ?? 300,
    timer: undefined,
    pending: undefined,
  };
  let entry = registry.get(topic);
  if (!entry) {
    const created: Entry = {
      channel: client.channel(topic, { config: { private: SLOT_CHANNEL_PRIVATE } }),
      listeners: new Set(),
      subscribed: false,
    };
    created.channel
      .on("broadcast", { event: SLOT_EVENT }, (message: { payload?: unknown }) => {
        const parsed = slotChangedPayloadSchema.safeParse(message.payload);
        const range = parsed.success ? { start: parsed.data.start_time, end: parsed.data.end_time } : null;
        for (const s of created.listeners) schedule(s, range);
      })
      .subscribe((status: SlotChannelStatus, error?: Error) => {
        created.subscribed = status === "SUBSCRIBED";
        for (const s of created.listeners) {
          s.listener.onStatus?.(status, error);
          if (status === "SUBSCRIBED") s.listener.onResync();
        }
      });
    registry.set(topic, created);
    noteChannelOpened(client, topic);
    entry = created;
  } else if (entry.subscribed) {
    // Joined before this listener arrived: it still needs its initial fetch.
    queueMicrotask(() => {
      if (entry!.listeners.has(state)) listener.onResync();
    });
  }
  entry.listeners.add(state);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    clearTimeout(state.timer);
    const current = registry!.get(topic);
    if (!current) return;
    current.listeners.delete(state);
    if (current.listeners.size === 0) {
      registry!.delete(topic);
      noteChannelClosed(client, topic);
      void client.removeChannel(current.channel);
    }
  };
}

function schedule(s: ListenerState, range: { start: string; end: string } | null) {
  s.pending =
    s.pending === undefined
      ? range
      : s.pending === null || range === null
        ? null
        : {
            start: s.pending.start < range.start ? s.pending.start : range.start,
            end: s.pending.end > range.end ? s.pending.end : range.end,
          };
  if (s.timer !== undefined) return;
  s.timer = setTimeout(() => {
    const pending = s.pending;
    s.timer = undefined;
    s.pending = undefined;
    if (pending !== undefined) s.listener.onInvalidate(pending);
  }, s.debounceMs);
}

/** Number of live court topics for a client (diagnostics and tests). */
export function activeCourtTopics(client: RealtimeClient): string[] {
  return [...(registries.get(client)?.keys() ?? [])];
}

let bookingChannelSeq = 0;

/**
 * Status changes of one of the caller's bookings (payment verified, hold
 * expired, venue moved it). Realtime checks the bookings RLS policy, so only
 * people who can see the booking receive it. Treat as a hint and refetch.
 */
export function subscribeToMyBooking(
  client: RealtimeClient,
  bookingId: string,
  onChange: () => void,
  onStatus?: (status: SlotChannelStatus, error?: Error) => void,
): () => void {
  const topic = `booking:${bookingId}:${++bookingChannelSeq}`;
  noteChannelOpened(client, topic);
  const channel = client
    .channel(topic)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "bookings", filter: `id=eq.${bookingId}` },
      () => onChange(),
    )
    .subscribe((status: SlotChannelStatus, error?: Error) => {
      onStatus?.(status, error);
      if (status === "SUBSCRIBED") onChange();
    });
  return () => {
    noteChannelClosed(client, topic);
    void client.removeChannel(channel);
  };
}
