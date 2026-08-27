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
3. The number of idle sessions that keep their previews running is limited by
   the existing **Max Idle Containers** setting.
4. While the host has enough memory, an idle session's preview is not stopped
   because of elapsed idle time alone.
5. Returning to such a session shows its preview immediately, with no wait for
   the services to start.
6. When a preview must be reclaimed — the limit in req 3 is exceeded, or the
   host is under memory pressure — the session returns to today's behaviour:
   the stack is stopped, and the user is told why through the surfaces that
   already report idle disposal.

## Open questions

- **Preview budget.** Req 3 names Max Idle Containers as the limit. Is that
  limit *shared* with the idle agent containers it counts today (one budget of
  N covering both), or a *separate* allowance of the same size (N idle agent
  containers **and** N idle preview stacks)? The two differ in peak host
  memory.
- **Which services survive.** Does the whole running Compose stack survive the
  idle stop — including `x-shipit-preview: manual` services such as a database
  or a queue the preview app talks to — or only the `auto` preview services,
  stopping the rest?

## Resolved questions

- (none yet)
