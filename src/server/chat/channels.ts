/**
 * Conversations: open a DM, mute, members, and blocks. Club and event chats
 * are joined and left through club membership and event seats, never here.
 */
import { z } from "zod";
import {
  muteSchema,
  participantSchema,
  participantsQuerySchema,
  profileTargetSchema,
  validate,
  type ActionResult,
  type Participant,
} from "../../domain";
import { compact } from "../../domain/object";
import type { DbClient } from "../db-client";
import type { ServerDeps } from "../deps";
import { callWithRetry } from "../transport";
import { badShape } from "./messages";

/**
 * The DM thread with another player, created on first use. Only the opener
 * joins now; the other person sees it when the first message arrives. An
 * existing thread opens even across a block (to read it or unblock), but a
 * new one can't be started with someone who blocked you or whom you blocked.
 */
export async function openDirectChannel(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<{ channel_id: string }>> {
  const v = validate(profileTargetSchema, input);
  if (!v.ok) return v;
  const res = await callWithRetry<string>(
    (signal) =>
      client
        .rpc("get_or_create_direct_channel", { p_other_profile_id: v.data.profile_id })
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  return res.ok ? { ok: true, data: { channel_id: res.data } } : res;
}

/** Mute or unmute a conversation for myself (no badge, no push). */
export async function setMuted(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<{ muted: boolean }>> {
  const v = validate(muteSchema, input);
  if (!v.ok) return v;
  // RLS limits the update to my own participant row.
  const res = await callWithRetry<null>(
    (signal) =>
      client
        .from("chat_participants")
        .update({ is_muted: v.data.muted }, { count: "exact" })
        .eq("channel_id", v.data.channel_id)
        .abortSignal(signal)
        .retry(false)
        .then((r) => ({
          ...r,
          data: null,
          ...(r.error === null && r.count === 0 ? { error: notInChat } : {}),
        })),
    deps.retry,
  );
  return res.ok ? { ok: true, data: { muted: v.data.muted } } : res;
}

const notInChat = {
  code: "42501",
  message: "NOT_A_PARTICIPANT: You're not in this conversation.",
  details: null,
  hint: null,
};

const participantsSchema = z.array(participantSchema);

/** Members of a conversation, by profile id (keyset `after_profile_id`), with their role. */
export async function listParticipants(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<Participant[]>> {
  const v = validate(participantsQuerySchema, input);
  if (!v.ok) return v;
  const res = await callWithRetry<unknown>(
    (signal) =>
      client
        .rpc(
          "list_chat_participants",
          compact({
            p_channel_id: v.data.channel_id,
            p_after_profile: v.data.after_profile_id,
            p_limit: v.data.limit,
          }),
        )
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  if (!res.ok) return res;
  const rows = participantsSchema.safeParse(res.data);
  return rows.success
    ? { ok: true, data: rows.data }
    : { ok: false, error: badShape("list_chat_participants") };
}

// -----------------------------------------------------------------------------
// Blocks
// -----------------------------------------------------------------------------
/**
 * Block a player: no DMs either way (sending, editing, typing, uploads, read
 * receipts), and no new DM threads. Group chats are unaffected; the app hides
 * their messages using listBlocks. Blocking twice is fine.
 */
export async function blockProfile(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<{ blocked: true }>> {
  const v = validate(profileTargetSchema, input);
  if (!v.ok) return v;
  const res = await callWithRetry<null>(
    (signal) =>
      client
        .from("profile_blocks")
        .insert({ blocked_id: v.data.profile_id })
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  if (!res.ok && res.error.cause !== "23505") return res;
  return { ok: true, data: { blocked: true } };
}

export async function unblockProfile(
  client: DbClient,
  input: unknown,
  deps: ServerDeps = {},
): Promise<ActionResult<{ unblocked: true }>> {
  const v = validate(profileTargetSchema, input);
  if (!v.ok) return v;
  const res = await callWithRetry<null>(
    (signal) =>
      client
        .from("profile_blocks")
        .delete()
        .eq("blocked_id", v.data.profile_id)
        .abortSignal(signal)
        .retry(false),
    deps.retry,
  );
  return res.ok ? { ok: true, data: { unblocked: true } } : res;
}

export interface BlockedProfile {
  profile_id: string;
  name: string;
  avatar_url: string | null;
  blocked_at: string;
}

/** People I blocked (for Settings, and to hide their messages in group chats). */
export async function listBlocks(
  client: DbClient,
  deps: ServerDeps = {},
): Promise<ActionResult<BlockedProfile[]>> {
  type Raw = {
    blocked_id: string;
    created_at: string;
    blocked: { full_name: string; display_name: string | null; avatar_url: string | null } | null;
  };
  const res = await callWithRetry<Raw[]>(
    (signal) =>
      client
        .from("profile_blocks")
        .select(
          "blocked_id, created_at, blocked:profiles!profile_blocks_blocked_id_fkey(full_name, display_name, avatar_url)",
        )
        .order("created_at", { ascending: false })
        .limit(1000)
        .abortSignal(signal)
        .retry(false)
        .overrideTypes<Raw[], { merge: false }>(),
    deps.retry,
  );
  if (!res.ok) return res;
  return {
    ok: true,
    data: res.data.map((b) => ({
      profile_id: b.blocked_id,
      name: b.blocked?.display_name ?? b.blocked?.full_name ?? "Player",
      avatar_url: b.blocked?.avatar_url ?? null,
      blocked_at: b.created_at,
    })),
  };
}
