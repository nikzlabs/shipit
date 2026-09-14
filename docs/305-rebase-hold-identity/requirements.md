# A rebase flow releases its own system hold

1. A rebase flow that took `systemTurnInProgress` releases it when the flow ends,
   even if a turn ShipIt never dispatched is running at that moment.
2. A rebase flow never clears a hold another owner has taken over, and never
   drains the queue under one.
3. A session is never left with `systemTurnInProgress` set and no owner, which
   queues every later dispatch until the orchestrator restarts.

## Open questions

_None._

## Resolved questions

- 2026-09-14 — Should the driver's *re-take* between resolution turns change too?
  No. The re-take reads `!runner.running`, and a resolution turn always settles
  with `running` already false, so an adopted turn cannot block it; the only case
  it skips is a real displacement. Verified by a fixture that adopts a CLI turn
  over the resolution turn and observes `running: false` at the settlement.
