---
issue: planning#324
title: Conditional history refetch
description: Make the tab-focus transcript refetch conditional on a per-session revision, so an unchanged transcript costs a 304 instead of a rebuild.
---

# Requirements — conditional history refetch

Human-owned. Numbered statements are what the feature must do, in observable
terms, taken from planning#324. Design lives in `plan.md`.

## Requirements

1. Returning focus to a ShipIt tab must not re-download or re-parse the chat
   transcript when the session's persisted history has not changed since the
   client last loaded it. The refetch becomes a validated conditional request
   that answers `304` for the unchanged case.
2. The WebSocket still reconnects **unconditionally** on foreground. Mobile
   OSes kill backgrounded sockets without telling the JS layer, so `readyState`
   lies; the reconnect must not gain a health check. Only the history payload
   is elided.
3. The refetch must never be **blind-skipped**. The turn-event buffer is
   cleared at the next turn start, so HTTP history is the only path that
   recovers transcript mutations that happened while the client was
   disconnected. Elision is allowed only when the server has positively
   validated "unchanged".
4. The server-side validator moves on **every** write to a session's persisted
   transcript — appends, in-place row updates (the card lifecycle patches:
   `updateBugReportCard`, `updatePermissionCard`, `updateEgressPromptCard`,
   `updateIssueWriteCard`, `upsertReleaseCard`), and full rewrites via
   `saveMessages` alike.
5. The validator must **not** be computed as `MAX(id)` + `COUNT(*)`: the
   in-place patches in req 4 change neither while the content changes. A
   per-session revision counter bumped on every write is the required shape.
6. The unchanged path must never leave the client with a stale or truncated
   transcript.
7. The revision counter is a reusable primitive: planning#268 (windowed
   history loading) needs the same counter to invalidate a paging cursor after
   a history rewrite.

## Open questions

(none)

## Resolved questions

- 2026-08-21 — **How does the revision compose with the body-hash ETag that
  planning#375 shipped after this issue was filed?** Benchmark assumption (no
  human available): the validator is now two-part —
  `composedEtag(revision, sha1(rest))`. The revision speaks for the messages
  (so a `304` no longer loads, projects, or serializes a single transcript
  row), and the non-transcript remainder (commits, agentRunning,
  backgroundTasks, rewindSnapshot, usage, presentations) keeps planning#375's
  hash-of-exactly-what-is-sent property. A revision-only tag was rejected: it
  would serve those six independently-changing sources stale from the client's
  cache on `304`, a regression planning#375's route comment explicitly warns
  about, and every future payload field would silently join the stale set.
- 2026-08-21 — **Manual bumps in each `ChatHistoryManager` method, or
  triggers?** Benchmark assumption: row-level SQLite triggers on `messages`
  (AFTER INSERT / UPDATE / DELETE). The manager has ~20 mutating methods and
  more will come; one forgotten bump is a silent stale 304. A trigger cannot
  be forgotten — it also covers `DatabaseManager.clearAll()` and any raw SQL.
  A test pins that a write bypassing the manager still moves the counter.
- 2026-08-21 — **Does the counter reset when a session's history is deleted?**
  Benchmark assumption: no. The `history_revisions` row deliberately outlives
  `delete(sessionId)` so the counter is monotonic for the life of the
  database. A counter that re-counts from zero after delete + rewrite could
  revisit a value an old client still holds, and a validator that repeats a
  value can serve a stale 304 for it (ABA). `clearAll()` (full reset) is the
  one exception — it erases every session id forever.
- 2026-08-21 — **Client-side work?** Benchmark assumption: none needed. The
  planning#375 client already sends `If-None-Match`, applies the cached
  parsed payload on `304` (LRU-bounded, per-session), and its supersede/abort
  guards prevent clobbering; the tag is opaque to it, so the server-side
  change of tag composition is invisible. Kept as-is and covered by the
  existing `session-data.test.ts` suite (reqs 1, 6).
