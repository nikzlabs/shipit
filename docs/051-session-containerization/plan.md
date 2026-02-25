---
status: planned
---

# 051 — Docker-Per-Session Containerization

## Problem

Today all sessions run as sibling processes on the same host. `SessionRunner` provides logical isolation (own agent, terminal, preview, file watcher per session), but there is no OS-level boundary between them. This creates three concrete problems:

1. **Port collisions.** HTML-mode previews hardcode port 5173. Command-mode previews use framework defaults (3001, 8080, etc.). Two sessions running the same framework fight for the same port — the second one fails or silently falls back to an unknown port. The port scanner reports the same detected ports to every session, so session A's dev server can appear in session B's preview dropdown.

2. **No filesystem isolation.** Claude CLI runs arbitrary code with `cwd: sessionDir`, but nothing prevents it from reading or writing `/workspace/sessions/<other-uuid>/`. A malicious or confused prompt can access another session's files.

3. **No resource limits.** A runaway `npm install` or infinite loop in one session can starve CPU/memory from all other sessions. There is no per-session capping.

### Goal

Each session's agent, terminal, preview server, and file watcher run inside a dedicated Docker container with:
- Isolated network namespace (port conflicts impossible)
- Isolated filesystem (only own session dir mounted)
- Resource limits (CPU, memory caps per session)
- No access to Docker socket or host resources

The orchestrator (Fastify server) remains on the host, managing session metadata, auth, and WebSocket routing. Untrusted code (Claude CLI, user dev servers) runs only inside session containers.

### Non-goals

- **Multi-host orchestration.** This design targets a single Docker host. Kubernetes/Swarm is a future concern.
- **Custom base images per session.** All sessions share one image. Per-session package installs happen inside the container at runtime.
- **Live migration.** Containers are ephemeral — tied to the session runner lifecycle, not persisted across server restarts.
- **Generic pre-warmed container pool.** A pool of idle containers without workspaces won't work because Docker bind mounts are immutable after creation. However, *speculative* pre-warming for the most recently used repo is viable — see Phase 4.

---

## Design Overview

```
Before (current):
  Fastify (:3000)
  ├── SessionRunner(A) ──spawns──▶ claude, terminal, preview (all host processes)
  ├── SessionRunner(B) ──spawns──▶ claude, terminal, preview (all host processes)
  └── shared: /workspace, network, ports

After (proposed):
  Fastify (:3000)  [orchestrator — host process]
  ├── manages session metadata, auth, WS routing
  ├── talks to Docker API via docker.sock
  │
  ├── Container(A) [isolated network + filesystem]
  │   ├── session-worker process (lightweight Node server)
  │   ├── claude CLI (PTY)
  │   ├── terminal (PTY)
  │   ├── preview server (port 5173 — no conflict, own network)
  │   └── file watcher
  │   └── volume: /workspace/sessions/{A}/ → /workspace
  │
  └── Container(B) [isolated network + filesystem]
      ├── session-worker process
      ├── claude CLI, terminal, preview (port 5173 — no conflict)
      └── volume: /workspace/sessions/{B}/ → /workspace
```

### Key Principles

- **Orchestrator never runs untrusted code.** Claude CLI, user terminals, and preview servers run exclusively inside containers.
- **Containers are transparent to the client.** The WebSocket protocol and HTTP API remain unchanged. The client does not know whether a session is containerized.
- **Containers follow SessionRunner lifecycle.** Created when a runner is needed (first `send_message` or `activate_session`), disposed on idle timeout or archive. Same 10-runner cap, same 10-minute idle timeout.
- **Graceful fallback.** A `useContainers: false` flag preserves the current behavior for development, testing, and environments without Docker.

---

## Detailed Design

### 1. Architecture Split: Orchestrator vs Session Worker

The current monolithic Fastify server splits into two roles:

**Orchestrator** (host process — existing `buildApp()`):
- Fastify HTTP server + WebSocket endpoint
- Session metadata (`SessionManager`, `ChatHistoryManager`)
- Auth (`AuthManager`, `GitHubAuthManager`, `CredentialStore`)
- Deployment management (`DeploymentManager`, `DeploymentStore`)
- Usage tracking (`UsageManager`)
- Docker container lifecycle (`SessionContainerManager`)
- WebSocket message routing (proxy to/from containers)

