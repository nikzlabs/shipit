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

The culprit is `SessionSidebar.tsx:479-519`:

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
  return repoOrder.map((repo) => ({ repo, sessions: grouped.get(repo.url) ?? [] }));
}, [repos, sessions]);
```

The function builds groups for *every* `remoteUrl` it encounters (good), then throws those groups away by returning only entries from `repoOrder` (bad). Two concrete failure modes both hit this:

1. **Local-mode forks.** `forkSession()` (`session-fork-merge.ts:73-75`) only calls `setRemoteUrl` when the parent's `remoteUrl` is truthy. Local-mode forks therefore inherit `undefined`, the grouping key becomes `""`, the `""` bucket isn't in `repoOrder`, and the session is dropped.
2. **Sessions whose repo was removed.** `removeRepo` clears the row from the `repos` table but leaves sessions on disk (intentional). Their `remoteUrl` is set, but `repoOrder` no longer contains it — same failure mode.

This is structurally the same bug. Fixing it once also resolves Open Q#1 from the previous draft (which is now removed).

**Fix.** After distributing sessions, render *every* non-empty group — not just the ones in `repoOrder`. Unmatched URLs get a synthetic header ("Other sessions", or the URL's host when present); the empty-string bucket renders under "Local sessions". Order: known repos first (existing `repoOrder` sort), then orphan groups appended in stable URL order.

### B2 — `rolledBack` and the rollback divider are both lost on reload

`rollback-complete.ts:25-27` flips `rolledBack: true` on in-memory messages only. The `PersistedMessage` interface (`chat-history.ts:10-50`) has no `rolled_back` column, and `toRow`/`fromRow` don't read or write the flag. After reload, dimmed messages come back fully active and their rollback dropdowns reappear.

The "Code rolled back to `abc1234`" divider has the same problem: `rollback-complete.ts:14-22` inserts it via `setMessages` only — the server never persists it. After reload, the divider disappears entirely, leaving no indication that a rollback ever happened.

**Fix.** Both in one migration:

1. Add `rolled_back INTEGER` to the `messages` table. Default `0`. Existing rows are silently un-dimmed (acceptable — pre-migration rollback state was already non-durable; we're not regressing).
2. Persist the rollback divider as a real assistant message with a `notice` flag (already exists on the client type — add the `notice` column to the schema if not already there) so it round-trips through `load(sessionId)`.
3. Thread `rolledBack` through `toRow`/`fromRow`. `handleRollbackCodeAndChat` and the unified gap handler write the flag on the persisted slice in the same transaction as the truncation. The client derives `rolledBack` from persisted state on load — no in-place mutation.

### B3 — Fork doesn't copy uploads

`handleForkSessionFromMessage` saves truncated chat history to the new session (`rollback-handlers.ts:117-120`) including messages with `/uploads/…` references. The new session has its own `uploads/` dir (per `getActiveDir`'s parent) — empty. Any image, screenshot, or attached file referenced by the surviving turns is a broken link in the fork.

**Fix.** Mirror the rewind helper: after `forkSession()` succeeds, walk `truncatedMessages` for `/uploads/` paths and `fs.copyFile` each into the new session's uploads dir. Wrap in `.catch(() => {})` per-file so a missing source doesn't blow up the whole fork.

### B4 — Rewind/fork during an active turn corrupts state

All four WS handlers (`handleRewindToMessage`, `handleRollbackCode`, `handleRollbackCodeAndChat`, `handleForkSessionFromMessage`) call `chatHistoryManager.saveMessages(...)` and/or `clearAgentSessionId(...)` without checking `runner.running`. The client disables the button via `disabled={isLoading}`, but the server has no guard. A stale tab, double-click, or any non-UI client can interleave a rewind with an in-flight turn and produce a corrupted in-progress message group.

A second, subtler hazard: if the user has queued messages (`runner.messageQueue`, populated via `message-queued.ts` and surfaced by `queue-updated.ts`), a successful rewind silently strands them — they're addressed to a chat that no longer exists below the rewind point.

**Fix.**
1. Each handler resolves the runner via `resolveRunner(ctx)` (see `ws-handlers/resolve-runner.ts`) and early-returns `{ type: "error", message: "Cannot rewind while a turn is running." }` when `runner.running` is true. Follow doc 095's capture-at-entry pattern — capture `sessionId`/`sessionDir` once at handler entry, never read them inside async callbacks.
2. If `runner.messageQueue.length > 0`, the client-side confirmation flow (U4) gains an extra "discard N queued messages" line on the modal it would already show for code-touching actions, OR shows a small single-purpose confirmation modal for chat-only actions that would otherwise be modal-free. On confirm, the server calls `runner.clearQueue()` (`session-runner.ts:458`) in the same transaction as the chat truncation, so the queue and history can't desync.

### B5 — WS handler vocabulary and `messageIndex` semantics are inconsistent

The existing handlers cannot be cleanly reused by the gap UI without first being normalized:

- `rewind_to_message` (`rewind-handlers.ts:99`) does `allMessages.slice(0, messageIndex)` — index is the **first message to discard**.
- `rollback_code_and_chat` (`rollback-handlers.ts:61`) does `allMessages.slice(0, messageIndex + 1)` — index is the **last message to keep**.
- `rewind_code` mode of `handleRewindToMessage` sends a `rollback_complete` event back (`rewind-handlers.ts:121`), not `rewind_complete` — the client renders an "assistant divider" message under a *user* message index, which works by accident.

If the gap UI tries to reuse these as-is, off-by-one bugs and divider-on-wrong-side bugs are inevitable.

**Fix.** Introduce a single new WS client message and a single new server response, used by every gap menu action:

- Client → server: `{ type: "rewind_at_gap", gapPosition: number, action: "chat" | "code" | "both" | "fork" }`. `gapPosition` is unambiguous — "keep the first `gapPosition` messages, discard the rest." A gap at position `messages.length` is "rewind nothing, fork from the current state."
- Server → client: `{ type: "rewind_complete", gapPosition: number, action: "...", ... }` for in-place actions; `{ type: "session_forked", ... }` for fork.

The four old WS messages (`rewind_to_message`, `rollback_code`, `rollback_code_and_chat`, `fork_session_from_message`) are removed in Landing 2 along with the per-message dropdowns. No external API consumes them — they're WS-only, internal — so no deprecation window is needed.

### B6 — `session_forked` strands the user

`handleSessionForked` (`session-forked.ts`) just appends a chat message: "Session forked as 'X'. Switch to it from the sidebar." This is exactly the link-out failure mode CLAUDE.md §1/§2 prohibits — the user explicitly asked to fork, and we're telling them to go hunt for the result. Combined with B1, today they're hunting for a row that doesn't exist.

**Fix.** On fork success:
1. Server response stays `session_forked` with `{sessionId, sessionName, branch}`.
2. Client auto-navigates to the new session (same code path as `setSessionId`).
3. The *parent* session's chat gets a `SpawnedSessionCard`-style entry (reuses the doc 117 pattern) as a breadcrumb, so the user can hop back. Persisted via the same mechanism `session-spawned.ts` will need anyway.

This makes Key Files' reference to `SpawnedSessionCard.tsx` load-bearing, not aspirational.

### B7 — Zero integration coverage

`grep -r "rewind_to_message\|fork_session_from_message\|rollback_code" src/server/orchestrator/integration_tests` returns nothing. The only adjacent tests are `git-rollback.test.ts` (raw simple-git layer) and `MessageList.test.tsx` (button visibility). Three rewind modes × three rollback modes × fork, all destructive, all untested. B1-B6 survived because nothing exercises this path end to end.

**Fix.** Add `src/server/orchestrator/integration_tests/rewind-fork.test.ts` covering:
- Each `rewind_at_gap` action (`chat`, `code`, `both`, `fork`) at multiple gap positions (first, middle, last).
- Fork produces a session that appears in the next `session_list` SSE payload AND renders in `SessionSidebar`'s orphan-group bucket when applicable.
- Fork copies referenced uploads into the new session's dir.
- Fork persists a `SpawnedSessionCard`-style breadcrumb in the parent's chat history (D7) and the client auto-switches on `session_forked` (the latter belongs in a hook-level test, not the integration file — call it out alongside the assertion).
- `rolledBack: true` survives a reload (`chatHistoryManager.load(sessionId)`).
- Rollback divider survives a reload.
- `rewind_preview` returns the correct `{turnGroupCount, fileCount}` for representative gap positions, including with `notice` messages straddling the gap (D1) and a trailing user message at the last gap (D2).
- `rewind_snapshots` round-trip: write a snapshot, simulate orchestrator restart by reopening the SQLite database, restore — both chat and `git` HEAD return to the pre-rewind state (D8).
- Rewind during `runner.running === true` returns an error and leaves state unchanged.
- Rewind with `runner.messageQueue.length > 0` clears the queue on confirm; queue and chat history end in a consistent state (no orphan queued messages addressing discarded turns).

A companion client test file, `src/client/components/RewindPoint.test.tsx`, covers the streaming-disabled visual states (D3: gap-after-last hidden, intermediate gaps disabled with tooltip) and the role-transition computation including notice-message transparency (D1). The integration file owns persistence/correctness; the client file owns UI states.

## UX problems

### U1, U2, U3 — Resolved by the new "rewind point" design

The three biggest UX problems all stem from the same root: controls are attached to *messages* instead of to *points in time*. Today's controls only let you fork *backwards* from a past turn (so there's no way to fork from the current state without sacrificing the latest exchange), and because each control is attached to a message it's never obvious whether that message is on the kept side or the discarded side. On top of that, the two dropdowns use different vocabularies for the same operations, and the floating `-top-3 -right-3` chip is invisible on touch and clips behind the scrollbar on narrow viewports.

The new design — described in "Proposed design" below — replaces all three with a single control anchored to the **gap between turns** (and after the last turn). It eliminates the message-attachment ambiguity by construction, gives us a natural surface for fork-from-current (the gap after the last message *is* the current-state rewind point), and lets us drop the floating-chip placement entirely.

### U4 — No confirmation, no undo

`chatHistoryManager.saveMessages` is a delete-and-reinsert transaction (`chat-history.ts:191-198`). `git.rollback` is `git reset --hard`. Both are one-click and irreversible from the UI. The only recovery today is `git reflog` from a terminal — which restores files but loses chat history, and which violates the "inline beats link-out" product principle.

**Fix.** Three pieces, designed together:

1. **Selective confirmation.** Chat-only rewind ("Rewind chat to here") is cheap and recoverable — no modal, just fire and rely on the undo toast. Code-touching actions ("Rewind code", "Rewind chat and code", "Fork") get a confirmation dialog with a summary derived from server-computed counts: "Discard 3 turn-groups and reset 5 files. Continue?" The "turn-group" wording matches D1's role-transition definition — a single user prompt followed by an assistant response is one turn-group, not two — which the count derivation also uses. This resolves the apparent tension between the doc's "geometric clarity removes ambiguity" claim and the modal: the geometry handles *what* gets discarded; the modal exists for *destructive-to-code* operations the user can't visually inspect.
2. **Snapshot covers files AND chat.** Pre-action snapshot stores `{messages: PersistedMessage[], headHash: string}`. Restore is atomic — `chatHistoryManager.saveMessages(sessionId, snapshot.messages)` followed by `git reset --hard <snapshot.headHash>`. The reset is safe because the rewind already moved HEAD; the reflog still holds the old commit. Stored in a small `rewind_snapshots` SQLite table with 5-minute expiry. (No `branch` field — none of the rewind actions cross branches, so `git.rollback()`'s straight `git reset --hard <hash>` is the right restore primitive too.)
3. **Undo affordance is dual-track.** A 10-second "Rewound. **Undo**" toast covers the common case. For up to 5 minutes after, a discreet "Recover recent rewind" entry lives in the session topbar overflow menu — inline per the product principle, not a link-out to `git reflog`.

The new server pair `rewind_preview_request` / `rewind_preview` lets the client populate the confirmation modal's counts without a roundtrip per keystroke. The client requests when the menu opens; server returns `{turnGroupCount, fileCount}` derived from `gapPosition` (turn-group count is computed from role transitions on the kept-vs-discarded split; file count is `git diff --name-only HEAD <target>`).

If the user has queued messages at the time of the action, the modal gains one extra line — "You have N queued messages; rewinding will discard them" — and confirming clears the queue. The chat-only path stays modal-free unless the queue is non-empty; if it is, a small single-purpose dialog ("Discard N queued messages and rewind?") appears. We deliberately keep the queue-clear confirmation distinct from the file-count modal so D4's "chat-only is modal-free" promise still holds in the common case.

### U5 — Stale chat after a code-only rewind

After "Rewind code" the chat still shows assistant turns discussing files that no longer exist. A divider message is inserted ("Code rolled back to `abc1234`"), but the now-stale turns above the divider are not marked.

**Fix.** When rewind-code finishes, mark assistant turns between the rewind point and the divider as `rolledBack` (dim them, hide their gap menus). They're still visible for reference but visually demoted. Depends on B2.

### U6 — Empty chat after first-message rewind is silent

Rewinding to the gap above the first message truncates the chat to an empty array with no marker. The session looks nuked.

**Fix.** When the truncated slice is empty, push a `notice` message ("Conversation rewound to start. Send a message to continue.") through the chat. Uses the existing `notice`/`noticeLevel` rendering path. The notice is **not** persisted — the next user message overwrites it for chat-history purposes, and on reload an empty session renders an empty chat (the existing first-run experience), not a stale "rewound to start" marker. This keeps the notice from being mistaken for a real turn-group by D1's role-transition computation.

### U7 — Forks get opaque names

`fork-{8-char-uuid}` is unsearchable and tells the user nothing. The sidebar row reads "Parent title (fork-3f8a91b2)".

**Fix.** When the user picks "Fork as new session", show an inline single-line input pre-filled with a session-namer-derived slug from the gap's most recent user message (or, for the gap-after-last with no recent user message in the kept window, the current session title). Let them edit before confirming. Same pattern used by the "Continue on new branch" dialog.

### U8 — Replay is text-only and frequently empty

`buildConversationReplay` (`services/replay.ts`) flattens each message to `User: …` / `Assistant: …` — tool calls, tool results, images, and file references are dropped. For tool-heavy sessions, where assistant turns can be purely tool-use with no narrative text, the replay reduces to `"Assistant: "` placeholders, which is worse than no replay at all. Any rewind/fork that resets the agent session loses that context, and Claude's continuation is markedly less informed than the pre-rewind turn was.

**Fix.** Include a compact summary of tool results (tool name + short result excerpt, capped at e.g. 500 chars per tool) and a manifest of attached files/images (paths, not content) in the replay. Behind a settings toggle or model-budget guard if we're worried about tokens — see Open Q#1.

## Design decisions (resolved before Landing 2)

The previous draft deferred several questions that turn out to be load-bearing. Locking them down here.

### D1 — Turn-group boundary = role transition

A "turn" is a maximal run of consecutive same-role messages. Gaps render between role transitions. No persistence change required — the client computes boundaries from the flat `messages: PersistedMessage[]` array.

This deliberately differs from the server's internal `agent_tool_result`-based grouping (which informs streaming chunking but isn't persisted). For the rewind UI, the user's mental model is "user said X, then assistant did stuff" — role transitions are the right granularity. Sub-turn gaps (between two assistant messages during a single agent run) are not useful and would clutter the chat.

**`notice` messages are transparent to the boundary computation.** Today's rollback divider and other system notes render as `role: "assistant"` with `notice: true` (`MessageList.tsx:84`). After B2, the divider is persisted with the same shape. A `notice` message between, say, two user messages must not manufacture a phantom user→assistant→user gap pattern. The boundary computation skips `notice: true` messages entirely — they belong visually to the surrounding turn-group (no gap above or below), and they're carried along with whichever side of an actual role-transition gap they fall on. The `rewind_preview` count derivation must use the same notice-stripped view, or the modal will report wrong turn-group counts.

### D2 — `gapPosition` is the count of kept messages

See B5. One number, one meaning. A gap at `gapPosition === messages.length` means "fork from current state" (kept = everything). A gap at `gapPosition === 0` means "rewind to empty" (kept = nothing); the menu suppresses non-fork actions in this case because there's nothing to rewind *to*.

**Trailing-user-message edge case.** If the kept slice ends on a user message with no following assistant turn (the agent errored, was interrupted, or never started a response despite the user message persisting), the fork includes that pending prompt. The replay re-sends it on the new session's first turn — same way a normal session would re-process an unanswered user message after a restart. We deliberately do not strip the trailing user message: the user explicitly chose to fork from this point, and stripping the prompt would silently change the kept slice in a way the gap geometry doesn't communicate.

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

It's the fork-from-current entry point and the doc has explicitly dropped the topbar surface for that, so its discoverability matters. The gap-after-last is rendered with:
- ~50% taller than intermediate gaps (so it reads as a dedicated row),
- A persistent, fully-visible pill containing both the rewind icon and a "+" icon (in contrast to intermediate gaps, where the pill only appears on hover/focus),
- Hairline at full opacity at rest,
- Aria-label "Fork from current state or rewind further."

No first-run cookie. The treatment is unconditional.

### D7 — Fork success auto-switches with a breadcrumb

See B6. On successful fork, the client auto-navigates to the new session, and the parent session's chat gets a `SpawnedSessionCard` entry as a breadcrumb back. This consolidates two patterns into one (doc 117's spawned-card and our fork-card) — both are "this session created a sibling, here's a way to navigate."

**Sequencing.** The server persists the breadcrumb to the parent's chat history *before* sending the `session_forked` response — same flow doc 117 uses for agent-spawned siblings. The client then auto-switches on receipt. Net effect: the user sees the new session immediately, and when they navigate back to the parent (via sidebar, history, or the breadcrumb's reverse link from the child), the breadcrumb is already there. The user never sees the breadcrumb flash by in the parent before navigation, and there's no race between persistence and navigation.

### D8 — Snapshot storage

The snapshot lives in a small SQLite table `rewind_snapshots(sessionId, ts, messages_json, head_hash)` with a 5-minute TTL enforced on read (lazy cleanup) plus a startup sweep. Durable across orchestrator restarts so the "Recover recent rewind" overflow item still works after a crash within the window. An in-memory Map was considered and rejected — the durability cost is one tiny table.

## Proposed design — rewind points between turns

Replace both per-message dropdowns with **one** control, anchored to the **gap between role transitions** (D1) and after the last turn. The control after the last turn doubles as "fork from the current state."

### Why between turns

When the control is attached to a message, the question "is this message kept or discarded?" has to be answered by the menu label and the user has to read carefully every time. When the control sits in the gap, the answer is geometric: **everything above the line is kept, everything below it is gone.** The modal in D4 exists for the file count, not for the chat geometry.

### Visual treatment and menu

See the "UI spec" section below for sketches of each surface (intermediate gap at rest, on hover, the menu, confirmation modal, undo toast, recover-overflow item). High-level rules:

- Intermediate gaps: 16-24px row with a persistent very-low-contrast hairline (D5). Hover/focus brings the hairline to full opacity and reveals a small pill with the rewind icon.
- Gap-after-last: ~50% taller, pill always visible, hairline always at full opacity (D6).
- Streaming: gap-after-last hidden; intermediate gaps disabled with tooltip (D3).
- Menu: four actions (rewind chat / rewind code / rewind both / fork). Code-touching actions open the confirmation modal first (D4). Counts in the modal come from `rewind_preview` (U4).

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

Same `RewindPoint` component, different styling tokens. ~50% taller (24-36px). Hairline always full opacity. Pill always visible, with both the rewind icon and a `Plus` icon — the second icon signals "this is also where new sessions branch off." Aria-label "Fork from current state or rewind further."

```
┌──────────────────────────────────────┐
│  Done — your handler is debounced.   │
└──────────────────────────────────────┘

   ──────────────  ⟲ +  ──────────────    ← taller row, both icons, always visible

