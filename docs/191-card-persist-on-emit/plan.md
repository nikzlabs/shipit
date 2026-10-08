---
issue: planning#107
description: emitChatCard persists the in-progress turn immediately, so every transcript card is in chat history the instant it appears — no disappear-then-reappear flicker.
---

# Card persistence happens on emit, not at the next boundary

## The bug

"Commented on issue" cards (and other side-channel transcript cards) sometimes
**disappeared and then reappeared a few seconds later**. Reported against the
issue-write provenance card, but it was a whole class.

## Root cause

`emitChatCard` (`chat-card-persistence.ts`) was the one supported way to add a
transcript card, but it only did two things: emit the live WS message and
*record* the card on the runner (`recordedCards`, anchored by `afterGroupIndex`).
The actual **write to chat history** was deferred — it happened later, when
`buildTurnMessages` ran at the next tool-result boundary (or `agent_result`).

Side-channel cards arrive off the agent-event stream via an HTTP relay (the agent
runs `shipit issue comment`, `report_shipit_bug`, `shipit session create`, a
review submit, a voice note). Between the relay emitting the card and the next
boundary, the card lived **only** in the live client array + `recordedCards` —
not in the DB. A `loadSessionHistory` in that window (any WS reconnect — mobile
bg/fg, a network blip, a ShipIt restart) replaced the live transcript with a DB
snapshot that lacked the card, so it vanished; a later boundary persisted it and
a subsequent reload/replay brought it back. Hence flicker.

Only the voice-note path was immune, because `agent-listeners.ts` had a
**separate, manual** `persistTurnInProgress` call right after delivering the
voice card. Every other side-channel card (issues read/write, bug-report,
reviews, session spawned/failed, compaction, in-turn notices) relied on the
deferred boundary persist and therefore had the window.

## Fix

Make the invariant **"a card appears ⇔ it is in session history"** hold the
instant the card fires, enforced by the single primitive:

- `emitChatCard` now does three things atomically — emit, record, **and persist
  the in-progress turn** (`persistTurnInProgress`) — and *requires* a persist
  context (`{ chatHistoryManager, sessionId }`). A card can no longer be emitted
  without being persisted; the type system enforces it.
- `buildTurnMessages` + `persistTurnInProgress` moved from `agent-listeners.ts`
  into `chat-card-persistence.ts` (their natural home — they share the
  `recordedCards` interleaving contract with `recordChatCard`), so `emitChatCard`
  can call the persist with **no import cycle**. `agent-listeners.ts` re-exports
  both for its existing importers (`send-message`, `dispatch-steering`,
  `agent-execution`, tests), so no import paths changed.
- The now-redundant manual eager-persist block for voice notes in
  `agent-listeners.ts` was removed — `routeVoiceNote` → `emitChatCard` persists
  on its own. `RouteVoiceNoteDeps` gained `chatHistoryManager`, threaded in at
  both wiring sites (`agent-execution.ts`, `runner-registry-factory.ts`).

Persisting eagerly is idempotent with the boundary persist: `replaceInProgress`
deletes all `in_progress` rows and re-inserts from the same `recordedCards`, so
re-running it at the boundary reproduces the identical set. Lifecycle transitions
(bug-report filed/failed, issue-write undone) still patch the persisted row in
place by `cardId`.

## A turn's rows are made final once (planning#645)

One agent attempt can end through more than one terminal event: an auth failure
and a result, an auth failure and a process error, a result and a process error
from the same death. Each terminal handler rebuilt the turn from the runner and
called `replaceInProgress` + `finalizeInProgress`. After the first one no row is
in progress, so the second deleted nothing and inserted every row again: each
card twice with the same id, and the partial assistant text twice.

`finalizeTurnRows` is now the single terminal write. It latches on
`runner.finalizedTurnEpoch === runner.turnEpoch`, and `resetRunnerTurnState`
bumps the epoch, so the latch re-arms for each turn. Once a turn's rows are
final, `persistTurnInProgress` writes nothing, `emitChatCard` appends the card
(as it does after the turn), and `persistCardTransition` patches the database
row. Every terminal site uses it: the listener's `agent_result` and `error`
paths, the auth handler, the executor's retry and fallback finalizes,
`onInterruptedTurn`, and turn adoption. The tool-result boundary goes through
`persistTurnInProgress`, so a late tool result cannot rebuild a final turn
either. The worker-loss rescue and the abandoned-turn handler keep their own
finalize (the abandoned turn's permission denial patched only the database row,
so a rebuild would restore it as pending) and set the latch with
`markTurnRowsFinalized`.

A failed sign-in heal settles the turn, and can start a queued turn, before the
auth handler writes its error. So the executor makes the failing turn's rows
final before it settles, and the auth handler only appends its error row when
a newer turn owns the runner.

Late assistant text after a result, in the same turn (Codex), is not saved on a
plain exit, and was not saved before this change either. Only an error after it
used to save it, as a second copy of the whole turn.

## Key files

- `chat-card-persistence.ts` — `emitChatCard` (now persists), `recordChatCard`,
  `buildTurnMessages`, `persistTurnInProgress`, `finalizeTurnRows`, `emitNoticeInTurn`,
  `emitNoticePostTurn`, the `CardPersistCtx` / `InProgressPersister` types.
- `ws-handlers/agent-listeners.ts` — re-exports the turn-rebuild helpers; the
  compaction card and in-turn notices pass the persist context; the manual
  voice-note eager persist is gone.
- `voice/voice-note-router.ts` — `RouteVoiceNoteDeps.chatHistoryManager`.
- HTTP relay call sites updated to pass the persist context:
  `api-routes-issues.ts` (read + write cards), `api-routes-bug-report.ts`,
  `api-routes-reviews.ts`, `api-routes-session.ts` (spawned + failed).

## Tests

- `chat-card-persistence.test.ts` — asserts `emitChatCard` persists in the same
  call (the core invariant), and `emitNoticeInTurn` likewise.
- `integration_tests/agent-issue-read-card.test.ts` — end-to-end regression: a
  `shipit issue comment` write card is present in `GET /history` immediately,
  with no tool-result boundary sent (the exact reported symptom).
- `voice-note-router.test.ts`, `ws-handlers/agent-listeners.test.ts`,
  `user-bug-filing.test.ts` updated for the new `emitChatCard` / `routeVoiceNote`
  contract.
- `integration_tests/turn-rows-finalized-once.test.ts` and the `finalizeTurnRows`
  block in `chat-card-persistence.test.ts` — planning#645: a turn that several
  terminal events end saves each card and each row once.

## Relation to the persistence rule

This strengthens the "Chat transcript content MUST be persisted, not just
emitted" rule in `CLAUDE.md`: the supported primitive no longer merely *records*
for later persistence — it persists now. The deferred-persist footgun is gone.