**Session Worker** (inside each container — new lightweight process):
- Claude CLI spawning and PTY management
- Terminal PTY
- Preview server (PreviewManager)
- File watcher
- Git operations (per-session GitManager)
- Port scanning (scoped to container's own network)
- Exposes a simple IPC channel (Unix socket or HTTP) for the orchestrator

The worker is a thin Node process that exposes the same operations `SessionRunner` currently performs, but over an IPC boundary instead of in-process method calls.

### 2. SessionContainerManager

New class that replaces direct process spawning in `SessionRunnerRegistry`. Uses [dockerode](https://github.com/apocas/dockerode) to manage container lifecycle.

```typescript
// src/server/session-container.ts

import Docker from "dockerode";

interface ContainerConfig {
  sessionId: string;
  sessionDir: string;       // host path: /workspace/sessions/{uuid}
  sharedRepoDir?: string;   // host path: /workspace/repos/{hash} (for worktree sessions)
  credentialsDir: string;   // host path: /credentials (read-only)
  imageName: string;        // e.g. "shipit-session-worker:latest"
  memoryLimit: number;      // bytes, default 512MB
  cpuQuota: number;         // microseconds per 100ms period, default 50000 (0.5 CPU)
}

interface SessionContainer {
  id: string;              // Docker container ID
  sessionId: string;
  ipcPort: number;         // host port mapped to container's IPC server
  previewPort: number;     // host port mapped to container's 5173
  status: "starting" | "running" | "stopping" | "stopped";
}

export class SessionContainerManager {
  private docker: Docker;
  private containers = new Map<string, SessionContainer>();
  private portPool: PortPool;

  constructor(opts: {
    socketPath?: string;           // default: /var/run/docker.sock
    imageName?: string;            // default: shipit-session-worker:latest
    portRange?: [number, number];  // default: [10000, 10999]
    memoryLimit?: number;          // default: 512MB
    cpuQuota?: number;             // default: 50000
  }) { /* ... */ }

  async create(config: ContainerConfig): Promise<SessionContainer> {
    const ipcPort = this.portPool.allocate();
    const previewPort = this.portPool.allocate();

    const container = await this.docker.createContainer({
      Image: config.imageName,
      Cmd: ["node", "dist/session-worker.js"],
      HostConfig: {
        Binds: [
          `${config.sessionDir}:/workspace:rw`,
          `${config.credentialsDir}:/credentials:ro`,
          // For worktree sessions: mount shared repo read-only so git can
          // resolve objects without allowing writes to shared state
          ...(config.sharedRepoDir ? [`${config.sharedRepoDir}:/repo:ro`] : []),
        ],
        PortBindings: {
          "9100/tcp": [{ HostPort: String(ipcPort) }],    // IPC
          "5173/tcp": [{ HostPort: String(previewPort) }], // preview
        },
        Memory: config.memoryLimit,
        CpuQuota: config.cpuQuota,
        CpuPeriod: 100_000,
        NetworkMode: "bridge",  // isolated network per container
        SecurityOpt: ["no-new-privileges"],
        ReadonlyRootfs: false,  // needs write for node_modules, tmp
      },
      Env: [
        `SESSION_ID=${config.sessionId}`,
        `WORKSPACE_DIR=/workspace`,
        "HOME=/root",
      ],
    });

    await container.start();
    // ... health check, return SessionContainer
  }

  async destroy(sessionId: string): Promise<void> {
    const sc = this.containers.get(sessionId);
    if (!sc) return;
    try {
      const container = this.docker.getContainer(sc.id);
      await container.stop({ t: 5 });  // 5s grace period
      await container.remove();
    } catch { /* already stopped */ }
    this.portPool.release(sc.ipcPort);
    this.portPool.release(sc.previewPort);
    this.containers.delete(sessionId);
  }

  get(sessionId: string): SessionContainer | undefined {
    return this.containers.get(sessionId);
  }

  async destroyAll(): Promise<void> { /* for full_reset */ }
}
```

### 3. Port Pool

Simple port allocator from a reserved range, replacing the global port scanner for managed ports.

```typescript
// src/server/port-pool.ts

export class PortPool {
  private available: number[];
  private allocated = new Set<number>();

  constructor(rangeStart: number, rangeEnd: number) {
    this.available = [];
    for (let p = rangeStart; p <= rangeEnd; p++) {
      this.available.push(p);
    }
  }

  allocate(): number {
    const port = this.available.pop();
    if (port === undefined) throw new Error("Port pool exhausted");
    this.allocated.add(port);
    return port;
  }

  release(port: number): void {
    if (this.allocated.delete(port)) {
      this.available.push(port);
    }
  }
}
```

Each container needs 2 host ports (IPC + preview primary). With 10 max containers, that's 20 ports from a 1000-port range — plenty of headroom for additional preview ports if needed.

### 4. Session Worker Process

New lightweight Node process that runs inside each container. Exposes operations over a local HTTP server on port 9100.

```typescript
// src/server/session-worker.ts

import Fastify from "fastify";

const app = Fastify();
const sessionId = process.env.SESSION_ID!;
const workspaceDir = process.env.WORKSPACE_DIR!;

// Each worker owns exactly one session's resources:
let agent: AgentProcess | null = null;
let terminal: TerminalProcess | null = null;
let preview: PreviewManager | null = null;
let fileWatcher: FileWatcher | null = null;
let gitManager: GitManager;

// --- IPC endpoints ---

// Start/stop agent
app.post("/agent/start", async (req) => { /* spawn Claude CLI */ });
app.post("/agent/interrupt", async () => { /* kill -SIGINT */ });
app.post("/agent/kill", async () => { /* kill -SIGTERM */ });

// Terminal
app.post("/terminal/start", async () => { /* spawn PTY */ });
app.post("/terminal/input", async (req) => { /* write to PTY */ });
app.post("/terminal/resize", async (req) => { /* resize PTY */ });

// Preview
app.post("/preview/start", async () => { /* start PreviewManager */ });
app.post("/preview/stop", async () => { /* stop */ });
app.get("/preview/status", async () => { /* return ports, running */ });

// File operations
app.get("/files/tree", async () => { /* scanFileTree */ });
app.get("/files/read", async (req) => { /* read file */ });

// Git operations
app.post("/git/commit", async (req) => { /* auto-commit */ });
app.get("/git/log", async () => { /* git log */ });
app.get("/git/diff", async () => { /* git diff */ });

// Event stream (SSE or WebSocket) for real-time output
app.get("/events", async (req, reply) => {
  // SSE stream: agent events, terminal output, file changes, preview status
  // Orchestrator connects here and forwards to client WebSocket
});

await app.listen({ port: 9100, host: "0.0.0.0" });
```

### 5. IPC: Orchestrator ↔ Container Communication

The orchestrator communicates with each container's worker via HTTP on the allocated IPC port. For streaming (agent events, terminal output), it uses an SSE connection.

```
Orchestrator                          Container Worker
────────────                          ────────────────

 POST /agent/start  ───────────────▶  spawn Claude CLI

 GET  /events       ◀─── SSE ──────  agent_event, terminal_output,
                                      file_changes, preview_status

 POST /terminal/input ─────────────▶  write to PTY

 GET  /preview/status ─────────────▶  return { running, port }
```

**Why HTTP+SSE instead of raw WebSocket or gRPC:**
- Fastify is already a dependency — no new libraries needed in the worker
- SSE is simpler than WebSocket for unidirectional server→client streaming
- HTTP requests map naturally to the existing `HandlerContext` operations
- Easy to debug with curl

### 6. Modified SessionRunner

`SessionRunner` becomes a **proxy** that delegates to the container worker instead of spawning processes directly. The public API stays identical — `HandlerContext` and WebSocket handlers don't change.

```typescript
// Changes to SessionRunner (conceptual)

export class SessionRunner extends EventEmitter {
  private container: SessionContainer | null = null;
  private eventSource: EventSource | null = null;  // SSE connection to worker

  // Instead of: this.agent = new ClaudeAdapter(...)
  // Now:        POST container:9100/agent/start
  async startAgent(opts: AgentStartOpts): Promise<void> {
    if (!this.container) {
      this.container = await containerManager.create({ ... });
    }
    await fetch(`http://localhost:${this.container.ipcPort}/agent/start`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
    this.connectEventStream();
  }

  private connectEventStream(): void {
    // Connect to container's SSE endpoint
    // Parse events and emit via this.emitMessage() — same as today
    // Handles reconnection if connection drops
  }

  // Terminal, preview, etc. follow the same pattern:
  // method call → HTTP request to container worker
}
```

**Key insight:** From the perspective of `HandlerContext`, `send-message.ts`, and all WebSocket handlers, nothing changes. They call `runner.startAgent()`, `runner.getAgent()`, etc. The runner internally routes to the container instead of local processes.

### 7. Preview Proxy Integration

With containers, each session's preview runs inside the container on port 5173 (no conflicts — isolated network). The orchestrator maps container:5173 to a unique host port via Docker port binding.

The existing `/preview/:port/` proxy (doc 048) works unchanged — it proxies to `localhost:{allocatedPreviewPort}` which Docker forwards to the container's 5173.

```
Browser                    Orchestrator                Container
───────                    ────────────                ─────────
/preview/10200/  ────────▶ proxy to localhost:10200 ──▶ 5173 (inside container)
```

If doc 048 is not yet implemented, the client can iframe `http://localhost:{allocatedPreviewPort}` directly. Either way, each session gets a unique preview URL with zero port conflicts.

