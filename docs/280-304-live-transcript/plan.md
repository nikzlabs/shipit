---
issue: planning#467
title: A validated 304 on /history keeps the live transcript and still re-seeds cards
---

# Plan — conditional transcript install on a validated 304

Implements [requirements.md](./requirements.md) (req 1–4).

## The two questions, answered at the source

### Q1 — can the cached payload truncate the live transcript?

The mechanism the issue names is real: `loadSessionHistory` (`src/client/utils/session-data.ts:336-341`) replaces the whole in-memory `messages` array with the served payload on both a 200 and a 304. The in-memory array is a superset of the persisted rows — live rows streamed since the last persist boundary — so the replace wipes them for at least a render.

What the issue's framing overstates is that this is a *loss*. No lasting truncation window exists, because the attach-time `turn_snapshot` repairs the running turn by construction, and every step of that construction is verified:

1. **The snapshot is sent whenever it is needed.** On attach, while `runner.running`, the server sends `turn_snapshot` built from `runner.chatMessageGroups` via `projectTurnSnapshotForWire` (`src/server/orchestrator/route-registry.ts:1070-1094`), which strips committed heavy bodies but keeps all rows (`src/server/orchestrator/transcript-projection.ts:733-742`, `allRowsPersisted: false`). It covers everything up to the attach instant — including rows the history payload does not have.
2. **The client repairs with it.** `handleTurnSnapshot` replaces the in-progress rows with the snapshot (`src/client/hooks/message-handlers/turn-snapshot.ts:51`). The in-progress marking comes from the persisted rows themselves (`src/server/orchestrator/chat-history.ts:669,722`).
3. **The ordering is guaranteed, not incidental.** `historyLoaded` is reset to false on every disconnect (`src/client/hooks/useConnectionSync.ts:203`) and every session switch (`src/client/stores/actions/session-actions.ts:105`). `useMessageHandler` queues `turn_snapshot` while `!historyLoaded` and flushes only after it flips (`src/client/hooks/useMessageHandler.ts:73-79,43-50`). `loadSessionHistory` runs `setMessages` before `setHistoryLoaded(true)` with no await between (`session-data.ts:336` vs `425`), so a snapshot can never be dispatched against a pre-baseline transcript.
4. **When the turn is not running, there is nothing to truncate.** No snapshot is sent, but a finished turn was persisted, and the 304 itself is the server's positive statement that the payload is unchanged (`session-data.ts:201-206`) — if a turn had finished mid-disconnect the server would have answered 200.
5. **The buffer replay is not a second restorer.** `agent_event` is deliberately skipped in the replay (`route-registry.ts:1113`); the replay's job is the non-transcript signals.

So the 304 re-install is redundant, transiently disruptive (the live tail visibly vanishes for a render before the snapshot restores it), and expensive (re-materializing thousands of message objects for nothing). The fix targets that, not a loss.

### Q2 — what does the card re-seed protect against?

The replay re-delivers buffered turn events from `lastPersistedBufferIndex`, skipping `agent_event`, `turn_snapshot`, `log_append`, terminal types, and `background_tasks` — but **not** the card events (`route-registry.ts:1112-1139`). The replayed card events reach the client handlers, which create draft-phase entries through non-clobbering `upsertCard` (`src/client/stores/bug-report-store.ts:66-70`, `permission-store.ts:53-58`, `egress-prompt-store.ts`, `issue-write-store.ts`) — dispatched immediately, because only the three agent-message types are gated behind `historyLoaded`.

The seeds are the authoritative correction for the replay-first ordering: `seedCards` overwrites by id with the persisted phase (`bug-report-store.ts:71-76` and siblings). The 304 says the *transcript* is unchanged; it says nothing about what a replay wrote into the card stores, and the replay happens on every attach independently of the history response. Skipping the seeds on a 304 re-opens the filed-card-comes-back-editable bug class — exactly what closed PR #2536 did wrong.

The protection needs **only the card fields**. The seeds extract `bugReport` / `permissionPrompt` / `egressPrompt` / `issueWrite` from the payload messages (`session-data.ts:348-388`) and use nothing else. On the 304 path the full payload is already in memory (`cached.data` — no re-download, no re-parse), so the seeds keep reading it; what they must not do is ride the transcript install's condition.

