import { describe, expect, it } from "vitest";
import {
  activeTypers,
  applyLatestPage,
  applyMessageHintToInbox,
  applyOlderPage,
  applyReadToInbox,
  applySyncPage,
  canEditMessage,
  CHAT_MEDIA_PATH_PATTERN,
  chatMediaPath,
  chatTextSchema,
  clearTyping,
  enqueueMessage,
  inboxEntrySchema,
  inboxPreview,
  inboxUnreadTotals,
  initialConversation,
  markSendFailed,
  markSending,
  markSent,
  messagesQuerySchema,
  needsReadUpdate,
  nextToSend,
  noteTyping,
  rankGroupTopics,
  readTarget,
  retryOutboxItem,
  sendMessageSchema,
  shouldSendTyping,
  timeline,
  TYPING,
  unreadLabel,
  upsertInbox,
  type ChatMessage,
  type InboxEntry,
  type MessagesPage,
} from "./chat";
import { mapDatabaseError, type DomainError } from "./errors";

const CH = "11111111-1111-4111-a111-111111111111";
const ME = "22222222-2222-4222-a222-222222222222";
const YOU = "33333333-3333-4333-a333-333333333333";
const KEY = "44444444-4444-4444-a444-444444444444";
const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

const msg = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: id(seq),
  channel_id: CH,
  seq,
  rev: seq,
  client_id: null,
  sender: { id: YOU, name: "You There", avatar_url: null },
  text: `message ${seq}`,
  media: null,
  reply_to: null,
  created_at: "2026-10-13T10:00:00.000Z",
  edited_at: null,
  deleted_at: null,
  deleted_by_moderator: false,
  ...over,
});

const page = (messages: ChatMessage[], over: Partial<MessagesPage> = {}): MessagesPage => ({
  channel_id: CH,
  last_seq: Math.max(0, ...messages.map((m) => m.seq)),
  last_rev: Math.max(0, ...messages.map((m) => m.rev)),
  has_more: false,
  messages,
  ...over,
});

describe("input schemas", () => {
  it("trims like the database and counts characters, not UTF-16 units", () => {
    expect(chatTextSchema.parse(" \n Laro tayo! \t")).toBe("Laro tayo!");
    expect(chatTextSchema.safeParse("🏓".repeat(4000)).success).toBe(true);
    expect(chatTextSchema.safeParse("a".repeat(4001)).success).toBe(false);
    expect(chatTextSchema.safeParse("bad\u0000byte").success).toBe(false);
  });

  it("a message needs text or media, and media named after this message's key", () => {
    expect(sendMessageSchema.safeParse({ channel_id: CH, client_id: KEY, text: "   " }).success).toBe(false);
    const path = chatMediaPath(CH, ME, KEY, "image/jpeg");
    expect(path).toBe(`${CH}/${ME}/${KEY}.jpg`);
    expect(CHAT_MEDIA_PATH_PATTERN.test(path)).toBe(true);
    expect(sendMessageSchema.safeParse({ channel_id: CH, client_id: KEY, media_path: path }).success).toBe(
      true,
    );
    const otherKey = chatMediaPath(CH, ME, id(9), "image/jpeg");
    expect(
      sendMessageSchema.safeParse({ channel_id: CH, client_id: KEY, media_path: otherKey }).success,
    ).toBe(false);
    const otherChat = chatMediaPath(id(8), ME, KEY, "image/jpeg");
    expect(
      sendMessageSchema.safeParse({ channel_id: CH, client_id: KEY, media_path: otherChat }).success,
    ).toBe(false);
    expect(
      sendMessageSchema.safeParse({ channel_id: CH, client_id: KEY, text: "hi", sender_id: ME }).success,
    ).toBe(false);
  });

  it("message pages take one paging mode at a time", () => {
    expect(messagesQuerySchema.safeParse({ channel_id: CH, before_seq: 5 }).success).toBe(true);
    expect(messagesQuerySchema.safeParse({ channel_id: CH, before_seq: 5, after_rev: 2 }).success).toBe(
      false,
    );
    expect(messagesQuerySchema.safeParse({ channel_id: CH, limit: 201 }).success).toBe(false);
  });
});

