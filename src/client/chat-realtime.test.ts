import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatTopic, chatTypingTopic, TYPING, userChatTopic } from "../domain/chat";
import { activeChatTopics, joinTyping, subscribeToConversation, subscribeToInbox } from "./chat-realtime";
import { subscribeToCourtSlots, type RealtimeClient } from "./court-slots";
import { channelsInUse, REALTIME_BUDGET } from "./realtime-budget";

const CH = "11111111-1111-4111-a111-111111111111";
const ME = "22222222-2222-4222-a222-222222222222";
const YOU = "33333333-3333-4333-a333-333333333333";
const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

/** Mimics supabase-js: one channel object per topic, broadcast bindings filtered by event ("*" = all). */
function fakeClient() {
  const channels = new Map<string, FakeChannel>();
  const removed: string[] = [];
  class FakeChannel {
    bindings: Array<{ event: string; cb: (m: { event: string; payload?: unknown }) => void }> = [];
    status?: (s: string, e?: Error) => void;
    sent: Array<{ event: string; payload: unknown }> = [];
    constructor(
      readonly topic: string,
      readonly opts: unknown,
    ) {}
    on(type: string, filter: { event: string }, cb: (m: { event: string; payload?: unknown }) => void) {
      expect(type).toBe("broadcast");
      this.bindings.push({ event: filter.event, cb });
      return this;
    }
    subscribe(cb: (s: string, e?: Error) => void) {
      this.status = cb;
      return this;
    }
    send(m: { type: string; event: string; payload: unknown }) {
      this.sent.push({ event: m.event, payload: m.payload });
      return Promise.resolve("ok");
    }
    emit(event: string, payload: unknown) {
      for (const b of this.bindings) if (b.event === "*" || b.event === event) b.cb({ event, payload });
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

const messageHint = (seq: number, channel = CH) => ({
  channel_id: channel,
  message_id: id(seq),
  seq,
  rev: seq,
  op: "INSERT",
  sender_id: YOU,
  created_at: "2026-10-13T10:00:00+00:00",
  id: "added-by-realtime",
});

describe("subscribeToConversation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("joins the private topic, batches message hints, resyncs on every (re)join", () => {
    const { client, channels } = fakeClient();
    const l = { onMessages: vi.fn(), onRead: vi.fn(), onChannel: vi.fn(), onResync: vi.fn() };
    const stop = subscribeToConversation(client, CH, l);
    const ch = channels.get(chatTopic(CH))!;
    expect(ch.opts).toEqual({ config: { private: true } });
    ch.status!("SUBSCRIBED");
    ch.emit("message", messageHint(1));
    ch.emit("message", messageHint(2));
    ch.emit("message", { junk: true });
    ch.emit("read", { channel_id: CH, profile_id: YOU, last_read_seq: 2 });
    ch.emit("channel", { channel_id: CH, reason: "archived" });
    vi.advanceTimersByTime(150);
    expect(l.onMessages).toHaveBeenCalledTimes(1);
    expect(l.onMessages.mock.calls[0]![0].map((h: { seq: number }) => h.seq)).toEqual([1, 2]);
    expect(l.onRead).toHaveBeenCalledWith(expect.objectContaining({ last_read_seq: 2 }));
    expect(l.onChannel).toHaveBeenCalledWith(expect.objectContaining({ reason: "archived" }));
    ch.status!("CHANNEL_ERROR", new Error("socket closed"));
    ch.status!("SUBSCRIBED");
    expect(l.onResync).toHaveBeenCalledTimes(2);
    stop();
    expect(activeChatTopics(client)).toEqual([]);
  });

  it("shares one channel with the inbox; it leaves only when both are done", async () => {
    const { client, channels, removed } = fakeClient();
    const conv = { onMessages: vi.fn(), onResync: vi.fn() };
    const stopConv = subscribeToConversation(client, CH, conv);
    const inbox = { onMessage: vi.fn(), onInbox: vi.fn(), onChannel: vi.fn(), onResync: vi.fn() };
    const sub = subscribeToInbox(client, ME, inbox);
    sub.setGroupChannels([CH]);
    const ch = channels.get(chatTopic(CH))!;
    ch.status!("SUBSCRIBED");
    ch.emit("message", messageHint(3));
    expect(inbox.onMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(150);
    expect(conv.onMessages).toHaveBeenCalledTimes(1);
    stopConv();
    expect(removed).not.toContain(chatTopic(CH));
    sub.stop();
    expect(removed).toContain(chatTopic(CH));
  });
});

describe("subscribeToInbox", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("DM messages arrive on my user topic; joins/leaves/reads as inbox hints", () => {
    const { client, channels } = fakeClient();
    const l = { onMessage: vi.fn(), onInbox: vi.fn(), onChannel: vi.fn(), onResync: vi.fn() };
    subscribeToInbox(client, ME, l);
    const user = channels.get(userChatTopic(ME))!;
    user.status!("SUBSCRIBED");
    expect(l.onResync).toHaveBeenCalledTimes(1);
    user.emit("inbox", { ...messageHint(4), reason: "message" });
    user.emit("inbox", { channel_id: CH, reason: "left" });
    user.emit("inbox", { channel_id: CH, reason: "read", last_read_seq: 4, is_muted: false });
    expect(l.onMessage).toHaveBeenCalledWith(expect.objectContaining({ seq: 4 }));
    expect(l.onInbox.mock.calls.map((c) => c[0].reason)).toEqual(["left", "read"]);
  });

  it("joins at most N group topics, a few at a time, and follows the ranking", () => {
    const { client } = fakeClient();
    const l = { onMessage: vi.fn(), onInbox: vi.fn(), onChannel: vi.fn(), onResync: vi.fn() };
    const sub = subscribeToInbox(client, ME, l, { maxGroupTopics: 8, joinBatch: 3, joinIntervalMs: 100 });
    const ranked = Array.from({ length: 12 }, (_, i) => id(i + 1));
    sub.setGroupChannels(ranked);
    expect(sub.liveGroupChannels()).toHaveLength(3);
    vi.advanceTimersByTime(100);
    expect(sub.liveGroupChannels()).toHaveLength(6);
    vi.advanceTimersByTime(100);
    expect(sub.liveGroupChannels()).toEqual(ranked.slice(0, 8));
    sub.setGroupChannels(ranked.slice(4));
    vi.advanceTimersByTime(500);
    expect(sub.liveGroupChannels().sort()).toEqual(ranked.slice(4, 12).sort());
  });

  it("drops a refused group topic instead of letting it retry forever", () => {
    const { client, channels } = fakeClient();
    const l = {
      onMessage: vi.fn(),
      onInbox: vi.fn(),
      onChannel: vi.fn(),
      onResync: vi.fn(),
      onTopicLost: vi.fn(),
    };
    const sub = subscribeToInbox(client, ME, l);
    sub.setGroupChannels([CH]);
    channels.get(chatTopic(CH))!.status!("CHANNEL_ERROR", new Error("Unauthorized"));
    expect(sub.liveGroupChannels()).toEqual([]);
    expect(l.onTopicLost).toHaveBeenCalledWith(CH);
  });

  it("shares the per-connection channel budget with court grids", () => {
    const { client } = fakeClient();
    const room = REALTIME_BUDGET.maxChannels - REALTIME_BUDGET.reserve;
    const courts = Array.from({ length: room - 5 }, (_, i) =>
      subscribeToCourtSlots(client, id(1000 + i), { onInvalidate: vi.fn(), onResync: vi.fn() }),
    );
    const l = { onMessage: vi.fn(), onInbox: vi.fn(), onChannel: vi.fn(), onResync: vi.fn() };
    const sub = subscribeToInbox(client, ME, l, { joinBatch: 50 });
    sub.setGroupChannels(Array.from({ length: 20 }, (_, i) => id(i + 1)));
    // The user topic took one slot: 4 left for group chats.
    expect(sub.liveGroupChannels()).toHaveLength(4);
    expect(channelsInUse(client)).toBe(room);
    for (const stop of courts) stop();
    sub.setGroupChannels(Array.from({ length: 20 }, (_, i) => id(i + 1)));
    expect(sub.liveGroupChannels()).toHaveLength(20);
  });
});