### 8. Credential and Auth Handling

Containers need access to credentials for Claude CLI and GitHub operations:

| Credential | Mount | Access |
|---|---|---|
| Claude CLI auth (`~/.claude/`) | Bind mount from host `/credentials/.claude/` | Read-only |
| GitHub token | Passed via env var `GITHUB_TOKEN` | Set at container create |
| Git identity | Passed via env vars `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | Set at container create |
| Deploy credentials | Bind mount from host per-session deploy dir | Read-only |

The orchestrator reads credentials from `CredentialStore` and passes them at container creation time. Containers never see the Docker socket or other sessions' credentials.

### 9. Filesystem Mounts and Worktree Isolation

#### Current layout (single volume)

```
/workspace/                           ← Docker VOLUME on host
├── sessions/
│   ├── {uuid-A}/                     ← session A's project files + .git
│   └── {uuid-B}/                     ← session B's project files + .git
├── repos/                            ← shared bare repos for worktree sessions
│   └── {sha256-of-remote-url}/       ← one per GitHub repo, shared by worktrees
├── .vibe-sessions.json               ← session metadata
├── .vibe-chat-history/               ← per-session chat JSON
├── .vibe-threads/                    ← thread/checkpoint data
├── .shipit-usage.json                ← cost tracking
└── .shipit-deploy/                   ← deploy configs and history

