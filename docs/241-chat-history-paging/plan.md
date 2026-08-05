---
issue: https://linear.app/shipit-ai/issue/SHI-266
title: Windowed chat-history loading
description: Load the latest N turns of a session transcript and page older ones in on scroll-up, instead of shipping the whole history on every switch and reload.
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

*Work at both ends* is untouched by any of that. But be precise about which work,
because an earlier draft of this section overcorrected and blamed the wrong line
items. `fromRow`'s ~40 conditional `JSON.parse` calls per row
(`chat-history.ts:519-582`), payload serialization and browser `JSON.parse` are
**milliseconds-scale** even on a 10 MB transcript — parse throughput is
O(100 MB/s). They are not the problem.

The two costs that are actually worth paging for:

1. **Initial React mount.** `content-visibility: auto` skips layout and paint of
   offscreen rows, but not the React commit or the first markdown parse inside
   each bubble. Several hundred bubbles × (mount + markdown parse) is plausibly
   seconds. This is the dominant time-to-interactive cost, and fewer mounted
   messages is exactly what paging buys.
2. **The refetch amplifier — the strongest practical argument in this doc.**
   Every foreground reconnect (`visibilitychange` / `focus` / `pageshow` /
   `online`) opens a fresh socket (`useWebSocket.ts:171-199`), which resets
   `historyLoadedRef` and re-runs `loadSessionHistory`
   (`useConnectionSync.ts:60-100`) — a *full* `/history` fetch. On mobile that
   recurs on every app switch. Windowing turns a recurring O(transcript) cost
   into a recurring O(window) one.

Also note base64 `images` compress poorly — already-compressed bytes in a text
encoding — so the heaviest rows benefit least from edge compression.

With that framing, measured against the source:

- **No limit exists anywhere on the read path.** `ChatHistoryManager.load()`
  (`chat-history.ts:590`) runs `SELECT * FROM messages WHERE session_id = ?
  ORDER BY id` (`chat-history.ts:455`) — every row, fully `JSON.parse`d.
- **The endpoint is a fat bootstrap.** `GET /api/sessions/:id/history`
  (`api-routes-session-spawn.ts:85-153`) returns messages *plus* git log, file
  tree, the full `turnUsage` series, presentations, background tasks and the
  rewind snapshot. Of these, the git log **is** bounded (`log(maxCount = 50)`,
  `shared/git.ts:268`) and `turnUsage` rows are tiny; but the **file tree is
  genuinely unbounded** (`file-tree.ts`, a recursive full scan). It scales with
  *repo size*, not dialog length — so it is not the growth axis the complaint
  describes, but it is re-walked on every switch *and every foreground
  reconnect*, putting a floor under switch latency that windowing cannot touch.
  §0 must measure it.
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
a session container, so the distribution is inferred from schema and code. Before
building, instrument one real long session:

- Total `/history` payload, split by component: message columns
  (`tool_results` / `tool_use` / `images` / `subagent_events`) **and** fileTree /
  commits / turnUsage. Without the second half the gate could bless paging while
  switch latency stays dominated by the file-tree walk.
- The time split: server `load()` vs serialize, transfer, client `JSON.parse`,
  and — separately — React mount/markdown-parse.
- How often a foreground reconnect actually fires in normal use, since it
  multiplies everything.

**Decision criterion — key on time, not bytes.** The design is justified on
time-to-interactive, so that is what should decide the ordering. If mount/render
of many rows dominates, paging is correct and goes first. If instead a handful of
heavy rows dominate *and* the time is going into transfer and parse rather than
mount, SHI-267 (lazy bodies) is the higher-leverage first move and this design
resequences behind it. Bytes are the secondary signal, not the trigger.

## Requirements

Confirmed with the user; deliberately not widened.

1. Initial load returns the latest N turns, not the whole transcript (see §2 —
   rows are not what a user means by "messages").
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

**It does not, however, make the cut position free — see §3.** The persistence
layer is indifferent to where the window starts; the *rendering* layer is not.

## Design

### 1. Windowed read

Add `ChatHistoryManager.loadWindow(sessionId, { limit, beforeId? })`. **Leave
`load()` intact**: rewind (`rollback-handlers.ts:167`) and PR-description
generation (`github.ts:1329`) legitimately need the whole history, and narrowing
`load()` would break them silently.

