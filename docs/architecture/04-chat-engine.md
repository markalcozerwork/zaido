# RacketHub · Step 4 · Real-time chat engine

> Club, event and direct chats with gapless per-chat ordering, free unread
> counts, retry-safe sends, Broadcast hints instead of per-row Postgres
> Changes, blocks, reports and a media lifecycle. The client sync engines
> keep a conversation and the inbox correct even when realtime messages are
> lost.

| | |
|---|---|
| Database | `supabase/migrations/20261013001100_chat_engine.sql` (builds on `0800_chat`) |
| Server actions | `src/server/chat/` (server-only; every action takes the caller's Supabase client) |
| Shared logic | `src/domain/chat.ts` (schemas, topics, limits, pure state updates), `errors.ts` |
| Client | `src/client/chat-realtime.ts` (subscriptions), `chat-sync.ts` (ConversationSync, InboxSync), `realtime-budget.ts` |
| Media purge job | `supabase/functions/purge-chat-media/` (Edge Function, service role) |
| Tests | SQL suite + races (`npm run db:verify`) · unit (`npm test`) · contract (`npm run test:contract`) · integration through PostgREST 13 (`npm run test:integration`) |

---

## 1. The flow

```
 player                       server action / client          Postgres (RLS + guards)
 ──────                       ──────────────────────          ───────────────────────
 open inbox  ───────────────▶ getInbox ───────────────────▶ get_chat_inbox        (unread = last_seq − last_read_seq)
 subscribe user:<me>:chat + up to 20 chat:<id> (most active groups); the rest are polled
 open chat   ───────────────▶ getMessages ────────────────▶ get_chat_messages     (latest page, cursor_rev)
 subscribe chat:<id> ◀───────────── `message` hint {seq, rev, op} → sync(after_rev = cursor)
 type "Laro tayo 6pm?"
   client_id = uuid once ───▶ sendMessage ──── retry ─────▶ send_chat_message(channel, client_id, …)
                                                              guard → lock channel → seq/rev → hints
              ◀──────────────  the message (or a typed refusal)
 scroll to the bottom ──────▶ markRead(up_to_seq) ─────────▶ mark_chat_read       (forward only, clamped)
```

Nothing above trusts the client. The database sets the message id, sender,
seq, rev and timestamps, checks every send and edit, and shapes what each
caller may read. TypeScript validates requests, keeps local state and
decides when to refetch.

## 2. Ordering: `seq` and `rev`

Every message gets two per-chat numbers, assigned by the
`chat_messages_20_sequence` trigger under the chat's row lock
(`FOR NO KEY UPDATE` on `chat_channels`), which is held until commit:

* **`seq`**: the message's position. Seq order is commit order, and seq has
  no gaps, so history pages are keyset on `(channel_id, seq)`.
* **`rev`**: the last change. A send, an edit (text or media) and a delete
  each take the next rev. Clients catch up with "everything where
  `rev > my cursor`".

`created_at` can't do this job. It is the transaction's start time, so a slow
sender commits "in the past", behind a cursor that has already moved on.
Race 11 shows it: 16 senders, 8 of them slow. A `seq` cursor saw all 16, a
`created_at` cursor saw 5.

`get_chat_messages` returns rows and `last_seq`/`last_rev` from one
snapshot, in three modes:

* latest page;
* `before_seq` (older history);
* `after_seq` / `after_rev` (catch-up).

So the cursor never runs ahead of the rows. Race 16 polls by rev under RLS
while 8 sends, 6 slow edits and 2 deletes run, and checks every change was
seen at its final rev.

## 3. Unread counts and read markers

`unread = chat_channels.last_seq − chat_participants.last_read_seq`. It is
two integer columns, so there is no count query, and the inbox costs one
page of rows.

* **Forward only.** `mark_chat_read(channel, up_to_seq)` and the participants
  guard never move a marker back, and clamp it to `last_seq`. Two devices
  racing end at the highest position (race 14).
* **`up_to_seq` is required.** The client sends the highest seq it actually
  showed, never "whatever is latest". A message that arrives as the user
  leaves stays unread.
* **Joiners start caught up.** The marker defaults to −1, and a BEFORE INSERT
  trigger replaces it with the chat's `last_seq`. A new club member doesn't
  start with 2,000 unread.
* **Your own message** moves your marker quietly (no hint to yourself).
* **Read receipts** ("Seen") exist only in DMs: the `read` hint and
  `partner_last_read_seq`, hidden while either side has blocked the other.
  Group chats have no per-person receipts.

## 4. Sending: `send_chat_message`

```sql
public.send_chat_message(p_channel_id, p_client_id,
                         p_text, p_media_path, p_reply_to_id, p_media_width, p_media_height)
  returns public.chat_messages
```

* **SECURITY INVOKER.** RLS and the guard apply as the caller (the schema lint
  keeps it that way).
* **Idempotent per (sender, `client_id`).** The client makes one key per
  message and keeps it in the outbox, which survives app kills. A retry after
  a lost response returns the message the first attempt created (race 12:
  24 double-taps → 1 row, one id, no seq gap).
  * Twins queue on an advisory lock (`rackethub:chat-idem:<sender>:<key>`),
    then look the key up, then do a plain INSERT.
  * A replay returns the same row, even if it was edited or deleted since.
  * The same key with different content, or in another chat, is
    `IDEMPOTENCY_KEY_REUSED`.
* **No `ON CONFLICT`.** BEFORE triggers run before the conflict check, so a
  skipped row would still have taken a seq. That would leave a gap and a
  phantom unread message. The guard also refuses a reused key (`23505`)
  *before* the counter moves, so even a raw PostgREST upsert with
  `ignore-duplicates` can't burn seqs (review finding SQL-1/SEC-1).
* **Direct inserts are narrow.** Users hold column-level INSERT on the message
  columns only: `channel_id`, `client_id`, `message_text`, `media_url`,
  `reply_to_id`, `media_width`, `media_height`. They can't set the id,
  sender, counters or timestamps.

### Refusals

Rules raise `"CODE: human message"`, as in Step 3. `mapDatabaseError()`
turns them into a `DomainError` with the form field. The contract test
scrapes every prefix and fails if TypeScript doesn't know one.

| Code | Raised when |
|---|---|
| `NOT_A_PARTICIPANT` | not signed in, or not in this chat (also for edits after leaving) |
| `MESSAGING_UNAVAILABLE` | a block between the two people in a DM. The same neutral text on both sides, so nobody learns who blocked whom |
| `RATE_LIMITED` | more than 20 messages in 30 seconds by one sender, across all chats. `HINT` carries the seconds to wait → `meta.retryAfterSeconds` |
| `MESSAGE_EMPTY` | no text (after trimming) and no media |
| `INVALID_MEDIA` | media path not `<channel>/<me>/<client_id>.<ext>`, the file isn't uploaded, or the type isn't allowed |
| `MEDIA_EXPIRED` | the upload is more than 20 hours old (attach it again) |
| `REPLY_NOT_IN_CHANNEL` | replying to a message from another chat |
| `MESSAGE_DELETED` | editing or deleting a deleted message (a retried delete counts as done) |
| `EDIT_WINDOW_PASSED` | editing more than 15 minutes after sending |
| `CHANNEL_ARCHIVED` | sending to, or editing in, a closed event chat (deletes are still allowed) |
| `IDEMPOTENCY_KEY_REUSED` | §4 |

The rate limit counts under an advisory lock on the sender
(`rackethub:chat-rate:<uid>`), so 40 parallel sends across 4 chats accept
exactly 20 (race 13).

## 5. Trust model

| Piece | Security | Why |
|---|---|---|
| `chat_messages_10_guard`, participants `_20_guard` | INVOKER | `app.is_trusted_context()` is true inside DEFINER code, so a DEFINER guard would trust everyone |
| `chat_messages_20_sequence` | DEFINER | locks and bumps the chat row the caller can't update; never asks who is calling |
| `chat_messages_80_after`, participants `_80_hints`, channel `_80/_81` | DEFINER | marker moves, purge queue, `realtime.send` |
| `send_chat_message`, `get_chat_messages` | INVOKER | RLS decides |
| `get_chat_inbox`, `mark_chat_read`, `list_chat_participants`, `report_chat_message` | DEFINER | restricted to the caller's own chats inside the function |

Trigger names fix the order (`_10_guard` validates before `_20_sequence`
takes the lock). The schema lint and `scripts/post-deploy-check.sql` both
check the INVOKER/DEFINER split.

Updates the guard lets through untouched: foreign-key null-outs (an account
deletion sets `sender_id`/`deleted_by` to NULL). They take no rev, no locks
and send no hints.

## 6. Membership (fixes to 0800)

Membership is still derived by triggers (01-database §5). Step 4 changes:

* **DMs are private until the first message.** `get_or_create_direct_channel`
  adds only the opener. The other person joins, with their marker at
  `last_seq`, when the first message is sent. Opening someone's profile
  doesn't put an empty thread in their inbox. An existing thread still opens
  when blocked (so history stays readable); a new one is refused.
* **A replaced organiser or coach** leaves the event chat.
* **Ex-members** still see and delete their own messages (and only those).
* **Account deletion** no longer fails on the guard (§5).

## 7. Realtime: Broadcast hints

The chat tables left the `supabase_realtime` publication. Postgres Changes
runs RLS for every subscriber on every change, which doesn't scale to
club-sized chats. Triggers send Broadcast messages from the database
instead. Payloads are **metadata hints**, never content: clients refetch
through the RLS-checked RPCs, so a missed, repeated or reordered hint can't
leave them wrong.

| Topic | Who | Events |
|---|---|---|
| `chat:<channel_id>` | participants and moderators **receive**; nobody sends | `message` {channel_id, message_id, seq, rev, op, sender_id, created_at} · `read` {profile_id, last_read_seq} (DMs only) · `channel` {reason: updated, archived, deleted} |
| `chat:<channel_id>:typing` | participants send and receive (not across a DM block) | `typing` {profile_id} |
| `user:<profile_id>:chat` | that user **receives** | `inbox` {channel_id, reason}: DM messages, own joins/leaves, own marker and mute moves from other devices |

* Policies match topics with an anchored regex and `app.try_uuid()`, so a
  malformed topic is denied and can't make other joins error.
* `chat:<id>:typing` is the only topic a client can send on. No INSERT policy
  exists for the others, so `message`, `read` and `channel` can't be forged.
* **Cost:** a group message is one `realtime.send`; a DM is three (chat topic
  and both user topics).
* **Bulk paths send nothing.** The archive job sets `rackethub.chat_bulk`,
  and the rows a deleted chat cascades to find no chat and stay quiet.
  Clients resync on (re)join instead. Deleting a club sends one `channel`
  hint, not one per member.
* **A removed member** keeps no content access. Until Realtime re-authorizes
  their channel (token refresh), they see at most metadata hints.

### Client subscriptions (`chat-realtime.ts`)

* One Realtime connection carries every channel the app opens, and Supabase
  caps it at 100. `realtime-budget.ts` tracks all of them, court grids
  included, and keeps 12 in reserve for screens.
* A ref-counted registry shares one channel per topic between components.
* `subscribeToConversation` batches hints over 150 ms.
* `subscribeToInbox` joins the user topic and live topics for the **20 most
  active group chats** (`rankGroupTopics`), within the budget. The rest are
  polled.
  * Joins are staggered (5 every 100 ms), because reconnect storms hit the
    project's joins-per-second quota.
  * A **refused** join (removed from the chat) is told apart from a dropped
    socket by realtime-js's error text. A refused topic is backed off for
    30 s, doubling to 10 minutes, and the inbox refetches.
  * Three timeouts drop a topic.

## 8. Client sync engines (`chat-sync.ts`)

Both engines take the server actions as injected I/O, so tests run them with
fakes and fake timers. Correctness never depends on realtime.

**`ConversationSync`** (one open chat):

* **Catch-up** runs on hints, on (re)join, on foreground/online and every
  45 s while visible. It fetches `after_rev = cursor` in pages of 200. Calls
  that arrive while a catch-up runs coalesce into one more run.
* **Far behind.** After 5 pages it fetches the latest page instead, swapping
  it in only on success, so the screen never goes blank. A generation
  counter drops pages already in flight for the old state.
* **Only the loaded window changes.** Catch-up applies changes to messages
  inside the loaded window. Reply quotes are refreshed from the full page
  (an edited or deleted original updates its quotes), and the cursor moves
  by the full page.
* **The outbox** keeps unsent messages, with their `client_id`, in a store
  that survives app kills.
  * Sends go one at a time, in order. `RATE_LIMITED` waits `retryAfterSeconds`.
  * A throw (offline fetch) becomes a retryable error, so the head is never
    stuck in "sending".
  * A send result never replaces a newer synced copy of the same message
    (higher rev wins).
* **Read markers** are debounced (800 ms), sent at least every 2 s while
  messages keep arriving, and flushed when the screen is hidden or stopped.
* **`stop()`** makes in-flight requests no-ops, so a closed screen can't
  overwrite the outbox store a newer instance of the same chat already uses.

**`InboxSync`**:

* **Refreshes are single-flight.** A request during a refresh queues one more
  run.
* **Merges are monotonic.** `last_seq`, `last_read_seq` and activity never go
  backwards, so a slow response can't bring back an unread badge you just
  cleared.
* **Short and full first pages.** A short first page is the whole inbox, so
  rows missing from it are dropped. On a full page, older rows are kept and
  marked stale.
* **Hints update rows in place**, and the preview is refetched narrowly. A
  short batch window plus jitter (1.5 s + up to 2 s) keeps a club's members
  from refetching in lockstep. The refetch asks only for the stale ids
  (`p_channel_ids`, with `limit = ids.length`).
* A lost or refused group topic marks the chat stale.

## 9. Blocks

`public.profile_blocks(blocker_id, blocked_id)`. Users see and manage their
own rows (`blockProfile`, `unblockProfile`, `listBlocks`; blocking twice is
fine). `app.dm_is_blocked(channel)` is a DEFINER helper, true when either
person in a DM has blocked the other. While it holds:

* DM sends, edits, typing, uploads and read receipts stop, **both ways**,
  with the same `MESSAGING_UNAVAILABLE` text;
* the thread stays readable, and the inbox shows `can_send = false` and
  `blocked_by_me` to the person who blocked;
* group chats are unaffected (moderation and reports cover those).

## 10. Media

| | |
|---|---|
| Bucket | `chat-media`, private, 10 MB, JPEG/PNG/WebP/GIF/MP4 |
| Name | `<channel_id>/<sender_id>/<client_id>.<ext>`: one object per message, named after its key (`chatMediaPath`) |
| Upload | participants, into their own sender folder, not across a DM block. Upload first, then send with the path |
| Read | signed URLs (300 s) while the message is live; the uploader before sending; platform admins while a report holds it |
| Delete | the uploader, only while unsent and not held by an open report |

* **Once referenced, a file can't be swapped** (unique `media_url`, and the
  guard checks the folder and key).
