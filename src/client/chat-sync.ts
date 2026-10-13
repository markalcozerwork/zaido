/**
 * Chat sync engines (browser/app). They hold the state for one conversation
 * and for the inbox, turn realtime hints into refetches, and keep the outbox
 * going, so screens only render state and forward user actions.
 *
 * Correctness never depends on realtime: the conversation catches up by rev
 * on (re)join, on foreground/online and every `safetySyncMs`; the inbox is
 * refetched on (re)join and polled for chats without a live topic.
 *
 * I/O is injected (the server actions, wrapped by the app's API layer), so
 * the engines run in tests with fakes and fake timers.
 */
import {
  acknowledgeRead,
  applyLatestPage,
  applyMessageHintToInbox,
  applyOlderPage,
  applyReadToInbox,
  applySyncPage,
  discardOutboxItem,
  enqueueMessage,
  initialConversation,
  markSendFailed,
  markSending,
  markSent,
  needsReadUpdate,
  nextInboxCursor,
  nextToSend,
  outboxWakeAt,
  rankGroupTopics,
  readTarget,
  removeFromInbox,
  retryOutboxItem,
  upsertInbox,
  type ActionResult,
  type ChannelHint,
  type ChatMessage,
  type ConversationState,
  type InboxEntry,
  type InboxHint,
  type InboxQuery,
  type MessageHint,
  type MessagesPage,
  type MessagesQuery,
  type OutboxItem,
  type SendMessageInput,
} from "../domain";

interface Timers {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}

const realTimers: Required<Pick<Timers, "setTimer" | "clearTimer">> = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

// -----------------------------------------------------------------------------
// One conversation
// -----------------------------------------------------------------------------
export interface ConversationApi {
  getMessages(query: MessagesQuery): Promise<ActionResult<MessagesPage>>;
  sendMessage(input: SendMessageInput): Promise<ActionResult<ChatMessage>>;
  markRead(input: {
    channel_id: string;
    up_to_seq: number;
  }): Promise<ActionResult<{ last_read_seq: number }>>;
}

/** Pending messages survive an app kill, so a retry reuses the same client_id. */
export interface OutboxStore {
  load(channelId: string): Promise<OutboxItem[]>;
  save(channelId: string, items: readonly OutboxItem[]): Promise<void>;
}

export const memoryOutboxStore = (): OutboxStore => {
  const data = new Map<string, OutboxItem[]>();
  return {
    load: async (id) => [...(data.get(id) ?? [])],
    save: async (id, items) => void data.set(id, [...items]),
  };
};

export interface ConversationOptions extends Timers {
  onChange(state: ConversationState): void;
  store?: OutboxStore;
  newClientId?: () => string;
  /** Catch-up even without hints (lost broadcasts, sleeping sockets). */
  safetySyncMs?: number;
  readDebounceMs?: number;
  /** Sync pages per catch-up before falling back to reloading the latest page. */
  maxSyncPages?: number;
  pageSize?: number;
}

export class ConversationSync {
  state: ConversationState;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<Timers["setTimer"]>;
  private readonly clearTimer: NonNullable<Timers["clearTimer"]>;
  private readonly store: OutboxStore;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private pumping = false;
  private stopped = false;
  private wakeTimer: unknown;
  private readTimer: unknown;
  private safetyTimer: unknown;
  private visible = false;

  constructor(
    private readonly api: ConversationApi,
    channelId: string,
    private readonly opts: ConversationOptions,
  ) {
    this.state = initialConversation(channelId);
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? realTimers.setTimer;
    this.clearTimer = opts.clearTimer ?? realTimers.clearTimer;
    this.store = opts.store ?? memoryOutboxStore();
  }

  private set(next: ConversationState) {
    if (next === this.state) return;
    this.state = next;
    this.opts.onChange(next);
  }