/credentials/                         ← separate volume
├── .claude/                          ← Claude CLI auth (symlinked to /root/.claude)
└── .claude.json
```

#### The worktree problem

Git worktrees share a parent repo. When a user forks session A into a worktree branch, the structure becomes:

```
/workspace/repos/{hash}/              ← shared bare-ish repo (primary checkout)
  └── .git/worktrees/{uuid-B}/        ← worktree metadata for session B

/workspace/sessions/{uuid-B}/         ← worktree checkout
  └── .git                            ← file (not dir), points to ../../repos/{hash}/.git/worktrees/{uuid-B}
```

Session B's `.git` is a pointer back to the shared repo. Git operations inside session B (commit, log, diff, status) need **read-write access to both** the session directory and the shared repo's `.git/worktrees/` directory. Mounting two containers to the same shared repo with write access risks git index corruption.

#### Solution: Split git operations by scope

Git operations fall into two categories:

**Session-local** (run inside the container) — these only touch the session's own working tree and its worktree-specific git state:
- `git status`, `git diff`, `git log`
- `git add`, `git commit` (writes to worktree-specific index)
- `git stash`, `git checkout` (file-level)
- File reads/writes by Claude CLI

These work correctly inside the container because git worktree operations use the per-worktree `index`, `HEAD`, and `refs` in `.git/worktrees/{id}/`, which are scoped to the session dir. The container mounts the session dir read-write and the shared repo read-only:

```
Container for session B (worktree):
  /workspace         ← bind: /workspace/sessions/{uuid-B}  (rw)
  /repo              ← bind: /workspace/repos/{hash}        (ro)