* **Deleted or moderated media** stops being readable at once and goes into
  `app.chat_media_purge`.
* **Unsent uploads** are swept after a day. Sends are refused 20 hours after
  the upload (`MEDIA_EXPIRED`), so the sweep can never delete the file of a
  send in flight.
* **Evidence.** A file held by an OPEN report is never deleted or purged.

**The purge job.** Storage objects must be deleted through the Storage API
(deleting the row leaves the file), so purging is a service-role job:

1. `claim_chat_media_purge(limit)` returns paths from the queue that are not
   live and not held by an open report, then orphans older than a day, up to
   the limit.
2. The job removes them through Storage in chunks of 100.
3. `complete_chat_media_purge(paths)` clears the queue.

`supabase/functions/purge-chat-media` loops until done or 50 s have passed,
and only callers bearing the service key may run it.
`src/server/chat/media.ts` `purgeChatMedia` is the same logic, unit-tested.

## 11. Reports and moderation

* `report_chat_message(message, reason, note)` stores a **snapshot** (text,
  media path, sender, chat), so deleting the message doesn't destroy the
  evidence. Reporting is idempotent per reporter and message. The reason is
  `chat_report_reason`; the note is ≤ 500 characters (code points, like the
  database).
* **Reporters** see their own reports and status, but not `resolved_by` or
  `resolution_note` (column grants). Platform admins stay hidden.
