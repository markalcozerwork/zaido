/**
 * Live chat (browser/app only). Every event is a hint: the caller refetches
 * through the chat RPCs, so missed, repeated or reordered events can't leave a
 * screen wrong. Resync on every (re)join, on app foreground and when the
 * network comes back.
 *
 *   chat:<id>          one per open conversation, plus the most active group
 *                      chats for the inbox (shared: one channel per topic)
 *   chat:<id>:typing   only while a conversation is open
 *   user:<me>:chat     always, while signed in: DM messages, my joins/leaves,
 *                      my read markers and mutes from other devices
 *
 * supabase-js returns the SAME channel object for the same topic and a channel
 * can be subscribed once, so a reference-counted registry joins each topic
 * once, binds every broadcast event ("*") and dispatches by event name.
 */
import {
  activeTypers,
  CHAT_CHANNELS_PRIVATE,
  CHAT_EVENTS,
  channelHintSchema,
  chatTopic,
  chatTypingTopic,
  clearTyping,
  inboxHintSchema,
  messageHintSchema,
  noteTyping,
  readHintSchema,
  shouldSendTyping,
  TYPING,
  userChatTopic,
  type ChannelHint,
  type InboxHint,
  type MessageHint,
  type ReadHint,
  type TypingState,
} from "../domain/chat";
import type { RealtimeClient, SlotChannelStatus } from "./court-slots";
import { channelsAvailable, noteChannelClosed, noteChannelOpened } from "./realtime-budget";

type Channel = ReturnType<RealtimeClient["channel"]>;
export type ChannelStatus = SlotChannelStatus;

interface TopicListener {
  onEvent(event: string, payload: unknown): void;
  onStatus?(status: ChannelStatus, error?: Error): void;
  /** (Re)joined: whatever was missed meanwhile must be refetched. */
  onJoin?(): void;
}

interface Entry {
  channel: Channel;
  listeners: Set<TopicListener>;
  subscribed: boolean;
}

const registries = new WeakMap<RealtimeClient, Map<string, Entry>>();

/** Live chat topics for a client (diagnostics and tests). */
export function activeChatTopics(client: RealtimeClient): string[] {
  return [...(registries.get(client)?.keys() ?? [])];
}

interface TopicHandle {
  unsubscribe(): void;
  /** Client-sent broadcast (typing only; the database refuses sends anywhere else). */
  send(event: string, payload: Record<string, unknown>): void;
  isSubscribed(): boolean;
}

function subscribeTopic(client: RealtimeClient, topic: string, listener: TopicListener): TopicHandle {
  let registry = registries.get(client);
  if (!registry) {
    registry = new Map();
    registries.set(client, registry);
  }
  let entry = registry.get(topic);
  if (!entry) {
    const created: Entry = {
      channel: client.channel(topic, { config: { private: CHAT_CHANNELS_PRIVATE } }),
      listeners: new Set(),
      subscribed: false,
    };
    created.channel
      .on("broadcast", { event: "*" }, (message: { event?: string; payload?: unknown }) => {
        for (const l of created.listeners) l.onEvent(message.event ?? "", message.payload);
      })
      .subscribe((status: ChannelStatus, error?: Error) => {
        created.subscribed = status === "SUBSCRIBED";
        for (const l of created.listeners) {
          l.onStatus?.(status, error);
          if (status === "SUBSCRIBED") l.onJoin?.();
        }
      });
    registry.set(topic, created);
    noteChannelOpened(client, topic);
    entry = created;
  } else if (entry.subscribed) {
    // Joined before this listener arrived: it still needs its initial fetch.
    const joined = entry;
    queueMicrotask(() => {
      if (joined.listeners.has(listener)) listener.onJoin?.();
    });
  }
  entry.listeners.add(listener);
  const mine = entry;

  let active = true;
  return {
    unsubscribe() {
      if (!active) return;
      active = false;
      const current = registry!.get(topic);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        registry!.delete(topic);
        noteChannelClosed(client, topic);
        void client.removeChannel(current.channel);
      }
    },
    send(event, payload) {
      if (active && mine.subscribed) void mine.channel.send({ type: "broadcast", event, payload });
    },
    isSubscribed: () => active && mine.subscribed,
  };
}

