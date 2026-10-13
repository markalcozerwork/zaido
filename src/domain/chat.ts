/**
 * Chat (Step 4): limits, realtime topics, input schemas, the shapes the chat
 * RPCs return, and pure state helpers shared by the server actions and the
 * mobile client.
 *
 * Ordering model (supabase/migrations/20261013001100_chat_engine.sql):
 *   seq  a message's position in its channel: gapless, in commit order. Used
 *        for history pages ("before seq"), unread counts and read markers.
 *   rev  the channel's change counter at the message's last change. A client
 *        that asks for "rev > my cursor" gets every insert, edit and delete
 *        since, and can't miss one that committed late.
 *
 * Realtime messages are hints (positions, never content). Clients refetch
 * through the RLS-checked RPCs, so a missed or repeated hint can't leave a
 * screen wrong.
 */
import { z } from "zod";
import { channelTypeSchema, chatReportReasonSchema, eventStatusSchema } from "./enums";
import type { DomainError } from "./errors";
import { instantSchema, uuidSchema } from "./primitives";

// -----------------------------------------------------------------------------
// Limits (the contract tests compare these with the database)
// -----------------------------------------------------------------------------
export const CHAT_LIMITS = {
  /** chat_messages_text_length: characters (code points), after trimming. */
  textMax: 4000,
  /** Inbox previews and reply quotes. */
  snippetLength: 140,
  /** app.chat_edit_window() */
  editWindowMinutes: 15,
  /** app.chat_rate_limit_count() messages per app.chat_rate_limit_window(). */
  rateLimitCount: 20,
  rateLimitWindowSeconds: 30,
  pageDefault: 50,
  pageMax: 200,
  inboxDefault: 30,
  inboxMax: 50,
  inboxChannelIdsMax: 50,
  participantsDefault: 100,
  participantsMax: 200,
  reportNoteMax: 500,
  mediaDimensionMax: 10_000,
  /** chat-media bucket file_size_limit. */
  mediaMaxBytes: 10 * 1024 * 1024,
  /** Signed media URLs outlive a removal by at most this long. */
  signedUrlSeconds: 300,
} as const;

// -----------------------------------------------------------------------------
// Media: one object per message, named after the message's idempotency key
// -----------------------------------------------------------------------------
export const CHAT_MEDIA_BUCKET = "chat-media";

export const CHAT_MEDIA_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
} as const;

export type ChatMediaMime = keyof typeof CHAT_MEDIA_TYPES;
export type ChatMediaKind = "IMAGE" | "VIDEO";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Same shape the storage INSERT policy requires: <channel>/<sender>/<client_id>.<ext>. */
export const CHAT_MEDIA_PATH_PATTERN = new RegExp(`^${UUID}/${UUID}/${UUID}\\.(jpe?g|png|webp|gif|mp4)$`);

export function isChatMediaMime(mime: string): mime is ChatMediaMime {
  return Object.hasOwn(CHAT_MEDIA_TYPES, mime);
}

/**
 * Where a message's photo or video goes. Upload it there first, then send the
 * message with the same client_id; the database refuses any other name.
 */
export function chatMediaPath(
  channelId: string,
  senderId: string,
  clientId: string,
  mime: ChatMediaMime,
): string {
  return `${channelId.toLowerCase()}/${senderId.toLowerCase()}/${clientId.toLowerCase()}.${CHAT_MEDIA_TYPES[mime]}`;
}

export const chatMediaKind = (mime: ChatMediaMime): ChatMediaKind =>
  mime.startsWith("video/") ? "VIDEO" : "IMAGE";

// -----------------------------------------------------------------------------
// Realtime topics and hint payloads
// -----------------------------------------------------------------------------
/** Receive-only for participants and moderators: message, read, channel. */
export const chatTopic = (channelId: string): string => `chat:${channelId.toLowerCase()}`;
/** The one client-sendable chat topic: typing. */
export const chatTypingTopic = (channelId: string): string => `chat:${channelId.toLowerCase()}:typing`;
/** Receive-only for that user: inbox. */
export const userChatTopic = (profileId: string): string => `user:${profileId.toLowerCase()}:chat`;

export const CHAT_EVENTS = {
  message: "message",
  read: "read",
  channel: "channel",
  inbox: "inbox",
  typing: "typing",
} as const;

/** All chat topics are private channels (Realtime checks the topic policies on join). */
export const CHAT_CHANNELS_PRIVATE = true;

