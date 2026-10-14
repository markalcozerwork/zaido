/**
 * Chat photos and videos in the private `chat-media` bucket.
 *
 * Upload flow (client): pick a client_id for the message, upload to
 * chatMediaPath(channel, me, client_id, mime), then send the message with that
 * client_id and media_path. The database accepts no other name, refuses to
 * let a sent object be replaced, and stops serving it once the message is
 * deleted.
 */
import { CHAT_LIMITS, CHAT_MEDIA_BUCKET, CHAT_MEDIA_PATH_PATTERN, type ActionResult } from "../../domain";
import type { DbClient } from "../db-client";
import type { ServerDeps } from "../deps";
import { callWithRetry } from "../transport";

/** The parts of the Storage client these functions use (a fake in tests). */
export interface ChatStorage {
  from(bucket: string): {
    createSignedUrls(
      paths: string[],
      expiresIn: number,
    ): PromiseLike<{
      data: Array<{ path: string | null; signedUrl: string | null; error: string | null }> | null;
      error: { message: string } | null;
    }>;
    remove(paths: string[]): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  };
}

/**
 * Short-lived URLs for media the caller can see. Always sign with the
 * caller's own client (never the service role), so storage RLS decides: a
 * path from another chat, or of a deleted message, comes back null. The short
 * lifetime bounds how long a removed member keeps a working link.
 */
export async function signChatMedia(
  client: { storage: ChatStorage },
  paths: readonly string[],
): Promise<ActionResult<Record<string, string | null>>> {
  const unique = [...new Set(paths)].filter((p) => CHAT_MEDIA_PATH_PATTERN.test(p));
  const out: Record<string, string | null> = Object.fromEntries(paths.map((p) => [p, null]));
  // A page holds up to CHAT_LIMITS.pageMax messages; sign them all, in chunks.
  const results = await Promise.all(
    chunks(unique, SIGN_CHUNK).map((chunk) =>
      client.storage.from(CHAT_MEDIA_BUCKET).createSignedUrls(chunk, CHAT_LIMITS.signedUrlSeconds),
    ),
  );
  for (const { data, error } of results) {
    if (error || !data) {
      return {
        ok: false,
        error: { code: "RETRYABLE", message: "Photos couldn't load. Pull to refresh.", retryable: true },
      };
    }
    for (const item of data) {
      if (item.path && !item.error && item.signedUrl) out[item.path] = item.signedUrl;
    }
  }
  return { ok: true, data: out };
}

const SIGN_CHUNK = 100;
/** Storage removes at most 1,000 objects per request; stay well below. */
const REMOVE_CHUNK = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface PurgeOutcome {
  claimed: number;
  removed: number;
  failed: number;
}

/**
 * Service-role job (cron/edge function): remove media of deleted messages
 * and uploads never sent (older than a day) through the Storage API, which
 * deletes the file as well as its row. Paths held by an open report are kept
 * as evidence. Safe to run concurrently or twice.
 */
export async function purgeChatMedia(
  service: DbClient & { storage: ChatStorage },
  options: { batch?: number } = {},
  deps: ServerDeps = {},
): Promise<ActionResult<PurgeOutcome>> {
  const batch = Math.min(Math.max(options.batch ?? 100, 1), 500);
  const claimed = await callWithRetry<string[]>(
    (signal) => service.rpc("claim_chat_media_purge", { p_limit: batch }).abortSignal(signal).retry(false),
    deps.retry,
  );
  if (!claimed.ok) return claimed;
  const paths = claimed.data;
  let removed = 0;
  let failed = 0;
  for (const chunk of chunks(paths, REMOVE_CHUNK)) {
    const { error } = await service.storage.from(CHAT_MEDIA_BUCKET).remove(chunk);
    if (error) {
      failed += chunk.length;
      continue;
    }
    // Removing a path that is already gone is not an error, so every path of
    // the chunk is now absent: take it off the queue.
    const done = await callWithRetry<number>(
      (signal) =>
        service.rpc("complete_chat_media_purge", { p_paths: chunk }).abortSignal(signal).retry(false),
      deps.retry,
    );
    if (!done.ok) return done;
    removed += chunk.length;
  }
  if (paths.length > 0 && removed === 0) {
    return {
      ok: false,
      error: { code: "RETRYABLE", message: "Storage refused every removal; retry later.", retryable: true },
    };
  }
  return { ok: true, data: { claimed: paths.length, removed, failed } };
}