describe("joinTyping", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends at most one typing event per interval, only once joined", () => {
    const { client, channels } = fakeClient();
    let now = 0;
    const t = joinTyping(client, CH, ME, {
      allowed: () => new Set([YOU]),
      onChange: vi.fn(),
      now: () => now,
    });
    const ch = channels.get(chatTypingTopic(CH))!;
    t.notifyTyping();
    expect(ch.sent).toHaveLength(0);
    ch.status!("SUBSCRIBED");
    t.notifyTyping();
    now = 1_000;
    t.notifyTyping();
    now = TYPING.sendEveryMs;
    t.notifyTyping();
    expect(ch.sent).toEqual([
      { event: "typing", payload: { profile_id: ME } },
      { event: "typing", payload: { profile_id: ME } },
    ]);
  });

  it("shows who is typing and hides them when they stop or their message lands", () => {
    const { client, channels } = fakeClient();
    const onChange = vi.fn();
    const t = joinTyping(client, CH, ME, { allowed: () => new Set([YOU]), onChange, now: () => Date.now() });
    const ch = channels.get(chatTypingTopic(CH))!;
    ch.emit("typing", { profile_id: YOU });
    ch.emit("typing", { profile_id: id(99) }); // not a participant: ignored
    expect(onChange).toHaveBeenLastCalledWith([YOU]);
    vi.advanceTimersByTime(TYPING.expireAfterMs + 5);
    expect(onChange).toHaveBeenLastCalledWith([]);
    ch.emit("typing", { profile_id: YOU });
    t.clear(YOU);
    expect(onChange).toHaveBeenLastCalledWith([]);
    t.stop();
  });
});
