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

- [ ] Add `dockerode` dependency
- [ ] Create `src/server/session-container.ts` — `SessionContainerManager`
  - [ ] `create()` — create container with resource limits, labels, bind mounts
  - [ ] `destroy()` — stop (5s grace) + remove container
  - [ ] `destroyAll()` — for `full_reset`
  - [ ] `get()` — look up container IP by session ID
- [ ] Create Docker bridge network (`shipit`) at startup
  - [ ] Auto-create if missing on startup
  - [ ] Orchestrator container joins the network
- [ ] Create `Dockerfile.session-worker` — slim image with Node, git, Claude CLI
- [ ] Wire `SessionContainerManager` into `AppDeps` and `buildApp()`
- [ ] `SessionRunnerRegistry.getOrCreate()` — delegate to `ContainerSessionRunner` when `useContainers: true`
- [ ] Docker auto-detection at startup (`docker.ping()`) — fall back to direct mode if unavailable
- [ ] Container bind mounts
  - [ ] Regular sessions: `${sessionDir}:/workspace:rw`, `${credentialsDir}:/credentials:rw`
  - [ ] Worktree sessions: add `${sharedRepoDir}:/repo:ro`
- [ ] Resource limits: 512MB memory, 0.5 CPU, 256 PIDs (configurable via AppDeps)
- [ ] Container labels: `shipit-session=true`, `shipit-session-id={uuid}`
- [ ] Orphan container cleanup on orchestrator startup (scan for stale `shipit-session` containers)
- [ ] Health checks — detect container crash/OOM via Docker event stream
- [ ] Unit tests for `SessionContainerManager` (mocked dockerode)
- [ ] Integration test: full lifecycle (create → run agent → output → idle timeout → remove)

## Phase 3: Terminal + Preview + File Watcher

- [ ] Session worker: terminal PTY endpoints
  - [ ] `POST /terminal/start` — spawn shell PTY
  - [ ] `POST /terminal/input` — write to PTY stdin
  - [ ] `POST /terminal/resize` — resize PTY
  - [ ] Terminal output streamed via SSE `/events`
- [ ] `ContainerSessionRunner`: terminal proxy methods
- [ ] Session worker: preview endpoints
  - [ ] `POST /preview/start` — start PreviewManager
  - [ ] `POST /preview/stop` — stop preview
  - [ ] `GET /preview/status` — return running state and detected ports
  - [ ] Preview status streamed via SSE `/events`
- [ ] Create `src/server/preview-proxy.ts` — session-ID-based reverse proxy
  - [ ] Route `GET/POST /preview/{sessionId}/{port}/*` → container bridge IP
  - [ ] WebSocket upgrade support for HMR
  - [ ] Port allowlist — only forward to ports the worker reports as active
- [ ] `ContainerSessionRunner.buildPreviewStatus()` — return `/preview/${sessionId}/${port}/` URLs
- [ ] Session worker: file watcher
  - [ ] File change events streamed via SSE `/events`
  - [ ] `GET /files/tree` — `scanFileTree()` scoped to container `/workspace`
- [ ] `ContainerSessionRunner`: file watcher proxy
- [ ] Port scanning scoped to container's own network namespace (automatic per-container localhost)
- [ ] Update `src/client/path-utils.ts` — handle `/workspace/` prefix alongside existing `/workspace/sessions/{uuid}/` format
- [ ] Git operations routing for worktree sessions
  - [ ] Worker detects git write ops (add, commit) and proxies to orchestrator
  - [ ] Orchestrator executes with `GitManager` that has rw access to shared repo
- [ ] Integration tests
  - [ ] Terminal I/O round-trips through container IPC
  - [ ] Preview proxy routes to correct container IP + port
  - [ ] File watcher events flow through SSE to orchestrator to client
  - [ ] Worktree git commit routed through orchestrator

## Phase 4: Speculative Container Pre-warming

- [ ] Track last active repo per user (by GitHub remote URL or local repo hash)
- [ ] `SessionContainerManager.createStandby()` — speculatively create container for predicted next session
  - [ ] Create new session directory (worktree from shared repo or shallow clone)
  - [ ] Bind-mount and boot session worker in background
  - [ ] Label with `shipit-standby=true` for cleanup identification
- [ ] `SessionContainerManager.claimStandby(repoId, sessionId)` — claim standby container when user creates matching session
  - [ ] Reassign session ID, update labels
  - [ ] Return claimed container (skip cold start)
- [ ] `SessionContainerManager.reclaimStandby()` — tear down unclaimed standby container
  - [ ] Auto-reclaim after 5-minute timeout
  - [ ] Auto-reclaim when user creates session on a different repo
  - [ ] Clean up speculative session directory
- [ ] `SessionRunnerRegistry.getOrCreate()` — check for claimable standby before creating new container
- [ ] Respect max container cap — don't pre-warm if all 10 slots are occupied by real sessions
- [ ] Integration tests
  - [ ] Standby container claimed successfully → zero cold start
  - [ ] Standby container reclaimed on timeout
  - [ ] Standby container reclaimed on repo mismatch
  - [ ] No pre-warm when at container cap

## Phase 5: Cross-Platform Validation

- [ ] Docker socket auto-detection — verify `docker.ping()` via default `/var/run/docker.sock` on all platforms
  - [ ] Linux (Docker Engine)
  - [ ] macOS (Docker Desktop with virtiofs)
  - [ ] Windows WSL2 (Docker Desktop WSL2 backend)
  - [ ] Windows WSL2 (Docker Engine installed inside WSL2)
- [ ] Bind mount path validation — confirm absolute paths work without translation
  - [ ] Linux: `/workspace/sessions/{uuid}` → container `/workspace`
  - [ ] macOS: Docker Desktop translates host paths to VM paths transparently
  - [ ] WSL2: WSL2 filesystem paths (`/home/user/...`) mount correctly
- [ ] Performance baseline per platform
  - [ ] Linux: document cold start time, `npm install` duration, file I/O throughput
  - [ ] macOS: document virtiofs overhead vs native (expect ~10-30% slower I/O)
  - [ ] WSL2: verify workspace on WSL2 filesystem (not `/mnt/c/`) for acceptable performance
- [ ] Bridge networking validation — verify orchestrator can reach container IPs on all platforms
- [ ] Graceful fallback — verify `useContainers: false` auto-triggers when Docker is missing on each platform
- [ ] Add setup documentation for each platform (Docker installation prerequisites)

## Post-launch

- [ ] Credential mounts: switch `/credentials` to read-only once Claude CLI `--resume` write path is isolated
- [ ] Run worker process as non-root user (uid 1000)
- [ ] Network egress restriction — allowlist `api.anthropic.com`, `github.com`, `registry.npmjs.org`
- [ ] `--dangerously-skip-permissions` support
  - [ ] Add `skipPermissions` flag to `ContainerConfig` (gated on `useContainers: true`)
  - [ ] Pass `SKIP_PERMISSIONS` env var to container
  - [ ] Session worker reads env var and adds `--dangerously-skip-permissions` to Claude CLI args
  - [ ] **Prerequisite:** credential read-only mount + network egress allowlist must be done first
  - [ ] Default to opt-in initially, flip to default-on after egress restrictions are validated
- [ ] `GIT_OBJECT_DIRECTORY` optimization — allow in-container commits for worktree sessions (skip orchestrator round-trip)
- [ ] Update doc 048 status to superseded by 051 session-ID routing
