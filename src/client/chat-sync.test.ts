import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inboxEntrySchema,
  type ActionResult,
  type ChatMessage,
  type InboxEntry,
  type InboxQuery,
  type MessagesPage,
  type MessagesQuery,
  type SendMessageInput,
} from "../domain";
import { ConversationSync, InboxSync, memoryOutboxStore } from "./chat-sync";

const CH = "11111111-1111-4111-a111-111111111111";
const ME = "22222222-2222-4222-a222-222222222222";
const YOU = "33333333-3333-4333-a333-333333333333";
const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

const msg = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: id(seq),
  channel_id: CH,
  seq,
  rev: seq,
  client_id: null,
  sender: { id: YOU, name: "You There", avatar_url: null },
  text: `m${seq}`,
  media: null,
  reply_to: null,
  created_at: "2026-10-13T10:00:00.000Z",
  edited_at: null,
  deleted_at: null,
  deleted_by_moderator: false,
  ...over,
});

/** A tiny server: a channel's messages with seq/rev counters, like the database. */
function fakeServer() {
  const messages: ChatMessage[] = [];
  let lastSeq = 0;
  let lastRev = 0;
  const sends: SendMessageInput[] = [];
  const reads: number[] = [];
  let sendResult: ((input: SendMessageInput) => ActionResult<ChatMessage> | null) | null = null;

  const add = (text: string, sender = YOU, clientId: string | null = null) => {
    const m = msg(++lastSeq, {
      rev: ++lastRev,
      text,
      client_id: clientId,
      sender: { id: sender, name: "", avatar_url: null },
    });
    messages.push(m);
    return m;
  };
  const edit = (seq: number, text: string) => {
    const i = messages.findIndex((m) => m.seq === seq);
    messages[i] = { ...messages[i]!, text, rev: ++lastRev, edited_at: "2026-10-13T10:05:00.000Z" };
  };
  const pageOf = (rows: ChatMessage[], hasMore: boolean): MessagesPage => ({
    channel_id: CH,
    last_seq: lastSeq,
    last_rev: lastRev,
    has_more: hasMore,
    messages: rows,
  });
  const api = {
    getMessages: vi.fn(async (q: MessagesQuery): Promise<ActionResult<MessagesPage>> => {
      const limit = q.limit ?? 50;
      let rows: ChatMessage[];
      if (q.after_rev !== undefined)
        rows = messages.filter((m) => m.rev > q.after_rev!).sort((a, b) => a.rev - b.rev);
      else if (q.before_seq !== undefined)
        rows = messages.filter((m) => m.seq < q.before_seq!).sort((a, b) => b.seq - a.seq);
      else rows = [...messages].sort((a, b) => b.seq - a.seq);
      const out = rows.slice(0, limit);
      if (q.after_rev === undefined) out.reverse();
      return { ok: true, data: pageOf(out, rows.length > limit) };
    }),
    sendMessage: vi.fn(async (input: SendMessageInput): Promise<ActionResult<ChatMessage>> => {
      sends.push(input);
      const forced = sendResult?.(input);
      if (forced) return forced;
      const existing = messages.find((m) => m.client_id === input.client_id);
      return { ok: true, data: existing ?? add(input.text ?? "", ME, input.client_id) };
    }),
    markRead: vi.fn(async (input: { channel_id: string; up_to_seq: number }) => {
      reads.push(input.up_to_seq);
      return { ok: true as const, data: { last_read_seq: Math.min(input.up_to_seq, lastSeq) } };
    }),
  };
  return {
    api,
    add,
    edit,
    sends,
    reads,
    failSendsWith(f: (input: SendMessageInput) => ActionResult<ChatMessage> | null) {
      sendResult = f;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("ConversationSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loads the latest page, then catches up by rev: new messages, edits and deletes", async () => {
    const server = fakeServer();
    for (let i = 1; i <= 3; i++) server.add(`hello ${i}`);
    const sync = new ConversationSync(server.api, CH, { onChange: vi.fn(), safetySyncMs: 0 });
    await sync.start();
    server.add("new one");
    server.edit(1, "hello 1 (edited)");
    await sync.sync();
    const texts = Object.values(sync.state.messages)
      .sort((a, b) => a.seq - b.seq)
      .map((m) => m.text);
    expect(texts).toEqual(["hello 1 (edited)", "hello 2", "hello 3", "new one"]);
    expect(sync.state.cursor_rev).toBe(5);
  });

  it("an edit that lands between loading two history pages is still caught", async () => {
    const server = fakeServer();
    for (let i = 1; i <= 6; i++) server.add(`m${i}`);
    const sync = new ConversationSync(server.api, CH, { onChange: vi.fn(), safetySyncMs: 0, pageSize: 3 });
    await sync.start(); // m4..m6, cursor = rev 6
    server.edit(5, "m5 edited"); // rev 7, on the page already loaded
    await sync.loadOlder(); // m1..m3 fetched now (snapshot rev 7)
    expect(sync.state.cursor_rev).toBe(6);
    await sync.sync();
    expect(sync.state.messages[id(5)]!.text).toBe("m5 edited");
  });

  it("concurrent sync requests collapse into at most one more run", async () => {
    const server = fakeServer();
    server.add("a");
    const sync = new ConversationSync(server.api, CH, { onChange: vi.fn(), safetySyncMs: 0 });
    await sync.start();
    server.api.getMessages.mockClear();
    await Promise.all([sync.sync(), sync.sync(), sync.sync(), sync.sync()]);
    expect(server.api.getMessages.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("sends in order; the pending copy becomes the server message", async () => {
    const server = fakeServer();
    const sync = new ConversationSync(server.api, CH, {
      onChange: vi.fn(),
      safetySyncMs: 0,
      newClientId: (() => {
        let n = 500;
        return () => id(++n);
      })(),
    });
    await sync.start();
    sync.send({ text: "first" });
    sync.send({ text: "second" });
    await flush();
    await sync.pump();
    expect(server.sends.map((s) => s.text)).toEqual(["first", "second"]);
    expect(sync.state.outbox).toEqual([]);
    expect(Object.values(sync.state.messages).map((m) => m.client_id)).toEqual([id(501), id(502)]);
  });

  it("a rate limit pauses the queue until retry-after, then resends with the same key", async () => {
    const server = fakeServer();
    let limited = true;
    server.failSendsWith(() =>
      limited
        ? {
            ok: false,
            error: {
              code: "RATE_LIMITED",
              message: "slow down",
              retryable: false,
              meta: { retryAfterSeconds: 5 },
            },
          }
        : null,
    );
    const sync = new ConversationSync(server.api, CH, {
      onChange: vi.fn(),
      safetySyncMs: 0,
      now: () => Date.now(),
    });
    await sync.start();
    const key = sync.send({ text: "hi" });
    await flush();
    expect(sync.state.outbox[0]).toMatchObject({ client_id: key, status: "queued" });
    limited = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(server.sends.map((s) => s.client_id)).toEqual([key, key]);
    expect(sync.state.outbox).toEqual([]);
  });

  it("restores unsent messages after a restart and replays them with their keys", async () => {
    const store = memoryOutboxStore();
    await store.save(CH, [
      {
        client_id: id(900),
        channel_id: CH,
        text: "from before",
        queued_at: "2026-10-13T09:59:00.000Z",
        status: "sending",
        attempts: 1,
      },
    ]);
    const server = fakeServer();
    const sync = new ConversationSync(server.api, CH, { onChange: vi.fn(), safetySyncMs: 0, store });
    await sync.start();
    await flush();
    expect(server.sends.map((s) => s.client_id)).toEqual([id(900)]);
    expect(await store.load(CH)).toEqual([]);
  });

  it("marks read only while visible, up to what was loaded", async () => {
    const server = fakeServer();
    server.add("a");
    server.add("b");
    const sync = new ConversationSync(server.api, CH, {
      onChange: vi.fn(),
      safetySyncMs: 0,
      readDebounceMs: 100,
    });
    await sync.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(server.reads).toEqual([]);
    sync.setVisible(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(server.reads).toEqual([2]);
    expect(sync.state.read_marker).toBe(2);
  });

  it("far behind: falls back to the latest page instead of replaying everything", async () => {
    const server = fakeServer();
    server.add("a");
    const sync = new ConversationSync(server.api, CH, {
      onChange: vi.fn(),
      safetySyncMs: 0,
      maxSyncPages: 2,
    });
    await sync.start();
    for (let i = 0; i < 500; i++) server.add(`x${i}`);
    await sync.sync();
    expect(sync.state.cursor_rev).toBe(501);
    expect(sync.state.messages[id(501)]).toBeDefined();
  });
});

const entry = (n: number, over: Partial<InboxEntry> = {}): InboxEntry =>
  inboxEntrySchema.parse({
    channel_id: id(n),
    channel_type: "CLUB",
    title: `Club ${n}`,
    image_url: null,
    club_id: id(1000 + n),
    event_id: null,
    event_start_time: null,
    event_status: null,
    partner_id: null,
    partner_last_read_seq: null,
    is_archived: false,
    is_muted: false,
    can_send: true,
    blocked_by_me: false,
    last_seq: 5,
    last_read_seq: 5,
    unread_count: 0,
    activity_at: `2026-10-13T09:${String(n).padStart(2, "0")}:00.000Z`,
    last_message_id: id(5),
    last_message_seq: 5,
    last_message_sender_id: YOU,
    last_message_sender_name: "Ana",
    last_message_snippet: "hi",
    last_message_media_kind: null,
    last_message_is_deleted: false,
    last_message_created_at: "2026-10-13T09:00:00.000Z",
    ...over,
  });

describe("InboxSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(rows: InboxEntry[]) {
    const calls: InboxQuery[] = [];
    let data = rows;
    const api = {
      getInbox: vi.fn(async (q: InboxQuery): Promise<ActionResult<InboxEntry[]>> => {
        calls.push(q);
        if (q.channel_ids)
          return { ok: true, data: data.filter((e) => q.channel_ids!.includes(e.channel_id)) };
        return { ok: true, data };
      }),
    };
    const topics = vi.fn();
    const sync = new InboxSync(api, {
      me: ME,
      onChange: vi.fn(),
      onGroupTopics: topics,
      pollMs: 0,
      refetchDelayMs: 1_000,
      refetchJitterMs: 2_000,
      random: () => 0.5,
    });
    return { sync, calls, topics, setData: (d: InboxEntry[]) => (data = d) };
  }

  it("refresh ranks the group chats to keep live", async () => {
    const { sync, topics } = setup([entry(1), entry(2), entry(3, { is_muted: true })]);
    await sync.refresh();
    expect(topics).toHaveBeenCalledWith([id(2), id(1)]);
  });

  it("a burst of message hints: counters move at once, previews refetch once, narrowly", async () => {
    const { sync, calls, setData } = setup([entry(1), entry(2)]);
    await sync.refresh();
    calls.length = 0;
    for (const seq of [6, 7, 8]) {
      sync.onMessage({
        channel_id: id(1),
        message_id: id(seq),
        seq,
        rev: seq,
        op: "INSERT",
        sender_id: YOU,
        created_at: "2026-10-13T10:00:00.000Z",
      });
    }
    expect(sync.entries[0]).toMatchObject({ channel_id: id(1), unread_count: 3 });
    setData([
      entry(1, {
        last_seq: 8,
        unread_count: 3,
        last_message_snippet: "latest",
        activity_at: "2026-10-13T10:00:00.000Z",
      }),
      entry(2),
    ]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toEqual([{ channel_ids: [id(1)] }]);
    expect(sync.entries[0]!.last_message_snippet).toBe("latest");
  });

  it("left and deleted chats disappear; a chat missing from a narrow refetch is dropped", async () => {
    const { sync, setData } = setup([entry(1), entry(2), entry(3)]);
    await sync.refresh();
    sync.onInbox({ channel_id: id(1), reason: "left" });
    sync.onChannel({ channel_id: id(2), reason: "deleted" });
    expect(sync.entries.map((e) => e.channel_id)).toEqual([id(3)]);
    setData([]);
    sync.onChannel({ channel_id: id(3), reason: "updated" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sync.entries).toEqual([]);
  });

  it("nothing is fetched while the inbox is hidden; stale rows refresh when it shows", async () => {
    const { sync, calls } = setup([entry(1)]);
    await sync.refresh();
    calls.length = 0;
    sync.setVisible(false);
    sync.onInbox({ channel_id: id(1), reason: "muted" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([]);
    sync.setVisible(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual([{ channel_ids: [id(1)] }]);
  });
});
