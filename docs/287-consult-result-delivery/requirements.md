---
issue: planning#500
title: Delivering a backgrounded consult's result
description: A finished `shipit agent run` consult must reach the agent that asked for it, and the session must not stay busy after a one-shot turn ends.
---

# Delivering a backgrounded consult's result

1. A background `shipit agent run` consult that finishes must re-invoke the
   agent that started it, so the agent acts on the result without the user
   having to type anything.
2. That must hold on a turn ShipIt started itself — a merged-child wake, a
   child-session report, the rebase driver, CI auto-fix — not only on a turn the
   user typed.
3. It must not produce a second, redundant turn when the agent is already going
   to see the result: the consult's own call is still returning it on stdout, or
   the resident CLI is about to raise it as a self-wake.
4. A delivery attempt must be recorded on the consult card, including when the
   woken turn did not run, so an operator or an agent reading the card back can
   tell whether the hand-over happened.
5. Delivery must never cost the caller its result: the sub-agent's output, its
   consult card, and `shipit agent result` all keep working whatever the
   delivery does.
6. A session must not read as busy after its turn's process has exited. A user
   looking at the sidebar has to be able to tell that the agent has stopped.

## Open questions

- None.

## Resolved questions

- 2026-09-03 — *Should the card FACE render the delivery record?* No, not in this
  change. The record exists so the state is auditable — from the DB, from the
  orchestrator log, and from `shipit agent result --json`, which returns the
  stored card. Rendering it would add a UI element for a state the user cannot
  act on. Req 4 says "recorded", not "rendered", for that reason.
- 2026-09-03 — *Should a `cancelled` consult also wake the session?* No. A
  `cancelled` card means ShipIt took the session away from the run (container
  teardown, forced dispose, the boot reconcile after a restart); there is no
  result to act on and the wake would boot a container that was just stopped.
  `error` and `timeout` do wake — they are answers the agent asked for.
- 2026-09-03 — *Should system turns simply be made streaming, so the CLI's own
  self-wake works there?* No. `systemTurn` carries more than the streaming
  choice: it blocks steering (`shouldSteerMessage` / `systemTurnInProgress`), it
  gates the clean-spawn-boundary kill at `dispatched-turn.ts`, and
  `docs/240-unlosable-turn-dispatch/plan.md:166` records "a wake turn is always
  `systemTurn: true`, hence never steerable" as an invariant other code depends
  on. Delivering the result explicitly also repairs cases relaxing that gate
  would not: a SIGTERMed shim, a container restart, a crashed CLI, a disposed
  runner.
