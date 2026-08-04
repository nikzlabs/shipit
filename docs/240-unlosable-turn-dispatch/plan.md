---
issue: https://linear.app/shipit-ai/issue/SHI-261
title: Unlosable turn dispatch — make a dispatched turn's semantics impossible to drop
description: Brand dispatch options so hand-construction can't compile, and make turn completion a settlement object rather than an unowned callback.
---

# Unlosable turn dispatch

## Problem

Five defects in quick succession are all the same bug: **a dispatched turn loses its
semantics somewhere between "dispatch requested" and "the turn ran and signalled
completion."**

| Issue | What was lost | How |
|---|---|---|
| SHI-254 | `onTurnComplete` | The steering path returned before any enqueue, so the callback went with it |
| SHI-255 | `execution`, `systemTurn`, `onTurnComplete` | The interactive drain rebuilt `AgentDispatchOptions` by hand; a third drain in `bootstrap-managers.ts` did the same |
| SHI-259 | `execution`, `systemTurn`, `onTurnComplete`, `postTurn` | Turn adoption added a **fourth** hand-rolled drain — *after* SHI-255 was fixed |
| SHI-260 | `onTurnComplete` (fires zero times) | Passed only to attempt zero; a no-result retry re-enters and the guard against firing twice means it never fires at all |

SHI-258 belongs to the same story from the other end: a retry supervisor built
because deliveries strand, with an in-memory `inFlight` set to tell "pending" from
"failed."

The tell is SHI-259. It was introduced by unrelated work, by an author reasonably
following the code around them, days after SHI-255's write-up claimed "a third drain
added later cannot re-narrow an entry without deliberately bypassing that module."
Nobody bypassed anything deliberately. **Convention is not holding, so the fix has to
be something the compiler enforces.**

## Two distinct root causes

Conflating them is why each fix keeps missing the next instance.

**A — the option set is reconstructed by hand at every drain site.**
`AgentDispatchOptions` is a wide bag of optional fields. Every place that turns a
queued entry into a running turn re-derives it field by field, and TypeScript cannot
catch a *missing optional*: an object literal with four of nine fields is a perfectly
valid `AgentDispatchOptions`. So each new drain silently narrows. SHI-255
centralized two call sites; it did nothing to prevent a third from being written.

**B — completion is an unowned callback on a fire-and-forget call.**
`dispatch(opts): void` returns nothing, and `onTurnComplete` rides along as one more
optional field. Nothing owns the invariant "this dispatch settles exactly once," so
the callback can be dropped in transit (254, 255, 259), or guarded so carefully
against firing twice that it fires zero times (260). Worse, the *consumer* cannot
distinguish **pending** from **lost** — which is why every instance manifests as
silent stranding rather than an error, and why SHI-258's supervisor was needed to
paper over it.

## Fix A — brand the prepared options so hand-construction doesn't compile

Implemented in `src/server/orchestrator/prepared-dispatch.ts`, which owns the
module-private brand key and is therefore the only file that can mint one:

```ts
declare const PREPARED: unique symbol;                 // not exported
export type PreparedDispatch = AgentDispatchOptions & { readonly [PREPARED]: true };
```

`runner.dispatch` / `runner.runDispatchedTurn` accept **only** `PreparedDispatch`,
on both runner implementations. The only producers are:

- `queuedMessageToDispatchOptions(next: QueuedMessage): PreparedDispatch` — the
  full drain conversion (re-exported from `queue-drain.ts`, whose historical
  import path every drain still uses), and