* **Platform admins** list reports (`list_chat_reports`, with resolver
  identity), resolve them (a trigger stamps `resolved_by`/`resolved_at`), and
  read the reported media. DMs have no other moderator.
* **Club admins and event organisers** can soft-delete messages in their
  chats. Deletes wipe the content and keep the row, so `seq` has no gaps.

## 12. Server actions

| Action | Notes |
|---|---|
| `sendMessage` | retry-safe; trims and validates first; `deps.sender` fills the sender for an optimistic row |
| `editMessage`, `deleteMessage` | a retried delete of a deleted message succeeds |
| `getMessages`, `syncMessages` | Zod-parses the jsonb page |
| `markRead` | `up_to_seq` required |
| `getInbox`, `getUnreadSummary` | keyset cursor `(activity_at, channel_id)` at millisecond precision; or `channel_ids` (≤ 50) for narrow refetches |
| `openDirectChannel`, `setMuted`, `listParticipants` | a muted chat keeps its own unread count but leaves the app badge total (`getUnreadSummary`) |
| `blockProfile`, `unblockProfile`, `listBlocks` | |
| `reportMessage` | |
| `signChatMedia` | signs in chunks of 100; an unknown or refused path comes back `null` |
| `purgeChatMedia` | service role only (§10) |

The transport is Step 3's `callWithRetry` (moved to `src/server/transport.ts`).
Every chat write is retry-safe: sends replay by key, edits set absolute
values, deletes and markers converge.

