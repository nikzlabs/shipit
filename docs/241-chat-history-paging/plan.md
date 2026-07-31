---
issue: https://linear.app/shipit-ai/issue/SHI-266
title: Windowed chat-history loading
description: Load the latest ~10 turns of a session transcript and page older turns in on scroll-up, instead of shipping the whole history on every switch and reload.
---

# Windowed chat-history loading

Long-running sessions — the ones that open several PRs in a row or spawn many
sub-sessions — accumulate transcripts that are slow and expensive to load. Every
session switch, page reload, and foreground reconnect currently fetches the
**entire** transcript. This doc designs a bounded initial window (the latest ~10
turns) plus a load-older path driven by scrolling up.

The problem was anticipated: `docs/071-sqlite-investigation/plan.md:122` lists
"Add proper pagination for long chat histories" as an unimplemented Phase-3
follow-up. This is that work.

## Why it is expensive today

Measured against the source, not assumed:

- **No limit exists anywhere on the read path.** `ChatHistoryManager.load()`
  (`chat-history.ts:590`) runs `SELECT * FROM messages WHERE session_id = ?
  ORDER BY id` (`chat-history.ts:455`) — every row, fully `JSON.parse`d.
- **The endpoint is a fat bootstrap.** `GET /api/sessions/:id/history`
  (`api-routes-session-spawn.ts:85-153`) returns messages *plus* git log, file
  tree, the full `turnUsage` series, presentations, background tasks and the
  rewind snapshot. There is no size cap on the wire.
- **Rows are large.** `tool_results` holds verbatim tool output (a `git diff`, a
  test log, a whole file read); `tool_use` holds raw tool input, so a `Write`
  carries the entire file body; `images` are inline base64; `subagent_events`
  carries an entire subagent transcript. The only truncation in the path is a
  1 MB cap applied to the *live* copy (`agent-event.ts:122`) — the persisted
  copy is uncapped.
- **The client re-fetches more often than you would think.** A foreground
  reconnect forces a fresh socket and therefore another full load
  (`useWebSocket.ts:160-200`).
- **Nothing is virtualized.** `MessageList` renders every message and leans on
  CSS `content-visibility: auto` (`MessageList.tsx:252`) plus `useDeferredValue`
  (`:107`). `buildVisualElements` is a full O(n) pass recomputed on every render.

So the dominant cost is bytes on the wire and parse/render of rows the user
never scrolls to. Bounding the window attacks exactly that.

## Requirements

Confirmed with the user; deliberately not widened beyond this.

1. Initial load returns the **latest ~10 full turns**, not a raw message count.
2. Older turns load when the user **scrolls up**.
3. In-chat search (Ctrl+F) keeps working across the whole conversation by
   **auto-loading older pages while searching**.
4. **Download chat must still export the whole history**, not the loaded window.
5. **Paging only.** Lazy-loading of heavy row bodies is explicitly out of scope
   here and is filed separately as SHI-267.

Non-requirements, called out so they are not smuggled in: no virtualization, no
transcript summarization/TOC, no change to what is persisted, no eviction of
already-loaded pages.

## Design

### 1. A turn needs a persisted marker — a per-session ordinal

The obvious boundary — "a row with `role: "user"` starts a turn" — **is wrong on
this schema**. Live-steered messages are persisted as `user` rows *interleaved
between assistant groups inside a running turn* (`session-runner.ts:111-148`,
re-interleaved by `buildTurnMessages` at `chat-card-persistence.ts:107`).
Counting user rows over-counts turns, and a page boundary landing on a steer cuts
a turn in half — precisely the orphaning that turn-alignment is meant to avoid.
There is no `turn_id`, no turn row, and no boundary marker in the schema today.

**Add a `turn_seq INTEGER` column: a per-session ordinal**, allocated once at turn
start and stamped on every row of that turn.

An earlier draft used *the row id of the turn-opening user message* as the key.
That is wrong, and the reason is worth recording. The narrow stability claim holds
— `persistUserMessage` (`agent-execution.ts:290`) appends the opening row without
`inProgress`, so it is written `in_progress = 0` and `replaceInProgress`
(`chat-history.ts:909`) never deletes it. But the key does not survive the paths
around it:

- **Rewind and fork rewrite every row.** `saveMessages` (`chat-history.ts:829`)
  deletes and reinserts the whole session (`rollback-handlers.ts:196, 262, 414`),
  so all row ids change. A retained `turn_seq` would point at deleted rows; a
  copied one would transplant the *parent's* id space into a fork.