/** Collects hints for `ms` and delivers them together (a burst becomes one refetch). */
function batcher<T>(ms: number, deliver: (items: T[]) => void) {
  let items: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    push(item: T) {
      items.push(item);
      timer ??= setTimeout(() => {
        const out = items;
        items = [];
        timer = undefined;
        deliver(out);
      }, ms);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      items = [];
    },
  };
}

// -----------------------------------------------------------------------------
// An open conversation
// -----------------------------------------------------------------------------
export interface ConversationListener {
  /** New, edited or deleted messages (a batch): run a catch-up sync. */
  onMessages(hints: MessageHint[]): void;
  /** DMs: the other person's read marker moved ("Seen"). */
  onRead?(hint: ReadHint): void;
  /** Renamed, closed (archived) or deleted. */
  onChannel?(hint: ChannelHint): void;
  /** (Re)joined: catch up from the cursor. */
  onResync(): void;
  onStatus?(status: ChannelStatus, error?: Error): void;
}

export function subscribeToConversation(
  client: RealtimeClient,
  channelId: string,
  listener: ConversationListener,
  opts: { debounceMs?: number } = {},
): () => void {
  const messages = batcher<MessageHint>(opts.debounceMs ?? 150, (hints) => listener.onMessages(hints));
  const handle = subscribeTopic(client, chatTopic(channelId), {
    onEvent(event, payload) {
      if (event === CHAT_EVENTS.message) {
        const h = messageHintSchema.safeParse(payload);
        if (h.success) messages.push(h.data);
      } else if (event === CHAT_EVENTS.read) {
        const h = readHintSchema.safeParse(payload);
        if (h.success) listener.onRead?.(h.data);
      } else if (event === CHAT_EVENTS.channel) {
        const h = channelHintSchema.safeParse(payload);
        if (h.success) listener.onChannel?.(h.data);
      }
    },
    onStatus: (status, error) => listener.onStatus?.(status, error),
    onJoin: () => listener.onResync(),
  });
  return () => {
    messages.cancel();
    handle.unsubscribe();
  };
}

// -----------------------------------------------------------------------------
// Typing indicators
// -----------------------------------------------------------------------------
export interface TypingOptions {
  /** Participants (minus blocked people) whose typing may be shown. */
  allowed(): ReadonlySet<string>;
  onChange(typers: string[]): void;
  now?: () => number;
}

export interface TypingHandle {
  /** Call on every keystroke; sends at most one event per TYPING.sendEveryMs. */
  notifyTyping(): void;
  /** Their message arrived: stop showing them as typing. */
  clear(profileId: string | null): void;
  stop(): void;
}

export function joinTyping(
  client: RealtimeClient,
  channelId: string,
  me: string,
  opts: TypingOptions,
): TypingHandle {
  const now = opts.now ?? Date.now;
  let state: TypingState = {};
  let lastSent: number | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let shown: string[] = [];

  const publish = () => {
    const typers = activeTypers(state, now());
    if (typers.join() !== shown.join()) {
      shown = typers;
      opts.onChange(typers);
    }
    clearTimeout(expiry);
    const next = Math.min(...Object.values(state).filter((t) => t > now()));
    expiry = Number.isFinite(next) ? setTimeout(publish, next - now() + 1) : undefined;
  };

  const handle = subscribeTopic(client, chatTypingTopic(channelId), {
    onEvent(event, payload) {
      if (event !== CHAT_EVENTS.typing) return;
      state = noteTyping(state, payload, now(), opts.allowed(), me);
      publish();
    },
  });

  return {
    notifyTyping() {
      if (!handle.isSubscribed() || !shouldSendTyping(lastSent, now())) return;
      lastSent = now();
      handle.send(CHAT_EVENTS.typing, { profile_id: me });
    },
    clear(profileId) {
      state = clearTyping(state, profileId);
      publish();
    },
    stop() {
      clearTimeout(expiry);
      handle.unsubscribe();
    },
  };
}