**Page on an id cursor, not a tail-relative offset.** An earlier draft claimed a
tail offset was "stable under concurrent appends because the agent only ever
writes at the tail." That is exactly backwards: a tail-relative offset shifts
*precisely because* rows append at the tail. If the client asks to skip the
latest K and a row lands before the query executes, the returned page overlaps
the loaded suffix and drops an older row. The stable coordinates are a **head
anchor** or an **opaque id cursor**; ids only ever grow, so `beforeId = the id of
the oldest loaded row` is stable under any amount of concurrent appending.

The cursor is ephemeral — valid until a history rewrite (`saveMessages`), which
must invalidate it and force a window reload. That is a different thing from a
durable message identity, and the distinction matters: rejecting `rowId` as a
permanent identity does not mean rejecting SQLite ids as a paging cursor.

`omittedBefore` is still returned, but as a **head-anchored count** (`COUNT(*)`
of rows below the window), which does not move under tail appends.

### 2. The window is counted in turns, floored and capped in rows

**A persisted row is not what a user means by "a message."** Message groups break
at *every tool-result boundary* (`agent-listeners.ts` sets `needsNewMessageGroup`
on each `agent_tool_result`), so a turn with 40 tool calls is ~40 rows. A flat
50-row window can therefore contain **a single turn** — and the sessions that
motivated this work ("multiple PRs in a row") are exactly the tool-heaviest ones.
Counting rows would deliver least in precisely the sessions the complaint is
about.

So the window is **the last N user-visible turns** — walk back to the Nth-newest
`role: "user"` row — with a **row floor** (never fewer than ~50 rows, so a short
turn still fills the screen) and a **row cap** (never more than ~500, so one
pathological turn cannot pull the whole transcript). N = 10 as the starting
value, subject to §0.

This costs nothing extra: locating user rows is the same machinery §3 needs for
the snap, and the floor/cap is the same conversation as the snap's cap. It is
also, in effect, what the original request asked for ("10 latest full turns").

### 3. Snap the window start to a user row — required, not polish

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

**Two things the snap does NOT cover** — stated because an earlier draft claimed
it covered everything:

- **`findPlanContent` has no user-row stop.** It scans backward to index 0
  (`MessageList.tsx:170`), so if the window opens at a steer that fell between a
  plan `Write` and its `ExitPlanMode`, the plan card renders empty. The localized
  fix is to persist the plan reference alongside `ExitPlanMode` rather than
  re-deriving it by scanning; failing that, the card must degrade visibly
  ("plan is earlier in this session") instead of silently blank.
- **The forward-snap cap collides with `turn_snapshot`.** If a long *running*
  turn is cut forward at a later steer, the HTTP window omits the turn's earlier
  rows — but the attach snapshot appends the **entire** turn from memory
  (`route-registry.ts:580`), reintroducing rows from below the window's own
  coordinate. The client is then immediately not a suffix. And if the running
  turn has no later user row, forward-snapping is impossible anyway. **The running
  turn must be exempt from the cap** — the window always includes it whole.

**This also mostly retires the turn-marker question.** The earlier draft worried
that "nearest user row" cannot distinguish a turn-opening prompt from a live
steer (steers persist as user rows inside a turn — `session-runner.ts:111-148`).
For this purpose the distinction is irrelevant: a steer *is* a user row, and a
user row is already a flush point, so snapping to one never bisects a group
either way. The cheap heuristic is exactly as good here as a persisted turn
marker would have been — which is why `turn_seq` buys nothing.

The snap is a server-side query detail: find the greatest user-row offset at or
below the requested start. No schema change.

### 4. API surface

One route, one branch — not a new subsystem.

- `GET /api/sessions/:id/history?limit=N` — today's payload, with `messages` as
  the last N rows plus `omittedBefore` (row count below the window), `hasMore`,
  and the two metadata fields below. **`limit` absent ⇒ everything, exactly as
  today**, which is both the back-compat path and the full fetch that search and
  export use. That absence *is* the opt-in; no separate activation flag is needed.
- With `&beforeId=`, return only `{ messages, omittedBefore, hasMore }` and
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

### 5. Index addressing — the one genuine hazard

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

**Rejected fix: translate the index through `omittedBefore`.** This was the
design's answer, and review broke it. The translation is only sound if the
client's array is an exact suffix of the server's rows, and the live array is a
*mixed* structure, not a database projection: optimistic user rows appended
before the server persists them, `turn_snapshot` replacing in-progress rows with
in-memory-built messages, cards appended by WS handlers, `handleReleaseCard`'s
append fallback. My earlier defence — "the suffix assumption is pre-existing, so
windowing only adds a constant offset" — is true about the *assumption* but does
not make it *sound*; it means today's rewind is already fragile, and windowing
would scale a latent off-by-N into a much larger one. That is not a defence.

