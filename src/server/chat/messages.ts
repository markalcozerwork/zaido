/**
 * Messages: send (idempotent), edit, delete, pages and catch-up sync, read
 * markers, reports. Every call goes through RLS as the signed-in user; the
 * database guards decide who may do what.
 */
import {
  chatMessageSchema,
  deleteMessageSchema,
  editMessageSchema,
  markReadSchema,
  messagesPageSchema,
  messagesQuerySchema,
  reportMessageSchema,
  sendMessageSchema,
  validate,
  type ActionResult,
  type ChatMessage,
  type DomainError,
  type MessagesPage,
  type SendMessageInput,
} from "../../domain";
import type { Row, RpcArgs } from "../../db";
import { compact } from "../../domain/object";
import type { DbClient } from "../db-client";
import type { ServerDeps } from "../deps";
import { callWithRetry } from "../transport";

export type ChatMessageRow = Row<"chat_messages">;

/** Who sent a message, for messages this caller just wrote (the row has only the id). */
export interface SenderInfo {
  name: string;
  avatar_url: string | null;
}

/**
 * A chat_messages row as a ChatMessage. Sender details and the reply preview
 * come from the next page or sync, which replaces this entry (same or newer rev).
 */
export function rowToChatMessage(row: ChatMessageRow, sender?: SenderInfo): ChatMessage {
  return chatMessageSchema.parse({
    id: row.id,
    channel_id: row.channel_id,
    seq: row.seq,
    rev: row.rev,
    client_id: row.client_id,
    sender: row.sender_id
      ? { id: row.sender_id, name: sender?.name ?? "", avatar_url: sender?.avatar_url ?? null }
      : null,
    text: row.message_text,
    media:
      row.media_url && row.media_kind
        ? { path: row.media_url, kind: row.media_kind, width: row.media_width, height: row.media_height }
        : null,
    reply_to: null,
    created_at: row.created_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
    deleted_by_moderator: row.deleted_at !== null && row.deleted_by !== row.sender_id,
  });
}

export function toSendArgs(m: SendMessageInput): RpcArgs<"send_chat_message"> {
  // Omitted (not null) arguments take the function's defaults.
  return compact({
    p_channel_id: m.channel_id,
    p_client_id: m.client_id,
    p_text: m.text === "" ? undefined : m.text,
    p_media_path: m.media_path,
    p_reply_to_id: m.reply_to_id,
    p_media_width: m.media_width,
    p_media_height: m.media_height,
  });
}

/**
 * Send a message. Safe to retry with the same client_id (lost responses on
 * mobile data are retried here; the outbox retries later ones): the database
 * returns the message the first attempt created.
 */
export async function sendMessage(
  client: DbClient,
  input: unknown,
  deps: ServerDeps & { sender?: SenderInfo } = {},
): Promise<ActionResult<ChatMessage>> {
  const v = validate(sendMessageSchema, input);
  if (!v.ok) return v;
  const res = await callWithRetry<ChatMessageRow>(
    (signal) => client.rpc("send_chat_message", toSendArgs(v.data)).abortSignal(signal).retry(false),
    deps.retry,
  );
  if (!res.ok) return res;
  return { ok: true, data: rowToChatMessage(res.data, deps.sender) };
}

const GONE: DomainError = {
  code: "NOT_FOUND",
  message: "This message can't be changed anymore. Refresh to see the latest.",
  retryable: false,
};

