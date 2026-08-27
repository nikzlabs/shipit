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
10. The memory budget is the only setting rationing idle runtime. The
    **Max Idle Containers** count is removed.
11. The budget decides what ShipIt **stops**, never what it **refuses**. At the
    budget with nothing reclaimable — every session has a viewer or a running
    agent — ShipIt warns and keeps working, and reclaims as soon as something
    becomes idle. Nothing the user is actively using is stopped or blocked.
12. The memory warning the user sees reports usage against the budget that
    decides reclaim, and names that budget. A budget larger than the machine
    cannot disable the warning: the host's own memory stays the ceiling.

## Open questions

- (none)

## Resolved questions

- 2026-08-27 — *Does the Max Idle Containers count survive alongside the memory
  budget?* The user chose to drop it: memory is the only knob. Carried by
  req 10.
- 2026-08-27 — *At the budget with nothing reclaimable, refuse or exceed?* The
  user chose to exceed and warn. Carried by req 11.
- 2026-08-27 — *Should the memory-pressure banner, today measured against total
  host RAM, be measured against the configured budget instead?* The user raised
  this and asked for a recommendation. Recommended and adopted: the banner
  measures against the budget, because the budget is what decides eviction — on
  a 64 GB host with a 16 GB budget a host-measured banner would never fire, and
  previews would vanish with no warning. The host stays a hard ceiling
  (`min(hostTotal, budget)`), so an oversized budget cannot disable the warning
  and an unset budget reproduces today's behaviour. Carried by req 12.
- 2026-08-27 — *Which services survive an idle stop, the whole Compose stack or
  only the `auto` preview services?* The user chose the whole stack. Carried by
  req 7.
- 2026-08-27 — *Is the limit on kept-alive previews shared with the idle agent
  containers Max Idle Containers counts today, or a separate allowance of the
  same size?* Neither: the user asked for a **user-set memory budget for all of
  ShipIt** instead of a container count, "because not all the containers have
  the same load on the system." Carried by reqs 3 and 4; what becomes of the
  count setting is open above.
