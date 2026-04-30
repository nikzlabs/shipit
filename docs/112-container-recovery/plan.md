---
status: in-progress
---

# Container recovery — debug visibility + escalation actions

## Problem

Sessions occasionally enter a "hung" state where:
- User messages send but the agent never responds.
- The shell tab returns no output and accepts no input.
- The interrupt button does nothing.

The user has no visibility into *which* layer is broken (agent process,
worker HTTP, SSE stream, container itself) and no recovery action short
of archiving the session and starting over. The orchestrator only
reacts to Docker `die` / `oom` events
(`container-health.ts:43–92`); a wedged-but-alive container is
invisible.

## The three failure modes

The "hang" symptom is actually three distinct bugs that need different
recovery paths:

1. **Agent process stuck** — Claude CLI hung mid-turn. Container fine,
   worker HTTP fine. *Today's fix*: Interrupt button (`/agent/interrupt`).
2. **Worker HTTP unresponsive** — `session-worker.ts` Fastify wedged,
   OOM, deadlock. `/agent/start`, `/terminal/start`, `/health` all stop
   responding. *Today's fix*: none. The orchestrator only sees crashes,
   not livelocks.
3. **SSE stream broke but container is healthy** — browser thinks it's
   hung; server is fine. *Today's fix*: WS reconnect logic auto-replays
   the terminal buffer (`container-session-runner.ts:614`). Usually
   self-heals.

The user's report ("messages send but nothing happens, shell doesn't
work") is mode 2. Interrupt doesn't help because the worker is dead.

## Design — three layers, escalating

### A. Diagnosis (debug visibility)

A small **session health strip** at the top of the Terminal tab
showing four signals:

| Signal | Source |
|---|---|
| Container state | `containerManager.get(sessionId)?.status` (Docker label) |
| Worker reachable + latency | `GET /health` on the worker, 3s timeout |
| Agent state | `GET /agent/status` on the worker |
| Last SSE event (seconds ago) | New `lastSseEventAt` on `ContainerSessionRunner` |

Aggregated by a new `getContainerHealth()` service into a single HTTP
response so the client makes one round-trip. Client polls every 10s
while the Terminal tab is mounted. Importantly, this poll is *separate*
from the worker SSE stream — when the SSE stream breaks (mode 2/3), the
poll is exactly the channel the user needs.

The strip turns red when the worker is unreachable, yellow when the
last SSE event is stale (>30s) or the agent is `running` but worker
reports otherwise.

### B. Recovery actions (escalation ladder)

Three buttons mapped to the three failure modes:

| Action | What it does | Mode it fixes |
|---|---|---|
| Interrupt agent *(exists)* | `POST /agent/interrupt` (SIGINT) | 1 |
| **Kill agent** *(new)* | `POST /agent/kill` (SIGKILL) | 1, when interrupt didn't take |
| **Restart container** *(new)* | Kill agent → destroy container → dispose runner. Client reconnects WS → factory creates fresh container. | 2 |

Both new actions are exposed as **HTTP routes**, not WS messages.
Reasoning:

- The orchestrator owns Docker, not the worker. Restart works even when
  the worker is dead.
- HTTP gives a clean ACK; WS messages can queue or get lost in
  pathological states.
- Matches the pattern of other lifecycle operations (archive, full
  reset).

The interrupt button stays on WS for now (it's a hot path during normal
use, not a recovery action).

#### Restart flow

```
POST /api/sessions/:id/container/restart
  → runner.emitMessage({ type: "container_restarting" })   // notify viewers
  → runner.killAgentOnWorker()                              // best-effort SIGKILL
  → runnerRegistry.dispose(sessionId, { force: true })      // tear down runner
  → containerManager.destroy(sessionId)                     // stop + remove
  → 200 { ok: true }

Client:
  → shows "Restarting container…" overlay on receipt of WS message
  → on HTTP 200, closes the per-session WS
  → reconnects to /ws/sessions/:id (existing exponential-backoff path)
  → activate-session triggers the runner factory → fresh container starts
  → user sees a normal session resume
```

This composes with the *existing* runner factory in
`app-lifecycle.ts:160`, which already handles the "stale container
exists, replace it" case. We don't need a new code path — we just need
to put the system into the state the factory already knows how to
recover from.

#### Kill agent flow

