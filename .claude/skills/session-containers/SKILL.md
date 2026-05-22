---
name: session-containers
description: "ShipIt Docker container and session runner architecture: ContainerSessionRunner, SessionRunnerRegistry, container creation/destruction, health monitoring, idle container disposal, reconnection after disposal, graceful shutdown. Load when working on containers, runners, idle cleanup, or container debugging."
user-invocable: true
---

# Session Containers & Runners

This skill covers Docker container management, session runners, idle disposal, and reconnection. For session creation/activation/switching, see the `session-lifecycle` skill.

## Key Components

| Component | Location | Role |
|-----------|----------|------|
| `SessionRunner` | `orchestrator/session-runner.ts` | In-process implementation (test-only). Spawns agent/terminal directly |
| `ContainerSessionRunner` | `orchestrator/container-session-runner.ts` | Production implementation. Delegates to per-session Docker container via HTTP+SSE |
| `SessionContainerManager` | `orchestrator/session-container.ts` | Docker orchestration: create, destroy, health monitor, orphan cleanup |
| `SessionRunnerRegistry` | `orchestrator/session-runner.ts` | App-level map of session ID -> runner |

## Runner Lifecycle

### SessionRunnerRegistry

- Maintains `Map<string, SessionRunnerInterface>` (session ID -> runner)
- **`getOrCreate(sessionId, sessionDir, agentId)`**:
  1. Return existing non-disposed runner if found
  2. Call runner factory to create new runner
  3. Register `"disposed"` listener for auto-cleanup from map
  4. Wire `runner.on("idle")` -> `onRunnerIdle(sessionId)` callback
- **`get(sessionId)`**: Returns runner if exists and not disposed
- Max 10 concurrent runners; evicts oldest idle runner if at capacity
- `disposeAll()` for graceful shutdown

### Runner Factory (Production)

`buildRunnerFactory()` (in `app-lifecycle.ts`) handles three cases, keyed on the
container's current `status`. A pre-booted **standby** container (warm pool —
see the `session-lifecycle` skill) shows up here as an `existing` container that
is `running` or `starting`, so it's just a data condition on these same cases —
there is no separate "warm" code path.

```
factory(opts):
  existing = containerManager.get(opts.sessionId)

  CASE 1: existing && status === "running"          (incl. a ready standby)
    -> mgr.claimStandby(sessionId)                  (clears standby flag if set)
    -> Reconnect: new ContainerSessionRunner({ workerUrl: existing.workerUrl })
    -> No container creation -- SSE replay delivers current state. Instant.

  CASE 2: existing && status === "starting"         (standby still booting)
    -> runner = new ContainerSessionRunner({ workerUrl: "http://0.0.0.0:0" })
    -> poll up to 30s (500ms): once running -> claimStandby + setWorkerUrl
       if it never becomes ready -> fall through to a fresh create
    (returns runner immediately; the poll runs in a fire-and-forget async block)

  CASE 3: no existing container, OR stale (stopping/stopped)
    -> runner = new ContainerSessionRunner({ workerUrl: "http://0.0.0.0:0" })
    -> createContainerForRunner({ destroyExisting: !!existing })
       (destroys the stale one first, then mgr.create + runner.setWorkerUrl)
```

The factory is **synchronous** — it returns the runner immediately. Container
creation/standby-poll happens async; the runner queues all operations behind
`_workerReady` (a promise resolved by `setWorkerUrl()`).

### Standby containers

A standby is a normal session container pre-created by the warm pool and tagged
`shipit-standby=true`, tracked in `standbySessionIds`:

- **`createStandby(config)`** — `create()` + standby label + track. Called from
  `warmSessionForRepo(..., { withStandby: true })` when there's idle headroom.
- **`claimStandby(sessionId)`** — drops the standby flag and returns the
  container so the runner factory reuses it (cases 1 & 2). After claiming it's
  an ordinary container.
- **`isStandby(sessionId)`** — used by the idle/missing-container reconciler and
  startup validation to avoid treating an unclaimed standby as an orphan.

Standby containers are excluded from the "real" count when the pool decides
whether to create another (`size - standbyCount < maxIdleContainers`).

## ContainerSessionRunner Internals

### Worker Ready Promise