```

The read-only shared repo mount is sufficient for commits and local operations — git reads the object store from the shared repo but writes new objects to the worktree's own `.git/worktrees/` directory.

**Cross-session** (run on the orchestrator) — these modify the shared repo and affect other sessions:
- `git worktree add` / `git worktree remove` (creates/deletes worktree entries in shared repo)
- `git branch -d` (deletes branch from shared repo)
- `git push` / `git fetch` (touches shared remote state)
- `git merge` across worktree branches
- `forkSession()`, `archiveSession()` (create/destroy worktree dirs + metadata)

These operations stay on the **orchestrator**, which has full read-write access to `/workspace`. They are already orchestrator-scoped today — `forkSession()` and `archiveSession()` live in `src/server/services/session.ts` and are called from HTTP routes, not from the session worker.

#### Container mount configuration

**Regular session** (standalone git repo):
```typescript
Binds: [
  `${sessionDir}:/workspace:rw`,          // session's project files
  `${credentialsDir}:/credentials:ro`,     // Claude CLI auth, GitHub token
]
```

**Worktree session** (references shared repo):
```typescript
Binds: [
  `${sessionDir}:/workspace:rw`,          // worktree checkout
  `${sharedRepoDir}:/repo:ro`,            // shared git object store (read-only)
  `${credentialsDir}:/credentials:ro`,
]
```

The read-only shared repo mount ensures the container can resolve git objects (commits, trees, blobs) but cannot corrupt the shared index or refs. The orchestrator is the only writer to the shared repo.

#### Git operations routing summary

| Operation | Where it runs | Why |
|---|---|---|
| `git status/diff/log` | Container | Reads worktree state only |
| `git add/commit` | Container | Writes to per-worktree index |
| `git push/pull/fetch` | Orchestrator | Touches shared remote refs |
| `git worktree add/remove` | Orchestrator | Modifies shared repo structure |
| `git branch -d` | Orchestrator | Modifies shared refs |
| `git merge` (cross-branch) | Orchestrator | May touch shared repo objects |
| `forkSession` | Orchestrator | Creates worktree + session metadata |
| `archiveSession` | Orchestrator | Removes worktree + cleans shared repo |

#### What stays on the orchestrator only (never in containers)

These files/directories are orchestrator-owned and never mounted into session containers:

- `.vibe-sessions.json` — session metadata (SessionManager)
- `.vibe-chat-history/` — chat persistence (ChatHistoryManager)
- `.vibe-threads/` — thread/checkpoint data (ThreadManager)
- `.shipit-usage.json` — cost tracking (UsageManager)
- `.shipit-deploy/` — deployment configs (DeploymentStore)
- `/workspace/repos/` — shared git repos (except individual repos mounted read-only for worktree sessions)

### 10. Worker Git Proxy

The session worker needs a way to request cross-session git operations from the orchestrator. The worker exposes these as "please do this on my behalf" requests over the IPC channel:

```typescript
// In session-worker.ts — when Claude CLI runs `git push`:
// The worker intercepts git operations that need shared repo access
// and proxies them to the orchestrator.

// Worker → Orchestrator (reverse IPC call)
app.post("/git-proxy/push", async (req) => {
  // Worker cannot push directly (shared repo is read-only mount).
  // Forward to orchestrator, which has rw access.
  return { proxy: true, operation: "push", args: req.body };
});
```

The orchestrator's IPC client watches for proxy requests and executes them with the real `GitManager` that has write access to the shared repo. This keeps the container's git operations fast (local commits are direct) while funneling shared-state operations through a single writer.

Alternatively, rather than intercepting at the git level, Claude CLI's `Bash` tool calls could be wrapped: if the worker detects a `git push`, `git fetch`, or similar command, it returns an error asking Claude to use the dedicated push/pull UI instead. This is simpler and avoids the complexity of a transparent git proxy.

### 11. Container Image

A `Dockerfile.session-worker` builds the session worker image:

```dockerfile
FROM node:22-slim

# Install git, common build tools
RUN apt-get update && apt-get install -y git build-essential python3 && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Copy session worker code
COPY dist/session-worker.js /app/
COPY node_modules /app/node_modules/

WORKDIR /workspace
EXPOSE 9100 5173

