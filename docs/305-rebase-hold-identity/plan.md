---
issue: planning#554
title: A rebase flow releases its own system hold, not whatever the flag holds
description: Why the rebase driver's release keyed on runner.running stranded the hold, and how the docs/304 hold ticket closes it.
---

# A rebase flow releases its own system hold

Implements [requirements.md](./requirements.md). Applies the hold ticket from
[docs/304-stranded-system-turn-hold](../304-stranded-system-turn-hold/plan.md) to
the one owner that predates it: the rebase driver.

## Root cause

`services/rebase-driver.ts` holds `systemTurnInProgress` across a whole rebase, so
user turns queue between resolution turns and through the final push. Its `finally`
released that hold only when nothing was running:

```ts
// A displacing turn owns its flag and queue drain.
if (!runner.running) { runner.systemTurnInProgress = false; releaseQueuedTurn(runner); }
```

That condition was written for planning#338, where a turn really did displace the
driver. It is not an ownership check, and it fails in both directions (req 1, req 2):

- **A turn can run without owning the hold.** A resident CLI raising
  `agent_self_wake` while the flow is between git steps makes `adoptCliStartedTurn`
  (`ws-handlers/agent-listeners.ts`) set `runner.running = true` for a turn ShipIt
  never dispatched, which takes no hold. The flow then skips its release, and the
  adopted turn's own teardown cannot release it either — `finishTurn` releases only
  for `input.systemTurn`. The hold is left set with no owner: every later dispatch
  queues behind it and only an orchestrator restart clears it (req 4).
- **The hold can change hands with no turn running.** Another owner acquiring
  mid-flow leaves `runner.running` false, so the flow cleared *their* hold and
  drained the queue under it — the docs/304 compaction-over-rebase hole, mirrored.

## The fix

The driver keys its release on the hold's identity, the `systemHoldSeq` ticket
docs/304 mints on every write of `true`:

```ts
function takeSystemHold(runner: SessionRunnerInterface, hold: DriverHold): void {
  runner.systemTurnInProgress = true;
  hold.seq = runner.systemHoldSeq;
}
…
if (runner.systemHoldSeq === hold.seq) runner.systemTurnInProgress = false;
releaseQueuedTurn(runner);
```

Acquisition goes through one function so no site can take the hold without
capturing the ticket it must release on — the driver acquires twice, once at entry
and once inside each resolution turn's `onTurnComplete`, because `finishTurn`
clears the per-turn flag the turn minted for itself.

A displacing turn minted a ticket of its own, so the comparison keeps planning#338's
rule intact; an adopted turn minted none, so it no longer blocks the release.
Calling `releaseQueuedTurn` while an adopted turn runs is a safe no-op — it declines
on `runner.running` — and the adopted turn's own `release-queued` step drains the
queue when it ends.

**The drain is deliberately NOT under that ticket check** (req 3). Review of this
branch found the case that separates the two: the abort endpoint emits `superseded`
*before* it clears `runner.running` (`api-routes-git.ts`), so the resolution turn
settles with a turn still apparently running, the driver skips its re-take, and its
ticket is stale by the time the flow unwinds. The flag is already correct there —
`finishTurn` released the turn's own hold — but a message queued before the abort had
nothing left to start it: a resolution turn runs under `postTurn: "none"`, so its
teardown never drains. `releaseQueuedTurn` carries every gate itself (it declines
while a turn runs, while any hold is held, and while a merge is held), so calling it
unconditionally starts a turn only when nothing else can.

**The re-take was left on `!runner.running`.** It is not a clean ownership test
either — the abort path above skips it with nothing displacing the driver — but every
state it reaches is already correct, and widening it buys nothing: in the ordinary
`agent_result → agent_self_wake → done` order the turn settles from the `done` path
with `running` already false, so an adopted turn never blocks it. A fixture that
adopts a CLI-started turn over the resolution turn observes `running: false` at the
settlement, which is what ruled the wider change out.

## Guards

In `src/server/orchestrator/services/rebase-driver.test.ts`, both driving
`runRebaseFlow` with the adoption injected at the flow's push step — a real
non-turn window of the flow:

- **releases the hold when a CLI-started turn was adopted mid-flow** — asserts the
  flag is clear and that a message queued during the flow then drains. Red with
  `!runner.running`: the flag stays set and `releaseQueuedTurn` returns false.
- **leaves a hold taken over mid-flow alone, and drains nothing under it** — red
  with `!runner.running`, which cleared the other owner's hold and drained under it.

In `src/server/orchestrator/integration_tests/rebase-flow.test.ts`, over the real
HTTP endpoints and the real dispatcher:

- **rebase abort endpoint — drains a message queued before the abort** — red with
  the drain placed under the ticket check: the queued turn never starts. The
  repo's existing abort test sends its message *after* the abort, so it cannot
  see this.

Each was checked red by making that one edit alone.

## Known residuals

**The drain reads no git state, so a failed abort can still hand a queued turn a
mid-rebase tree** — filed as planning#566. `releaseQueuedTurn`'s gates are
`runner.running`, `systemTurnInProgress`, `mergeHold` and an empty queue; none of
them knows whether `git rebase --abort` succeeded. The flow already computes that
verdict when it reports "the workspace is still mid-rebase", and then discards it.
The same shape lets the driver's drain outrun the abort endpoint's own LFS restore.
Both predate this change — the old `!runner.running` release drained on every one of
those paths too — and the obvious guard swaps a turn on a broken tree for a queue
nothing will ever drain, which is a decision rather than a fix.

## Key files

- `src/server/orchestrator/services/rebase-driver.ts` — `DriverHold`,
  `takeSystemHold`, and the ticket-keyed release in `runRebaseFlow`'s `finally`.
- `src/server/orchestrator/session-runner.ts` — `systemHoldSeq`, from docs/304.
- `src/server/orchestrator/queue-drain.ts` — `releaseQueuedTurn`, whose own gates
  are what make the unconditional call safe.
- `src/server/orchestrator/api-routes-git.ts` — the abort endpoint's ordering.
