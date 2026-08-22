---
issue: planning#467
title: A validated 304 on /history keeps the live transcript and still re-seeds cards
description: The 304 path re-installs the cached transcript over live rows; the install becomes conditional while the card seeds stay unconditional.
---

# A validated 304 keeps the live transcript, and still re-seeds cards

1. When `GET /api/sessions/:id/history` answers **304** and the in-memory message list is still the materialization of that cached payload, the list must be left unchanged: rows streamed live since the last load must not be replaced or dropped, even transiently.
2. When the in-memory message list has been cleared, reset, or detached from that payload (session switch, rewind restore, a fork or spawn that changed `sessionId` without clearing), a **304** must install the cached transcript exactly as it does today.
3. The four authoritative card re-seeds (bug-report docs/164, permission docs/193, egress-prompt docs/172, issue-write docs/177) must run on every history load — **200 and 304 alike**. The 304 is not a reason to skip them.
4. A **200** must install the transcript unconditionally, as it does today.

## Open questions

None — the benchmark brief (planning#467) forbids asking the user; every decision below is recorded as a benchmark assumption with its source.

## Resolved questions

- 2026-08-22 — **Q1: can the cached payload truncate the live transcript?** No lasting truncation window exists. The re-install transiently wipes live rows on both the 200 and the 304 path, but the attach-time `turn_snapshot` repairs the running turn by construction: it is sent unconditionally while the turn runs, covers everything up to the attach instant, and the `historyLoaded` gate guarantees it is applied after (never before) the history baseline. So the 304 re-install is redundant, transiently disruptive, and expensive — never a lasting loss. Source: the verification chain recorded in plan.md. (Benchmark assumption — the brief directed "if what you find contradicts the issue's framing, say so in your design doc and follow the code rather than the issue.")
- 2026-08-22 — **Q2: what does the card re-seed protect against?** The attach-time turn-event-buffer replay re-delivers buffered card events, which the client turns into draft-phase entries via non-clobbering `upsertCard`, dispatched immediately (not gated behind `historyLoaded`). The seeds are the authoritative overwrite that repairs the replay-first ordering. The transcript being unchanged (304) says nothing about what the replay wrote, so the seeds must run on every load; the protection needs only the card fields, which the fix keeps reading from the cached payload on the 304 path (already in memory — no re-download, no re-parse). Source: verified at the four store files and `route-registry.ts:1112-1139`, per plan.md. (Benchmark assumption — the brief's constraint forbids skipping the seeds; this receipts why that constraint is correct.)
- 2026-08-22 — **How does the client know the in-memory list is still the cached payload's materialization?** A baseline marker in the session store (`historyBaseline`), set by `loadSessionHistory` whenever it installs, and cleared automatically by `setMessages` on every wholesale (plain-array) replace and by `reset()`. Functional updates preserve it, which is exactly right: appends and in-place edits refine the same transcript. A 304 skips the install only when the marker names the same session and the same ETag. (Benchmark assumption — the mechanism was not specified by the brief; this is the smallest one that satisfies req 1–4 without the unsafe "non-empty means current" heuristic, which misreads the fork/rewind paths that change `sessionId` without clearing messages.)
