# Session Architecture

This document describes the full lifecycle of sessions in ShipIt: creation, warm-up, activation, container management, preview delivery, idle disposal, reconnection, and shutdown.

## Key Components

| Component | Location | Role |
|-----------|----------|------|
| `SessionManager` | `orchestrator/sessions.ts` | Persists session metadata (title, workspace dir, remote URL, warm flag) to JSON |
| `SessionRunnerRegistry` | `orchestrator/session-runner.ts` | App-level map of session ID → runner. Enforces max concurrent runners (default 10) |
| `SessionRunnerInterface` | `orchestrator/session-runner.ts` | Abstract contract: agent state, message queue, viewer count, preview, idle timer |
| `SessionRunner` | `orchestrator/session-runner.ts` | In-process implementation (test-only). Spawns agent/terminal directly |
| `ContainerSessionRunner` | `orchestrator/container-session-runner.ts` | Production implementation. Delegates to per-session Docker container via HTTP+SSE |
| `SessionContainerManager` | `orchestrator/session-container.ts` | Docker orchestration: create, destroy, health monitor, orphan cleanup |
| Session Worker | `session/session-worker.ts` | Fastify server (port 9100) inside each container. Manages agent, terminal, preview, file watcher |
| `RepoStore` | `orchestrator/repo-store.ts` | Tracks imported repos, clone status, warm session IDs |