  /** Restore the outbox, load the latest page, resume sending. */
  async start(): Promise<ActionResult<void>> {
    const saved = await this.store.load(this.state.channel_id);
    let s = this.state;
    for (const item of saved) {
      const { status: _s, attempts: _a, channel_id: _c, ...rest } = item;
      s = enqueueMessage(s, rest);
    }
    this.set(s);
    const res = await this.loadLatest();
    this.scheduleSafetySync();
    void this.pump();
    return res;
  }

  stop() {
    this.stopped = true;
    this.clearTimer(this.wakeTimer);
    this.clearTimer(this.readTimer);
    this.clearTimer(this.safetyTimer);
  }

  private async loadLatest(): Promise<ActionResult<void>> {
    const res = await this.api.getMessages({
      channel_id: this.state.channel_id,
      limit: this.opts.pageSize ?? 50,
    });
    if (!res.ok) return res;
    this.set(applyLatestPage(this.state, res.data));
    this.maybeMarkRead();
    return { ok: true, data: undefined };
  }

  /**
   * Catch up from the cursor (hints, (re)join, foreground, online). Calls
   * while one runs coalesce into one more run.
   */
  sync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.syncAgain = false;
        await this.syncOnce();
      } while (this.syncAgain && !this.stopped);
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    if (this.state.cursor_rev === null) {
      await this.loadLatest();
      return;
    }
    for (let i = 0; i < (this.opts.maxSyncPages ?? 5); i++) {
      if (this.stopped) return;
      const res = await this.api.getMessages({
        channel_id: this.state.channel_id,
        after_rev: this.state.cursor_rev ?? 0,
        limit: 200,
      });
      if (!res.ok) return; // the next hint, resync or safety timer tries again
      this.set(applySyncPage(this.state, res.data));
      if (!res.data.has_more) {
        this.maybeMarkRead();
        return;
      }
    }
    // Far behind (long offline): the latest page is cheaper than replaying every change.
    this.set({
      ...initialConversation(this.state.channel_id),
      outbox: this.state.outbox,
      read_marker: this.state.read_marker,
    });
    await this.loadLatest();
  }

  /** Realtime hints for this conversation. */
  onHints(_hints: readonly MessageHint[]) {
    void this.sync();
  }

  async loadOlder(): Promise<ActionResult<void>> {
    if (!this.state.has_older || this.state.oldest_seq === null) return { ok: true, data: undefined };
    const res = await this.api.getMessages({
      channel_id: this.state.channel_id,
      before_seq: this.state.oldest_seq,
      limit: this.opts.pageSize ?? 50,
    });
    if (!res.ok) return res;
    this.set(applyOlderPage(this.state, res.data));
    return { ok: true, data: undefined };
  }

  private scheduleSafetySync() {
    const every = this.opts.safetySyncMs ?? 45_000;
    if (every <= 0 || this.stopped) return;
    this.safetyTimer = this.setTimer(() => {
      if (this.visible) void this.sync();
      this.scheduleSafetySync();
    }, every);
  }

  // Sending ---------------------------------------------------------------------
  /** Queue a message (shown at once as pending) and send it in order. */
  send(
    input: Omit<OutboxItem, "client_id" | "channel_id" | "queued_at" | "status" | "attempts"> & {
      client_id?: string;
    },
  ): string {
    const clientId = input.client_id ?? (this.opts.newClientId ?? (() => crypto.randomUUID()))();
    this.set(
      enqueueMessage(this.state, {
        ...input,
        client_id: clientId,
        queued_at: new Date(this.now()).toISOString(),
      }),
    );
    void this.persist().then(() => this.pump());
    return clientId;
  }

  retry(clientId: string) {
    this.set(retryOutboxItem(this.state, clientId));
    void this.persist().then(() => this.pump());
  }

  discard(clientId: string) {
    this.set(discardOutboxItem(this.state, clientId));
    void this.persist().then(() => this.pump());
  }

  private persist() {
    return this.store.save(this.state.channel_id, this.state.outbox);
  }

  /** Send queued messages one at a time, in order. */
  async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      for (;;) {
        const item = nextToSend(this.state, this.now());
        if (!item || this.stopped) break;
        this.set(markSending(this.state, item.client_id));
        await this.persist();
        const res = await this.api.sendMessage({
          channel_id: item.channel_id,
          client_id: item.client_id,
          ...(item.text !== undefined ? { text: item.text } : {}),
          ...(item.media_path !== undefined ? { media_path: item.media_path } : {}),
          ...(item.media_width !== undefined ? { media_width: item.media_width } : {}),
          ...(item.media_height !== undefined ? { media_height: item.media_height } : {}),
          ...(item.reply_to_id !== undefined ? { reply_to_id: item.reply_to_id } : {}),
        });
        this.set(
          res.ok
            ? markSent(this.state, res.data)
            : markSendFailed(this.state, item.client_id, res.error, this.now()),
        );
        await this.persist();
        if (res.ok) this.maybeMarkRead();
      }
    } finally {
      this.pumping = false;
    }
    const wake = outboxWakeAt(this.state);
    this.clearTimer(this.wakeTimer);
    if (wake !== undefined && !this.stopped) {
      this.wakeTimer = this.setTimer(() => void this.pump(), Math.max(0, wake - this.now()));
    }
  }

  // Read marker -------------------------------------------------------------------
  /** The conversation is on screen (scrolled to the bottom): report what was seen. */
  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) {
      void this.sync();
      this.maybeMarkRead();
    }
  }

  private maybeMarkRead() {
    if (!this.visible || !needsReadUpdate(this.state) || this.stopped) return;
    this.clearTimer(this.readTimer);
    this.readTimer = this.setTimer(async () => {
      const target = readTarget(this.state);
      if (target <= this.state.read_marker) return;
      const res = await this.api.markRead({ channel_id: this.state.channel_id, up_to_seq: target });
      if (res.ok) this.set(acknowledgeRead(this.state, res.data.last_read_seq));
    }, this.opts.readDebounceMs ?? 800);
  }
}

