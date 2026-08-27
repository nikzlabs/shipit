---
issue: planning#481
title: Idle preview survives the agent container
description: When a session goes idle, stop its agent container but keep its preview services running while host memory allows.
---

# 284 — Idle preview survives the agent container

Today an idle session loses two things at once: its agent container **and** its
Compose preview stack. Coming back to the session means waiting for both to
start again. Only the first of those two teardowns is wanted.

## Requirements

1. When a session becomes idle, its preview services continue to run and stay
   reachable at their preview URLs.
2. Stopping the session's **agent** container when the session becomes idle
   stays acceptable. This feature does not change that behaviour.
3. How many idle sessions keep their previews running is limited by **memory**,
   not by a container count: the user sets one memory budget for ShipIt, and
   idle previews keep running until that budget is reached.
4. The budget covers everything ShipIt runs — the orchestrator, session
   containers, and Compose service containers — because a count of containers
   is a poor proxy for load, which is what the user is actually rationing.
5. While the budget is not reached, an idle session's preview is not stopped
   because of elapsed idle time alone.
6. Returning to such a session shows its preview immediately, with no wait for
   the services to start.
7. The **whole** running Compose stack survives the idle stop, including
   services marked `x-shipit-preview: manual` such as a database or a queue.
   A live preview URL serving errors because its backend was stopped is worse
   than a clean stop.
8. When something must be reclaimed to stay inside the budget, the session
   returns to today's behaviour: the stack is stopped, and the user is told why
   through the surfaces that already report idle disposal.
9. On an install where the user has not set a budget, ShipIt behaves as it does
   today rather than changing memory behaviour silently.

## Open questions

- **What happens to Max Idle Containers.** Req 3 replaces the count with a
  memory budget. Does the existing **Max Idle Containers** setting go away,
  stay as a secondary hard ceiling on top of the budget, or keep governing
  agent containers while the budget governs only previews?
- **Hard cap or reclaim target.** When the budget is reached and nothing is
  idle — every session has a viewer or a running agent — does ShipIt refuse to
  start more (new sessions, new services), or does it exceed the budget and
  warn, reclaiming only once something goes idle?

## Resolved questions

- 2026-08-27 — *Which services survive an idle stop, the whole Compose stack or
  only the `auto` preview services?* The user chose the whole stack. Carried by
  req 7.
- 2026-08-27 — *Is the limit on kept-alive previews shared with the idle agent
  containers Max Idle Containers counts today, or a separate allowance of the
  same size?* Neither: the user asked for a **user-set memory budget for all of
  ShipIt** instead of a container count, "because not all the containers have
  the same load on the system." Carried by reqs 3 and 4; what becomes of the
  count setting is open above.
