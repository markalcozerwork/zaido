/**
 * The chat engine through PostgREST 13 with real JWTs: the server actions as
 * the app calls them, RLS and the database guards deciding.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  blockProfile,
  deleteMessage,
  editMessage,
  getInbox,
  getMessages,
  getUnreadSummary,
  listBlocks,
  listParticipants,
  markRead,
  openDirectChannel,
  reportMessage,
  sendMessage,
  setMuted,
  unblockProfile,
} from "../../src/server/chat";
import { chatMediaPath } from "../../src/domain";
import { clientAs, createUser, ensureLocations, loseResponses, sql, LOC } from "./support";

const retry = { sleep: async () => {}, random: () => 0 };

/** A public club whose chat has `members` (the first is the admin). */
async function clubChat(...members: string[]): Promise<string> {
  await ensureLocations();
  const clubId = randomUUID();
  await sql(
    `insert into public.clubs (id, name, slug, sport, municipality_code, created_by)
     values ($1, $2, $3, 'PICKLEBALL', $4, $5)`,
    [clubId, `Chat Club ${clubId.slice(0, 6)}`, `chat-${clubId.slice(0, 8)}`, LOC.municipality, members[0]],
  );
  for (const m of members.slice(1)) {
    await sql(`insert into public.club_members (club_id, profile_id) values ($1, $2)`, [clubId, m]);
  }
  const [c] = await sql<{ id: string }>(
    `select id from public.chat_channels where type = 'CLUB' and club_id = $1`,
    [clubId],
  );
  return c!.id;
}

const ok = <T>(res: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!res.ok) throw new Error(JSON.stringify(res.error));
  return res.data;
};