// -----------------------------------------------------------------------------
// The inbox
// -----------------------------------------------------------------------------
export interface InboxApi {
  getInbox(query: InboxQuery): Promise<ActionResult<InboxEntry[]>>;
}

export interface InboxOptions extends Timers {
  me: string;
  onChange(entries: InboxEntry[]): void;
  /** Group chats to keep live (pass to subscribeToInbox().setGroupChannels). */
  onGroupTopics?(rankedChannelIds: string[]): void;
  /** Batch window for preview refetches, plus random jitter so a club's members don't refetch in lockstep. */
  refetchDelayMs?: number;
  refetchJitterMs?: number;
  /** While visible: refetch the first page this often (chats without a live topic). */
  pollMs?: number;
  pageSize?: number;
  maxGroupTopics?: number;
}

export class InboxSync {
  entries: InboxEntry[] = [];
  private readonly setTimer: NonNullable<Timers["setTimer"]>;
  private readonly clearTimer: NonNullable<Timers["clearTimer"]>;
  private readonly random: () => number;
  private stale = new Set<string>();
  private refetchTimer: unknown;
  private pollTimer: unknown;
  private visible = true;
  private stopped = false;
  private hasMore = false;

  constructor(
    private readonly api: InboxApi,
    private readonly opts: InboxOptions,
  ) {
    this.setTimer = opts.setTimer ?? realTimers.setTimer;
    this.clearTimer = opts.clearTimer ?? realTimers.clearTimer;
    this.random = opts.random ?? Math.random;
  }

  private set(entries: InboxEntry[]) {
    this.entries = entries;
    this.opts.onChange(entries);
  }