const seqNumber = z.number().int().nonnegative();
export const messageOpSchema = z.enum(["INSERT", "UPDATE", "DELETE"]);
export type MessageOp = z.output<typeof messageOpSchema>;

// Loose: Realtime adds its own keys (`id`), and later triggers may add more.
export const messageHintSchema = z.looseObject({
  channel_id: uuidSchema,
  message_id: uuidSchema,
  seq: seqNumber,
  rev: seqNumber,
  op: messageOpSchema,
  sender_id: uuidSchema.nullable(),
  created_at: instantSchema,
});
export type MessageHint = z.output<typeof messageHintSchema>;

export const readHintSchema = z.looseObject({
  channel_id: uuidSchema,
  profile_id: uuidSchema,
  last_read_seq: seqNumber,
});
export type ReadHint = z.output<typeof readHintSchema>;

export const channelHintSchema = z.looseObject({
  channel_id: uuidSchema,
  reason: z.enum(["updated", "archived", "deleted"]),
});
export type ChannelHint = z.output<typeof channelHintSchema>;

export const inboxHintSchema = z.looseObject({
  channel_id: uuidSchema,
  reason: z.enum(["message", "joined", "left", "read", "muted"]),
  seq: seqNumber.optional(),
  rev: seqNumber.optional(),
  op: messageOpSchema.optional(),
  sender_id: uuidSchema.nullable().optional(),
  created_at: instantSchema.optional(),
  last_read_seq: seqNumber.optional(),
  is_muted: z.boolean().optional(),
});
export type InboxHint = z.output<typeof inboxHintSchema>;

/**
 * Typing events are sent by clients, so they are untrusted: only this exact
 * shape is accepted, and the receiver shows it only for known, unblocked
 * participants (a participant could claim another participant's id).
 */
export const typingPayloadSchema = z.object({ profile_id: uuidSchema });

export const TYPING = {
  /** Send at most one typing event per this interval while the user types. */
  sendEveryMs: 3_000,
  /** Show "X is typing" for this long after the last event. */
  expireAfterMs: 6_000,
  /** Ignore larger frames. */
  maxPayloadBytes: 256,
} as const;

// -----------------------------------------------------------------------------
// Input schemas (server boundary)
// -----------------------------------------------------------------------------
/** Postgres btrim(text, E' \t\r\n'): the database trims exactly these. */
const trimChat = (s: string): string => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
const codePoints = (s: string): number => [...s].length;

export const chatTextSchema = z
  .string()
  .transform(trimChat)
  .refine((s) => !s.includes("\u0000"), { error: "Messages can't contain that character." })
  .refine((s) => codePoints(s) <= CHAT_LIMITS.textMax, {
    error: `Messages can be at most ${CHAT_LIMITS.textMax.toLocaleString("en-PH")} characters.`,
  });

const mediaDimension = z.number().int().min(1).max(CHAT_LIMITS.mediaDimensionMax);

export const sendMessageSchema = z
  .strictObject({
    channel_id: uuidSchema,
    /** The idempotency key: generate once per message, reuse on every retry. */
    client_id: uuidSchema,
    text: chatTextSchema.optional(),
    media_path: z.string().regex(CHAT_MEDIA_PATH_PATTERN, { error: "Upload the photo again." }).optional(),
    media_width: mediaDimension.optional(),
    media_height: mediaDimension.optional(),
    reply_to_id: uuidSchema.optional(),
  })
  .refine((v) => (v.text !== undefined && v.text.length > 0) || v.media_path !== undefined, {
    error: "Type a message or attach a photo.",
    path: ["text"],
  })
  .refine(
    (v) =>
      v.media_path === undefined ||
      (v.media_path.startsWith(`${v.channel_id.toLowerCase()}/`) &&
        v.media_path.split("/")[2]?.startsWith(`${v.client_id.toLowerCase()}.`)),
    { error: "Upload the photo again.", path: ["media_path"] },
  );
export type SendMessageInput = z.output<typeof sendMessageSchema>;

export const editMessageSchema = z.strictObject({
  message_id: uuidSchema,
  text: chatTextSchema.refine((s) => s.length > 0, { error: "A message can't be empty. Delete it instead." }),
});

export const deleteMessageSchema = z.strictObject({ message_id: uuidSchema });