describe("club chat end to end", () => {
  it("send → inbox → page → read → edit → catch-up sync → delete", async () => {
    const ana = await createUser("Ana Lim");
    const ben = await createUser("Ben Cruz");
    const channel = await clubChat(ana, ben);
    const asAna = clientAs(ana);
    const asBen = clientAs(ben);

    const first = ok(
      await sendMessage(asAna, { channel_id: channel, client_id: randomUUID(), text: " Game at 6? " }),
    );
    expect(first).toMatchObject({ seq: 1, rev: 1, text: "Game at 6?" });

    const [row] = ok(await getInbox(asBen, { channel_ids: [channel] }));
    expect(row).toMatchObject({ channel_type: "CLUB", unread_count: 1, last_message_snippet: "Game at 6?" });

    const page = ok(await getMessages(asBen, { channel_id: channel }));
    expect(page).toMatchObject({ last_seq: 1, last_rev: 1, has_more: false });
    expect(page.messages[0]!.sender).toMatchObject({ id: ana, name: "Ana Lim" });

    expect(ok(await markRead(asBen, { channel_id: channel, up_to_seq: 1 }))).toMatchObject({
      last_read_seq: 1,
      unread_count: 0,
    });

    ok(await editMessage(asAna, { message_id: first.id, text: "Game at 6:30?" }));
    const sync = ok(await getMessages(asBen, { channel_id: channel, after_rev: page.last_rev }));
    expect(sync.messages.map((m) => [m.text, m.edited_at !== null])).toEqual([["Game at 6:30?", true]]);

    const notMine = await deleteMessage(asBen, { message_id: first.id });
    expect(notMine).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    ok(await deleteMessage(asAna, { message_id: first.id }));
    expect(ok(await deleteMessage(asAna, { message_id: first.id }))).toEqual({
      deleted: true,
      message: null,
    });
    const after = ok(await getMessages(asBen, { channel_id: channel }));
    expect(after.messages[0]).toMatchObject({ text: null, deleted_by_moderator: false });
  });

  it("a send whose response is lost is retried with the same key: one message", async () => {
    const ana = await createUser("Ana Lim");
    const channel = await clubChat(ana);
    const lost = loseResponses((url) => url.includes("/rpc/send_chat_message"));
    const key = randomUUID();
    const res = await sendMessage(
      clientAs(ana, { wrapFetch: lost.wrap }),
      { channel_id: channel, client_id: key, text: "once" },
      { retry },
    );
    expect(res.ok).toBe(true);
    expect(lost.state).toEqual({ lost: 1, calls: 2 });
    const [n] = await sql<{ n: string; last: string }>(
      `select count(*)::text as n, (select last_seq from public.chat_channels where id = $1)::text as last
         from public.chat_messages where channel_id = $1`,
      [channel],
    );
    expect(n).toEqual({ n: "1", last: "1" });
  });

  it("outsiders get nothing; members see roles", async () => {
    const ana = await createUser("Ana Lim");
    const ben = await createUser("Ben Cruz");
    const dan = await createUser("Dan Stranger");
    const channel = await clubChat(ana, ben);
    const asDan = clientAs(dan);
    expect(await getMessages(asDan, { channel_id: channel })).toMatchObject({
      ok: false,
      error: { code: "NOT_A_PARTICIPANT" },
    });
    expect(
      await sendMessage(asDan, { channel_id: channel, client_id: randomUUID(), text: "hi" }),
    ).toMatchObject({
      ok: false,
      error: { code: "NOT_A_PARTICIPANT" },
    });
    expect(ok(await getInbox(asDan, { channel_ids: [channel] }))).toEqual([]);
    const members = ok(await listParticipants(clientAs(ben), { channel_id: channel }));
    expect(members.map((m) => `${m.display_name}:${m.role}`).sort()).toEqual([
      "Ana Lim:ADMIN",
      "Ben Cruz:MEMBER",
    ]);
  });

  it("the rate limit says how long to wait", async () => {
    const fay = await createUser("Fay Fast");
    const channel = await clubChat(fay);
    const asFay = clientAs(fay);
    for (let i = 0; i < 20; i++)
      ok(await sendMessage(asFay, { channel_id: channel, client_id: randomUUID(), text: `m${i}` }));
    const res = await sendMessage(asFay, { channel_id: channel, client_id: randomUUID(), text: "one more" });
    expect(res).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", field: "text" } });
    if (!res.ok) expect(res.error.meta?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("mute leaves the badge; reports are idempotent", async () => {
    const ana = await createUser("Ana Lim");
    const ben = await createUser("Ben Cruz");
    const channel = await clubChat(ana, ben);
    const m = ok(
      await sendMessage(clientAs(ana), {
        channel_id: channel,
        client_id: randomUUID(),
        text: "buy my paddles",
      }),
    );
    const asBen = clientAs(ben);
    expect(ok(await getUnreadSummary(asBen))).toEqual({ unread_messages: 1, unread_channels: 1 });
    ok(await setMuted(asBen, { channel_id: channel, muted: true }));
    expect(ok(await getUnreadSummary(asBen))).toEqual({ unread_messages: 0, unread_channels: 0 });
    expect(
      await setMuted(clientAs(await createUser("Dan")), { channel_id: channel, muted: true }),
    ).toMatchObject({
      ok: false,
      error: { code: "NOT_A_PARTICIPANT" },
    });
    const r1 = ok(
      await reportMessage(asBen, { message_id: m.id, reason: "SPAM", note: "Selling in every chat" }),
    );
    const r2 = ok(await reportMessage(asBen, { message_id: m.id, reason: "SPAM" }));
    expect(r2).toEqual(r1);
  });

  it("photos: named after the message key, uploaded first", async () => {
    const ana = await createUser("Ana Lim");
    const channel = await clubChat(ana);
    const key = randomUUID();
    const path = chatMediaPath(channel, ana, key, "image/jpeg");
    const asAna = clientAs(ana);
    expect(await sendMessage(asAna, { channel_id: channel, client_id: key, media_path: path })).toMatchObject(
      {
        ok: false,
        error: { code: "INVALID_MEDIA" },
      },
    );
    await sql(
      `insert into storage.objects (bucket_id, name, owner, metadata) values ('chat-media', $1, $2, $3)`,
      [path, ana, { mimetype: "image/jpeg" }],
    );
    const sent = ok(
      await sendMessage(asAna, {
        channel_id: channel,
        client_id: key,
        media_path: path,
        media_width: 1080,
        media_height: 1350,
      }),
    );
    expect(sent.media).toEqual({ path, kind: "IMAGE", width: 1080, height: 1350 });
  });
});

describe("direct messages", () => {
  it("opening is private until the first message; then unread, replies and Seen", async () => {
    const ana = await createUser("Ana Lim");
    const ben = await createUser("Ben Cruz");
    const asAna = clientAs(ana);
    const asBen = clientAs(ben);
    const { channel_id: dm } = ok(await openDirectChannel(asAna, { profile_id: ben }));
    expect(ok(await getInbox(asBen))).toEqual([]);
    expect(ok(await getInbox(asAna))).toEqual([]);

    const hello = ok(
      await sendMessage(asAna, { channel_id: dm, client_id: randomUUID(), text: "Laro tayo bukas?" }),
    );
    const [benRow] = ok(await getInbox(asBen));
    expect(benRow).toMatchObject({
      channel_id: dm,
      channel_type: "DIRECT",
      title: "Ana Lim",
      partner_id: ana,
      unread_count: 1,
    });

    ok(await markRead(asBen, { channel_id: dm, up_to_seq: hello.seq }));
    const [anaRow] = ok(await getInbox(asAna));
    expect(anaRow!.partner_last_read_seq).toBe(hello.seq);

    const reply = ok(
      await sendMessage(asBen, {
        channel_id: dm,
        client_id: randomUUID(),
        text: "G!",
        reply_to_id: hello.id,
      }),
    );
    const page = ok(await getMessages(asAna, { channel_id: dm, after_seq: hello.seq }));
    expect(page.messages[0]).toMatchObject({
      id: reply.id,
      reply_to: { id: hello.id, snippet: "Laro tayo bukas?" },
    });
  });

  it("blocks: either side stops the DM; the blocked person isn't told who", async () => {
    const ana = await createUser("Ana Lim");
    const ben = await createUser("Ben Cruz");
    const asAna = clientAs(ana);
    const asBen = clientAs(ben);
    const { channel_id: dm } = ok(await openDirectChannel(asAna, { profile_id: ben }));
    ok(await sendMessage(asAna, { channel_id: dm, client_id: randomUUID(), text: "hi" }));

    ok(await blockProfile(asBen, { profile_id: ana }));
    ok(await blockProfile(asBen, { profile_id: ana }));
    expect(ok(await listBlocks(asBen)).map((b) => [b.profile_id, b.name])).toEqual([[ana, "Ana Lim"]]);
    expect(ok(await listBlocks(asAna))).toEqual([]);

    const blocked = await sendMessage(asAna, { channel_id: dm, client_id: randomUUID(), text: "hello?" });
    expect(blocked).toMatchObject({ ok: false, error: { code: "MESSAGING_UNAVAILABLE" } });
    const [anaRow] = ok(await getInbox(asAna));
    expect(anaRow).toMatchObject({ can_send: false, blocked_by_me: false });
    expect(ok(await openDirectChannel(asAna, { profile_id: ben })).channel_id).toBe(dm);

    ok(await unblockProfile(asBen, { profile_id: ana }));
    expect((await sendMessage(asAna, { channel_id: dm, client_id: randomUUID(), text: "sorry!" })).ok).toBe(
      true,
    );
  });

  it("an expired session asks to sign in again", async () => {
    const ana = await createUser("Ana Lim");
    expect(await getInbox(clientAs(ana, { expired: true }))).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
  });
});