## 13. What the tests prove

| Suite | Highlights |
|---|---|
| SQL (`tests/db/70_chat_engine.sql`, 153 checks) | seq/rev and trimming · idempotent replays and key reuse · `ON CONFLICT` refusal and column-grant spoofing · edits/deletes (rev moves, seq doesn't) · forward-only markers, joiners caught up · inbox incl. same-millisecond paging and id lists · private DM opening · blocks both ways · rate limit · media naming, live-only reads, evidence, `MEDIA_EXPIRED`, sweep rules · reports and reporter privacy · pages and sync · hints on the right topics, topic policies · archive · organiser replacement · account deletion · club deletion (one hint) · structure invariants |
| Concurrency (races 11–16) | seq vs created_at poller · 24 double-taps → 1 row · 40 sends across 4 chats → exactly 20 · two devices' markers → max wins · 24 simultaneous DM opens → one thread · sends, slow edits and deletes vs a rev poller → nothing missed |
| Schema lint / post-deploy | chat triggers installed · guards and RPCs INVOKER, sequence DEFINER · chat tables out of the publication · typing is the only send policy · no TRUNCATE · `last_seq = max(seq)` · purge backlog older than 2 days |
| Contract | limits ≡ the database · page/snippet/id-list sizes · bucket size and types · topics and media names ≡ the policies · schemas parse real RPC output and hint payloads · `chatTextSchema` ≡ trimming and length · real refusals → `DomainError` |
| Unit | state updates (pages, sync window, quotes, outbox, inbox merge, ranking) · sync engines with fake timers (outbox, far-behind, stop, read max-wait, single-flight inbox, stale refetch) · realtime registry, budget, refused vs dropped joins · server actions (retries, mapping, chunking) |
| Integration (PostgREST 13, real JWTs) | club chat end to end · lost send response → one message · outsiders get nothing · rate limit wait · mute and reports · photo upload and send · private DM opening, unread, replies, Seen · blocks · expired session · raw upsert can't burn seqs · inbox paging over chats joined in one transaction |
| Counts | SQL suite and races: 480 checks · unit 329 · contract 82 · integration 62 |

## 14. Operations

* **After deploying**, run `scripts/post-deploy-check.sql`. It checks the
  three chat topic policies (and that no other client-send policy exists),
  that the chat tables are out of the publication, the triggers, the
  INVOKER guards, the `last_seq` invariant, the archive cron job and the
  purge backlog. Without the topic policies, private channels silently
  receive nothing.
* **Schedule the media purge** every 15 minutes:

  ```bash
  supabase functions deploy purge-chat-media
  ```

  ```sql
  select cron.schedule('rh-purge-chat-media', '*/15 * * * *', $$
    select net.http_post(
      url     := '<project-url>/functions/v1/purge-chat-media',
      headers := jsonb_build_object('Authorization', 'Bearer ' || <service role key from Vault>));
  $$);
  ```

  A queue or unsent-upload backlog older than two days in the post-deploy
  check means the job isn't running.
* **Cron** (from Step 1): `archive_finished_event_channels` daily at 03:17.
* **Migration backfill:**
  * seq/rev by `created_at`;
  * markers from `last_read_at`, index-backed;
  * duplicate media paths deduplicated before the unique index.

  `0800` never held production chat data, so this only matters for
  development databases.

## 15. Limitations and what's next

| Item | Where |
|---|---|
| **Typing identity is client-supplied.** Any participant can make another participant appear to be typing in that chat (not outside it, not across a DM block). It is cosmetic: no content, no persistence. A server-attested indicator would cost a database write per typing burst | accepted; revisit if abused |
| Unread counts include deleted messages and messages from people you blocked in group chats (the count is two integers) | by design |
| Push notifications (FCM/APNs) for messages while the app is closed | Step 5 |
| Erasing a deleted account's message content (messages stay, without a sender) | with account-deletion anonymisation |
| End-to-end delivery against a live Supabase Realtime server (the SQL side and the client registry are tested separately) | before launch |
| Per-IP / per-device limits at the edge (the per-sender rate limit covers each account) | before launch |

## 16. Reviews

**Design critique (before building).** Reviewers attacked the first plan, and
plan v2 took in what held up:

* no `ON CONFLICT` sends;
* the INVOKER/DEFINER split;
* blocks hidden from the blocked person;
* FK null-outs that pass the guard;
* a safe backfill, and joiners who start caught up;
* no hints from bulk paths;
* the inbox refetch herd;
* the realtime topic cap and budget;
* the media lifecycle;
* single-snapshot cursors;
* column grants for privacy;
* reports, and private DM opening.

**Implementation review (after building).** Four lenses (SQL, security,
TypeScript, client) plus a coverage pass produced 28 findings. An
adversarial verifier per finding tried to refute and reproduce each one on
its own database. Results:

* 21 were confirmed;
* 1 was a duplicate (CLIENT-4 of TS3);
* 6 were judged overstated.

All were addressed except SEC-5, which is documented in §15. Regression
tests are in `70_chat_engine.sql` (sections 1, 4, 9, 9b), races 14 and 16,
the "review fixes" unit blocks, and `tests/integration/chat.test.ts`.

| Finding | Fix |
|---|---|
| SQL-1/SEC-1 `ON CONFLICT DO NOTHING` inflated `last_seq`: phantom unread, inbox bumps (high) | column-level INSERT; the guard refuses a reused key before the counter moves |
| SQL-2 edited/deleted originals left stale reply quotes | catch-up refreshes quotes of loaded replies from the full page |
| SEC-2 a sender could delete reported media | no delete or purge while an open report holds the file |
| SEC-3 `resolved_by` revealed who is a platform admin | reporters lose `resolved_by`/`resolution_note`; admins use `list_chat_reports` |
| SEC-4 admins couldn't open reported media | storage read policy for reported media |
| SEC-5 typing identity from the payload | accepted, §15 |
| TS1 a send/edit result overwrote the full synced copy | the higher rev wins; equal rev keeps the synced copy |
| TS2 inbox cursor cut to milliseconds skipped chats | keyset on millisecond activity in SQL too |
| TS3/CLIENT-4 a throwing send left the outbox stuck | `safely()`: throws become retryable errors |
| TS5 report note counted UTF-16 units | counts code points, like Postgres |
| TS6/COV-3 the orphan sweep could race a send | `MEDIA_EXPIRED` after 20 h; sweep after a day; tested |
| TS7 signing dropped paths after 100 | chunks of 100 |
| CLIENT-2 a ghost row looped refused joins and refetches (high) | refused joins back off; short pages drop absent rows |
| CLIENT-5 a stopped screen overwrote the outbox store | `stop()` makes in-flight work a no-op |
| CLIENT-6 far-behind fallback blanked the chat and raced `loadOlder` | fetch first, swap on success; generation counter |
| CLIENT-7 a stale refresh brought back cleared unread | single-flight, monotonic merge |
| CLIENT-9 catch-up showed changes outside the loaded window | only the window changes; the cursor still moves |
| COV-4 nothing ran the purge | Edge Function + schedule + backlog check |
| COV-5 races never used the rev cursor; race 14 was flaky | race 16; race 14 made deterministic |

The verifiers judged six findings overstated. Small fixes went in anyway,
and none loosens a rule:

* **TS4/COV-2:** the purge clamps its batch and removes in chunks of 100;
  the orphan scan stops at the batch limit.
* **CLIENT-1:** narrow refetches pass `limit = ids.length`, so a long stale
  list can't drop chats.
* **CLIENT-3:** dropped sockets aren't treated as refusals; refetches are
  jittered.
* **CLIENT-8:** read markers have a 2 s max wait and flush on hide/stop.
* **COV-1:** the backfill is index-backed and deduplicates media paths.
