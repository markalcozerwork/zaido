import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeCourtTopics, subscribeToCourtSlots, type RealtimeClient } from "./court-slots";

const COURT = "20000000-0000-4000-a000-000000000001";

/** Mimics supabase-js: channel() returns the SAME object for the same topic. */
function fakeClient() {
  const channels = new Map<string, FakeChannel>();
  const removed: string[] = [];
  class FakeChannel {
    handlers: Array<(m: { payload?: unknown }) => void> = [];
    status?: (s: string, e?: Error) => void;
    subscribeCount = 0;
    constructor(
      readonly topic: string,
      readonly opts: unknown,
    ) {}
    on(type: string, filter: { event: string }, cb: (m: { payload?: unknown }) => void) {
      expect(type).toBe("broadcast");
      expect(filter).toEqual({ event: "slot_changed" });
      this.handlers.push(cb);
      return this;
    }
    subscribe(cb: (s: string, e?: Error) => void) {
      this.subscribeCount++;
      this.status = cb;
      return this;
    }
    emit(payload: unknown) {
      for (const h of this.handlers) h({ payload });
    }
  }
  const client = {
    channel(topic: string, opts: unknown) {
      let c = channels.get(topic);
      if (!c) {
        c = new FakeChannel(topic, opts);
        channels.set(topic, c);
      }
      return c;
    },
    async removeChannel(c: FakeChannel) {
      removed.push(c.topic);
      channels.delete(c.topic);
      return "ok";
    },
  };
  return { client: client as unknown as RealtimeClient, channels, removed };
}

const listener = () => ({ onInvalidate: vi.fn(), onResync: vi.fn(), onStatus: vi.fn() });
const payload = (start: string, end: string) => ({
  court_id: COURT,
  start_time: start,
  end_time: end,
  busy: true,
  held_until: null,
  id: "added-by-realtime",
});

describe("subscribeToCourtSlots", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("joins the private court topic once and resyncs on every (re)join", () => {
    const { client, channels } = fakeClient();
    const l = listener();
    subscribeToCourtSlots(client, COURT, l);
    const ch = channels.get(`court:${COURT}:slots`)!;
    expect(ch.opts).toEqual({ config: { private: true } });
    ch.status!("SUBSCRIBED");
    ch.status!("CHANNEL_ERROR", new Error("socket closed"));
    ch.status!("SUBSCRIBED");
    expect(l.onResync).toHaveBeenCalledTimes(2);
    expect(l.onStatus).toHaveBeenCalledWith("CHANNEL_ERROR", expect.any(Error));
  });

  it("debounces a burst into one invalidation covering the whole burst", () => {
    const { client, channels } = fakeClient();
    const l = listener();
    subscribeToCourtSlots(client, COURT, l, { debounceMs: 300 });
    const ch = channels.get(`court:${COURT}:slots`)!;
    ch.emit(payload("2026-10-19T10:00:00.000Z", "2026-10-19T11:00:00.000Z"));
    ch.emit(payload("2026-10-19T08:00:00.000Z", "2026-10-19T09:00:00.000Z"));
    expect(l.onInvalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(l.onInvalidate).toHaveBeenCalledTimes(1);
    expect(l.onInvalidate).toHaveBeenCalledWith({
      start: "2026-10-19T08:00:00.000Z",
      end: "2026-10-19T11:00:00.000Z",
    });
  });

  it("an unparseable payload still invalidates (unknown range)", () => {
    const { client, channels } = fakeClient();
    const l = listener();
    subscribeToCourtSlots(client, COURT, l, { debounceMs: 0 });
    channels.get(`court:${COURT}:slots`)!.emit({ nonsense: true });
    vi.advanceTimersByTime(0);
    expect(l.onInvalidate).toHaveBeenCalledWith(null);
  });

  it("shares one channel between subscribers and leaves only after the last one", async () => {
    const { client, channels, removed } = fakeClient();
    const a = listener();
    const b = listener();
    const offA = subscribeToCourtSlots(client, COURT, a);
    const ch = channels.get(`court:${COURT}:slots`)!;
    ch.status!("SUBSCRIBED");
    const offB = subscribeToCourtSlots(client, COURT, b);
    expect(ch.subscribeCount).toBe(1);
    expect(ch.handlers).toHaveLength(1);
    // The late subscriber still gets its initial resync.
    await Promise.resolve();
    expect(b.onResync).toHaveBeenCalledTimes(1);

    offA();
    offA(); // idempotent
    expect(removed).toEqual([]);
    ch.emit(payload("2026-10-19T10:00:00.000Z", "2026-10-19T11:00:00.000Z"));
    vi.advanceTimersByTime(300);
    expect(a.onInvalidate).not.toHaveBeenCalled();
    expect(b.onInvalidate).toHaveBeenCalledTimes(1);

    offB();
    expect(removed).toEqual([`court:${COURT}:slots`]);
    expect(activeCourtTopics(client)).toEqual([]);
  });

  it("drops a pending invalidation when the listener unsubscribes", () => {
    const { client, channels } = fakeClient();
    const l = listener();
    const off = subscribeToCourtSlots(client, COURT, l);
    channels
      .get(`court:${COURT}:slots`)!
      .emit(payload("2026-10-19T10:00:00.000Z", "2026-10-19T11:00:00.000Z"));
    off();
    vi.advanceTimersByTime(1000);
    expect(l.onInvalidate).not.toHaveBeenCalled();
  });
});
