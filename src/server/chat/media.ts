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
  const unique = [...new Set(paths)].filter((p) => CHAT_MEDIA_PATH_PATTERN.test(p)).slice(0, 100);
  const out: Record<string, string | null> = Object.fromEntries(paths.map((p) => [p, null]));
  if (unique.length === 0) return { ok: true, data: out };
  const { data, error } = await client.storage
    .from(CHAT_MEDIA_BUCKET)
    .createSignedUrls(unique, CHAT_LIMITS.signedUrlSeconds);
  if (error || !data) {
    return {
      ok: false,
      error: { code: "RETRYABLE", message: "Photos couldn't load. Pull to refresh.", retryable: true },
    };
  }
  for (const item of data) {
    if (item.path && !item.error && item.signedUrl) out[item.path] = item.signedUrl;
  }
  return { ok: true, data: out };
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
  const claimed = await callWithRetry<string[]>(
    (signal) =>
      service
        .rpc("claim_chat_media_purge", { p_limit: options.batch ?? 100 })
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  if (!claimed.ok) return claimed;
  const paths = claimed.data;
  if (paths.length === 0) return { ok: true, data: { claimed: 0, removed: 0, failed: 0 } };

  const { error } = await service.storage.from(CHAT_MEDIA_BUCKET).remove(paths);
  if (error) return { ok: true, data: { claimed: paths.length, removed: 0, failed: paths.length } };

  // Removing a path that is already gone is not an error, so every claimed
  // path is now absent.
  const done = await callWithRetry<number>(
    (signal) => service.rpc("complete_chat_media_purge", { p_paths: paths }).abortSignal(signal).retry(false),
    deps.retry,
  );
  if (!done.ok) return done;
  return { ok: true, data: { claimed: paths.length, removed: paths.length, failed: 0 } };
}
