---
issue: https://linear.app/shipit-ai/issue/SHI-94
description: Make every at-rest chat card/notice survive reload and session switch — close the recurring emit-only persistence gap.
---

# Persist all at-rest transcript content

## Context

The chat transcript was **non-deterministic across reload / session switch**: several
cards and notices rendered live (and survived a WS reconnect via the turn-event buffer)
but **vanished on a full page reload or session switch**, because those rehydrate the
transcript only from persisted chat history (`loadSessionHistory` → `GET /history` →
`ChatHistoryManager`). Staring at a session vs. switching away and back produced different
transcripts — which reads as a bug.

This is a recurring bug class (voice notes docs/163, bug-report docs/164, issue-write
docs/177, compaction docs/178 each shipped emit-only and were retrofitted). An audit found
the remaining gaps and this doc closes them, establishing the rule:

> **Anything still visible in the scrollback once a turn settles must survive reload.**
> Genuinely transient live status (spinners, "Thinking…", queue-position badge,
> `preview_status`, the `streaming` flag) stays ephemeral — it already disappears on its own
> when the turn settles, so reload changes nothing. Persisting a frozen "Running…" spinner
> would only create a stale artifact.

## What changed

The fix reuses the established side-channel-card pattern (`emitChatCard` →
`PersistedMessage` field + DB column → rehydrate in `loadSessionHistory` → idempotent-by-id
client handler). All new fields are message-field cards (no Zustand store) like
voiceNote/compaction.

- **`spawnedSession` / `spawnFailed`** (docs/117) — `api-routes-session.ts` emits via
  `emitChatCard`. New `spawned_session` / `spawn_failed` columns. `spawnFailed` gets a
  server-generated `id` (no natural key; a failed spawn has no sidebar row to fall back on,
  so persistence is its only record). Client dedupes by `childSessionId` / `id`.
- **`agentReview`** (docs/151) — `api-routes-reviews.ts` emits via `emitChatCard`. New
  `agent_review` column. The review snapshot + comments already persisted in `agent_reviews`;
  this persists the inline breadcrumb. Client dedupes by `reviewId`.
- **`userReview`** — threaded through `send_message` (`WsSendMessage.userReview`) →
  `persistUserMessage` (agent-execution.ts) onto the initiating user row (new `user_review`
  column). The prompt text was always persisted; this keeps the card chrome instead of
  degrading to a plain text bubble on reload.
- **`system_notice`** (docs/138) — now persisted with a stable `id` (new `notice_id` column).
  In-turn notices (guarded-mode banners) use `emitNoticeInTurn` (records in-band via
  `emitChatCard`); post-turn notices (unresolved-conflict, no-result retry) use
  `emitNoticePostTurn` (append + emit, lands at the current end). Client dedupes by `noticeId`
  so a buffer-replayed copy doesn't double-render.

### Deliberately left ephemeral

- **Rewind action-feedback** — the queue-clear notice (`rollback-handlers.ts`) and the
  rewind-to-start notice (`rewind-complete.ts`) are transient feedback for a destructive
  operation the user is actively performing. The rewind's durable result (truncated history +
  the appended "Code rolled back" notice) survives; these footnotes don't. The queue-clear
  also fires *before* the branch `saveMessages(truncated)` that would wipe an append.
- **spawnedSession status pill** stays live (derived from the session store) — only the static
  card payload persists.

## Key files

- `src/server/orchestrator/chat-history.ts` — new `PersistedMessage` fields + columns +
  toRow/fromRow.
- `src/server/shared/database.ts` — migration adding `spawned_session`, `spawn_failed`,
  `agent_review`, `user_review`, `notice_id`.
- `src/server/orchestrator/chat-card-persistence.ts` — `emitNoticeInTurn` /
  `emitNoticePostTurn` helpers (+ `buildSystemNotice`).
- `src/server/orchestrator/api-routes-session.ts`, `api-routes-reviews.ts` — card emits.
- `src/server/orchestrator/ws-handlers/{agent-execution,agent-listeners,post-turn}.ts`,
  `turn-executor.ts`, `dispatched-turn.ts`, `services/github.ts` — notice emits + userReview.
- `src/client/hooks/message-handlers/{session-spawned,session-spawn-failed,agent-review-added,system-notice}.ts`
  — idempotent-by-id appends.
- `src/client/components/visual-elements.ts` — `hasCardContent` allow-list (the render-drop
  bug fixed in the same effort for `issueWrite` + `compaction`).

## Related docs

- `docs/117-agent-spawned-sessions/`, `docs/138-claude-auto-mode-classifier/`,
  `docs/151-agent-review-cards/` — the features whose cards/notices this persists.
- `docs/163-voice-notes/`, `docs/164-user-bug-filing/`, `docs/177-agent-issue-writes/`,
  `docs/178-context-compaction/` — prior instances of the same bug class; the pattern this
  reuses. See also CLAUDE.md "Chat transcript content MUST be persisted, not just emitted".
