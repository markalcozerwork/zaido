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
  behindLocal,
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

const OFFLINE = {
  code: "RETRYABLE",
  message: "You're offline. We'll keep trying.",
  retryable: true,
} as const;

/** Run an API call; a throw (network) becomes a retryable error result. */
async function safely<T>(call: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: { ...OFFLINE } };
  }
}

// -----------------------------------------------------------------------------
// One conversation
// -----------------------------------------------------------------------------
/**
 * The server actions as the app calls them. They may also throw (a fetch that
 * fails offline); the engines treat that like a retryable error.
 */
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
  /** A read is reported at least this often while messages keep arriving. */
  readMaxWaitMs?: number;
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
  private readPendingSince: number | undefined;
  private safetyTimer: unknown;
  private visible = false;
  /** Bumped when the state is rebuilt from scratch; older in-flight pages are dropped. */
  private generation = 0;

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
    if (next === this.state || this.stopped) return;
    this.state = next;
    this.opts.onChange(next);
  }

  /** Restore the outbox, load the latest page, resume sending. */
  async start(): Promise<ActionResult<void>> {
    const saved = await this.store.load(this.state.channel_id).catch(() => [] as OutboxItem[]);
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

  /**
   * Leave the screen. Reports what was read, cancels timers, and makes any
   * request still in flight a no-op (it must not overwrite the outbox store
   * that a newer instance for this chat may already use).
   */
  stop() {
    if (this.stopped) return;
    this.flushRead();
    this.stopped = true;
    this.clearTimer(this.wakeTimer);
    this.clearTimer(this.readTimer);
    this.clearTimer(this.safetyTimer);
  }

  private async loadLatest(): Promise<ActionResult<void>> {
    const gen = this.generation;
    const res = await safely(() =>
      this.api.getMessages({ channel_id: this.state.channel_id, limit: this.opts.pageSize ?? 50 }),
    );
    if (!res.ok || this.stopped || gen !== this.generation)
      return res.ok ? { ok: true, data: undefined } : res;
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
      const res = await safely(() =>
        this.api.getMessages({
          channel_id: this.state.channel_id,
          after_rev: this.state.cursor_rev ?? 0,
          limit: 200,
        }),
      );
      if (!res.ok || this.stopped) return; // the next hint, resync or safety timer tries again
      this.set(applySyncPage(this.state, res.data));
      if (!res.data.has_more) {
        this.maybeMarkRead();
        return;
      }
    }
    // Far behind (long offline): the latest page is cheaper than replaying
    // every change. Fetch it first and swap only on success, so the screen
    // never goes blank; pages already in flight for the old state are dropped.
    const res = await safely(() =>
      this.api.getMessages({ channel_id: this.state.channel_id, limit: this.opts.pageSize ?? 50 }),
    );
    if (!res.ok || this.stopped) return;
    this.generation++;
    this.set(
      applyLatestPage(
        {
          ...initialConversation(this.state.channel_id),
          outbox: this.state.outbox,
          read_marker: this.state.read_marker,
        },
        res.data,
      ),
    );
    this.maybeMarkRead();
  }

  /** Realtime hints for this conversation. */
  onHints(_hints: readonly MessageHint[]) {
    void this.sync();
  }

  async loadOlder(): Promise<ActionResult<void>> {
    const before = this.state.oldest_seq;
    if (!this.state.has_older || before === null) return { ok: true, data: undefined };
    const gen = this.generation;
    const res = await safely(() =>
      this.api.getMessages({
        channel_id: this.state.channel_id,
        before_seq: before,
        limit: this.opts.pageSize ?? 50,
      }),
    );
    if (!res.ok) return res;
    // The state was rebuilt, or another page already moved the edge: this
    // page would leave a hole.
    if (this.stopped || gen !== this.generation || this.state.oldest_seq !== before)
      return { ok: true, data: undefined };
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

  /** Never rejects; a stopped instance never writes (a newer one may own the store). */
  private async persist(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.store.save(this.state.channel_id, this.state.outbox);
    } catch {
      // Storage full or unavailable: keep sending from memory.
    }
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
        const res = await safely(() =>
          this.api.sendMessage({
            channel_id: item.channel_id,
            client_id: item.client_id,
            ...(item.text !== undefined ? { text: item.text } : {}),
            ...(item.media_path !== undefined ? { media_path: item.media_path } : {}),
            ...(item.media_width !== undefined ? { media_width: item.media_width } : {}),
            ...(item.media_height !== undefined ? { media_height: item.media_height } : {}),
            ...(item.reply_to_id !== undefined ? { reply_to_id: item.reply_to_id } : {}),
          }),
        );
        if (this.stopped) return;
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
    if (!visible) this.flushRead();
    this.visible = visible;
    if (visible) {
      void this.sync();
      this.maybeMarkRead();
    }
  }

  /**
   * Debounced, but reported at least every readMaxWaitMs while messages keep
   * arriving, and never for messages that arrive after the screen is hidden.
   */
  private maybeMarkRead() {
    if (!this.visible || !needsReadUpdate(this.state) || this.stopped) return;
    const now = this.now();
    this.readPendingSince ??= now;
    this.clearTimer(this.readTimer);
    const overdue = now - this.readPendingSince >= (this.opts.readMaxWaitMs ?? 2_000);
    this.readTimer = this.setTimer(
      () => {
        if (this.visible) this.flushRead();
      },
      overdue ? 0 : (this.opts.readDebounceMs ?? 800),
    );
  }

  /** Report what is on screen now (the screen is about to hide, or the timer fired). */
  private flushRead() {
    this.clearTimer(this.readTimer);
    this.readPendingSince = undefined;
    if (!this.visible || this.stopped) return;
    const target = readTarget(this.state);
    if (target <= this.state.read_marker) return;
    void safely(() => this.api.markRead({ channel_id: this.state.channel_id, up_to_seq: target })).then(
      (res) => {
        if (res.ok) this.set(acknowledgeRead(this.state, res.data.last_read_seq));
      },
    );
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
  private refetching = false;
  private pollTimer: unknown;
  private visible = true;
  private stopped = false;
  private hasMore = false;
  private refreshing: Promise<ActionResult<void>> | null = null;
  private refreshAgain = false;

  constructor(
    private readonly api: InboxApi,
    private readonly opts: InboxOptions,
  ) {
    this.setTimer = opts.setTimer ?? realTimers.setTimer;
    this.clearTimer = opts.clearTimer ?? realTimers.clearTimer;
    this.random = opts.random ?? Math.random;
  }

  private get pageSize() {
    return this.opts.pageSize ?? 30;
  }

  private set(entries: InboxEntry[]) {
    if (this.stopped) return;
    this.entries = entries;
    this.opts.onChange(entries);
  }

  private publishTopics() {
    this.opts.onGroupTopics?.(rankGroupTopics(this.entries, this.opts.maxGroupTopics ?? 20));
  }

  /**
   * First page from scratch: on start, (re)join, foreground, joined/left,
   * poll. Single-flight: calls during a refresh collapse into one more run,
   * so responses can't land out of order.
   */
  refresh(): Promise<ActionResult<void>> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      let res: ActionResult<void>;
      do {
        this.refreshAgain = false;
        res = await this.refreshOnce();
      } while (this.refreshAgain && !this.stopped);
      return res;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<ActionResult<void>> {
    const res = await safely(() => this.api.getInbox({ limit: this.pageSize }));
    if (!res.ok || this.stopped) return res.ok ? { ok: true, data: undefined } : res;
    const firstIds = new Set(res.data.map((e) => e.channel_id));
    const last = res.data.at(-1);
    let older: InboxEntry[] = [];
    if (res.data.length >= this.pageSize && last) {
      // A full page: keep the older pages the user scrolled to, but check
      // them again (a chat I was removed from while offline must go).
      older = this.entries.filter((e) => !firstIds.has(e.channel_id) && e.activity_at < last.activity_at);
      this.markStale(older.map((e) => e.channel_id));
    }
    // A short page is the whole inbox: anything else is gone. Rows on the page
    // merge with what hints already told us (counters only move forward).
    this.hasMore = res.data.length >= this.pageSize;
    this.markStale(behindLocal(this.entries, res.data));
    const keep = new Set([...firstIds, ...older.map((e) => e.channel_id)]);
    this.set(
      upsertInbox(
        this.entries.filter((e) => keep.has(e.channel_id)),
        res.data,
      ),
    );
    this.publishTopics();
    return { ok: true, data: undefined };
  }

  async loadMore(): Promise<ActionResult<boolean>> {
    const cursor = nextInboxCursor(this.entries);
    if (!this.hasMore || !cursor) return { ok: true, data: false };
    const res = await safely(() => this.api.getInbox({ limit: this.pageSize, cursor }));
    if (!res.ok) return res;
    this.hasMore = res.data.length >= this.pageSize;
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
        this.publishTopics();
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
    if (hint.reason === "deleted") {
      this.set(removeFromInbox(this.entries, hint.channel_id));
      this.publishTopics();
    } else this.markStale([hint.channel_id]);
  }

  /** My user topic (re)joined: start over. */
  onResync() {
    void this.refresh();
  }

  /** A group topic was refused (probably removed): check just that chat. */
  onTopicLost(channelId: string) {
    this.markStale([channelId]);
  }

  // Narrow refetches ------------------------------------------------------------
  private markStale(ids: readonly string[]) {
    if (!ids.length) return;
    for (const id of ids) this.stale.add(id);
    if (this.visible) this.scheduleRefetch(this.opts.refetchDelayMs ?? 1_500);
  }

  private scheduleRefetch(baseMs: number) {
    if (this.refetchTimer !== undefined || this.refetching || this.stopped) return;
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
    this.refetching = true;
    const res = await safely(() => this.api.getInbox({ channel_ids: ids, limit: ids.length }));
    this.refetching = false;
    if (this.stopped) return;
    if (!res.ok) {
      for (const id of ids) this.stale.add(id);
    } else {
      const found = new Set(res.data.map((e) => e.channel_id));
      // Asked for but not returned: I'm no longer in it (or it's an unsent DM).
      const gone = ids.filter((id) => !found.has(id));
      let next = this.entries.filter((e) => !gone.includes(e.channel_id));
      this.markStale(behindLocal(next, res.data));
      next = upsertInbox(next, res.data);
      this.set(next);
      if (gone.length) this.publishTopics();
    }
    if (this.stale.size && this.visible) this.scheduleRefetch(this.opts.refetchDelayMs ?? 1_500);
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
