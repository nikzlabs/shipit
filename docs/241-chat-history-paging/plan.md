---
issue: https://linear.app/shipit-ai/issue/SHI-266
title: Windowed chat-history loading
description: Load the latest N messages of a session transcript and page older ones in on scroll-up, instead of shipping the whole history on every switch and reload.
---

# Windowed chat-history loading

Long-running sessions — the ones that open several PRs in a row or spawn many
sub-sessions — accumulate transcripts that are slow and expensive to load. Every
session switch, page reload, and foreground reconnect currently fetches the
**entire** transcript. This doc designs a bounded initial window plus a
load-older path driven by scrolling up.

Anticipated in `docs/071-sqlite-investigation/plan.md:122`, which lists "Add
proper pagination for long chat histories" as an unimplemented follow-up.

**No schema change. No migration.** An earlier draft of this doc proposed a
`turn_seq` column, a history-generation counter and row ids on the wire; all
three were removed after review showed the claim justifying them was false. See
[Rejected alternatives](#rejected-alternatives) — the reasoning is worth keeping.

## Why it is expensive today

**First, separate the two costs.** The complaint was "time and traffic," but those
have different fixes and only one of them is bytes.

*Bytes on the wire* are likely already mitigated on the hosted path: there is no
`@fastify/compress` at the origin, but the VPS deployment fronts ShipIt with a
Cloudflare tunnel (`deployment/vps/cloudflare.sh`), and Cloudflare compresses
proxied JSON by default. The tailnet-only path (`deployment/vps/tailscale.sh`) and
`deployment/local` have no compressing proxy and do ship raw JSON — enabling
origin compression is a cheap, orthogonal win for those, and is **not** a
substitute for this work.

*Work at both ends* is untouched by any of that, and it is what paging actually
fixes: the SQLite read of every row, `fromRow` JSON-parsing every populated column
of every row server-side (`chat-history.ts:519-582`), serializing the payload,
`JSON.parse` in the browser, and the render. Compression shrinks the transfer and
changes none of it. Note too that base64 `images` compress poorly — already-
compressed bytes in a text encoding — so the heaviest rows benefit least.

So the design is justified by latency and CPU at both ends more than by raw
transfer. With that framing, measured against the source:

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
  (`:107`). `buildVisualElements` is a full O(n) pass, recomputed on every render
  and not memoized.

**Measurement gap.** None of the above is measured — there is no live database in
a session container, so the byte and time distribution is inferred from schema and
code. Before building, instrument one real long session: total payload size, the
share contributed by `tool_results` / `tool_use` / `images` / `subagent_events`,
server time in `load()` vs serialization, and client time in parse vs render. If
bytes turn out to be dominated by a handful of rows rather than by row count, then
SHI-267 (lazy bodies) is the higher-leverage first move and this design should be
resequenced behind it.

## Requirements

Confirmed with the user; deliberately not widened.

1. Initial load returns the latest N messages, not the whole transcript.
2. Older messages load when the user **scrolls up**.
3. In-chat search (Ctrl+F) keeps working across the whole conversation.
4. **Download chat must still export the whole history**, not the loaded window.
5. **Paging only.** Lazy-loading of heavy row bodies is out of scope (SHI-267).

Non-requirements: no virtualization, no transcript summarization/TOC, no change
to what is persisted, no page eviction.

## The key schema fact: persisted rows are self-contained

This is what makes the design small, so it is worth stating precisely.

- **A tool result lives on the same row as its tool use.** `PersistedMessage`
  carries both `toolUse` and `toolResults` (`chat-history.ts:106-133`);
  `buildTurnMessages` emits them together (`chat-card-persistence.ts:135-142`);
  `toRow`/`fromRow` serialize both onto one row (`:482`, `:528`). Every client
  lookup is same-row (`visual-elements.ts:120,137,157`). There is no cross-row
  pairing anywhere.
- **Cards are ordinary standalone rows.** `afterGroupIndex` is in-memory only —
  there is no such column. By persist time the interleaving is flattened into row
  order, and no persisted row references another row's position.

Therefore **a cut at any row boundary loses nothing and breaks no persisted
relationship.** That removes the need for a persisted turn marker, and with it a
column, an index, an ordinal-allocation rule, a crash-recovery path, an
out-of-turn-row policy spanning eight call sites, and a backfill migration.

**It does not, however, make the cut position free — see §2.** The persistence
layer is indifferent to where the window starts; the *rendering* layer is not.

## Design

### 1. Windowed read

Add `ChatHistoryManager.loadWindow(sessionId, { limit, beforeOffset? })` — two
prepared statements (`ORDER BY id DESC LIMIT ?`, reversed; and the same with an
offset). **Leave `load()` intact**: rewind (`rollback-handlers.ts:167`) and
PR-description generation (`github.ts:1329`) legitimately need the whole history,
and narrowing `load()` would break them silently.

Paging is by **row offset from the tail**, which is stable under concurrent
appends: the agent only ever writes at the tail, and `replaceInProgress` churn is
confined to the running turn, which is always inside the newest window. A
front-anchored "the M rows before offset X" read cannot be disturbed by either.

### 2. Snap the window start to a user row — required, not polish

Persisted rows are self-contained, but the **renderer builds cross-row
constructs**, and a window that begins mid-run makes them silently wrong rather
than merely ugly.

`buildVisualElements` accumulates groupable tools across *consecutive assistant
messages* into one tool-group (`visual-elements.ts:119-123`). It flushes on
visible content (`:114`), on an extractable standalone tool (`:135`), or on any
non-groupable message — a condition that includes `msg.role === "user"`
(`:141-142`). Two more constructs behave the same way: `turnProseByLastIndex`
tracks a `runStart` reset at user rows (`MessageList.tsx:126-152`), and
`findPlanContent` scans backward for the `Write` that produced the plan
(`:168-182`).

So if the window opens in the middle of a run, the grouping layer starts
accumulating at the first *loaded* row and renders a tool-group with **fewer
items than the turn actually made** — a turn that ran twelve tool calls displays
three. Nothing is lost and nothing crashes, but the UI *misreports* what
happened. Likewise the voice Play button would speak a partial turn's prose, and
an `ExitPlanMode` card could fail to find its plan. That is a correctness-shaped
defect in the UI, not an aesthetic seam, and it is not acceptable as
ship-without-it polish.

**Fix: snap the window start to a `role: "user"` row.** A user row is already a
flush point for all three constructs, so a window beginning there can never
bisect a tool group or a prose run. Extend backward to the nearest preceding user
row; if that exceeds a cap (a pathologically long run), snap *forward* to the
next user row instead and show slightly less — either direction lands on a flush
point, so the invariant holds in both. Only a single run longer than the cap in
both directions forces a mid-group cut; that is rare enough to accept.

**This also fully retires the turn-marker question.** The earlier draft worried
that "nearest user row" cannot distinguish a turn-opening prompt from a live
steer (steers persist as user rows inside a turn — `session-runner.ts:111-148`).
For this purpose the distinction is irrelevant: a steer *is* a user row, and a
user row is already a flush point, so snapping to one never bisects a group
either way. The cheap heuristic is exactly as good here as a persisted turn
marker would have been — which is why `turn_seq` buys nothing.

The snap is a server-side query detail: find the greatest user-row offset at or
below the requested start. No schema change.

### 3. API surface

One route, one branch — not a new subsystem.

- `GET /api/sessions/:id/history?limit=N` — today's payload, with `messages` as
  the last N rows plus `omittedBefore` (row count below the window), `hasMore`,
  and the two metadata fields below. **`limit` absent ⇒ everything, exactly as
  today**, which is both the back-compat path and the full fetch that search and
  export use. That absence *is* the opt-in; no separate activation flag is needed.
- With `&beforeOffset=`, return only `{ messages, omittedBefore, hasMore }` and
  skip the git-log and file-tree work (`api-routes-session-spawn.ts:93-107`) —
  scrolling must not re-walk the workspace.

Two metadata fields replace whole-array scans, both via **narrow SQL** (deriving
them through `load()` would re-read and `JSON.parse` every heavy row, giving back
most of the saving):

- `firstUserText` — a `LIMIT 1` query. `PrLifecycleCard` reads the first user
  message for the session title (`shared.tsx:166`, `PrLifecycleCard.tsx:111`).
- `sentUploadPaths` — a targeted user-row scan. `file-store.ts:213-224` prunes
  the draft-upload set by scanning messages; under a suffix window an old sent
  upload **resurrects as a draft chip**, the exact bug that code says it
  structurally prevents.

### 4. Index addressing — the one genuine hazard

The client addresses messages by array position, and two protocols carry that
position across the wire. This is data-loss-grade and **gates turning the window
on**.

**Rewind.** The client sends `gapPosition`, an index into its own loaded array.
The server validates only `gapPosition > allMessages.length` against the *full*
history and then runs `saveMessages(allMessages.slice(0, gapPosition))`
(`rollback-handlers.ts:167-196`). Concretely: full history 100 rows, windowed
client holds 10, user rewinds at local position 5 → the server **keeps the oldest
five rows and destroys the other 95**. Per action: `chat` and `both` are genuine
transcript data loss; `code` rolls the tree back from the wrong early commit;
`fork` builds the child from the wrong base.

(Implementation note: production rewind uses `saveMessages`, not `truncate()` —
`truncate()` has no production caller, tests only.)

**`commit_linked`.** The server emits `messageIndex` computed over the full
history (`agent-listeners.ts:1176`, `post-turn.ts:175`, `turn-executor.ts:455`);
the client applies it by array position (`commit-linked.ts:7`), so the commit chip
lands on the wrong bubble.

**Fix: translate through `omittedBefore`.** The client's array is exactly a
suffix of the server's, so the mapping is exact in both directions — rewind sends
`omittedBefore + gapPosition`, `commit_linked` applies `messageIndex -
omittedBefore`. Two one-line changes.

### 5. Client

**Stable keys without row ids.** `omittedBefore + i` is invariant: prepending M
rows decrements `omittedBefore` by M and increments every existing row's `i` by
M, so the sum is unchanged. That is a usable DOM key, replacing the array-index
keys at `MessageList.tsx:300,313` — which matters, because index keys make a
prepend remount everything below it, destroying scroll position, collapse state
and the scroll anchor itself. It is also the scroll anchor. Page dedupe is
unnecessary: pages are non-overlapping ranges behind a single in-flight latch.

**Scroll anchoring on prepend** — element anchoring, not `scrollHeight` deltas:

1. Record the oldest visible row's key and its `getBoundingClientRect().top`.
2. Prepend the page.
3. In a `useLayoutEffect` after that page has rendered, re-find the row and apply
   `scrollTop += newTop - oldTop`.

Three pitfalls specific to this codebase:

- `content-visibility: auto` makes `scrollHeight` unreliable — newly prepended
  offscreen nodes report the `contain-intrinsic-size: auto 5rem` placeholder
  first (`MessageList.tsx:252`). Render a freshly prepended batch with
  `content-visibility: visible` until the correction lands, then restore `auto`.
- `useMessageScroll` needs an explicit **prepend** signal. Today it reads any
  message-count increase as growth and re-pins to the bottom
  (`useMessageScroll.ts:139-171`); its settle loop would fight the anchor.
- `useDeferredValue` (`MessageList.tsx:107`) means the correction must follow the
  *rendered* array, not the Zustand update.

This is the genuinely new UX work and the part most likely to need iteration.

**Card-store seeding.** `loadSessionHistory` (`session-data.ts:146`) scans the
message array to seed four card stores — bug-report `:174`, permission `:187`,
egress `:198`, issue-write `:209`. Run the same scans over each prepended page,
**seed-if-absent** so an older page never overwrites newer lifecycle state.

**`handleReleaseCard`** (`release-card.ts:18`) appends when it cannot find its
card by `cardId` — under paging, an update to an unloaded old card would teleport
it to the bottom of the transcript. Guard: drop when not found and `hasMore`.

**Search and export** both need the whole transcript, and both already have a way
to get it — the limitless route. Fetch it once on demand: Ctrl+F with `hasMore`
fetches the full history, installs it, then searches exactly as today; download
chat does the same fetch and keeps its existing client-side serialization
(`SessionItem.tsx:114-124`). No incremental search-paging loop, no new export
endpoint. This is the same traffic as today, but only when the user asks for it.

## What this does not fix

- **DOM growth is deferred, not eliminated.** Scrolling to the top — or running a
  search, which fetches everything — reconstructs today's unbounded,
  non-virtualized transcript. Eviction or virtualization is a later step.
- **Bytes are not bounded, only rows.** A window containing several near-1 MB tool
  outputs is still heavy. That is SHI-267.
- **Write amplification is untouched.** Every tool-result boundary deletes and
  reinserts the running turn's rows (`replaceInProgress`), so a 40-tool-call turn
  rewrites its accumulated blobs ~40 times. Separate problem.
- **The hydration race is pre-existing and unchanged.** A transcript mutation
  arriving between the history fetch and the `setMessages` install can be appended
  then erased. That is true today with full loads; window size does not affect it,
  so fixing it is not part of this work.

## Rejected alternatives

Recorded because two review rounds proposed each of these, and the reasons they
were dropped are the useful part of this doc.

- **Turn-aligned windows via a `turn_seq` column.** Rejected: it existed to prevent
  "orphaned tool results and cards," and that premise is false — persisted rows are
  self-contained (see above), so a mid-turn cut is cosmetic. It would have cost a
  column, an index, ordinal allocation with a crash-recovery rule, edge cases for
  retry/adoption/first-turn paths, a policy for the many out-of-turn appends
  (merge-watch, session reports, issue lifecycle, startup tasks, fork breadcrumbs),
  and a backfill migration that *still* could not distinguish a legacy steer from
  a turn start.
- **A `historyGeneration` counter to invalidate stale cursors.** Rejected: rewind
  is blocked while a turn runs (`rollback-handlers.ts:161`) and the initiating tab
  already reloads (`rewind-restored.ts`). The only gap is a second tab holding a
  load-older mid-rewind — and that tab's whole transcript is *already* stale today,
  since `rewind_complete` goes to the initiator only. The failure there is a
  misaligned prepend on a read, not data loss, and the dangerous cross-tab case (a
  stale tab *sending* a rewind) is covered by index translation regardless. If it
  ever matters, reload the window in `handleRewindSnapshotAvailable`, which *is*
  broadcast to all viewers (`rollback-handlers.ts:94`) — one line, and it fixes the
  pre-existing staleness too.
- **`rowId` on the wire.** Rejected: a redundant second positional scheme.
  `omittedBefore + i` is already stable, and row ids are positional anyway (ids are
  reused — `id INTEGER PRIMARY KEY` with no `AUTOINCREMENT`, `database.ts:17`), and
  live rows have none: `turn_snapshot` is built from in-memory state
  (`route-registry.ts:580`), and optimistic/streamed rows never had one.
- **Row-id addressing for rewind.** Same reason — rewind targets a just-completed
  live turn in the common case, which has no ids to anchor on.
- **A separate `/history/messages` route.** It is a branch on the existing handler,
  not a new endpoint.
- **A permanent per-message UUID.** Would make row-id addressing viable everywhere;
  materially more invasive than this requirement justifies.
- **`OFFSET` paging from the head.** Shifts under concurrent appends; offsets are
  measured from the tail instead.
- **Virtualization instead of paging.** Fixes render cost, not bytes on the wire.
  `docs/065-terminal-improvements` evaluated `@tanstack/react-virtual` for the logs
  list and rejected it as unwarranted.

## Sequencing

1. `loadWindow()` with the user-row snap + `?limit`/`&beforeOffset` on the
   existing route + the two metadata fields. Inert: no client sends `limit`, so
   every response is byte-identical to today.
2. **`omittedBefore` translation for rewind and `commit_linked`.** Must land
   before any client sends `limit`.
3. Client: keys, prepend + scroll anchoring, prepend-aware `useMessageScroll`,
   per-page card seeding, the `handleReleaseCard` guard, on-demand full fetch for
   search and export — and the client starts sending `limit`.

Roughly one to two PRs. The ordering constraint that matters is a single
sentence: do not send `limit` until rewind translation, search and export are
done.

## Follow-up, not in this design

**SHI-267** — lazy-loading heavy row bodies not displayed inline (`tool_results`
content, `tool_use` inputs, `subagent_events`, base64 `images`). Complementary:
paging avoids transferring untouched history, lazy bodies reduce the weight of the
pages actually loaded. Must keep per-result metadata inline (`toolUseId`,
existence, error state, `durationMs`) — `AskUserQuestion` renders the answer from
result content, `ExitPlanMode` keys off result existence, Present extracts its
artifact id, and subagent reports come from parent tool output
(`message-tools.tsx:125`).

## Key files

**Server** — `chat-history.ts` (`load:590`, `stmtLoadAll:455`, `fromRow:519`,
`replaceInProgress:909`, `saveMessages:829`), `database.ts:17-32` (schema),
`api-routes-session-spawn.ts:85-153` (endpoint), `services/session.ts:101`
(`getChatHistory`), `ws-handlers/rollback-handlers.ts:105-196` (rewind),
`services/github.ts:1329` (needs full history).

**Client** — `utils/session-data.ts:146-341` (`loadSessionHistory`),
`stores/session-store.ts:321-336`, `components/MessageList/MessageList.tsx`
(`:208` gaps, `:252` content-visibility, `:300` keys),
`MessageList/hooks/useMessageScroll.ts`, `hooks/useSearch.ts`,
`hooks/message-handlers/` (`commit-linked.ts`, `release-card.ts`),
`stores/file-store.ts:213`, `components/SessionSidebar/SessionItem.tsx:114`,
`components/PrLifecycleCard/shared.tsx:166`.

## Related docs

`docs/071-sqlite-investigation` (names this work as a follow-up),
`docs/144-rewind-fork-ux` (the `gapPosition` model §4 must translate),
`docs/188-persist-transcript-cards` and `docs/191-card-persist-on-emit` (the
persistence contract paging must not break),
`docs/237-mid-turn-reattach-snapshot` (`turn_snapshot`, the live overlay),
`docs/104-chat-toc-and-summaries` (plan-only; the other long-transcript idea).
