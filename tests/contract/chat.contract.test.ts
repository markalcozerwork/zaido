/**
 * Chat (Step 4): TypeScript mirrors ↔ the real chat engine.
 *   * CHAT_LIMITS, media types and size ≡ the database's limits
 *   * topic helpers produce exactly the topics the realtime policies accept
 *   * chatMediaPath produces the names the storage policy accepts
 *   * Zod schemas parse what the RPCs and hint triggers actually return
 *   * chatTextSchema trims and counts like the database
 *   * real chat refusals map to their DomainError codes
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CHAT_EVENTS,
  CHAT_LIMITS,
  CHAT_MEDIA_TYPES,
  channelHintSchema,
  chatMediaPath,
  chatTextSchema,
  chatTopic,
  chatTypingTopic,
  inboxEntrySchema,
  inboxHintSchema,
  mapDatabaseError,
  messageHintSchema,
  messagesPageSchema,
  readHintSchema,
  userChatTopic,
} from "../../src/domain";
import { createUser, useContractDb, type Db } from "./harness";

const db = useContractDb();

interface Room {
  ana: string;
  ben: string;
  dan: string;
  club: string;
  dm: string;
}

/** A club chat with Ana and Ben, a DM between them, and Dan outside both. */
async function room(d: Db): Promise<Room> {
  const ana = await createUser(d, "Ana Lim");
  const ben = await createUser(d, "Ben Cruz");
  const dan = await createUser(d, "Dan Stranger");
  const clubId = randomUUID();
  await d.exec(
    `insert into public.clubs (id, name, slug, sport, municipality_code, created_by)
     values ($1, 'Contract Chat Club', $2, 'PICKLEBALL', '9900100000', $3)`,
    [clubId, `contract-chat-${clubId.slice(0, 8)}`, ana],
  );
  await d.exec(`insert into public.club_members (club_id, profile_id) values ($1, $2)`, [clubId, ben]);
  const [c] = await d.exec<{ id: string }>(
    `select id from public.chat_channels where type = 'CLUB' and club_id = $1`,
    [clubId],
  );
  await d.asUser(ana);
  const [dm] = await d.exec<{ id: string }>(`select public.get_or_create_direct_channel($1) as id`, [ben]);
  await d.asAdmin();
  return { ana, ben, dan, club: c!.id, dm: dm!.id };
}

const send = (d: Db, channel: string, text: string | null, extra = "") =>
  d.attempt(
    `select row_to_json(m) as j from public.send_chat_message($1, gen_random_uuid(), $2 ${extra}) m`,
    [channel, text],
  );

describe("limits ≡ the database", () => {
  it("edit window, rate limit, text length, media dimensions, report note", async () => {
    const [r] = await db.exec<Record<string, number>>(
      `select extract(epoch from app.chat_edit_window())::int / 60 as edit,
              app.chat_rate_limit_count() as rate_count,
              extract(epoch from app.chat_rate_limit_window())::int as rate_window`,
    );
    expect(r).toEqual({
      edit: CHAT_LIMITS.editWindowMinutes,
      rate_count: CHAT_LIMITS.rateLimitCount,
      rate_window: CHAT_LIMITS.rateLimitWindowSeconds,
    });
    const checks = await db.exec<{ name: string; def: string }>(
      `select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('chat_messages_text_length', 'chat_messages_media_dimensions', 'chat_reports_note_length')`,
    );
    const def = (n: string) => checks.find((c) => c.name === n)!.def;
    expect(def("chat_messages_text_length")).toContain(`<= ${CHAT_LIMITS.textMax}`);
    expect(def("chat_messages_media_dimensions")).toContain(`${CHAT_LIMITS.mediaDimensionMax}`);
    expect(def("chat_reports_note_length")).toContain(`<= ${CHAT_LIMITS.reportNoteMax}`);
  });

  it("page sizes, snippet length and the inbox id list", async () => {
    const src = async (fn: string) =>
      (await db.exec<{ src: string }>(`select prosrc as src from pg_proc where oid = $1::regproc`, [fn]))[0]!
        .src;
    const messages = await src("public.get_chat_messages");
    expect(messages).toContain(`coalesce(p_limit, ${CHAT_LIMITS.pageDefault}), 1), ${CHAT_LIMITS.pageMax})`);
    expect(messages).toContain(`left(r.message_text, ${CHAT_LIMITS.snippetLength})`);
    const inbox = await src("public.get_chat_inbox");
    expect(inbox).toContain(`coalesce(p_limit, ${CHAT_LIMITS.inboxDefault}), 1), ${CHAT_LIMITS.inboxMax})`);
    expect(inbox).toContain(`left(lm.message_text, ${CHAT_LIMITS.snippetLength})`);
    expect(inbox).toContain(`cardinality(p_channel_ids) > ${CHAT_LIMITS.inboxChannelIdsMax}`);
    const members = await src("public.list_chat_participants");
    expect(members).toContain(
      `coalesce(p_limit, ${CHAT_LIMITS.participantsDefault}), 1), ${CHAT_LIMITS.participantsMax})`,
    );
  });

  it("the chat-media bucket: size limit and MIME types", async () => {
    const [b] = await db.exec<{ size: string; types: string[] }>(
      `select file_size_limit::text as size, allowed_mime_types as types from storage.buckets where id = 'chat-media'`,
    );
    expect(Number(b!.size)).toBe(CHAT_LIMITS.mediaMaxBytes);
    expect([...b!.types].sort()).toEqual(Object.keys(CHAT_MEDIA_TYPES).sort());
  });
});