export const markReadSchema = z.strictObject({
  channel_id: uuidSchema,
  /** The highest position the user has actually seen (never "whatever is latest"). */
  up_to_seq: seqNumber,
});

export const messagesQuerySchema = z
  .strictObject({
    channel_id: uuidSchema,
    before_seq: seqNumber.optional(),
    after_seq: seqNumber.optional(),
    after_rev: seqNumber.optional(),
    limit: z.number().int().min(1).max(CHAT_LIMITS.pageMax).optional(),
  })
  .refine((v) => [v.before_seq, v.after_seq, v.after_rev].filter((x) => x !== undefined).length <= 1, {
    error: "Choose one of before_seq, after_seq or after_rev.",
  });
export type MessagesQuery = z.output<typeof messagesQuerySchema>;

export const inboxCursorSchema = z.strictObject({ activity_at: instantSchema, channel_id: uuidSchema });
export type InboxCursor = z.output<typeof inboxCursorSchema>;

export const inboxQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(CHAT_LIMITS.inboxMax).optional(),
  cursor: inboxCursorSchema.optional(),
  archived: z.boolean().optional(),
  channel_ids: z.array(uuidSchema).min(1).max(CHAT_LIMITS.inboxChannelIdsMax).optional(),
});
export type InboxQuery = z.output<typeof inboxQuerySchema>;

export const participantsQuerySchema = z.strictObject({
  channel_id: uuidSchema,
  after_profile_id: uuidSchema.optional(),
  limit: z.number().int().min(1).max(CHAT_LIMITS.participantsMax).optional(),
});

export const reportMessageSchema = z.strictObject({
  message_id: uuidSchema,
  reason: chatReportReasonSchema,
  note: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length <= CHAT_LIMITS.reportNoteMax, {
      error: `Keep the note under ${CHAT_LIMITS.reportNoteMax} characters.`,
    })
    .optional(),
});

export const profileTargetSchema = z.strictObject({ profile_id: uuidSchema });
export const muteSchema = z.strictObject({ channel_id: uuidSchema, muted: z.boolean() });

// -----------------------------------------------------------------------------
// What the RPCs return (parsed at the boundary: the generated types claim
// every RETURNS TABLE column is non-null, and get_chat_messages returns jsonb)
// -----------------------------------------------------------------------------
export const chatMessageSchema = z.object({
  id: uuidSchema,
  channel_id: uuidSchema,
  seq: seqNumber,
  rev: seqNumber,
  /** Only on your own messages: matches the outbox entry that sent it. */
  client_id: uuidSchema.nullable(),
  sender: z.object({ id: uuidSchema, name: z.string(), avatar_url: z.string().nullable() }).nullable(),
  text: z.string().nullable(),
  media: z
    .object({
      path: z.string(),
      kind: z.enum(["IMAGE", "VIDEO"]),
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
    })
    .nullable(),
  reply_to: z
    .object({
      id: uuidSchema,
      seq: seqNumber,
      sender_id: uuidSchema.nullable(),
      sender_name: z.string().nullable(),
      snippet: z.string().nullable(),
      media_kind: z.enum(["IMAGE", "VIDEO"]).nullable(),
      is_deleted: z.boolean(),
    })
    .nullable(),
  created_at: instantSchema,
  edited_at: instantSchema.nullable(),
  deleted_at: instantSchema.nullable(),
  deleted_by_moderator: z.boolean(),
});
export type ChatMessage = z.output<typeof chatMessageSchema>;

export const messagesPageSchema = z.object({
  channel_id: uuidSchema,
  /** The channel's counters in the same snapshot as `messages`. */
  last_seq: seqNumber,
  last_rev: seqNumber,
  has_more: z.boolean(),
  /** Oldest first (by seq), or by rev for an after_rev sync page. */
  messages: z.array(chatMessageSchema),
});
export type MessagesPage = z.output<typeof messagesPageSchema>;