/** Edit your own message (within the edit window). Idempotent: it sets the text. */
export async function editMessage(
  client: DbClient,
  input: unknown,
  deps: ServerDeps & { sender?: SenderInfo } = {},
): Promise<ActionResult<ChatMessage>> {
  const v = validate(editMessageSchema, input);
  if (!v.ok) return v;
  const res = await callWithRetry<ChatMessageRow[]>(
    (signal) =>
      client
        .from("chat_messages")
        .update({ message_text: v.data.text })
        .eq("id", v.data.message_id)
        .is("deleted_at", null)
        .select("*")
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  if (!res.ok) return res;
  const row = res.data[0];
  return row ? { ok: true, data: rowToChatMessage(row, deps.sender) } : { ok: false, error: GONE };
}

/**
 * Delete a message: your own (also after leaving the chat), or anyone's as a
 * moderator. The content is wiped and photos stop being viewable at once.
 */
export async function deleteMessage(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<{ deleted: true; message: ChatMessage | null }>> {
  const v = validate(deleteMessageSchema, input);
  if (!v.ok) return v;
  const res = await callWithRetry<ChatMessageRow[]>(
    (signal) =>
      client
        .from("chat_messages")
        // The guard stamps the real time; any value marks the delete.
        .update({ deleted_at: new Date(0).toISOString() })
        .eq("id", v.data.message_id)
        .select("*")
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  // A retry of a delete that went through the first time finds it deleted: that's success.
  if (!res.ok)
    return res.error.code === "MESSAGE_DELETED" ? { ok: true, data: { deleted: true, message: null } } : res;
  const row = res.data[0];
  return row
    ? { ok: true, data: { deleted: true, message: rowToChatMessage(row) } }
    : { ok: false, error: GONE };
}

/**
 * A page of messages: the latest (no cursor), older history (before_seq),
 * newer history (after_seq), or a catch-up sync (after_rev). The page's
 * last_seq/last_rev come from the same snapshot as its rows.
 */
export async function getMessages(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<MessagesPage>> {
  const v = validate(messagesQuerySchema, input);
  if (!v.ok) return v;
  const q = v.data;
  const res = await callWithRetry<unknown>(
    (signal) =>
      client
        .rpc(
          "get_chat_messages",
          compact({
            p_channel_id: q.channel_id,
            p_before_seq: q.before_seq,
            p_after_seq: q.after_seq,
            p_after_rev: q.after_rev,
            p_limit: q.limit,
          }),
        )
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  if (!res.ok) return res;
  const page = messagesPageSchema.safeParse(res.data);
  return page.success ? { ok: true, data: page.data } : { ok: false, error: badShape("get_chat_messages") };
}

/**
 * Catch up from `cursor_rev` to now, page by page (bounded), returning the
 * pages in order. Stops early on an error, keeping what arrived.
 */
export async function syncMessages(
  client: DbClient,
  input: { channel_id: string; after_rev: number; limit?: number; maxPages?: number },
  deps: ServerDeps = {},
): Promise<ActionResult<MessagesPage[]>> {
  const pages: MessagesPage[] = [];
  let cursor = input.after_rev;
  for (let i = 0; i < (input.maxPages ?? 10); i++) {
    const res = await getMessages(
      client,
      compact({ channel_id: input.channel_id, after_rev: cursor, limit: input.limit }),
      deps,
    );
    if (!res.ok) return pages.length ? { ok: true, data: pages } : res;
    pages.push(res.data);
    if (!res.data.has_more) break;
    cursor = res.data.messages.reduce((a, m) => Math.max(a, m.rev), cursor);
  }
  return { ok: true, data: pages };
}

export interface ReadResult {
  channel_id: string;
  last_read_seq: number;
  unread_count: number;
}

/** Move my read marker to the highest position I have seen (forward only). */
export async function markRead(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<ReadResult>> {
  const v = validate(markReadSchema, input);
  if (!v.ok) return v;
  const res = await callWithRetry<ReadResult[]>(
    (signal) =>
      client
        .rpc("mark_chat_read", { p_channel_id: v.data.channel_id, p_up_to_seq: v.data.up_to_seq })
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  if (!res.ok) return res;
  const row = res.data[0];
  return row ? { ok: true, data: row } : { ok: false, error: badShape("mark_chat_read") };
}

/** Report a message to the platform moderators (idempotent per reporter and message). */
export async function reportMessage(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<{ report_id: string }>> {
  const v = validate(reportMessageSchema, input);
  if (!v.ok) return v;
  const res = await callWithRetry<string>(
    (signal) =>
      client
        .rpc(
          "report_chat_message",
          compact({
            p_message_id: v.data.message_id,
            p_reason: v.data.reason,
            p_note: v.data.note || undefined,
          }),
        )
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  return res.ok ? { ok: true, data: { report_id: res.data } } : res;
}

export const badShape = (rpc: string): DomainError => ({
  code: "UNKNOWN",
  message: "Something went wrong. Please try again.",
  retryable: false,
  cause: `unexpected ${rpc} response`,
});
