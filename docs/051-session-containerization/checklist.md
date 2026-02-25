# 051 — Docker-Per-Session Containerization Checklist

## Phase 1: Session Worker + IPC (foundation)

- [ ] Extract shared `SessionRunnerInterface` from `SessionRunner` (start/stop agent, terminal, preview, file watcher methods)
- [ ] Create `src/server/session-worker.ts` — lightweight Fastify server on port 9100
  - [ ] `POST /agent/start` — spawn Claude CLI with PTY
  - [ ] `POST /agent/interrupt` — send SIGINT to agent
  - [ ] `POST /agent/kill` — send SIGTERM to agent
  - [ ] `GET /events` — SSE stream for agent output, terminal output, file changes, preview status
- [ ] Create `src/server/container-session-runner.ts` — `ContainerSessionRunner` class
  - [ ] Delegates `startAgent()` / `interrupt()` / `kill()` to worker HTTP endpoints
  - [ ] Connects SSE event stream and re-emits events via `emitMessage()`
  - [ ] SSE reconnection with exponential backoff (1s, 2s, 4s, max 10s)
- [ ] Test worker as a subprocess (no Docker) — validate agent start/stop/output round-trips
- [ ] Verify existing integration tests pass with `useContainers: false` (fallback mode)

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

## Post-launch

- [ ] Credential mounts: switch `/credentials` to read-only once Claude CLI `--resume` write path is isolated
- [ ] Run worker process as non-root user (uid 1000)
- [ ] Network egress restriction — allowlist `api.anthropic.com`, `github.com`, `registry.npmjs.org`
- [ ] `GIT_OBJECT_DIRECTORY` optimization — allow in-container commits for worktree sessions (skip orchestrator round-trip)
- [ ] Update doc 048 status to superseded by 051 session-ID routing