The runner initializes with a `_workerReady` promise. All HTTP calls to the worker (`workerPost`, `workerGet`) await this promise before executing. When the constructor receives a real URL (not `"http://0.0.0.0:0"`), the promise resolves immediately (reconnect case). Otherwise, it resolves when `setWorkerUrl()` is called after container creation completes.

### SSE Event Stream

```
connectEventStream():
  1. Await _workerReady
  2. Open GET {workerUrl}/events (Server-Sent Events)
  3. Parse incoming events -> handleSSEEvent()
  4. On error/close: exponential backoff reconnect (1s, 2s, 4s, 8s, 10s cap)
```

SSE events map to actions:
| SSE Event | Action |
|-----------|--------|
| `agent_event` | Forward to ProxyAgentProcess -> emitted as WS `assistant_*` messages |
| `agent_done` | Forward to ProxyAgentProcess -> triggers onAgentFinished |
| `file_changes` | Emit files_changed. If shipit.yaml/compose changed, reconcile compose stack |
| `terminal_data` | Emit terminal_output |

### SSE Replay

When the SSE connection opens (or reconnects), the session worker replays current state:
- If terminal is alive -> sends empty `terminal_data` signal

Preview/service state is managed by the orchestrator's `ServiceManager` (Docker Compose), not the session worker.

### attachViewer / detachViewer

```
attachViewer():
  viewerCount++
  if (viewerCount === 1):  // first viewer
    connectEventStream().then(() => startWorkerResources())

detachViewer():
  viewerCount--
  // Does NOT disconnect SSE or stop resources
  // Container keeps running for fast re-attach
```

### startWorkerResources()

```
startWorkerResources():
  if (_workerResourcesStarted) return
  _workerResourcesStarted = true
  await _workerReady
  POST {workerUrl}/files/watch   <- idempotent
```

## Container Lifecycle

### Container Creation

```
SessionContainerManager.create(config):
  1. Build Docker mounts:
     - session dir -> /workspace (read-write)
     - credentials dir -> /credentials (read-only)
     - shared repo dir -> same absolute path (for worktree resolution)
  2. docker.createContainer({
       Image: "shipit-session-worker:latest",
       Cmd: ["node", "--import", "tsx", "src/server/session/session-worker.ts"],
       NetworkingConfig: { shipit bridge network },
       HostConfig: { Memory: 512MB, CpuQuota: 50000, PidsLimit: 256 },
       Labels: { "shipit-session-id": sessionId },
     })
  3. container.start()
  4. container.inspect() -> get bridge IP
  5. Poll GET http://{ip}:9100/health every 500ms (up to 30s)
  6. Return { id, workerUrl: "http://{ip}:9100", containerIp, status: "running" }
```

### Container Destruction

```
SessionContainerManager.destroy(sessionId):
  1. container.stop({ t: 5 })   // 5-second graceful timeout
  2. container.remove({ force: true })
  3. Remove from containers map
```

### Health Monitor

```
containerManager.startHealthMonitor():
  1. docker.getEvents({ filters: { label: ["shipit-session-id"] } })
  2. On "die" or "oom" event:
     a. Parse sessionId from container labels
     b. Parse exitCode from event attributes
     c. Remove from containers map
     d. Emit "container_exited" event
```

The orchestrator listens for `container_exited`:
```
containerManager.on("container_exited", (sessionId, exitCode, error)):
  1. Get runner from registry
  2. runner.emitMessage({ type: "session_status", error: "container exited" })
  3. runner.dispose()
```

### Orphan Cleanup + Container Rediscovery

On startup, two phases restore the in-memory state from Docker.
`activeSessionIds` is built from `sessionManager.allIds()` which includes warm
and archived sessions — this is critical so warm session containers are not
treated as orphans.

```
containerManager.cleanupOrphans(activeSessionIds):
  1. docker.listContainers({ filters: { label: ["shipit-session-id"] } })
  2. For each container not in activeSessionIds:
     - container.stop() + container.remove()
  3. Return count of removed containers

containerManager.rediscover(activeSessionIds):
  1. docker.listContainers({ filters: { label: ["shipit-session-id"] } })
  2. For each running container in activeSessionIds that's not already tracked:
     - container.inspect() -> get bridge IP
     - Populate containers map with { id, workerUrl, containerIp, status }
  3. Return count of rediscovered containers
```