CMD ["node", "/app/session-worker.js"]
```

This image is built once and reused for all sessions. Per-session dependencies (npm install for user's project) happen at runtime inside the container, isolated from other sessions.

### 12. Lifecycle Mapping

| Current (SessionRunner) | Containerized |
|---|---|
| `registry.getOrCreate()` | Create Docker container + start worker |
| `runner.attachViewer()` | Connect SSE event stream from worker |
| `runner.detachViewer()` (last viewer) | Disconnect SSE (container keeps running) |
| `runner.startAgent()` | `POST container/agent/start` |
| `runner.dispose()` (idle timeout) | `docker stop` + `docker rm` + release ports |
| `registry.disposeAll()` (full_reset) | Stop and remove all session containers |

Container startup adds ~1-2s latency vs the current ~10ms process spawn. This is acceptable because:
- It only happens on first interaction with a session (not on every message)
- Subsequent messages reuse the running container
- The container stays alive through session switches and tab closes (same as current runner persistence)

### 13. Fallback Mode

For development and environments without Docker:

```typescript
// In buildApp() / AppDeps:
interface AppDeps {
  // ... existing fields ...
  useContainers?: boolean;  // default: false (auto-detect Docker availability)
}

// In SessionRunnerRegistry:
getOrCreate(sessionId, sessionDir, agentId) {
  if (this.useContainers) {
    return new ContainerSessionRunner({ ... });  // proxy to Docker container
  }
  return new SessionRunner({ ... });  // current behavior, direct process spawn
}
```

Both `SessionRunner` (direct) and `ContainerSessionRunner` (Docker proxy) implement the same interface. Tests continue to use the direct mode with stubs.

---

## Phased Implementation

### Phase 1: Session Worker + IPC (foundation)

**Goal:** Extract session-scoped logic into a standalone worker process that can run independently. Validate the IPC protocol without Docker.

**Scope:**
- Create `src/server/session-worker.ts` with Fastify IPC server
- Implement agent start/stop/interrupt over HTTP
- Implement SSE event stream for agent output
- Create `ContainerSessionRunner` that talks to the worker via HTTP
- Test by running worker as a subprocess (no Docker yet)
- Validate that all existing integration tests pass with the IPC layer

**Files:**
| File | Change |
|---|---|
| `src/server/session-worker.ts` | **NEW** — worker process |
| `src/server/container-session-runner.ts` | **NEW** — runner proxy |
| `src/server/session-runner.ts` | Extract shared interface |

### Phase 2: Docker Integration

**Goal:** Run the session worker inside Docker containers with full isolation.

**Scope:**
- Create `SessionContainerManager` with dockerode
- Create `PortPool` for host port allocation
- Create `Dockerfile.session-worker`
- Wire container lifecycle to runner registry
- Mount workspace volumes and credentials
- Add resource limits (CPU, memory)
- Add health checks and container restart logic

**Files:**
| File | Change |
|---|---|
| `src/server/session-container.ts` | **NEW** — container manager |
| `src/server/port-pool.ts` | **NEW** — port allocator |
| `Dockerfile.session-worker` | **NEW** — worker image |
| `src/server/index.ts` | Wire container manager into AppDeps |
| `src/server/session-runner.ts` | Registry delegates to container manager |

### Phase 3: Terminal + Preview + File Watcher

**Goal:** Move remaining per-session resources into the container.

**Scope:**
- Terminal PTY runs inside container, I/O proxied via IPC
- Preview server runs inside container, proxied via allocated host port
- File watcher runs inside container, events streamed via SSE
- Port scanning scoped to container's network namespace (automatic — each container has its own localhost)
- Integrate with doc 048 preview proxy if available

**Files:**
| File | Change |
|---|---|
| `src/server/session-worker.ts` | Add terminal, preview, file watcher endpoints |
| `src/server/container-session-runner.ts` | Add terminal, preview, file watcher proxy methods |
| `src/server/session-container.ts` | Map preview port in container config |

### Phase 4: Speculative Container Pre-warming

**Goal:** Eliminate cold-start latency for the most common flow — creating a new session on the same repo.

**Insight:** Generic container pools don't work because bind mounts are immutable after creation. But we can predict the *next* session: when a user is working on repo X, the most likely next action is "new session on repo X." We speculatively create a container with that repo's workspace already mounted.

**Scope:**
- Track the user's most recently active repo (by GitHub remote URL or local repo hash)
- After a session is activated, speculatively create a standby container in the background:
  1. Create a new session directory (worktree from the shared repo, or shallow clone)
  2. Create a container with that directory bind-mounted as `/workspace`
  3. Boot the session worker — container is idle but ready
- When the user creates a new session on the same repo → claim the standby container, assign the real session ID, ready instantly (~0ms cold start)
- Reclaim logic:
  - If unclaimed after 5 minutes → tear down container and delete speculative session dir
  - If user creates a session on a *different* repo → tear down standby, create new container normally
  - If container cap (10) is reached → don't pre-warm, reserve all slots for real sessions
- The standby container counts toward the max container limit but uses only ~50 MB idle

**Heuristic refinement:** Track the last N repos used (e.g., 3). Pre-warm for the most recently used one. If the user alternates between two repos, the heuristic adapts after one miss.

**Files:**
| File | Change |
|---|---|
| `src/server/session-container.ts` | Add `createStandby()`, `claimStandby()`, `reclaimStandby()` methods |
| `src/server/session-runner.ts` | Registry checks for standby container before creating new one |
| `src/server/services/session.ts` | Track last active repo per user for pre-warm heuristic |

---

## Resource Management

### Per-container limits

| Resource | Default | Rationale |
|---|---|---|
| Memory | 512 MB | Covers Node + Claude CLI + dev server + npm install peaks |
| CPU | 0.5 cores (50% of one core) | Prevents one session from starving others |
| Disk | No limit (workspace volume) | Bounded by host disk; user's project size varies |
| PIDs | 256 | Prevents fork bombs |
| Network | Bridge (isolated) | Each container gets own IP and port namespace |

Limits are configurable via `AppDeps` for different deployment environments.

### Container cleanup

- **Idle timeout:** Same 10-minute timeout as current `SessionRunner`. Container stopped + removed when no viewers and no running agent.
- **Orphan cleanup:** On orchestrator startup, scan for containers with label `shipit-session` and remove any that don't match active sessions.
- **OOM kill:** Docker kills the container. Orchestrator detects exit, notifies attached viewers with an error, cleans up.
- **Graceful shutdown:** On server SIGTERM, call `destroyAll()` which sends SIGTERM to each container with a 5s grace period before SIGKILL.

### Scaling considerations

10 containers × 512MB = 5GB RAM baseline. On a host with 16GB, this leaves 11GB for the orchestrator and OS. Sufficient for a single-user deployment. For multi-user, increase host resources or reduce per-container limits.

---

## Edge Cases

### 1. Docker not available

Auto-detect at startup: `docker.ping()`. If it fails, fall back to direct process spawning (current behavior) and log a warning. This ensures the app works in development without Docker.

### 2. Container fails to start

Return error to client: `{ type: "error", message: "Failed to start session container" }`. Clean up allocated ports. Retry once with a fresh container before giving up.

### 3. Container exits unexpectedly (OOM, crash)

Orchestrator detects via Docker event stream (`docker.getEvents()`). Notifies attached viewers: `{ type: "session_status", running: false, error: "Session container exited unexpectedly" }`. Cleans up ports and registry entry. Next interaction with the session creates a fresh container.

### 4. Network partition between orchestrator and container

SSE connection drops. Orchestrator reconnects with exponential backoff (1s, 2s, 4s, max 10s). If container is unreachable after 30s, assume it's dead and clean up.

### 5. Container outlives orchestrator restart

On startup, orchestrator lists containers with label `shipit-session=true`. Containers matching active sessions are re-adopted (reconnect SSE). Orphans are removed.

### 6. Two tabs viewing same containerized session

Both tabs connect to the same orchestrator WebSocket. The orchestrator maintains one SSE connection to the container and fans out events to both tabs via `runner.emitMessage()`. Identical to current behavior — containers are transparent.

### 7. Session switch with running container

Switching sessions detaches from runner A (SSE stays connected for reconnection) and attaches to runner B (new container created if needed). Container A keeps running. Identical to current `SessionRunner` persistence.

### 8. Archive session with running container

`registry.dispose(sessionId)` → `containerManager.destroy(sessionId)` → `docker stop` + `docker rm`. Same as current behavior but with container cleanup instead of process kill.

### 9. Port pool exhaustion

With 1000 ports and 20 ports per container (2 base + headroom), this supports 50 containers — well above the 10-runner cap. If somehow exhausted, return an error and refuse to create new containers.

---

## Security Considerations

### Docker socket access

**The Docker socket is mounted ONLY in the orchestrator container**, never in session containers. Claude CLI running inside a session container cannot access Docker and cannot escape to the host.

### Read-only credential mounts

Credentials (`/credentials/`) are mounted read-only in session containers. Claude cannot modify or exfiltrate them beyond their intended use (CLI auth, git push).

### No privileged containers

Session containers run with:
- `no-new-privileges` security option
- No added capabilities
- Non-root user (future improvement: run worker as uid 1000)
- No access to host network, PID namespace, or IPC namespace

### `--dangerously-skip-permissions` in containers

Containerization unlocks the ability to run Claude CLI with `--dangerously-skip-permissions`, which auto-approves all tool calls (file writes, bash commands) without human confirmation. Today this flag is too risky because Claude runs on the shared host. With containers, the OS enforces the permission boundary instead of Claude's built-in approval system.

**What the container guards against:**
- Filesystem damage is scoped to `/workspace` (the session's own directory)
- Port conflicts are impossible (isolated network namespace)
- Resource abuse is capped (512MB / 0.5 CPU / 256 PIDs)
- No Docker socket access, no host filesystem access, no other sessions reachable

**Remaining risks even with containers:**
- **Credential access.** `/credentials` is mounted into the container. Claude could read auth tokens and exfiltrate them via network requests. Mitigations: (1) switch credentials to read-only mount (post-launch item), (2) restrict network egress to an allowlist (post-launch item), (3) pass tokens via env vars that Claude CLI consumes internally rather than as files readable by arbitrary commands.
- **Network egress.** Without the egress allowlist, Claude could make arbitrary outbound HTTP requests (data exfiltration, abuse external APIs). This is bounded by the post-launch egress restriction item.
- **API cost.** Auto-approved tool use could cause Claude CLI to loop and burn API credits. Bounded by the existing `UsageManager` per-turn cost tracking on the orchestrator side.

**Implementation:** Add `--dangerously-skip-permissions` as a per-session option, gated on `useContainers: true`. When the orchestrator creates a container, it passes a `skipPermissions` flag in the `ContainerConfig`. The session worker includes the flag when spawning Claude CLI. In fallback mode (`useContainers: false`), the flag is never set — Claude's built-in permission system remains active.

```typescript
// In ContainerConfig:
interface ContainerConfig {
  // ... existing fields ...
  skipPermissions?: boolean;  // default: true when useContainers is true
}

