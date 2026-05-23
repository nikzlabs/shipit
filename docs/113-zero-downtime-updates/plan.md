---
status: planned
priority: medium
description: Drain in-flight agent turns before swapping the orchestrator container so running sessions survive an Update Now without losing mid-turn work.
---

# Zero-downtime updates — keep running agents alive across `Update Now`

## Problem

Today, clicking **Update Now** in Settings (`docs/083-self-update`) kills
every running agent on the box. The host script that runs the update —
`deployment/hetzner/deploy.sh` — explicitly does:

```bash
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit") 2>/dev/null || true
docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true
```

That bulldozes:

- The orchestrator (`shipit-stack=shipit`).
- Every session-worker container the orchestrator spawned (also labelled
  `shipit-stack=shipit`).
- Every Compose service container the user's projects spawned
  (`shipit-parent-session=<id>`).

The fallout for an agent that was mid-turn when the user (or another
user on the same box) clicks **Update Now** is total: the Claude CLI
subprocess dies inside the worker container, the session-worker process
dies with it, the in-flight tool call is lost, and the UI surfaces a
generic "Connection lost" error. The user has to manually re-prompt and
hope nothing destructive was half-done.

This doc designs the path to **updating ShipIt without killing running
agents**.

## Why this is even tractable

The system already has most of what it needs. We are *one bad shell
script* and *one ordering policy* away from agents surviving updates.
Specifically:

| Existing piece | Where | What it gives us |
|---|---|---|
| Session containers labelled by session ID | `session-container.ts:182–186` | Docker keeps them running independently of the orchestrator process. |
| `rediscoverContainers()` on boot | `container-discovery.ts`, called from `app-lifecycle.ts:81–95` | New orchestrator adopts existing containers instead of recreating them. |
| `SessionRunnerRegistry` is in-memory only | `session-runner.ts` (doc 041) | Runners are *expected* to be ephemeral; they're recreated lazily on first WS message. |
| Chat history persisted in SQLite | `chat-history.ts` | Survives orchestrator AND container restarts. `finalizeInProgress()` cleans up half-streamed messages on boot. |
| SSE auto-reconnect with backoff | `container-session-runner.ts:614–705` | Worker → orchestrator stream re-establishes itself when a new orchestrator boots. |
| WS auto-reconnect with backoff | `useWebSocket.ts:35–100`, `useConnectionSync.ts` | Browser → orchestrator stream re-establishes itself when the new orchestrator is up. |
| Client/server build id | `build-id.ts`, `client-build.ts`, `useServerEvents.ts` | On SSE reconnect, the new orchestrator sends its build id (`SHIPIT_BUILD_ID`, falling back to git SHA in dev). A browser tab whose baked client build id differs hard-reloads so it runs the matching client bundle. |
| Terminal output buffer + xterm reset | `container-session-runner.ts` (~line 642) | Re-attach replays the recent scrollback without corrupting rendering. |
| `ContainerSessionRunner` placeholder workerUrl | `container-session-runner.ts:136–160` | Runner can exist before the worker URL is known; it resolves on adoption. |

The architecture was *designed* for the orchestrator to die under it.
Doc 041 is explicit: "Closing a tab, switching sessions, or navigating
away should never affect running agents." The update flow is the one
remaining place where the orchestrator violates that contract by
reaching outside its own process and killing the agents on the way out.

## The option space

The user's framing was "either don't kill the agent containers, or kill
them and auto-resume." Those are the two endpoints; there's a third
option — a hybrid that drains in-flight work first — that's almost
always the right answer.

### Option A — Hot-swap orchestrator only (don't touch session containers)

Replace the `shipit` orchestrator container. Leave session-worker
containers and Compose service containers alone. New orchestrator boots,
calls `rediscoverContainers()`, adopts the running session containers.
WebSocket clients reconnect, see their agents still running.

**Pros**
- Truly zero interruption for running agents.
- Leverages everything the architecture already supports.
- Update window is bounded by orchestrator boot time (~5–10s).