describe("topics and media names ≡ the policies", () => {
  it("members join chat:<id> and chat:<id>:typing, send only on typing; I join only my user topic", async () => {
    const r = await room(db);
    await db.exec(
      `insert into realtime.messages (topic, extension, payload, event) values ('x', 'broadcast', '{}', 'contract-probe')`,
    );
    const canJoin = async (topic: string) => {
      await db.exec(`select set_config('realtime.topic', $1, true)`, [topic]);
      return (await db.exec(`select 1 from realtime.messages where event = 'contract-probe'`)).length > 0;
    };
    const canSend = async (topic: string) => {
      await db.exec(`select set_config('realtime.topic', $1, true)`, [topic]);
      return (
        await db.probe(
          `insert into realtime.messages (topic, extension, payload, event) values ($1, 'broadcast', '{}', $2)`,
          [topic, CHAT_EVENTS.typing],
        )
      ).ok;
    };
    await db.asUser(r.ben);
    expect(await canJoin(chatTopic(r.club))).toBe(true);
    expect(await canJoin(chatTypingTopic(r.club))).toBe(true);
    expect(await canJoin(userChatTopic(r.ben))).toBe(true);
    expect(await canJoin(userChatTopic(r.ana))).toBe(false);
    expect(await canSend(chatTypingTopic(r.club))).toBe(true);
    expect(await canSend(chatTopic(r.club))).toBe(false);
    await db.asUser(r.dan);
    expect(await canJoin(chatTopic(r.club))).toBe(false);
    await db.asAdmin();
  });

  it("chatMediaPath is the name the upload policy and the send guard accept", async () => {
    const r = await room(db);
    const key = randomUUID();
    const path = chatMediaPath(r.club, r.ana, key, "image/webp");
    await db.asUser(r.ana);
    const upload = await db.attempt(
      `insert into storage.objects (bucket_id, name, owner, metadata) values ('chat-media', $1, $2, '{"mimetype": "image/webp"}')`,
      [path, r.ana],
    );
    expect(upload.ok).toBe(true);
    const sent = await db.attempt(
      `select row_to_json(m) as j from public.send_chat_message($1, $2, null, $3, null, 800, 600) m`,
      [r.club, key, path],
    );
    expect(sent.ok && (sent.rows[0] as { j: { media_kind: string } }).j.media_kind).toBe("IMAGE");
    await db.asAdmin();
  });
});

