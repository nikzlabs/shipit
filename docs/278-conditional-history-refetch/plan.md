---
issue: planning#324
title: Conditional history refetch — design
description: A per-session transcript revision, composed into the /history ETag, so an unchanged refetch costs one indexed row read.
---

# 278 — Conditional history refetch: design

Implements [`requirements.md`](./requirements.md). Requirements are cited as `(req N)`.

## The path being fixed

Four listeners (`visibilitychange`, `pageshow`, `focus`, `online`) feed
`useForegroundSignal`, which force-reconnects the session WebSocket when the tab returns to
the foreground. The reconnect is deliberate and stays (req 5): mobile OSes kill or stall a
backgrounded socket without telling the JS layer, so `readyState` can read `OPEN` on a dead
one — verified at `useWebSocket.ts` (`reconnectForForeground` and the comment above
`useForegroundSignal`).

The new socket drives `status` through `connecting`/`closed`, which resets `historyLoadedRef`
in `useConnectionSync`; on `open` it calls `loadSessionHistory`, which issues
`GET /api/sessions/:id/history` and `setMessages`-replaces the transcript.

So: focus the tab, and the transcript is fetched again.

## What was already true, and what was not

`planning#375` (docs/265) landed the client half and an ETag over the response body:
`loadSessionHistory` caches the parsed payload per session (LRU, 6 entries), sends
`If-None-Match`, and on a `304` re-applies the cached object — no transfer and no
`JSON.parse`. Verified at `session-data.ts` (`historyCache`, `remember`, `touch`) and pinned
by `session-data.test.ts` → *"revalidates instead of re-downloading"*. **Requirements 1 and 3
were therefore already met, and the client needs no change.**

What was not met is **req 2**. The tag was a hash of the body, so producing it meant loading
every row of the session, decoding ~44 JSON columns per row through `fromRow`, running the
wire projection, `JSON.stringify`ing megabytes and hashing them — the entire cost of a
change, paid to report the absence of one, on every alt-tab and every session switch, for
every attached viewer. That is also exactly the cost that grows with the conversation
(req 4).

## The design

### A per-session transcript revision

`transcript_revisions (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)`, incremented
by three `AFTER INSERT / UPDATE / DELETE` triggers on `messages` (migration at the end of
`database.ts`). `ChatHistoryManager.transcriptRevision(sessionId)` reads it; a session with
no messages reads 0.

**Triggers rather than a bump in `ChatHistoryManager` (req 7).** The writes are spread over
~20 methods of that class, several ad-hoc `db.prepare(...)` statements inside it, and a
`DELETE FROM messages` in `DatabaseManager.clearAll`. A TypeScript-side bump is one
forgotten call site away from serving a stale transcript, and the failure is silent: the
client is told nothing changed, keeps what it has, and the change stays invisible until
something unrelated moves the counter. Attached to the table, the counter cannot be missed —
including by paths written after this one and by raw SQL that never goes near the manager.

**A counter rather than `MAX(id)` + `COUNT(*)` (req 8).** `updateBugReportCard`,
`updatePermissionCard`, `updateEgressPromptCard`, `updateIssueWriteCard`,
`updateSubAgentConsultCard`, `updateNonTurnFailureCard` and `upsertReleaseCard` all patch a
row in place through `stmtUpdate` with the row's existing id, so the row count and the
largest id are both unchanged while the content is not. `retireBackgroundSubagentResult`
does the same to a tool result. The `UPDATE` trigger is what covers them.

Revision rows outlive a session's messages on purpose: a transcript that is deleted and
written again must not reuse a revision a client already holds. `clearAll` empties the table
**after** the messages delete — before it, the delete's own triggers would put every row
straight back.

### A composed validator

`GET /history` now builds everything except the transcript, and hashes:

```ts
etagFor(JSON.stringify([sessionId, transcriptRevision, rest]))
```

where `rest` is the six non-transcript sources (git log, `agentRunning`, background tasks,
rewind snapshot, usage, presentations). If `If-None-Match` matches, the route answers `304`
**before** `getChatHistory` is called — the transcript is never materialized (req 2). Only a
request that will actually send a body pays for one.

This is sound because `messages` is a pure function of the session id and the revision:
`projectMessagesForWire` on the history path derives everything from the rows it is handed
(verified at `transcript-projection.ts` — the image `src` is content-addressed from the row's
own bytes). The six other sources are still hashed directly, so the tag never speaks for a
source it did not read (req 3).

The `304` also carries the tag, per RFC 9110 §15.4.5. The client keeps the tag it sent
either way; this is for the intermediaries.

### Deliberately not done

- **No client change.** The conditional request, the per-session cache and the `304` handling
  already exist and are tested. A second mechanism beside them would be the stale one.
- **The git log still runs on the unchanged path.** It is a subprocess, and the next thing
  worth measuring, but it is bounded (50 commits) and does not grow with the conversation,
  which is the axis req 4 names. Left alone.

## Relationship to planning#268 (windowed loading)

Independent and complementary: `planning#268` bounds what a refetch costs, this bounds how
often it is paid. The revision is also the primitive `planning#268` needs to invalidate a
paging cursor after a history rewrite — a rewrite moves it, which is precisely the signal a
cursor cannot get from `MAX(id)`.

## Key files

| File | Role |
|---|---|
| `src/server/shared/database.ts` | `transcript_revisions` + the three triggers; `clearAll` ordering |
| `src/server/orchestrator/chat-history.ts` | `transcriptRevision(sessionId)` |
| `src/server/orchestrator/api-routes-session-spawn.ts` | the composed validator; `304` before the transcript is read |
| `src/server/orchestrator/http-etag.ts` | unchanged — weak comparison, for the CDN |
| `src/client/utils/session-data.ts` | unchanged — sends `If-None-Match`, reuses the cached payload on `304` |

## Tests

- `chat-history.test.ts` → *"transcript revision (planning#324)"* — a case per mutating
  method (21 of them), plus the explicit `MAX(id)`/`COUNT(*)`-unchanged case, session
  scoping, durability, and no-rewind-after-delete. Dropping the `UPDATE` trigger fails 14 of
  them.
- `database.test.ts` → *"transcript revision triggers"* — raw SQL moves the counter, and
  `clearAll` empties the table instead of resurrecting it.
- `integration_tests/history-conditional-refetch.test.ts` — the route over the real
  orchestrator: `304` on an unchanged repeat, a fresh body after an in-place card patch and
  after a same-length rewrite (both of which a `MAX(id)` + `COUNT(*)` validator answers `304`
  to — verified by swapping it in), a fresh body when a non-transcript source changes, and
  `ChatHistoryManager.load` never called on the `304` path.