- **Retries do not re-append the opener.** Auth retries and dispatched
  no-result retries reset turn state deliberately without persisting the user row
  again (`turn-executor.ts:235`, `dispatched-turn.ts:253`).
- **Adoption skips user persistence entirely** (`turn-adoption.ts:101`) and would
  have to recover the key from the database.
- **A new session's first user row is persisted only on `agent_init`**
  (`agent-listeners.ts:721`). If the orchestrator dies after the worker starts but
  before that event, adoption replays with `isNewSession: false` and no opener is
  ever created.
- The id is not known until `append()` returns, so insert-and-self-stamp would
  have to be one transaction.

A plain per-session ordinal sidesteps all of it: it is allocated at turn start,
carried as row *content* (so `saveMessages` round-trips it untouched), meaningful
inside a forked copy, and trivially recoverable after a crash as
`MAX(turn_seq) + 1`.

**Out-of-turn rows need a policy, and there are many of them.** Cards and notices
are appended outside any turn: merge-watch (`merge-watch.ts:838`), session
reports (`session-report.ts:321`), branch-sync (`rebase-driver.ts:187`), issue
lifecycle (`issue-lifecycle.ts:113`), startup tasks (`startup-tasks.ts:301`),
fork breadcrumbs (`rollback-handlers.ts:272`), post-turn notices
(`chat-card-persistence.ts:387`). Some can even *precede* the first turn —
dispatched attachment warnings append before `executeAgentTurn` persists its user
row (`dispatched-turn.ts:92`).

Policy: **an out-of-turn row inherits the most recently allocated ordinal**; rows
appended before any turn exists get `0`. So "the latest 10 turns" always means 10
*agent* turns with their trailing cards attached, a `DISTINCT turn_seq` query is
well-defined, and nothing is silently omitted. This does not break the paging
cursor — a card appended now inherits the newest ordinal and therefore lands in
the newest page, never in an already-loaded older one.

**Backfill.** Existing rows genuinely cannot distinguish an opening prompt from a
steer. A one-shot migration walks each session's rows in id order and assigns
ordinals using the user-row heuristic. **This is a real limitation, not a
cosmetic one:** a legacy steer becomes a page boundary, so a page can begin mid-turn
and omit that turn's opening prompt and earlier assistant groups — exactly the
split this design otherwise prevents. It is confined to pre-migration history and
degrades legibility, not correctness (no row is lost and no card is separated from
its own row). It needs an explicit test rather than a footnote.

Index: `CREATE INDEX idx_messages_session_turn ON messages(session_id, turn_seq)`.

### 2. Keyset paging, plus a history generation

Page on `turn_seq`, never `OFFSET` — an offset shifts under concurrent appends.

- **Initial page:** take the 10 highest `turn_seq` values for the session and
  return their rows, ascending by id.
- **Older page:** given `beforeTurnSeq`, take the 10 next-lower ordinals and
  return their rows, ascending.
- Appends only ever land in the newest ordinal, so a load-older request can never
  be invalidated by the agent writing concurrently. The running turn stays a live
  overlay exactly as today: `turn_snapshot` replaces `in_progress` rows
  (`turn-snapshot.ts:30-44`).

**Row ids are reusable.** The schema is `id INTEGER PRIMARY KEY`
(`database.ts:17`), a plain rowid alias with no `AUTOINCREMENT`, so ids are reused
after rows are deleted from the tail. Two consequences:

- **In-progress row ids are not durable identity.** `replaceInProgress` deletes
  and reinserts the running turn's rows at every tool-result boundary, churning
  ids constantly. They must never be used as a cursor or a durable key. Paging on
  `turn_seq` rather than id already avoids this; the rule just needs stating.
- **Destructive rewrites need a generation counter.** Bump a per-session
  `historyGeneration` on `saveMessages` (`chat-history.ts:829`),
  `markRolledBackFromIndex` (`:838`), `clearRolledBack` (`:855`) and
  `deleteMessageById` (`:866`, used to undo a fork breadcrumb at
  `rollback-handlers.ts:458`). **Not** on `replaceInProgress` — bumping every
  tool boundary would invalidate the client constantly for rows it replaces via
  `turn_snapshot` anyway. Rewind *restore* needs no separate bump because it goes
  through `saveMessages`.

Every page response carries the generation; the client sends it back on
load-older and discards mismatched responses, aborts in-flight fetches, and
reloads the recent window. The generation check, the page read and any destructive
mutation must each be atomic with their bump.

### 3. API surface

Keep the existing route as the bootstrap, add a lean one for scrolling.