- `prepareDispatch(init: AgentDispatchInit): PreparedDispatch` — the explicit
  entry point for a dispatch that does **not** come off the queue (the wake turn,
  the CI auto-fix loop, the rebase driver, `sendChildMessage`, quick sessions,
  the WS handler's not-steering fall-through).

`toQueuedMessage` was narrowed to `PreparedDispatch` too, so
`enqueue(toQueuedMessage(…))` is not a back door: every path *into* the queue
starts at a producer, exactly like every path out of it.

A drain site that builds an object literal now fails to typecheck.
`turn-adoption.ts`'s hand-rolled `drainNext` was a **compile error** after this
change and is now routed through `startQueuedMessage`.

**Plus an exhaustive field mapping**, so adding a field to `AgentDispatchOptions`
breaks the producer until it is handled. Three independent checks, all in
`prepared-dispatch.ts`:

1. `AgentDispatchInit` — a *complete* init interface (every field required,
   `undefined` allowed) whose key set is asserted equal to
   `keyof AgentDispatchOptions` via `AssertNever<Exclude<…>>` in both directions.
   A new field errors with `Type '"yourNewField"' does not satisfy the constraint
   'never'`, naming it.
2. `DISPATCH_FIELDS: Record<keyof AgentDispatchOptions, true>` — the runtime copy
   iterates exactly this, so the mapping cannot go stale.
3. Because the init is complete, **every `prepareDispatch` call site** also fails
   to compile until the new field is considered there.

(The init is deliberately *not* a `Partial` with defaults: that would re-open the
identical hole one level up — a drain could call `prepareDispatch({ text })` and
lose the rest with the compiler's blessing. Tests use a test-only
`testDispatch()` shim under `integration_tests/`, never importable in anger from
production without it reading as exactly what it is.)

SHI-255's round-trip test is kept: it guards a different surface (a field dropped
*inside* the converter) than the brand does (the converter bypassed entirely).

## Fix B — settlement as an object, not a callback

Implemented in `src/server/orchestrator/turn-settlement.ts`. `dispatch` returns a
handle:

```ts
interface TurnHandle {
  /** Resolves exactly once, when the turn reaches a terminal outcome. */
  readonly settled: Promise<TurnOutcome>;
}

type TurnOutcomeStatus = "completed" | "errored" | "no-result" | "steered" | "dropped";
interface TurnOutcome { status: TurnOutcomeStatus; errored: boolean; detail?: string }
```

`completed` is the only success. `steered` covers a message injected into an
already-running turn (there is no separate turn to wait for); `dropped` covers a
queue entry discarded by `clearQueue` / runner disposal, which used to eat the
signal silently. `errored` keeps its pre-docs/240 meaning — "ended via an agent
process error" — so the existing `{ errored }` consumers (the rebase driver, the
CI auto-fix loop) are behaviourally untouched; `status` is the axis new consumers
branch on.

Where the settlement is resolved, and why it can't be skipped:

- `executeAgentTurn`'s `done` handler wraps its whole body in `try { … } finally {
  settleTurn(…) }`. Every terminal branch already calls `finishTurn()` (which
  computes the real outcome), so the `finally` is a no-op on the healthy paths —
  it exists to catch the branches that `return` early, which is exactly how
  SHI-260 fired zero times. A branch added later that forgets to finish the turn
  still settles it. (The `finally` deliberately does *not* clear
  `systemTurnInProgress`: on the retry path the superseded attempt unwinds
  **after** the retry has re-armed that flag.)
- `runDispatchedTurn` owns "exactly once across attempts": one `settled` latch
  plus a `currentAttempt` filter, so a retry supersedes its predecessor and the
  outcome the caller sees is the LAST attempt's.

Consequences that fall out:

- **SHI-260 dissolves.** The "fire only on attempt zero" guard is **deleted**;
  every attempt reports, and the double fire it was protecting against is no
  longer expressible.
- **Dropping completion stops being silent.** A discarded queue entry settles as
  `dropped` instead of stranding its consumer at "pending forever".
- **The consumer can tell pending from lost.** Which is what SHI-258's `inFlight`
  set was approximating — `merge-watch` now releases the marker and re-attempts
  on any non-`completed` outcome.

### Migration

The ~15 dispatch call sites don't move at once: `onTurnComplete` stays as a thin
adapter over the settlement. `dispatch` chains the handle's `settle` onto it
(`withSettlement`), and because `onTurnComplete` already rides the in-memory
queue, a turn enqueued behind a running turn still settles its handle when it
later drains.

`wakeSessionWithTurn` is migrated in the sense that matters — it passes the whole
`TurnOutcome` through (`onSettled`) instead of flattening it to "delivered",
which is the defect docs/239 flagged. It reads that outcome via the
`onTurnComplete` adapter rather than `await handle.settled`, on purpose: the
handle resolves a microtask later, and the notify-on-merge state machine (plus
its regression suite) is written against a synchronous "the turn finished" edge.
Nothing is lost by that choice — a wake turn is always `systemTurn: true`, hence
never steerable, and the `dropped` case reaches `onTurnComplete` too.

## Why not just more tests

Every one of these bugs shipped *with* tests, and SHI-255 even shipped a guard test
for the exact field-carrying property that SHI-259 then broke. The tests were
correct; they covered the drains that existed. A test cannot fail for a call site
nobody has written yet, which is precisely the failure mode. A type error can.

## Fix C — durable `deliveryId` (SHI-264)

The third layer, deferred until docs/239 shipped and now built. Fix B made
completion an **owned** signal; it is still an **in-memory** one, so it dies with
the orchestrator process. This makes the same signal **durable**.

### The gap it closes

Turn adoption reconnects a restarted orchestrator to a turn that outlived it, but
the worker's reported turn identity carried only agent id, run token and
streaming state — no delivery metadata — so the adopted `executeAgentTurn`
reconstructed **no completion settlement**. For a turn dispatched on behalf of a
notify-on-merge watch (either `kind`), after a restart: the turn kept running,
the watch stayed non-terminal because nothing could settle it, and
`reconcilePending` queued a **second** wake behind the still-running first one.
SHI-259's startup ordering (adopt before reconcile) stopped them colliding; it
never stopped the duplicate.

For a self-merge wake (docs/239) the duplicate's first act is a branch reset,
which that command's safety gate makes *refuse* rather than destroy — bounded,
but leaning on a downstream gate to absorb a duplicate is not a fix.

### Derive liveness rather than track it

Every watch-originated turn is stamped `watchId:attempt` and the id is persisted
**with** the attempt (`SessionMergeWatch.deliveryId`, same write as
`deliveryAttempts`). It rides the dispatch to the worker on `/agent/start`, the
worker records it **against the turn** (not the spawn — a resident streaming
process outlives its turn, and a delivery held there would keep reading as live
and leak onto the next turn `/agent/message` starts), and `/agent/status` reports
it back.

Liveness is then a question with a ground-truth answer, asked of the runner that
actually owns the turn:

```ts
runner.hasDelivery(id)   // running as the current turn, OR queued behind one
```

- **Running** — `runner.activeDeliveryId`, set synchronously by `dispatch` in the
  same tick as `running` (the async gap before `executeAgentTurn` would otherwise
  read as "not in flight", at exactly the slowest sessions), re-published by the
  executor at turn start, and by **adoption** from the worker's report.
- **Queued** — the id rides `QueuedMessage` exactly as `onTurnComplete` does, so
  a wake waiting behind a busy parent answers truthfully for the whole wait.

Nothing here can drift the way SHI-258's `inFlight` set did: a disposed runner is
gone from the registry, a replacement runner has an empty queue, and after a
restart the answer came from the worker itself. **No runner, no delivery.**

### Adoption re-settles; reconcile stands down

`SystemTurnDeps.rebindDelivery(deliveryId)` hands adoption the settlement for a
delivery whose original callback died. `MergeWatchManager.rebindDelivery` matches
the id against the persisted watch rows and rebuilds the **identical** callback
`attemptDelivery` attaches — same helper, `buildDeliverySettlement`, so the two
cannot drift (two hand-written copies is precisely the pattern this doc exists to
end). A miss (cancelled, re-armed, already terminal) returns `undefined` and the
adopted turn runs unsettled, exactly like a user turn.

`attemptDelivery` then gains one guard, at the single funnel every delivery path
goes through (poller, register-time check, retry supervisor, startup reconcile):
if the delivery is live, return. So reconcile redispatches **only** when no live
worker reports it.

### What's left of `inFlight`

A `dispatching` set holding one `await` — the window between recording the
attempt and `runner.dispatch` actually enqueueing it, which can span a container
boot. Released in a `finally`, so it cannot outlive the operation it guards. It
is a re-entrancy lock, not liveness, and a restart correctly empties it.

### Settlement contract, unchanged

Exactly-once, resolved in a `finally`, `errored` preserved. The delivery id is
carried *alongside* the settlement, never instead of it: `settleTurn` clears the
published delivery **before** invoking the consumer (whose first act on a
non-`completed` outcome is to decide whether to retry — a delivery still reading
as in-flight would suppress that forever), guarded on identity so a settling turn
can't clear a successor's, and on `!runner.running` so a no-result retry that has
already re-armed the id isn't clobbered by its superseded predecessor.

## SHI-259's second half — startup ordering

Startup used to launch watch reconciliation and the turn-adoption sweep as two
independent fire-and-forget calls, reconciliation **first**. So `reconcilePending`
could redispatch a wake-turn for a watch still at `merge-observed` while the
original turn was still running inside a worker that outlived the restart: the
fresh `/agent/start` meets the live agent, retries, and can ultimately kill it as
stale.

`bootstrap-managers.ts` now runs both inside one `void (async () => …)()`, with
the adoption sweep **awaited first**. Adopting first makes those runners report
`running`, so a reconcile-issued wake-turn enqueues behind the surviving turn —
or is skipped entirely, because the adopted turn's own completion advanced the
watch. Still off the boot path; each half keeps its own `try/catch` so one
failing doesn't skip the other.

## Risks — and how each was handled

- **This is the orchestrator's hottest path.** Fix A is mechanical: it moved the
  entire dispatch caller set in one pass, but every change is "wrap the literal
  in `prepareDispatch`" and the compiler found all of them. Fix B changes
  behavior only inside the turn executor, and `onTurnComplete` stayed as the
  adapter so no caller had to move at once.
- **A brand is only as good as its producers.** `prepareDispatch` takes a
  **complete** `AgentDispatchInit` (every field required, `undefined` allowed) —
  never a partial with defaults, which would re-open the hole one level up. The
  test-only `testDispatch()` shim that does accept a partial lives under
  `integration_tests/` and is documented as unusable from production.
- **`TurnOutcome` must carry the error case.** `wakeSessionWithTurn`'s
  `onExecuted(): void` became `onSettled(outcome: TurnOutcome)`, and
  `merge-watch` now stamps `delivered` **only** on `status === "completed"`.
  Anything else (`errored`, `no-result`, `dropped`) records a failed attempt —
  and (Fix C) the turn's delivery stops reading as in-flight as it settles — so
  the retry supervisor re-attempts on a backoff instead of the watch looking
  healthy while stranded.

## Fix D — the stuck-running recovery is a terminal path (SHI-280)

Production, 2026-08-04 ~06:28 UTC. A parent session sat wedged for 40+ minutes
with one message frozen in its queue (`Child PR #1939 merged: …`) and no agent
running anywhere.

