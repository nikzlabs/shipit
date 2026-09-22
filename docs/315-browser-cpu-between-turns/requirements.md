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
2. A page is reclaimed at the end of the turn, and only when it is still consuming CPU
   then. A page sitting still costs nothing and is left alone, so a workflow that spans
   turns — navigate in one turn, look in the next — keeps working.
3. An agent that returns to its browser must find it usable. Reclaiming must never make
   a later browser tool call fail, and must never require the agent to know that a
   reclaim happened.
4. Reclaiming must never disturb a browser that is in use. Work in flight is not
   interrupted, and no tool call in progress fails because of it.
5. Agents keep the browser they have today. Building, previewing, screenshotting and
   interacting with a WebGL application must work exactly as well afterwards, at the same
   rendering quality.
6. Stopping the render is ShipIt's guarantee, not something the agent is asked to
   remember. It holds whatever the agent does, and for every agent backend.

## Open questions

_None. All four were resolved on 2026-09-22; see below._

## Resolved questions

- 2026-09-22 — **What counts as "stopped using"?** Answer: the end of the turn, but only
  when the page is still burning CPU at that moment. Turn end is an exact signal ShipIt
  already has, and the CPU gate is what keeps a static page alive across turns. This is
  req 2. The rejected alternatives were reclaiming at every turn end regardless (costs
  cross-turn workflows for no gain on pages that cost nothing) and an idle timer
  (burns CPU for the length of the window and adds a number to tune).
- 2026-09-22 — **"Still consuming CPU" (req 2) needs a number, and the number does not
  meet req 1 literally.** The threshold is 25 ticks/s, a quarter of a core. A canvas
  animation measures ~6 and is therefore left running, even though req 1's plain words
  ask for any abandoned rendering to stop. Recorded rather than quietly diverged from,
  because no threshold can do better: a real static page measures 3, so a line drawn low
  enough to catch a 6 would also reclaim settled pages that req 2 exists to protect, and
  a page costing 6% of a core is not what put a host at load 42. Raised by review.
- 2026-09-22 — **Is losing in-memory browser state acceptable?** Answer: yes. Killing the
  browser drops cookies, logins and `localStorage` along with the page, because
  `playwright-mcp` runs with `--isolated` and keeps the profile in memory. An agent that
  needs a login again does it again. Blanking the page instead would preserve the
  profile but needs a way to drive the agent's browser from outside the MCP server, and
  the extra mechanism is not worth a rare annoyance. Constrains req 3: "usable" means a
  working browser, not a preserved session.
- 2026-09-22 — **Does a CPU cap on the browser belong here?** Answer: no, it is separate
  work, filed as planning#614. The starved-by-its-own-browser case is real (a session
  measured that day was losing 4.5 of its 7 cores to a stale page while actively
  working) but it is independent of the reclaim and carries its own tradeoff — a cap
  slows legitimate screenshot work. Keeping it out is what keeps this feature small.
- 2026-09-22 — **ShipIt's guarantee or the agent's discipline?** Answer: ShipIt's
  guarantee, and no prompt change. docs/289 made the same call for the equivalent
  outcome (its req 2) rather than trusting the CLI. A resource leak that depends on the
  agent remembering is one the agent will forget. This is req 6.
- 2026-09-22 — Which of the two runaway browsers could be killed by hand for immediate
  relief? Only the idle one. The user pointed out that session
  `256425eb-3a44-4661-bcf8-5af1af02a60c` was actively running, and it was left alone;
  this is the origin of req 4, and of the case that became planning#614.

- 2026-09-22 — Which of the two runaway browsers could be killed by hand for immediate
  relief? Only the idle one. The user pointed out that session
  `256425eb-3a44-4661-bcf8-5af1af02a60c` was actively running, and it was left alone;
  this is the origin of req 3, and of the observation behind the req 5 open question.
