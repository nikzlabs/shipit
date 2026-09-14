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
  queues behind it and only an orchestrator restart clears it (req 3).
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
if (runner.systemHoldSeq === hold.seq) {
  runner.systemTurnInProgress = false;
  releaseQueuedTurn(runner);
}
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

**The re-take was left on `!runner.running` deliberately.** A resolution turn
settles from the `done` path with `running` already false, so an adopted turn cannot
reach that branch; the only case it skips is a genuine displacement, where the flow
is about to abort anyway. A fixture that adopts a CLI-started turn over the
resolution turn observes `running: false` at the settlement, which is what ruled the
wider change out.

## Guards

In `src/server/orchestrator/services/rebase-driver.test.ts`, both driving
`runRebaseFlow` with the adoption injected at the flow's push step — a real
non-turn window of the flow:

- **releases the hold when a CLI-started turn was adopted mid-flow** — asserts the
  flag is clear and that a message queued during the flow then drains. Red with
  `!runner.running`: the flag stays set and `releaseQueuedTurn` returns false.
- **leaves a hold taken over mid-flow alone, and drains nothing under it** — red
  with `!runner.running`, which cleared the other owner's hold and drained under it.

Both were checked red by restoring the old condition alone.

## Key files

- `src/server/orchestrator/services/rebase-driver.ts` — `DriverHold`,
  `takeSystemHold`, and the ticket-keyed release in `runRebaseFlow`'s `finally`.
- `src/server/orchestrator/session-runner.ts` — `systemHoldSeq`, from docs/304.