**Fix: do not do ordinal arithmetic over the live array for destructive actions.**
Rewind is rare, is already blocked while a turn runs
(`rollback-handlers.ts:161`), and is the most destructive action in the product.
So before opening the rewind affordance, **fully hydrate canonical history** and
address the gap against that — or have the server issue a boundary token
(the adjacent row's id) that the client echoes back. Either removes the
coordinate problem for the dangerous path entirely, rather than making every
transient client row participate in destructive index arithmetic.

`commit_linked` is not destructive and can take the cheap path: key it on the
row id the server already knows, rather than translating a full-array index.

**The rewind confirmation preview must be computed server-side** from the
canonical position. A preview built over the client's array would understate the
blast radius on exactly the action where that matters most.

(For completeness: the scope-drop path is *not* a divergence source —
`TRANSCRIPT_SCOPED_MESSAGES` drops only messages belonging to other sessions,
`message-handlers/index.ts:261-265`.)

### 6. Client

**Stable keys without row ids.** `omittedBefore + i` is invariant: prepending M
rows decrements `omittedBefore` by M and increments every existing row's `i` by
M, so the sum is unchanged. That is a usable DOM key, replacing the array-index
keys at `MessageList.tsx:300,313` — which matters, because index keys make a
prepend remount everything below it, destroying scroll position, collapse state
and the scroll anchor itself. **Tool-group keys are index-derived too**
(`tg-${el.messageIndices[0]}`, `MessageList.tsx:264`) and need the same
treatment — and they matter more than the bubble keys, because in an agent-heavy
transcript the topmost visible element is usually a tool group, i.e. the anchor
itself. Page dedupe is unnecessary: pages are non-overlapping ranges behind a
single in-flight latch.

Note also that `buildVisualElements` runs inline in render with no memo
(`MessageList.tsx:259`), so every prepend re-runs an O(n) pass over the entire
loaded array. Correct anchoring can still feel like a hitch twenty pages in;
memoizing it is cheap insurance.

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

**Reconnect must preserve the loaded span.** This is the one bug the design would
otherwise ship. A foreground reconnect resets `historyLoadedRef` and re-runs
`loadSessionHistory` (`useConnectionSync.ts:60-100`), which `setMessages`-*replaces*
the transcript. Today that is invisible because the array is identical. Under
paging it would collapse a 500-row loaded span back to the window — destroying
every page the user scrolled to load, and their reading position with it. On
mobile, backgrounding for five seconds would throw away ten pages. The refetch
must request `limit = max(window, currentlyLoadedCount)` (or merge rather than
replace).

**The prepend must not yank the view to the bottom.** `useMessageScroll` re-pins
whenever the message count grows *and* the last row is a user message
(`:143-145`) — and that check deliberately bypasses the "user has scrolled away"
guard. That condition is true in the window between the user sending a message and
the agent's first output, which is exactly when someone scrolls up to re-read
context. A prepend there would throw them to the bottom. The prepend signal has to
suppress this branch, not just the ordinary growth branch.

**Search needs care, because the failure mode is being confidently wrong.**
`SearchBar` autofocuses and `useSearch` recomputes on every keystroke over
whatever is in `messages` (`useSearch.ts:32-53`). Naively fetching on the first
query means the user types and gets an authoritative-looking "0 results" for a
query with forty matches, which then silently changes when the fetch lands. So:
fetch when the **search bar opens**, not on first query (it overlaps typing
latency); while in flight, **suppress the count rather than showing zero** and
disable next/previous; and run the full install through the same anchor
correction as a prepend, since swapping 50 rows for 5000 otherwise teleports the
view. Use the messages-only endpoint — a full fetch through the fat route would
re-pay the file-tree walk for nothing.

Worth stating plainly so requirement 3 is not over-read: search scans `msg.text`
only — never tool output, never card content. Paging does not change that, but
"covers the whole conversation" is already narrower than it sounds.

**Export** does the same one-shot full fetch and keeps its existing client-side
serialization (`SessionItem.tsx:114-124`). No new export endpoint.

**A visible seam, not an invisible one.** The design's instinct was that the
window should be imperceptible. That is wrong here, and it is the biggest UX risk
in the doc: every way paging can fail — a slow page, a failed fetch, a reconnect,
a search still loading — presents to the user as *a transcript that stops early*.
Scrolling simply halts, with no way to tell "still loading" from "this is the
start of the session" from "something broke." This codebase has spent real effort
defending the user's trust that the scrollback is complete (`docs/163`,
`docs/188`, and CLAUDE.md's "if it has a place in the scrollback, it has a row in
the DB"); a silent floor spends that trust for a latency win.

So: a persistent element at the top of the window — label → spinner → "Couldn't
load earlier messages · Retry". Scroll proximity still auto-fires it; the element
is the affordance that remains when the fetch fails, and it is a far more reliable
target on mobile, where momentum scrolling overshoots. Pair it with a "jump to
latest" control once the user is far from the bottom: none exists today, and the
scrollbar stops being an honest depth indicator once it only reflects the loaded
window.

Note this is *navigation*, not a shell-shaped affordance — CLAUDE.md §5 bans
buttons that run commands the agent should run, which this is not.

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
- **`rowId` as a *durable message identity*.** Still rejected: ids are reused
  (`id INTEGER PRIMARY KEY`, no `AUTOINCREMENT`, `database.ts:17`), in-progress
  rows are deleted and reinserted on every rebuild, and live rows have none —
  `turn_snapshot` is built from in-memory state (`route-registry.ts:580`).
  **But ids are perfectly good as an ephemeral paging cursor**, valid until a
  rewrite invalidates them; an earlier draft conflated the two and rejected both.
  §1 now uses `beforeId`.
- **Ordinal translation of the rewind index** (`omittedBefore + gapPosition`).
  Rejected — see §5. The live array is not a reliable database suffix, and
  destructive actions must not depend on it.
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

0. **Instrumentation** (§0). The ordering question below hinges on numbers nobody
   has, and the change is small: log payload size by component, server timing, and
   client marks for parse vs mount. This is the first PR whichever way the gate
   decides.
1. `loadWindow()` — turn-counted window with floor/cap and the user-row snap +
   `?limit`/`&beforeId` on the existing route + the two metadata fields.
   Inert: no client sends `limit`, so every response is byte-identical to today.
2. **`omittedBefore` translation for rewind and `commit_linked`**, plus the
   server-side rewind preview. Must land before any client sends `limit`.
3. Client: keys (bubbles *and* tool groups), memoized `buildVisualElements`,
   prepend + scroll anchoring, prepend-aware `useMessageScroll` including the
   `appendedUserMessage` branch, reconnect span preservation, per-page card
   seeding, the `handleReleaseCard` guard.
4. The visible seam (label / spinner / retry), the jump-to-latest control, and
   the search-open fetch with a suppressed count — then the client starts sending
   `limit`.

**The gate before the client may send `limit` is larger than one sentence.** All
of these must land first:

1. A concurrency-safe older-page cursor (`beforeId`, not a tail offset).
2. Cursor invalidation + window reload after any history rewrite, including the
   cross-tab broadcast path.
3. `turn_snapshot` compatible with the window — the running turn exempt from the
   cap, so the snapshot cannot reintroduce rows from below the window.
4. Every index-bearing exchange handled: rewind preview request *and* response,
   the rewind action, `rewind_complete`, and `commit_linked` — including the
   distinction between absolute gap zero and window-local position zero.
5. Canonical hydration (or a server-issued boundary token) before any destructive
   rewind.
6. Reconnect span preservation.
7. Release-card insert-vs-update handling.
8. One request epoch covering initial history, reconnect loads, page loads,
   search expansion, session switches and rewind restore — the existing
   `historyLoadSeq` guard generalized.
9. Search/export that cannot overwrite live transcript state.
10. The visible seam. Shipping the window without it produces a transcript that
    silently appears truncated, which is worse than the latency it fixes.

The hydration race is therefore **back in scope**: it was dismissed as
pre-existing, but once window coordinates feed destructive actions it stops being
cosmetic.

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
`docs/144-rewind-fork-ux` (the `gapPosition` model §5 must translate),
`docs/188-persist-transcript-cards` and `docs/191-card-persist-on-emit` (the
persistence contract paging must not break),
`docs/237-mid-turn-reattach-snapshot` (`turn_snapshot`, the live overlay),
`docs/104-chat-toc-and-summaries` (plan-only; the other long-transcript idea).