The turn that was "running" had every one of its events dropped — the relay
logged `dropped (no _agent)` from `agent_init` all the way through
`agent_result`, so the slot was empty from the start of the turn, not displaced
mid-turn. `running` therefore stayed `true`, the merge wake dispatched seven
minutes later was enqueued behind it, and 14 seconds after that the reconciler
did its job: `Detected stuck running=true (worker reports no agent). Resetting.`

Then nothing. The reset restored `running` and emitted `idle`, but two things
were still hanging off the phantom turn:

1. **The queue.** Every drain in the system is reached *from a turn that
   actually ran* — the executor's post-turn drain, the WS drain,
   `dispatchOnRunner`'s setup-failure release, `drainQueueForSession` after an
   auto-resolve attempt. None of them can fire for a turn whose events never
   arrived, so the entry sat there until a human happened to send a new message
   (which ran immediately, and whose own post-turn drain then picked it up).
2. **The settlement.** The turn never reached the executor's settling `finally`,
   so `onTurnComplete` never fired and `activeDeliveryId` stayed published —
   which is exactly the "indefinitely in flight" reading that suppresses every
   retry. Same stranding class as SHI-263 / SHI-264, reached through the one
   path Fix B and Fix C did not cover: a turn that loses its ability to settle
   itself while its runner stays perfectly alive.