describe("conversation state", () => {
  it("seeds the sync cursor from the first page only; older pages never move it", () => {
    // Page 1 (latest) at rev 10. Then message 2 is edited (rev 11) before the
    // user scrolls up and loads it at rev 11. The cursor must stay at 10 so a
    // sync still delivers every change after 10 (including others at 11+).
    let s = applyLatestPage(
      initialConversation(CH),
      page([msg(5), msg(6)], { last_seq: 6, last_rev: 10, has_more: true }),
    );
    expect(s.cursor_rev).toBe(10);
    s = applyOlderPage(s, page([msg(2, { rev: 11 }), msg(3)], { last_seq: 7, last_rev: 12, has_more: true }));
    expect(s.cursor_rev).toBe(10);
    expect(s.oldest_seq).toBe(2);
    s = applySyncPage(
      s,
      page([msg(2, { rev: 11, text: "edited" }), msg(7, { rev: 12 })], { last_seq: 7, last_rev: 12 }),
    );
    expect(s.cursor_rev).toBe(12);
    expect(timeline(s).sent.map((m) => m.seq)).toEqual([2, 3, 5, 6, 7]);
  });

  it("a sync page with more to come advances to its last row, a complete one to the snapshot", () => {
    let s = applyLatestPage(initialConversation(CH), page([msg(1)], { last_rev: 1 }));
    s = applySyncPage(s, page([msg(2), msg(3)], { last_seq: 9, last_rev: 9, has_more: true }));
    expect(s.cursor_rev).toBe(3);
    s = applySyncPage(s, page([msg(4)], { last_seq: 9, last_rev: 9 }));
    expect(s.cursor_rev).toBe(9);
    expect(s.tail_seq).toBe(9);
  });

  it("keeps the newer revision of a message whatever order pages arrive in", () => {
    let s = applyLatestPage(initialConversation(CH), page([msg(1, { rev: 5, text: "new" })]));
    s = applyOlderPage(s, page([msg(1, { rev: 1, text: "old" })]));
    expect(s.messages[id(1)]!.text).toBe("new");
  });

  it("reads up to the loaded tail, not past what was shown", () => {
    let s = applyLatestPage(initialConversation(CH), page([msg(1), msg(2)], { last_seq: 3, last_rev: 3 }));
    // seq 3 is a gap (e.g. a client's ON CONFLICT insert): the page ended at the tail.
    expect(readTarget(s)).toBe(3);
    expect(needsReadUpdate(s)).toBe(true);
    s = { ...s, read_marker: 3 };
    expect(needsReadUpdate(s)).toBe(false);
  });
});

describe("outbox", () => {
  const queued = () =>
    enqueueMessage(
      enqueueMessage(initialConversation(CH), {
        client_id: id(101),
        text: "one",
        queued_at: "2026-10-13T10:00:00.000Z",
      }),
      {
        client_id: id(102),
        text: "two",
        queued_at: "2026-10-13T10:00:01.000Z",
      },
    );

  it("sends in order and drops the pending copy when the server row arrives", () => {
    let s = queued();
    expect(nextToSend(s, 0)!.client_id).toBe(id(101));
    s = markSending(s, id(101));
    expect(nextToSend(s, 0)).toBeUndefined(); // one at a time
    s = markSent(s, msg(8, { client_id: id(101), sender: { id: ME, name: "", avatar_url: null } }));
    expect(s.outbox.map((o) => o.client_id)).toEqual([id(102)]);
    expect(timeline(s).sent.map((m) => m.seq)).toEqual([8]);
  });

  it("a rate limit waits the server's retry-after, with the same key", () => {
    const err = mapDatabaseError({
      code: "23514",
      message: "RATE_LIMITED: You're sending messages too quickly. Wait a few seconds and try again.",
      hint: "7",
    });
    expect(err).toMatchObject({ code: "RATE_LIMITED", meta: { retryAfterSeconds: 7 } });
    let s = markSendFailed(markSending(queued(), id(101)), id(101), err, 1_000);
    expect(s.outbox[0]).toMatchObject({ status: "queued", not_before: 8_000, client_id: id(101) });
    expect(nextToSend(s, 7_999)).toBeUndefined();
    expect(nextToSend(s, 8_000)!.client_id).toBe(id(101));
    s = markSendFailed(s, id(101), { code: "RETRYABLE", message: "x", retryable: true }, 0);
    expect(s.outbox[0]!.status).toBe("queued");
  });

  it("a permanent failure stops the queue until the user retries or discards", () => {
    const refused: DomainError = { code: "MESSAGING_UNAVAILABLE", message: "x", retryable: false };
    let s = markSendFailed(markSending(queued(), id(101)), id(101), refused, 0);
    expect(s.outbox[0]!.status).toBe("failed");
    expect(nextToSend(s, 0)).toBeUndefined();
    s = retryOutboxItem(s, id(101));
    expect(nextToSend(s, 0)!.client_id).toBe(id(101));
  });
});

