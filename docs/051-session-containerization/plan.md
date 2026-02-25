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
  containerIp: string;     // bridge network IP (e.g. 172.17.0.3)
  status: "starting" | "running" | "stopping" | "stopped";
}

export class SessionContainerManager {
  private docker: Docker;
  private containers = new Map<string, SessionContainer>();
  private networkName: string;

  constructor(opts: {
    socketPath?: string;           // default: /var/run/docker.sock
    imageName?: string;            // default: shipit-session-worker:latest
    networkName?: string;          // default: "shipit"
    memoryLimit?: number;          // default: 512MB
    cpuQuota?: number;             // default: 50000
  }) { /* ... */ }

  async create(config: ContainerConfig): Promise<SessionContainer> {
    const container = await this.docker.createContainer({
      Image: config.imageName,
      Cmd: ["node", "dist/session-worker.js"],
      Labels: {
        "shipit-session": "true",
        "shipit-session-id": config.sessionId,
      },
      HostConfig: {
        Binds: [
          `${config.sessionDir}:/workspace:rw`,
          `${config.credentialsDir}:/credentials:rw`,  // rw: Claude CLI writes conversation cache on --resume
          // For worktree sessions: mount shared repo read-only so git can
          // resolve objects without allowing writes to shared state
          ...(config.sharedRepoDir ? [`${config.sharedRepoDir}:/repo:ro`] : []),
        ],
        // No PortBindings — orchestrator reaches containers directly via
        // bridge network IP. Preview traffic is proxied through Fastify
        // using /preview/{sessionId}/{port}/ routes.
        Memory: config.memoryLimit,
        CpuQuota: config.cpuQuota,
        CpuPeriod: 100_000,
        PidsLimit: 256,
        NetworkMode: "shipit",  // custom bridge network for orchestrator ↔ container
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

    // Get the container's IP on the bridge network
    const info = await container.inspect();
    const containerIp = info.NetworkSettings.Networks["shipit"].IPAddress;

    const sc: SessionContainer = { id: container.id, sessionId: config.sessionId, containerIp, status: "running" };
    this.containers.set(config.sessionId, sc);
    return sc;
  }

  async destroy(sessionId: string): Promise<void> {
    const sc = this.containers.get(sessionId);
    if (!sc) return;
    try {
      const container = this.docker.getContainer(sc.id);
      await container.stop({ t: 5 });  // 5s grace period
      await container.remove();
    } catch { /* already stopped */ }
    this.containers.delete(sessionId);
  }

  get(sessionId: string): SessionContainer | undefined {
    return this.containers.get(sessionId);
  }

  async destroyAll(): Promise<void> { /* for full_reset */ }
}
```

### 3. Docker Network

All session containers and the orchestrator join a custom bridge network (`shipit`). The orchestrator reaches containers by their bridge IP (e.g. `172.18.0.3`) — no host port mappings needed for either IPC or preview traffic.

```bash
# Created once at startup (or via docker-compose)
docker network create shipit
```

The orchestrator container itself must also be on this network. With 10 max containers, the default `/16` bridge subnet provides more than enough IPs.

**No `PortPool` needed.** The previous design allocated host ports for IPC and preview. With bridge networking, all traffic flows over internal IPs on fixed container ports (9100 for IPC, any port for preview). This eliminates port exhaustion as a failure mode entirely.

**Internet egress:** The custom bridge network provides outbound internet access by default (Docker's NAT masquerade). This is required for `npm install`, `git clone`, and Claude CLI API calls inside session containers. `git push`/`git fetch` are routed through the orchestrator (see section 10) for worktree coordination, but standalone sessions could push directly — the network allows it. Restricting egress to specific hosts (e.g., only `api.anthropic.com`, `github.com`, `registry.npmjs.org`) is a future hardening step, not a launch blocker.

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

The orchestrator communicates with each container's worker over the Docker bridge network. The worker listens on port 9100 inside the container. The orchestrator connects via the container's bridge IP (e.g. `http://172.18.0.3:9100/`). No host port mappings needed.

For streaming (agent events, terminal output), the orchestrator opens an SSE connection to the worker.

```
Orchestrator (172.18.0.2)             Container Worker (172.18.0.3)
─────────────────────────             ──────────────────────────────

 POST :9100/agent/start  ──────────▶  spawn Claude CLI

 GET  :9100/events       ◀── SSE ──  agent_event, terminal_output,
                                      file_changes, preview_status

 POST :9100/terminal/input ────────▶  write to PTY

 GET  :9100/preview/status ────────▶  return { running, ports }
```

**Why HTTP+SSE instead of raw WebSocket or gRPC:**
- Fastify is already a dependency — no new libraries needed in the worker
- SSE is simpler than WebSocket for unidirectional server→client streaming
- HTTP requests map naturally to the existing `HandlerContext` operations
- Easy to debug: `curl http://172.18.0.3:9100/events` from the orchestrator container

### 6. Modified SessionRunner

`SessionRunner` becomes a **proxy** that delegates to the container worker instead of spawning processes directly. The public API stays identical — `HandlerContext` and WebSocket handlers don't change.

```typescript
// src/server/container-session-runner.ts
// Implements the same interface as SessionRunner but delegates to a container worker.

export class ContainerSessionRunner extends EventEmitter {
  private container: SessionContainer | null = null;
  private eventSource: EventSource | null = null;  // SSE connection to worker

  // Instead of spawning a local ClaudeAdapter, POST to the container worker
  async startAgent(opts: AgentStartOpts): Promise<void> {
    if (!this.container) {
      this.container = await containerManager.create({ ... });
    }
    await fetch(`http://${this.container.containerIp}:9100/agent/start`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
    this.connectEventStream();
  }

  private connectEventStream(): void {
    // Connect to container's SSE endpoint
    // Parse events and emit via this.emitMessage() — same as SessionRunner
    // Handles reconnection if connection drops
  }

  // Terminal, preview, etc. follow the same pattern:
  // method call → HTTP request to container worker
}
```

**Key insight:** `ContainerSessionRunner` and `SessionRunner` (direct mode) implement the same interface. From the perspective of `HandlerContext`, `send-message.ts`, and all WebSocket handlers, nothing changes. They call `runner.startAgent()`, `runner.getAgent()`, etc. The registry decides which implementation to create (see section 13).

### 7. Preview Proxy Integration

With containers, each session's preview runs inside the container on its default port (e.g. 5173 for Vite, 3001 for Next.js) — no conflicts because each container has its own network namespace. The orchestrator proxies preview traffic to containers via the Docker bridge network using session-ID-based routing.

#### URL scheme

```
/preview/{sessionId}/{port}/{path...}
```

- `{sessionId}` — identifies which container to route to
- `{port}` — the target port inside that container (supports multiple dev servers)
- `{path...}` — forwarded verbatim including query string

Examples:
```
GET /preview/abc-123/5173/           → container(abc-123) 172.17.0.3:5173/
GET /preview/abc-123/8080/api/users  → container(abc-123) 172.17.0.3:8080/api/users
WS  /preview/abc-123/5173/           → container(abc-123) ws://172.17.0.3:5173/  (HMR)
```

#### Why session ID instead of host port

This supersedes the port-based proxy in doc 048 (`/preview/{port}/`):

| | Port-based (048) | Session-ID-based (051) |
|---|---|---|
| Published ports | One host port per preview per session | **Zero** — bridge network only |
| Port pool | Needed for preview port allocation | **Not needed** |
| Multi-port | Each internal port needs its own host port | **Free** — route by container IP + any internal port |
| Port conflicts | Impossible (allocated) but ports are a finite resource | **Impossible** — each container has own network |
| URL construction | Client needs allocated host port from server | Client uses session ID (already known) |

#### Implementation

The proxy resolves `sessionId` → `containerIp` via `SessionContainerManager`, then forwards:

```typescript
app.all("/preview/:sessionId/:port/*", async (request, reply) => {
  const { sessionId, port } = request.params;
  const sc = containerManager.get(sessionId);
  if (!sc) return reply.code(404).send({ error: "Session not found" });

  const targetPort = Number(port);
  const target = request.url.replace(`/preview/${sessionId}/${port}`, "") || "/";

  // Forward to container's bridge IP — no host port mapping needed
  const proxyReq = http.request({
    hostname: sc.containerIp,
    port: targetPort,
    path: target,
    method: request.method,
    headers: { ...request.headers, host: `localhost:${targetPort}` },
  }, (proxyRes) => {
    reply.raw.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(reply.raw);
  });

  request.raw.pipe(proxyReq);
});
```

WebSocket upgrade follows the same pattern — intercept `/preview/{sessionId}/{port}/*` upgrade requests and pipe to the container's bridge IP.

#### Port allowlist

The proxy only forwards to ports the session worker reports as active (via the SSE event stream). The worker runs its own port scanner scoped to the container's localhost and reports detected ports to the orchestrator. Unknown ports get `403 Forbidden`.

#### Preview status URL format

The current `SessionRunner.buildPreviewStatus()` returns `url: "http://localhost:${port}"`. With containerization, the `ContainerSessionRunner` constructs the proxy URL instead:

```typescript
buildPreviewStatus(): WsServerMessage {
  // Worker reports: { running: true, ports: [5173, 8080] }
  // Orchestrator constructs proxy URL for the client:
  return {
    type: "preview_status",
    running: true,
    port: workerPorts[0],
    url: `/preview/${this.sessionId}/${workerPorts[0]}/`,
    source: "managed",
    detectedPorts: workerPorts.slice(1),
  };
}
```

The client receives a relative URL and iframes it directly — same-origin, no CORS issues.

#### Path simplification

With containers, Claude CLI runs with `cwd: /workspace` (the container's mount point). File paths in tool calls become `/workspace/src/App.tsx` instead of `/workspace/sessions/{uuid}/src/App.tsx`. The client-side `sessionRelativePath()` utility (`src/client/path-utils.ts`) simplifies from stripping a UUID-containing prefix to just stripping `/workspace/`:

```typescript
// Before (current): "/workspace/sessions/28e2fa34-.../src/App.tsx" → "src/App.tsx"
const SESSION_PREFIX_RE = /^\/workspace\/sessions\/[^/]+\//;

// After (containerized): "/workspace/src/App.tsx" → "src/App.tsx"
const SESSION_PREFIX_RE = /^\/workspace\//;
```

This regex change should be gated on the `useContainers` flag or made to handle both formats for backward compatibility.

### 8. Credential and Auth Handling

Containers need access to credentials for Claude CLI and GitHub operations:

| Credential | Mount | Access |
|---|---|---|
| Claude CLI auth (`~/.claude/`) | Bind mount from host `/credentials/.claude/` | **Read-write** (CLI writes conversation cache on `--resume`) |
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

However, `git commit` also writes new objects (blobs, trees, commit) to the **shared object store** at `.git/objects/` in the parent repo — not to the per-worktree directory. This means a read-only shared repo mount would break commits.

**Workaround: per-worktree object directory.** Git supports `GIT_OBJECT_DIRECTORY` to redirect new object writes to a separate location. The container sets this to a writable path inside the session dir:

```
Container for session B (worktree):
  /workspace         ← bind: /workspace/sessions/{uuid-B}  (rw)
  /repo              ← bind: /workspace/repos/{hash}        (ro)

  GIT_OBJECT_DIRECTORY=/workspace/.git-objects        (writable, inside session dir)
  GIT_ALTERNATE_OBJECTS_DIRECTORIES=/repo/.git/objects (read-only, shared store)
```

New objects from commits go to the writable session-local directory. Git reads existing objects from the shared store via alternates. On the orchestrator side, after a worktree session's container is stopped, a maintenance step (`git repack` or object transfer) can fold session-local objects back into the shared repo if needed.

**Trade-off:** This adds complexity. A simpler alternative is to run **all git operations for worktree sessions through the orchestrator** via IPC, avoiding the split entirely. The orchestrator has read-write access to both the session dir and shared repo. The cost is latency for every `git commit` (HTTP round-trip instead of local), but commits are infrequent relative to file edits.

**Recommended approach:** For phase 1, route all worktree git operations through the orchestrator. Revisit `GIT_OBJECT_DIRECTORY` in a later phase if the latency proves problematic.

**Cross-session** (run on the orchestrator) — these modify the shared repo and affect other sessions:
- `git worktree add` / `git worktree remove` (creates/deletes worktree entries in shared repo)
- `git branch -d` (deletes branch from shared repo)
- `git push` / `git fetch` (touches shared remote state)
- `git merge` across worktree branches
- `forkSession()`, `archiveSession()` (create/destroy worktree dirs + metadata)
- **For worktree sessions:** `git add`, `git commit` (need write access to shared object store)

These operations stay on the **orchestrator**, which has full read-write access to `/workspace`. Most are already orchestrator-scoped today — `forkSession()` and `archiveSession()` live in `src/server/services/session.ts` and are called from HTTP routes, not from the session worker. For worktree sessions, `git commit` is additionally routed through the orchestrator.

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

The shared repo is mounted read-only. The container can read git objects (for `git log`, `git diff`, file reads) but cannot write new objects. All git write operations for worktree sessions (commit, add) are routed through the orchestrator via IPC. See section 10 for details.

#### Git operations routing summary

| Operation | Standalone session | Worktree session | Why |
|---|---|---|---|
| `git status/diff/log` | Container | Container | Reads working tree + objects (read-only shared repo sufficient) |
| `git add/commit` | Container | **Orchestrator** | Standalone writes to local `.git/objects/`; worktree writes to shared object store |
| `git push/pull/fetch` | Orchestrator | Orchestrator | Needs network egress + shared remote refs |
| `git worktree add/remove` | — | Orchestrator | Modifies shared repo structure |
| `git branch -d` | Orchestrator | Orchestrator | Modifies shared refs |
| `git merge` (cross-branch) | Orchestrator | Orchestrator | May touch shared repo objects |
| `forkSession` | Orchestrator | Orchestrator | Creates worktree + session metadata |
| `archiveSession` | Orchestrator | Orchestrator | Removes worktree + cleans shared repo |

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
# IPC server port — no EXPOSE needed since we use bridge networking,
# but documented here for clarity. Preview ports are dynamic.
EXPOSE 9100

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
| `runner.dispose()` (idle timeout) | `docker stop` + `docker rm` |
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
- Create `shipit` Docker bridge network for orchestrator ↔ container communication
- Create `Dockerfile.session-worker`
- Wire container lifecycle to runner registry
- Mount workspace volumes and credentials (read-only shared repo for worktrees)
- Add resource limits (CPU, memory)
- Add health checks and container restart logic

**Files:**
| File | Change |
|---|---|
| `src/server/session-container.ts` | **NEW** — container manager |
| `Dockerfile.session-worker` | **NEW** — worker image |
| `src/server/index.ts` | Wire container manager into AppDeps |
| `src/server/session-runner.ts` | Registry delegates to container manager |

### Phase 3: Terminal + Preview + File Watcher

**Goal:** Move remaining per-session resources into the container.

**Scope:**
- Terminal PTY runs inside container, I/O proxied via IPC
- Preview server runs inside container, proxied via `/preview/{sessionId}/{port}/` route
- File watcher runs inside container, events streamed via SSE
- Port scanning scoped to container's network namespace (automatic — each container has its own localhost)
- Add preview proxy route to Fastify (replaces doc 048 port-based proxy with session-ID-based routing)
- Update `sessionRelativePath()` to handle containerized paths (`/workspace/` prefix instead of `/workspace/sessions/{uuid}/`)

**Files:**
| File | Change |
|---|---|
| `src/server/session-worker.ts` | Add terminal, preview, file watcher endpoints |
| `src/server/container-session-runner.ts` | Add terminal, preview, file watcher proxy methods |
| `src/server/preview-proxy.ts` | **NEW** — session-ID-based reverse proxy |
| `src/client/path-utils.ts` | Handle both containerized and direct path formats |

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

Return error to client: `{ type: "error", message: "Failed to start session container" }`. Clean up registry entry. Retry once with a fresh container before giving up.

### 3. Container exits unexpectedly (OOM, crash)

Orchestrator detects via Docker event stream (`docker.getEvents()`). Notifies attached viewers: `{ type: "session_status", running: false, error: "Session container exited unexpectedly" }`. Cleans up registry entry. Next interaction with the session creates a fresh container.

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

### 9. Bridge network IP exhaustion

The default Docker bridge subnet is `/16` (65k IPs). With 10 max containers this is not a realistic concern. If the network is misconfigured, container creation fails and the orchestrator returns an error to the client.

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

### Container labels for management

All session containers are labeled `shipit-session=true` and `shipit-session-id={uuid}` for reliable cleanup and identification.

---

## Testing Strategy

### Unit tests

- `SessionContainerManager`: create, destroy, destroyAll (mocked dockerode)
- `ContainerSessionRunner`: delegates to HTTP endpoints (mocked fetch)
- Preview proxy: session ID resolution, path stripping, port allowlist

### Integration tests

- Worker IPC: start worker as subprocess, verify agent start/stop via HTTP
- SSE event stream: verify agent events flow through SSE to orchestrator
- Terminal proxy: verify PTY I/O round-trips through IPC
- Preview proxy: verify `/preview/{sessionId}/{port}/` routes to correct container IP
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
| `src/server/preview-proxy.ts` | **NEW** — session-ID-based reverse proxy for preview traffic |
| `Dockerfile.session-worker` | **NEW** — container image for session workers |
| `src/server/session-runner.ts` | Extract interface, registry delegates to container or direct |
| `src/server/index.ts` | Wire container manager, bridge network, auto-detect Docker |
| `src/client/path-utils.ts` | Handle `/workspace/` prefix (containerized) alongside existing format |
| `src/server/ws-handlers/types.ts` | No changes (HandlerContext unchanged) |
| `src/server/ws-handlers/send-message.ts` | No changes (delegates to runner) |
| `docs/041-persistent-session-runners/plan.md` | Prior art — SessionRunner design |
| `docs/048-multi-port-support/plan.md` | Superseded — session-ID routing replaces port-based proxy |
