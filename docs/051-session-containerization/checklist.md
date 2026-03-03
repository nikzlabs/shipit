# 051 — Docker-Per-Session Containerization Checklist

## Phase 1: Session Worker + IPC (foundation)

- [x] Extract shared `SessionRunnerInterface` from `SessionRunner` (start/stop agent, terminal, preview, file watcher methods)
- [x] Create `src/server/session-worker.ts` — lightweight Fastify server on port 9100
  - [x] `POST /agent/start` — spawn agent via factory
  - [x] `POST /agent/interrupt` — send interrupt to agent
  - [x] `POST /agent/kill` — kill agent
  - [x] `POST /agent/stdin` — write to agent stdin
  - [x] `GET /agent/status` — check if agent is running
  - [x] `GET /events` — SSE stream for agent output (events, done, error, auth_required, log)
  - [x] `GET /health` — health check
- [x] Create `src/server/container-session-runner.ts` — `ContainerSessionRunner` class
  - [x] Delegates `startAgentOnWorker()` / `interruptAgentOnWorker()` / `killAgentOnWorker()` to worker HTTP endpoints
  - [x] `writeAgentStdin()` — write to agent stdin on worker
  - [x] Connects SSE event stream and forwards events to proxy AgentProcess
  - [x] SSE reconnection with exponential backoff (1s, 2s, 4s, max 10s)
  - [x] Full `SessionRunnerInterface` compliance (state, queue, terminal buffer, turn buffer, viewer management)
- [x] `SessionRunnerRegistry` accepts `runnerFactory` to create either direct or container runners
- [x] `AppDeps.runnerFactory` wiring in `buildApp()` for custom runner creation
- [x] Test worker as in-process Fastify server — validate agent start/stop/interrupt/stdin/output round-trips (16 tests)
- [x] Verify existing integration tests pass with `useContainers: false` (fallback mode, all 1604 tests pass)

## Phase 2: Docker Integration

- [x] Add `dockerode` dependency
- [x] Create `src/server/session-container.ts` — `SessionContainerManager`
  - [x] `create()` — create container with resource limits, labels, bind mounts
  - [x] `destroy()` — stop (5s grace) + remove container
  - [x] `destroyAll()` — for `full_reset`
  - [x] `get()` — look up container IP by session ID
- [x] Create Docker bridge network (`shipit`) at startup
  - [x] Auto-create if missing on startup
  - [x] Orchestrator container joins the network
- [x] Create `Dockerfile.session-worker.dev` / `Dockerfile.session-worker.prod` — separate dev and prod session worker images
- [x] Wire `SessionContainerManager` into `AppDeps` and `buildApp()`
- [x] `SessionRunnerRegistry.getOrCreate()` — delegate to `ContainerSessionRunner` when `useContainers: true`
- [x] Docker auto-detection at startup (`docker.ping()`) — fall back to direct mode if unavailable
- [x] Container bind mounts
  - [x] Regular sessions: `${sessionDir}:/workspace:rw`, `${credentialsDir}:/credentials:rw`
  - [x] Worktree sessions: add `${sharedRepoDir}:/repo:ro`
- [x] Resource limits: 512MB memory, 0.5 CPU, 256 PIDs (configurable via AppDeps)
- [x] Container labels: `shipit-session=true`, `shipit-session-id={uuid}`
- [x] Orphan container cleanup on orchestrator startup (scan for stale `shipit-session` containers)
- [x] Health checks — detect container crash/OOM via Docker event stream
- [x] Unit tests for `SessionContainerManager` (mocked dockerode) — 27 tests
- [x] Integration test: full lifecycle (create → activate → container started → shutdown → cleanup) — 5 tests

## Phase 3: Terminal + Preview + File Watcher

- [x] Session worker: terminal PTY endpoints
  - [x] `POST /terminal/start` — spawn shell PTY (with injectable factory for testing)
  - [x] `POST /terminal/input` — write to PTY stdin
  - [x] `POST /terminal/resize` — resize PTY
  - [x] Terminal output (`terminal_data`, `terminal_exit`) streamed via SSE `/events`
- [x] `ContainerSessionRunner`: terminal proxy methods (`startTerminalOnWorker`, `writeTerminalOnWorker`, `resizeTerminalOnWorker`)
- [x] `SessionRunnerInterface.supportsRemoteTerminal` — optional flag for container runners
- [x] Terminal handlers adapted for container mode — delegates to `ContainerSessionRunner` when `supportsRemoteTerminal` is true
- [x] Session worker: preview endpoints
  - [x] `POST /preview/start` — start PreviewManager (with injectable factory for testing)
  - [x] `POST /preview/stop` — stop preview
  - [x] `GET /preview/status` — return running state and detected ports
  - [x] Preview events (`preview_ready`, `preview_stopped`, `preview_config_missing`, `preview_config_error`, `preview_install_status`, `preview_log`) streamed via SSE `/events`
- [x] Create `src/server/preview-proxy.ts` — session-ID-based reverse proxy
  - [x] Route `GET/POST /preview/{sessionId}/{port}/*` → container bridge IP
  - [x] WebSocket upgrade support for HMR
  - [x] Error handling: 400 (invalid port), 404 (unknown session), 502 (unreachable)
