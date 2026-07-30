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

## Later — durable `deliveryId` (gated on docs/239)

Not part of this work; recorded here because it is the third layer and only earns its
cost if `docs/239-self-merge-wake` proceeds.

SHI-258's `inFlight` set is **tracked** state, so it desynchronizes: a disposed
runner, an adopted turn that survived a restart, or a second runner created for the
same session all leave it wrong. The robust form is to **derive liveness rather than
track it** — stamp every server-originated turn with a durable `deliveryId`, have the
worker report which ids are queued or running (via `/agent/status`), and let a
supervisor ask ground truth instead of trusting a set someone remembered to update.

That also supplies the missing half of SHI-259: turn adoption currently cannot
reconstruct a watch's completion settlement, because the worker's reported turn
identity carries no delivery metadata. With a `deliveryId` it can re-settle a
surviving delivery instead of the orchestrator redispatching over the top of it.

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
  Anything else (`errored`, `no-result`, `dropped`) releases the SHI-258
  in-flight marker and records a failed attempt, so the retry supervisor
  re-attempts on a backoff instead of the watch looking healthy while stranded.

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
| Ordering | `src/server/orchestrator/bootstrap-managers.ts` | The adoption sweep is awaited before watch reconciliation (SHI-259's second half) |

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
- **`deliveryId` is out of scope** and gated on docs/239 proceeding.
