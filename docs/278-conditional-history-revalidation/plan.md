---
title: Conditional history revalidation — design
description: A persisted per-session transcript revision gates the /history refetch; 304 never clobbers a live transcript.
---

# 278 — Conditional history revalidation: design

Implements [`requirements.md`](./requirements.md). Requirements are cited as `(req N)`.

## The problem, restated

Four foreground listeners — `visibilitychange`, `pageshow`, `focus`, `online` —
drive `useForegroundSignal` → `reconnectForForeground` (`useWebSocket.ts`),
which opens a fresh socket unconditionally (req 2 — the socket can lie about
being healthy, so no readyState gate is added). The fresh socket drives the WS
status through `closed`/`connecting`, which lowers `historyLoaded`
(`useConnectionSync.ts`), and the next open re-runs `loadSessionHistory` — a
full `GET /history` (**the refetch amplifier** the issue describes).

`planning#375` (`docs/265`) already made that GET conditional on a
whole-payload body-hash ETag, which elides the transfer and the parse when the
**entire** payload is byte-identical. This feature adds the transcript's own
validator — a per-session write counter — so the refetch is conditional on the
transcript specifically (reqs 1, 3, 4), and, on a validated-unchanged answer,
leaves the client's live transcript literally untouched (req 5).

## The primitive: a per-session transcript revision

**Storage.** New SQLite table `session_history_revision (session_id TEXT
PRIMARY KEY, revision INTEGER NOT NULL)`, created by an appended migration
(`database.ts`). One row per session, one monotonic integer. A session with no
row reads as revision `0` — never written. Persisted, so it survives an
orchestrator restart the way the transcript itself does (req 4's validator must
not reset on reboot, or every refetch after a restart would re-download).

**Who bumps it.** `ChatHistoryManager` owns every write to the `messages`
table — no other module writes it — so the bump lives on the manager, inside
each mutating method's `db.transaction`, committing atomically with the write
it stamps:

- **appends** — `append` (now transactional: insert + bump), the append branch
  of `upsertReleaseCard`;
- **in-place patches** — `updateBugReportCard`, `updatePermissionCard`,
  `updateEgressPromptCard`, `updateIssueWriteCard`, `updateSubAgentConsultCard`,
  `updateNonTurnFailureCard`, `updateLastMessage`,
  `retireBackgroundSubagentResult`, `consumeUnreportedBugOutcomes`, the patch
  branch of `upsertReleaseCard` — every one of these rewrites a row that keeps
  its `id`, so `MAX(id) + COUNT(*)` cannot see them (req 4);
- **full rewrites** — `saveMessages`, `replaceInProgress` (the delete-and-
  reinsert cycle at every tool-result boundary), `finalizeInProgress` and
  `clearInProgress` (the served `inProgress` flag flips), `truncate`, `delete`,
  `deleteMessageById`, `markRolledBackFromIndex`, `clearRolledBack`.

A no-op call (a patch that matches no card, a delete that deletes nothing) does
not bump — nothing changed, and an unchanged counter is the correct answer for
an unchanged transcript. Methods that might have written, even when their batch
is empty (`replaceInProgress`, `finalizeInProgress`, `clearInProgress`), always
bump: an over-bump only costs an elision, an under-bump serves stale rows.
`getHistoryRevision` is a one-row read; `bumpHistoryRevision` is an
`INSERT … ON CONFLICT … DO UPDATE SET revision = revision + 1`.

## The conditional route

`GET /api/sessions/:id/history` (`api-routes-session-spawn.ts`):

1. reads `revision = chatHistoryManager.getHistoryRevision(id)` and the
   client's `x-history-revision` header;
2. assembles the payload and the body-hash ETag exactly as `planning#375` did;
3. answers **304 only when both validators match**: the client's revision
   equals the current one (the transcript did not move, reqs 3–4) AND
   `If-None-Match` matches the body hash (the whole multi-source payload did
   not move — see the receipt in `requirements.md`);
4. every response — 200 and 304 — carries `x-history-revision`, so the client
   can cache the validator it loaded under and refresh it on a revalidation.

## The client

`loadSessionHistory` (`session-data.ts`):

1. the per-session cache entry grows a `revision` field alongside `etag`,
   taken from the response's `x-history-revision`;
2. a warm refetch sends `If-None-Match` **and** `X-History-Revision` (req 1);
3. on **304**: the cache is touched, the stored revision is refreshed from the
   response header, and — the new half — the transcript is handled without
   clobbering (req 5):
   - a transcript already holding rows is **left alone**: no `setMessages`, no
     card-store re-seeds. The live array is a superset of the validated-unchanged
     cache (it carries what a running turn produced since its last persist), so
     reinstalling the cache would truncate exactly what the refetch exists to
     preserve;
   - an **empty** transcript still materializes from the cache — the session-
     switch case, where nothing of this session's is on screen yet and the 304
     is the server's certificate that the cache is current;
4. on **200**: the fresh payload installs as today (req 6), and the cache
   entry's `etag`/`revision` are replaced.

The two behaviours the issue says are correct today are untouched:
`useWebSocket.ts` is not modified (req 2), and there is no client-side "skip
because we already have history" branch — a skip happens only under a
server-validated 304 (req 3).

## Key files

| File | Role |
|------|------|
| `src/server/shared/database.ts` | `session_history_revision` migration; wiped in `clearAll` |
| `src/server/orchestrator/chat-history.ts` | `getHistoryRevision` / `bumpHistoryRevision`; a bump in every mutating method |
| `src/server/orchestrator/api-routes-session-spawn.ts` | 304 requires revision + etag; `x-history-revision` on 200 and 304 |
| `src/client/utils/session-data.ts` | cache entries carry the revision; client sends it; 304 no-clobber rule |

## Tests

- `chat-history.test.ts` — "per-session transcript revision": every mutating
  method moves the counter (a future writer that forgets its bump fails the
  suite by name), a no-op does not, sessions are isolated, the revision is
  DB-backed, and the `MAX(id)+COUNT(*)` trap is pinned: an in-place card patch
  leaves the row ids and count identical while the revision moves.
- `http-phase3.test.ts` — the route contract: 304 needs both validators, a
  stale or missing revision refuses the 304, a same-content `saveMessages`
  rewrite answers 200 under the pre-rewrite revision even though the ETag still
  matches, the revision is per-payload on 200 and 304.
- `session-data.test.ts` — the client sends `X-History-Revision` on a warm
  refetch; a validated-unchanged 304 keeps a live row the server has not
  persisted; it materializes from the cache when the store is empty; a 200
  still replaces the transcript.