- `GET /api/sessions/:id/history` — **windowing is opt-in via an explicit
  `?turns=N` parameter.** Absent, the route behaves exactly as today and returns
  everything. This is what makes the server work landable ahead of the client
  (see [Sequencing](#sequencing)). When present, `messages` is the window and the
  response gains `hasMore`, `oldestTurnSeq`, `omittedBefore` (row count below the
  window), `historyGeneration`, and the whole-history metadata from §6.
- `GET /api/sessions/:id/history/messages?beforeTurnSeq=&turns=&generation=` —
  **messages only**. Older pages must not re-run the git log and file-tree walk
  (`api-routes-session-spawn.ts:93-107`) on every scroll.

Server-side, add `ChatHistoryManager.loadWindow(...)` and **leave `load()`
intact**. Several server paths legitimately need the whole history — rewind
(`rollback-handlers.ts:167`) and PR-description generation (`github.ts:1329`)
among them. Narrowing `load()` would break them silently.

### 4. Absolute indices crossing the client/server boundary

This is the sharpest correctness hazard, and it is a data-loss one.

The client addresses messages purely by array position, and two protocols carry
that position **across the wire**:

**Rewind.** The client sends `gapPosition` — an index into its own loaded array
(`MessageList.tsx:231`). The server validates only `gapPosition > allMessages.length`
against the *full* history (`rollback-handlers.ts:167`), so a small index from a
windowed client passes validation and is applied at the wrong point. Concretely:
full history 100 rows, windowed client holds 10, user rewinds at local position 5
→ the server runs `saveMessages(allMessages.slice(0, 5))`, **keeping the oldest
five rows and destroying the other 95**. Per action: `chat` and `both` are genuine
transcript data loss; `code` rolls the working tree back from the wrong early
commit; `fork` builds the child from the wrong base but leaves the parent intact.

(Note for implementers: production rewind uses `saveMessages`, not `truncate()` —
`truncate()` has no production caller, tests only. An earlier draft of this doc
said otherwise.)

**`commit_linked`.** The server emits `messageIndex` computed by `indexOfMessageId`
over the full history (`agent-listeners.ts:1176`, `post-turn.ts:175`,
`turn-executor.ts:455`); the client applies it by array position
(`commit-linked.ts:7`), so the commit chip lands on the wrong bubble.

**Fix: translate through `omittedBefore`, do not re-key on row ids.** The client's
array is exactly a suffix of the server's, so `serverIndex = omittedBefore +
clientIndex` is exact in both directions. `omittedBefore` decreases as pages are
prepended and is invalidated by a generation change.

Row-id re-keying was considered and rejected as the primary mechanism, because
**live rows have no row id**: `turn_snapshot` is built from in-memory
`buildTurnMessages` rather than database rows (`route-registry.ts:580`) and the
client installs that id-less snapshot over its in-progress rows
(`turn-snapshot.ts:30`); optimistic user messages and streamed assistant bubbles
have no id either, and the client does not re-fetch history when a turn
finalizes. So a rewind targeting a just-completed turn — the overwhelmingly
common case — has no ids to anchor on. Index translation covers live and hydrated
rows uniformly.

`rowId` is still worth exposing (`fromRow`, `chat-history.ts:519`, currently drops
both `id` and `created_at`) for page dedupe and as a scroll anchor on hydrated
rows. It is a *positional* handle, not a durable message identity. A permanent
per-message UUID would be cleaner and would make row-id addressing viable
everywhere, but it is substantially more invasive than this requirement justifies.

Render-local indices (`useSearch.ts:47`, `visual-elements.ts:67-69`) are
recomputed from the current array every render and need no change — worth stating
so the migration does not sprawl.

### 5. Client: prepend, hydration, and scroll anchoring

**Page hydration.** `loadSessionHistory` (`session-data.ts:146`) scans the whole
message array to seed four card stores — bug-report `:174`, permission `:187`,
egress `:198`, issue-write `:209`. Factor these into one
`hydrateTranscriptPage(messages, mode)` called for the initial page *and* every
prepended page. On a prepend, merge only entries not already present: an older
page must never overwrite newer lifecycle state.

Lifecycle updates for rows outside the window need row-aware handling.
`handleReleaseCard` (`release-card.ts:18`) **appends** when it cannot find the
card by `cardId` — under paging, an update to an unloaded old card would teleport
it to the bottom of the transcript. Such updates should be cached by card id, or
dropped until that page loads; never appended.

**Scroll anchoring on prepend** — element anchoring, not `scrollHeight` deltas:

1. Record the oldest visible row's key and its `getBoundingClientRect().top`.
2. Prepend the page.
3. In a `useLayoutEffect` after that page has actually rendered, re-find the row
   and apply `scrollTop += newTop - oldTop`.

Three pitfalls specific to this codebase:

- `content-visibility: auto` makes `scrollHeight` unreliable — newly prepended
  offscreen nodes report the `contain-intrinsic-size: auto 5rem` placeholder
  first (`MessageList.tsx:252`). Render a freshly prepended batch with
  `content-visibility: visible` until the correction lands, then restore `auto`.
- `useMessageScroll` must learn an explicit **prepend** signal. Today it treats
  any message-count increase as growth and re-pins to the bottom
  (`useMessageScroll.ts:139-171`); its settle loop would fight the anchor.
- `useDeferredValue` (`MessageList.tsx:107`) means the correction must follow the
  *rendered* array, not the Zustand update.

This also requires **stable DOM keys**. Keys are array indices today
(`MessageList.tsx:300`), so a prepend remounts everything below it — destroying
scroll position, collapse state and the anchor itself. Key hydrated rows by
`rowId` and live rows by a client-assigned local key (`rowId ?? local-${n}`);
live rows are always at the tail, so the anchor is always a hydrated row.

**Transport ordering.** Only three message types are queued behind hydration
(`useMessageHandler.ts:67-79`). With a windowed baseline, any transcript mutation
arriving between the fetch and the `setMessages` install can be appended and then
erased. Queue every transcript mutation until the initial page is installed.

### 6. Whole-history consumers

Anything that reads the full array must become explicit metadata or a server
call:

| Consumer | Where | Fix |
|---|---|---|
| First user message (PR card title/context) | `PrLifecycleCard/shared.tsx:166`, `PrLifecycleCard.tsx:111` | Return `firstUserText` as page metadata |
| Sent-upload detection | `file-store.ts:213-224` | Scans user rows for `/uploads/` paths to prune the draft set. With a suffix window an old sent upload **resurrects as a draft chip** — the exact bug the code's comment says it structurally prevents. Return `sentUploadPaths` as metadata |
| Download chat | `SessionItem.tsx:114-124` | Serializes `useSessionStore.getState().messages` — would silently export only the loaded suffix. Make it a server-side full-history export endpoint (requirement 4) |
| Ctrl+F search | `useSearch.ts:32-52` | Page backwards **through to the start** while a search is active, with visible progress (see below) |

Both metadata fields must be computed with **narrow SQL** (a `LIMIT 1` for
`firstUserText`, a targeted column scan for `sentUploadPaths`). Deriving them by
calling `load()` would re-read and `JSON.parse` every heavy row and give back most
of the server-side cost this feature exists to remove.

On search specifically: stopping at the first match would not satisfy requirement
3 — older matches would be missing from next/previous navigation. Activating
search pages backwards to the beginning (progress shown), after which navigation
behaves exactly as it does today.

### 7. Server-side wins this enables (not in scope)

Eight `ChatHistoryManager` methods currently full-load and `fromRow`-parse the
entire session history: five card writes — `updateBugReportCard:644`,
`upsertReleaseCard:672`, `updateEgressPromptCard:701`, `updatePermissionCard:730`,
`updateIssueWriteCard:793` — plus the reads `listSubAgentConsultCards:755`,
`findIssueWriteCard:770` and `indexOfMessageId:810`. Targeted queries would help,
though note that card ids live inside JSON columns, so this only stops being
O(history) if the lookup keys are indexed (a generated column or an explicit
`card_id` column). Filed separately rather than bundled here.

## What this does not fix

Stated plainly so the design is not oversold:

- **DOM growth is deferred, not eliminated.** A user who scrolls all the way up
  reconstructs today's unbounded, non-virtualized transcript. Page eviction or
  real virtualization is a later step. Ctrl+F, which pages to the start, reaches
  that state deliberately.
- **A single turn can still be huge.** Ten turns containing several near-1 MB
  tool outputs is still a heavy payload. Turn-count bounds *rows*, not *bytes* —
  that is SHI-267.
- **Write amplification is untouched.** Every tool-result boundary deletes and
  reinserts the running turn's rows (`replaceInProgress`), so a 40-tool-call turn
  rewrites its accumulated blobs ~40 times. Separate problem, separate fix.

## Rejected alternatives

- **Fixed 50-message window.** Simpler and gives a predictable payload, but a page
  can begin mid-turn, orphaning tool results and cards from the rows they anchor
  to. Turn alignment costs one column and removes the whole failure class.
- **`turn_seq` = the opening user row's id.** Rejected — see §1; it does not
  survive `saveMessages` rewrites, forks, retries, adoption, or a first-turn crash.
- **Row-id addressing for rewind and `commit_linked`.** Rejected as the primary
  mechanism — see §4; live rows have no row id, and rewind targets a
  just-completed live turn in the common case.
- **`OFFSET`-based paging.** Shifts under concurrent appends during a live turn.
- **Client-side trim only** (keep fetching everything, render less). Does nothing
  for the actual complaint, which is traffic and load time.
- **Virtualization instead of paging.** Fixes render cost but not bytes on the
  wire. `docs/065-terminal-improvements` evaluated `@tanstack/react-virtual` for
  the logs list and rejected it as unwarranted.
- **A permanent per-message UUID.** Cleaner identity model, materially more
  invasive; not justified by this requirement.

## Sequencing

1. `turn_seq` column, ordinal allocation, out-of-turn policy, backfill migration,
   index; `loadWindow()` alongside `load()`; `historyGeneration`.
2. Opt-in `?turns=N` on `/history`; the lean messages-only endpoint; `rowId` and
   page metadata (`hasMore`, `omittedBefore`, `historyGeneration`,
   `firstUserText`, `sentUploadPaths`).
3. **Fix rewind and `commit_linked` addressing** via `omittedBefore` translation.
4. Client: stable keys, prepend path, `hydrateTranscriptPage`, scroll anchoring,
   prepend-aware `useMessageScroll`, widened hydration gate.
5. Ctrl+F backward paging; server-side full export.
6. **Activate the window** — the client starts sending `?turns=10`.

Steps 1–2 are inert *because windowing is opt-in*: no client sends `turns`, so
every response is byte-identical to today. Activation is deliberately its own
step at the end — turning the window on before step 5 would ship a transcript
whose search and export silently cover only part of the conversation, violating
requirements 3 and 4.

## Follow-up, not in this design

**SHI-267** — lazy-loading heavy row bodies for fields not directly displayed in
the conversation UI (`tool_results` content, `tool_use` inputs, `subagent_events`,
base64 `images`). Complementary to paging: paging avoids transferring untouched
history, lazy bodies reduce the weight of the pages actually loaded. Any such
design must keep per-result metadata inline (`toolUseId`, existence, error state,
`durationMs`) because several consumers read result *content* or mere *existence*:
`AskUserQuestion` renders the answer from result content, `ExitPlanMode` keys off
result existence, Present extracts its artifact id, and subagent final reports come
from parent tool output (`message-tools.tsx:125`).

## Key files

**Server** — `chat-history.ts` (`load:590`, `stmtLoadAll:455`, `fromRow:519`,
`replaceInProgress:909`, `saveMessages:829`, `markRolledBackFromIndex:838`,
`clearRolledBack:855`, `deleteMessageById:866`, `indexOfMessageId:810`),
`database.ts:17-32` (schema), `api-routes-session-spawn.ts:85-153` (endpoint),
`services/session.ts:101` (`getChatHistory`),
`ws-handlers/rollback-handlers.ts:105-192` (rewind),
`chat-card-persistence.ts:97-155` (`buildTurnMessages`),
`agent-execution.ts:290` (`persistUserMessage`), `agent-listeners.ts:721`
(first-turn persist), `turn-adoption.ts:101`, `dispatched-turn.ts:92, 253`,
`turn-executor.ts:235`.

**Client** — `utils/session-data.ts:146-341` (`loadSessionHistory`),
`stores/session-store.ts:321-336`, `components/MessageList/MessageList.tsx`,
`MessageList/hooks/useMessageScroll.ts`, `hooks/useMessageHandler.ts:67-79`,
`hooks/useSearch.ts`, `hooks/message-handlers/` (`commit-linked.ts`,
`release-card.ts`, `turn-snapshot.ts`, `rewind-complete.ts`),
`stores/file-store.ts:213`, `components/SessionSidebar/SessionItem.tsx:114`.

## Related docs

`docs/071-sqlite-investigation` (names this work as a follow-up),
`docs/144-rewind-fork-ux` (the `gapPosition` model this must change),
`docs/188-persist-transcript-cards` and `docs/191-card-persist-on-emit` (the
persistence contract paging must not break),
`docs/237-mid-turn-reattach-snapshot` (`turn_snapshot`, the live overlay),
`docs/104-chat-toc-and-summaries` (plan-only; the other long-transcript idea).