export const inboxEntrySchema = z.object({
  channel_id: uuidSchema,
  channel_type: channelTypeSchema,
  title: z.string().nullable(),
  image_url: z.string().nullable(),
  club_id: uuidSchema.nullable(),
  event_id: uuidSchema.nullable(),
  event_start_time: instantSchema.nullable(),
  event_status: eventStatusSchema.nullable(),
  partner_id: uuidSchema.nullable(),
  /** DMs only, and hidden (null) across a block: "Seen" up to this position. */
  partner_last_read_seq: seqNumber.nullable(),
  is_archived: z.boolean(),
  is_muted: z.boolean(),
  can_send: z.boolean(),
  blocked_by_me: z.boolean(),
  last_seq: seqNumber,
  last_read_seq: seqNumber,
  unread_count: seqNumber,
  activity_at: instantSchema,
  last_message_id: uuidSchema.nullable(),
  last_message_seq: seqNumber.nullable(),
  last_message_sender_id: uuidSchema.nullable(),
  last_message_sender_name: z.string().nullable(),
  last_message_snippet: z.string().nullable(),
  last_message_media_kind: z.enum(["IMAGE", "VIDEO"]).nullable(),
  last_message_is_deleted: z.boolean().nullable(),
  last_message_created_at: instantSchema.nullable(),
});
export type InboxEntry = z.output<typeof inboxEntrySchema>;

export const unreadSummarySchema = z.object({
  unread_messages: seqNumber,
  unread_channels: seqNumber,
});
export type UnreadSummary = z.output<typeof unreadSummarySchema>;

export const participantSchema = z.object({
  profile_id: uuidSchema,
  display_name: z.string(),
  avatar_url: z.string().nullable(),
  role: z.enum(["ORGANIZER", "COACH", "ADMIN", "MEMBER"]),
  joined_at: instantSchema,
});
export type Participant = z.output<typeof participantSchema>;

/** The next inbox page starts after the last entry of this one. */
export const nextInboxCursor = (page: readonly InboxEntry[]): InboxCursor | undefined => {
  const last = page.at(-1);
  return last ? { activity_at: last.activity_at, channel_id: last.channel_id } : undefined;
};