describe("schemas parse what the database returns", () => {
  it("get_chat_messages and get_chat_inbox", async () => {
    const r = await room(db);
    await db.asUser(r.ana);
    const first = await send(db, r.club, "First!");
    const firstId = first.ok ? (first.rows[0] as { j: { id: string } }).j.id : "";
    await db.asUser(r.ben);
    await db.attempt(`select public.send_chat_message($1, gen_random_uuid(), 'Agreed', null, $2)`, [
      r.club,
      firstId,
    ]);
    // A DM someone opened is theirs until you open it too.
    await db.exec(`select public.get_or_create_direct_channel($1)`, [r.ana]);
    await db.exec(`select public.send_chat_message($1, gen_random_uuid(), 'DM!')`, [r.dm]);
    await db.asUser(r.ana);
    await db.attempt(`update public.chat_messages set deleted_at = now() where id = $1`, [firstId]);

    const [p] = await db.exec<{ page: unknown }>(`select public.get_chat_messages($1) as page`, [r.club]);
    const page = messagesPageSchema.parse(p!.page);
    expect(page.messages.map((m) => m.text)).toEqual([null, "Agreed"]);
    expect(page.messages[1]!.reply_to).toMatchObject({ id: firstId, is_deleted: true, snippet: null });

    // As JSON, the way PostgREST returns it (node-pg would give bigint strings and Dates).
    const inbox = (
      await db.exec<{ j: unknown }>(`select to_jsonb(i) as j from public.get_chat_inbox() i`)
    ).map((row) => inboxEntrySchema.parse(row.j));
    expect(inbox.map((e) => e.channel_type).sort()).toEqual(["CLUB", "DIRECT"]);
    expect(inbox.find((e) => e.channel_type === "DIRECT")).toMatchObject({ unread_count: 1, can_send: true });
    await db.asAdmin();
  });

  it("hint payloads", async () => {
    const r = await room(db);
    const [{ mark }] = (await db.exec<{ mark: string }>(
      `select coalesce(max(id), 0)::text as mark from realtime.messages`,
    )) as [{ mark: string }];
    await db.asUser(r.ana);
    await db.attempt(`select public.send_chat_message($1, gen_random_uuid(), 'Hi Ben')`, [r.dm]);
    await db.asUser(r.ben);
    await db.attempt(`select public.mark_chat_read($1, 1)`, [r.dm]);
    await db.asAdmin();
    await db.exec(`update public.chat_channels set title = 'Renamed' where id = $1`, [r.club]);
    const rows = await db.exec<{ topic: string; event: string; payload: unknown }>(
      `select topic, event, payload from realtime.messages where id > $1::bigint order by id`,
      [mark],
    );
    const parsedBy = {
      message: messageHintSchema,
      read: readHintSchema,
      channel: channelHintSchema,
      inbox: inboxHintSchema,
    };
    const events = new Set<string>();
    for (const row of rows) {
      const schema = parsedBy[row.event as keyof typeof parsedBy];
      expect(schema, row.event).toBeDefined();
      expect(schema.safeParse(row.payload).success, JSON.stringify(row)).toBe(true);
      events.add(`${row.event}@${row.topic.split(":")[0]}`);
    }
    expect([...events].sort()).toEqual(["channel@chat", "inbox@user", "message@chat", "read@chat"]);
  });
});

describe("chatTextSchema ≡ the database's trimming and length", () => {
  it("stores what the schema produces; refuses what it refuses", async () => {
    const r = await room(db);
    await db.asUser(r.ana);
    for (const raw of ["  hello\n", "\t\r\nline one\nline two \n", "🏓".repeat(CHAT_LIMITS.textMax)]) {
      const out = await send(db, r.club, raw);
      expect(out.ok && (out.rows[0] as { j: { message_text: string } }).j.message_text).toBe(
        chatTextSchema.parse(raw),
      );
    }
    const tooLong = "a".repeat(CHAT_LIMITS.textMax + 1);
    expect(chatTextSchema.safeParse(tooLong).success).toBe(false);
    const refused = await send(db, r.club, tooLong);
    expect(!refused.ok && mapDatabaseError(refused)).toMatchObject({
      code: "VALIDATION_FAILED",
      field: "text",
    });
    await db.asAdmin();
  });
});

describe("real chat refusals → DomainError", () => {
  it("outsider, block, key reuse, rate limit", async () => {
    const r = await room(db);
    await db.asUser(r.dan);
    const outsider = await send(db, r.club, "let me in");
    expect(!outsider.ok && mapDatabaseError(outsider)).toMatchObject({ code: "NOT_A_PARTICIPANT" });

    await db.asUser(r.ben);
    await db.exec(`insert into public.profile_blocks (blocked_id) values ($1)`, [r.ana]);
    await db.asUser(r.ana);
    const blocked = await send(db, r.dm, "hello?");
    expect(!blocked.ok && mapDatabaseError(blocked)).toMatchObject({ code: "MESSAGING_UNAVAILABLE" });

    const key = randomUUID();
    await db.attempt(`select public.send_chat_message($1, $2, 'one')`, [r.club, key]);
    const reused = await db.attempt(`select public.send_chat_message($1, $2, 'two')`, [r.club, key]);
    expect(!reused.ok && mapDatabaseError(reused)).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    for (let i = 0; i < CHAT_LIMITS.rateLimitCount; i++) await send(db, r.club, `spam ${i}`);
    const limited = await db.attempt(`select public.send_chat_message($1, gen_random_uuid(), 'one more')`, [
      r.club,
    ]);
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      // pg reports the hint separately; the harness only keeps code/message, so check the code here
      // (the retry-after hint is covered by the SQL suite and the integration tests).
      expect(mapDatabaseError(limited)).toMatchObject({ code: "RATE_LIMITED", field: "text" });
    }
    await db.asAdmin();
  });
});
