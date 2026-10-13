import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../db-client";
import type { PostgrestResponseLike } from "../transport";
import { blockProfile } from "./channels";
import { purgeChatMedia, signChatMedia, type ChatStorage } from "./media";
import { deleteMessage, getMessages, sendMessage, toSendArgs } from "./messages";

type Res = PostgrestResponseLike<unknown>;
const ok = (data: unknown): Res => ({ data, error: null, status: 200 });
const fail = (status: number, code: string, message = "x", hint?: string): Res => ({
  data: null,
  error: { code, message, details: null, hint: hint ?? null },
  status,
});
const network = (): Res => fail(0, "", "TypeError: fetch failed");
const retry = { sleep: async () => {}, random: () => 0, clock: () => 0 };

const CH = "11111111-1111-4111-a111-111111111111";
const ME = "22222222-2222-4222-a222-222222222222";
const KEY = "44444444-4444-4444-a444-444444444444";

/** postgrest-js builder stand-in: every chained call returns itself; awaiting it pops a response. */
function fakeClient(responses: Res[]) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const builder = (): unknown => {
    const b: Record<string, unknown> = {};
    for (const m of [
      "from",
      "update",
      "insert",
      "delete",
      "select",
      "eq",
      "is",
      "order",
      "limit",
      "abortSignal",
      "retry",
      "overrideTypes",
    ]) {
      b[m] = (...args: unknown[]) => {
        calls.push({ op: m, args });
        return b;
      };
    }
    b.then = (resolve: (r: Res) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(responses.shift() ?? network()).then(resolve, reject);
    return b;
  };
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ op: "rpc", args: [fn, args] });
      return builder();
    },
    from: (table: string) => {
      calls.push({ op: "from", args: [table] });
      return builder();
    },
  };
  return { client: client as unknown as DbClient, calls };
}

const row = {
  id: "55555555-5555-4555-a555-555555555555",
  channel_id: CH,
  sender_id: ME,
  client_id: KEY,
  seq: 7,
  rev: 9,
  message_text: "Laro tayo",
  media_url: null,
  media_kind: null,
  media_width: null,
  media_height: null,
  reply_to_id: null,
  edited_at: null,
  deleted_at: null,
  deleted_by: null,
  created_at: "2026-10-13T10:00:00+00:00",
};

describe("sendMessage", () => {
  it("omits absent arguments (never null) and keeps the message key", () => {
    expect(toSendArgs({ channel_id: CH, client_id: KEY, text: "hi" })).toEqual({
      p_channel_id: CH,
      p_client_id: KEY,
      p_text: "hi",
    });
  });

  it("survives a lost response: the retry carries the same key and returns the same message", async () => {
    const { client, calls } = fakeClient([network(), ok(row)]);
    const res = await sendMessage(
      client,
      { channel_id: CH, client_id: KEY, text: " Laro tayo " },
      {
        retry,
        sender: { name: "Ana", avatar_url: null },
      },
    );
    expect(res).toMatchObject({
      ok: true,
      data: { seq: 7, rev: 9, client_id: KEY, sender: { id: ME, name: "Ana" } },
    });
    const rpcs = calls.filter((c) => c.op === "rpc");
    expect(rpcs).toHaveLength(2);
    expect(rpcs[0]!.args).toEqual([
      "send_chat_message",
      { p_channel_id: CH, p_client_id: KEY, p_text: "Laro tayo" },
    ]);
    expect(rpcs[1]!.args).toEqual(rpcs[0]!.args);
  });

  it("maps the database's chat refusals", async () => {
    const { client } = fakeClient([
      fail(
        400,
        "23514",
        "RATE_LIMITED: You're sending messages too quickly. Wait a few seconds and try again.",
        "12",
      ),
    ]);
    expect(await sendMessage(client, { channel_id: CH, client_id: KEY, text: "x" }, { retry })).toMatchObject(
      {
        ok: false,
        error: { code: "RATE_LIMITED", field: "text", meta: { retryAfterSeconds: 12 } },
      },
    );
  });

  it("rejects bad input before calling the database", async () => {
    const { client, calls } = fakeClient([]);
    for (const bad of [
      { channel_id: CH, text: "no key" },
      { channel_id: CH, client_id: KEY, text: " " },
      { channel_id: CH, client_id: KEY, text: "x", seq: 1 },
    ]) {
      expect((await sendMessage(client, bad, { retry })).ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("deleteMessage / getMessages", () => {
  it("a retried delete that already went through counts as done", async () => {
    const { client } = fakeClient([fail(400, "23514", "MESSAGE_DELETED: This message was deleted.")]);
    expect(await deleteMessage(client, { message_id: row.id }, { retry })).toEqual({
      ok: true,
      data: { deleted: true, message: null },
    });
  });

  it("validates the page shape (jsonb comes back untyped)", async () => {
    const { client } = fakeClient([ok({ channel_id: CH, last_seq: "nope" })]);
    expect(await getMessages(client, { channel_id: CH }, { retry })).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN" },
    });
  });
});

describe("blockProfile", () => {
  it("blocking twice is fine", async () => {
    const { client } = fakeClient([
      fail(409, "23505", 'duplicate key value violates unique constraint "profile_blocks_pkey"'),
    ]);
    expect(await blockProfile(client, { profile_id: ME }, { retry })).toEqual({
      ok: true,
      data: { blocked: true },
    });
  });
});

describe("chat media", () => {
  const path = `${CH}/${ME}/${KEY}.jpg`;

  function fakeStorage(
    signed: Array<{ path: string | null; signedUrl: string | null; error: string | null }>,
  ) {
    const removed: string[][] = [];
    const storage: ChatStorage = {
      from: (bucket: string) => {
        expect(bucket).toBe("chat-media");
        return {
          createSignedUrls: vi.fn(async (paths: string[], expiresIn: number) => {
            expect(expiresIn).toBe(300);
            return { data: signed.filter((s) => s.path && paths.includes(s.path)), error: null };
          }),
          remove: vi.fn(async (paths: string[]) => {
            removed.push(paths);
            return { data: [], error: null };
          }),
        };
      },
    };
    return { storage, removed };
  }

  it("signs only well-formed paths; refused ones come back null", async () => {
    const other = `${CH}/${ME}/66666666-6666-4666-a666-666666666666.png`;
    const { storage } = fakeStorage([
      { path, signedUrl: "https://cdn.example/signed", error: null },
      { path: other, signedUrl: null, error: "Object not found" },
    ]);
    const res = await signChatMedia({ storage }, [path, other, "../../etc/passwd"]);
    expect(res).toEqual({
      ok: true,
      data: { [path]: "https://cdn.example/signed", [other]: null, "../../etc/passwd": null },
    });
  });

  it("purge: claim, remove through Storage, then clear the queue", async () => {
    const { storage, removed } = fakeStorage([]);
    const { client, calls } = fakeClient([ok([path]), ok(1)]);
    const res = await purgeChatMedia(Object.assign(client, { storage }), { batch: 10 }, { retry });
    expect(res).toEqual({ ok: true, data: { claimed: 1, removed: 1, failed: 0 } });
    expect(removed).toEqual([[path]]);
    expect(calls.filter((c) => c.op === "rpc").map((c) => c.args)).toEqual([
      ["claim_chat_media_purge", { p_limit: 10 }],
      ["complete_chat_media_purge", { p_paths: [path] }],
    ]);
  });
});
