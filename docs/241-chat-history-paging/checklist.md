# Checklist

Design only so far — nothing implemented. Sequencing rationale is in `plan.md`.

## 1. Storage + windowed read
- [ ] Add `turn_seq INTEGER` (per-session ordinal) + `idx_messages_session_turn`
- [ ] Allocate the ordinal at turn start; recover after a crash as `MAX(turn_seq) + 1`
- [ ] Ordinal survives paths that do NOT re-append the opener: auth retry (`turn-executor.ts:235`), dispatched no-result retry (`dispatched-turn.ts:253`), adoption (`turn-adoption.ts:101`)
- [ ] First-turn edge: new session persists its user row only on `agent_init` (`agent-listeners.ts:721`) — cover the crash-before-`agent_init` replay
- [ ] Out-of-turn rows inherit the latest ordinal; rows before any turn get `0` (merge-watch, session-report, rebase-driver, issue-lifecycle, startup-tasks, fork breadcrumb, post-turn notices, `dispatched-turn.ts:92`)
- [ ] `saveMessages` round-trips `turn_seq` unchanged (rewind + fork)
- [ ] One-shot backfill migration for legacy rows (user-row heuristic)
- [ ] `loadWindow(sessionId, { turns, beforeTurnSeq })`; leave `load()` intact
- [ ] `historyGeneration` per session — bump on `saveMessages`, `markRolledBackFromIndex`, `clearRolledBack`, `deleteMessageById`; NOT on `replaceInProgress`
- [ ] Generation check + page read + destructive mutation each atomic with their bump

## 2. Wire shape + endpoints
- [ ] Opt-in `?turns=N` on `/history`; absent ⇒ byte-identical to today
- [ ] `rowId` through `fromRow` → `PersistedMessage` → `ChatMessage`
- [ ] Page metadata: `hasMore`, `oldestTurnSeq`, `omittedBefore`, `historyGeneration`
- [ ] `firstUserText` + `sentUploadPaths` via narrow SQL (never via `load()`)
- [ ] Lean `GET /api/sessions/:id/history/messages` (no git log / file tree)

## 3. Fix index addressing (gates activation)
- [ ] Rewind: translate `gapPosition` through `omittedBefore`
- [ ] `commit_linked.messageIndex`: translate through `omittedBefore`
- [ ] Regression test: rewind from a windowed client rewrites the correct rows (`chat`, `both`, `code`, `fork`)

## 4. Client paging
- [ ] Stable keys: `rowId` for hydrated rows, local key for live/id-less rows
- [ ] Prepend path in the session store + page dedupe
- [ ] `hydrateTranscriptPage(messages, mode)` — replaces the four whole-array card-store scans
- [ ] Older page must not overwrite newer card lifecycle state
- [ ] Row-aware lifecycle updates for unloaded cards (fix `handleReleaseCard`'s append fallback)
- [ ] Scroll anchoring on prepend (element anchor; `content-visibility: visible` during correction)
- [ ] Prepend signal in `useMessageScroll` so the bottom-pin settle loop stands down
- [ ] Queue all transcript mutations behind initial-page install
- [ ] Generation mismatch → abort in-flight fetches, reload recent window

## 5. Whole-history consumers
- [ ] `PrLifecycleCard` (x2) reads `firstUserText`
- [ ] `file-store` sent-upload pruning reads `sentUploadPaths`
- [ ] Server-side full-history export endpoint; `handleDownloadChat` uses it
- [ ] Ctrl+F pages backwards **through to the start**, with visible progress

## 6. Activate
- [ ] Client sends `?turns=10` — only after 3, 4 and 5 are done

## 7. Verification
- [ ] Initial load returns whole turns, never a mid-turn cut
- [ ] Steered mid-turn user rows do not create a page boundary
- [ ] Legacy backfilled history: document + test the known mid-turn split at a legacy steer
- [ ] Load-older is stable while a turn is appending
- [ ] Out-of-turn cards land in the newest page, never an already-loaded older one
- [ ] Card lifecycle state survives a prepend
- [ ] Manual: scroll position holds on prepend, with and without images in the batch