```
POST /api/sessions/:id/agent/kill
  → runner.wasInterrupted = true
  → runner.killAgentOnWorker()    // POST /agent/kill on worker → SIGKILL
  → runner.emitMessage({ type: "claude_interrupted" })
  → 200 { ok: true }
```

Defensive: if the worker is unreachable, the request returns
`502 worker_unreachable` and the UI advises restarting the container.

### C. Auto-watchdog (defense in depth)

Periodic worker `/health` probe inside `ContainerSessionRunner` (every
30s). After 3 consecutive failures while Docker reports the container
`running`, emit a `container_unresponsive` event. The client
shows a banner: *"Agent container is not responding. [Restart container]"*.

We deliberately do **not** auto-restart — a long agent turn can look
like a hang to a probe but is just slow. Auto-detection only surfaces
the situation; the user makes the call.

**On C's status:** C *can* be implemented today — there are no missing
primitives. But it's sequenced last because:

- It needs A's UI surface (the strip becomes the banner host).
- It needs B's restart action (the banner button has to *do* something).
- The thresholds (3 failures × 30s = 90s before banner) need empirical
  tuning we don't have yet. Shipping C blind risks false-positive
  banners during slow agent turns.

So C is *unblocked but deferred* — pick up after we've watched A+B in
production for a few weeks.

## Where the controls live

The user asked for the Terminal tab. That's where the diagnostic strip
goes. Both action buttons (Kill agent, Restart container) live in the
strip alongside the diagnostics — same place users instinctively look
when something feels broken.

The existing Interrupt button stays in `MessageInput` (it's a hot path,
not a recovery action). We deliberately do *not* add Kill / Restart to
the chat input chrome — that conflates "interrupt my agent" with
"recover from a stuck container," and the latter is rare enough that it
shouldn't sit on the primary surface.

This stays compatible with product principle §5 (chat is input, agent
is actor). Recovery affordances are a category exception: the agent
literally cannot restart its own container, so the buttons aren't
"shell-shaped affordances for things the agent could do." They're the
manual override for when the agent is dead.

## Key files

### Server

- `src/server/orchestrator/services/health.ts` *(new)* — aggregates the
  four signals into one `ContainerHealth` object.
- `src/server/orchestrator/services/recovery.ts` *(new)* —
  `killAgent()` and `restartContainer()` services.
- `src/server/orchestrator/api-routes-container.ts` *(new)* — HTTP
  routes for `GET /api/sessions/:id/container/health`,
  `POST /api/sessions/:id/agent/kill`,
  `POST /api/sessions/:id/container/restart`.
- `src/server/orchestrator/api-routes.ts` — register the new route
  module.
- `src/server/orchestrator/container-session-runner.ts` — track
  `_lastSseEventAt` updated in `handleSSEEvent()`; expose as getter.
- `src/server/orchestrator/worker-http.ts` — add optional `timeoutMs`
  to `workerGet`/`workerPost` so health probes don't hang the request.
- `src/server/shared/types/ws-server-messages.ts` — new
  `container_restarting` server message type.

### Client

- `src/client/components/SessionHealthStrip.tsx` *(new)* — polls the
  health endpoint every 10s, renders dot + state labels, hosts the two
  recovery buttons.
- `src/client/components/TerminalPanel.tsx` — embed the strip above
  the existing tab content; thread `sessionId` prop through.
- `src/client/AppLayout.tsx` — pass `sessionId` to `TerminalPanel`.

## Patterns this fits into

- **Service layer** (`server-architecture` skill): new
  `services/health.ts` and `services/recovery.ts` follow the existing
  three-tier pattern (routes → services → managers). Routes do
  validation + ServiceError handling; services compose manager calls.
- **WebSocket lifecycle independence** (CLAUDE.md): the restart route
  destroys the runner via the registry, then on next WS reconnect the
  factory creates a fresh container. No WS-driven server-side teardown.
- **Idempotent recovery**: kill + restart are safe to retry. If the
  worker is already dead, kill returns 502 cleanly; if the container
  is already gone, restart still creates a fresh one.

## Out of scope for this iteration

- Automatic restart (deliberately deferred — see C).
- Restart-with-warm-pool (i.e. re-using a standby container when
  restarting). Adds complexity for marginal benefit during a recovery
  flow that should be rare.
- Persisting hang telemetry (frequency, durations, mode mix). Worth
  doing once we have C, to validate the thresholds.
