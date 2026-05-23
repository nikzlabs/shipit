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

1. **Schema.** Add four columns to `messages`: `rolled_back INTEGER DEFAULT 0`, `notice INTEGER DEFAULT 0`, `notice_level TEXT NULL` (for `info` / `warn`), and `fork_child TEXT NULL` (JSON-encoded `{childSessionId, title, branch}`, used by B6/D7's persisted fork breadcrumb). Existing rows are silently un-dimmed (acceptable — pre-migration rollback state was already non-durable; we're not regressing).
2. **Type + mappers.** Extend `PersistedMessage` (`chat-history.ts:10-50`) with `rolledBack?: boolean`, `notice?: boolean`, `noticeLevel?: "info" | "warn"`, and `forkChild?: { childSessionId: string; title: string; branch: string }`. Update both mappers — `toRow` (currently 112-131) writes the new columns; `fromRow` (currently 133-150) reads them back into the same shape the client already expects.
3. **Persist the divider as a structural marker.** The unified gap handler writes the divider into history with `notice: true` in the same transaction as the truncation. The flag is what distinguishes it from a regular assistant message — both at render time (D5 styling) and at boundary-computation time (D1: notice messages are transparent to role transitions). The client derives `rolledBack` and the divider from persisted state on load — no in-place mutation in `setMessages`.
4. **Persist the fork breadcrumb.** The same migration adds the storage that B6/D7 rely on; the fork handler `append`s a message with `forkChild` populated. Client `MessageList.tsx` detects `forkChild` and renders `SpawnedSessionCard` for the breadcrumb. Doc 117's in-memory `SpawnedSessionCard` path is unchanged — that's a separate, deliberately-unpersisted channel for agent-spawned siblings.

### B3 — Fork doesn't copy uploads

`handleForkSessionFromMessage` saves truncated chat history to the new session (`rollback-handlers.ts:117-120`) including messages with `/uploads/…` references. The new session has its own `uploads/` dir (per `getActiveDir`'s parent) — empty. Any image, screenshot, or attached file referenced by the surviving turns is a broken link in the fork.

**Fix.** Mirror the rewind helper: after `forkSession()` succeeds, walk `truncatedMessages` for `/uploads/` paths and `fs.copyFile` each into the new session's uploads dir. Wrap in `.catch(() => {})` per-file so a missing source doesn't blow up the whole fork.

### B4 — Rewind/fork during an active turn corrupts state

All four WS handlers (`handleRewindToMessage`, `handleRollbackCode`, `handleRollbackCodeAndChat`, `handleForkSessionFromMessage`) call `chatHistoryManager.saveMessages(...)` and/or `clearAgentSessionId(...)` without checking `runner.running`. The client disables the button via `disabled={isLoading}`, but the server has no guard. A stale tab, double-click, or any non-UI client can interleave a rewind with an in-flight turn and produce a corrupted in-progress message group.

A second, subtler hazard: if the user has queued messages (`runner.messageQueue`, populated via `message-queued.ts` and surfaced by `queue-updated.ts`), a successful rewind silently strands them — they're addressed to a chat that no longer exists below the rewind point.

**Fix.**
1. Each handler resolves the runner via `resolveRunner(ctx)` (see `ws-handlers/resolve-runner.ts`), which prefers the `RunnerRegistry` over `ctx.getRunner()` — the latter returns `null` after a WS reconnect mid-turn, which is exactly the race this guard has to close. The handler early-returns `{ type: "error", message: "Cannot rewind while a turn is running." }` when `runner.running` is true. Both the running-check read and any subsequent state mutation go through the same resolved reference; never re-read via `ctx.getRunner()` inside async callbacks. Follow doc 095's capture-at-entry pattern for `sessionId`/`sessionDir` too.
2. If `runner.messageQueue.length > 0`, the server calls `runner.clearQueue()` (currently `session-runner.ts:477`) *before* the chat truncation completes its SQLite transaction, inside the same handler call. There is no shared transaction boundary (the queue is in-memory; the truncation is SQLite), so this isn't a true cross-system atomicity guarantee — instead, ordering plus the per-runner mutex (`enqueue` paths go through the same runner) prevent the visible race in practice: any `enqueue` from a stale tab that arrives mid-handler runs *after* the clear and lands in a queue that is about to be re-validated against the truncated history. If, despite the ordering, a queued message slips in and references a discarded turn, the runner ignores it on dequeue (the message's referenced `messageIndex` is past the new tail) and emits a `system-notice` ("Discarded 1 queued message addressing rewound turns.") so the user is told. The user-facing pre-confirm differs by landing: Landing 1 (no new UI yet) clears unconditionally and emits a follow-up `system-notice` ("Cleared N queued message(s) as part of rewind.") so the user is told what happened. Landing 2 adds the explicit pre-confirm — U4's modal gains an extra "discard N queued messages" line for code-touching actions, and a small single-purpose modal appears for chat-only actions that would otherwise be modal-free.

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
  - `{ type: "rewind_at_gap", gapPosition: number, action: "fork", branchName: string, title?: string }` — `branchName` is the user-edited slug from U7's inline name input (required; the menu can't open Fork without it). `title` is optional and, when omitted, the server derives one synchronously from the most recent kept user message: a trimmed-and-truncated first line (up to ~60 chars), with the parent's title appended in parens as the fallback when the kept slice has no user message in the recent window. This deliberately avoids `generateSessionName()` (currently only called post-first-message from `send-message.ts:270`); calling that primitive inline would block the modal on an LLM round-trip and there is no synchronous slugger on the claim path to reuse.
  - `gapPosition` is unambiguous — "keep the first `gapPosition` messages, discard the rest." A gap at position `messages.length` is "rewind nothing, fork from the current state."

