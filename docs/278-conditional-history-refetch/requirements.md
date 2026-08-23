---
issue: planning#324
title: Conditional history refetch — requirements
description: Returning focus to a tab must not re-download or re-derive a chat transcript that has not changed.
---

# 278 — Conditional history refetch: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

## Where these come from

`planning#324`, in the reporter's words: *"Returning focus to a ShipIt tab re-downloads and
re-parses the entire chat transcript, even when nothing changed and the connection was
healthy … On a long session that is exactly the cost planning#268 is about, paid again on
every alt-tab."*

Requirements 1–4 restate that report. Requirements 5–7 are the behaviours the issue names as
correct today and asks to keep. Requirement 8 is the subtlety it asks the design to survive.

## Requirements

1. Returning focus to a tab must not re-download the chat transcript when that session's
   transcript has not changed since the client last loaded it.

2. Nor must the server re-derive it. Answering "nothing changed" must not cost the work of
   answering "here is everything" — the transcript must not be read, decoded and hashed
   just to discover it is the same.

3. What the user sees after a refetch — elided or not — must match what the server holds.
   No stale transcript, no truncated one, no lost tail of a running turn.

4. The saving must hold for a long session, which is the case that hurts. It must not
   depend on the conversation being short.

5. The WebSocket still reconnects unconditionally on foreground. A backgrounded socket can
   read `OPEN` while being dead, so a health check cannot be trusted; only the history
   payload is elided, never the reconnect.

6. The refetch must stay a **validated** conditional request, never "skip it if we already
   have history". The turn-event buffer is cleared at the next turn start, so events from
   completed prior turns are not replayable and the database is the only copy of them.

7. Every write that changes a session's persisted transcript must be visible to the
   validator: appends, in-place card patches, and full rewrites alike.

8. The validator must not be derived from the largest message id and the row count. Card
   lifecycle transitions patch a row in place, so both are unchanged while the content is
   not.

## Open questions

*(none)*

## Resolved questions

- **2026-08-21 — Replace the existing body-hash ETag, or compose with it?** *(benchmark
  assumption — recorded here rather than asked, per the rules this session runs under.)*

  The issue proposes "send a revision/ETag and return `304`", written before `planning#375`
  landed an ETag over the response body. That ETag already meets requirements 1 and 3; what
  it does not meet is requirement 2, because hashing the body means building the body.

  Replacing it outright with a transcript revision would meet requirement 2 and **break
  requirement 3**: `GET /history` carries six things besides the transcript (git log, runner
  state, background tasks, usage, presentations, rewind snapshot), and a stamp that speaks
  for a source it does not read leaves that source permanently stale for a client that never
  receives a fresh body.

  **Chosen: compose.** The transcript — the expensive part, and the only part whose cost
  grows with the session — contributes a per-session revision; the other six contribute
  themselves, hashed as before. Cheap where cost grows, exact everywhere else.

- **2026-08-21 — Where does the revision live: `ChatHistoryManager`, or the schema?**
  *(benchmark assumption.)* Requirement 7 covers roughly twenty methods plus several ad-hoc
  statements and a `DELETE FROM messages` outside that class. A bump in TypeScript is one
  forgotten call site away from a silently stale transcript. **Chosen: three triggers on the
  `messages` table**, so the counter moves for any path that writes a row — including paths
  written after this one.
