---
status: planned
priority: high
description: Fix the broken fork-as-new-session path and overhaul rewind/rollback UX into a single coherent "go back" model anchored to the gaps between turns.
---

# Rewind & Fork UX Overhaul

The rewind/rollback/fork system (originally landed in doc 007) has accumulated several real bugs and a confused mental model. The user-visible summary today is:

- "Fork as new session" appears to do nothing — no new entry in the sidebar.
- The user-message control only lets you fork from a point *before* a user turn, so you can't fork from the current state without sacrificing the latest exchange.
- There are two different dropdowns ("Rewind" on user messages, "Rollback" on assistant messages) with overlapping options and inconsistent vocabulary.
- After a "Rollback code + chat" the dimmed messages come back un-dimmed on reload — the `rolledBack` flag is never persisted, and neither is the "Code rolled back to X" divider message.
- After a successful fork, the in-chat "Switch from the sidebar" prompt sends the user hunting for a sidebar row that (per the first bullet) isn't there.

This doc captures both the bug fixes and a design redo. The bug fixes are urgent; the redesign should ship behind them.

## Bugs (the feature doesn't work)

### B1 — Forked sessions never reach the sidebar

`handleForkSessionFromMessage` (`src/server/orchestrator/ws-handlers/rollback-handlers.ts:80-139`) tracks the new session via `sessionManager.track(...)` inside `forkSession()` and then calls `ctx.sseBroadcast("session_list", { sessions: result.sessions })`. The SSE round-trip works (`useServerEvents` consumes `session_list` correctly), but the sidebar never renders the new row.

The culprit is the `repoGroups` `useMemo` in `SessionSidebar.tsx` (currently lines 521-557):

```ts
const repoGroups = useMemo(() => {
  const grouped = new Map<string, SessionInfo[]>();
  for (const repo of repos) grouped.set(repo.url, []);
  for (const s of sessions) {
    const key = s.remoteUrl ?? "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(s);
  }
  // …sort…
  return repos.map((repo) => ({ repo, sessions: grouped.get(repo.url) ?? [] }));
}, [repos, sessions]);
```

The function builds groups for *every* `remoteUrl` it encounters (good), then throws those groups away by returning only entries from `repos` (bad). Two concrete failure modes both hit this:

1. **Local-mode forks.** `forkSession()` (`session-fork-merge.ts:73-75`) only calls `setRemoteUrl` when the parent's `remoteUrl` is truthy. Local-mode forks therefore inherit `undefined`, the grouping key becomes `""`, the `""` bucket isn't in `repos`, and the session is dropped.
2. **Sessions whose repo was removed.** `removeRepo` clears the row from the `repos` table but leaves sessions on disk (intentional). Their `remoteUrl` is set, but `repos` no longer contains it — same failure mode.

This is structurally the same bug. Fixing it once also resolves Open Q#1 from the previous draft (which is now removed).

