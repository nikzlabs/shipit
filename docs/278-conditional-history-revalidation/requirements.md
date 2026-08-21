---
title: Conditional history revalidation — requirements
description: A tab focus must not re-download the transcript when nothing changed; the refetch is validated, never skipped by hand.
---

# 278 — Conditional history revalidation: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

## Where these come from

This work implements **`planning#324`** ("Every tab focus refetches the whole chat
history — make the refetch conditional"), filed from the chat-history paging
design (`docs/241`), which cites the foreground refetch as its "refetch
amplifier": bounds how much a refetch costs, while `planning#324` bounds how
often the cost is paid at all. The issue body is the human's words; the
numbered requirements below preserve its two explicit "correct today, must
stay correct" behaviours and its one design subtlety as acceptance criteria.

## Requirements

1. Returning focus to a ShipIt tab does not re-download or re-parse the
   session's chat transcript when the transcript has not changed since the
   client last loaded it.
2. The WebSocket still reconnects unconditionally when the tab returns to the
   foreground. The reconnect is deliberate — a backgrounded mobile socket can
   read as healthy while dead — so no health check may gate it.
3. The client never skips a refetch on its own judgement. The skip is a
   server-validated conditional response (a 304), so transcript mutations that
   happened while the client was disconnected are always recovered: either the
   validator moved and the payload is served, or the server positively certifies
   the client's copy as current.
4. The validator reflects **content**, not shape: it moves on every write to the
   session's persisted transcript — appends, in-place card lifecycle patches,
   and full rewrites alike. It must not be computable as `MAX(id) + COUNT(*)`,
   which cannot see a row patched in place.
5. An unchanged response never clobbers or truncates the client's live
   transcript. In particular it preserves rows a running turn produced since
   the last persist.
6. A changed response behaves exactly as today: the client installs the fresh
   payload.

## Open questions

- The wire form of the validator (the issue says "a revision/ETag"). Closed in
  the design as a per-session counter served as the `x-history-revision` header,
  cooperating with — never replacing — the existing whole-payload ETag from
  `planning#375`; see the resolved receipt below.

## Resolved questions

- **2026-08-21 · validator shape — a per-session revision counter.** The issue
  names the straightforward version: a per-session counter bumped on every
  write. The design uses exactly that, persisted in SQLite so it survives an
  orchestrator restart, served to the client as `x-history-revision`, and
  echoed back on every refetch. `planning#268` wants the same primitive to
  invalidate a paging cursor after a history rewrite; this feature is that
  primitive's first consumer.
- **2026-08-21 · how the counter relates to the `planning#375` body-hash
  ETag.** The ETag (hash of the whole response body) stays, and stays
  authoritative for the response's seven payload sources — `docs/265` already
  reasoned that a composed stamp serving that payload can forget a source and
  serve stale data. The 304 therefore requires **both** validators to match:
  the counter proves the transcript did not move, the ETag proves the whole
  payload did not move, and for a well-behaved client the two always move
  together, so the conjunction costs nothing. (This is a benchmark assumption:
  the issue's letter says "send a revision/ETag and return 304 when the
  session's history is unchanged", and both halves of the conjunction deliver
  that with no staleness cliff for the non-transcript payload fields.)
- **2026-08-21 · benchmark constraints on the tracker.** This folder carries
  no `issue:` pointer and no tracker is touched: the work is part of a
  controlled four-session benchmark in which exactly one PR is opened per
  session and the tracker is off-limits to all of them. The PR body links
  `Refs planning#324` (never `Closes`); the issue remains the authoritative
  pointer for this work.