const entry = (over: Partial<InboxEntry> = {}): InboxEntry =>
  inboxEntrySchema.parse({
    channel_id: CH,
    channel_type: "CLUB",
    title: "Kapitolyo Picklers",
    image_url: null,
    club_id: id(50),
    event_id: null,
    event_start_time: null,
    event_status: null,
    partner_id: null,
    partner_last_read_seq: null,
    is_archived: false,
    is_muted: false,
    can_send: true,
    blocked_by_me: false,
    last_seq: 4,
    last_read_seq: 4,
    unread_count: 0,
    activity_at: "2026-10-13T09:00:00+00:00",
    last_message_id: id(4),
    last_message_seq: 4,
    last_message_sender_id: YOU,
    last_message_sender_name: "Ana Lim",
    last_message_snippet: "See you!",
    last_message_media_kind: null,
    last_message_is_deleted: false,
    last_message_created_at: "2026-10-13T09:00:00+00:00",
    ...over,
  });

describe("inbox", () => {
  const hint = (seq: number, sender = YOU) => ({
    channel_id: CH,
    message_id: id(seq),
    seq,
    rev: seq,
    op: "INSERT" as const,
    sender_id: sender,
    created_at: "2026-10-13T10:00:00.000Z",
  });

  it("a message hint updates unread and order at once, and asks for the new preview", () => {
    const other = entry({ channel_id: id(60), activity_at: "2026-10-13T09:30:00+00:00" });
    const r = applyMessageHintToInbox([other, entry()], hint(6), ME);
    expect(r.entries[0]!.channel_id).toBe(CH);
    expect(r.entries[0]).toMatchObject({ last_seq: 6, unread_count: 2 });
    expect(r.refetch).toEqual([CH]);
  });

  it("my own messages don't count as unread", () => {
    const r = applyMessageHintToInbox([entry()], hint(5, ME), ME);
    expect(r.entries[0]).toMatchObject({ last_seq: 5, last_read_seq: 5, unread_count: 0 });
  });

  it("a hint for a chat not on screen asks for that row", () => {
    expect(applyMessageHintToInbox([], hint(1), ME).refetch).toEqual([CH]);
  });

  it("other devices' read markers only move forward", () => {
    const e = entry({ last_seq: 9, last_read_seq: 4, unread_count: 5 });
    expect(applyReadToInbox([e], CH, 7)[0]).toMatchObject({ last_read_seq: 7, unread_count: 2 });
    expect(applyReadToInbox([e], CH, 2)[0]).toMatchObject({ last_read_seq: 4 });
  });

  it("badge totals skip muted and closed chats; live topics go to active, unmuted group chats", () => {
    const rows = [
      entry({ channel_id: id(1), unread_count: 3 }),
      entry({ channel_id: id(2), unread_count: 4, is_muted: true }),
      entry({ channel_id: id(3), unread_count: 5, is_archived: true }),
      entry({ channel_id: id(4), channel_type: "DIRECT", unread_count: 1 }),
    ];
    expect(inboxUnreadTotals(rows)).toEqual({ messages: 4, channels: 2 });
    expect(rankGroupTopics(rows, 20)).toEqual([id(1)]);
  });

  it("archived rows leave the active list when refetched", () => {
    expect(upsertInbox([entry()], [entry({ is_archived: true })])).toEqual([]);
  });

  it("previews", () => {
    expect(inboxPreview(entry(), ME)).toBe("Ana: See you!");
    expect(inboxPreview(entry({ last_message_sender_id: ME }), ME)).toBe("You: See you!");
    expect(inboxPreview(entry({ last_message_is_deleted: true }), ME)).toBe("Message deleted");
    expect(inboxPreview(entry({ last_message_snippet: null, last_message_media_kind: "IMAGE" }), ME)).toBe(
      "Ana: Photo",
    );
    expect(unreadLabel(0)).toBe("");
    expect(unreadLabel(120)).toBe("99+");
  });
});

describe("typing", () => {
  const allowed = new Set([YOU]);

  it("shows known participants for a few seconds, never myself or strangers", () => {
    let t = noteTyping({}, { profile_id: YOU }, 1_000, allowed, ME);
    t = noteTyping(t, { profile_id: ME }, 1_000, new Set([ME, YOU]), ME);
    t = noteTyping(t, { profile_id: id(77) }, 1_000, allowed, ME);
    t = noteTyping(t, { profile_id: "not-a-uuid" }, 1_000, allowed, ME);
    t = noteTyping(t, { profile_id: YOU, filler: "x".repeat(TYPING.maxPayloadBytes) }, 1_500, allowed, ME);
    expect(activeTypers(t, 1_000 + TYPING.expireAfterMs - 1)).toEqual([YOU]);
    expect(activeTypers(t, 1_000 + TYPING.expireAfterMs)).toEqual([]);
    expect(clearTyping(t, YOU)).toEqual({});
  });

  it("throttles outgoing typing events", () => {
    expect(shouldSendTyping(undefined, 0)).toBe(true);
    expect(shouldSendTyping(0, TYPING.sendEveryMs - 1)).toBe(false);
    expect(shouldSendTyping(0, TYPING.sendEveryMs)).toBe(true);
  });
});