So the reset is treated as what it is — the turn's real terminal moment:

- `verifyRunningState` clears `activeDeliveryId`, emits a new runner event
  `turn_abandoned`, and then releases the queue. `dispatchOnRunner` listens for
  `turn_abandoned` alongside `disposed` and settles the handle as `dropped`
  through the same chained-callback path, so the pre-docs/240 consumers hear it
  too. Ordering matches `settleTurn`: the delivery stops being live *before* its
  consumer is told, or the consumer's retry check reads a stale `true`.
- The release goes through `releaseQueuedTurn` (`queue-drain.ts`), which is
  `drainQueueForSession`'s body lifted into the module that owns the drain rule.
  Both callers are the same shape — a path with no turn of its own to drain from
  — so there is one implementation rather than a fifth hand-rolled one, and the
  entry keeps `systemTurn` / `postTurn` / `onTurnComplete` / `deliveryId` by
  construction. `idle` is emitted only when nothing was released: a released
  turn means the runner is *not* idle, and that turn's own post-turn flow
  signals idle when it finishes.
- `send-message.ts` re-reads `runner.running` after `verifyRunningState` instead
  of trusting the return value. The release claims the runner synchronously, and
  without the re-read the user message that triggered the recovery would fall
  through and spawn a second agent against the one the released turn is already
  starting — two paths racing for the `_agent` slot, which is how the phantom
  turn came about in the first place. Re-entering the queue branch puts the user
  message behind the entry that was there first.

**The rebase banner is a symptom of the same bug, not a second one.** The
incident also reported a "Rebasing onto `main`…" spinner with nothing behind it.
`runRebaseFlow` emits `rebase_started` and then *awaits*
`runRebaseResolutionTurn`, whose promise resolves from `onTurnComplete`. A
resolution turn stranded this way never settles, so the flow never reaches
`rebase_complete` / `rebase_aborted`, and the buffered `rebase_started` replays
on every viewer attach. (Start and terminal are both buffered via
`emitMessage`, so a lone start can *only* mean the flow itself never finished —
replay filtering would have hidden the symptom, not fixed it.) With Fix D the
abandoned resolution turn settles as `dropped`, which is `errored: true`, so the
driver rejects, the route's `flowPromise.catch` emits `rebase_aborted`, and the
banner clears.

Separately, the rebase lifecycle messages now carry `sessionId` and their
handlers drop foreign ones — `useGitStore` is a global client store fed by a
per-session socket, and `auto_resolve_started`, which interleaves with them,
already had that guard.

## Key files