// In session-worker.ts, when spawning Claude CLI:
const args = ["--output-format", "stream-json"];
if (process.env.SKIP_PERMISSIONS === "true") {
  args.push("--dangerously-skip-permissions");
}
```

**Prerequisite:** The credential read-only mount and network egress allowlist (both post-launch items) should be completed before enabling `--dangerously-skip-permissions` by default. Until then, the flag can be opt-in for testing.

### Container labels for management

All session containers are labeled `shipit-session=true` and `shipit-session-id={uuid}` for reliable cleanup and identification.

---

## Testing Strategy

### Unit tests

- `PortPool`: allocate, release, exhaustion error
- `SessionContainerManager`: create, destroy, destroyAll (mocked dockerode)
- `ContainerSessionRunner`: delegates to HTTP endpoints (mocked fetch)

### Integration tests

- Worker IPC: start worker as subprocess, verify agent start/stop via HTTP
- SSE event stream: verify agent events flow through SSE to orchestrator
- Terminal proxy: verify PTY I/O round-trips through IPC
- Preview proxy: verify preview accessible on allocated host port
- Full lifecycle: create container → run agent → get output → idle timeout → container removed

### Fallback tests

- All existing integration tests pass unchanged with `useContainers: false`
- Docker-unavailable detection falls back gracefully

---

## Key Files

| File | Role |
|---|---|
| `src/server/session-worker.ts` | **NEW** — worker process running inside container |
| `src/server/session-container.ts` | **NEW** — Docker container lifecycle manager |
| `src/server/container-session-runner.ts` | **NEW** — SessionRunner proxy to container |
| `src/server/port-pool.ts` | **NEW** — host port allocator |
| `Dockerfile.session-worker` | **NEW** — container image for session workers |
| `src/server/session-runner.ts` | Extract interface, registry delegates to container or direct |
| `src/server/index.ts` | Wire container manager, auto-detect Docker |
| `src/server/ws-handlers/types.ts` | No changes (HandlerContext unchanged) |
| `src/server/ws-handlers/send-message.ts` | No changes (delegates to runner) |
| `docs/041-persistent-session-runners/plan.md` | Prior art — SessionRunner design |
| `docs/048-multi-port-support/plan.md` | Related — preview proxy pairs well with containerized previews |