## The fix: different conditions for the install and the seeds

Per the brief's constraint, the two get different conditions:

- **Card seeds (and every other apply step): unchanged on both paths.** The 304 path keeps running them unconditionally, exactly as today.
- **The transcript install becomes conditional on the 304 path only.** A 200 always installs (req 4). A 304 installs unless the in-memory array is provably still the cached payload's materialization (req 1, 2).

The proof is a **baseline marker**, `historyBaseline: { sessionId: string; etag: string | undefined } | null`, added to the session store (`src/client/stores/session-store.ts`):

- Set by `loadSessionHistory` whenever it installs (both paths).
- Cleared automatically inside `setMessages` whenever it receives a **plain array** — every wholesale replace (`resumeSessionInternal`'s `setMessages([])`, rewind-complete's replace, future ones) detaches the array from its baseline with no call-site coordination. Functional updates (appends, in-place edits) preserve the marker — correct, they refine the same transcript.
- Included in `initialResettableState`, so `reset()` clears it too.

The 304 skip condition: `marker !== null && marker.sessionId === sessionId && marker.etag === cached.etag`. ETag equality is sufficient per the server contract (`session-data.ts:201-206`: a 304 is the server's positive statement that the tagged payload is current). The `sessionId` comparison is load-bearing, not defensive: ETag strings are per-session stamps that can collide across sessions, and the fork/spawn/rewind paths change `sessionId` **without** clearing messages (`session-forked.ts:13`, `rewind-restored.ts:11-18`, `SpawnedSessionCard.tsx` — `setSessionId` then navigate, which makes `useSessionActivation`'s resume check a no-op). Without it, a 304 for the incoming session could skip the install against the outgoing session's baseline.

### Why the store marker, not "non-empty means current"

The closed PR's heuristic ("skip the 304 install iff messages is non-empty") fails on every path that changes `sessionId` without clearing messages — the incoming session's 304 would leave the *outgoing* session's transcript on screen. The marker compares identity (session + ETag), not emptiness.

### Why not fix it server-side

The server cannot know whether the client's in-memory array is still the payload it validated — that is client-render state. The 304 protocol already answers the part the server owns (is the payload current).

## Key files

- `src/client/utils/session-data.ts` — `loadSessionHistory`: tracks `etag`/`fromCache`, conditional install.
- `src/client/stores/session-store.ts` — `historyBaseline` field + `setHistoryBaseline` action; `setMessages` clears the marker on plain-array replaces; `initialResettableState`.
- `src/client/utils/session-data.test.ts` — new describe block (below).

## Tests

Co-located in `session-data.test.ts`, extending the existing "revalidates instead of re-downloading" conventions:

1. A 304 with live rows appended does not replace the list (fails on current code).
2. A 304 after `setMessages([])` still materializes from the cache (already pinned by the existing test at line 563; kept green).
3. A 304 after a fork-style `setSessionId` (same ETag string for both sessions) still installs — pins the marker's `sessionId` comparison.
4. A 304 still re-seeds the card stores: a replay-created draft is overwritten by the persisted phase, and the live rows stay (fails against the closed-PR approach; guards the constraint).
5. `reset()` clears the marker, so a subsequent 304 installs.

## Verification

- Red→green: with the pre-change `session-data.ts` restored from git, tests 1 and 4 fail on the truncation assertions; with the fix, all 5 pass. `npm run test:dev`, `npm run typecheck`, `npm run lint:dev` all green.
- Runtime, against the real system (dogfood inner instance, local mode, real GLM turn): an open page ran a long streaming turn while its WebSocket was force-closed 8 times. Every reconnect rehydrated via `GET /history`; six reconnects got a **304** mid-stream. A zustand subscription on the live store recorded `messages.length` decreases only after the **200** responses (two transient installs, the designed req-4 path, repaired by the attach snapshot); **no 304 was followed by any truncation**, and the transcript completed intact. The live store's `historyBaseline` matched each installed payload's ETag throughout.
