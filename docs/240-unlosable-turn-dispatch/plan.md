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

```ts
declare const PREPARED: unique symbol;
export type PreparedDispatch = AgentDispatchOptions & { readonly [PREPARED]: true };
```

`runner.dispatch` / `runDispatchedTurn` accept **only** `PreparedDispatch`. The only
producers are:

- `queuedMessageToDispatchOptions(next: QueuedMessage): PreparedDispatch` — the
  existing full conversion (`queue-drain.ts`), and
- `prepareDispatch(init: AgentDispatchInit): PreparedDispatch` — the explicit
  entry point for a dispatch that does **not** come off the queue (the poller's wake
  turn, the CI auto-fix loop, `sendChildMessage`).

A drain site that builds an object literal now fails to typecheck. `turn-adoption.ts`'s
hand-rolled `drainNext` becomes a **compile error** rather than something a reviewer
has to notice.

**Plus an exhaustive field mapping**, so adding a field to `AgentDispatchOptions`
breaks the converter until it is handled — a `Record<keyof AgentDispatchOptions, …>`
or an explicit destructure with no rest element. SHI-255 shipped a round-trip test
that guards the *converter*; branding guards the *call sites*, which is where both
regressions actually happened. Both are wanted: the test catches a field dropped
inside the converter, the brand catches a converter that was bypassed.

## Fix B — settlement as an object, not a callback

`dispatch` returns a handle:

```ts
interface TurnHandle {
  /** Resolves exactly once, when the turn reaches a terminal outcome. */
  readonly settled: Promise<TurnOutcome>;   // { status: "completed" | "errored" | "no-result", … }
}
```

The executor resolves it in a `finally`, so a turn cannot exit without settling.
Consequences that fall out:

- **SHI-260 dissolves.** No-result retries become attempts *within* one settlement.
  The "fire only on attempt zero" guard exists to prevent a double-fire; with a
  single settlement resolved once at the end, a double-fire is not expressible and
  the guard is deleted rather than corrected.
- **Dropping completion stops being silent.** You can't drop a settlement — you can
  only fail to resolve one, which is detectable (an unresolved handle at teardown is
  an assertable bug, and a consumer awaiting it sees a hang rather than a permanent
  "pending").
- **The consumer can tell pending from lost.** Which is what SHI-258's `inFlight` set
  was approximating.

### Migration

The ~15 dispatch call sites don't move at once. Keep `onTurnComplete` as a thin
adapter over the settlement:

```ts
const handle = runner.dispatch(prepared);
if (opts.onTurnComplete) void handle.settled.then(opts.onTurnComplete);
```

so callers migrate incrementally and the risky path — the hottest in the
orchestrator — changes shape in one place rather than in fifteen commits.

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

## Risks

- **This is the orchestrator's hottest path.** Fix A is mechanical and independently
  landable. Fix B changes a signature every dispatch caller touches; the adapter
  above is what keeps it from being a big-bang change.
- **A brand is only as good as its producers.** If `prepareDispatch` accepts a
  partial and fills defaults, it re-opens the same hole one level up. It must take a
  complete init object with the exhaustive mapping applied.
- **`TurnOutcome` must carry the error case.** `wakeSessionWithTurn` currently
  discards the `errored` outcome, so a consumer can conclude "delivered" for a turn
  that crashed (noted in docs/239). The settlement must not repeat that.

## Key files

| Area | File | Change |
|---|---|---|
| Brand + producers | `src/server/orchestrator/session-runner.ts` | `PreparedDispatch`, `prepareDispatch`, narrowed `dispatch` / `runDispatchedTurn` signatures |
| Converter | `src/server/orchestrator/queue-drain.ts` | Return `PreparedDispatch`; exhaustive field mapping |
| The regression | `src/server/orchestrator/turn-adoption.ts` | Hand-rolled `drainNext` becomes a compile error; route through `startQueuedMessage` |
| Settlement | `src/server/orchestrator/dispatched-turn.ts`, `turn-executor.ts` | `TurnHandle` / `TurnOutcome`; resolve once in `finally`; delete the attempt-zero guard |
| Runner impls | `src/server/orchestrator/container-session-runner.ts` | Same signatures on the container runner |
| Callers | `wake-session.ts`, `merge-watch.ts`, CI auto-fix, `sendChildMessage`, `bootstrap-managers.ts` | Adapter first, then migrate to `settled` |
| Ordering | `src/server/orchestrator/bootstrap-managers.ts` | Await the adoption sweep before watch reconciliation (SHI-259's second half) |

## Testing

- A hand-built `AgentDispatchOptions` passed to `dispatch` **fails to compile** —
  asserted as a type-level test, since a runtime test cannot express it.
- Adding a field to `AgentDispatchOptions` without updating the converter fails the
  exhaustiveness check.
- A callback-bearing system turn queued behind an **adopted** turn runs as a system
  turn and settles (the SHI-259 regression).
- A no-result retry that **succeeds** settles once with success; one whose retries are
  **exhausted** settles once with failure (the SHI-260 regression).
- An `errored` turn settles with the error outcome, not a success.
- The existing SHI-254/255/258 regressions still pass unchanged.

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