[  Type your next message…              ]
```

### Streaming states

- Gap-after-last during a streaming turn: **completely hidden.** No row, no hairline, no pill. There's no committed "current state" to fork from until the auto-commit fires.
- Intermediate gaps during streaming: hairline drops to ≈5% opacity; pill rendered but disabled (greyed; no hover effect). Tooltip on the row: "Wait for the current turn to finish."

When the turn ends, the after-last gap reappears with a fresh `commitHash` and intermediate gaps re-enable.

### The menu

Opens from the pill, prefers opening upward since the gap is inline in scrolling chat. Width ~280px. Item layout mirrors the existing dropdowns (label + 1-line muted subtitle):

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

Turn-group / file counts in the subtitles come from `rewind_preview` (requested when the menu opens). Until the response arrives, subtitles render with no numbers ("Discard turn-groups" / "Reset files") and upgrade in place when the count lands. The "Rewind chat to here" subtitle never has a file count; the "Rewind code" subtitle never has a turn-group count.

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

Appears bottom-center after any rewind (including the chat-only path that skipped the modal). 10-second timer with a thin progress bar; clicking **Undo** restores from `rewind_snapshots` (D8) — both files and chat in one transaction.

```
┌─────────────────────────────────────────┐
│  ✓ Rewound chat and code.    [ Undo ]   │
│  ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱   │
└─────────────────────────────────────────┘
```

For Fork, the toast text is "Forked to *debounce-experiment*" and the **Undo** button removes the new session + restores the parent's chat/files.

### "Recover recent rewind" — topbar overflow

For up to ~5 minutes after the toast expires, the session topbar overflow menu shows a discreet entry. Disappears once the snapshot's TTL passes (D8). Time shown is relative.

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
| Gap-after-last | 24-36px | hairline 100%, pill visible | (same) | Both icons in pill |
| Gap-after-last (streaming) | 0px | hidden | n/a | Row removed entirely |
| Modal | dialog default | n/a | n/a | Reuses existing `Dialog` |
| Toast | bottom-center | 100% | n/a | 10s timer + Undo |

## Implementation plan

Three landings. Landing 1 is fully independent. Landing 2 depends on B1+B5 from Landing 1 (sidebar fix + unified WS message). Landing 3 depends on B2 (persisted `rolled_back`) for U5; everything else in Landing 3 can ship in any order.

### Landing 1 — Make it work (bug fixes, no UX change)

- [ ] B1: render orphan-grouped sessions in `SessionSidebar`. Add a "Local sessions" / "Other sessions" group header for unmatched URLs.
- [ ] B2: add `rolled_back` column + persist the rollback divider. Migration writes default `0` for existing rows.
- [ ] B3: copy referenced uploads into the forked session.
- [ ] B4: server-side `runner.running` guard on all current handlers; doc 095 capture-at-entry pattern; queued-message confirmation path.
- [ ] B5: introduce `rewind_at_gap` WS message + handler; map existing client buttons to call it (no UX change yet). Old WS messages stay alive in this landing — they're removed in Landing 2.
- [ ] B6: auto-switch + breadcrumb on fork success (uses `SpawnedSessionCard`).
- [ ] B7: integration test file covering all branches above.

### Landing 2 — Replace per-message dropdowns with between-turn rewind points

- [ ] Build `RewindPoint` component per the "UI spec" section above (intermediate gap, gap-after-last, streaming states, menu).
- [ ] Render `RewindPoint` between every role transition in `MessageList`, plus the prominent gap-after-last (D6). Hide/disable per D3.
- [ ] Implement the four menu actions, all routing through `rewind_at_gap` (D2).
- [ ] Add `rewind_preview_request` / `rewind_preview` WS pair; populate menu subtitles and modal counts (U4 + UI spec).
- [ ] Confirmation modal (selective, per D4) + undo toast + "Recover recent rewind" topbar overflow item.
- [ ] `rewind_snapshots` SQLite table + restore endpoint (D8).
- [ ] Delete `RewindDropdown.tsx`, `RollbackDropdown.tsx`, the four old WS message types and their handlers. Cover with regression tests so the old chip can't sneak back.
- [ ] U6: empty-chat marker after full rewind.

### Landing 3 — Polish

- [ ] U5: dim stale assistant turns after rewind-code (needs B2 from Landing 1).
- [ ] U7: name input on fork (inline single-line field in the gap menu's confirmation modal).
- [ ] U8: richer replay (tool result summary + attachment manifest).

## Key files

**Server**
- `src/server/orchestrator/ws-handlers/rewind-handlers.ts` — current three-mode rewind handler; deprecated in Landing 2.
- `src/server/orchestrator/ws-handlers/rollback-handlers.ts` — current code / code+chat / fork handlers; deprecated in Landing 2.
- `src/server/orchestrator/ws-handlers/resolve-runner.ts` — `resolveRunner(ctx)` for B4.
- `src/server/orchestrator/services/session-fork-merge.ts` — `forkSession()` clone + branch logic.
- `src/server/orchestrator/services/replay.ts` — `buildConversationReplay()`.
- `src/server/orchestrator/chat-history.ts` — persisted message schema, `truncate`, `saveMessages`; B2 migration target.
- `src/server/orchestrator/api-routes-session.ts:352-375` — HTTP `POST /api/sessions/:id/fork` (mirror path; update for B3 too).
- `src/server/shared/git.ts` — `rollback()`; reused for snapshot restore.
- `src/server/shared/database.ts` — migration for `rolled_back` column and the new `rewind_snapshots` table.

**Client**
- `src/client/components/SessionSidebar.tsx:479-519` — repo-group rendering bug (B1).
- `src/client/components/MessageList.tsx:380-437` — current rewind/rollback trigger placement; goes away in Landing 2.
- `src/client/components/RewindDropdown.tsx` + `RollbackDropdown.tsx` — deleted in Landing 2.
- `src/client/components/SpawnedSessionCard.tsx` — reused by fork breadcrumb (B6 / D7).
- `src/client/hooks/message-handlers/rewind-complete.ts`, `rollback-complete.ts`, `session-forked.ts` — rewritten or deleted in Landing 2 depending on WS message changes.
- `src/client/App.tsx:459-537` — `handleRewind` / `handleRollback` send-side; collapses to one `handleRewindAtGap`.

**Shared types**
- `src/server/shared/types/ws-client-messages.ts` — add `WsRewindAtGap`, `WsRewindPreviewRequest`; remove the four old types in Landing 2.
- `src/server/shared/types/ws-server-messages.ts` — add `WsRewindPreview`; align `WsRewindComplete` / `WsSessionForked` with new payload shapes.

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