**Cons / risks**
- **Image version skew.** The new orchestrator may speak a different
  worker HTTP/SSE contract than the worker images that are still
  running. If we ship a breaking change to `/agent/start`, `/events`,
  or any of the worker endpoints in `worker-http.ts`, an old worker
  won't speak it. Today there is no version negotiation.
- **Agent-side fixes never reach old containers.** The session-worker
  image bakes in `claude.ts`, `tool-map.ts`, `agent-instructions.ts`,
  and `/shipit-docs/`. A user with a long-lived session keeps running
  the old worker indefinitely.
- **Compose service containers also keep their old config.** Less
  important — these are user-controlled — but worth flagging.

### Option B — Kill containers, auto-resume

Kill everything, the new orchestrator boots, and on first reconnect we
spin up a fresh session-worker container per active session and call
`claude --resume <sessionId>` to restart the CLI.

**Pros**
- One image version everywhere, always. No version skew.
- Conceptually simple.

**Cons / risks**
- **Mid-turn state is genuinely lost.** `claude --resume` resumes from
  the last completed turn, not from where the CLI was when it was
  killed. A 3-minute generation killed at the 2:30 mark restarts from
  the start of that turn. Tool calls that were already executed are
  re-executed on resume; tool calls that were partway through are
  abandoned without a result.
- **Long-running shell side-effects are abandoned.** A `npm install`
  or dev-server-startup spawned inside the container dies with the
  container. The agent comes back to a half-installed workspace and
  has to figure out what state it's in.
- **The "auto-resume" code does not exist yet.** We'd have to build
  the orchestrator-driven recovery loop: detect that session `S` had
  an in-flight turn, spin up a worker, replay the user's prompt, hope
  Claude CLI's resume handles the rest. That's a non-trivial feature
  on its own.

### Option C — Drain → hot-swap → lazy worker rotation *(recommended)*

The hybrid the user's framing missed.

1. **Drain phase.** Orchestrator enters "updating" mode. New
   `send_message` requests across all sessions are queued and the user
   sees a banner: "Update in progress — your message will be sent when
   the system finishes updating." Already-running turns are allowed to
   complete. There's a hard cap (e.g., 5 minutes) after which the
   drain is forced.
2. **Hot-swap phase (Option A).** Once no agent is mid-turn — or the
   drain cap expires — the orchestrator container alone is replaced.
   Session-worker containers and Compose service containers are *not*
   touched. New orchestrator boots, adopts existing containers,
   browsers reconnect via the existing WS reconnect path.
3. **Lazy worker rotation.** Existing session-worker containers
   continue running their old image. As sessions naturally go idle and
   the runner is disposed by the idle enforcer, the container is also
   disposed. The next time the user opens that session, a fresh
   container with the new image starts. The fleet rolls forward over
   the next few hours of normal use.
4. **Explicit rotation escape hatch.** If a session genuinely needs the
   new image *now* (e.g., the update fixed a bug the user is hitting),
   they can use the existing **Restart container** button from doc
   112. That tears the worker down and the factory rebuilds it on next
   activation.

This converts both failure modes:

- **Option A's version-skew risk** is bounded — old workers exist, but
  only until idle. We add a version check on adoption (see "Version
  contract" below) so the orchestrator refuses to talk to a worker it
  cannot understand and surfaces a "restart this container" banner
  instead of crashing.
- **Option B's mid-turn loss risk** is converted into a *waiting cost*
  — if you click Update Now while ten people have running agents, the
  update waits for them to finish (up to the cap) instead of nuking
  them.

Drain-on-update is also the standard pattern for this class of problem
(load balancers draining backends before rolling, k8s `terminationGracePeriodSeconds`,
etc.), and it composes cleanly with the existing primitives.

**Recommendation: Option C.**

## Detailed design

### 1. Stop killing session containers in `deploy.sh`

The single most impactful change. The two destructive lines at the top
of `deploy.sh`:

```bash
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit") 2>/dev/null || true
docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true
```

…need to become a precise targeted restart of the orchestrator service
only:

```bash
# Build new images (session-worker rebuild produces a new image;
# existing containers are not affected — Docker images are immutable).
docker compose -f "$COMPOSE_FILE" build --no-cache --pull session-worker shipit

# Restart ONLY the orchestrator. Session-worker containers and
# Compose service containers (shipit-parent-session) keep running.
docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-deps shipit
```

The `docker rm -f` lines existed to garbage-collect orphaned containers
from a previous broken run. That GC responsibility moves to the
orchestrator boot path (`cleanupOrphanContainers()` in
`container-discovery.ts:102` already exists and runs on startup). The
host script is no longer responsible for tearing down session state —
the orchestrator owns it.

This change alone gets us 90% of Option C. Steps 2–7 below are what
prevents the remaining 10% from being a foot-gun.

### 2. Drain mode in the orchestrator

Add a process-wide `updateState` to the orchestrator: `idle` |
`draining` | `updating`.

```ts
// In app-di.ts or a new services/update-state.ts
type UpdateState =
  | { phase: "idle" }
  | { phase: "draining"; deadline: number; reason: "user-update" }
  | { phase: "updating" };
```

**Transitions**

- `POST /api/updates/apply` (existing route, in `services/updates.ts`):
  before writing `.update-requested`, set `updateState = { phase: "draining", deadline: now + 5min, reason: "user-update" }`,
  broadcast a `system_update_starting` event over the global SSE stream
  (`useServerEvents`), and return immediately. **Do not write the
  trigger file yet.**
- A drain monitor (a `setInterval` or a one-shot `setTimeout` chain)
  runs every 5s. It checks `runnerRegistry.listActive()`. When the
  list is empty *or* the deadline expires, it transitions to
  `updating`, writes `.update-requested`, and lets the systemd path
  unit pick it up.
- During `draining`:
  - `handleSendMessage` rejects new turns with a typed error
    (`update_in_progress`) — the existing send-message path already
    has a queue; we *could* enqueue instead of reject, but the user
    will be reconnecting to a new orchestrator soon and the queue
    won't survive. Cleaner to surface "your message will be sent in a
    moment" and have the client auto-retry once the WS reconnects to
    the new orchestrator. The new orchestrator boots in `idle` and
    accepts the retried message normally.
  - Already-running turns finish normally. `agent_result` decrements
    `listActive`'s count.
  - The browser shows an "Updating in MM:SS" banner driven by the
    `system_update_starting` event.
- During `updating`: process exit is imminent. Nothing else to do.

**Force cap.** If the deadline expires with active runners, the drain
monitor logs a warning, emits a `system_update_force_killing` event so
the UI can warn affected users, and then transitions anyway. Active
agents will be killed when the orchestrator is replaced. We accept that
as the worst case — but only after we've waited for them.

### 3. Adopt existing containers on boot (already works, verify)

The new orchestrator's startup path in `app-lifecycle.ts:81–95` already
calls `rediscoverContainers(activeSessionIds, ...)` which finds running
containers labelled `shipit-session=<id>` and rebuilds the in-memory
`SessionContainer` records. `cleanupOrphanContainers()` reaps anything
not in the active session set.

Two things to verify (and gate with tests):

1. The runner factory in `app-lifecycle.ts:167–210` correctly
   *adopts* the rediscovered container instead of creating a new one
   when the next WS message arrives. This is doc 041's "stale
   container exists, replace it" path — but for adoption rather than
   replacement.
2. The first SSE connection from the new orchestrator to an adopted
   worker correctly resyncs state. The worker's `/agent/status`
   endpoint should be the source of truth (`runner.running`,
   `runner.turnSummary`) — the orchestrator pulls it on adoption and
   seeds the new in-memory runner.

Test: spin up a session in an integration test, kill the orchestrator
process (not the container), restart, send a WS message, assert the
agent state survives.

### 4. Worker version contract

The orchestrator and worker speak HTTP+SSE over a versioned API. Add a
`/version` endpoint on the worker that returns:

```json
{
  "image": "shipit-session-worker:prod",
  "gitSha": "abc123…",
  "apiVersion": 3
}
```

Bump `apiVersion` whenever any of these change in a non-additive way:
- Worker HTTP request/response shapes (`/agent/start`, `/agent/interrupt`, `/agent/kill`, `/agent/status`, `/terminal/*`, `/files/*`, `/secrets/*`).
- SSE event schema (additions are fine; renames/removals are breaking).

On adoption, the orchestrator calls `/version`. If
`workerApiVersion < orchestrator.minWorkerApiVersion`, the runner
**refuses to use the worker** and emits a typed event:

```ts
{ type: "session_worker_outdated", sessionId, workerApiVersion, orchestratorMinVersion }
```

The client surfaces a banner in the session: *"This session is running
an older worker. Restart the container to pick up the latest update.
[Restart container]"* — reusing the existing recovery action from doc
112. Until they restart, the session is effectively read-only (chat
history visible, but `send_message` is blocked).

This is the safety net that makes Option C viable: we never have to
guess whether the orchestrator can drive an old worker. We ask, and
either talk to it normally or refuse and tell the user how to recover.

### 5. Lazy worker rotation

No code change needed beyond §4 — the existing idle enforcer already
disposes runners (and their containers) after the configured idle
window. The next session activation rebuilds the container from the
freshly-built image. Add one piece of telemetry: log the worker's
`gitSha` on adoption and on creation, so we can confirm in logs that
the fleet rolls forward over time.

Optional: a "Workers" admin row in Settings listing each running
session container, its image SHA, and a "Restart" button. Keeps the
escape hatch visible for ops users. Out of scope for v1.

### 6. Compose service containers (`shipit-parent-session`)

These are user-controlled — `npm run dev`, Prisma Studio, log tailers
declared in the user's `docker-compose.yml`. They survive the update
under §1 (we no longer `docker rm -f` them). They keep running their
configured image, which is whatever the user's `docker-compose.yml`
points at — usually a public image like `node:20`, not anything ShipIt
ships. So there's no version skew issue; they just keep running across
the update window.

If the user changes their `docker-compose.yml` and the file watcher
triggers a `ServiceManager.restart()`, the services come up cleanly on
the new orchestrator (`ServiceManager` is recreated lazily per
session, same as the runner).

### 7. Failure modes

| Failure | Outcome |
|---|---|
| New orchestrator image fails to build | `deploy.sh` exits non-zero before the `up -d` step. Old orchestrator is still running. Drain banner clears on next health-check tick (orchestrator never wrote the trigger file because the drain monitor crashed; needs a "drain timed out without completing" recovery). Add a 10-minute hard cap on the `draining` phase that resets to `idle` if the trigger file was never written. |
| New orchestrator boots but crashes on adoption | systemd restarts it (existing `Restart=always` policy). If it crashes 5x in 60s, the unit goes into `failed` and an operator has to intervene. Out of scope to auto-rollback; flag for monitoring instead. |
| Worker version check rejects a container | User sees "Restart container" banner. The session is read-only until they click. No data loss. |
| User clicks Update Now twice | Second click sees `updateState !== "idle"` and returns `409 update_in_progress`. UI shows the existing banner. |
| Orchestrator dies during `draining` (e.g., OOM) | systemd restarts it in `idle` state. Trigger file was never written. Update did not happen. UI shows orchestrator coming back. User can retry. |
| Drain cap expires with running agents | Active agents are killed when orchestrator is replaced. `agent_result` events for those turns never fire; chat history is finalized via `ChatHistoryManager.finalizeInProgress()` on next boot. User sees the half-message marked as interrupted. |

### 8. Sequencing

1. **Phase 1 — stop the bleeding.** Land §1 (`deploy.sh` no longer
   kills session containers) and §3 (verify adoption works
   end-to-end). This alone makes updates safe for *idle* sessions and
   stops nuking long-running Compose services.
2. **Phase 2 — drain mode.** Land §2 (orchestrator drain state, UI
   banner, send_message rejection during drain). Now updates wait for
   running turns instead of killing them.
3. **Phase 3 — version contract.** Land §4 (`/version` endpoint,
   adoption-time check, "outdated worker" banner). Required before we
   can ship a breaking worker API change with confidence.
4. **Phase 4 — lazy rotation telemetry.** §5 — log + optional admin
   surface. Nice-to-have.

Phases 1 and 2 are independently shippable and each move the system
forward; you don't need 4 to start.

## Why this is consistent with product principles

- **§1 ShipIt is the surface.** The drain banner, restart-container
  banner, and "outdated worker" banner all render in the chat UI. No
  link-out, no shell, no GitHub tab.
- **§5 Chat is input.** The user does not initiate worker rotation by
  clicking a "rebuild" button on every session — they ask the agent or
  use the recovery affordance from doc 112. Lazy rotation is a system
  behavior, not a user task.
- **WebSocket lifecycle independence (CLAUDE.md "WebSocket lifecycle
  MUST NOT affect server behavior").** The drain → swap → adopt flow
  treats the WS exactly like any other reconnect: it goes away, comes
  back, and the runner state is whatever the registry/worker say it
  is. We are *not* using the WS as a coordination channel for the
  update.

## Key files

### Server

- `deployment/hetzner/deploy.sh` — replace destructive `docker rm -f`
  with targeted `up -d --force-recreate --no-deps shipit`.
- `src/server/orchestrator/services/updates.ts` — extend
  `requestUpdate()` to flip `updateState` to `draining`, schedule the
  drain monitor, and only write `.update-requested` when drain
  completes.
- `src/server/orchestrator/services/update-state.ts` *(new)* —
  `UpdateState` machine + drain monitor.
- `src/server/orchestrator/api-routes-updates.ts` — return
  `409 update_in_progress` from a second `apply` call.
- `src/server/orchestrator/ws-handlers/send-message.ts` — reject new
  turns during `draining` with a typed error the client can render.
- `src/server/session/session-worker.ts` — add `GET /version`
  endpoint exposing `apiVersion` + `gitSha`.
- `src/server/orchestrator/worker-http.ts` — add `workerVersion()`
  helper.
- `src/server/orchestrator/container-session-runner.ts` — call
  `workerVersion()` on adoption (in the `setWorkerUrl` resolution
  path), gate runner usage on the result.
- `src/server/orchestrator/app-lifecycle.ts` — verify
  `rediscoverContainers` adoption path; add a test.
- `src/server/shared/types/ws-server-messages.ts` — new event types:
  `system_update_starting`, `system_update_completing`,
  `session_worker_outdated`.
- `src/server/orchestrator/integration_tests/update-flow.test.ts`
  *(new)* — drain happy path, drain cap, post-update adoption,
  version-mismatch fallback.

### Client

- `src/client/components/UpdateBanner.tsx` *(new)* — global banner
  driven by `system_update_starting` / `system_update_completing`
  events.
- `src/client/components/SessionWorkerOutdatedBanner.tsx` *(new)* —
  per-session banner with "Restart container" button (reuses the
  existing restart action from doc 112).
- `src/client/hooks/useServerEvents.ts` — handle the new event types.
  Already handles client/server build skew: `system_info.buildId`
  is compared against the browser's baked client build id, and a
  mismatch triggers a hard page reload.
- `src/client/components/Settings.tsx` — surface drain countdown in
  the existing "Software Updates" section.

### Docs

- `docs/083-self-update/plan.md` — link forward to this doc; note
  that the v1 "kill everything" behavior is superseded.
- `docs/112-container-recovery/plan.md` — note that
  "session-worker-outdated" reuses the same restart-container action.

## Out of scope

- **True zero-downtime orchestrator** (rolling two orchestrator
  instances behind a load balancer). Requires sticky-session routing
  on the WS layer and shared state between instances. The single-box
  Hetzner deployment doesn't justify it; the ~5–10s gap during
  orchestrator restart is acceptable when the agent isn't killed.
- **Mid-turn agent resume** (Option B's auto-resume). We deliberately
  avoid building this because Option C makes it unnecessary in the
  common case and the rare case (drain cap exceeded) is handled by
  finalizing the in-progress message and letting the user re-prompt.
- **Cross-session migration** (move a running session from old worker
  to new worker without restarting the container). Same reason —
  lazy rotation handles this acceptably.
- **Telemetry on update success rate / agent survival rate.** Worth
  doing once Phases 1–3 are live so we can validate the design
  against real traffic.