**Fix.** After distributing sessions, render *every* non-empty group — not just the ones in `repos`. Unmatched URLs get a synthetic header ("Other sessions", or the URL's host when present); the empty-string bucket renders under "Local sessions". Order: known repos first (existing server-provided order), then orphan groups appended in stable URL order.

### B2 — `rolledBack` and the rollback divider are both lost on reload

`rollback-complete.ts:25-27` flips `rolledBack: true` on in-memory messages only. The `PersistedMessage` interface (`chat-history.ts:10-50`) has no `rolledBack` field, and `toRow`/`fromRow` (lines 112-150) don't read or write one. After reload, dimmed messages come back fully active and their rollback dropdowns reappear.

The "Code rolled back to `abc1234`" divider has the same problem: `rollback-complete.ts:14-22` inserts it via `setMessages` only — the server never persists it. After reload, the divider disappears entirely, leaving no indication that a rollback ever happened. The client `ChatMessage` type carries `notice`/`noticeLevel` for transient system notes (see `system-notice.ts:14-19`), but the server-side `PersistedMessage` doesn't — neither field is in the type, neither column is in the `messages` table, and the divider in `rollback-complete.ts` isn't even built with `notice` today (it renders as a regular assistant message, which is part of why this bug is so easy to miss).

**Fix.** One migration, three coordinated changes:

1. **Schema.** Add five columns to `messages`: `rolled_back INTEGER DEFAULT 0`, `notice INTEGER DEFAULT 0`, `notice_level TEXT NULL` (for `info` / `warn`), `fork_child TEXT NULL` (JSON-encoded `{childSessionId, title, branch}`, used by B6/D7's persisted fork breadcrumb), and `code_rollback_hash TEXT NULL` (set on the first rolled-back row of a `code` action so the client can render the synthetic divider — see #3 below). Existing rows are silently un-dimmed (acceptable — pre-migration rollback state was already non-durable; we're not regressing).
2. **Type + mappers.** Extend `PersistedMessage` (`chat-history.ts:10-50`) with `rolledBack?: boolean`, `notice?: boolean`, `noticeLevel?: "info" | "warn"`, `forkChild?: { childSessionId: string; title: string; branch: string }`, and `codeRollbackHash?: string`. Update both mappers — `toRow` (currently 112-131) writes the new columns; `fromRow` (currently 133-150) reads them back into the same shape the client already expects. Widen `append(sessionId, message)` (currently 153-155, returns `void`) to return the inserted row id: `append(...): number` returning `this.stmtInsert.run(...).lastInsertRowid as number`. The fork breadcrumb writer needs this so D8's `{childSessionId, breadcrumbMessageId}` snapshot can address the breadcrumb row for undo (without this widening, the undo path has no row id to store and falls back to the brittle length-based truncation U4 #2 explicitly rejects). Add two sibling helpers:
   - `markRolledBackFromIndex(sessionId, gapPosition, codeRollbackHash): number[]` — runs a single `UPDATE messages SET rolled_back = 1, code_rollback_hash = CASE WHEN id = (first past-gap rowid) THEN ? ELSE code_rollback_hash END WHERE session_id = ? AND id >= (the rowid at chat position gapPosition)` (resolved via the same `stmtLoadAll`-style ordering used by `truncate`). Returns the list of flipped row ids so the `code` snapshot in D8 can store them for undo. The new `action: "code"` handler calls this inside one `db.transaction(...)`.
   - `clearRolledBack(sessionId, messageIds: number[]): void` — runs a single `UPDATE messages SET rolled_back = 0, code_rollback_hash = NULL WHERE session_id = ? AND id IN (...)`. Used by `code`-undo to reverse the flip atomically.
3. **Divider persistence is per-action, because SQLite's `messages` table is ordered by auto-increment rowid (`chat-history.ts:105`: `ORDER BY id`) and `append()` always lands at the bottom.**
   - For `action: "chat"`, no code changed — there's nothing for a "Code rolled back to X" marker to announce. No divider is inserted at all; the truncated chat *is* the indication of the rewind. (The Undo toast still surfaces, per U4 #3 / Undo toast section.) This matches today's `fork_chat` flow which also inserts no divider.
   - For `action: "both"`, past-gap rows are deleted before a divider is appended, so the new row lands at the correct position (the bottom of the kept slice). The divider is persisted as a regular row with `notice: true` and text `"Code rolled back to <short-hash>. The changes from the previous response have been reverted."` in the same `db.transaction(...)` as the deletion. The flag is what distinguishes it from a regular assistant message — both at render time (D5 styling) and at boundary-computation time (D1: notice messages are transparent to role transitions). The client derives `rolledBack` and the divider from persisted state on load — no in-place mutation in `setMessages`.
   - For `action: "code"`, past-gap rows are *not* deleted (they get dimmed in place per U5), so an `append`ed divider would land at the bottom of the chat — below the dimmed turns — not at the rewind point. Adding a sort-key column or renumbering rowids would touch every read/write site and is a much larger change than this doc wants to scope. Instead, the `code` action does **not** persist the divider as a row. The divider becomes a **client-rendered synthetic marker** computed on load: if any message has `rolledBack: true && codeRollbackHash != null`, the client inserts a virtual divider before the first such message, using `codeRollbackHash` as the displayed commit (the new optional `PersistedMessage.codeRollbackHash?: string` field is set on the *first* rolled-back row by `markRolledBackFromIndex`; cheap because it's `NULL` for every existing row and for all non-`code` rewinds). This keeps the divider visually at the rewind point and is durable across reload — the data is in the rolled-back rows themselves, not a separate row whose position we'd have to anchor.
4. **Persist the fork breadcrumb.** The same migration adds the storage that B6/D7 rely on; the fork handler `append`s a message with `forkChild` populated. Client `MessageList.tsx` detects `forkChild` and renders `SpawnedSessionCard` for the breadcrumb. Doc 117's in-memory `SpawnedSessionCard` path is unchanged — that's a separate, deliberately-unpersisted channel for agent-spawned siblings.

### B3 — Fork doesn't copy uploads

`handleForkSessionFromMessage` saves truncated chat history to the new session (`rollback-handlers.ts:117-120`) including messages with `/uploads/…` references. The new session has its own `uploads/` dir (per `getActiveDir`'s parent) — empty. Any image, screenshot, or attached file referenced by the surviving turns is a broken link in the fork.

**Fix.** Mirror the rewind helper's scan target: `deleteUploadsFromMessages` (`rewind-handlers.ts:33-50`) iterates `msg.files[].path` and accumulates paths starting with `/uploads/`. The fork copy uses the same source — walk `truncatedMessages[].files[].path` for entries beginning with `/uploads/` and `fs.copyFile` each into the new session's uploads dir. We deliberately don't scan `msg.text` for `/uploads/` substrings: the agent's prose may quote upload paths in code blocks or explanations without those entries being "live" attachments, and copying them on a substring match would over-fetch (and the rewind helper has the same scope, so the symmetry is preserved). Also include the `uploadPaths` field on `PersistedMessage` (lines 41-42 in `chat-history.ts`) in the same scan; it's the canonical record of what was actually consumed when the message was sent. Wrap in `.catch(() => {})` per-file so a missing source doesn't blow up the whole fork.

### B4 — Rewind/fork during an active turn corrupts state

All four WS handlers (`handleRewindToMessage`, `handleRollbackCode`, `handleRollbackCodeAndChat`, `handleForkSessionFromMessage`) run destructive operations — `git.rollback` (which is `git reset --hard`), `chatHistoryManager.saveMessages`, `clearAgentSessionId`, or a chat clone via `forkSession` — without checking `runner.running`. Specifically: `handleRollbackCode` (`rollback-handlers.ts:16-36`) does only `git.rollback`; `handleRollbackCodeAndChat` (lines 42-74) does `git.rollback` + `setConversationReplay` + `clearAgentSessionId`; `handleRewindToMessage` does the union depending on mode (`rewind-handlers.ts:96-144`); `handleForkSessionFromMessage` clones the workspace + copies chat history (`rollback-handlers.ts:80-139`). The client disables the buttons via `disabled={isLoading}`, but the server has no guard. A stale tab, double-click, or any non-UI client can interleave a mid-turn `git reset --hard` or an agent-session clear with an in-flight turn and corrupt the in-progress message group.

A second, subtler hazard: if the user has queued messages (`runner.messageQueue`, populated by the server-side `send-message.ts` handler — `runnerForQueue.messageQueue.push(...)` around line 138 — and surfaced to the client via the `queue_updated` WS event), a successful rewind silently strands them — they're addressed to a chat that no longer exists below the rewind point.

**Fix.**
1. Each handler resolves the runner via `resolveRunner(ctx)` (see `ws-handlers/resolve-runner.ts`), which prefers the `RunnerRegistry` over `ctx.getRunner()` — the latter returns `null` after a WS reconnect mid-turn, which is exactly the race this guard has to close. The handler early-returns `{ type: "error", message: "Cannot rewind while a turn is running." }` when `runner.running` is true. Both the running-check read and any subsequent state mutation go through the same resolved reference; never re-read via `ctx.getRunner()` inside async callbacks. Follow doc 095's capture-at-entry pattern for `sessionId`/`sessionDir` too.
2. If `runner.messageQueue.length > 0`, the server calls `runner.clearQueue()` (currently `session-runner.ts:477`) *before* the chat truncation runs its SQLite transaction, both inside the same handler call. There is no shared transaction boundary (the queue is in-memory; the truncation is SQLite) and no per-runner mutex — the JS event loop just serializes the two synchronous steps so an `enqueue` from a stale tab can only land in one of three places: (a) before the handler started, in which case the clear sweeps it; (b) between the clear and the truncation, in which case the message lands in a queue that's about to be operated on against truncated history — this is the residual race; (c) after the truncation commits, in which case it's a normal post-rewind enqueue. The residual race in (b) is intentional and bounded: `QueuedMessage` (`session-runner.ts:70-78`) carries no message-index anchor today, so the runner cannot detect "this queued message addresses a turn that no longer exists." Rather than expand `QueuedMessage` with an anchor and re-validate on dequeue (a bigger change than this doc wants to scope), we accept that a (b) message will be processed against the truncated chat — semantically it becomes a new prompt to a freshly-rewound session, which is what the user would have done by hand anyway. The user-facing pre-confirm differs by landing: Landing 1 (no new UI yet) clears unconditionally and emits a follow-up `system-notice` ("Cleared N queued message(s) as part of rewind.") so the user is told what happened. Landing 2 adds the explicit pre-confirm — U4's modal gains an extra "discard N queued messages" line for code-touching actions, and a small single-purpose modal appears for chat-only actions that would otherwise be modal-free.

### B5 — WS handler vocabulary and `messageIndex` semantics are inconsistent

The existing handlers cannot be cleanly reused by the gap UI without first being normalized:

- `rewind_to_message` (`rewind-handlers.ts:99`) does `allMessages.slice(0, messageIndex)` — index is the **first message to discard**.
- `rollback_code_and_chat` (`rollback-handlers.ts:61`) does `allMessages.slice(0, messageIndex + 1)` — index is the **last message to keep**.
- `rewind_code` mode of `handleRewindToMessage` sends a `rollback_complete` event back (`rewind-handlers.ts:121`), not `rewind_complete` — the client renders an "assistant divider" message under a *user* message index, which works by accident.

If the gap UI tries to reuse these as-is, off-by-one bugs and divider-on-wrong-side bugs are inevitable.

**Fix.** Introduce a small, coherent set of new WS message types used by every gap menu action and its supporting flows. This is the single source of truth for the type contract; downstream sections reference it by name rather than redefining shapes:

**New WS client messages (Landing 1):**
- `rewind_at_gap` — discriminated on `action`:
  - `{ type: "rewind_at_gap", gapPosition: number, action: "chat" }`
  - `{ type: "rewind_at_gap", gapPosition: number, action: "code" }`
  - `{ type: "rewind_at_gap", gapPosition: number, action: "both" }`
  - `{ type: "rewind_at_gap", gapPosition: number, action: "fork", branchName: string }` — `branchName` is the user-edited slug from U7's inline name input (required; the menu can't open Fork without it). The display title is derived server-side from the parent title plus the branch (`` `${parent.title} (${branchName})` ``, matching `forkSession()`'s existing template at `session-fork-merge.ts:69`). There is deliberately no separate `title` field on the WS message — the Fork modal exposes a single input (the slug) so the user has one thing to think about; if telemetry later shows users want independent control of the title, a follow-up adds it then. Title derivation never reaches for `generateSessionName()` (which is async / LLM-backed at `send-message.ts:270`) — that would block the fork on a round-trip with no observable user benefit since the slug is already user-edited.
  - `gapPosition` is unambiguous — "keep the first `gapPosition` messages, discard the rest." A gap at position `messages.length` is "rewind nothing, fork from the current state."
  - **`gapPosition` is always computed against the server's notice-stripped persisted view** — never the client's transient `messages` array. This matters around U6: after rewind-to-empty the client carries a `[notice]` of length 1, but the server's `chatHistoryManager.load()` returns `[]`. The client must convert its visible gap index to the server's index before sending. Convention: client tracks a `persistedIndexFor(visibleIndex)` derived from the same notice-stripping rule D1 uses for boundary computation. The empty-chat surface always maps to `gapPosition: 0` on the wire. D2's server-side enforcement (returns "Nothing to rewind…" when a non-fork action arrives with `gapPosition === messages.length`) uses the server's view and is therefore unambiguous.

**New WS client messages (Landing 2):**
- `rewind_preview_request` — `{ type: "rewind_preview_request", gapPosition: number, action: "chat" | "code" | "both" | "fork" }`. Sent when the menu opens; populates the modal counts (U4 + UI spec).

**New WS server messages (Landing 1, all variants of `rewind_complete` and the redefined `session_forked`):**
- `{ type: "rewind_complete", gapPosition: number, action: "chat", droppedMessageCount: number }` — client drops everything past `gapPosition`.
- `{ type: "rewind_complete", gapPosition: number, action: "code", commitHash: string }` — client refreshes the file tree and applies the dim treatment past the rewind point (U5). The client updates its in-memory `messages` array by setting `rolledBack: true` on entries at index ≥ `gapPosition` and stamping `codeRollbackHash = commitHash` on the first such entry — purely positional, no per-row id required. The divider itself is **not** a server-inserted row — the client renders it synthetically before the first message with `rolledBack: true && codeRollbackHash != null` (see B2 #3 for the architectural reason). The server keeps the exact list of flipped row ids in the `rewind_snapshots.payload_json` for undo (B2 #2 / D8) — that list lives only in the snapshot, never on the wire, because `ChatMessage` / `PersistedMessage` carry no row-id field on the client today and bolting one on for this single use case isn't worth it. Definitionally: the divider sits at the rewind point and announces what's beneath it; nothing above the divider gets dimmed.
- `{ type: "rewind_complete", gapPosition: number, action: "both", droppedMessageCount: number, commitHash: string }` — drop + reset.
- `{ type: "session_forked", parentSessionId: string, childSessionId: string, title: string, branch: string }` — sent on the initiating connection; client auto-switches to the child (D7). Replaces today's `{ sessionId, sessionName }` shape.

**New WS server messages (Landing 2):**
- `{ type: "rewind_preview", gapPosition: number, action: "chat" | "code" | "both" | "fork", discardedTurnGroupCount?: number, keptTurnGroupCount?: number, fileCount?: number }` — reply to `rewind_preview_request`. Counts are scoped per action so the client doesn't have to derive subtitles from an ambiguous "turn-group count":
  - `chat` / `both` → server returns `discardedTurnGroupCount` only; client renders "Discard N turn-groups". `fileCount` only on `both`.
  - `code` → `discardedTurnGroupCount` (the messages that get dimmed) + `fileCount`; client renders "Reset N files. Chat kept, N turn-groups dimmed."
  - `fork` → `keptTurnGroupCount`; client renders "Includes N turn-groups…" in the Fork modal (matches the modal mockup). `fileCount` is omitted for fork — the child's files are exactly the kept-side commit, not a diff against anything.

  Each count is optional at the type level so the response stays narrow, but the action discriminates which subset is required. A `rewind_preview` for `fork` without `keptTurnGroupCount` is a server bug.
- `{ type: "fork_breadcrumb", parentSessionId: string, message: PersistedMessage }` — emitted via the parent runner's `runner.emitMessage` so every viewer attached to the parent (other tabs, other devices) sees the just-persisted breadcrumb row without a reload, per CLAUDE.md's "emit via `runner.emitMessage`, not `ctx.send`" rule. See D7 for sequencing; ships in Landing 2 (Landing 1 only the initiating viewer sees the card immediately — see Landing 1's B6 note).

**Removed in Landing 2** (no external consumers — WS-only, internal — so no deprecation window):
- Client → server: `rewind_to_message`, `rollback_code`, `rollback_code_and_chat`, `fork_session_from_message`.
- Server → client: today's `{ messageIndex, mode, parentCommitHash }`-style `rewind_complete` / `rollback_complete` shapes.

Each new variant carries exactly the fields the client needs to render its post-state without re-fetching. Implementer note: the `rewind_at_gap` server handler ships in Landing 1 and Landing 1's client is also cut over to send it — the per-button `messageIndex → gapPosition` conversion is the client-side rewiring (see Landing 1 below). The old WS messages and their handlers stay alive in Landing 1 only so the cutover is reversible if a bug surfaces; they're deleted in Landing 2 once the new gap UI replaces the old per-message dropdowns. Splitting "ship the new handler + cut over the client" across two landings was rejected as it would leave Landing 1 with two parallel rewind paths and no guarantee they stay in sync.

### B6 — `session_forked` strands the user

`handleSessionForked` (`session-forked.ts`) just appends a chat message: "Session forked as 'X'. Switch to it from the sidebar." This is exactly the link-out failure mode CLAUDE.md §1/§2 prohibits — the user explicitly asked to fork, and we're telling them to go hunt for the result. Combined with B1, today they're hunting for a row that doesn't exist.

**Fix.** On fork success:
1. Server response stays `session_forked` (payload aligned with B5's typed shape: `{parentSessionId, childSessionId, title, branch}`).
2. Client auto-navigates to the new session (same code path as `setSessionId`).
3. The *parent* session's chat gets a breadcrumb card that reuses the **rendering** of `SpawnedSessionCard.tsx` (status pill, branch, "Open" button — the existing component is reused as-is) but routed through a new persisted channel.

**The persistence is net-new — doc 117 deliberately punted on it.** `docs/117-agent-spawned-sessions/plan.md` notes explicitly that "No persistence of the `SpawnedSessionCard` in chat history" was a Phase 1+2+3 choice. The actual mechanism today: `handleSessionSpawned` (`src/client/hooks/message-handlers/session-spawned.ts`) receives the live `session_spawned` WS event and pushes a `ChatMessage` with `spawnedSession` into `useSessionStore.setMessages(...)`. The message lives only in client memory; nothing is written to the SQLite `messages` table, and on reload the card is gone (only the sidebar row survives, via the unrelated `session_list` SSE broadcast). That live-only mechanism is *not* sufficient here, because a fork's breadcrumb must survive page reload (the user navigates away to the child, comes back days later, and expects to see the link). Concretely: the fork handler `append`s a `PersistedMessage` with a new field — `forkChild?: { childSessionId: string; title: string; branch: string }` — added to the `PersistedMessage` interface in the same B2 migration that adds `notice`. The client renderer in `MessageList.tsx` detects `forkChild` and renders `SpawnedSessionCard` (which is already wired to look up live status from `useSessionStore`). The `session_spawned` WS event remains unpersisted and unchanged — this is a deliberately separate, persisted channel for the fork case. If a follow-up to doc 117 decides to persist the agent-spawned card too, it can hang off the same field; for now this doc owns the persistence.

### B7 — Zero integration coverage

`grep -r "rewind_to_message\|fork_session_from_message\|rollback_code" src/server/orchestrator/integration_tests` returns nothing. The only adjacent tests are `git-rollback.test.ts` (raw simple-git layer) and `MessageList.test.tsx` (button visibility). Three rewind modes × three rollback modes × fork, all destructive, all untested. B1-B6 survived because nothing exercises this path end to end.

**Fix.** Add `src/server/orchestrator/integration_tests/rewind-fork.test.ts`, split per landing so reviewers can tell which cases ship with which work:

**Landing 1 — bug-fix + cutover coverage.** Tests exercise the new `rewind_at_gap` handler end-to-end (the client is cut over per B5's conversion table — the old WS messages stay alive only as a reversibility hatch and are removed in Landing 2). Cases:
- `rolledBack: true` survives a reload (`chatHistoryManager.load(sessionId)`) (B2).
- After `action: "both"`, the persisted divider row (notice + "Code rolled back to X" text) survives a reload (B2 #3). After `action: "code"`, no divider row is appended; the client-side load reconstructs a synthetic divider from the first row's `codeRollbackHash` and the same visual is presented. After `action: "chat"`, no divider exists at all — confirm reload produces the truncated chat without any spurious notice row.
- `rewind_at_gap` with `action: "code"` writes atomically (U5 / B2 #3): every message originally at index ≥ `gapPosition` gets `rolled_back = 1`, and the *first* such row gets `code_rollback_hash = <commit>` set. **No divider row is appended for `code`** (the divider is client-rendered from `codeRollbackHash`). Both reads (right after the call, and after a database-reopen-simulated reload) confirm the same shape; the client renderer produces the synthetic divider before the first rolled-back row in both cases. Messages above the rewind point are unaffected.
- Fork copies referenced uploads into the new session's dir (B3).
- Each old WS handler returns an error and leaves state unchanged when `runner.running === true` (B4).
- Rewind with `runner.messageQueue.length > 0` clears the queue unconditionally and emits the system-notice (B4 — this matches Landing 1's interim "no modal" behavior; the explicit pre-confirm tests land in Landing 2).
- Fork persists a breadcrumb (`PersistedMessage` with `forkChild`) in the parent's chat history (B6 / D7); the client auto-switches on `session_forked` (the latter assertion belongs in a hook-level test at `src/client/hooks/message-handlers/session-forked.test.ts` — new file co-located with the rewritten handler — not the integration file).
- B5's `rewind_at_gap` happy path for each `action` (so the new server-side handler is exercised even though the new client UI isn't live yet). Gap-position coverage: first / middle for all four actions; `action: "fork"` is additionally tested at the last gap (`gapPosition === messages.length`); the three non-fork actions at the last gap go in the error-path bucket below because D2 makes them server-rejected.
- `rewind_at_gap` with `action: chat | code | both` at `gapPosition === messages.length` returns the "Nothing to rewind from the current state." error and leaves state unchanged (D2's server-side enforcement).

**Landing 2 — gap-UI coverage.** Adds:
- `rewind_preview` returns the correct `{turnGroupCount, fileCount}` for representative gap positions, including with `notice` messages straddling the gap (D1) and a trailing user message at the last gap (D2).
- `rewind_snapshots` round-trip across each action shape (D8): chat-only restores history; code-only resets HEAD; both runs the sequenced pair; fork archives the child and removes the parent breadcrumb. Each test simulates an orchestrator restart by reopening the SQLite database before restore so the durability claim is exercised.
- `both` undo when `git reset --hard` fails (reflog pruned): chat is restored, the toast surfaces the inline-error path described in the Undo toast section, and the snapshot row remains until TTL so "Recover recent rewind" can re-attempt (U4 #3).
- `fork_breadcrumb` event is emitted to other parent-viewer connections on fork; a second `TestClient` attached to the parent runner observes the breadcrumb without reloading (B5 / D7).
- Rewind with `runner.messageQueue.length > 0` shows the explicit pre-confirm modal (U4 + B4), and confirming clears the queue.
- gap-0 ("rewind to empty") for each non-fork action: chat returns empty history; code resets to the session's first commit (per D2); both does both.

**Landing 2 — client-side, `src/client/components/RewindPoint.test.tsx`.** Streaming-disabled visual states (D3: gap-after-last hidden, intermediate gaps disabled with tooltip), the role-transition computation including notice-message transparency (D1), gap-after-last menu shows only the fork item (D2 + D6), Plus icon only on gap-after-last pill, and aria-label correctness.

The integration file owns persistence/correctness; the client file owns UI states.

## UX problems

### U1, U2, U3 — Resolved by the new "rewind point" design

The three biggest UX problems all stem from the same root: controls are attached to *messages* instead of to *points in time*. Today's controls only let you fork *backwards* from a past turn (so there's no way to fork from the current state without sacrificing the latest exchange), and because each control is attached to a message it's never obvious whether that message is on the kept side or the discarded side. On top of that, the two dropdowns use different vocabularies for the same operations, and the floating `-top-3 -right-3` chip is invisible on touch and clips behind the scrollbar on narrow viewports.

The new design — described in "Proposed design" below — replaces all three with a single control anchored to the **gap between turns** (and after the last turn). It eliminates the message-attachment ambiguity by construction, gives us a natural surface for fork-from-current (the gap after the last message *is* the current-state rewind point), and lets us drop the floating-chip placement entirely.

### U4 — No confirmation, no undo

`chatHistoryManager.saveMessages` is a delete-and-reinsert transaction (`chat-history.ts:205-212`; the adjacent `truncate` at 191-202 has the same property for partial wipes). `git.rollback` is `git reset --hard`. Both are one-click and irreversible from the UI. The only recovery today is `git reflog` from a terminal — which restores files but loses chat history, and which violates the "inline beats link-out" product principle.

**Fix.** Four pieces, designed together:

1. **Selective confirmation.** Chat-only rewind ("Rewind chat to here") is cheap and recoverable — no modal, just fire and rely on the undo toast. Code-touching actions ("Rewind code", "Rewind chat and code", "Fork") get a confirmation dialog with a summary derived from server-computed counts: "Discard 3 turn-groups and reset 5 files. Continue?" The "turn-group" wording matches D1's role-transition definition — a single user prompt followed by an assistant response is one turn-group, not two — which the count derivation also uses. This resolves the apparent tension between the doc's "geometric clarity removes ambiguity" claim and the modal: the geometry handles *what* gets discarded; the modal exists for *destructive-to-code* operations the user can't visually inspect.
2. **Snapshot shape varies by action.** The `rewind_snapshots` table stores a discriminated row per action (the table is keyed on `(sessionId, ts)` with `action` discriminating `payload_json`):
   - `chat` → `{messages: PersistedMessage[]}`. Undo replaces history via `saveMessages`.
   - `code` → `{headHash: string, flippedMessageIds: number[]}`. Undo resets HEAD AND calls `clearRolledBack(sessionId, flippedMessageIds)` so the dim-and-divider effect is fully reversed. Storing the ids (rather than recomputing from `gapPosition` at undo time) protects against new rows landing past the gap during the 5-minute TTL — the undo only un-flips the exact rows the original action flipped.
   - `both` → `{messages: PersistedMessage[], headHash: string}`. Undo runs both restores in sequence (see U4 #3 for the non-atomicity story).
   - `fork` → `{childSessionId: string, breadcrumbMessageId: number}`. **Fork doesn't truncate or git-reset the parent** — only the child gets the truncated copy. The single parent-side mutation is the breadcrumb append from D7 (a `PersistedMessage` with `forkChild` populated). Undo archives the child session (workspace + container teardown — see disclaimer below) and removes the breadcrumb by primary-key row id. Using the row id rather than the pre-append chat length matters because new entries can land in the parent's chat during the 5-minute window (another turn, an agent-spawned card, a system notice, an inbound message in another tab), and length-based truncation would silently discard them. If the breadcrumb row is already gone (the user manually cleared chat history, or another mechanism removed it) the undo proceeds with the child teardown and the toast notes that there was no breadcrumb to remove — never an error. **The fork snapshot is keyed on the *parent* sessionId, not the child** (see D8). Because D7 auto-switches the user to the child, the immediate Undo toast renders on the child view but its handler targets the parent's snapshot; the post-toast "Recover recent rewind" entry appears in the *parent's* `SessionTopBar` overflow — when the user navigates back to the parent within the 5-minute TTL, the entry is there. On the child view that the user lands on, "Recover recent rewind" is absent for the fork (the child has no parent-mutating action to recover). Tests in B7 assert both surfaces explicitly.

   **Undo is not reversibly cheap for fork.** Per CLAUDE.md's disk-cleanup section, `archiveSession` signals `removeVolumesOnDispose = true` and `ServiceManager.stop({ removeVolumes: true })` appends `--volumes` to `docker compose down` — so any named volumes the child Compose stack declared (e.g. `node_modules` caches) are dropped permanently. A user who forks, lets `npm install` run inside the child, then hits Undo within 5 minutes loses that install. We accept this because (a) the alternative of leaving orphan volumes behind would leak disk indefinitely on every fork-undo cycle, and (b) the toast text — "Forked to *X*. **Undo**" — already communicates that Undo unwinds the fork; a user who has done work in the child has a clear signal they're undoing it. The toast does not warn about volumes specifically; if telemetry shows users hitting this surprised, a confirmation modal is the right next step.
3. **Restore is not cross-system atomic.** The `chat` and `code` paths each run inside a single SQLite transaction / single git command and are atomic on their own. The `both` path is sequenced: chat first inside one SQLite transaction, then `git reset --hard <headHash>`. If the reset fails (e.g. the reflog has been pruned mid-window, which the 5-minute TTL is designed to avoid but can't guarantee), the chat restore is left applied and the undo toast surfaces an inline error suggesting the user run `git reflog` in the inline terminal panel to find the lost commit — inline per CLAUDE.md §1, not a link-out to anything external. The `fork` path is similarly sequenced: child teardown, then parent chat truncation. We avoid claiming cross-system atomicity that SQLite + git can't actually provide. Snapshots are stored in a small `rewind_snapshots` SQLite table with 5-minute expiry. (No `branch` field — none of the rewind actions cross branches, so `git.rollback()`'s straight `git reset --hard <hash>` is the right restore primitive.)
4. **Undo affordance is dual-track.** A 10-second "Rewound. **Undo**" toast covers the common case. For up to 5 minutes after, a discreet "Recover recent rewind" entry lives in `SessionTopBar.tsx`'s `DotsThreeVerticalIcon` overflow menu — the same `DropdownMenuContent` that already holds Rename / Download chat / Archive (currently around lines 91-103). Inline per the product principle, not a link-out to `git reflog`.

The new server pair `rewind_preview_request` / `rewind_preview` lets the client populate the confirmation modal's counts without a roundtrip per keystroke. The client requests when the menu opens; server returns counts per the per-action shape defined in B5 — `discardedTurnGroupCount` for rewind actions, `keptTurnGroupCount` for fork, plus `fileCount` where applicable. Turn-group counts are computed from role transitions on the kept-vs-discarded split (notice-stripped per D1); file counts are `git diff --name-only HEAD <target>`.

If the user has queued messages at the time of the action, the modal gains one extra line — "You have N queued messages; rewinding will discard them" — and confirming clears the queue. The chat-only path stays modal-free unless the queue is non-empty; if it is, a small single-purpose dialog ("Discard N queued messages and rewind?") appears. We deliberately keep the queue-clear confirmation distinct from the file-count modal so D4's "chat-only is modal-free" promise still holds in the common case.

### U5 — Stale chat after a code-only rewind

After "Rewind code" the chat still shows messages discussing files that no longer exist. A "Code rolled back to `abc1234`" notice is inserted at the rewind point, but the now-stale turns above it are not marked.

**Fix.** When rewind-code finishes, the server marks every message at index ≥ `gapPosition` (the ones whose code effects were just reverted) with `rolledBack: true` — both assistant turns *and* the user prompts that drove them — and stamps `codeRollbackHash = <commit>` on the *first* such row. The client renders a synthetic "Code rolled back to X" divider before the first row with `rolledBack: true && codeRollbackHash != null`; the divider is *not* persisted as its own row (see B2 #3 for the architectural reason — SQLite's id-ordered `messages` table can't position an appended row in the middle of the chat without invasive rowid renumbering, and `code` doesn't truncate the past-gap rows the way `chat` and `both` do). `MessageList.tsx:390` already applies `opacity-40` to `rolledBack` regardless of role, so dimming and hiding their hover affordances (gap menus and any per-message controls that survive Landing 2) is one consistent treatment. Stale turns stay visible for reference but are visually demoted on both sides of the conversation. Depends on B2 for `rolledBack` + `codeRollbackHash` to survive reload, so ships in Landing 1 alongside B2 and the new `action: "code"` handler (the original draft listed this under Landing 3 polish; all of its dependencies actually land in Landing 1 and the renderer already exists, so deferring it added nothing).

### U6 — Empty chat after first-message rewind is silent

Rewinding to the gap above the first message truncates the chat to an empty array with no marker. The session looks nuked.

**Fix.** When the truncated slice is empty, push a `notice` message ("Conversation rewound to start. Send a message to continue.") through the chat. Uses the existing `notice`/`noticeLevel` rendering path. The notice is **client-only and transient** — it lives in `useSessionStore.messages` for the lifetime of the current page, and the server never persists it (no `append` / `saveMessages` call). On reload the session is back to an empty array and renders the existing first-run experience; if the user sends a follow-up before reloading, the message is appended after the notice and the notice fades on its next render cycle (the rendering rule: an empty-chat notice is suppressed whenever a user message is present). This keeps the notice from being mistaken for a real turn-group by D1's role-transition computation and avoids stale "rewound to start" markers on revisit.

### U7 — Forks get opaque names

`fork-{8-char-uuid}` is unsearchable and tells the user nothing. The sidebar row reads "Parent title (fork-3f8a91b2)".

**Fix.** When the user picks "Fork as new session", show an inline single-line input pre-filled with a slug derived synchronously from the gap's most recent kept user message (trim, lowercase, replace non-`[a-z0-9]` runs with `-`, cap to ~40 chars). For the gap-after-last with no recent user message in the kept window, fall back to the parent's session title slug. Let the user edit before confirming. We deliberately do *not* call `generateSessionName()` here (which is async / LLM-backed and lives at `send-message.ts:270`) — it would block the modal on a round-trip; the synchronous slug is fine because the user is going to edit it anyway. The input control mirrors the rename input in `SessionTopBar.tsx` (the inline single-line `<input>` wired up at lines ~50-72) — we reuse its keyboard behavior (Enter to confirm, Escape to cancel, blur to commit) so the modal's field feels native to the rest of the app.

### U8 — Replay is text-only and frequently empty

`buildConversationReplay` (`services/replay.ts`) flattens each message to `User: …` / `Assistant: …` — tool calls, tool results, images, and file references are dropped. For tool-heavy sessions, where assistant turns can be purely tool-use with no narrative text, the replay reduces to `"Assistant: "` placeholders, which is worse than no replay at all. Any rewind/fork that resets the agent session loses that context, and Claude's continuation is markedly less informed than the pre-rewind turn was.

**Fix.** Include a compact summary of tool results (tool name + short result excerpt, capped at e.g. 500 chars per tool) and a manifest of attached files/images (paths, not content) in the replay. Behind a settings toggle or model-budget guard if we're worried about tokens — see Open Q#1.

## Design decisions (resolved before Landing 2)

The previous draft deferred several questions that turn out to be load-bearing. Locking them down here.

### D1 — Turn-group boundary = role transition

A "turn" is a maximal run of consecutive same-role messages. Gaps render between role transitions, **plus one synthetic gap above the first message** (so `gapPosition === 0` has a UI surface — see D2's gap-0 behavior) and one after the last message (the gap-after-last per D6). The client computes boundaries from the flat `messages: PersistedMessage[]` array; persistence changes are owned by B2 (adding `notice` to `PersistedMessage` so the divider survives reload).

This deliberately differs from the server's internal `agent_tool_result`-based grouping (which informs streaming chunking but isn't persisted). For the rewind UI, the user's mental model is "user said X, then assistant did stuff" — role transitions are the right granularity. Sub-turn gaps (between two assistant messages during a single agent run) are not useful and would clutter the chat.

**`notice` messages are transparent to the boundary computation.** Transient system notes today render as `role: "assistant"` with `notice: true` on the client type (`system-notice.ts:14-19`) but are not persisted. After B2, the rollback divider becomes the first persisted `notice` message — the server-side gap handler `append`s it with `notice: true` inside the truncation transaction (B2 #3). The client-side `rollback-complete.ts:14-20` insertion via `setMessages` is *removed* in Landing 2 (along with the four old WS messages it serviced); leaving the client construction in place would re-create the not-persisted bug B2 fixes. A `notice` message between, say, two user messages must not manufacture a phantom user→assistant→user gap pattern. The boundary computation skips `notice: true` messages entirely — they belong visually to the surrounding turn-group (no gap above or below), and they're carried along with whichever side of an actual role-transition gap they fall on. The `rewind_preview` count derivation must use the same notice-stripped view, or the modal will report wrong turn-group counts.

### D2 — `gapPosition` is the count of kept messages

See B5. One number, one meaning. A gap at `gapPosition === messages.length` means "fork from current state" (kept = everything). A gap at `gapPosition === 0` means "rewind to empty" (kept = nothing) — this is a valid op and is the case U6 is built around (an empty-chat notice is rendered after the truncation so the session doesn't look nuked).

**Rendering of gap-0.** D1 adds an explicit synthetic gap above the first non-notice message so gap-0 has a UI surface whenever the chat contains any real turns — it follows intermediate-gap styling, and its menu has the full four actions (see below). When the chat is effectively empty (no non-notice messages) there is no separate gap-0 row — the gap-after-last *is* the gap at position 0, and it inherits gap-after-last styling (fork-only menu per D6). The "non-notice" qualifier matters: after U6's empty-chat notice lands, `messages` is `[notice]` (length 1), but boundary computation is notice-stripped (D1), so the visible state is still "effectively empty" and only the gap-after-last renders — no competing intermediate gap-0 above the notice. The empty-chat case has nothing to rewind from in any of the three non-fork actions, so showing them disabled would be noise. "Rewind to empty" only makes sense when the chat is *non-empty*; once the rewind completes, U6's notice lands and the next render shows the empty-chat gap (fork-only). The transient state where the user opens the menu at non-empty gap-0 and picks "Rewind chat" is the one where all four actions are present.

**Menu actions at non-empty gap-0:** "Rewind chat" empties history; "Rewind code" resets HEAD to the session's first committed state — the `parentCommitHash` of the earliest message that has one (a forward-walking loop, distinct from the backward-walking `findCommitBeforeMessage` helper; the existing code-path that uses this is `handleRewindToMessage`'s fallback at `rewind-handlers.ts:84-91`, which walks forward from `messageIndex` looking for the first `parentCommitHash`). If no message carries a `parentCommitHash` either, the action is unavailable and the menu surfaces a disabled item with tooltip "No earlier code state to reset to". "Rewind chat and code" does both; "Fork" forks from an empty kept slice (the child opens with no chat; the user's first message there is the start of the new conversation). We deliberately do *not* use `git rev-list --max-parents=0 HEAD` for "session's first commit" — that returns the repo's root commit, which for forked or worktree-derived sessions discards everything the parent had committed before the fork.

**Menu items at the gap-after-last.** When `gapPosition === messages.length` the three rewind actions are no-ops by construction (there's nothing past the gap to discard or reset), so the menu shows only the fork action — not all four with three of them disabled. The accompanying confirmation modal, when opened, shows the fork-name input instead of the rewind summary. D6's prominent visual treatment is *because* this gap is fork-only; rendering grayed-out rewind items there would muddle the affordance. The boundary case is enforced server-side too: a `rewind_at_gap` with `action: "chat" | "code" | "both"` and `gapPosition === messages.length` returns `{ type: "error", message: "Nothing to rewind from the current state." }` so a stale client that opened the menu before a streaming turn appended new messages can't no-op the server into corrupted state.

**Trailing-user-message edge case (intermediate gaps).** If the kept slice ends on a user message with no following assistant turn (the agent errored, was interrupted, or never started a response despite the user message persisting), the fork includes that pending prompt in the persisted history copied to the child. The conversation replay (`services/replay.ts`) carries it as context in the child's first agent system prompt — `buildConversationReplay` formats the kept messages as system-prompt context rather than auto-issuing a turn — so the child opens with the trailing user message visible but the user must send a follow-up (or the agent must be explicitly nudged) to actually drive a turn. We deliberately do not strip the trailing user message: the user explicitly chose to fork from this point, and stripping the prompt would silently change the kept slice in a way the gap geometry doesn't communicate.

### D3 — Streaming-turn behavior is specified

While `runner.running === true`:
- The gap-after-last is **hidden**. There's no "current state" until the auto-commit fires.
- Intermediate gaps remain visible but **disabled**, with a tooltip ("Wait for the current turn to finish") on hover/focus. This avoids the user clicking a gap and getting a server error.

When the turn ends, the gap-after-last reappears (with the new commit hash) and intermediate gaps re-enable.

### D4 — Confirmation policy

- "Rewind chat to here" → no modal, just an undo toast.
- "Rewind code", "Rewind chat and code", "Fork as new session" → confirmation modal with server-derived counts, then undo toast.

The modal exists for code-touching actions because the user can't visually inspect "I'm about to reset 5 files" the way they can visually inspect "I'm about to discard the turns below the line."

### D5 — Mobile/touch affordance

The gap renders a **persistent very-low-contrast hairline** (≈10% opacity) at all viewport widths. On desktop, hover bumps to full opacity and reveals the chevron. On touch, tapping anywhere in the gap row opens the menu. Long-press is supported but isn't the primary path — the persistent hairline makes the affordance discoverable without it.

### D6 — Gap-after-last gets a slightly more prominent treatment

It's the only fork-from-current entry point in the new design, so its discoverability matters. The gap-after-last is rendered with:
- ~50% taller than intermediate gaps (so it reads as a dedicated row),
- A persistent, fully-visible pill containing only a `Plus` icon — no rewind icon. The menu at this gap is fork-only (D2), so showing a rewind icon would promise an affordance the menu doesn't deliver,
- Hairline at full opacity at rest,
- Aria-label "Fork from current state."

No first-run cookie. The treatment is unconditional.

### D7 — Fork success auto-switches with a breadcrumb

See B6. On successful fork, the client auto-navigates to the new session, and the parent session's chat gets a card (rendered with `SpawnedSessionCard`) as a breadcrumb back. The rendering is shared with doc 117's spawned-card; the **persistence** is *not* — doc 117 deliberately re-renders the card live from the turn-event buffer and explicitly does not persist it, while the fork breadcrumb must survive reload. B6 defines the new persisted channel (a `forkChild` field on `PersistedMessage`, added in the same B2 migration).

**Sequencing.**
1. Server `append`s the breadcrumb (`PersistedMessage` with `forkChild` populated) to the parent's chat history.
2. Server resolves the **parent** runner via the registry — `ctx.getRunnerRegistry().get(parentSessionId)` — *not* `ctx.getRunner()`. This matters because step 4 will auto-switch the initiating connection to the child, after which `ctx.getRunner()` would return the child runner (or `null` if the WS reconnects mid-flow), and the broadcast would silently drop. The registry-first resolution is the CLAUDE.md-mandated pattern for any post-mutation broadcast that has to find a runner by id.
3. Parent runner emits `{ type: "fork_breadcrumb", parentSessionId, message }` via `runner.emitMessage` so every viewer attached to the parent — including ones in other tabs that didn't initiate the fork — sees the new card without a reload (per CLAUDE.md's "emit via `runner.emitMessage`, not `ctx.send`" rule).
4. Server sends the `session_forked` response to the initiating connection.
5. Initiating client auto-switches on receipt; the parent's viewers (including the just-departed initiator's connection while it persists) keep their breadcrumb.

Net effect: the initiating user sees the new session immediately; other tabs viewing the parent see the breadcrumb inline; when anyone navigates back to the parent (via sidebar, history, or the breadcrumb's reverse link from the child), the breadcrumb is already persisted. No race between persistence and navigation.

### D8 — Snapshot storage

The snapshot lives in a small SQLite table `rewind_snapshots(sessionId, ts, action, payload_json)` with a 5-minute TTL enforced on read (lazy cleanup) plus a startup sweep. `action` discriminates the `payload_json` shape per U4 #2 (`{messages}` for `chat` / `{headHash, flippedMessageIds: number[]}` for `code` / `{messages, headHash}` for `both` / `{childSessionId, breadcrumbMessageId}` for `fork`). For `chat` / `code` / `both`, `sessionId` is the session that was rewound; the SessionTopBar "Recover recent rewind" entry queries by the active session id, so the entry surfaces wherever the rewind happened. For `fork`, `sessionId` is the **originating parent's** id — fork's only parent-side mutation is the breadcrumb append, and the undo also targets the parent. Because D7 auto-switches the user to the child, the post-toast "Recover recent rewind" entry is absent on the child view and present on the parent view (see U4 #2 — B7 covers this). Durable across orchestrator restarts so the "Recover recent rewind" overflow item still works after a crash within the window. An in-memory Map was considered and rejected — the durability cost is one tiny table.

Restore is not cross-system atomic; the actual sequencing and failure modes are documented in U4 #3 so the discrepancy doesn't have to be re-explained here. Anything load-bearing about atomicity belongs in that single source.

## Proposed design — rewind points between turns

Replace both per-message dropdowns with **one** control, anchored to the **gap between role transitions** (D1) and after the last turn. The control after the last turn doubles as "fork from the current state."

### Why between turns

When the control is attached to a message, the question "is this message kept or discarded?" has to be answered by the menu label and the user has to read carefully every time. When the control sits in the gap, the answer is geometric: **everything above the line is kept, everything below it is gone.** The modal in D4 exists for the file count, not for the chat geometry.

### Visual treatment and menu

See the "UI spec" section below for sketches of each surface (intermediate gap at rest, on hover, the menu, confirmation modal, undo toast, recover-overflow item). High-level rules:

- Intermediate gaps: 16-24px row with a persistent very-low-contrast hairline (D5). Hover/focus brings the hairline to full opacity and reveals a small pill with the rewind icon.
- Gap-after-last: ~50% taller, pill always visible, hairline always at full opacity (D6).
- Streaming: gap-after-last hidden; intermediate gaps disabled with tooltip (D3).
- Menu: at intermediate gaps, four actions (rewind chat / rewind code / rewind both / fork). At the gap-after-last, only the fork action — the three rewind actions are no-ops there by construction (D2) and are hidden from the menu entirely. Code-touching actions open the confirmation modal first (D4). Counts in the modal come from `rewind_preview` (U4).

The server resolves the target commit from `gapPosition` by walking the kept-side suffix for the latest assistant message with a `commitHash`. For `gapPosition === messages.length` the target is `HEAD` (the most recent auto-commit).

### Behavior summary

All actions:
- Require `!runner.running` (B4).
- Use `rewind_at_gap` WS message (D2 / B5).
- File and message counts come from `rewind_preview_request` / `rewind_preview` (U4).
- Confirmation policy per D4.
- Undo toast + topbar "Recover recent rewind" entry (U4 / D8).
- Tab-focusable; Space/Enter opens menu; Cmd/Ctrl+Z on a focused gap opens menu directly.

### Implications

- `RewindDropdown` and `RollbackDropdown` both go away. Their per-message wiring in `MessageList.tsx:415-437` goes away.
- The four old WS messages (`rewind_to_message`, `rollback_code`, `rollback_code_and_chat`, `fork_session_from_message`) and their handlers are removed (B5).
- The "Fork conversation from here" label trap disappears — the new menu items describe their actual effect, and the only thing called "Fork" creates a real new session.
- `session-forked.ts`'s "Switch from sidebar" text is gone (B6).

## UI spec

Concrete visual targets for the `RewindPoint` component and its associated surfaces (confirmation modal, undo toast, recover-overflow item). Sketches are ASCII-only; the implementer should follow the design tokens in `src/client/design-tokens.ts` for sizing/spacing and the existing `--color-*` CSS variables for color.

### Intermediate gap — at rest

A 16-24px row between every role transition. A hairline runs across the chat column at ~10% opacity (use `--color-border-secondary` faded, or `--color-border-primary` at low alpha). No button, no text — the hairline is the only affordance hint.

```
┌──────────────────────────────────────┐
│  How do I add a debounce here?       │
└──────────────────────────────────────┘

   ╶───────────────────────────────╴      ← ≈10% opacity hairline, 16px row

┌──────────────────────────────────────┐
│  I'll wrap the handler in lodash…    │
│  [tool: Edit src/App.tsx]            │
└──────────────────────────────────────┘
```

### Intermediate gap — hover or keyboard focus

Hairline goes to full opacity. A small pill appears centered on the line, ~20px tall × ~32px wide, containing an `ArrowCounterClockwise` icon at `ICON_SIZE.XS` (12px) — matches the icon the existing RewindDropdown already uses, so the affordance reads as "rewind point," not as a brand-new control. Background `--color-bg-secondary`; border matches the hairline so the pill looks like it's *on* the line.

```
   ───────────────  ⟲  ───────────────    ← full-opacity hairline + pill
```

Focus ring on the pill when reached via Tab. Cmd/Ctrl+Z while focused opens the menu directly (skips the click step).

### Gap-after-last

Same `RewindPoint` component, different styling tokens. ~50% taller (24-36px). Hairline always full opacity. Pill always visible, containing only the `Plus` icon — the menu at this gap is fork-only (D2), so the rewind icon is omitted to avoid promising an affordance the menu doesn't deliver. Aria-label "Fork from current state."

```
┌──────────────────────────────────────┐
│  Done — your handler is debounced.   │
└──────────────────────────────────────┘

   ──────────────   +   ──────────────    ← taller row, plus icon, always visible

[  Type your next message…              ]
```

### Streaming states

- Gap-after-last during a streaming turn: **completely hidden.** No row, no hairline, no pill. There's no committed "current state" to fork from until the auto-commit fires.
- Intermediate gaps during streaming: hairline drops to ≈5% opacity; pill rendered but disabled (greyed; no hover effect). Tooltip on the row: "Wait for the current turn to finish."

When the turn ends, the after-last gap reappears with a fresh `commitHash` and intermediate gaps re-enable.

### The menu

Opens from the pill, prefers opening upward since the gap is inline in scrolling chat. Width ~280px. Item layout mirrors the existing dropdowns (label + 1-line muted subtitle). The intermediate-gap menu has all four items; the gap-after-last menu has only the Fork item (D2 — the three rewind actions have nothing past the gap to discard or reset).

Intermediate gap:

```
┌──────────────────────────────────────────────┐
│  ⟲  Rewind chat to here                       │
│     Discard 2 turn-groups. Code unchanged.    │
├──────────────────────────────────────────────┤
│  ⟲  Rewind code to here                       │
│     Reset 5 files. Chat kept, stale turns     │
│     dimmed.                                   │
├──────────────────────────────────────────────┤
│  ⟲  Rewind chat and code                      │
│     Discard turns and reset files.            │
├─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
│  +  Fork as new session                       │
│     New worktree from this point.             │
└──────────────────────────────────────────────┘
```

Gap-after-last (fork-only — D2):

```
┌──────────────────────────────────────────────┐
│  +  Fork as new session                       │
│     New worktree from this point.             │
└──────────────────────────────────────────────┘
```

Counts in the subtitles come from `rewind_preview` (requested when the menu opens). Until the response arrives, subtitles render with no numbers ("Discard turn-groups" / "Reset files") and upgrade in place when the count lands. Per the per-action shape in B5: chat/both subtitles use `discardedTurnGroupCount`; code uses `discardedTurnGroupCount` (dimmed) + `fileCount`; fork uses `keptTurnGroupCount`. The gap-after-last fork *does* request `rewind_preview` — the Fork modal's "Includes N turn-groups…" line needs `keptTurnGroupCount` — but `fileCount` is intentionally omitted by the server for fork (the child's files are just the current state at HEAD, not a diff against anything).

### Confirmation modal (code-touching actions)

For "Rewind code", "Rewind chat and code", and "Fork as new session" the menu item opens a modal before firing. Reuse the existing `Dialog` component. The action button uses the destructive/accent variant.

```
┌──────────────────────────────────────────────┐
│  Rewind chat and code                         │
│                                               │
│  This will:                                   │
│    • Discard 2 turn-groups                    │
│    • Reset 5 files to commit a1b2c3d         │
│                                               │
│  You have 1 queued message that will also     │
│  be discarded.                                │
│                                               │
│                       [ Cancel ]  [ Rewind ]  │
└──────────────────────────────────────────────┘
```

The queue line only renders when `runner.messageQueue.length > 0` (B4). The chat-only "Rewind chat to here" path stays modal-free *unless* the queue is non-empty; in that case it shows a smaller single-purpose modal ("Discard N queued messages and rewind?"). The Fork modal swaps the body for an inline name input:

```
┌──────────────────────────────────────────────┐
│  Fork as new session                          │
│                                               │
│  Branch: [ debounce-experiment      ]         │
│                                               │
│  Title:  Parent title (debounce-experiment)   │
│                                               │
│  Includes 4 turn-groups and the current       │
│  files at commit a1b2c3d.                     │
│                                               │
│                       [ Cancel ]  [ Fork ]    │
└──────────────────────────────────────────────┘
```

Single editable field labelled **Branch**, pre-filled by the synchronous slug from U7. The **Title** below it is read-only: it shows the derived display title (`` `${parent.title} (${branch})` ``, matching `forkSession()` at `session-fork-merge.ts:69`) and updates live as the user types. We deliberately don't expose a separate title input — see B5's `rewind_at_gap` shape for the rationale.

### Undo toast

Appears bottom-center after any rewind (including the chat-only path that skipped the modal). 10-second timer with a thin progress bar; clicking **Undo** restores from `rewind_snapshots` per the per-action shape defined in U4 #2 / D8 (chat-only restores history; code-only resets HEAD; both does the sequenced pair; fork archives the child and removes the breadcrumb).

**Restore failure path.** Per U4 #3 the `both` and `fork` undos are sequenced and not cross-system atomic — a `git reset --hard` can fail if the reflog has been pruned mid-window, and a child-archive can fail mid-teardown. When the restore endpoint returns a non-2xx, the toast transforms in place into an error variant: red accent, the error message, and a single inline link to the `SessionTopBar.tsx` overflow menu's `Recover recent rewind` entry (which still holds the snapshot until the TTL expires). For `both` specifically, when the reset fails the error message also tells the user the chat is restored but the files aren't, and suggests running `git reflog` in the inline terminal panel to find the lost commit — inline per CLAUDE.md §1's "terminal output ... surface inline" rule, not a link-out. The user is never left with "undo failed silently."

```
┌─────────────────────────────────────────┐
│  ✓ Rewound chat and code.    [ Undo ]   │
│  ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱   │
└─────────────────────────────────────────┘
```

For Fork, the toast text is "Forked to *debounce-experiment*" and the **Undo** button archives the new session (workspace + container teardown) and removes the breadcrumb entry the fork appended to the parent's chat history. The parent's git state is unchanged — fork never resets HEAD on the parent — and the only parent-side mutation is the breadcrumb row, which Undo removes. See U4 #2 and D8 for the full snapshot/undo shape.

### "Recover recent rewind" — topbar overflow

For up to ~5 minutes after the toast expires, `SessionTopBar.tsx`'s overflow menu (the `DotsThreeVerticalIcon` `DropdownMenu`, currently lines 81-104 with Rename / Download chat / Archive) gains a discreet entry. Disappears once the snapshot's TTL passes (D8). Time shown is relative.

```
…
─────────────────
↶  Recover recent rewind (3m ago)
─────────────────
…
```

Clicking it triggers the same restore path as the toast's **Undo**.

### Tokens at a glance

| Surface | Height | Opacity at rest | Opacity on hover | Notes |
|---|---|---|---|---|
| Intermediate gap | 16-24px | hairline 10% | hairline 100%, pill visible | Pill: `--color-bg-secondary`, 20×32px |
| Intermediate gap (streaming) | 16-24px | hairline 5% | n/a (disabled) | Tooltip on row |
| Gap-after-last | 24-36px | hairline 100%, pill visible | (same) | `Plus` icon only (D6 — menu is fork-only) |
| Gap-after-last (streaming) | 0px | hidden | n/a | Row removed entirely |
| Modal | dialog default | n/a | n/a | Reuses existing `Dialog` |
| Toast | bottom-center | 100% | n/a | 10s timer + Undo |

## Implementation plan

Three landings. Landing 1 is fully independent. Landing 2 depends on most of Landing 1:
- **B1** — orphan-group rendering, so the gap-UI fork lands in the sidebar.
- **B2** — persisted `notice` (D1's role-transition transparency, the rewind-preview counts, and the rollback divider surviving reload) and persisted `fork_child` (which `MessageList` needs to render `SpawnedSessionCard` from a persisted message, and which the new `fork_breadcrumb` event carries).
- **B3** — fork's uploads-copy (every fork now initiates through the gap UI).
- **B4** — the `resolveRunner`-via-registry + `runner.running` guard pattern (Landing 2's `rewind_at_gap` handler relies on it).
- **B5** — the normalized `rewind_at_gap` WS message and its discriminated response shapes.
- **B6** — auto-switch + persisted breadcrumb on fork success.

Landing 3 has no Landing-1 or Landing-2 hard dependencies — its items (U8 richer replay) can ship in any order once Landing 2 is in. U5 (dim stale messages after `action: "code"`) was originally a Landing 3 item but ships in Landing 1 alongside B2 and B5 — those landings already give it the persisted `rolled_back` flag, the new gap-UI handler, and the existing client renderer (`MessageList.tsx:390` already applies `opacity-40` to `rolledBack` for both roles, per U5).

### Landing 1 — Make it work (bug fixes, no UX change)

- [ ] B1: render orphan-grouped sessions in `SessionSidebar`. Add a "Local sessions" / "Other sessions" group header for unmatched URLs.
- [ ] B2: schema migration — add `rolled_back`, `notice`, `notice_level`, `fork_child`, and `code_rollback_hash` columns to `messages` (defaults: `0`, `0`, `NULL`, `NULL`, `NULL` for existing rows). Extend `PersistedMessage` and `toRow`/`fromRow` to round-trip all five fields. Widen `append()` to return the inserted rowid (consumed by B6's breadcrumb writer for the fork-undo snapshot). Add the new `markRolledBackFromIndex(sessionId, gapPosition, codeRollbackHash) → number[]` and `clearRolledBack(sessionId, ids[])` helpers used by U5 / the `code` undo path. Persist the `action: "both"` divider with `notice: true` (currently `rollback-complete.ts:14-20` builds it client-side without any `notice` field, and the persistence side is missing entirely). For `action: "chat"` no divider is appended, and for `action: "code"` the divider is client-rendered from `codeRollbackHash` (see B2 #3).
- [ ] B3: copy referenced uploads into the forked session.
- [ ] B4: server-side `runner.running` guard on all current handlers; doc 095 capture-at-entry pattern. For the queued-message case in Landing 1 — Landing 1 still uses the four per-message dropdowns, so the per-action confirmation modal pipeline from U4 doesn't exist yet — the interim behavior is: the server unconditionally calls `runner.clearQueue()` inside the rewind/fork transaction and emits a follow-up `system-notice` chat message ("Cleared N queued message(s) as part of rewind."). This keeps queue and history consistent immediately; the explicit pre-confirm prompt arrives in Landing 2 alongside the modal pipeline.
- [ ] B5: introduce `rewind_at_gap` WS message + discriminated handler. Then rewire each of the six existing client call sites (three modes per dropdown) with **explicit per-button `messageIndex` → `gapPosition` conversion**, because the buttons split across two dropdowns with opposite `messageIndex` semantics (verified against `RewindDropdown.tsx:41-52`, `RollbackDropdown.tsx:43-55`, `rewind-handlers.ts:99`, `rollback-handlers.ts:61, 117-120`):

  | Dropdown | Item (mode) | Sends today | Today's effect | New `action` | Conversion | Cutover note |
  |---|---|---|---|---|---|---|
  | `RewindDropdown` (user msg X) | "Fork conversation from here" (`fork_chat`) | `rewind_to_message` | Truncate chat to before X (`slice(0, X)`), code unchanged | `chat` | `gapPosition = X` | Behavior preserved |
  | `RewindDropdown` (user msg X) | "Rewind code to here" (`rewind_code`) | `rewind_to_message` | Git reset to commit before X (backward walk from X-1), chat unchanged. Errors with "No code changes to rewind" when no commits exist past X (`rewind-handlers.ts:115-118`) | `code` | `gapPosition = X` | Behavior preserved (kept-side suffix walk from gap X finds the same commit). The new handler preserves today's no-op error too: when no commit exists past `gapPosition`, return `{ type: "error", message: "No code changes to rewind from this point." }` instead of silently issuing a `git reset --hard HEAD` (which would also be a no-op but would still trigger the file-tree refresh + divider insert, both spurious). |
  | `RewindDropdown` (user msg X) | "Fork conversation and rewind code" (`rewind_all`) | `rewind_to_message` | Truncate chat to before X + git reset | `both` | `gapPosition = X` | Behavior preserved |
  | `RollbackDropdown` (assistant msg X) | "Rollback code" (`code`) | `rollback_code` | `git.rollback(X.parentCommitHash)` — code reset to state before X's edits, chat untouched | `code` | `gapPosition = X` | Code matches (kept-side suffix walk from gap X lands on X-1's commit = state before X). Per U5, the new handler also dims messages from X onward — that's a UI change vs today, which is acceptable because it's the U5 win |
  | `RollbackDropdown` (assistant msg X) | "Rollback code + chat" (`code_and_chat`) | `rollback_code_and_chat` | `git.rollback(X.parentCommitHash)` + `setConversationReplay(slice(0, X + 1))` + `clearAgentSessionId` — **does not persist any chat deletion**; the slice only builds a replay string. The visible "dimmed" past-X effect comes from `rolledBack: true` set in-memory by `rollback-complete.ts:24-27` and is *not* persisted (B2 fixes this for `rolled_back`, separately) | `both` | `gapPosition = X` | **Material behavior shift, not minor.** Under the new gap model, the clicked assistant message X *and* every message past it are persistently deleted from the `messages` table (the new `both` handler calls `chatHistoryManager.truncate(sessionId, X)` inside its transaction). Today those rows survive — they just render dimmed in-session via an in-memory flag and reappear fully on reload (the bug B2 catches for `rolledBack`). The git reset is identical. We treat this as the desired direction (geometric consistency: chat shape matches the discarded set; reload is no longer surprising; B2's "dimmed messages come back fully active and their rollback dropdowns reappear" failure mode is structurally gone). But it's worth flagging explicitly in the Landing 1 PR description so reviewers expect the change, since users who have been relying on the "reload restores my deleted chat" quirk will notice. |
  | `RollbackDropdown` (assistant msg X) | "Fork as new session" (`fork`) | `fork_session_from_message` | `slice(0, X + 1)` (child keeps through X) + clone branched off `X.parentCommitHash` (code before X) | `fork` | `gapPosition = X` | **Behavior shift** — same as above: the child's chat now excludes message X. The new branch is still cut off the same commit (state before X). The cutover prioritizes the new gap model's internal consistency over preserving today's "chat ahead of code" quirk; the user can still fork from `gapPosition = X + 1` to keep X in the child if that's what they want. |

  All six conversions live in the same callback as the old `send(...)` call so the off-by-one bug class B5 calls out can't reappear. Behavioral details the new handlers must preserve under the unified actions:

  - **All four actions (`chat`, `code`, `both`, `fork`)** call `clearAgentSessionId(sessionId)` and (where the kept slice changes) `setConversationReplay(...)` for chat-mutating modes, matching today's `fork_chat` / `rewind_all` / `rollback_code_and_chat` flows (`rewind-handlers.ts:106-108, 140`, `rollback-handlers.ts:68`). Forgetting `clearAgentSessionId` on the `chat` action would let the next user message resume the existing CLI session whose memory still includes the discarded turns — silent context bleed.
  - **`action: "code"` calls `clearAgentSessionId` in the new model** — this is a deliberate change from today (`rewind-handlers.ts:113-122` only resets git, leaving the CLI session alive). The new design dims the stale turns past the divider (U5), which means the agent's CLI memory now holds tool calls and edits the visible UI says are reverted; the next user message would resume that CLI session and produce a response that "remembers" reverted work as if it were still in effect. Clearing the agent session forces the next turn to start fresh with the conversation-replay context only, which matches what the dimmed UI tells the user is happening. `setConversationReplay` is also called for `code` so the next turn has the pre-rewind context (notice-stripped, with the dimmed turns included as historical context). This is the only behavioral change relative to today's `rewind_code` and is part of the U5 trade-off — keeping the old "leave the CLI session" behavior here would re-create the silent-context-bleed bug B7 explicitly tests for.
  - **Fork** in Landing 1 needs a `branchName`. Since U7's name input ships in Landing 2, the Landing 1 conversion derives a placeholder branch (`fork-<8-char-uuid>`, the same shape `handleForkSessionFromMessage` uses today at `rollback-handlers.ts:101-102`).

  Old WS messages stay alive in this landing — they're removed in Landing 2 once the gap UI is live.
- [ ] B6: auto-switch + breadcrumb on fork success (uses `SpawnedSessionCard`). The breadcrumb is persisted (B2's `fork_child` column) so it survives reload. In Landing 1 no parent viewer sees the card live: the initiating viewer auto-navigates to the child immediately (so never sees their own breadcrumb appear); other tabs viewing the parent see it on their next reload. Live multi-viewer broadcast (`fork_breadcrumb` event, B5 / D7) ships in Landing 2 — pulling it forward into Landing 1 was considered but deferred so Landing 1 stays focused on the bug-fix slice; the event's type and emit site are both small enough that revisiting this trade-off if Landing 2 slips is cheap.
- [ ] U5: the new `rewind_at_gap` handler for `action: "code"` calls `markRolledBackFromIndex(sessionId, gapPosition, commitHash)` so every message at index ≥ `gapPosition` (both user and assistant — see `MessageList.tsx:390`) gets `rolled_back = 1`, and the first such row gets `code_rollback_hash = <commit>`. Both writes happen inside one `db.transaction(...)`. No divider row is appended for `code` — the client renders the divider synthetically from `codeRollbackHash` (per B2 #3), so reload preserves the dimmed + synthetic-divider state.
- [ ] B7: integration test file covering all branches above.

### Landing 2 — Replace per-message dropdowns with between-turn rewind points

- [ ] Build `RewindPoint` component per the "UI spec" section above (intermediate gap, gap-after-last, streaming states, menu).
- [ ] Render `RewindPoint` between every role transition in `MessageList`, plus the prominent gap-after-last (D6). Hide/disable per D3.
- [ ] Implement the four menu actions, all routing through `rewind_at_gap` (D2). The Fork action requires a branch name (B5 says the server rejects fork without `branchName`), so the Fork modal includes the inline name input from U7 — that input ships in Landing 2, not Landing 3, because Landing 2's UI is the first place a fork can be initiated under the new design. Defaults come from the session-namer slug; the user can edit before confirming.
- [ ] Add `rewind_preview_request` / `rewind_preview` WS pair; populate menu subtitles and modal counts (U4 + UI spec).
- [ ] Confirmation modal (selective, per D4) + undo toast + "Recover recent rewind" topbar overflow item.
- [ ] `rewind_snapshots` SQLite table + restore endpoint (D8).
- [ ] `fork_breadcrumb` WS event + handler so other parent viewers see the just-persisted breadcrumb without a reload (B5 / D7).
- [ ] Delete `RewindDropdown.tsx`, `RollbackDropdown.tsx`, the four old WS message types and their handlers. Cover with regression tests so the old chip can't sneak back.
- [ ] U6: empty-chat marker after full rewind.

### Landing 3 — Polish

- [ ] U8: richer replay (tool result summary + attachment manifest).

## Key files

**Server**
- `src/server/orchestrator/ws-handlers/rewind-handlers.ts` — current three-mode rewind handler; deprecated in Landing 2.
- `src/server/orchestrator/ws-handlers/rollback-handlers.ts` — current code / code+chat / fork handlers; deprecated in Landing 2.
- `src/server/orchestrator/ws-handlers/resolve-runner.ts` — `resolveRunner(ctx)` for B4.
- `src/server/orchestrator/services/session-fork-merge.ts` — `forkSession()` clone + branch logic. The existing title-derivation template at line 69 (`` `${activeSession?.title ?? "Session"} (${trimmed})` ``) is exactly what the new fork flow wants, so the function signature is unchanged. The only ripples for B5/B6 are the new WS handler calling `forkSession()` with the user-edited branch slug, plus appending the breadcrumb + emitting `fork_breadcrumb` after `forkSession()` returns. `POST /api/sessions/:id/fork` (`api-routes-session.ts:257-280`) likewise needs no body-shape change.
- `src/server/orchestrator/services/replay.ts` — `buildConversationReplay()`.
- `src/server/orchestrator/chat-history.ts` — `PersistedMessage` interface (10-50), `toRow`/`fromRow` (112-150), `truncate` (191-202), `saveMessages` (205-212); B2 migration target.
- `src/server/orchestrator/api-routes-session.ts:257-280` — HTTP `POST /api/sessions/:id/fork`. Not on B3's path — this route only creates the cloned workspace/branch via `forkSession()`; it doesn't copy chat history, so it has no upload references to mirror. B3 is purely about the WS `handleForkSessionFromMessage` handler at `rollback-handlers.ts:80-139`, which *does* copy chat history (lines 117-120) and is the actual leak surface.
- `src/server/shared/git.ts` — `rollback()`; reused for snapshot restore.
- `src/server/shared/database.ts` — migration adding `rolled_back`, `notice`, `notice_level`, `fork_child`, and `code_rollback_hash` columns to `messages` (B2 / B6 / D7 / U5), plus the new `rewind_snapshots` table.

**Client**
- `src/client/components/SessionSidebar.tsx` — `repoGroups` `useMemo` (currently 521-557, returning `repos.map(...)` at 553-556) is the repo-group rendering bug (B1).
- `src/client/components/SessionTopBar.tsx` — overflow `DropdownMenu` (currently 81-104, rename / download chat / archive items) hosts the new "Recover recent rewind" entry (U4 / D8).
- `src/client/components/MessageList.tsx:380-437` — current rewind/rollback trigger placement; goes away in Landing 2. Also `MessageList.tsx:390` is where `rolledBack` applies `opacity-40` to both user and assistant messages (U5).
- `src/client/components/RewindDropdown.tsx` + `RollbackDropdown.tsx` — deleted in Landing 2.
- `src/client/components/SpawnedSessionCard.tsx` — reused (rendering only) by the fork breadcrumb. The persistence channel is new — see B6 / D7.
- `src/client/hooks/message-handlers/rewind-complete.ts`, `rollback-complete.ts`, `session-forked.ts` — rewritten or deleted in Landing 2 depending on WS message changes.
- `src/client/App.tsx` — `handleRewind` (currently ~475-480) and `handleRollback` (currently ~542-553) send-side; collapses to one `handleRewindAtGap`.

**Shared types**
- `src/server/shared/types/ws-client-messages.ts` — add `WsRewindAtGap`, `WsRewindPreviewRequest`; remove the four old types in Landing 2.
- `src/server/shared/types/ws-server-messages.ts` — add `WsRewindPreview` and `WsForkBreadcrumb`; align `WsRewindComplete` / `WsSessionForked` with the new discriminated payload shapes from B5.

**Tests (to add)**
- `src/server/orchestrator/integration_tests/rewind-fork.test.ts` (new — Landing 1 + Landing 2 cases per B7's per-landing split).
- `src/client/hooks/message-handlers/session-forked.test.ts` (new — Landing 1; covers the auto-switch hook behavior referenced by B7).
- `src/client/components/RewindPoint.test.tsx` (new — Landing 2).

**Related docs**
- `docs/007-threads-checkpoints/plan.md` — original rollback design. Add a cross-reference pointing here once this ships.
- `docs/095-runner-ctx-simplification/plan.md` — capture-at-entry pattern used in B4.
- `docs/117-agent-spawned-sessions/plan.md` — source of the `SpawnedSessionCard` pattern reused by D7.

## Open questions

1. **Replay token cost.** U8 widens replay materially for tool-heavy sessions. Measure on representative sessions before deciding whether to gate behind a setting or trim aggressively (e.g. last N tool results only).
2. **Repo-removed orphan sessions UX.** B1's fix surfaces sessions whose repo was removed. The current product behavior is "removeRepo hides them"; surfacing them as "Other sessions" changes that contract. Confirm with product that this is desired — if not, we need a separate "deleted repo" flag to keep them hidden.

(The previous draft had a third open question about `rewind_snapshots` cleanup cadence. Decided: startup sweep + lazy on-read TTL enforcement. The combination gives durability across restarts with no runtime timer overhead, and the 5-minute window means orphan rows are bounded by usage frequency, not wall-clock time.)
