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
armed ──merge observed──▶ merge-observed ──wake-turn RAN──▶ delivered   (terminal)
  │                              ▲                                │
  │                              └──────────restart re-fires──────┘
  └──PR closed unmerged──▶ closed-unmerged                                (terminal)
```

- **`armed`** — registered, waiting. The child's PR need not exist yet.
- **`merge-observed`** — the poller saw the merge and surfaced the card, and the
  actionable wake-turn has been delivered **but has not yet run to completion**.
  This is the recoverable in-flight state: the watch stays here while the turn is
  merely enqueued (parent mid-turn) or still executing, and while a parent
  container is being (re)booted. A poll / the startup reconcile re-fires from here
  (the card-surface guard makes the re-entry skip the duplicate card and just
  retry the wake-turn).
- **`delivered`** — the merge wake-turn has **actually run to completion** (not
  merely been enqueued). Terminal, **fire-once**.
- **`closed-unmerged`** — the PR closed without merging; a *distinct* wake-turn
  was enqueued so the parent doesn't proceed as if the work shipped. Terminal.

The `delivered` / `closed-unmerged` terminal states are the fire-once guard: a
re-poll or a restart re-observation is a no-op.

**Why `delivered` means "ran", not "enqueued" (the docs/196 restart fix).** The
dispatched turn lives only in the parent runner's **in-memory** queue until it
executes. If the watch were stamped `delivered` the instant the turn was
*enqueued* — as the original code did — an orchestrator restart (or a parent
idle-reap) between enqueue and execution would lose the queued turn while the
persisted watch already read `delivered`. `reconcilePending` only re-fires
`armed` / `merge-observed` watches, so a prematurely-`delivered` watch is skipped
forever: the card persists and rehydrates on reload, but the parent agent never
runs ("notification visually there, agent didn't start"). The fix advances to
`delivered` **only from the wake-turn's `onTurnComplete`** (the same
turn-completion signal the CI auto-fix loop awaits in `app-lifecycle.ts`):
- **idle parent** → `dispatch` starts the turn now → it completes → `delivered`.
- **mid-turn parent** → `dispatch` enqueues (never preempting). `onTurnComplete`
  rides the **in-memory queue** (carried by `toQueuedMessage` /
  `queuedMessageToDispatchOptions`), so when the queued turn later drains and
  runs it advances the watch to `delivered` **in-process** — no restart needed.
  The watch sits at `merge-observed` only for the window between enqueue and the
  turn actually running; a restart inside that window drops the queued turn and
  leaves the watch recoverable for `reconcilePending`. This holds on **both**
  drains — the dispatched turn's own and the interactive (WS) turn's — see
  *How a queued wake-turn survives the drain* below.

A restart at any point before the turn completes therefore leaves the watch
recoverable, and re-delivery never surfaces a second card.

**Duplicate-notification fix (busy-parent path).** The original code left the
mid-turn path's `onTurnComplete` *unwired* and relied solely on `onTurnComplete`
being "dispatch-only, not carried through the queue." A busy-parent watch
therefore never reached `delivered` even after its wake-turn ran — it stayed
`merge-observed` **forever**, so `reconcilePending` re-fired a fresh wake-turn on
**every** orchestrator restart. In a long fan-out where the parent is almost
always mid-turn, nearly every watch hit this path, producing the observed bursts
of duplicate "Child PR merged" wake-turns on each restart/reconnect. Carrying
`onTurnComplete` through the in-memory queue lets the busy path reach
`delivered` once the turn drains, so reconcile re-fires **only** the genuine
"restart lost the still-queued turn" case.

### How a queued wake-turn survives the drain (SHI-254 / SHI-255)

Carrying `onTurnComplete` on the queue is necessary but wasn't sufficient: two
defects in the shared dispatch path meant a wake-turn arriving at a *genuinely*
busy parent still lost it. Both are fixed; the mechanism now honors
"`delivered` means the turn ran" instead of quietly breaking it.

- **The wake-turn is never live-steered (SHI-254).** `dispatch` consults
  `trySteerDispatch` before enqueueing, and `shouldSteerMessage` only asks
  whether the **currently running** turn is a system turn — nothing about the
  incoming one. With live steering on, a wake-turn arriving during an ordinary
  streaming *user* turn was therefore injected into that turn via
  `sendUserMessage`: the system instruction landed mid-context in someone else's
  turn (contradicting "never preempts a running turn"), and because the steer
  branch returns **before** any enqueue, `onTurnComplete` was dropped outright —
  the watch could never leave `merge-observed`. `isSteerableDispatch`
  (`dispatch-steering.ts`) now refuses to steer any dispatch carrying
  `systemTurn` **or** a completion callback, so such a turn always enqueues and
  always runs as its own turn.
- **Both queue drains preserve the full option set (SHI-255).** A session has one
  queue but two drains: the dispatched turn's (`dispatched-turn.ts`) and the
  interactive WS turn's (`ws-handlers/agent-execution.ts`). Only the first
  restored `systemTurn` / `onTurnComplete`; the interactive one re-entered
  `runAgentWithMessage` with just text, attachments, and the agent session id. So
  a wake-turn queued behind a **user** turn — the common case, since a busy
  parent is busy precisely because a user turn is running — ran as an ordinary
  interactive turn and never signalled completion. Every queued entry is now
  **tagged** with the executor that must run it (`QueuedMessage.execution`:
  `"interactive"` for a user-typed WS message, `"dispatched"` for everything
  server-originated, which is also the default), and both drains route through
  `startQueuedMessage` (`queue-drain.ts`): a `"dispatched"` entry goes back
  through `runner.runDispatchedTurn` with the full option set, and only an
  `"interactive"` entry reaches a transport's narrower re-entry. A third drain
  added later cannot re-narrow an entry without deliberately bypassing that
  module.
- **A drained system turn runs as a system turn.** `dispatch` sets
  `systemTurnInProgress` synchronously only for a turn it starts from idle, so an
  *enqueued* system turn used to run steerable. `executeAgentTurn` now sets the
  flag from `input.systemTurn` as well (and clears it on teardown), so a
  wake-turn suppresses live steering for its whole duration however it started.

**Still open (not fixed here).** A wake-turn delivery that *fails* has no retry
before an orchestrator restart: `reconcilePending` has only a bootstrap call
site, so a `deliverWakeTurn` throw (parent container couldn't be resumed) leaves
the watch at `merge-observed` until the next startup. That is a design gap
needing a retry supervisor, not a narrow bug fix.

## Correctness requirements (and how they're met)

- **Never preempt a running parent turn.** Delivery is a single
  `runner.dispatch({ systemTurn: true })`, which enqueues when the parent is
  mid-turn (drained post-turn) and starts a turn when idle. The poller event
  never calls `agent.kill()` / `dispose()` — same invariant as the rest of the
  poller-driven automations. "Enqueues when mid-turn" is unconditional: a
  `systemTurn` dispatch is never live-steered into the running turn, whatever the
  steering settings say (SHI-254, above).
- **Survives an orchestrator restart.** The watch is persisted; on startup
  `MergeWatchManager.reconcilePending()` re-derives "child PR terminal + watch
  un-delivered → fire" from the persisted PR snapshot (`loadPersisted` seeds it),
  independent of whether the poller re-observes the (now-archived) merged child.
- **Fires headlessly — keeps the poll alive with no viewer.** The live (non-restart)
  fire path depends on a poll *observing* the child PR's terminal state, but the
  poll loop only runs while `PollingGlobalGate.isOpen()` is true. A child waiting
  on a human merge has no viewer and no armed remediation of its own, so without a
  signal the gate closes, the supervisor stops, and the merge is never observed
  until someone reopens a tab. The gate therefore treats *any* pending watch as a
  reason to keep polling: `hasPendingMergeWatch()` (backed by
  `SessionManager.listPendingMergeWatches()`) is wired into
  `anyAutonomousActionInFlight()` (`polling-global-gate.ts`). `reconcilePending`
  is the restart backstop; this is the steady-state one. Covered by
  `polling-global-gate.test.ts` ("a pending notify-on-merge watch keeps the gate
  open with no viewer").
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
- **Parent archived before the merge** → the watch is dropped silently at
  delivery (`handleChildPrTerminal` bails on `parent.archived || userArchived`).
  Now also refused at **arm time**: `registerMergeWatch` rejects (400) when the
  parent is archived, so a watch that could only ever be dropped is never even
  persisted. Both ends enforce the same invariant — an archived parent receives
  nothing.
- **PR already resolved when the watch is armed** (the poller won't re-observe an
  already-promoted session) → the register route fires a one-shot
  `checkAndFireNow` off the response path.
- **Only the parent that spawned the child may watch it** — reuses the
  `assertChildOfParent` cross-tenancy guard (404, never "wrong parent").

### Related hardening — archived sessions receive nothing

Notify-on-merge is the headline "updates from a child" channel, but the same
invariant — **an archived session is frozen and receives no updates from
children or anything else** — is enforced on the sibling out-of-turn delivery
paths:

- **Issue-lifecycle merge cards** (`issue-lifecycle.ts` `surfaceWriteCard`) skip
  the chat-history append + live emit for an archived session. The *outward*
  tracker write (closing the linked issue on PR merge) still happens — that's
  correct regardless of local session lifecycle — but no provenance card is
  pushed into an archived transcript.
- **WS activation** (`route-registry.ts` `activateSession`) refuses to
  `getOrCreate` a runner or re-track the PR poller for an archived session, so a
  stray connection to an archived session id can't boot a container or re-arm
  polling. The restore path (`unarchiveSession`) flips `archived → false` before
  the client activates, so the legitimate flow is untouched; history still loads
  read-only over HTTP.

Most other emit paths are runner-gated (an archived session has no runner) and
the PR poller only scans Active (`list()`) sessions, so the invariant holds by
construction elsewhere.

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
- `src/server/orchestrator/session-runner.ts` +
  `src/server/orchestrator/dispatched-turn.ts` — `onTurnComplete` is carried
  through the in-memory queue (`QueuedMessage` / `toQueuedMessage` /
  `queuedMessageToDispatchOptions`) so an enqueued wake-turn signals completion
  when it drains (the busy-parent `delivered` path / duplicate-fire fix), plus
  the `QueuedMessage.execution` tag and `runner.runDispatchedTurn` drain re-entry.
- `src/server/orchestrator/queue-drain.ts` — `startQueuedMessage`: the single
  router both drains use, so a queued entry always runs on the executor it was
  tagged for (SHI-255).
- `src/server/orchestrator/dispatch-steering.ts` — `isSteerableDispatch`: a
  `systemTurn` / completion-callback dispatch is never steered (SHI-254).
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — the interactive
  drain routes through `startQueuedMessage`; `runQueuedInteractiveMessage` is
  reached only by `"interactive"` entries.
- `src/server/orchestrator/turn-executor.ts` — sets `systemTurnInProgress` from
  `input.systemTurn`, so a *drained* system turn also suppresses live steering.
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
  preempt), closed-unmerged, parent-archived drop, reconcile, checkAndFireNow,
  and the restart fix — `delivered` is reached only once the wake-turn runs to
  completion (not when enqueued). Busy parent: the enqueued wake-turn reaches
  `delivered` once it **drains in-process** (no restart needed), and a delivered
  watch is never re-fired across repeated restarts (the duplicate-notification
  regression); a busy watch lost to a restart *before* it drains is re-delivered
  by reconcile without a second card.
- `services/child-sessions-wait.test.ts` — `registerMergeWatch` arm-time guards:
  arms when active, rejects (400) an archived parent (no watch persisted) and an
  archived child.
- `issue-lifecycle.test.ts` — an archived session still gets the outward tracker
  write on merge but **no** provenance card appended or emitted.
- `pr-status-poller.test.ts` — `onPrTerminalState` fires on merged AND closed.
- `integration_tests/session-notify-on-merge.test.ts` — register (happy /
  cross-tenancy 404) → merge → persisted parent card + dispatched wake-turn →
  `delivered` only after the real turn completes → fire-once → closed-unmerged,
  plus a restart-before-the-turn-runs case recovered by `reconcilePending`
  (no second card), through a fully-wired `buildApp`. Includes the busy-parent
  case against a **real interactive turn** (SHI-255): the wake-turn queues behind
  it, drains, runs as a system turn, and reaches `delivered` in-process.
- `integration_tests/system-turn-queue.test.ts` — the two dispatch-path
  regressions against a real turn (the fake busy runner in `merge-watch.test.ts`
  cannot reproduce either): with live steering on a `systemTurn` dispatch queues
  instead of being steered and its `onTurnComplete` still fires (SHI-254); a
  wake-turn queued behind a real interactive turn runs as a system turn and fires
  its callback (SHI-255); and an ordinary user message queued behind a running
  turn still drains on the interactive path (no duplicate echo bubble).
- `queue-drain.test.ts` — the drain router: a `"dispatched"` entry never reaches
  the interactive re-entry, an `"interactive"` one always does, the deps-less
  fallback, and a round-trip guard that fails if a new `AgentDispatchOptions`
  field is not carried through the queue.
- `session-runner.test.ts` — a `systemTurn` (or completion-callback) dispatch
  enqueues rather than steering, even with live steering on and a streaming turn
  in flight, and the queued entry keeps its callback.
- `chat-history.test.ts` + `visual-elements.test.ts` — the at-rest-card guard
  contract (round-trip + empty-text carrier).