- [x] `ContainerSessionRunner.buildPreviewStatus()` — return `/preview/${sessionId}/${port}/` URLs
- [x] Session worker: file watcher (with injectable factory for testing)
  - [x] `POST /files/watch` — start file watcher
  - [x] `POST /files/unwatch` — stop file watcher
  - [x] File change events (`file_changes`) streamed via SSE `/events`
  - [x] `GET /files/tree` — `scanFileTree()` scoped to container `/workspace`
- [x] `ContainerSessionRunner`: file watcher proxy (SSE → `files_changed` message)
- [x] `ContainerSessionRunner`: auto-restart preview when `shipit.yaml` changes detected
- [x] `ContainerSessionRunner`: worker resource lifecycle (`startWorkerResources` / `stopWorkerResources`) on viewer attach/detach
- [x] Port scanning scoped to container's own network namespace (automatic per-container localhost)
- [x] Update `src/client/path-utils.ts` — handle `/workspace/` prefix alongside existing `/workspace/sessions/{uuid}/` format
- [x] Worker cleanup — `stop()` kills terminal, stops preview, stops file watcher
- [x] Git operations routing for worktree sessions (accepted limitation: orchestrator auto-commit works unchanged, in-container git deferred to 067)
- [x] Integration tests (35 tests in `worker-terminal.test.ts`, `worker-preview.test.ts`, `worker-file-watcher.test.ts`)
  - [x] Terminal I/O round-trips through worker endpoints + SSE
  - [x] Terminal proxy via ContainerSessionRunner (start, write, resize, exit)
  - [x] Preview start/stop/status on worker + SSE events
  - [x] Preview proxy via ContainerSessionRunner (ready, stopped, status URLs)
  - [x] File watcher start/stop on worker + SSE file_changes events
  - [x] File watcher proxy via ContainerSessionRunner (files_changed message)
  - [x] Preview reverse proxy routing (404/400 error cases + end-to-end with mock container)
  - [x] Worker cleanup of all resources on stop
- [x] Client path-utils tests (7 tests in `path-utils.test.ts`)

## Phase 4: Session Pre-warming

### 4a: Worktree-level warm pool (done)

- [x] Track last active repo per user (`RepoStore.warmSessionId` keyed by GitHub remote URL)
- [x] `warmSessionForRepo()` in `index.ts` — create worktree session in background when repo reaches "ready"
  - [x] Create worktree from shared repo (or bare clone if repo is empty)
  - [x] Mark session `warm: true` via `SessionManager.setWarm()`
  - [x] Store warm session ID in `RepoStore.setWarmSessionId()`
  - [x] Cache warming promise to prevent duplicate work
- [x] Claim warm session on "New Session" — `findUngraduatedWarm()` in `SessionManager`
  - [x] Claim endpoint in `api-routes.ts` reuses warm session (no container created yet)
  - [x] Triggers re-warming for next session after claim
- [x] Graduation on first message — `send-message.ts` removes `warm: true`, triggers AI naming, re-warms
- [x] Startup validation — verify warm sessions exist after restart, re-warm missing ones
- [x] Integration tests (`warm-sessions.test.ts`, 309 lines)
  - [x] Warm session creation on startup
  - [x] Worktree directory verification
  - [x] Claim endpoint claiming pre-created session
  - [x] Re-warming triggered after claim
  - [x] Graduation on first message

### 4b: Container-level standby pre-warming (done)

- [x] `SessionContainerManager.createStandby()` — boot container for warm session during re-warming
  - [x] Reuses `create()` with `extraLabels` + `CONTAINER_STANDBY_LABEL`
  - [x] Label with `shipit-standby=true` for cleanup identification
- [x] `SessionContainerManager.claimStandby(sessionId)` — claim standby container when user activates warm session
  - [x] Remove standby tracking, return container for runner factory reconnect
- [x] `SessionContainerManager.isStandby()` / `standbyCount` — query standby state
- [x] Standby tracking restored on `rediscover()` after restart
- [x] `warmSessionForRepo(url, { withStandby })` — conditionally boot standby after worktree creation
  - [x] Fetch origin before worktree creation when `withStandby: true`
  - [x] Respect max container cap — skip standby if real containers >= maxIdleContainers
- [x] Runner factory `claimStandby()` on reconnect path — zero cold start for standby containers
- [x] Standby containers excluded from idle cleanup (`enforceIdleContainerLimit`)
- [x] Claim endpoint and graduation pass `{ withStandby: true }` to re-warming
- [x] Startup warming — worktree only, no containers (first "New Session" per repo cold-starts, triggers standby for next)
- [x] Standby destroyed on repo delete and stale startup validation
- [x] Integration tests (7 tests in `standby-container.test.ts`)
  - [x] Startup warming does NOT create standby
  - [x] Claim triggers re-warming with standby container
  - [x] Standby reused on activation (zero cold start)
  - [x] Standby protected from idle cleanup
  - [x] Standby destroyed on repo delete
  - [x] Rediscover restores standby state after restart
  - [x] No standby when at container cap

## Phase 5: Cross-Platform Validation (macOS done, remainder moved to 067)

- [x] macOS (Docker Desktop with virtiofs) — fully validated: socket, bind mounts, performance, bridge networking, graceful fallback
- Remaining platforms (Linux, WSL2) and setup documentation moved to [067-container-hardening](../067-container-hardening/plan.md)

## Post-launch (moved to 067)

All post-launch items (credential mounts, non-root worker, network egress, `--dangerously-skip-permissions`, `GIT_OBJECT_DIRECTORY`, doc 048 update) moved to [067-container-hardening](../067-container-hardening/plan.md).