## Layered Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (React SPA)                   │
│  Zustand stores ← useSessionWebSocket ← WS messages    │
│                 ← useConnectionSync   ← HTTP fallbacks  │
└──────────────────────┬──────────────────────────────────┘
                       │  WS /ws/sessions/:id
                       │  HTTP /api/sessions/*, /api/repos/*
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Orchestrator (Fastify, single process)      │
│                                                          │
│  buildApp() → routes, WS handler, warm pool, SSE        │
│  SessionRunnerRegistry → ContainerSessionRunner          │
│  SessionContainerManager → Docker API                    │
└──────────────────────┬──────────────────────────────────┘
                       │  HTTP to container IP:9100
                       │  SSE /events (long-lived)
                       ▼
┌─────────────────────────────────────────────────────────┐
│         Session Worker (one per Docker container)        │
│                                                          │
│  /agent/start, /preview/start, /files/watch, /events    │
│  Claude CLI process, PreviewManager, FileWatcher         │
└─────────────────────────────────────────────────────────┘
```

## Session Types

1. **Standalone session** — no repo, fresh git repo initialized in the session directory. Created via `POST /api/sessions`.
2. **Worktree session** — backed by a shared repo clone. Session directory is a git worktree branching from the repo's default branch. Created via warm pool or `claim-session`.
3. **Warm session** — a worktree session pre-created in the background with runner and preview already running. Invisible in the sidebar until the user sends their first message ("graduated").

## Session Creation

### Path A: Standalone Session (no repo)

```
Client                          Server
  │                               │
  ├─ POST /api/sessions ────────→ │ createSessionDir(title)
  │  {title}                      │   mkdir sessions/{uuid}
  │                               │   git init
  │                               │   configure credentials
  │                               │   sessionManager.track()
  │                               │   threadManager.init()
  │← {sessionId, sessionDir} ─────┤
  │                               │
  │  store pendingWsMessage       │
  │  navigate(/session/{id})      │
  │                               │
  │  useSessionWebSocket opens    │
  ├─ WS /ws/sessions/{id} ──────→ │ activateSession(id)
  │                               │   runnerRegistry.getOrCreate()
  │                               │     → factory creates container
  │                               │   attachToRunner()
  │                               │
  │  useConnectionSync fires      │
  ├─ GET /api/sessions/{id}/history →│ returns messages, commits, etc.
  │                               │
  │  send pendingWsMessage        │
  ├─ WS send_message ───────────→ │ handleSendMessage()
  │                               │   POST /agent/start to worker
  │← WS streaming events ─────────┤
```

### Path B: Warm Session (repo, pool hit)

```
Client                          Server
  │                               │
  │  navigate(/{owner}/{repo}/new)│
  ├─ POST /api/repos/:url/claim-session →│
  │                               │  repo.warmSessionId exists?
  │                               │  warmRunner alive?
  │                               │  YES → return warm session
  │                               │  clear warmSessionId
  │                               │  start warming next session
  │← {sessionId} ─────────────────┤
  │                               │
  │  store pendingWsMessage       │
  │  navigate(/session/{id})      │
  │                               │
  │  WS /ws/sessions/{id} ──────→ │ activateSession(id)
  │                               │   runnerRegistry.get() → existing runner
  │                               │   attachToRunner()
  │                               │   runner.previewStatusKnown = true
  │← WS preview_status ───────────┤   (preview already running)
  │                               │
  │  send pendingWsMessage        │
  ├─ WS send_message ───────────→ │ graduates warm session
  │                               │   (rename, clear warm flag, broadcast)
```

### Path C: Claim Session (repo, no warm pool)

Same as Path B but `claim-session` creates the session synchronously:

1. `createSessionDir(title, { skipGitInit: true })`
2. Create git worktree from shared repo clone
3. Configure credentials
4. `runnerRegistry.getOrCreate()` → creates runner + container
5. `runner.attachViewer(); runner.detachViewer()` → starts preview + file watcher
6. Return session ID to client

## Warm Session Pool

The warm pool pre-creates one session per repo so users get instant "New Session" with a running preview.

### Warm-Up Sequence

```
warmSessionForRepo(repoUrl):
  1. Check repo.status === "ready" and no existing warm session
  2. createSessionDir("Warm session", { skipGitInit: true })
  3. sessionManager.setWarm(appSessionId, true)
  4. Remove empty dir (worktree add needs it absent)
  5. repoGit.createWorktree(sessionDir, branchPrefix, startPoint)
  6. Configure git credentials
  7. runnerRegistry.getOrCreate(appSessionId, sessionDir, defaultAgentId)
     → runner factory creates Docker container (async)
  8. runner.attachViewer()   ← triggers SSE connect + startWorkerResources
  9. runner.detachViewer()   ← decrements viewer count, resources keep running
 10. repoStore.setWarmSessionId(repoUrl, appSessionId)
 11. sseBroadcast("repo_warm_ready", ...)
```

### Startup Re-Warming

On server start, all "ready" repos whose warm sessions are missing are re-warmed via `setTimeout(0)` (deferred until after `buildApp()` returns).

### Graduation

When the user sends their first message on a warm session, `handleSendMessage` "graduates" it:
- Clears the `warm` flag
- Renames from "Warm session" to a meaningful title
- Broadcasts `session_list` update (session appears in sidebar)

## Session Activation (Per-Session WebSocket)

The client connects to `ws[s]://host/ws/sessions/{sessionId}?agent=claude`. The server handles this in `buildApp()`:

### Server-Side (on WS connect)

```
1. Validate session exists (close 4004 if not)
2. Initialize per-connection state:
   - activeAppSessionId = sessionId
   - activeSessionDir = session.workspaceDir
   - perConnectionAgentId = query.agent ?? defaultAgentId
3. activateSession(sessionId):
   a. existingRunner = runnerRegistry.get(sessionId)
   b. If exists: attachToRunner(existingRunner)
   c. Else: runner = runnerRegistry.getOrCreate(sessionId, dir, agentId)
            attachToRunner(runner)
4. Send log buffer
5. Re-send preview_status after log buffer (React batching mitigation)
```

### attachToRunner(runner)

```
1. Detach from any previous runner
2. Subscribe runner.on("message", send)
3. runner.attachViewer() — increments viewer count
4. Replay turn event buffer (all events from current turn)
5. Send queue status if messages are queued
6. Send session_status if agent is running
7. Send preview_status ONLY IF runner.previewStatusKnown === true
   (otherwise, the runner will emit it later when SSE delivers state)
8. If previewStatusKnown === false:
   Register a one-shot "message" listener on the runner. When the first
   preview_status arrives, schedule a delayed re-send (300ms) so it
   arrives in its own event-loop turn and survives React 18 batching.
   (useWebSocket stores messages via setLastMessage — React batches
   rapid state updates, potentially dropping intermediate messages.)
```

### Client-Side (on WS open)

```
useConnectionSync:
  1. GET /api/sessions/{id}/history → messages, commits, fileTree, threads
  2. GET /api/sessions/{id}/preview-status → HTTP fallback for preview state
     (only applied if store still has preview=null)
     If response is known: false → retry once after 3s (by then SSE has connected)
  3. Send pendingWsMessage if present
```

## Runner Lifecycle

### SessionRunnerRegistry

- Maintains `Map<string, SessionRunnerInterface>` (session ID → runner)
- **`getOrCreate(sessionId, sessionDir, agentId)`**:
  1. Return existing non-disposed runner if found
  2. If at capacity (default 10), evict oldest idle runner (not running, no viewers)
  3. Call runner factory to create new runner
  4. Register `"disposed"` listener for auto-cleanup from map
- **`get(sessionId)`**: Returns runner if exists and not disposed

### Runner Factory (Production)

The factory in `buildApp()` handles three cases:

```
factory(opts):
  existing = containerManager.get(opts.sessionId)

  CASE 1: existing && status === "running"
    → Reconnect: new ContainerSessionRunner({ workerUrl: existing.workerUrl })
    → No container creation needed — SSE replay delivers current state

  CASE 2: existing && status !== "running" (stale)
    → runner = new ContainerSessionRunner({ workerUrl: "http://0.0.0.0:0" })
    → mgr.destroy(sessionId).then(() => mgr.create(config))
      .then((sc) => runner.setWorkerUrl(sc.workerUrl))

  CASE 3: no existing container
    → runner = new ContainerSessionRunner({ workerUrl: "http://0.0.0.0:0" })
    → mgr.create(config).then((sc) => runner.setWorkerUrl(sc.workerUrl))
```

The factory is **synchronous** — it returns the runner immediately. Container creation happens async; the runner queues all operations behind `_workerReady` (a promise resolved by `setWorkerUrl()`).

### Idle Timer

Both `SessionRunner` and `ContainerSessionRunner` implement idle disposal:

```
resetIdleTimer():
  clearTimeout(existing)
  setTimeout(() => {
    if (!running && queue.length === 0 && viewerCount === 0):
      dispose()
  }, idleTimeoutMs)  // default: 10 minutes
```

The timer resets on construction and when `onAgentFinished()` fires.

### Eviction

When `getOrCreate` hits the concurrent runner limit (default 10), it evicts the oldest runner that has no running agent and no viewers. Eviction calls `dispose()`, which:
- For `ContainerSessionRunner`: disconnects SSE, kills agent, but does NOT stop the Docker container
- For `SessionRunner`: kills agent, terminal, clears buffers

## Container Lifecycle

### Container Creation

```
SessionContainerManager.create(config):
  1. Build Docker mounts:
     - session dir → /user (read-write)
     - credentials dir → /credentials (read-only)
     - shared repo dir → same absolute path (for worktree resolution)
  2. docker.createContainer({
       Image: "shipit-session-worker:latest",
       Cmd: ["node", "--import", "tsx", "src/server/session/session-worker.ts"],
       NetworkingConfig: { shipit bridge network },
       HostConfig: { Memory: 512MB, CpuQuota: 50000, PidsLimit: 256 },
       Labels: { "shipit-session-id": sessionId },
     })
  3. container.start()
  4. container.inspect() → get bridge IP
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

### Orphan Cleanup

On startup:
```
containerManager.cleanupOrphans(activeSessionIds):
  1. docker.listContainers({ filters: { label: ["shipit-session-id"] } })
  2. For each container not in activeSessionIds:
     - container.stop() + container.remove()
  3. Return count of removed containers
```

### Container Persistence Across Runner Disposal

When a `ContainerSessionRunner` is disposed (idle timeout, eviction), the Docker container is NOT stopped. The `dispose()` method:
- Kills the agent process in the container (fire-and-forget)
- Does NOT call `/preview/stop` or `/files/unwatch`
- Disconnects the SSE stream
- Emits `"disposed"` → removed from `SessionRunnerRegistry`

The container keeps running with its preview server and file watcher active. This enables fast reconnection — a new runner can reconnect to the existing container without restarting anything.

## ContainerSessionRunner Internals

### Worker Ready Promise

The runner initializes with a `_workerReady` promise. All HTTP calls to the worker (`workerPost`, `workerGet`) await this promise before executing. When the constructor receives a real URL (not `"http://0.0.0.0:0"`), the promise resolves immediately (reconnect case). Otherwise, it resolves when `setWorkerUrl()` is called after container creation completes.

### SSE Event Stream

```
connectEventStream():
  1. Await _workerReady
  2. Open GET {workerUrl}/events (Server-Sent Events)
  3. Parse incoming events → handleSSEEvent()
  4. On error/close: exponential backoff reconnect (1s, 2s, 4s, 8s, 10s cap)
```

SSE events map to actions:
| SSE Event | Action |
|-----------|--------|
| `agent_event` | Forward to ProxyAgentProcess → emitted as WS `assistant_*` messages |
| `agent_done` | Forward to ProxyAgentProcess → triggers onAgentFinished |
| `preview_ready` | Update local ports, set `_previewStateReceived=true`, emit preview_status |
| `preview_stopped` | Clear ports, emit preview_status |
| `preview_config_missing` | Emit config_missing |
| `preview_install_status` | Emit install status |
| `file_changes` | Emit files_changed. If shipit.yaml changed, restart preview |
| `terminal_data` | Emit terminal_output |

### SSE Replay

When the SSE connection opens (or reconnects), the session worker replays current state:
- If preview is running with ports → sends `preview_ready`
- If preview crashed → replays recent log lines + `preview_stopped`
- If terminal is alive → sends empty `terminal_data` signal

This ensures the runner always has current state, even after SSE reconnect.

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
  POST {workerUrl}/files/watch   ← idempotent
  POST {workerUrl}/preview/start ← returns 409 if already running (reconnect case)
```

## Preview Status Delivery

Preview status reaches the client through multiple redundant paths:

### Primary Path: SSE → Runner → WS

```
Container: PreviewManager emits "ready"
    → SessionWorker broadcasts SSE event "preview_ready"
    → ContainerSessionRunner.handleSSEEvent() processes it
    → runner.emitMessage(buildPreviewStatus())
    → WS message listener on the connection sends to client
    → Client updates usePreviewStore
```

### Secondary Path: Server-Side Delayed Re-send

When `attachToRunner` finds `previewStatusKnown === false`, it registers a one-shot listener on the runner. When the first `preview_status` message arrives (from SSE replay), the listener schedules a re-send after 300ms via `setTimeout`. This ensures the message arrives in its own event-loop turn, immune to React 18 `setLastMessage` batching where intermediate WS messages can be dropped.

### Tertiary Path: HTTP Fallback + Retry

```
Client (useConnectionSync → loadSessionHistory):
  GET /api/sessions/{id}/preview-status
  Server checks runner.previewStatusKnown:
    - true → returns { known: true, running, port, url, ... }
    - false → returns { known: false } → client retries once after 3s
  Client only applies if store still has preview=null
```

The 3-second retry covers the case where `known` is initially false (runner SSE hasn't connected yet). By the retry, the SSE should have connected and the endpoint returns the actual state.

### Quaternary Path: Log Buffer Mitigation

After sending the log buffer to a newly connected WS client, the server re-sends `preview_status` if the runner has known state. This prevents React 18 automatic batching from swallowing the initial preview_status in a burst of rapid WS messages.

### SSE Replay on Reconnect

When the `ContainerSessionRunner` SSE reconnects (after backoff), the worker replays current preview state. This covers the case where the runner was created and SSE connected, but the preview started between SSE connections.

### Why So Many Paths?

The `useWebSocket` hook stores incoming messages as React state via `setLastMessage(event)`. When the server sends a burst of WS messages in the same event-loop tick (turn buffer replay, queue/session status, preview status, log entries), React 18 batches the `setLastMessage` calls and only the **last** value triggers a re-render. Intermediate messages are silently dropped. Each redundant delivery path mitigates a different timing window where the primary WS delivery can fail.

## Session Switching (Client-Side)

### Switching to an Existing Session

```
handleSessionResume(sessionId, navigate):
  1. resumeSessionInternal(sessionId):
     a. Set sessionId in session store
     b. Clear messages, loading, queue
     c. Reset all session-specific stores (files, git, threads, terminal, UI, preview)
        → preview store reset to null
     d. loadSessionHistory(sessionId) via HTTP (async)
  2. navigate("/session/{sessionId}")
     → URL change triggers React re-render
     → useSessionWebSocket computes new WS URL
     → useWebSocket closes old WS, opens new WS
```

Server-side effects:
```
Old WS close:
  → socket.on("close") fires
  → detachFromRunner() — decrements viewer count on old runner
  → Old runner may start idle timer (if no other viewers)

New WS open:
  → activateSession(newSessionId)
  → getOrCreate() gets (or creates) runner
  → attachToRunner() — subscribes to events, replays state
```

### Creating a New Session from Home

```
newSession(navigate):
  1. Clear sessionId
  2. Reset all session state
  3. Show templates
  4. navigate("/")
  → WS disconnects when leaving /session/* URL
```

## Idle Disposal and Reconnection

### Disposal Trigger

After `idleTimeoutMs` (default 10 minutes) with no running agent, no queued messages, and no viewers:

```
ContainerSessionRunner.dispose():
  1. POST /agent/kill to worker (fire-and-forget)
  2. Do NOT stop preview or file watcher
  3. Disconnect SSE stream
  4. Clear timers, buffers, listeners
  5. Emit "disposed" → removed from SessionRunnerRegistry
```

The Docker container continues running. Preview server, file watcher, and all container state persist.

### Reconnection

When a user returns to a session whose runner was disposed:

```
1. WS connects to /ws/sessions/{id}
2. activateSession(id):
   a. runnerRegistry.get(id) → undefined (runner was disposed)
   b. runnerRegistry.getOrCreate(id, dir, agentId)
      → calls runner factory
      → factory checks containerManager.get(id)
      → existing container with status "running" found
      → creates new ContainerSessionRunner with existing workerUrl
      → _workerReady resolves immediately (real URL)
3. attachToRunner(runner):
   a. runner.attachViewer()
      → first viewer: connectEventStream() then startWorkerResources()
      → SSE connects to running container
      → Worker replays current state (preview_ready, etc.)
      → startWorkerResources():
        - POST /files/watch → idempotent (already watching)
        - POST /preview/start → 409 "already running" → handled gracefully
   b. Send preview_status if runner.previewStatusKnown
4. Client receives preview state → shows preview immediately
```

**No container restart. No preview restart. Instant reconnect.**

## Graceful Shutdown

```
app.addHook("onClose"):
  1. authManager.kill()
  2. runnerRegistry.disposeAll()
     → each runner: kill agent, disconnect SSE, emit "disposed"
  3. containerManager.dispose()
     → for each container: stop + remove
```

All Docker containers are destroyed on server shutdown. On next startup, orphan cleanup catches any that survived an unclean shutdown.

## Sequence Diagrams

### Full Session Lifecycle (Happy Path)

```
User clicks "+ New Session" on a repo

  ┌──────────┐    ┌─────────────┐    ┌────────────┐    ┌───────────────┐
  │  Browser  │    │ Orchestrator│    │  Container  │    │ Session Worker│
  │  (React)  │    │  (Fastify)  │    │  Manager    │    │  (in Docker)  │
  └─────┬─────┘    └──────┬──────┘    └──────┬──────┘    └───────┬───────┘
        │                 │                  │                   │
  1. POST claim-session   │                  │                   │
        ├────────────────→│                  │                   │
        │     return warm │session ID        │                   │
        │←────────────────┤                  │                   │
        │                 │                  │                   │
  2. navigate(/session/id)│                  │                   │
        │                 │                  │                   │
  3. WS connect           │                  │                   │
        ├────────────────→│                  │                   │
        │    activateSession                 │                   │
        │    getOrCreate → │existing runner  │                   │
        │    attachToRunner│                 │                   │
        │←─ preview_status┤                 │                   │
        │                 │                  │                   │
  4. GET /history         │                  │                   │
        ├────────────────→│                  │                   │
        │←─ messages, etc.┤                  │                   │
        │                 │                  │                   │
  5. WS send_message      │                  │                   │
        ├────────────────→│                  │                   │
        │          POST /agent/start         │                   │
        │                 ├──────────────────┼──────────────────→│
        │                 │            SSE agent_event           │
        │                 │←─────────────────┼───────────────────┤
        │←─ WS assistant  │                  │                   │
        │                 │                  │                   │
  ... (streaming continues until agent_done) │                   │
        │                 │                  │                   │
  6. User closes tab      │                  │                   │
        │─WS close───────→│                  │                   │
        │     detachViewer │                  │                   │
        │     idle timer starts              │                   │
        │                 │                  │                   │
  7. (10 min later)       │                  │                   │
        │     runner.dispose()               │                   │
        │     disconnect SSE                 │                   │
        │     (container stays running)      │    ← still alive  │
        │                 │                  │                   │
  8. User returns         │                  │                   │
        ├─WS connect─────→│                  │                   │
        │     getOrCreate → │factory          │                   │
        │     mgr.get(id) → │running          │                   │
        │     → reconnect (reuse workerUrl)  │                   │
        │     attachViewer → │SSE connect     │                   │
        │                 ├──────────────────┼────── SSE ───────→│
        │                 │           SSE replay (preview_ready) │
        │                 │←─────────────────┼───────────────────┤
        │←─ WS preview_status                │                   │
```

### Container Crash and Recovery

```
  ┌──────────┐    ┌─────────────┐    ┌────────────┐    ┌───────────────┐
  │  Browser  │    │ Orchestrator│    │  Container  │    │    Docker     │
  └─────┬─────┘    └──────┬──────┘    │  Manager    │    └───────┬───────┘
        │                 │           └──────┬──────┘            │
        │                 │                  │                   │
  1. Container OOM-killed │                  │                   │
        │                 │           health monitor ←── die event
        │                 │                  ├───────────────────┤
        │                 │  container_exited │                   │
        │                 │←─────────────────┤                   │
        │                 │                  │                   │
  2. runner.emitMessage(session_status error)│                   │
        │←─ WS error ─────┤                  │                   │
        │   runner.dispose()                 │                   │
        │                 │                  │                   │
  3. User clicks session  │                  │                   │
        ├─WS connect─────→│                  │                   │
        │    getOrCreate → │factory           │                   │
        │    mgr.get(id) → │undefined (crash removed it)         │
        │    mgr.create(config)              │                   │
        │                 ├─────────────────→│                   │
        │                 │           docker.createContainer     │
        │                 │                  ├──────────────────→│
        │                 │           docker.start               │
        │                 │                  ├──────────────────→│
        │                 │           health check passes        │
        │                 │           runner.setWorkerUrl()      │
        │                 │←─────────────────┤                   │
        │←─ WS preview_status (new container)│                   │
```

## Data Flow Summary

| Source | Transport | Destination | Examples |
|--------|-----------|-------------|----------|
| Worker → Runner | SSE (`/events`) | `handleSSEEvent()` | agent_event, preview_ready, file_changes |
| Runner → Client | WS (per-session) | `useMessageHandler` | assistant_message, preview_status, files_changed |
| Client → Server | HTTP (`/api/*`) | Route handlers | create session, get history, claim session |
| Client → Server | WS | Message dispatcher | send_message, interrupt_claude, terminal_input |
| Server → Client | HTTP response | Direct | session history, preview status, bootstrap data |
| Server → All Clients | SSE (`/api/events`) | `useSSE` hook | session_list, repo_warm_ready, active_runners |
| Runner → Worker | HTTP POST | Worker routes | /agent/start, /preview/start, /files/watch |

## Configuration Constants

| Constant | Default | Location | Purpose |
|----------|---------|----------|---------|
| `maxConcurrentRunners` | 10 | SessionRunnerRegistry | Max runners in memory |
| `defaultIdleTimeoutMs` | 600,000 (10 min) | SessionRunnerRegistry | Runner auto-dispose after no activity |
| Worker port | 9100 | session-worker.ts | HTTP server inside each container |
| Container memory | 512 MB | session-container.ts | Docker memory limit |
| Container CPU | 0.5 (50,000 quota) | session-container.ts | Docker CPU limit |
| Container PIDs | 256 | session-container.ts | Docker PID limit |
| Health check interval | 500 ms | session-container.ts | Polling interval for container readiness |
| Health check timeout | 30 s | session-container.ts | Max wait for container to become healthy |
| SSE reconnect backoff | 1s → 10s | container-session-runner.ts | Exponential backoff cap |
| Container stop timeout | 5 s | session-container.ts | Grace period before force-kill |