// -----------------------------------------------------------------------------
// Display helpers
// -----------------------------------------------------------------------------
export function unreadLabel(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

/** Inbox preview line, e.g. "You: See you at 6", "Ana: Photo", "Message deleted". */
export function inboxPreview(entry: InboxEntry, me: string): string {
  if (entry.last_message_id === null) return "No messages yet";
  if (entry.last_message_is_deleted) return "Message deleted";
  const body =
    entry.last_message_snippet ??
    (entry.last_message_media_kind === "VIDEO" ? "Video" : entry.last_message_media_kind ? "Photo" : "");
  if (entry.last_message_sender_id === me) return `You: ${body}`;
  if (entry.channel_type === "DIRECT" || !entry.last_message_sender_name) return body;
  return `${entry.last_message_sender_name.split(" ")[0]}: ${body}`;
}

export function canEditMessage(m: ChatMessage, me: string, now: Date): boolean {
  return (
    m.sender?.id === me &&
    m.deleted_at === null &&
    m.text !== null &&
    now.getTime() <= new Date(m.created_at).getTime() + CHAT_LIMITS.editWindowMinutes * 60_000
  );
}

export const canDeleteMessage = (m: ChatMessage, me: string, isModerator: boolean): boolean =>
  m.deleted_at === null && (m.sender?.id === me || isModerator);

/** "Seen" under my last DM message: the partner's marker reached it. */
export const isSeenByPartner = (m: ChatMessage, entry: Pick<InboxEntry, "partner_last_read_seq">): boolean =>
  entry.partner_last_read_seq !== null && entry.partner_last_read_seq >= m.seq;

// -----------------------------------------------------------------------------
// Conversation state: server pages, catch-up sync, outbox, read marker
// -----------------------------------------------------------------------------
export interface OutboxItem {
  client_id: string;
  channel_id: string;
  text?: string;
  media_path?: string;
  media_width?: number;
  media_height?: number;
  /** A local URI to show while the upload/send is in flight. */
  local_media_uri?: string;
  reply_to_id?: string;
  /** Local time the user pressed send (for ordering among pending items). */
  queued_at: string;
  status: "queued" | "sending" | "failed";
  attempts: number;
  /** Don't try before this time (ms since epoch): rate limit or backoff. */
  not_before?: number;
  error?: DomainError;
}

export interface ConversationState {
  channel_id: string;
  /** Server messages by id (newest revision wins). */
  messages: Record<string, ChatMessage>;
  /**
   * Catch-up cursor: the last_rev of the FIRST page, then advanced only by
   * sync pages. Older history pages never move it (they may be newer than
   * edits the cursor hasn't seen yet).
   */
  cursor_rev: number | null;
  /** last_seq of a page that included the tail (latest page or a finished sync). */
  tail_seq: number;
  oldest_seq: number | null;
  has_older: boolean;
  outbox: OutboxItem[];
  /** The marker the server has acknowledged. */
  read_marker: number;
}

export const initialConversation = (channelId: string): ConversationState => ({
  channel_id: channelId,
  messages: {},
  cursor_rev: null,
  tail_seq: 0,
  oldest_seq: null,
  has_older: true,
  outbox: [],
  read_marker: 0,
});

/** Keep the newer revision of a message. */
export const newerMessage = (a: ChatMessage | undefined, b: ChatMessage): ChatMessage =>
  a === undefined || b.rev >= a.rev ? b : a;

function mergeMessages(state: ConversationState, incoming: readonly ChatMessage[]): ConversationState {
  if (incoming.length === 0) return state;
  const messages = { ...state.messages };
  const sentKeys = new Set<string>();
  for (const m of incoming) {
    messages[m.id] = newerMessage(messages[m.id], m);
    if (m.client_id) sentKeys.add(m.client_id);
  }
  // A message the server now has is no longer pending.
  const outbox = sentKeys.size ? state.outbox.filter((o) => !sentKeys.has(o.client_id)) : state.outbox;
  return { ...state, messages, outbox };
}

const minSeq = (ms: readonly ChatMessage[]): number | null =>
  ms.length ? ms.reduce((a, m) => Math.min(a, m.seq), Number.POSITIVE_INFINITY) : null;

/** The latest page (no paging argument). Seeds the sync cursor the first time. */
export function applyLatestPage(state: ConversationState, page: MessagesPage): ConversationState {
  const next = mergeMessages(state, page.messages);
  const oldest = minSeq(page.messages);
  return {
    ...next,
    cursor_rev: state.cursor_rev ?? page.last_rev,
    tail_seq: Math.max(state.tail_seq, page.last_seq),
    oldest_seq:
      state.oldest_seq === null
        ? oldest
        : oldest === null
          ? state.oldest_seq
          : Math.min(state.oldest_seq, oldest),
    has_older: state.oldest_seq === null ? page.has_more : state.has_older,
  };
}

/** An older history page (before_seq). Never moves the sync cursor. */
export function applyOlderPage(state: ConversationState, page: MessagesPage): ConversationState {
  const next = mergeMessages(state, page.messages);
  const oldest = minSeq(page.messages);
  return {
    ...next,
    oldest_seq: oldest === null ? state.oldest_seq : Math.min(state.oldest_seq ?? oldest, oldest),
    has_older: page.has_more,
  };
}

/**
 * A catch-up page (after_rev = cursor_rev). With more to come, the cursor
 * moves to the last row's rev; once complete, to the snapshot's last_rev.
 */
export function applySyncPage(state: ConversationState, page: MessagesPage): ConversationState {
  const next = mergeMessages(state, page.messages);
  const maxRev = page.messages.reduce((a, m) => Math.max(a, m.rev), state.cursor_rev ?? 0);
  return {
    ...next,
    cursor_rev: page.has_more ? maxRev : Math.max(maxRev, page.last_rev),
    tail_seq: page.has_more ? state.tail_seq : Math.max(state.tail_seq, page.last_seq),
  };
}

/** Server messages oldest first, then what is still in the outbox. */
export function timeline(state: ConversationState): { sent: ChatMessage[]; pending: OutboxItem[] } {
  return {
    sent: Object.values(state.messages).sort((a, b) => a.seq - b.seq),
    pending: [...state.outbox].sort((a, b) => a.queued_at.localeCompare(b.queued_at)),
  };
}

/**
 * The position to report as read: the highest message actually loaded, or the
 * tail of a page that ended at the channel's last message.
 */
export function readTarget(state: ConversationState): number {
  const loaded = Object.values(state.messages).reduce((a, m) => Math.max(a, m.seq), 0);
  return Math.max(loaded, state.tail_seq);
}

export const needsReadUpdate = (state: ConversationState): boolean => readTarget(state) > state.read_marker;

export const acknowledgeRead = (state: ConversationState, marker: number): ConversationState => ({
  ...state,
  read_marker: Math.max(state.read_marker, marker),
});

// Outbox ----------------------------------------------------------------------
export function enqueueMessage(
  state: ConversationState,
  item: Omit<OutboxItem, "status" | "attempts" | "channel_id">,
): ConversationState {
  if (state.outbox.some((o) => o.client_id === item.client_id)) return state;
  return {
    ...state,
    outbox: [...state.outbox, { ...item, channel_id: state.channel_id, status: "queued", attempts: 0 }],
  };
}

const updateOutbox = (
  state: ConversationState,
  clientId: string,
  f: (o: OutboxItem) => OutboxItem,
): ConversationState => ({
  ...state,
  outbox: state.outbox.map((o) => (o.client_id === clientId ? f(o) : o)),
});

export const markSending = (state: ConversationState, clientId: string): ConversationState =>
  updateOutbox(state, clientId, (o) => ({ ...o, status: "sending", attempts: o.attempts + 1 }));

/** The server accepted (or replayed) the message. */
export const markSent = (state: ConversationState, message: ChatMessage): ConversationState =>
  mergeMessages({ ...state, outbox: state.outbox.filter((o) => o.client_id !== message.client_id) }, [
    message,
  ]);

export const OUTBOX_BACKOFF = { baseMs: 1_000, maxMs: 30_000 } as const;

/**
 * A failed send. Rate limits and transient failures go back in the queue
 * (same client_id, so a retry can't duplicate); anything else waits for the
 * user to retry or discard.
 */
export function markSendFailed(
  state: ConversationState,
  clientId: string,
  error: DomainError,
  nowMs: number,
): ConversationState {
  return updateOutbox(state, clientId, (o) => {
    if (error.code === "RATE_LIMITED") {
      const wait = (error.meta?.retryAfterSeconds ?? CHAT_LIMITS.rateLimitWindowSeconds) * 1000;
      return { ...o, status: "queued", not_before: nowMs + wait, error };
    }
    if (error.retryable || error.code === "RETRYABLE" || error.code === "ABORTED") {
      const wait = Math.min(OUTBOX_BACKOFF.maxMs, OUTBOX_BACKOFF.baseMs * 2 ** Math.max(0, o.attempts - 1));
      return { ...o, status: "queued", not_before: nowMs + wait, error };
    }
    return { ...o, status: "failed", error };
  });
}

export const retryOutboxItem = (state: ConversationState, clientId: string): ConversationState =>
  updateOutbox(state, clientId, (o) => {
    const { not_before: _wait, error: _error, ...rest } = o;
    return { ...rest, status: "queued" };
  });

export const discardOutboxItem = (state: ConversationState, clientId: string): ConversationState => ({
  ...state,
  outbox: state.outbox.filter((o) => o.client_id !== clientId),
});

/**
 * The next message to send: one at a time and in order, so messages arrive in
 * the order they were written. A failed item blocks the ones after it until
 * the user retries or discards it.
 */
export function nextToSend(state: ConversationState, nowMs: number): OutboxItem | undefined {
  const ordered = [...state.outbox].sort((a, b) => a.queued_at.localeCompare(b.queued_at));
  const head = ordered[0];
  if (!head || head.status !== "queued") return undefined;
  return (head.not_before ?? 0) <= nowMs ? head : undefined;
}

/** When the head of the queue may be tried again (for a timer), if it's waiting. */
export function outboxWakeAt(state: ConversationState): number | undefined {
  const head = [...state.outbox].sort((a, b) => a.queued_at.localeCompare(b.queued_at))[0];
  return head?.status === "queued" ? head.not_before : undefined;
}

// -----------------------------------------------------------------------------
// Inbox state: local updates from hints, narrow refetches for previews
// -----------------------------------------------------------------------------
export function sortInbox(entries: readonly InboxEntry[]): InboxEntry[] {
  return [...entries].sort((a, b) =>
    a.activity_at === b.activity_at
      ? b.channel_id.localeCompare(a.channel_id)
      : b.activity_at.localeCompare(a.activity_at),
  );
}

/** Replace/insert fetched rows; drop channels that are now archived from the active list. */
export function upsertInbox(
  entries: readonly InboxEntry[],
  fetched: readonly InboxEntry[],
  view: "active" | "archived" = "active",
): InboxEntry[] {
  const byId = new Map(entries.map((e) => [e.channel_id, e]));
  for (const f of fetched) {
    if ((view === "active") === f.is_archived) byId.delete(f.channel_id);
    else byId.set(f.channel_id, f);
  }
  return sortInbox([...byId.values()]);
}

export const removeFromInbox = (entries: readonly InboxEntry[], channelId: string): InboxEntry[] =>
  entries.filter((e) => e.channel_id !== channelId);

export interface InboxHintResult {
  entries: InboxEntry[];
  /** Channels whose preview (or whole row) must be fetched again. */
  refetch: string[];
}

/**
 * Apply a message hint without a round trip: counters, unread and order move
 * now; the preview text is refetched (narrowly, batched) since hints carry no
 * content.
 */
export function applyMessageHintToInbox(
  entries: readonly InboxEntry[],
  hint: MessageHint,
  me: string,
): InboxHintResult {
  const entry = entries.find((e) => e.channel_id === hint.channel_id);
  if (!entry) return { entries: [...entries], refetch: [hint.channel_id] };
  if (hint.op !== "INSERT") {
    const affectsPreview = entry.last_message_id === hint.message_id;
    return { entries: [...entries], refetch: affectsPreview ? [hint.channel_id] : [] };
  }
  const lastSeq = Math.max(entry.last_seq, hint.seq);
  const lastRead = hint.sender_id === me ? Math.max(entry.last_read_seq, hint.seq) : entry.last_read_seq;
  const updated: InboxEntry = {
    ...entry,
    last_seq: lastSeq,
    last_read_seq: lastRead,
    unread_count: Math.max(lastSeq - lastRead, 0),
    activity_at: hint.created_at > entry.activity_at ? hint.created_at : entry.activity_at,
  };
  const stale = (entry.last_message_seq ?? 0) < hint.seq;
  return {
    entries: sortInbox(entries.map((e) => (e.channel_id === entry.channel_id ? updated : e))),
    refetch: stale ? [hint.channel_id] : [],
  };
}

/** My own marker moved (this or another of my devices). */
export function applyReadToInbox(
  entries: readonly InboxEntry[],
  channelId: string,
  lastReadSeq: number,
): InboxEntry[] {
  return entries.map((e) =>
    e.channel_id === channelId && lastReadSeq > e.last_read_seq
      ? { ...e, last_read_seq: lastReadSeq, unread_count: Math.max(e.last_seq - lastReadSeq, 0) }
      : e,
  );
}

/** Tab badge from the loaded rows (muted and closed chats don't count). */
export function inboxUnreadTotals(entries: readonly InboxEntry[]): { messages: number; channels: number } {
  let messages = 0;
  let channels = 0;
  for (const e of entries) {
    if (e.is_muted || e.is_archived || e.unread_count <= 0) continue;
    messages += e.unread_count;
    channels += 1;
  }
  return { messages, channels };
}

/**
 * Which group chats get a live topic: the most recently active, unmuted, open
 * club/event chats, up to `max`. DMs arrive on the user topic; the rest are
 * refreshed by polling.
 */
export function rankGroupTopics(entries: readonly InboxEntry[], max: number): string[] {
  return sortInbox(entries)
    .filter((e) => e.channel_type !== "DIRECT" && !e.is_muted && !e.is_archived)
    .slice(0, Math.max(0, max))
    .map((e) => e.channel_id);
}

// -----------------------------------------------------------------------------
// Typing
// -----------------------------------------------------------------------------
/** profile_id → expiry (ms since epoch). */
export type TypingState = Readonly<Record<string, number>>;

export function noteTyping(
  state: TypingState,
  payload: unknown,
  nowMs: number,
  allowed: ReadonlySet<string>,
  me: string,
): TypingState {
  if (JSON.stringify(payload ?? null).length > TYPING.maxPayloadBytes) return state;
  const parsed = typingPayloadSchema.safeParse(payload);
  if (!parsed.success) return state;
  const who = parsed.data.profile_id;
  if (who === me || !allowed.has(who)) return state;
  return { ...state, [who]: nowMs + TYPING.expireAfterMs };
}

export const activeTypers = (state: TypingState, nowMs: number): string[] =>
  Object.entries(state)
    .filter(([, until]) => until > nowMs)
    .map(([id]) => id)
    .sort();

/** A message from someone clears their typing indicator at once. */
export function clearTyping(state: TypingState, profileId: string | null): TypingState {
  if (!profileId || !(profileId in state)) return state;
  const { [profileId]: _gone, ...rest } = state;
  return rest;
}

export const shouldSendTyping = (lastSentMs: number | undefined, nowMs: number): boolean =>
  lastSentMs === undefined || nowMs - lastSentMs >= TYPING.sendEveryMs;
