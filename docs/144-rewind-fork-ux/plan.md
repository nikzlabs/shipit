---
status: planned
priority: high
description: Fix the broken fork-as-new-session path and overhaul rewind/rollback UX into a single coherent "go back" model.
---

# Rewind & Fork UX Overhaul

The rewind/rollback/fork system (originally landed in doc 007) has accumulated several real bugs and a confused mental model. The user-visible summary today is:

- "Fork as new session" appears to do nothing — no new entry in the sidebar.
- The user-message control only lets you fork from a point *before* a user turn, so you can't fork from the current state without sacrificing the latest exchange.
- There are two different dropdowns ("Rewind" on user messages, "Rollback" on assistant messages) with overlapping options and inconsistent vocabulary.
- After a "Rollback code + chat" the dimmed messages come back un-dimmed on reload — the `rolledBack` flag is never persisted.

This doc captures both the bug fixes and a design redo. The bug fixes are urgent; the redesign should ship behind them.

## Bugs (the feature doesn't work)

### B1 — Forked sessions never reach the sidebar

`handleForkSessionFromMessage` (`src/server/orchestrator/ws-handlers/rollback-handlers.ts:80-139`) tracks the new session via `sessionManager.track(...)` inside `forkSession()` and then calls `ctx.sseBroadcast("session_list", { sessions: result.sessions })`. The SSE round-trip works (`useServerEvents` consumes `session_list` correctly), but the sidebar still doesn't render the new row.

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

The function builds groups for *every* `remoteUrl` it encounters (good), then throws those groups away by returning only entries from `repoOrder` (bad). Any session whose `remoteUrl` doesn't match a row in the `repos` store — including all freshly forked sessions where the parent's `remoteUrl` is set to something the `repos` table hasn't surfaced yet, plus all local-mode forks where `remoteUrl` is `""` — is silently discarded.

**Fix.** Two parts:
1. After distributing sessions, render *all* non-empty groups, not just the ones with a matching `repo` entry. Use a synthetic group header for unmatched urls (label them by domain, or fall back to "Other sessions").
2. While we're here, confirm `sessionManager.list()` returns the new session *before* `sseBroadcast` fires. The current order in `forkSession()` is correct, but add an integration test that asserts the new id is present in the SSE payload.

### B2 — `rolledBack` is never persisted

`rollback-complete.ts:25-27` flips `rolledBack: true` on in-memory messages only. The `PersistedMessage` interface in `chat-history.ts:10-50` has no `rolled_back` column, and `toRow`/`fromRow` don't read or write the flag. After a reload the dimmed messages come back fully active, the rollback dropdown reappears on them, and clicking it produces nonsense replays.

**Fix.** Add `rolled_back INTEGER` to the `messages` table (migration in `database.ts`), thread it through `toRow`/`fromRow`, and have `handleRollbackCodeAndChat` and the rewind handler write the flag on the persisted slice in the same transaction as the truncation. The client should derive `rolledBack` from the persisted state on load instead of mutating in place.

### B3 — Fork doesn't copy uploads

