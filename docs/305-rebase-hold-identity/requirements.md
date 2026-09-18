# A rebase flow releases its own system hold

1. A rebase flow that took `systemTurnInProgress` releases it when the flow ends,
   even if a turn ShipIt never dispatched is running at that moment.
2. A rebase flow never clears a hold another owner has taken over, and never
   starts a queued turn under one.
3. A message queued during a rebase flow always starts once the flow ends and
   nothing else holds the session — including when the flow ended at the abort
   endpoint.
4. A session is never left with `systemTurnInProgress` set and no owner, which
   queues every later dispatch until the orchestrator restarts.

## Open questions

_None._

## Resolved questions

- 2026-09-14 — Should the driver's *re-take* between resolution turns change too?
  No. Review found one real case where it is skipped without a displacement — the
  abort endpoint settles the turn before it clears `runner.running` — but the
  end state there is already correct, and what that case actually loses is the
  queue drain. Req 3 covers it directly instead.