  /** First page from scratch: on start, (re)join, foreground, joined/left, poll. */
  async refresh(): Promise<ActionResult<void>> {
    const res = await this.api.getInbox({ limit: this.opts.pageSize ?? 30 });
    if (!res.ok) return res;
    // Keep older pages the user scrolled to; replace the first page.
    const firstIds = new Set(res.data.map((e) => e.channel_id));
    const last = res.data.at(-1);
    const older = last
      ? this.entries.filter((e) => !firstIds.has(e.channel_id) && e.activity_at < last.activity_at)
      : [];
    this.hasMore = res.data.length >= (this.opts.pageSize ?? 30);
    this.set(upsertInbox(older, res.data));
    this.opts.onGroupTopics?.(rankGroupTopics(this.entries, this.opts.maxGroupTopics ?? 20));
    return { ok: true, data: undefined };
  }

  async loadMore(): Promise<ActionResult<boolean>> {
    const cursor = nextInboxCursor(this.entries);
    if (!this.hasMore || !cursor) return { ok: true, data: false };
    const res = await this.api.getInbox({ limit: this.opts.pageSize ?? 30, cursor });
    if (!res.ok) return res;
    this.hasMore = res.data.length >= (this.opts.pageSize ?? 30);
    this.set(upsertInbox(this.entries, res.data));
    return { ok: true, data: this.hasMore };
  }

  start() {
    void this.refresh();
    this.schedulePoll();
  }

  stop() {
    this.stopped = true;
    this.clearTimer(this.refetchTimer);
    this.clearTimer(this.pollTimer);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible && this.stale.size) this.scheduleRefetch(0);
  }

  // Hints -------------------------------------------------------------------------
  onMessage(hint: MessageHint) {
    const r = applyMessageHintToInbox(this.entries, hint, this.opts.me);
    this.set(r.entries);
    this.markStale(r.refetch);
  }

  onInbox(hint: InboxHint) {
    switch (hint.reason) {
      case "left":
        this.set(removeFromInbox(this.entries, hint.channel_id));
        break;
      case "read":
        if (hint.last_read_seq !== undefined)
          this.set(applyReadToInbox(this.entries, hint.channel_id, hint.last_read_seq));
        break;
      default: // joined, muted, message
        this.markStale([hint.channel_id]);
    }
  }

  onChannel(hint: ChannelHint) {
    if (hint.reason === "deleted") this.set(removeFromInbox(this.entries, hint.channel_id));
    else this.markStale([hint.channel_id]);
  }

  /** My user topic (re)joined, or a group topic was lost: start over. */
  onResync() {
    void this.refresh();
  }

  // Narrow refetches ------------------------------------------------------------
  private markStale(ids: readonly string[]) {
    if (!ids.length) return;
    for (const id of ids) this.stale.add(id);
    if (this.visible) this.scheduleRefetch(this.opts.refetchDelayMs ?? 1_500);
  }

  private scheduleRefetch(baseMs: number) {
    if (this.refetchTimer !== undefined || this.stopped) return;
    const delay = baseMs + this.random() * (this.opts.refetchJitterMs ?? 2_000);
    this.refetchTimer = this.setTimer(() => {
      this.refetchTimer = undefined;
      void this.refetchStale();
    }, delay);
  }

  private async refetchStale() {
    const ids = [...this.stale].slice(0, 50);
    if (!ids.length || this.stopped) return;
    for (const id of ids) this.stale.delete(id);
    const res = await this.api.getInbox({ channel_ids: ids });
    if (!res.ok) {
      for (const id of ids) this.stale.add(id);
      return;
    }
    const found = new Set(res.data.map((e) => e.channel_id));
    // Asked for but not returned: I'm no longer in it (or it's an unsent DM).
    let next = this.entries.filter((e) => !ids.includes(e.channel_id) || found.has(e.channel_id));
    next = upsertInbox(next, res.data);
    this.set(next);
    if (this.stale.size) this.scheduleRefetch(this.opts.refetchDelayMs ?? 1_500);
  }

  private schedulePoll() {
    const every = this.opts.pollMs ?? 45_000;
    if (every <= 0 || this.stopped) return;
    this.pollTimer = this.setTimer(() => {
      if (this.visible) void this.refresh();
      this.schedulePoll();
    }, every);
  }
}