describe("edit window", () => {
  it("only my own, undeleted text messages within 15 minutes", () => {
    const mine = msg(1, { sender: { id: ME, name: "", avatar_url: null } });
    const sent = new Date(mine.created_at).getTime();
    expect(canEditMessage(mine, ME, new Date(sent + 15 * 60_000))).toBe(true);
    expect(canEditMessage(mine, ME, new Date(sent + 15 * 60_000 + 1))).toBe(false);
    expect(canEditMessage(msg(1), ME, new Date(sent))).toBe(false);
    expect(canEditMessage({ ...mine, deleted_at: mine.created_at }, ME, new Date(sent))).toBe(false);
  });
});

describe("review fixes: conversation state", () => {
  const quoting = (seq: number, quoted: ChatMessage) =>
    msg(seq, {
      reply_to: {
        id: quoted.id,
        seq: quoted.seq,
        sender_id: YOU,
        sender_name: "You There",
        snippet: quoted.text,
        media_kind: null,
        is_deleted: false,
      },
    });

  it("a moderated or edited message no longer lives on in the quotes of replies", () => {
    const abusive = msg(1, { text: "ABUSIVE" });
    let s = applyLatestPage(initialConversation(CH), page([abusive, quoting(2, abusive)]));
    s = applySyncPage(
      s,
      page([{ ...abusive, rev: 3, text: null, deleted_at: "2026-10-13T10:01:00.000Z" }], { last_rev: 3 }),
    );
    expect(s.messages[id(2)]!.reply_to).toMatchObject({ snippet: null, is_deleted: true });
    s = applySyncPage(s, page([msg(4, { rev: 4 })], { last_seq: 4, last_rev: 4 }));
    const edited = msg(5, { rev: 5, text: "first version" });
    s = applySyncPage(s, page([edited, quoting(6, edited)], { last_seq: 6, last_rev: 6 }));
    s = applySyncPage(s, page([{ ...edited, rev: 7, text: "x".repeat(200) }], { last_seq: 6, last_rev: 7 }));
    expect(s.messages[id(6)]!.reply_to!.snippet).toBe("x".repeat(140));
  });

  it("a send result never replaces the synced copy at the same rev (it has no quote or name)", () => {
    const full = msg(3, { client_id: id(900), sender: { id: ME, name: "Ana Lim", avatar_url: null } });
    let s = applySyncPage(
      applyLatestPage(initialConversation(CH), page([])),
      page([full], { last_seq: 3, last_rev: 3 }),
    );
    s = markSent(s, { ...full, sender: { id: ME, name: "", avatar_url: null } });
    expect(s.messages[full.id]!.sender!.name).toBe("Ana Lim");
  });

  it("changes to messages above the loaded history aren't shown out of place, but still move the cursor", () => {
    let s = applyLatestPage(
      initialConversation(CH),
      page([msg(251), msg(252)], { last_seq: 252, last_rev: 300, has_more: true }),
    );
    s = applySyncPage(
      s,
      page([msg(3, { rev: 301, deleted_at: "2026-10-13T10:00:00.000Z" })], { last_seq: 252, last_rev: 301 }),
    );
    expect(s.messages[id(3)]).toBeUndefined();
    expect(s.cursor_rev).toBe(301);
  });

  it("report notes count characters like the database", async () => {
    const { reportMessageSchema } = await import("./chat");
    const base = { message_id: id(1), reason: "HARASSMENT" };
    expect(reportMessageSchema.safeParse({ ...base, note: "😡".repeat(300) }).success).toBe(true);
    expect(reportMessageSchema.safeParse({ ...base, note: "a".repeat(501) }).success).toBe(false);
  });
});

describe("review fixes: inbox merge", () => {
  it("fetched rows never move counters backwards", async () => {
    const { mergeInboxEntry, behindLocal } = await import("./chat");
    const local = entry({
      last_seq: 9,
      last_read_seq: 9,
      unread_count: 0,
      activity_at: "2026-10-13T10:00:00.000Z",
    });
    const stale = entry({ last_seq: 8, last_read_seq: 5, unread_count: 3 });
    expect(mergeInboxEntry(local, stale)).toMatchObject({ last_seq: 9, last_read_seq: 9, unread_count: 0 });
    expect(behindLocal([local], [stale])).toEqual([CH]);
  });
});
