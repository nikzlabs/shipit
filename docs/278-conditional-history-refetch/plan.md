---
issue: planning#324
title: Conditional history refetch — design
description: A trigger-maintained per-session revision counter as the transcript's validator, composed with a hash of the rest of the /history payload.
---

# 278 — Conditional history refetch: design

Implements [`requirements.md`](./requirements.md). Fixes planning#324.

## The problem

Re-foregrounding a tab deliberately reconnects the WebSocket
(`useWebSocket.ts` — backgrounded sockets die silently, so `readyState` cannot
be trusted; req 2), which resets `historyLoaded` and drives a full
`GET /api/sessions/:id/history`. planning#375 made that refetch conditional at
the *transfer* level: the client sends `If-None-Match` and a `304` skips the
download and the parse. But the tag was `sha1(body)`, so the server still
**built the whole body** — loaded every message row, ran the docs/244 wire
projection, and serialized megabytes — on every alt-tab, purely to discover
nothing changed.

## The mechanism

### A per-session revision counter, maintained by triggers (reqs 4, 5)

Migration in `database.ts`:

- `history_revisions (session_id TEXT PRIMARY KEY, revision INTEGER)`.
- Three row-level triggers on `messages` (AFTER INSERT / AFTER UPDATE /
  AFTER DELETE), each `INSERT OR IGNORE` the session's row and `UPDATE
  revision = revision + 1`.

Triggers rather than per-method bumps because the property that matters is
"no write path can miss it". `ChatHistoryManager` has ~20 mutating methods —
appends, the in-place card patches that change neither `MAX(id)` nor
`COUNT(*)` (req 5), `saveMessages` rewrites, finalize/clear sweeps, raw
deletes — and the trigger covers all of them, plus `clearAll()`, plus any
method added later, by construction. A value-identical `UPDATE` still fires
the trigger: a false invalidation costs one extra 200; the reverse direction
(a missed write) would be a stale 304, which is the failure req 6 forbids.

Monotonicity is load-bearing: equal revision ⇒ zero writes happened ⇒ the
persisted transcript is identical. So the counter never resets while the
database lives — the `history_revisions` row survives
`ChatHistoryManager.delete(sessionId)` on purpose (ABA; see
`requirements.md` resolved questions). `DatabaseManager.clearAll()` clears the
table *after* the messages delete (the triggers re-create rows during it).

Read path: `ChatHistoryManager.revision(sessionId)` — one indexed SELECT,
`0` for a never-written session. planning#268's paging-cursor invalidation is
expected to consume this same accessor (req 7).

### The two-part validator (reqs 1, 3, 6)

`GET /api/sessions/:id/history` (`api-routes-session-spawn.ts`) now:

1. Reads the revision **before anything touches message rows** — a write
   landing mid-request then makes the served body *newer* than the tag (one
   redundant 200 later), never the tag newer than the body (a stale 304).
2. Builds `rest` — everything in the payload except `messages`: commits,
   `agentRunning`, `backgroundTasks`, `rewindSnapshot`, usage, presentations.
3. Computes `composedEtag(revision, JSON.stringify(rest))` (`http-etag.ts`)
   and compares via the existing weak `matchesIfNoneMatch` (the Cloudflare
   `W/"…"` round trip from planning#375 is unchanged).
4. On match: `304` — **no message row is read, projected, or serialized**.
5. On miss: load + project the messages and send `{ messages, ...rest }` —
   the hashed object *is* the sent object, so the remainder half keeps
   planning#375's "cannot forget a source" property; the messages half is the
   revision's statement, sound because the docs/244 wire projection is a pure
   function of the rows.

The client is untouched (req 6): the tag is opaque, and the planning#375
cache — `If-None-Match`, apply-parsed-cache-on-304, LRU, supersede/abort
guards — already is the conditional client. The WS foreground reconnect is
untouched (req 2).

## Key files

- `src/server/shared/database.ts` — migration (table + triggers), `clearAll`.
- `src/server/orchestrator/chat-history.ts` — `revision(sessionId)`.
- `src/server/orchestrator/http-etag.ts` — `composedEtag`.
- `src/server/orchestrator/api-routes-session-spawn.ts` — the `/history` route.
- `src/client/utils/session-data.ts` — unchanged; the conditional client
  (planning#375) this feature serves.

## Tests

- `chat-history.test.ts` — "transcript revision (planning#324)": every
  mutation path moves the counter; the five issue-named in-place patchers (+
  `updateLastMessage`, `consumeUnreportedBugOutcomes`) do so while `MAX(id)`
  and `COUNT(*)` stand still; rewrites, in-progress lifecycle, truncate /
  delete / rollback marking; reads don't move it; per-session isolation; no
  ABA across delete + rewrite; a raw SQL write bypassing the manager still
  moves it (the by-construction guarantee).
- `integration_tests/http-phase3.test.ts` — 304 for unchanged (incl. the
  CDN-weakened form); fresh 200 across an append, across an **in-place card
  patch**, and across a **non-transcript** change (rewind snapshot); a 304 is
  answered **without a single `load()` call**.
- `http-etag.test.ts` — `composedEtag` stability, sensitivity to both halves,
  weak-comparison round trip.
