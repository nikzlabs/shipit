---
issue: https://linear.app/shipit-ai/issue/SHI-118
title: Async notify-on-merge watch for spawned child sessions
description: A parent session arms a watch and is woken by a queued system turn when a spawned child's PR merges (or closes), without blocking a turn on human-review latency.
---

# Notify-on-merge (`shipit session notify-on-merge`)

## Problem

A parent session that spawns a child for foundation work it depends on has no
way to resume automatically once the child's PR **merges**. `shipit session wait`
only blocks until the child's *agent turn* goes idle (code written / PR opened),
capped at 1 hour — it does **not** wait on a merge, and blocking an agent turn on
a human merge (which can take days) is the wrong model.

## Model — event-driven, not a blocking wait

`shipit session notify-on-merge <child-id>`:

1. The parent agent calls it; the orchestrator **registers a persisted watch** on
   the child session row, the command returns `0` ("armed"), and the parent's
   turn ends. **Non-blocking.**
2. The PR poller (`pr-status-poller.ts`) already detects PR terminal states. When
   the watched child's PR transitions to **merged** (or **closed-without-merge**),
   the watch fires.
3. Firing = **enqueue a system-originated turn into the PARENT's message queue**
   (the same per-session queue `shipit session message` uses) + **surface a
   persisted merge card** in the parent's transcript immediately.

This is the async primitive only. A blocking `wait --until merged` is explicitly
out of scope.

## Watch state machine

The watch is persisted on the **child** session row (`SessionMergeWatch`, keyed
by the child id; the registering parent is recorded in `parentSessionId`). Stored
on the child because PR-terminal detection is keyed by the child's session id, so
the poller has the child in scope at fire time.

```
armed ──merge observed──▶ merge-observed ──wake-turn enqueued──▶ delivered   (terminal)
  │
  └──PR closed unmerged──▶ closed-unmerged                                    (terminal)
```

- **`armed`** — registered, waiting. The child's PR need not exist yet.
- **`merge-observed`** — the poller saw the merge and surfaced the card, but the
  actionable wake-turn hasn't been enqueued yet. A transient step: if enqueue
  can't complete (parent container boot failure), the watch stays here and a
  later poll / the startup reconcile retries it.
- **`delivered`** — the merge wake-turn was enqueued. Terminal, **fire-once**.
- **`closed-unmerged`** — the PR closed without merging; a *distinct* wake-turn
  was enqueued so the parent doesn't proceed as if the work shipped. Terminal.

The `delivered` / `closed-unmerged` terminal states are the fire-once guard: a
re-poll or a restart re-observation is a no-op.

## Correctness requirements (and how they're met)

- **Never preempt a running parent turn.** Delivery is a single
  `runner.dispatch({ systemTurn: true })`, which enqueues when the parent is
  mid-turn (drained post-turn) and starts a turn when idle. The poller event
  never calls `agent.kill()` / `dispose()` — same invariant as the rest of the
  poller-driven automations.
- **Survives an orchestrator restart.** The watch is persisted; on startup
  `MergeWatchManager.reconcilePending()` re-derives "child PR terminal + watch
  un-delivered → fire" from the persisted PR snapshot (`loadPersisted` seeds it),
  independent of whether the poller re-observes the (now-archived) merged child.
- **Self-describing payload.** The wake-turn prompt carries the child id, branch,
  PR ref, merge SHA, and intent — it depends on no in-memory state, so it stands
  alone even if it runs many turns or a restart later.
- **Persisted merge card, decoupled from the turn.** Surfaced via
  `chatHistoryManager.append` + a live `child_merged_card` WS emit (the card fires
  outside any turn, so it's an append, not `emitChatCard` — same pattern as
  `issue-lifecycle.ts`). Full at-rest-card contract: typed `childMerged` field on
  `PersistedMessage`, `child_merged` column + `toRow`/`fromRow` + migration,
  `CARD_MESSAGE_FIELDS` registration, client `ChildMergedCard`, and the two guard
  tests.

## Edge cases

- **Child PR not opened yet** → arm and wait; fires once it appears and resolves.
- **Child PR closed without merging** → distinct `closed-unmerged` wake-turn +
  card; the parent is told the work did **not** ship.
- **Parent archived before the merge** → the watch is dropped silently.
- **PR already resolved when the watch is armed** (the poller won't re-observe an
  already-promoted session) → the register route fires a one-shot
  `checkAndFireNow` off the response path.
- **Only the parent that spawned the child may watch it** — reuses the
  `assertChildOfParent` cross-tenancy guard (404, never "wrong parent").

## Flow

```
shipit session notify-on-merge <child>   (shim, agent-shim/shipit.ts)
  → POST /agent-ops/session/notify-on-merge/:childId   (worker, agent-ops-routes.ts)
  → POST /api/sessions/:parentId/children/:childId/notify-on-merge   (api-routes-session.ts)
  → registerMergeWatch(...)   (services/child-sessions.ts) — persists armed watch

PR poller detects terminal PR state (verifyMissingPr)
  → onPrTerminalState(info)   (pr-status-poller.ts hook)
  → MergeWatchManager.handleChildPrTerminal(info)   (merge-watch.ts)
       ├─ surface persisted ChildMergedCard into the parent (append + live emit)
       └─ deliverWakeTurn: resume parent runner + runner.dispatch({systemTurn})
```

## Key files

- `src/server/orchestrator/merge-watch.ts` — `MergeWatchManager`: fire / card /
  wake-turn delivery / startup reconcile / register-time check.
- `src/server/orchestrator/pr-status-poller.ts` — `onPrTerminalState` hook +
  `PrTerminalStateInfo`, fired at the terminal site in `verifyMissingPr` (merged
  AND closed).
- `src/server/orchestrator/services/child-sessions.ts` — `registerMergeWatch`
  (arms the watch, reuses `assertChildOfParent`).
- `src/server/orchestrator/sessions.ts` — `merge_watch` column,
  `setMergeWatch` / `getMergeWatch` / `listPendingMergeWatches`.
- `src/server/orchestrator/api-routes-session.ts` — register route.
- `src/server/session/agent-ops-routes.ts` — worker relay.
- `src/server/session/agent-shim/shipit.ts` — `notify-on-merge` subcommand.
- `src/server/orchestrator/chat-history.ts`, `src/server/shared/database.ts`,
  `src/server/shared/types/domain-types.ts`, `ws-server-messages.ts` — the
  `childMerged` persisted card + `child_merged` column + `WsChildMergedCard`.
- `src/client/components/ChildMergedCard.tsx`,
  `src/client/hooks/message-handlers/child-merged.ts`,
  `src/client/components/visual-elements.ts`,
  `src/client/components/MessageList.tsx` — client render + live handler.
- `src/server/shipit-docs/sessions.md` — agent-facing reference.

## Tests

- `merge-watch.test.ts` — state machine: fire-once, idle/busy parent (never
  preempt), closed-unmerged, parent-archived drop, reconcile, checkAndFireNow.
- `pr-status-poller.test.ts` — `onPrTerminalState` fires on merged AND closed.
- `integration_tests/session-notify-on-merge.test.ts` — register (happy /
  cross-tenancy 404) → merge → persisted parent card + queued wake-turn →
  fire-once → closed-unmerged, through a fully-wired `buildApp`.
- `chat-history.test.ts` + `visual-elements.test.ts` — the at-rest-card guard
  contract (round-trip + empty-text carrier).