After restart, the `containers` map (in-memory) is empty even though Docker
containers survived. `rediscover()` restores it so the runner factory can
reconnect to existing containers instead of creating duplicates.

### Container Persistence Across Runner Disposal

When a `ContainerSessionRunner` is disposed (idle container cleanup), the Docker container is destroyed along with the runner. However, when a runner is disposed without explicit container destruction (e.g. server shutdown cleanup), the `dispose()` method:
- Kills the agent process in the container (fire-and-forget)
- Disconnects the SSE stream
- Emits `"disposed"` -> removed from `SessionRunnerRegistry`

Containers that survive (e.g. after an unclean shutdown) are rediscovered on startup, enabling fast reconnection — a new runner can reconnect to the existing container without restarting anything.

## Idle Container Cleanup

Instead of per-runner idle timers, ShipIt manages container lifecycle with a single `maxIdleContainers` setting (default 5, persisted in `CredentialStore`). An **idle container** is one where:
- The runner has `viewerCount === 0` AND `!running`, OR
- The container has no runner at all

`enforceIdleContainerLimit()` (in `index.ts`) scans all containers, identifies idle ones, and destroys the oldest excess beyond the limit. It fires on two triggers:
1. **Viewer disconnects** — called in the WS close handler after `detachFromRunner()`
2. **Agent finishes** — called via the `onRunnerIdle` registry callback when a runner emits `"idle"`

When excess idle containers are destroyed:
- `containerManager.destroy(sessionId)` stops and removes the Docker container
- `runnerRegistry.dispose(sessionId)` cleans up the in-memory runner

The `maxIdleContainers` setting is exposed via `PUT /api/settings` and the Settings UI (Advanced tab).

## Idle Timer

Both runner implementations have an idle timer (default 10 minutes). After timeout with no running agent, no queue, and no viewers -> `dispose()`.

Special case: `ContainerSessionRunner` tracks `_hasBeenUsed`. If a viewer detaches and the runner was never used (no agent started), the idle timer resets to 10 seconds instead of 10 minutes. This cleans up containers from briefly-visited sessions.

## Reconnection

When a user returns to a session whose runner was disposed:

```
1. WS connects to /ws/sessions/{id}
2. activateSession(id):
   a. runnerRegistry.get(id) -> undefined (runner was disposed)
   b. runnerRegistry.getOrCreate(id, dir, agentId)
      -> calls runner factory
      -> factory checks containerManager.get(id)
      -> existing container with status "running" found
      -> creates new ContainerSessionRunner with existing workerUrl
      -> _workerReady resolves immediately (real URL)
3. attachToRunner(runner):
   a. runner.attachViewer()
      -> first viewer: connectEventStream() then startWorkerResources()
      -> SSE connects to running container
      -> Worker replays current state (preview_ready, etc.)
      -> startWorkerResources():
        - POST /files/watch -> idempotent (already watching)
   b. Send preview_status (built from ServiceManager detected ports)
   c. Send service_list (current compose service states)
4. Client receives service/preview state -> shows preview immediately
```

**No container restart. Instant reconnect.** Compose services persist independently of the runner lifecycle.

## Graceful Shutdown

```
app.addHook("onClose"):
  1. authManager.kill()
  2. runnerRegistry.disposeAll()
     -> each runner: kill agent, disconnect SSE, emit "disposed"
  3. containerManager.dispose()
     -> for each container: stop + remove
```

All Docker containers are destroyed on server shutdown. On next startup, orphan cleanup catches any that survived an unclean shutdown.

## Resource Limits

| Resource | Limit | Location |
|----------|-------|----------|
| Container memory | 512 MB | `session-container.ts` |
| Container CPU | 0.5 (50,000 quota) | `session-container.ts` |
| Container PIDs | 256 | `session-container.ts` |
| Concurrent runners | 10 | `SessionRunnerRegistry` |
| Runner idle timeout | 10 min (default) | `SessionRunnerRegistry` |
| Unused runner idle | 10 sec | `ContainerSessionRunner` |
| Container stop timeout | 5 s | `session-container.ts` |
| Health check interval | 500 ms | `session-container.ts` |
| Health check timeout | 30 s | `session-container.ts` |
| SSE reconnect backoff | 1s -> 10s | `container-session-runner.ts` |
