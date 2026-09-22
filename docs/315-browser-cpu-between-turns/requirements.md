---
issue: planning#612
title: Browser CPU between turns
description: A page the agent has stopped looking at must stop consuming CPU, without taking away the browser it may come back to.
---

# Browser CPU between turns

The agent's headless browser keeps rendering a page long after the turn that opened it
ended. On production on 2026-09-22 two sessions held ~10 of a 16-core host this way, one
of them for 4h45m, and each consumed its own container's entire 7-core quota. The page
does not have to be unusual: both were WebGL games an agent had previewed and moved on
from. Full measurement and reproduction in planning#612.

This is the gap next to [docs/289-agent-process-tree-teardown](../289-agent-process-tree-teardown/plan.md),
which makes the browser die with the **agent CLI**. Here the CLI is alive and healthy;
what has ended is the **turn**.

1. A page the agent has stopped using must stop consuming CPU, without the user or the
   agent having to ask.
2. An agent that returns to its browser must find it usable. Reclaiming must never make
   a later browser tool call fail, and must never require the agent to know that a
   reclaim happened.
3. Reclaiming must never disturb a browser that is in use. Work in flight is not
   interrupted, and no tool call in progress fails because of it.
4. Agents keep the browser they have today. Building, previewing, screenshotting and
   interacting with a WebGL application must work exactly as well afterwards, at the same
   rendering quality.
5. One session's browser must not be able to degrade other sessions on the host.

## Open questions

- **What counts as "stopped using" (req 1)?** The end of the turn that last touched the
  browser is an exact signal ShipIt already has, but it breaks a workflow that spans
  turns — navigate in one turn, snapshot in the next. An idle timer keeps that working
  and leaves a window in which CPU is still burned. Which, and if a timer, how long?
- **Is losing in-memory browser state an acceptable cost of reclaiming (req 2)?**
  `playwright-mcp` runs with `--isolated`, so the profile lives in memory. Tearing the
  browser down drops cookies, logins and `localStorage` along with the page, so an agent
  that logged into something in an earlier turn would have to log in again. Navigating
  the page to `about:blank` instead would stop the rendering and keep the profile, but
  it is not obviously reachable from outside the MCP server.
- **Does req 5 belong in this feature?** The active session measured on 2026-09-22 was
  being starved by its *own* browser, which req 1 does not cover because that page was
  arguably still in use. Capping or deprioritizing the browser's CPU would cover it and
  is independent of any reclaim. In scope here, or a separate piece of work?
- **Should this be ShipIt's guarantee or the agent's discipline?** Instructing the agent
  to close the page when it is done is much cheaper, and is the kind of thing agents
  forget. docs/289 chose to make the equivalent outcome ShipIt's guarantee rather than
  the CLI's (its req 2). Same call here?

## Resolved questions

- 2026-09-22 — Which of the two runaway browsers could be killed by hand for immediate
  relief? Only the idle one. The user pointed out that session
  `256425eb-3a44-4661-bcf8-5af1af02a60c` was actively running, and it was left alone;
  this is the origin of req 3, and of the observation behind the req 5 open question.
