---
issue: planning#309
title: A sub-agent consult survives an orchestrator restart
description: What must be true of a `shipit agent run` consult whose orchestrator restarts while the run is in flight.
---

# Requirements — a sub-agent consult survives an orchestrator restart

Source: planning#309, plus the spawning session's brief. Everything numbered below is
stated in the issue or is directly observable from it. Anything I had to supply
myself is under [Open questions](#open-questions), not here.

## The situation these requirements are about

A user's agent runs `shipit agent run --agent codex …`. A consult card is
persisted `pending` at spawn time and the sub-agent starts working inside the
session's worker container. The orchestrator process then dies and restarts
(crash, deploy, `unless-stopped` bounce) while the run is still in flight.
Session containers have their own lifetime and keep running — as do the
sub-agents inside them.

## Requirements

1. A consult card must not stay `pending` forever. After the orchestrator
   restarts, every consult it can no longer finish must end up in a state the
   user reads as finished, not as still-running.

2. The UI must not show a consult as perpetually in progress. A card left over
   from a restart must stop rendering the "Asking Codex…" spinner state.

3. `shipit agent result <id>` must return a terminal answer for such a run
   rather than reporting `pending` on every call.

4. `shipit agent result --wait` must not sit against such a run until its
   timeout every single time. It must resolve.

5. The card must say what happened, in terms the user can act on — a consult
   interrupted by an orchestrator restart must be distinguishable from a
   sub-agent that genuinely errored or was cancelled by the user.

6. Whatever marks these cards terminal must never mark a *live* consult
   terminal. A run that is genuinely still in flight must keep reporting
   `pending` until it really finishes.

7. The change in what a waiting caller observes is intended, not incidental.
   `shipit agent result` exits `4` ("still running") for a `pending` card and
   `3` ("the run failed") for a terminal non-success one (docs/248). A stranded
   card today makes a caller loop on `4` forever; after this change the same
   caller gets `3` and stops. Anyone polling `shipit agent result` in a loop
   must be able to rely on that loop now terminating.

8. The consult's status must read as `cancelled` rather than as an error: the
   sub-agent did not fail, ShipIt cut the run short.

## Non-requirements

- **Recovering the sub-agent's output.** The work is lost and the caller re-runs
  the consult. See the resolved question below.
- Preventing orchestrator restarts, or draining in-flight consults before one.
  The restart is a given.
- Anything about the primary agent turn, which docs/240 already covers.

## Open questions

_(none)_

## Resolved questions

- **2026-08-04 — Must the sub-agent's output be recovered, or is an honest
  terminal card enough?** Asked with two options: an honest card only (a boot
  reconcile over persisted cards), or additionally recovering the output (a
  durable worker-side record plus a re-attach path, which still needs the
  honest-card path underneath it for when the container died too). Answer:
  **honest card only.** Recorded as the non-requirement above; requirements 1–7
  are unchanged by it.

- **2026-08-04 — When the output is not recovered, what should the card say it
  was, `error` or `cancelled`?** Answered as part of the same choice:
  **`cancelled`**, on the grounds that nothing went wrong with the sub-agent and
  an error-shaped card sends the reader hunting for a fault that isn't there.
  Added as requirement 8. This is what makes requirement 5 load-bearing rather
  than decorative — `cancelled` alone is indistinguishable from a consult the
  user cancelled, so the card has to carry the reason.
