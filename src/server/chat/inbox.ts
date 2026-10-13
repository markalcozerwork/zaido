/**
 * The chat inbox: the caller's conversations with previews and unread counts,
 * newest activity first, plus the tab badge. Both RPCs only ever return the
 * caller's own conversations.
 */
import { z } from "zod";
import {
  inboxEntrySchema,
  inboxQuerySchema,
  unreadSummarySchema,
  validate,
  type ActionResult,
  type InboxEntry,
  type UnreadSummary,
} from "../../domain";
import { compact } from "../../domain/object";
import type { DbClient } from "../db-client";
import type { ServerDeps } from "../deps";
import { callWithRetry } from "../transport";
import { badShape } from "./messages";

const inboxPageSchema = z.array(inboxEntrySchema);

/**
 * A page of the inbox (keyset: pass the last entry's activity_at/channel_id as
 * `cursor`), the archived list (`archived: true`), or specific conversations
 * (`channel_ids`, e.g. previews a hint marked stale, or a deep link).
 * Unsent DMs are not conversations yet and never appear.
 */
export async function getInbox(
  client: DbClient,
  input: unknown = {},
  deps: ServerDeps = {},
): Promise<ActionResult<InboxEntry[]>> {
  const v = validate(inboxQuerySchema, input);
  if (!v.ok) return v;
  const q = v.data;
  const res = await callWithRetry<unknown>(
    (signal) =>
      client
        .rpc(
          "get_chat_inbox",
          compact({
            p_limit: q.limit,
            p_before_activity: q.cursor?.activity_at,
            p_before_channel: q.cursor?.channel_id,
            p_archived: q.archived,
            p_channel_ids: q.channel_ids,
          }),
        )
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  if (!res.ok) return res;
  const page = inboxPageSchema.safeParse(res.data);
  return page.success ? { ok: true, data: page.data } : { ok: false, error: badShape("get_chat_inbox") };
}

/** Unread messages and conversations for the chat tab badge (muted and closed chats excluded). */
export async function getUnreadSummary(
  client: DbClient,
  deps: ServerDeps = {},
): Promise<ActionResult<UnreadSummary>> {
  const res = await callWithRetry<unknown>(
    (signal) => client.rpc("get_chat_unread_summary").abortSignal(signal).retry(false),
    deps.retry,
  );
  if (!res.ok) return res;
  const row = z.array(unreadSummarySchema).safeParse(res.data);
  return row.success && row.data[0]
    ? { ok: true, data: row.data[0] }
    : { ok: false, error: badShape("get_chat_unread_summary") };
}
