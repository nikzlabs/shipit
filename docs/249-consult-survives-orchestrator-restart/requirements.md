---
issue: https://linear.app/shipit-ai/issue/SHI-307
title: A sub-agent consult survives an orchestrator restart
description: What must be true of a `shipit agent run` consult whose orchestrator restarts while the run is in flight.
---

# Requirements — a sub-agent consult survives an orchestrator restart

Source: SHI-307, plus the spawning session's brief. Everything numbered below is
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

## Non-requirements

- Preventing orchestrator restarts, or draining in-flight consults before one.
  The restart is a given.
- Anything about the primary agent turn, which docs/240 already covers.

## Open questions

- **Must the sub-agent's output be recovered, or is an honest terminal card
  enough?** SHI-307 lists "the sub-agent's actual output is lost even though the
  work was done" as one of four harms, and lists a recovery mechanism as one of
  two undecided directions — it does not say which outcome is wanted. These are
  different products at different prices: an honest card is a boot-time
  reconcile over persisted cards; recovering the output means the worker
  retains a record of the run and the orchestrator re-reads it after restart,
  and still needs the honest-card path as its fallback for the cases where
  recovery is impossible (container gone, worker restarted too).

- **When the output is not recovered, what should the card say it was?** The
  issue offers `error` or `cancelled` without choosing. The two differ in what
  the user reads on the card face ("Cancelled asking Codex" vs an error) and in
  whether it looks like something went wrong with Codex.

## Resolved questions

_(none yet)_
