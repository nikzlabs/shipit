---
title: In-flight work — current reclamation behavior
description: Verified map of every automatic path that destroys a session container, and what each one considers "busy".
---

# 256 — Current behavior, verified

Reference material for [`requirements.md`](requirements.md). This records what
the code does **today**, read at the source. It decides nothing.

## Two automatic reapers, and only two

Every other `containerManager.destroy` call site is an explicit user action or
a recovery path (`services/recovery.ts`, `services/session.ts:660`,
`restart-turn-reattach.ts`, warm-pool teardown). Unattended destruction comes
from exactly two places:

| | `idle-enforcer.ts` | `tier-escalation.ts` (`canAutoDescend`) |
|---|---|---|
| Fires | every 30s (`startup-monitors.ts:126`), plus edge-triggered on crossing memory pressure | startup, per session activation, hourly backstop |
| Trigger | more than `maxIdleContainers` (default 5) idle containers; 0 under pressure | idle **age** ≥ 24h (`hot → light`) |
| Skips a running turn | yes — `agentBusy` (`:128`, re-checked `:154`) | yes — `agentBusy` (`:143`) |
| Skips an attached viewer | yes (`:129`) | yes (`:144`) |
| Skips `keepPreviewRunning` | **yes** (`:113`, `:153`) | **no** |
| Skips `pinnedAt` | **no** | **yes** (`:137`) |

That last pair is the asymmetry: a pinned session is safe from the disk ladder
but not from idle disposal; an always-on preview is safe from idle disposal but
not from the disk ladder. Neither guard is defended in a comment as
deliberate — `canAutoDescend`'s docstring describes itself as "the single
chokepoint for BOTH the age-based descent and the disk-pressure LRU descent",
which is true of pins and silently untrue of reservations.

**The `keepPreviewRunning` half is a plain defect** and is fixed here. docs/241
states the reservation holds "across viewer disconnects, idle cleanup,
memory-pressure eviction, and orchestrator restarts", and the `hot → light`
rung disposes the runner and destroys the container
(`tier-escalation.ts:154-176`) — so a reserved preview nobody views for 24h
gets torn down by the ladder. Worse than a one-shot: the container exit is seen
by the health monitor, which calls the keep-preview restart supervisor
(`startup-monitors.ts:375`), so the ladder and the supervisor fight.

**The `pinnedAt` half is not a defect.** `pinnedAt`'s own type comment
(`shared/types/domain-types/session.ts:152-162`) scopes a pin to sidebar
persistence, the merged top-N cap exemption, and disk-tier immunity — never to
runtime. Widening it is a product decision, so it is an open question rather
than part of this fix.

## What the orchestrator can see

`runner.agentBusy` (`container-session-runner.ts:398`) is the only "this
session is working" signal both reapers consult:

```
agentBusy = _isRunning || backgroundTaskCount > 0 || subAgentSpawnsInFlight > 0
```

- `_isRunning` — an orchestrator-started or self-woken turn is in flight.
- `subAgentSpawnsInFlight` — `_subAgentAborts.size`, a fact the orchestrator
  **owns** (it holds the abort controller for each in-flight
  `shipit agent run`). No liveness gate, no decay. This is what keeps a
  backgrounded cross-agent consult alive, and it is the closest thing in the
  codebase to a lease. It is bounded by the worker's own wall-clock cap
  (`DEFAULT_SUB_AGENT_TIMEOUT_MS`, 30 min) plus a transport backstop
  (`SUB_AGENT_TRANSPORT_TIMEOUT_MS`, +5 min).
- `backgroundTaskCount` — a *reported hint* from the agent backend, and the
  weakest of the three (below).

A detached OS process — `nohup python3 pass-b.py &`, the docs/247 case — is in
none of these. The orchestrator has no view into the container's process table
at all, so that job contributes nothing to `agentBusy` and the session reads as
fully idle between turns.

## The background-task signal expires after 10 minutes

This one was not in the original survey and it materially narrows the existing
protection.

`BackgroundTaskTracker` (`background-task-tracker.ts`) records the backend's
task list and stamps `seenAt` when it arrives. `count()` returns 0 once
`now - seenAt >= BACKGROUND_TASK_TTL_MS` — which is `IDLE_GRACE_PERIOD_MS`,
**10 minutes** (`:42`, `:80`).

The list is emitted **only on change** (`adapter.ts:199`,
`agent-listeners.ts:482`; docs/235 probe B confirms a new turn and a fresh
`init` do not re-state it), there is no heartbeat, and there is no pull API to
re-ask with. So for a job that runs longer than 10 minutes, nothing ever
refreshes `seenAt`.

**Consequence:** even a job ShipIt *can* see — a proper
`Bash(run_in_background: true)` task rather than a detached `nohup` — stops
protecting its container 10 minutes after it starts. A 2-hour job is protected
for the first 8% of its life. The decay is deliberate and correct for what it
was built for (a dropped SSE frame must not pin a session unreclaimable
forever, `background-task-tracker.ts:1-29`), but it means the existing
mechanism cannot be the answer to requirement 2 without a refresh path.

## The rest of the picture

- **Idle alone does not reap.** Only the excess over `maxIdleContainers`
  (default 5, `credential-store.ts:562`) is destroyed, oldest-first. Under
  memory pressure (≥ 0.85 of host, `memory-pressure.ts:27`) the cap drops to 0
  and the 10-minute post-detach grace (`IDLE_GRACE_PERIOD_MS`) is bypassed
  entirely. So on a busy host the window is one 30s tick, not ten minutes.
- **A runner that never had a viewer skips the grace period**, since the check
  is written `lastViewerDetachAt > 0 && …` (`idle-enforcer.ts:135`).
- **`keepPreviewRunning` is not agent-settable.** It is a user toggle in the
  sidebar overflow menu, admission-capped at 1 by default
  (`services/session.ts:490,526-534`). The `shipit` shim exposes no
  keep-alive of any kind (`agent-shim/shipit.ts` HELP).
- **Disposal is guarded twice.** `runner.dispose()` refuses on `_isRunning` or
  a live sub-agent spawn unless forced (`container-session-runner.ts:2521`,
  `:2531`), and since planning#298 the idle enforcer destroys the container only
  after the runner accepted disposal. Any new protection expressed as runner
  state inherits both.
- **`keepalive.ts` is unrelated** — a WebSocket ping for Cloudflare's 100s
  proxy cut.

## What the docs promise the agent today

`shipit-docs/environment.md:156-200` is explicit and correct: in-container
background work does not survive, the 10-minute grace is "a cushion, not a
guarantee", and durable work belongs in a Compose service or `agent.install`.
docs/235's own "Bounds" section says the same. So the current behavior is
documented, not accidental — requirement 2 asks to change the product, not to
repair a broken promise.
