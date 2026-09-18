---
issue: planning#552
title: Releasing a system-turn hold a CLI-started turn displaced
description: Why a late agent_self_wake stranded systemTurnInProgress on a non-streaming system turn, and where the hold is now released.
---

# Releasing a system-turn hold a CLI-started turn displaced

Implements [requirements.md](./requirements.md). Sibling of
[docs/287-consult-result-delivery](../287-consult-result-delivery/plan.md),
which fixed the same event order on the *other* flag.

## Symptom

Session `ed7d9efe` on 2026-09-14, deployed build `b8ecfa69a02a`. A backgrounded
`shipit agent run --role reviewer` consult finished, ShipIt logged
`[consult-delivery] woke session=… status=success`, and **no turn ever started**.
The session read idle with the wake in its queue. 34 minutes later it was still
stuck, and every message the user typed afterwards queued behind it too. Only an
orchestrator restart cleared it.

docs/287's Fix 1 was in that build and worked: `running` was correctly unlatched
(proved by `wake-session.ts:76` logging `turn=warm-up`, which it does only when
`!runner.running`). The flag left latched was `systemTurnInProgress`.

## Root cause

On a **non-streaming system turn** — every ShipIt-started turn is one, because
`dispatched-turn.ts` forces `useStreaming` false whenever `systemTurn` is set —
this order strands the runner:

1. `agent_result` runs `tryDrain`, which sets `runner.running = false`. It does
   not call `finishTurn()`.
2. `agent_self_wake` arrives, a backgrounded job having finished.
   `adoptCliStartedTurn` (`ws-handlers/agent-listeners.ts`) sees `!runner.running`,
   so it treats the notification as the start of a CLI-started turn and calls
   `resetRunnerTurnState`, which **increments `runner.turnEpoch`**.
3. `done` unlatches `running` and calls `finishTurn()`, whose release of the hold
   is guarded on `turnIsCurrent()` — the epoch captured at turn start against
   `runner.turnEpoch`. Step 2 moved the epoch, so the guard fails and
   `systemTurnInProgress` stays `true` for the life of the process.

Every later dispatch then hits the system-hold gate in
`session-runner.ts` (`dispatchOnRunner`) and enqueues instead of starting, and no
drain path can release it: `releaseQueuedTurn` returns false on the flag,
`drainNextQueuedMessage` returns early on it, `send-message.ts` queues on it, and
`verifyRunningState` sees `running` already false and returns at once.

## The fix

Three changes; only the first is the root cause.

### 1. Release the hold by its identity, not the turn's

The turn epoch was never the right question. It identifies the *turn*, and the
hold is a separate thing that a turn takes, hands on, and can outlive — so
`turnIsCurrent()` answers "did anything else start?" when the question is "do I
still hold this?".

`systemTurnInProgress` therefore gains an identity of its own. Every write of
`true` mints a new `systemHoldSeq` on the runner, including one written while the
flag is already set, because that is a different owner taking it over.
`executeAgentTurn` captures the value on the line it takes the hold, and
`finishTurn` releases only on a match:

```ts
runner.systemTurnInProgress = input.systemTurn === true;
const heldSystemHoldSeq = runner?.systemHoldSeq;
…
if (input.systemTurn && runner && runner.systemHoldSeq === heldSystemHoldSeq) {
  runner.systemTurnInProgress = false;
}
```

The release stays at the same point of the same `done` sequence as before. The
adoption becomes irrelevant to it: a CLI-started turn moves the epoch and does
not touch the hold, so the turn that took it still releases it.

**This also closes two holes that predate the incident**, both found by review of
this branch and both reachable through the silent compaction turn, which releases
its hold at its own drain (`dispatched-turn.ts`) while its process is still
exiting. A rebase can acquire the hold in that window, and then:

- the compaction turn's `finishTurn` cleared it, because `turnIsCurrent()` was
  true — nothing had displaced the *turn*. Guarded by "leaves a hold that changed
  hands mid-turn alone".
- its `drainNext` cleared it *and started a queued turn under it*, because the
  gate and the silent release keyed on `opts.systemTurn` — "this is a system turn,
  so the hold must be mine". `executeAgentTurn` now passes the same ownership
  answer into `drainNext`, which takes both decisions from it. Guarded by
  "neither releases nor drains under a hold taken while it was exiting".