**New WS client messages (Landing 2):**
- `rewind_preview_request` — `{ type: "rewind_preview_request", gapPosition: number, action: "chat" | "code" | "both" | "fork" }`. Sent when the menu opens; populates the modal counts (U4 + UI spec).

**New WS server messages (Landing 1, all variants of `rewind_complete` and the redefined `session_forked`):**
- `{ type: "rewind_complete", gapPosition: number, action: "chat", droppedMessageCount: number }` — client drops everything past `gapPosition`.
- `{ type: "rewind_complete", gapPosition: number, action: "code", dividerInsertedAt: number, commitHash: string }` — client refreshes the file tree and re-renders the (now-persisted) divider + dims the stale messages above it (U5).
- `{ type: "rewind_complete", gapPosition: number, action: "both", droppedMessageCount: number, commitHash: string }` — drop + reset.
- `{ type: "session_forked", parentSessionId: string, childSessionId: string, title: string, branch: string }` — sent on the initiating connection; client auto-switches to the child (D7). Replaces today's `{ sessionId, sessionName }` shape.

**New WS server messages (Landing 2):**
- `{ type: "rewind_preview", gapPosition: number, action: "chat" | "code" | "both" | "fork", turnGroupCount?: number, fileCount?: number }` — reply to `rewind_preview_request`. Each count is optional (the "Rewind chat to here" subtitle has no file count, etc.).
- `{ type: "fork_breadcrumb", parentSessionId: string, message: PersistedMessage }` — emitted via the parent runner's `runner.emitMessage` so every viewer attached to the parent (other tabs, other devices) sees the just-persisted breadcrumb row without a reload, per CLAUDE.md's "emit via `runner.emitMessage`, not `ctx.send`" rule. See D7 for sequencing; ships in Landing 2 (Landing 1 only the initiating viewer sees the card immediately — see Landing 1's B6 note).

**Removed in Landing 2** (no external consumers — WS-only, internal — so no deprecation window):
- Client → server: `rewind_to_message`, `rollback_code`, `rollback_code_and_chat`, `fork_session_from_message`.
- Server → client: today's `{ messageIndex, mode, parentCommitHash }`-style `rewind_complete` / `rollback_complete` shapes.

Each new variant carries exactly the fields the client needs to render its post-state without re-fetching. Implementer note: the `rewind_at_gap` server handler ships in Landing 1 (so its tests can run end-to-end against B5's normalized vocabulary), but Landing 1's client still routes through the old WS messages via the conversion table (see Landing 1 below) — the cutover to the gap UI calls is the first item in Landing 2.

### B6 — `session_forked` strands the user

`handleSessionForked` (`session-forked.ts`) just appends a chat message: "Session forked as 'X'. Switch to it from the sidebar." This is exactly the link-out failure mode CLAUDE.md §1/§2 prohibits — the user explicitly asked to fork, and we're telling them to go hunt for the result. Combined with B1, today they're hunting for a row that doesn't exist.

**Fix.** On fork success:
1. Server response stays `session_forked` (payload aligned with B5's typed shape: `{parentSessionId, childSessionId, title, branch}`).
2. Client auto-navigates to the new session (same code path as `setSessionId`).
3. The *parent* session's chat gets a breadcrumb card that reuses the **rendering** of `SpawnedSessionCard.tsx` (status pill, branch, "Open" button — the existing component is reused as-is) but routed through a new persisted channel.

**The persistence is net-new — doc 117 deliberately punted on it.** `docs/117-agent-spawned-sessions/plan.md` notes explicitly that "No persistence of the `SpawnedSessionCard` in chat history" was a Phase 1+2+3 choice — the card is re-rendered live via the turn-event buffer. That mechanism is *not* sufficient here, because a fork's breadcrumb must survive page reload (the user navigates away to the child, comes back days later, and expects to see the link). Concretely: the fork handler `append`s a `PersistedMessage` with a new field — `forkChild?: { childSessionId: string; title: string; branch: string }` — added to the `PersistedMessage` interface in the same B2 migration that adds `notice`. The client renderer in `MessageList.tsx` detects `forkChild` and renders `SpawnedSessionCard` (which is already wired to look up live status from `useSessionStore`). The session-spawned WS event remains unpersisted and unchanged — this is a deliberately separate, persisted channel for the fork case. If a follow-up to doc 117 decides to persist the agent-spawned card too, it can hang off the same field; for now this doc owns the persistence.

### B7 — Zero integration coverage

`grep -r "rewind_to_message\|fork_session_from_message\|rollback_code" src/server/orchestrator/integration_tests` returns nothing. The only adjacent tests are `git-rollback.test.ts` (raw simple-git layer) and `MessageList.test.tsx` (button visibility). Three rewind modes × three rollback modes × fork, all destructive, all untested. B1-B6 survived because nothing exercises this path end to end.

**Fix.** Add `src/server/orchestrator/integration_tests/rewind-fork.test.ts`, split per landing so reviewers can tell which cases ship with which work:

**Landing 1 — bug-fix coverage on the old WS surface.** Tests run against the unchanged four-handler shape (the new `rewind_at_gap` handler exists alongside, but Landing 1's client still routes through the old messages via the conversion table). Cases:
- `rolledBack: true` survives a reload (`chatHistoryManager.load(sessionId)`) (B2).
- The rollback divider (now persisted with `notice: true`) survives a reload (B2).
- Fork copies referenced uploads into the new session's dir (B3).
- Each old WS handler returns an error and leaves state unchanged when `runner.running === true` (B4).
- Rewind with `runner.messageQueue.length > 0` clears the queue unconditionally and emits the system-notice (B4 — this matches Landing 1's interim "no modal" behavior; the explicit pre-confirm tests land in Landing 2).
- Fork persists a breadcrumb (`PersistedMessage` with `forkChild`) in the parent's chat history (B6 / D7); the client auto-switches on `session_forked` (belongs in a hook-level test, not the integration file — call it out alongside the assertion).
- B5's `rewind_at_gap` happy path for each `action`, at first / middle / last gap positions (so the new server-side handler is exercised even though the new client UI isn't live yet).

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
   - `chat` → `{messages: PersistedMessage[]}`. Undo replaces history.
   - `code` → `{headHash: string}`. Undo resets HEAD (the dim-stale-turn marking from U5 is recomputed from the restored chat).
   - `both` → `{messages: PersistedMessage[], headHash: string}`. Undo runs both restores in sequence (see U4 #3 for the non-atomicity story).
   - `fork` → `{childSessionId: string, breadcrumbMessageId: number}`. **Fork doesn't truncate or git-reset the parent** — only the child gets the truncated copy. The single parent-side mutation is the breadcrumb append from D7 (a `PersistedMessage` with `forkChild` populated). Undo deletes the child session (archive + workspace teardown) and removes the breadcrumb by primary-key row id. Using the row id rather than the pre-append chat length matters because new entries can land in the parent's chat during the 5-minute window (another turn, an agent-spawned card, a system notice, an inbound message in another tab), and length-based truncation would silently discard them. If the breadcrumb row is already gone (the user manually cleared chat history, or another mechanism removed it) the undo proceeds with the child teardown and the toast notes that there was no breadcrumb to remove — never an error. **The fork snapshot is keyed on the *parent* sessionId, not the child** (see D8). Because D7 auto-switches the user to the child, the immediate Undo toast renders on the child view but its handler targets the parent's snapshot; the post-toast "Recover recent rewind" entry appears in the *parent's* `SessionTopBar` overflow — when the user navigates back to the parent within the 5-minute TTL, the entry is there. On the child view that the user lands on, "Recover recent rewind" is absent for the fork (the child has no parent-mutating action to recover). Tests in B7 assert both surfaces explicitly.
3. **Restore is not cross-system atomic.** The `chat` and `code` paths each run inside a single SQLite transaction / single git command and are atomic on their own. The `both` path is sequenced: chat first inside one SQLite transaction, then `git reset --hard <headHash>`. If the reset fails (e.g. the reflog has been pruned mid-window, which the 5-minute TTL is designed to avoid but can't guarantee), the chat restore is left applied and the undo toast surfaces an inline error suggesting the user run `git reflog` in the inline terminal panel to find the lost commit — inline per CLAUDE.md §1, not a link-out to anything external. The `fork` path is similarly sequenced: child teardown, then parent chat truncation. We avoid claiming cross-system atomicity that SQLite + git can't actually provide. Snapshots are stored in a small `rewind_snapshots` SQLite table with 5-minute expiry. (No `branch` field — none of the rewind actions cross branches, so `git.rollback()`'s straight `git reset --hard <hash>` is the right restore primitive.)
4. **Undo affordance is dual-track.** A 10-second "Rewound. **Undo**" toast covers the common case. For up to 5 minutes after, a discreet "Recover recent rewind" entry lives in `SessionTopBar.tsx`'s `DotsThreeVerticalIcon` overflow menu — the same `DropdownMenuContent` that already holds Rename / Download chat / Archive (currently around lines 91-103). Inline per the product principle, not a link-out to `git reflog`.

The new server pair `rewind_preview_request` / `rewind_preview` lets the client populate the confirmation modal's counts without a roundtrip per keystroke. The client requests when the menu opens; server returns `{turnGroupCount, fileCount}` derived from `gapPosition` (turn-group count is computed from role transitions on the kept-vs-discarded split; file count is `git diff --name-only HEAD <target>`).

If the user has queued messages at the time of the action, the modal gains one extra line — "You have N queued messages; rewinding will discard them" — and confirming clears the queue. The chat-only path stays modal-free unless the queue is non-empty; if it is, a small single-purpose dialog ("Discard N queued messages and rewind?") appears. We deliberately keep the queue-clear confirmation distinct from the file-count modal so D4's "chat-only is modal-free" promise still holds in the common case.

### U5 — Stale chat after a code-only rewind

After "Rewind code" the chat still shows messages discussing files that no longer exist. A "Code rolled back to `abc1234`" notice is inserted at the rewind point, but the now-stale turns above it are not marked.

**Fix.** When rewind-code finishes, mark every message between the gap and the inserted notice as `rolledBack` — both assistant turns *and* the user prompts that drove them. `MessageList.tsx:390` already applies `opacity-40` to `rolledBack` regardless of role, so dimming and hiding their hover affordances (gap menus and any per-message controls that survive Landing 2) is one consistent treatment. Stale turns stay visible for reference but are visually demoted on both sides of the conversation. Depends on B2 for `rolledBack` to survive reload.

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

**`notice` messages are transparent to the boundary computation.** Transient system notes today render as `role: "assistant"` with `notice: true` on the client type (`system-notice.ts:14-19`) but are not persisted. After B2, the rollback divider becomes the first persisted `notice` message (`rollback-complete.ts:14-20` is rewritten to set `notice: true`; today it doesn't). A `notice` message between, say, two user messages must not manufacture a phantom user→assistant→user gap pattern. The boundary computation skips `notice: true` messages entirely — they belong visually to the surrounding turn-group (no gap above or below), and they're carried along with whichever side of an actual role-transition gap they fall on. The `rewind_preview` count derivation must use the same notice-stripped view, or the modal will report wrong turn-group counts.

### D2 — `gapPosition` is the count of kept messages

See B5. One number, one meaning. A gap at `gapPosition === messages.length` means "fork from current state" (kept = everything). A gap at `gapPosition === 0` means "rewind to empty" (kept = nothing) — this is a valid op and is the case U6 is built around (an empty-chat notice is rendered after the truncation so the session doesn't look nuked).

**Rendering of gap-0.** D1 adds an explicit synthetic gap above the first message so gap-0 has a UI surface when `messages.length > 0` — it follows intermediate-gap styling, and its menu has the full four actions (see below). When `messages.length === 0` there is no separate gap-0 row — the gap-after-last *is* the gap at position 0, and it inherits gap-after-last styling (fork-only menu per D6). This isn't a contradiction: the empty-chat case has nothing to rewind from in any of the three non-fork actions, so showing them disabled would be noise. "Rewind to empty" only makes sense when the chat is *non-empty*; once the rewind completes, U6's notice lands and the next render shows the empty-chat gap (fork-only). The transient state where the user opens the menu at non-empty gap-0 and picks "Rewind chat" is the one where all four actions are present.

**Menu actions at non-empty gap-0:** "Rewind chat" empties history; "Rewind code" resets HEAD to the session's first committed state (the `parentCommitHash` of the earliest message that has one, using the same `findCommitBeforeMessage` fallback logic as `rewind-handlers.ts:85-90`; if no message carries a `parentCommitHash` either, the action is unavailable and the menu surfaces a disabled item with tooltip "No earlier code state to reset to"); "Rewind chat and code" does both; "Fork" forks from an empty kept slice (the child starts with the user's first follow-up). We deliberately do *not* use `git rev-list --max-parents=0 HEAD` for "session's first commit" — that returns the repo's root commit, which for forked or worktree-derived sessions discards everything the parent had committed before the fork.

**Menu items at the gap-after-last.** When `gapPosition === messages.length` the three rewind actions are no-ops by construction (there's nothing past the gap to discard or reset), so the menu shows only the fork action — not all four with three of them disabled. The accompanying confirmation modal, when opened, shows the fork-name input instead of the rewind summary. D6's prominent visual treatment is *because* this gap is fork-only; rendering grayed-out rewind items there would muddle the affordance. The boundary case is enforced server-side too: a `rewind_at_gap` with `action: "chat" | "code" | "both"` and `gapPosition === messages.length` returns `{ type: "error", message: "Nothing to rewind from the current state." }` so a stale client that opened the menu before a streaming turn appended new messages can't no-op the server into corrupted state.

**Trailing-user-message edge case (intermediate gaps).** If the kept slice ends on a user message with no following assistant turn (the agent errored, was interrupted, or never started a response despite the user message persisting), the fork includes that pending prompt. The replay re-sends it on the new session's first turn — same way a normal session would re-process an unanswered user message after a restart. We deliberately do not strip the trailing user message: the user explicitly chose to fork from this point, and stripping the prompt would silently change the kept slice in a way the gap geometry doesn't communicate.

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
2. Parent runner emits `{ type: "fork_breadcrumb", parentSessionId, message }` via `runner.emitMessage` so every viewer attached to the parent — including ones in other tabs that didn't initiate the fork — sees the new card without a reload (per CLAUDE.md's "emit via `runner.emitMessage`, not `ctx.send`" rule).
3. Server sends the `session_forked` response to the initiating connection.
4. Initiating client auto-switches on receipt.

Net effect: the initiating user sees the new session immediately; other tabs viewing the parent see the breadcrumb inline; when anyone navigates back to the parent (via sidebar, history, or the breadcrumb's reverse link from the child), the breadcrumb is already persisted. No race between persistence and navigation.

### D8 — Snapshot storage

The snapshot lives in a small SQLite table `rewind_snapshots(sessionId, ts, action, payload_json)` with a 5-minute TTL enforced on read (lazy cleanup) plus a startup sweep. `action` discriminates the `payload_json` shape per U4 #2 (`{messages}` / `{headHash}` / `{messages, headHash}` / `{childSessionId, breadcrumbMessageId}`). Durable across orchestrator restarts so the "Recover recent rewind" overflow item still works after a crash within the window. An in-memory Map was considered and rejected — the durability cost is one tiny table.

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

Turn-group / file counts in the subtitles come from `rewind_preview` (requested when the menu opens). Until the response arrives, subtitles render with no numbers ("Discard turn-groups" / "Reset files") and upgrade in place when the count lands. The "Rewind chat to here" subtitle never has a file count; the "Rewind code" subtitle never has a turn-group count. The gap-after-last fork item doesn't request `rewind_preview` at all — there's nothing to count on the discard side and the file state is just "current."

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
│  Name: [ debounce-experiment        ]         │
│                                               │
│  Includes 4 turn-groups and the current       │
│  files at commit a1b2c3d.                     │
│                                               │
│                       [ Cancel ]  [ Fork ]    │
└──────────────────────────────────────────────┘
```

Name is pre-filled by the session-namer slug (U7); the user can edit before confirming.

### Undo toast

Appears bottom-center after any rewind (including the chat-only path that skipped the modal). 10-second timer with a thin progress bar; clicking **Undo** restores from `rewind_snapshots` per the per-action shape defined in U4 #2 / D8 (chat-only restores history; code-only resets HEAD; both does the sequenced pair; fork archives the child and removes the breadcrumb).

**Restore failure path.** Per U4 #3 the `both` and `fork` undos are sequenced and not cross-system atomic — a `git reset --hard` can fail if the reflog has been pruned mid-window, and a child-archive can fail mid-teardown. When the restore endpoint returns a non-2xx, the toast transforms in place into an error variant: red accent, the error message, and a single inline link to the `SessionTopBar.tsx` overflow menu's `Recover recent rewind` entry (which still holds the snapshot until the TTL expires). For `both` specifically, when the reset fails the error message also tells the user the chat is restored but the files aren't, and suggests running `git reflog` in the inline terminal panel to find the lost commit — inline per CLAUDE.md §1's "terminal output ... surface inline" rule, not a link-out. The user is never left with "undo failed silently."

```
┌─────────────────────────────────────────┐
│  ✓ Rewound chat and code.    [ Undo ]   │
│  ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱   │
└─────────────────────────────────────────┘
```

For Fork, the toast text is "Forked to *debounce-experiment*" and the **Undo** button archives the new session (workspace + container teardown) and removes the parent's breadcrumb entry. The parent's git state and chat history are unchanged — fork never mutates them — so there's nothing else to restore (see U4 #2 and D8).

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

Three landings. Landing 1 is fully independent. Landing 2 depends on B1+B5 from Landing 1 (sidebar fix + unified WS message). Landing 3 depends on B2 (persisted `rolled_back`) for U5; everything else in Landing 3 can ship in any order.

### Landing 1 — Make it work (bug fixes, no UX change)

- [ ] B1: render orphan-grouped sessions in `SessionSidebar`. Add a "Local sessions" / "Other sessions" group header for unmatched URLs.
- [ ] B2: schema migration — add `rolled_back`, `notice`, `notice_level`, and `fork_child` columns to `messages` (defaults: `0`, `0`, `NULL`, `NULL` for existing rows). Extend `PersistedMessage` and `toRow`/`fromRow` to round-trip all four fields. Persist the rollback divider with `notice: true` (currently `rollback-complete.ts:14-20` builds it without any `notice` field).
- [ ] B3: copy referenced uploads into the forked session.
- [ ] B4: server-side `runner.running` guard on all current handlers; doc 095 capture-at-entry pattern. For the queued-message case in Landing 1 — Landing 1 still uses the four per-message dropdowns, so the per-action confirmation modal pipeline from U4 doesn't exist yet — the interim behavior is: the server unconditionally calls `runner.clearQueue()` inside the rewind/fork transaction and emits a follow-up `system-notice` chat message ("Cleared N queued message(s) as part of rewind."). This keeps queue and history consistent immediately; the explicit pre-confirm prompt arrives in Landing 2 alongside the modal pipeline.
- [ ] B5: introduce `rewind_at_gap` WS message + discriminated handler. Then rewire each of the six existing client call sites (three modes per dropdown) with **explicit per-button `messageIndex` → `gapPosition` conversion**, because the buttons split across two dropdowns with opposite `messageIndex` semantics (verified against `RewindDropdown.tsx:41-52`, `RollbackDropdown.tsx:43-55`, `rewind-handlers.ts:99`, `rollback-handlers.ts:61, 117-120`):

  | Dropdown | Item (mode) | Sends today | Handler `slice` | New `action` | Conversion |
  |---|---|---|---|---|---|
  | `RewindDropdown` (user msg) | "Fork conversation from here" (`fork_chat`) | `rewind_to_message` | `slice(0, messageIndex)` (first-to-discard) | `chat` | `gapPosition = messageIndex` |
  | `RewindDropdown` (user msg) | "Rewind code to here" (`rewind_code`) | `rewind_to_message` | first-to-discard | `code` | `gapPosition = messageIndex` |
  | `RewindDropdown` (user msg) | "Fork conversation and rewind code" (`rewind_all`) | `rewind_to_message` | first-to-discard | `both` | `gapPosition = messageIndex` |
  | `RollbackDropdown` (assistant msg) | "Rollback code" (`code`) | `rollback_code` | `slice(0, messageIndex + 1)` (last-to-keep) | `code` | `gapPosition = messageIndex + 1` |
  | `RollbackDropdown` (assistant msg) | "Rollback code + chat" (`code_and_chat`) | `rollback_code_and_chat` | last-to-keep | `both` | `gapPosition = messageIndex + 1` |
  | `RollbackDropdown` (assistant msg) | "Fork as new session" (`fork`) | `fork_session_from_message` | last-to-keep | `fork` | `gapPosition = messageIndex + 1` |

  Each conversion lives in the same callback as the old `send(...)` call so the off-by-one bug class B5 calls out can't reappear during the cutover. Two behavioral details that the cutover must preserve under the unified `both` action: (a) `rewind_all` and `rollback_code_and_chat` both call `clearAgentSessionId(sessionId)` (`rewind-handlers.ts:140`, `rollback-handlers.ts:68`) — the new `both` handler must too, so the next message starts a fresh agent CLI session. (b) Fork in Landing 1 needs a `branchName`; since U7's name input ships in Landing 2 (see Landing 2 below), the Landing 1 conversion derives a placeholder branch (`fork-<8-char-uuid>`, the same shape `handleForkSessionFromMessage` uses today at `rollback-handlers.ts:101-102`). Old WS messages stay alive in this landing — they're removed in Landing 2 once the gap UI is live.
- [ ] B6: auto-switch + breadcrumb on fork success (uses `SpawnedSessionCard`). The breadcrumb is persisted (B2's `fork_child` column) so it survives reload. In Landing 1 only the initiating viewer sees the card immediately; other tabs viewing the parent see it on their next reload. Live multi-viewer broadcast (`fork_breadcrumb` event, B5 / D7) ships in Landing 2 — pulling it forward into Landing 1 was considered but deferred so Landing 1 stays focused on the bug-fix slice; the event's type and emit site are both small enough that revisiting this trade-off if Landing 2 slips is cheap.
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

- [ ] U5: dim stale messages after rewind-code (needs B2 from Landing 1).
- [ ] U8: richer replay (tool result summary + attachment manifest).

## Key files

**Server**
- `src/server/orchestrator/ws-handlers/rewind-handlers.ts` — current three-mode rewind handler; deprecated in Landing 2.
- `src/server/orchestrator/ws-handlers/rollback-handlers.ts` — current code / code+chat / fork handlers; deprecated in Landing 2.
- `src/server/orchestrator/ws-handlers/resolve-runner.ts` — `resolveRunner(ctx)` for B4.
- `src/server/orchestrator/services/session-fork-merge.ts` — `forkSession()` clone + branch logic. Today the function synthesizes the title server-side as `` `${activeSession?.title ?? "Session"} (${trimmed})` `` and never accepts a caller-supplied title (line 69). The new fork flow needs `forkSession()` to accept an optional `title` parameter from the WS handler / HTTP route — this is a real signature change, not just a rename, and it ripples to `POST /api/sessions/:id/fork` in `api-routes-session.ts:257-280` (which today only accepts `branchName` + `startPoint`).
- `src/server/orchestrator/services/replay.ts` — `buildConversationReplay()`.
- `src/server/orchestrator/chat-history.ts` — `PersistedMessage` interface (10-50), `toRow`/`fromRow` (112-150), `truncate` (191-202), `saveMessages` (205-212); B2 migration target.
- `src/server/orchestrator/api-routes-session.ts:257-280` — HTTP `POST /api/sessions/:id/fork` (mirror path; update for B3 too).
- `src/server/shared/git.ts` — `rollback()`; reused for snapshot restore.
- `src/server/shared/database.ts` — migration adding `rolled_back`, `notice`, `notice_level`, and `fork_child` columns to `messages` (B2 / B6 / D7), plus the new `rewind_snapshots` table.

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
- `src/server/orchestrator/integration_tests/rewind-fork.test.ts` (new — Landing 1).
- `src/client/components/RewindPoint.test.tsx` (new — Landing 2).

**Related docs**
- `docs/007-threads-checkpoints/plan.md` — original rollback design. Add a cross-reference pointing here once this ships.
- `docs/095-runner-ctx-simplification/plan.md` — capture-at-entry pattern used in B4.
- `docs/117-agent-spawned-sessions/plan.md` — source of the `SpawnedSessionCard` pattern reused by D7.

## Open questions

1. **Replay token cost.** U8 widens replay materially for tool-heavy sessions. Measure on representative sessions before deciding whether to gate behind a setting or trim aggressively (e.g. last N tool results only).
2. **Repo-removed orphan sessions UX.** B1's fix surfaces sessions whose repo was removed. The current product behavior is "removeRepo hides them"; surfacing them as "Other sessions" changes that contract. Confirm with product that this is desired — if not, we need a separate "deleted repo" flag to keep them hidden.

(The previous draft had a third open question about `rewind_snapshots` cleanup cadence. Decided: startup sweep + lazy on-read TTL enforcement. The combination gives durability across restarts with no runtime timer overhead, and the 5-minute window means orphan rows are bounded by usage frequency, not wall-clock time.)
