---
status: in-progress
priority: high
---

# Session rescue & diagnostics — surfacing silent failures and giving the user a real escape hatch

## Problem

Sessions periodically enter a state where "nothing works" — agent
doesn't respond, preview is dead, terminal is silent, or some
combination. Today the user has three observations and one tool:

- A green/yellow/red strip at the top of the Terminal tab
  ([SessionHealthStrip](../../src/client/components/SessionHealthStrip.tsx)).
- A per-service status dot inside the Services panel.
- The Logs panel, if anything got logged.
- A single **Restart container** button.

That's it. When Restart container doesn't fix it (and several silent
failure paths exist where it won't), the user has no further recourse
and no diagnostics to file a useful bug report. The session is
effectively bricked until they archive it and start a new one.

This doc catalogs the silent-failure paths that aren't already covered
by an existing feature doc, redesigns Restart container into a
**Rescue session** flow that handles the cases it currently misses,
and adds an aggregate **Session diagnostics** view that's both the
user's first port of call when something feels off and the one screen
they copy into a bug report when Rescue itself can't help.

## What's already covered (cross-references)

The reliability story lives across multiple docs. This feature is
deliberately the *gap-filler* — it does not duplicate territory that's
already designed.

| Concern | Tracked in | Status |
|---|---|---|
| Manual recovery surface (health strip, kill-agent, restart-container) | [112-container-recovery](../112-container-recovery/plan.md) | A+B done; C (auto-watchdog) deferred |
| SSE idle timeout, Docker event-stream auto-restart | [120-container-resilience](../120-container-resilience/plan.md) | done |
| Compose `pollStatus` swallowed errors, bounded SSE reconnect, log-streamer restart | [121-compose-resilience](../121-compose-resilience/plan.md) | planned (medium) |
| Memory pressure → eviction | [122-memory-pressure](../122-memory-pressure/plan.md) | done |
| Orphan compose-resource reaping at orchestrator startup | [091-compose-stack-cleanup](../091-compose-stack-cleanup/plan.md) | done |
| WS-disconnect resilience (lifecycle independence) | [098-ws-lifecycle-hardening-followups](../098-ws-lifecycle-hardening-followups/plan.md) | done |

This feature picks up everything else from a recent audit that no doc
yet names.

## Part 1 — Surface the silent signals

Six concrete swallowed-failure paths, each independent. Most are
one-line wirings; the common pattern is "an event is generated but
nothing routes it to the user."

### 1.1 `stack_error` event is dropped on the floor

`ServiceManager` emits `stack_error` when a stack-level failure
happens (compose file invalid, daemon unreachable, `docker compose up`
exits non-zero before any service starts).
[service-manager.ts:473](../../src/server/orchestrator/service-manager.ts#L473)
emits; the only listener wiring is in
[container-session-runner.ts:383-386](../../src/server/orchestrator/container-session-runner.ts#L383),
which subscribes to `service_status`, `service_log`, `stack_ready`,
`secrets_status` — and **not** `stack_error`. The event has no
subscriber and silently vanishes.

**Fix:** subscribe in `setServiceManager()` and route to both:
- A `runner.emitMessage({ type: "stack_error", error })` so reconnecting
  viewers see it via the turn-event log.
- A `ctx.broadcastLog({ level: "error", source: "compose", … })` so it
  shows up in the existing Logs panel with the unread badge.

### 1.2 Compose-child container OOM is invisible to the health monitor

[container-health.ts:84-89](../../src/server/orchestrator/container-health.ts#L84)
listens for Docker `die`/`oom` events but filters by
`label=shipit-session=true`. Compose-managed children carry
`shipit-parent-session={sid}` — they are *not* `shipit-session=true` —
so an OOM kill of the user's dev server is invisible to the event
stream. It surfaces ~5 s later as `pollStatus` flipping the service
to `error` with the unhelpful message "Exited with code 137."

**Fix:** widen the label filter to also include
`label=shipit-parent-session`. On a `die`/`oom` event, look up the
session via `shipit-parent-session` if `shipit-session=true` isn't
present, and emit a service-level `service_oom` runner event. Annotate
`pollStatus`'s exit message with "OOMKilled" when the inspect data
confirms it (already available — we just don't read it).

### 1.3 `workerPost` has no default timeout

[worker-http.ts:21-74](../../src/server/orchestrator/worker-http.ts#L21)
takes an optional `timeoutMs`. Only `getContainerHealth` and
`recovery.ts` opt in. Agent control HTTP — `/agent/start`,
`/agent/stdin`, `/agent/interrupt` — is unbounded. A wedged worker
socket leaves these calls hanging forever, which is exactly the
"interrupt does nothing" symptom from feature 112's problem statement.

**Fix:** default `timeoutMs` to 10 s in `workerPost`/`workerGet`. Each
call site can opt out (`timeoutMs: 0` or similar) for genuinely
streaming endpoints. On timeout, raise a typed `WorkerTimeoutError` so
callers can route it to a user-visible chat error rather than a
generic exception.

### 1.4 `ProxyAgentProcess.kill()` swallows errors silently

[proxy-agent-process.ts:75-77](../../src/server/orchestrator/proxy-agent-process.ts#L75)
wraps the kill HTTP call in `.catch(() => {})`. The interrupt button
funnels into this. When the worker is dead, the user clicks Interrupt,
nothing happens, and there is zero feedback in either direction.

**Fix:** propagate the error to a chat-visible `log_entry` and a
`session_status` field (`lastInterruptError`). The kill itself is
still best-effort, but the *attempt* and its outcome become
observable.

### 1.5 Preview-proxy 502s are iframe-only

[preview-proxy.ts:134-139](../../src/server/orchestrator/preview-proxy.ts#L134)
returns 502 JSON when it can't reach the container; HMR upgrade
failures destroy the WebSocket without notice
([proxy-error.ts:182-184](../../src/server/orchestrator/proxy-error.ts#L182)).
The user sees a blank iframe or raw JSON. Server-side, nothing is
logged or emitted.

**Fix:** on proxy errors, emit a `runner.emitMessage({ type:
"preview_error", port, error })` so the PreviewFrame component can
overlay a "Preview unreachable on port 5173 — Rescue session?" banner
and the Logs panel gets a record.

### 1.6 Idle-disposal cleanup is a console.log only

[app-lifecycle.ts:441](../../src/server/orchestrator/app-lifecycle.ts#L441)
logs to the orchestrator's stdout when a session is idle-disposed.
The user gets no inline notification that their container went away —
they come back to a tab where everything is detached and the only
clue is "containerState: missing" in the health strip.

**Fix:** emit a `session_status` event with reason
`"idle-disposed"` (and the elapsed-idle duration) when the enforcer
fires. The client renders a non-blocking notice: "Session paused after
N minutes idle. Send a message to resume." This converts a mystery
disappearance into a documented behavior.

## Part 2 — Make Restart Container actually deep ("Rescue session")

Today's `restartContainer()` flow
([recovery.ts:144-247](../../src/server/orchestrator/services/recovery.ts#L144)):

1. Emit `container_restarting`.
2. Best-effort `killAgentOnWorker({timeoutMs:3000})`.
3. `runnerRegistry.dispose(sessionId, {force:true})` — calls
   `clearServiceManager()`
   ([container-session-runner.ts:1107](../../src/server/orchestrator/container-session-runner.ts#L1107))
   which **detaches listeners** but does **not stop the compose
   stack**.
4. `containerManager.destroy(sessionId)`.
5. `runnerRegistry.getOrCreate(...)` to recreate.
6. Poll up to 8 s for `running` / `missing` / surfaced create error.

The compose stack from the prior runner survives steps 3–4. The new
runner's `ServiceManager.start()` calls `killStaleContainers()`
([service-manager.ts:1135-1153](../../src/server/orchestrator/service-manager.ts#L1135))
which reaps by label — but only if `start()` reaches that point. If
the compose file is now broken, or if Docker is hiccupping, you can
end up with *both* the prior orphan stack running *and* a fresh agent
container that can't talk to it. This is one of the unbreakable
states.

A second unbreakable state: the agent says `running=true`, the worker
says idle, but the reconciler that fixes this
(`verifyRunningState`,
[container-session-runner.ts:1055-1080](../../src/server/orchestrator/container-session-runner.ts#L1055))
only runs from `send-message.ts:56`. If the user doesn't send a new
message, the spinner spins forever and the runner can't be
idle-disposed because it thinks it's busy.

### 2.1 Stop the compose stack before disposal

In `restartContainer()`:

1. Resolve the existing runner (if any).
2. Call `runner.serviceManager?.stop()` *before*
   `runnerRegistry.dispose()`. `ServiceManager.stop()` runs
   `docker compose down --remove-orphans` and tears down per-session
   networks/volumes properly. This is the same path full-reset uses;
   we just need it on the rescue path too.
3. As defense in depth, after destroy, run a one-shot reaper that
   lists `label=shipit-parent-session={sid}` containers and forcibly
   removes any survivors. Reuses logic from
   `cleanupSessionDockerResources` (already exists for orphan reaping
   at startup).

This guarantees the new runner starts with a clean slate; we don't
depend on the new `ServiceManager.start()` getting far enough to do
the cleanup itself.

### 2.2 Periodic `verifyRunningState` reconciler

Add a periodic reconciler that runs while the runner is alive:

- Every 30 s, call `verifyRunningState()` if `runner.running === true`
  and a viewer is attached.
- Piggyback on the existing 10 s container-health poll on the client —
  the server already exposes `agentRunning` from `/agent/status` via
  `getContainerHealth`. The orchestrator can compare against
  `runner.running` server-side and emit `session_status` correction
  events when they diverge for >2 consecutive polls.

This means the "spinner stuck on" state self-heals within ~60 s
without the user retrying.

### 2.3 Phased progress instead of an opaque overlay

Today's "Restarting container…" overlay is a single indeterminate
spinner with a 60 s timeout. Replace it with phased progress emitted
as `session_status` events:

| Phase | User sees |
|---|---|
| `stopping_stack` | "Stopping services…" |
| `destroying_container` | "Destroying container…" |
| `creating_container` | "Recreating container…" |
| `starting_stack` | "Starting services…" |
| `ready` | overlay clears |
| `failed:<reason>` | shows reason inline + diagnostics deep-link |

Each phase has a max duration; on timeout, the overlay flips to a
"This is taking longer than expected" state with a button to open the
diagnostics view (Part 3) so the user can see *which* phase is
hanging.

### 2.4 Naming & UI

The button label changes from **Restart container** to **Rescue
session** to communicate that this is the deep operation that handles
both the agent container and the compose stack. The shallower
**Kill agent** button (already in `SessionHealthStrip`) stays as the
lighter-touch action for "just the agent CLI is stuck."

## Part 3 — Aggregate diagnostics view

Today's diagnostics are scattered:

- `SessionHealthStrip` — container state, worker reachability, agent
  state, SSE freshness, last create error.
- `ServicesPanel` — per-service status + log viewer (per-service, no
  aggregate).
- Logs panel — `log_entry` stream, mixed across sources.

There is no single screen that says "here is everything wrong with
this session." When Rescue session itself fails, or fails to fix the
problem, the user has nowhere to look and nothing to copy into a bug
report.

### 3.1 Session diagnostics panel

A new modal/panel reachable from `SessionHealthStrip`'s existing
"Details" affordance. Shows in one scrollable view:

**Container** — id, state, started-at, restart count, last create
error, last create error timestamp, worker URL.

**Worker** — last `/health` latency + timestamp, last
`/agent/status` (agent running, queue length), last successful
`workerPost` per endpoint.

**SSE** — connected, last activity timestamp, reconnect attempt
count, last reconnect reason.

**Compose stack** — for each service: status, last status change
timestamp, restart count, last exit code + reason (incl. OOM
annotation per Part 1.2), last 20 lines of stderr.

**Recent log entries** — last 50 `log_entry` events with source,
level, timestamp.

**Runner** — running flag, viewer count, last viewer detach, queue
length, capturedSessionId mismatches (if any).

### 3.2 "Copy diagnostics" action

A button at the top of the panel copies the full state as
JSON-formatted text to the clipboard. This is the bug-report
artifact. It includes everything above plus the session ID and a
client-generated timestamp, so a user pasting it into a chat or issue
gives whoever's debugging immediate insight without round-trips.

### 3.3 Endpoint

`GET /api/sessions/:id/diagnostics` returns the full payload as JSON.
Internally composes:
- Existing `getContainerHealth` (Part 112).
- A new `getServiceDiagnostics` that walks `ServiceManager`'s in-memory
  service map and reads tail of each log buffer.
- A new `getRunnerDiagnostics` that reads `runner.running`, viewer
  count, queue length, last SSE event.
- The orchestrator's recent broadcastLog ring (we already buffer this
  for new viewers; expose a getter).

The endpoint is read-only and safe to call repeatedly. The panel
polls at 2 s while open, snapshots on copy.

## Part 4 — Sequence

Recommended ordering (each phase is independently shippable):

**Phase 1 — Surface signals (Part 1).** Items 1.1–1.6. All small,
isolated, mostly one-line wirings. Each one independently turns a
silent failure into an observable one. Highest user-value-per-LOC.

**Phase 2 — Diagnostics endpoint + panel (Part 3.1, 3.3).** With Part
1 in place there's enough actually-flowing data to populate the
panel; without Part 1 the panel would just have gaps in it.

**Phase 3 — Rescue session (Part 2).** Renames the button, makes it
deep, adds phased progress. Diagnostics from Phase 2 deep-link from
the failure overlays.

**Phase 4 — Copy diagnostics (Part 3.2).** Smallest piece; can land
with Phase 3 or just after.

The periodic `verifyRunningState` reconciler (Part 2.2) is technically
independent of the rest of Part 2 and can move into Phase 1 if it's
helpful for empirical tuning.

## Key files

### Server

- `src/server/orchestrator/container-session-runner.ts` — subscribe to
  `stack_error`; periodic `verifyRunningState`; expose runner
  diagnostics getter.
- `src/server/orchestrator/service-manager.ts` — annotate `pollStatus`
  exit messages with OOM info; expose log-buffer-tail getter for
  diagnostics.
- `src/server/orchestrator/container-health.ts` — widen Docker event
  label filter to include `shipit-parent-session`; emit `service_oom`
  on compose-child OOM.
- `src/server/orchestrator/worker-http.ts` — default 10 s timeout;
  typed `WorkerTimeoutError`.
- `src/server/orchestrator/proxy-agent-process.ts` — propagate
  `kill()` errors as a chat-visible `log_entry`.
- `src/server/orchestrator/preview-proxy.ts` &
  `src/server/orchestrator/proxy-error.ts` — emit `preview_error`
  runner events on connection / HMR upgrade failures.
- `src/server/orchestrator/app-lifecycle.ts` — emit `session_status`
  with reason `"idle-disposed"` when the enforcer fires.
- `src/server/orchestrator/services/recovery.ts` — stop the compose
  stack before dispose; one-shot orphan reaper after destroy; phased
  progress events.
- `src/server/orchestrator/services/diagnostics.ts` *(new)* — composes
  diagnostics from health, services, runner, log ring.
- `src/server/orchestrator/api-routes-container.ts` — add
  `GET /api/sessions/:id/diagnostics`.
- `src/server/shared/types/ws-server-messages.ts` — new message types:
  `stack_error`, `preview_error`, `service_oom`, refined
  `container_restarting` payload with `phase`.

### Client

- `src/client/components/SessionHealthStrip.tsx` — rename to "Rescue
  session"; render phased progress; deep-link to diagnostics panel.
- `src/client/components/SessionDiagnosticsPanel.tsx` *(new)* — the
  aggregate view; "Copy diagnostics" button.
- `src/client/components/PreviewFrame.tsx` — render `preview_error`
  overlay.
- `src/client/components/ServicesPanel.tsx` — show OOM annotations on
  service status; restart-count badges (plumbing for the diagnostics
  panel anyway).

## Patterns this fits into

- **Service layer** (server-architecture skill): new
  `services/diagnostics.ts` follows the existing routes → services →
  managers pattern.
- **WebSocket lifecycle independence** (CLAUDE.md): the diagnostics
  endpoint is HTTP, not WS; Rescue session phased progress goes
  through `runner.emitMessage` so reconnecting viewers see it via the
  turn-event log.
- **Inline beats link-out** (CLAUDE.md §2): "Copy diagnostics" keeps
  bug reporting inside ShipIt rather than asking the user to scrape
  console output across multiple panels.
- **Chat is input, agent is actor** (CLAUDE.md §5): Rescue session is
  a recovery affordance, not a shell-shaped one — same exception
  carve-out as feature 112's Restart container. The agent literally
  cannot rescue its own container.

## Out of scope for this iteration

- **Auto-rescue.** We deliberately keep Rescue session manual. An
  auto-rescue policy needs the empirical data Part 1 will start
  generating; revisit after a few weeks of usage.
- **Cross-session "Docker is unhealthy" banner.** Handled adequately
  by per-session diagnostics for now; revisit if we see daemon-down
  events spanning multiple sessions in production.
- **Persistent diagnostics history.** The panel is live state. If a
  user wants to file a bug after the fact, the "Copy diagnostics"
  button captures the state-at-that-moment. A scrolling history
  archive is more infrastructure than the problem warrants.
- **Telemetry / aggregate metrics on rescue frequency, phase failure
  rates, OOM counts.** Worth doing once we have enough data to act on
  it — track separately.
- **Items already covered by 112-C, 121-D/E/F.** Auto-watchdog,
  bounded SSE retries, compose poll-failure handling, log-streamer
  restart all stay in their existing docs. This feature does not
  re-design them; it complements them.