**Two repairs were weighed and rejected.** *Relaxing `turnIsCurrent()`* widens
exactly the wrong predicate — it lets a stale predecessor clear a flag it cannot
attribute at all. *Clearing `systemTurnInProgress` inside `adoptCliStartedTurn`*
(the ops packet's preferred one-liner) fixes the incident, but the listener does
not know whose hold it is: the rebase driver holds the flag across a whole flow
with `runner.running` false in between, so a resident CLI's self-wake would
release the tree mid-rebase. It also moves the release earlier in the sequence,
before `signalIdleIfIdle` — the signal that starts auto-remediation, which admits
itself only when the flag is clear. The test "leaves a hold taken by a driver
between turns alone" goes red under that form.

### 2. A wake reports whether it started a turn

`TurnHandle` gains `admitted: "started" | "queued" | "steered" | "refused"`,
recorded synchronously by `dispatchOnRunner` on every exit. It describes
admission only — pre-turn compaction can still re-queue a dispatch reported
`started`. `wakeSessionWithTurn` now returns the handle instead of discarding it,
so a caller can tell delivery from waiting: `services/consult-result-delivery.ts`
logs `queued a wake for session=…` rather than `woke …` and returns `admitted`
on its decision; `services/session-report.ts` and `merge-watch.ts` log the
non-`started` case. `createTurnSettlement` defaults to `started`, so a test fake
that returns a bare settlement still reports honestly.

The card's `wakeDelivery` stamp is unchanged: `queued` there already means
"dispatch accepted, not yet settled", and a queued wake still settles when it
drains.

### 3. A queued message after a system turn, and a queue branch that says so

A dispatch that arrives between a system turn's result and its exit queues behind
the hold, and `tryDrain` was spent at the result — so the non-streaming `done`
now ends with `releaseQueuedTurn` when anything is queued, after `finishTurn` has
released the hold. It was the incident's own symptom through a shorter path: no
adoption needed, just a wake landing in that window.

`releaseQueuedTurn` is the right primitive because every gate is inside it: it
declines while anything runs, while a hold is held, and while a merge is held.
Two orderings make it safe. It runs *after* `finishTurn`, which is what releases
this turn's hold — and `finishTurn` settles the turn in the same call, so a driver
that re-takes its hold synchronously (the rebase driver does) has already done so.
And it is skipped under `postTurn: "none"`, where the drain belongs to the owning
driver; `rebase-driver.test.ts`'s planning#338 displacement test is the guard that
named this rule.

`enqueueOrRefuse` warned only when it refused. The queue branch now logs the
session, the position and the same reason string, marking a system dispatch as
such — the line whose absence made the incident invisible in the logs. The other
way a dispatch ends up queued, pre-turn compaction pushing it back
(`dispatched-turn.ts`), logs the same way.

## Filed, not fixed here

Two defects review found in the same family — a hold with no owner left — are
in other subsystems and need their own design and tests:

- **planning#554** — a rebase flow releases its hold only `if (!runner.running)`,
  so a CLI-started turn adopted while it runs strands the hold with no owner at
  all: the same permanent stall, through the rebase door. Fixed on the ticket
  introduced here — see
  [docs/305-rebase-hold-identity](../305-rebase-hold-identity/plan.md).
- **planning#555** — a restart-adopted turn's quota or auth retry spreads
  `adopt: true` into the recursive `executeAgentTurn`, which then spawns an agent
  it never runs. Unrelated to holds; found while auditing the retry paths.

## Known residuals

1. **`admitted: "started"` is the decision at admission, not a promise the turn
   ran.** Pre-turn compaction can still push an admitted dispatch back into the
   queue; the log line above is the only correction its caller gets.
2. **`shipit session report` still prints "recipient(s) woken" for a queued
   wake.** The card is in the parent's transcript either way, so the word is not
   wrong about delivery, and the admission stays server-side in the log.
3. **The same "queued with nothing to drain it" shape exists on the streaming
   path**, where a message can queue between the turn's drain and its `done`.
   A system turn is never streaming, so it is not this incident; the release
   added here is deliberately on the non-streaming branch only.

## Guards

`src/server/orchestrator/system-turn-self-wake-hold.test.ts` drives the
production path (`runner.dispatch` → `dispatchOnRunner` → the real gates) with
the incident's event order, `agent_result` → `agent_self_wake` → `done`, on a
non-streaming system turn:

- **releases the hold, so a later wake starts a turn** — red with the old
  `turnIsCurrent()` condition.
- **a queue release drains a message sent after the adopted turn, and reaches
  idle** — red with the old condition (`releaseQueuedTurn` returned false).
- **starts a wake that queued behind the hold between the result and the exit** —
  red without the `release-queued` step.
- **neither releases nor drains under a hold taken while it was exiting** — red
  with `drainNext` keyed on `opts.systemTurn` alone.
- **leaves a hold that changed hands mid-turn alone** — red with the old
  `finishTurn` condition.
- **leaves a hold taken by a driver between turns alone** — red if the release
  moves into `adoptCliStartedTurn`.

Each was checked by making that one edit and watching that one test fail. Every
test waits on the turn's settlement callback, never on `runner.running`, which is
already false when the terminal sequence starts and so waits for nothing.

`services/consult-result-delivery.test.ts` covers the queued-admission decision
and its log line. It supplies the admission through its fake runner, so it pins
the service's reporting, not the dispatcher's gates.

## Key files

- `src/server/orchestrator/session-runner.ts` — `systemHoldSeq` on the interface
  and on `SessionRunner`; records the admission; logs the queue branch.
- `src/server/orchestrator/container-session-runner.ts` — the same hold ticket.
- `src/server/orchestrator/turn-executor.ts` — captures the hold, and
  `finishTurn`'s release of it.
- `src/server/orchestrator/dispatched-turn.ts` — `drainNext` takes its hold
  ownership from the executor; logs the compaction re-queue.
- `src/server/orchestrator/turn-settlement.ts` — `TurnAdmission`, `admitted`,
  `noteAdmission`.
- `src/server/orchestrator/wake-session.ts` — returns the `TurnHandle`.
- `src/server/orchestrator/services/consult-result-delivery.ts`,
  `services/session-report.ts`, `merge-watch.ts` — report a queued wake.