`handleForkSessionFromMessage` saves truncated chat history to the new session (`rollback-handlers.ts:117-120`) including messages with `/uploads/…` references. The new session has its own `uploads/` dir (per `getActiveDir`'s parent) — empty. Any image, screenshot, or attached file referenced by the surviving turns is a broken link in the fork.

**Fix.** Mirror the rewind helper: after `forkSession()` succeeds, walk `truncatedMessages` for `/uploads/` paths and `fs.copyFile` each into the new session's uploads dir. Wrap in `.catch(() => {})` per-file so a missing source doesn't blow up the whole fork.

### B4 — Rewind/fork during an active turn corrupts state

All four WS handlers (`handleRewindToMessage`, `handleRollbackCode`, `handleRollbackCodeAndChat`, `handleForkSessionFromMessage`) call `chatHistoryManager.saveMessages(...)` and/or `clearAgentSessionId(...)` without checking `runner.running`. The client disables the button via `disabled={isLoading}`, but the server has no guard. A stale tab, double-click, or any non-UI client can interleave a rewind with an in-flight turn and produce a corrupted in-progress message group.

**Fix.** Each handler resolves the runner via `resolveRunner(ctx)` and early-returns `{ type: "error", message: "Cannot rewind while a turn is running." }` when `runner.running` is true. Same guard for fork.

### B5 — Zero integration coverage

`grep -r "rewind_to_message\|fork_session_from_message\|rollback_code" src/server/orchestrator/integration_tests` returns nothing. The only adjacent tests are `git-rollback.test.ts` (raw simple-git layer) and `MessageList.test.tsx` (button visibility). Three rewind modes × three rollback modes × fork, all destructive, all untested. B1-B4 survived because nothing exercises this path.

**Fix.** Add `src/server/orchestrator/integration_tests/rewind-fork.test.ts` covering:
- All three rewind modes write the expected chat/git state.
- All three rollback modes (code, code+chat, fork) ditto.
- Fork produces a session that appears in the next `session_list` SSE payload.
- Fork copies referenced uploads into the new session's dir.
- `rolledBack: true` survives a reload (`chatHistoryManager.load(sessionId)`).
- Rewind/fork during `runner.running === true` returns an error and leaves state unchanged.

## UX problems

### U1 — You can't fork from the current state

This is the headline UX complaint. Today's controls only let you fork *backwards* from a past turn:

- Rewind dropdown on a user message X → forks from *before* X.
- Rollback dropdown on assistant message Y → forks from *before* Y.

There is no "fork from here, keep everything" affordance. To branch the current conversation onto a side experiment, the user must sacrifice the latest exchange. The mental model the user actually wants is "open a copy of this session, including everything up to right now, on its own branch."

**Fix.** Add a top-level "Fork session" action that doesn't take a message index — it forks from `HEAD` with the full history. Two reasonable surfaces:
- Item in the session topbar's overflow menu.
- Dedicated entry at the *bottom* of the chat ("Fork from current state") near the message input, mirroring the way GitHub surfaces "Create branch from this PR."

The existing per-message fork stays (forking from a past state is still useful) but stops being the only entry point.

### U2 — Two dropdowns, two vocabularies, one feature

The split between RewindDropdown (user messages) and RollbackDropdown (assistant messages) has no real basis. The same goal — "go back" — has different verbs and partially-overlapping options:

| RewindDropdown (user msg)           | RollbackDropdown (assistant msg) | Real effect                |
|-------------------------------------|----------------------------------|----------------------------|
| Fork conversation from here         | —                                | Truncate chat, keep code   |
| Rewind code to here                 | Rollback code                    | Reset files, keep chat     |
| Fork conversation and rewind code   | Rollback code + chat             | Reset files + truncate chat|
| —                                   | Fork as new session              | New worktree from this pt  |

Six menu items collapse to **three real actions plus fork**. The "Fork conversation from here" label is the worst trap: it's not actually a fork (no new session created), it just truncates the current chat.

**Fix.** Replace both dropdowns with a single component, shown on every message (user or assistant), with this menu:

- **Rewind chat** — Discard messages from this point onward. Code unchanged.
- **Rewind code** — Reset files to before this turn. Chat unchanged.
- **Rewind both** — Reset files and discard messages.
- *(separator)*
- **Fork as new session** — Create a sibling session at this point with truncated history.

Server figures out the target commit from the message index (walk backward for the last assistant commit). One mental model, one vocabulary.

### U3 — Hover-only trigger, easy to clip

Both dropdowns use `hidden group-hover:flex` plus absolute `-top-3 -right-3` (`MessageList.tsx:417,428`). Consequences:

- Touch devices have no way to surface it.
- On the rightmost edge of a narrow column, `-right-3` clips behind the scrollbar.
- New users have no clue the feature exists.

**Fix.** Move the trigger inline with the message metadata (timestamp, copy button, etc.) so it's always present at low contrast on every message. Bump opacity on hover/focus. On touch, expose via long-press. Lose the `-top-3 -right-3` floating chip.

### U4 — No confirmation, no undo

`chatHistoryManager.saveMessages` is a delete-and-reinsert transaction (`chat-history.ts:191-198`). `git.rollback` is `git reset --hard`. Both are one-click and irreversible from the UI. The only recovery is `git reflog` from a terminal, which loses the user's chat history regardless.

**Fix.**
- Confirmation dialog with a one-line summary: "This will discard 5 messages and reset 3 files. Continue?"
- After rewind/rollback, show a toast: "Rewound. **Undo** (10s)" that restores from a pre-rewind snapshot. The snapshot is cheap: write the full `messages` slice + the HEAD hash to a transient table, key by `(sessionId, ts)`, expire after 5 minutes.

### U5 — Stale chat after a code-only rewind

After "Rewind code" / "Rollback code" the chat still shows assistant turns discussing files that no longer exist. A divider message is inserted ("Code rolled back to `abc1234`"), but the now-stale turns above are not marked.

**Fix.** When rewind-code finishes, mark assistant turns between the rewind point and the divider as `rolledBack` (dim them, hide their rollback dropdowns) the same way we dim post-rollback messages today. They're still visible for reference but visually demoted. Persists with B2.

### U6 — Empty chat after first-message rewind is silent

Rewinding to message index 0 truncates the chat to an empty array with no marker. The session looks nuked.

**Fix.** When the truncated slice is empty, push a `notice` message ("Conversation rewound to start. Send a message to continue.") through the chat. Uses the existing `notice`/`noticeLevel` rendering path.

### U7 — Forks get opaque names

`fork-{8-char-uuid}` is unsearchable and tells the user nothing. The sidebar row reads "Parent title (fork-3f8a91b2)".

**Fix.** When the user picks "Fork as new session", show an inline single-line input pre-filled with a session-namer-derived slug from the message text or the current chat title. Let them edit before confirming. Same pattern used by the "Continue on new branch" dialog.

### U8 — Replay drops everything that isn't text

`buildConversationReplay` (`services/replay.ts`) flattens each message to `User: …` / `Assistant: …` — tool calls, tool results, images, and file references are dropped. Any rewind/fork that resets the agent session loses that context, and Claude's continuation is markedly less informed than the pre-rewind turn was.

**Fix.** Include a compact summary of tool results and a manifest of attached files/images (paths, not content) in the replay. Behind a settings toggle or model-budget guard if we're worried about tokens.

## Proposed design — single mental model

Replace the per-message dropdowns with **one** menu, named **"Go back"**, available on every message and as a top-level "Fork session" affordance. The four actions:

1. **Rewind chat** (chat ← this point, code unchanged)
2. **Rewind code** (code ← state before this turn, chat unchanged but stale turns dimmed)
3. **Rewind both** (chat + code, fresh agent session, replay built from kept turns)
4. **Fork as new session** (new worktree from this point, optionally including the latest exchange when invoked from the top-level affordance)

All four:
- Require `!runner.running` server-side (B4).
- Confirm with a summary before firing (U4).
- Emit an "Undo (10s)" toast after firing (U4).
- Are accessible via the per-message gutter button and via keyboard shortcut on the focused message (Cmd/Ctrl+Z opens the menu).

## Implementation plan

Three landings.

### Landing 1 — Make it work (bug fixes, no UX change)

- [ ] B1: fix `SessionSidebar` repo-group rendering so orphan-grouped sessions appear.
- [ ] B2: persist `rolled_back` through the messages table; hydrate on load.
- [ ] B3: copy uploads into the forked session.
- [ ] B4: server-side `runner.running` guard on all four handlers.
- [ ] B5: integration test file covering all branches.

### Landing 2 — Collapse the two dropdowns and add fork-from-current

- [ ] U1: top-level "Fork session" entry (topbar overflow + below-input affordance).
- [ ] U2: single "Go back" menu component, replaces RewindDropdown + RollbackDropdown.
- [ ] U3: move the trigger out of `-top-3 -right-3`, surface as inline gutter icon, always visible at low contrast.
- [ ] U4: confirmation dialog + undo toast with snapshot restore.
- [ ] U6: empty-chat marker after full rewind.

### Landing 3 — Polish

- [ ] U5: dim stale assistant turns after rewind-code.
- [ ] U7: name input on fork.
- [ ] U8: richer replay (tool result summary + attachment manifest).
- [ ] Keyboard shortcut (Cmd/Ctrl+Z opens "Go back" menu on focused message).

## Key files

**Server**
- `src/server/orchestrator/ws-handlers/rewind-handlers.ts` — three-mode rewind handler.
- `src/server/orchestrator/ws-handlers/rollback-handlers.ts` — code / code+chat / fork handlers.
- `src/server/orchestrator/services/session-fork-merge.ts` — `forkSession()` clone + branch logic.
- `src/server/orchestrator/services/replay.ts` — `buildConversationReplay()`.
- `src/server/orchestrator/chat-history.ts` — persisted message schema, `truncate`, `saveMessages`.
- `src/server/orchestrator/api-routes-session.ts:352-375` — HTTP `POST /api/sessions/:id/fork` (mirror path).
- `src/server/shared/git.ts` — `rollback()`.

**Client**
- `src/client/components/SessionSidebar.tsx:479-519` — repo-group rendering bug (B1).
- `src/client/components/MessageList.tsx:380-437` — rewind/rollback trigger placement (U3).
- `src/client/components/RewindDropdown.tsx` + `RollbackDropdown.tsx` — to be merged (U2).
- `src/client/components/SpawnedSessionCard.tsx` — pattern to reuse for fork notification.
- `src/client/hooks/message-handlers/rewind-complete.ts`, `rollback-complete.ts`, `session-forked.ts`.
- `src/client/App.tsx:459-537` — `handleRewind` / `handleRollback` send-side.

**Shared types**
- `src/server/shared/types/ws-client-messages.ts` — `WsRewindToMessage`, `WsRollbackCode`, `WsRollbackCodeAndChat`, `WsForkSessionFromMessage`.
- `src/server/shared/types/ws-server-messages.ts` — `WsRewindComplete`, `WsRollbackComplete`, `WsSessionForked`.

**Tests (to add)**
- `src/server/orchestrator/integration_tests/rewind-fork.test.ts` (new).

## Open questions

1. **Does B1 also affect non-fork sessions?** If a repo is removed (`repos` cleared) but its sessions persist on disk, they'd be invisible by the same logic. Confirm and fix once. Could be a separate doc if scope creeps.
2. **Undo snapshot retention.** 5 minutes feels right for chat; for the working tree we have `git reflog` for free and don't need a second mechanism. Worth confirming.
3. **Fork-from-current scope.** Should the top-level fork action live in the topbar, below the input, or both? Recommend the topbar overflow first, with a small "Fork" button next to the existing PR card once we ship the rest.
4. **Replay token cost.** U8 widens replay; we should measure on a representative session before deciding whether to gate behind a setting.
