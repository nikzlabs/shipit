---
issue: planning#612
title: Browser CPU between turns
description: At turn end, a browser still rendering is torn down; one sitting still is left alone.
---

# Browser CPU between turns

Implements [requirements.md](./requirements.md).

## The defect

`playwright-mcp` has no idle-browser timeout, so the browser lives as long as the MCP
server, which lives as long as the agent CLI, which lives as long as the container. A
page that animates therefore renders until the container dies, whether or not anybody is
reading it.

Headless Chromium has no GPU, so WebGL falls back to SwiftShader, which rasterizes every
frame across a worker thread per visible core. Inside a session container `nproc` reports
the **host's** core count, not the container's quota — 16 against a 7-core `cpu.max` on
the production host — so the pool is sized to overrun the quota by design.

Measured on `shipit-prod` 2026-09-22 (planning#612): two sessions, both building games,
held ~10 of a 16-core host. One had been rendering for **4h45m at 639%** with its agent
idle at 0.5%; the other was burning 455% of its own 700% quota *while actively working*,
starving its own agent. Two containers out of 330 produced the load.

Reproduced in a session container, sampling `/proc/<pid>/stat`:

| Page | ticks/s (100 = one core) |
|---|---|
| `about:blank` | 0 |
| A real static page (CSS transitions, a form, a table) | 3 |
| Canvas 2D `requestAnimationFrame` | ~6 |
| WebGL `requestAnimationFrame`, 1280x800 | **587** |

This is the gap beside [docs/289-agent-process-tree-teardown](../289-agent-process-tree-teardown/plan.md),
whose observed leak was the same shape — an animated page burning half a core after a
turn. That doc makes the browser die with the **agent CLI**; here the CLI is alive and
healthy and what ended is the **turn**, so none of its call sites fire.

## Mechanism: sample at turn end, kill only what is still rendering

`reclaimStillRenderingBrowsers` (`session/agents/browser-reclaim.ts`) runs from
`AgentController.endTurn()`:

1. **Find the browsers we own.** Walk descendants of the worker's own pid; keep a process
   whose cmdline carries Playwright's `--remote-debugging-pipe` — present on the top
   browser process and on nothing below it — **and** whose parent's cmdline names
   `playwright-mcp`. A browser the user's project launched has a test runner for a
   parent and is not ours to touch.
2. **Sample** the tree's `utime + stime` over 1s, **per process identity**, re-walking
   descendants each time because renderer and GPU processes come and go under the root.
3. **Kill** the tree when the rate clears `BUSY_TICKS_PER_SEC`, via `killDescendantTree`.

Not awaited. The turn is already reported finished by the time `endTurn` runs, and the
second of sampling must not delay the next turn. A re-entry flag keeps one in flight, and
a pass skipped because something was in the way is **deferred, not dropped** — whatever
clears the block calls back in, including a sub-agent spawn completing. Dropping it would
leave the abandoned browser rendering until some later turn happened to end at a quiet
moment, which is the defect itself.

### A difference of totals is not the CPU burned

The first version subtracted one tree total from another, and a review reproduced the
failure: when a process exits between samples its **entire lifetime** leaves the second
total, so a GPU process with hours on it swamps everything its siblings burned during the
window and a pegged tree reads as settled. `ticksBurned` therefore matches processes by
pid **and `startTime`** and sums per-process deltas: present in both, take the delta;
newly appeared, take all of it, since it can only have run inside the window; vanished,
take nothing, because nothing available here says how much of its lifetime fell inside
the window. That last case undercounts, which errs toward keeping a browser rather than
killing a live one. The rate divides by real elapsed time, not the requested delay, so a
timer firing late under load cannot inflate it.

### Why the threshold is 25 and not 5

A static page costs 3 ticks/s and a light canvas animation ~6, so **no threshold
separates them** — and none needs to, because both cost a few percent of a core. The
number that matters is the distance to the case worth reclaiming: 25 sits an order of
magnitude under WebGL's 587 and clear of a settled page, which req 2 promises to keep.
The first draft used 5, which left a 2-tick margin over a real static page and would have
reclaimed pages req 2 exists to protect.

### Why kill the browser rather than blank the page

Navigating to `about:blank` would stop the rendering and keep the in-memory `--isolated`
profile, but `playwright-mcp` exposes no way in from outside, and driving it would need
machinery that does not exist. Killing is complete and cheap: the whole tree exits, and
the MCP server launches a fresh browser lazily on the next tool call. The cost is the
profile — cookies, logins and `localStorage` go with the page. Accepted (requirements,
resolved 2026-09-22).

### Where the guards are

- **Ownership is the walk.** `killDescendantTree` (new, in `shared/kill-child.ts`)
  carries `killProcessTree`'s discipline to a root we hold no `ChildProcess` for.
  `killProcessTree` proves ownership with `ppid === process.pid`, which cannot reach a
  grandchild: the tree is worker → agent CLI → `playwright-mcp` → browser. So ownership
  is re-established by re-walking from our own pid and requiring the root to appear in
  it, with its `startTime` unchanged. Everything else is reused — `signalIdentity`'s
  start-time check against pid reuse, and the 5s SIGKILL sweep that re-walks survivors.
- **A turn that starts mid-sample cancels the kill** (req 4). `stillIdle` is re-read
  after the sample and before each kill, so the browser is never signalled out from
  under a live turn.
- **"Unattended" is not `turnActive` alone.** A sub-agent spawn outlives the primary turn
  on purpose (the note at the top of `agent-controller.ts`) and drives a browser of its
  own, which the reclaim would have found and killed mid-use — a `shipit agent run`
  review being the obvious victim. `browsersAreUnattended()` requires an empty
  `spawnedAgents` as well, and is checked both before starting and inside `stillIdle`.
- **Every backend, and the crash paths too** (req 6). `endTurn` is the worker's single
  turn-end: `agent_result` reaches it directly, and `done` / `error` reach it through
  `vacateSlot`.

## Verified

Against the real MCP browser in a session container, not only in tests: detection found
exactly one managed root; the WebGL page measured 587 ticks/s and the real static page 3;
killing the tree left `playwright-mcp` alive, and the next `browser_navigate` relaunched
the browser and succeeded with nothing for the agent to notice (req 3).

## Known limits

Stated rather than fixed, all three raised by the independent review.

- **The teardown overlaps the start of the next turn.** `killDescendantTree` returns
  after SIGTERM and SIGKILLs survivors 5s later, so a turn starting inside that window
  could issue a browser call against a connection that is going away. The idle check
  stops a reclaim from *starting* during a turn but cannot un-send a signal. The blast
  radius is one tool call that may need retrying, against a browser the agent was not
  using a moment earlier; closing it properly would need a handshake with the MCP server,
  which has no interface for one. The verified relaunch below does not test this overlap.
- **Detection is substring matching on a command line, not identity.** It is anchored to
  `PLAYWRIGHT_MCP_BIN`, the name `playwright-mcp.ts` execs, so the two move together —
  but a project runner invoked through a path that happens to contain that name would
  match, and invoking the package some other way would be missed.
- **An orphaned browser is invisible.** One whose MCP server died is reparented to pid 1
  and no walk from us can reach it. That is docs/289's case, not this one's.

## Not covered here

A browser in genuine use can still take the whole container quota, which is what starved
the second session measured. That is planning#614, deliberately out of scope
(requirements, resolved 2026-09-22): it is independent of the reclaim, and a cap slows
legitimate screenshot work.

## Key files

- `src/server/session/agents/browser-reclaim.ts` — detection, the CPU sample, the gate
- `src/server/session/agents/browser-reclaim.test.ts` — real process trees, as
  `kill-child.test.ts` does; a fixture's markers ride in the parent's script **path** and
  the child's **argv**, because node parses a `--flag` after `-e` as its own option
- `src/server/shared/kill-child.ts` — `killDescendantTree`
- `src/server/session/agent-controller.ts` — the `endTurn` hook