export { TYPING };

// -----------------------------------------------------------------------------
// The inbox
// -----------------------------------------------------------------------------
export interface InboxListener {
  /** A message in any of my chats (group topics, or DMs via my user topic). */
  onMessage(hint: MessageHint): void;
  /** My joins/leaves, and my read markers and mutes from other devices. */
  onInbox(hint: InboxHint): void;
  onChannel(hint: ChannelHint): void;
  /** My user topic (re)joined: refetch the inbox. */
  onResync(): void;
  /** A group topic was refused or dropped (e.g. I was removed): refetch the inbox. */
  onTopicLost?(channelId: string): void;
}

export interface InboxOptions {
  /** Live topics for the most active group chats; the rest are polled. */
  maxGroupTopics?: number;
  /** Joins are spread out (reconnect storms hit the project-wide joins/s quota). */
  joinBatch?: number;
  joinIntervalMs?: number;
}

export interface InboxSubscription {
  /** Ranked group chat ids (rankGroupTopics); call after every inbox fetch. */
  setGroupChannels(rankedChannelIds: readonly string[]): void;
  /** Group chats currently joined live. */
  liveGroupChannels(): string[];
  stop(): void;
}

export function subscribeToInbox(
  client: RealtimeClient,
  me: string,
  listener: InboxListener,
  opts: InboxOptions = {},
): InboxSubscription {
  const maxGroup = opts.maxGroupTopics ?? 20;
  const joinBatch = opts.joinBatch ?? 5;
  const joinIntervalMs = opts.joinIntervalMs ?? 100;
  const groups = new Map<string, TopicHandle>();
  let pending: string[] = [];
  let joinTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const user = subscribeTopic(client, userChatTopic(me), {
    onEvent(event, payload) {
      if (event !== CHAT_EVENTS.inbox) return;
      const h = inboxHintSchema.safeParse(payload);
      if (!h.success) return;
      if (h.data.reason === "message") {
        const m = messageHintSchema.safeParse(payload);
        if (m.success) listener.onMessage(m.data);
      } else {
        listener.onInbox(h.data);
      }
    },
    onJoin: () => listener.onResync(),
  });

  const joinGroup = (channelId: string) => {
    const handle = subscribeTopic(client, chatTopic(channelId), {
      onEvent(event, payload) {
        if (event === CHAT_EVENTS.message) {
          const h = messageHintSchema.safeParse(payload);
          if (h.success) listener.onMessage(h.data);
        } else if (event === CHAT_EVENTS.channel) {
          const h = channelHintSchema.safeParse(payload);
          if (h.success) listener.onChannel(h.data);
        }
      },
      onStatus(status) {
        // Don't let supabase-js retry a refused join forever: drop it and let
        // the next inbox fetch decide whether it belongs here.
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          groups.get(channelId)?.unsubscribe();
          groups.delete(channelId);
          listener.onTopicLost?.(channelId);
        }
      },
    });
    groups.set(channelId, handle);
  };

  const drain = () => {
    joinTimer = undefined;
    if (stopped) return;
    for (const id of pending.splice(0, joinBatch)) {
      if (!groups.has(id)) joinGroup(id);
    }
    if (pending.length) joinTimer = setTimeout(drain, joinIntervalMs);
  };

  return {
    setGroupChannels(ranked) {
      if (stopped) return;
      // My own group topics don't count against what is left for me.
      const cap = Math.min(maxGroup, channelsAvailable(client) + groups.size);
      const wanted = new Set(ranked.slice(0, Math.max(0, cap)));
      for (const [id, handle] of groups) {
        if (!wanted.has(id)) {
          handle.unsubscribe();
          groups.delete(id);
        }
      }
      pending = [...wanted].filter((id) => !groups.has(id));
      if (pending.length && joinTimer === undefined) drain();
    },
    liveGroupChannels: () => [...groups.keys()],
    stop() {
      stopped = true;
      clearTimeout(joinTimer);
      pending = [];
      for (const handle of groups.values()) handle.unsubscribe();
      groups.clear();
      user.unsubscribe();
    },
  };
}