| Area | File | Change |
|---|---|---|
| Brand + producers | `src/server/orchestrator/prepared-dispatch.ts` *(new)* | Module-private `PREPARED` symbol, `PreparedDispatch`, `AgentDispatchInit`, `prepareDispatch`, `queuedMessageToDispatchOptions`, `withSettlement`, the exhaustiveness assertions |
| Settlement primitive | `src/server/orchestrator/turn-settlement.ts` *(new)* | `TurnHandle` / `TurnOutcome` / `createTurnSettlement` / `settleDroppedQueueEntries` |
| Runner contract | `src/server/orchestrator/session-runner.ts` | `dispatch(PreparedDispatch): TurnHandle`; `runDispatchedTurn(PreparedDispatch)`; `toQueuedMessage` narrowed; ONE shared `dispatchOnRunner` both runners delegate to; `clearQueue` / `dispose` settle dropped entries |
| Converter home | `src/server/orchestrator/queue-drain.ts` | Re-exports the converter (historical import path); `startQueuedMessage` unchanged |
| The regression | `src/server/orchestrator/turn-adoption.ts` | Hand-rolled `drainNext` deleted — it no longer compiles; routed through `startQueuedMessage` |
| Settlement wiring | `src/server/orchestrator/dispatched-turn.ts`, `turn-executor.ts` | One settlement per logical turn across retries; attempt-zero guard **deleted**; `done` handler settles from a `finally` |
| Runner impls | `src/server/orchestrator/container-session-runner.ts`, `turn-accumulator.ts` | Same narrowed signatures; queue teardown settles what it discards |
| Callers | `wake-session.ts`, `merge-watch.ts`, `app-lifecycle.ts` (CI auto-fix), `services/rebase-driver.ts`, `services/child-sessions.ts`, `services/github-ci-fix.ts`, `services/headless-sessions.ts`, `services/agent.ts`, `ws-handlers/send-message.ts` | Migrated to `prepareDispatch`; merge-watch consumes the OUTCOME instead of assuming delivery |
| Ordering | `src/server/orchestrator/bootstrap-managers.ts` | The adoption sweep is awaited before watch reconciliation (SHI-259's second half); `mergeWatchManagerRef` forward-ref feeds `rebindDelivery` into every runner |
| **Fix C** — worker report | `src/server/session/agent-controller.ts` | `/agent/start` accepts `deliveryId`; `turnDeliveryId` is keyed to the TURN (cleared by `endTurn`) and published on `/agent/status` |
| Fix C — wire | `src/server/orchestrator/proxy-agent-process.ts`, `container-session-runner.ts` | `ProxyAgentProcess.deliveryId` / `setDeliveryId`, forwarded on `/agent/start`; `adoptWorkerTurn` reads `status.deliveryId` |
| Fix C — runner contract | `src/server/orchestrator/session-runner.ts` | `activeDeliveryId` + `hasDelivery()` on both runners; `deliveryId` on `AgentDispatchOptions` / `QueuedMessage`; `dispatch` publishes it synchronously and clears it on setup failure |
| Fix C — turn lifecycle | `src/server/orchestrator/turn-executor.ts`, `dispatched-turn.ts`, `turn-adoption.ts` | Publish at turn start, stamp on the spawn, clear in `settleTurn` before reporting; adoption rebinds via `deps.rebindDelivery` |
| Fix C — the owner | `src/server/orchestrator/merge-watch.ts` | Mints + persists `watchId:attempt`; `buildDeliverySettlement` shared by dispatch and rebind; `rebindDelivery`; derived `isDeliveryInFlight`; `inFlight` reduced to a `dispatching` lock |
| Fix C — persistence | `src/server/shared/types/domain-types/session.ts`, `agent-types.ts` | `SessionMergeWatch.deliveryId` (JSON column — no migration), `WorkerAgentStatus.deliveryId`, `AgentProcess.setDeliveryId?` |
| **Fix D** — recovery | `src/server/orchestrator/container-session-runner.ts` | `verifyRunningState` clears `activeDeliveryId`, emits `turn_abandoned`, releases the queue, and emits `idle` only when nothing was released |
| Fix D — settlement | `src/server/orchestrator/session-runner.ts` | `turn_abandoned` on `SessionRunnerEvents`; `dispatchOnRunner` settles it as `dropped` via the same `settleAsDropped` path as `disposed` |
| Fix D — one drain | `src/server/orchestrator/queue-drain.ts`, `bootstrap-managers.ts` | `releaseQueuedTurn` — `drainQueueForSession`'s body lifted into the module that owns the drain rule, shared by both no-turn-of-its-own paths |
| Fix D — the race | `src/server/orchestrator/ws-handlers/send-message.ts` | Re-reads `runner.running` after `verifyRunningState`, so a released entry isn't raced for the `_agent` slot |
| Fix D — banner scope | `src/server/shared/types/ws-server-messages/git.ts`, `services/rebase-driver.ts`, `api-routes-git.ts`, `client/hooks/message-handlers/rebase-*.ts` | `sessionId` on the four rebase lifecycle messages; handlers drop foreign ones (the guard `auto_resolve_started` already had) |

## Testing

- `prepared-dispatch.test.ts` — **type-level** (`@ts-expect-error`, compiled by
  `npm run typecheck`, which fails on an *unused* directive, so the guard bites
  the moment the brand is removed): a hand-built `AgentDispatchOptions` and an
  inline literal cannot be passed to `dispatch` or `runDispatchedTurn`, and an
  incomplete `prepareDispatch` init does not compile. Plus the converter's
  runtime field coverage and `withSettlement`'s settle-even-if-the-consumer-throws
  behavior.
- `queue-drain.test.ts` — SHI-255's round-trip guard, kept: it covers a field
  dropped *inside* the converter, which the brand does not.
- Exhaustiveness — adding a field to `AgentDispatchOptions` without updating
  `AgentDispatchInit` / `DISPATCH_FIELDS` fails to compile, naming the field.
- `integration_tests/turn-settlement.test.ts` — driven through the real
  `dispatch → runDispatchedTurn → executeAgentTurn` path with a fake agent:
  a no-result retry that **succeeds** settles once with success; one whose
  retries are **exhausted** settles once with failure (SHI-260); an **errored**
  turn settles with the error outcome, not a success; a discarded queue entry
  settles as `dropped`; and a callback-bearing system turn queued behind an
  **ADOPTED** turn runs as a system turn and settles (SHI-259).
- The existing SHI-254 / SHI-255 / SHI-258 regressions pass unchanged — only the
  outcome literal in two assertions grew a `status` field.
- `integration_tests/restart-delivery-identity.test.ts` (SHI-264) — the honest
  harness: a REAL `SessionWorker` over HTTP + SSE, a REAL `ContainerSessionRunner`
  and a REAL `MergeWatchManager`, run in the bootstrap order (adopt, then
  reconcile), for **both** `kind: "child"` and `kind: "self"`. A restart during a
  watch-originated turn yields ONE turn and the watch settles from the ADOPTED
  turn; a restart where the worker turn genuinely died redispatches exactly once
  (with a fresh id) and a second reconcile stands down; a manager instance that
  has never dispatched anything reaches the same verdict, which is the property
  "`inFlight` is no longer load-bearing for liveness" stated as a test. Nothing
  is faked at the orchestrator boundary — the id makes the round trip through the
  worker, so `/agent/status` reporting it is part of what's under test.
- `merge-watch.test.ts` — the manager-side half: an id is minted per attempt and
  persisted WITH it, a retry mints a distinct one, a queued delivery is
  recognized by a fresh manager, and `rebindDelivery` matches only a live
  non-terminal watch. Its `FakeRunner` models `hasDelivery` + a `simulateRestart`
  that drops the in-memory queue, so the fake tracks the contract rather than
  the old marker.
- `integration_tests/turn-settlement.test.ts` — when the published delivery flips:
  live in the same tick as `running`, live across the queued wait and through its
  own turn, and cleared BEFORE the consumer is told (a stale `true` reads as
  "never retry").

## Resolved decisions

- **Compiler enforcement over convention.** SHI-259 was introduced by unrelated work
  following surrounding patterns; a documented rule and a converter module were not
  enough.
- **Brand the options rather than lint for object literals.** A lint rule is
  bypassable and lives outside the type system; the brand makes the invalid state
  unrepresentable.
- **Keep the converter round-trip test.** It guards a different surface (fields
  dropped *inside* the converter) than the brand does (converter bypassed entirely).
- **Settlement resolved in `finally`, retries inside one settlement.** Deletes
  SHI-260's guard rather than fixing it.
- **Incremental migration via a callback adapter**, not a fifteen-caller rewrite.
- **`deliveryId` keyed to the TURN on the worker, not the spawn.** A resident
  streaming process outlives its turn, so a delivery held on `residentSpawn`
  would keep reporting as live after the turn ended — permanently suppressing a
  legitimate redispatch — and would leak onto the next turn `/agent/message`
  starts on the same process.
- **The liveness guard lives in `attemptDelivery`, not at each caller.** It is the
  one funnel every delivery path goes through, which is the same reason the
  settlement lives in the executor rather than at each dispatch site.
- **`rebindDelivery` rebuilds the settlement from the persisted row** rather than
  the manager keeping an in-memory map of deliveries. A map would be the same
  tracked-state mistake one layer up; the row already holds everything the
  callback needs (attempt number, `watchId`, `observedAt`).
- **The old `inFlight` set is reduced, not renamed.** What survives guards one
  `await` and is released in a `finally` — it cannot answer a liveness question
  it is not asked.
