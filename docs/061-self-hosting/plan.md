---
status: planned
---

# 061 — Self-Hosting: Developing ShipIt in ShipIt

Use ShipIt as the IDE for developing ShipIt itself. This doc covers two levels of ambition — editing/testing (Level 1) and running a full nested instance (Level 2) — with concrete options and trade-offs for each.

## Motivation

ShipIt is a browser-based IDE powered by Claude. Developing ShipIt currently requires a local machine with Node, Docker, and a terminal. If ShipIt could host its own development, it would:

1. **Prove the platform** — every limitation hit during self-hosted development is a limitation real users will hit on complex projects.
2. **Lower the contributor bar** — new contributors clone the repo in ShipIt and start coding, no local setup required.
3. **Eat our own cooking** — bugs in the IDE surface immediately when the IDE is being used to fix the IDE.

## Scope

**Level 1 — Edit, test, commit.** Use ShipIt as an editor: clone the repo, have Claude edit code, run `npm test` / `npm run typecheck` / `npm run lint`, commit and push. No running instance of the ShipIt server.

**Level 2 — Full inception.** Run a working ShipIt instance inside a ShipIt session, including its own preview, WebSocket server, and (optionally) its own session management.

Level 1 is the near-term goal. Level 2 is the north star that informs architectural decisions.

---

## Current State: What Works and What Doesn't

### What already works

- Session containers include `python3`, `make`, `g++` — sufficient for `npm ci` with native addons (`node-pty`).
- `SessionContainerManager.buildConfig()` already accepts per-session `memoryLimit`, `cpuQuota`, `pidsLimit` overrides — but they are never exposed to users.
- Integration tests use in-process `SessionRunner` (no Docker needed), so `npm test` should run inside a container.
- The preview system supports multiple ports and WebSocket proxying.
- `buildApp()` accepts `AppDeps` with injectable factories — the non-containerized code path exists.

### What blocks Level 1

| Blocker | Current state | What's needed |
|---------|--------------|---------------|
| **Memory** | 512 MB hard cap | ShipIt needs ~2 GB (`npm ci` peaks at 800 MB+, vitest workers ~500 MB, tsc ~400 MB) |
| **CPU** | 0.5 cores | TypeScript compilation and parallel vitest workers need 2+ cores |
| **PIDs** | 256 limit | Node + vitest workers + Claude CLI + terminal easily exceeds this; need 1024+ |
| **No `shipit.yaml`** | ShipIt repo has no preview config | Need config for the two-process dev server (Vite HMR + Fastify API) |
| **No resource profiles** | Container limits are hardcoded per-deployment | Users need a way to request more resources for heavy projects |

### What additionally blocks Level 2

| Blocker | Why it's hard |
|---------|--------------|
| **No Docker inside sessions** | Session containers have no `/var/run/docker.sock`. Inner ShipIt can't spawn containers. |
| **Nested networking** | Inner ShipIt's preview proxy must be reachable through outer ShipIt's preview proxy. |
| **HMR WebSocket interference** | The HMR patch rewrites all `localhost` WebSocket connections, which breaks the inner ShipIt's application WebSocket. |
| **Port conflicts** | Inner sessions sharing the same network namespace can collide on default ports (5173, 3001). |

---

## Level 1 Design: Edit and Test ShipIt in ShipIt

### 1.1 Configurable Resource Profiles

**Problem**: Container resource limits are set at deployment time, not per-session. ShipIt development needs 4x the default memory and CPU.

**Option A: `shipit.yaml` resource hints** (Recommended)

Add an optional `resources` block to `shipit.yaml`:

```yaml
resources:
  memory: 2048    # MB, default 512
  cpu: 2.0        # cores, default 0.5
  pids: 1024      # default 256

install: npm ci
preview:
  command: "npm run dev"
  ports: [3001]
```

The session worker reads this on startup and reports resource requirements to the orchestrator. The orchestrator applies caps (e.g., max 4 GB, max 4 cores) before creating the container.

**Pros**: Project-specific, version-controlled, no UI changes needed.
**Cons**: Requires container recreation if limits change (acceptable — limits rarely change).

**Option B: Session-level resource tiers in the UI**

Add a "session profile" dropdown (Standard / Performance / Heavy) that maps to preset resource bundles. Stored in session metadata.

**Pros**: User-visible, no file needed.
**Cons**: Not version-controlled, must be set per-session manually, another UI concept to maintain.

**Option C: Auto-detection based on project size**

Orchestrator inspects `package.json` dependency count, presence of TypeScript, etc. and auto-selects resource limits.

**Pros**: Zero config.
**Cons**: Heuristics are fragile, surprising when wrong, hard to debug.

**Recommendation**: Option A. It's explicit, version-controlled, and the `shipit.yaml` file already exists as the project config surface. Pair it with sensible deployment-level caps.

### 1.2 `shipit.yaml` for ShipIt Itself

ShipIt's dev mode runs two processes (see `docker-entrypoint.dev.sh`):
- Vite HMR server on port 3000 (serves the React client with hot reload)
- Fastify API server on port 3001 (HTTP + WebSocket)

The Vite config already proxies `/api/*` and `/ws` to the Fastify port. So only the Vite port needs to be the "preview" entry point — the client handles internal routing.

```yaml
# shipit.yaml (for developing ShipIt in ShipIt)
resources:
  memory: 2048
  cpu: 2.0
  pids: 1024

install: npm ci

preview:
  command: "API_PORT=3001 npx vite --host 0.0.0.0 --port 3000 & PORT=3001 npm run dev"
  ports: [3000]
```

The preview proxy exposes port 3000 (Vite), which internally proxies API calls to port 3001 (Fastify). The user sees the full ShipIt UI through the preview frame.

### 1.3 Implementation Plan for Level 1

1. **Add `resources` field to `shipit.yaml` schema** — extend `preview-config.ts` to parse and validate resource hints.
2. **Plumb resource hints to container creation** — session worker reports parsed resources via `/health` or a new `/config` endpoint. Orchestrator reads them and passes to `SessionContainerManager.create()`.
3. **Add deployment-level caps** — env vars `MAX_SESSION_MEMORY_MB`, `MAX_SESSION_CPU`, `MAX_SESSION_PIDS` with defaults.
4. **Write `shipit.yaml`** for the ShipIt repo.
5. **Validate the toolchain** — manually test `npm ci`, `npm test`, `npm run typecheck`, `npm run lint` inside a session container with elevated resource limits.
6. **Document** — add contributor guide: "Developing ShipIt in ShipIt."

---

## Level 2 Design: Running ShipIt Inside ShipIt

### The Core Problem: Docker Access

The inner ShipIt orchestrator needs to spawn session containers. Session containers have no Docker access today, for good reason (security). Four options:

### Option 1: Non-Containerized Inner Mode (Recommended for MVP)

Run the inner ShipIt with `USE_CONTAINERS=false`. It uses in-process `SessionRunner` instead of Docker containers.

```
Browser
  → Outer ShipIt (port 4123)
    → Preview proxy → Session container (bridge IP)
      → Inner ShipIt orchestrator (port 3001, non-containerized mode)
        → In-process SessionRunner
          → Claude CLI (child process)
          → Preview server (child process)
          → Terminal PTY (child process)
```

**What needs to change:**
- Promote non-containerized mode from "test-only" to a supported runtime flag. Today `SessionRunner` (in-process) is documented as "used by integration tests." It needs hardening: proper error handling for child process crashes, cleanup on shutdown, and signal forwarding.
- The inner ShipIt's preview servers run as child processes in the same network namespace — no port isolation. Need dynamic port allocation with retry on `EADDRINUSE`.
- Inner sessions' workspaces live as subdirectories of the container's `/user` filesystem.

**Pros**: No Docker-in-Docker. Works today with moderate changes. Safe — inner sessions share the same sandbox as the session container.
**Cons**: No isolation between inner sessions. One bad inner session can affect others. Process crashes are noisier without container boundaries.

### Option 2: Docker Socket Passthrough

Mount `/var/run/docker.sock` into the session container, allowing the inner ShipIt to spawn sibling containers on the host.

```
Host Docker daemon
  ├── Outer orchestrator container
  │     └── manages outer sessions
  └── Session container (with docker.sock)
        └── Inner ShipIt orchestrator
              └── creates containers via host Docker
                    └── Inner session containers (host-level siblings)
```

**What needs to change:**
- New session-level flag: `docker_access: true` in `shipit.yaml` or session metadata.
- `SessionContainerManager.create()` conditionally mounts `/var/run/docker.sock` based on flag.
- Inner ShipIt needs its own `WORKSPACE_VOLUME`, `DOCKER_NETWORK`, `DOCKER_STACK` to avoid colliding with the outer instance's resources.
- Inner session containers are real host-level containers — visible to the outer orchestrator. Label namespacing prevents the outer orchestrator from cleaning them up.

**Pros**: Full container isolation for inner sessions. Inner ShipIt works identically to outer ShipIt.
**Cons**: **Major security risk** — session container can control ALL host containers, including the outer ShipIt. A prompt injection or malicious user code could `docker rm -f` the outer orchestrator. Only viable for single-user self-hosted deployments with full trust.

### Option 3: Docker-in-Docker (DinD)

Run a Docker daemon inside the session container, giving the inner ShipIt its own isolated Docker environment.

```
Host Docker daemon
  └── Session container (privileged or sysbox)
        └── Inner Docker daemon (isolated)
              └── Inner session containers (invisible to host)
```

**What needs to change:**
- Session container image needs Docker daemon installed.
- Container must run with `--privileged` flag or use a rootless container runtime like [Sysbox](https://github.com/nestybox/sysbox).
- Inner Docker daemon needs storage driver configuration (vfs or overlay2-in-overlay2).
- Startup sequence: start Docker daemon → wait for readiness → start inner ShipIt.
- Resource limits must account for DinD overhead (~200 MB for the daemon itself).

**Pros**: True isolation — inner Docker is invisible to host. Inner ShipIt works identically to outer.
**Cons**: Requires `--privileged` (security concern) or Sysbox (extra dependency). Performance overhead on nested overlay2. Storage driver edge cases. Adds ~200 MB RAM overhead for the daemon. Not all hosting environments support privileged containers.

### Option 4: Container Broker API

The inner ShipIt doesn't talk to Docker directly. Instead, it calls a "container broker" API exposed by the outer orchestrator, which creates containers on its behalf.

```
Inner ShipIt orchestrator
  → POST /api/broker/containers {image, mounts, resources}
    → Outer orchestrator validates + creates container
      → Returns container ID + bridge IP
```

**What needs to change:**
- New HTTP API on the outer orchestrator: `/api/broker/containers` (create, destroy, list).
- Inner ShipIt's `SessionContainerManager` gets a new backend that talks to the broker API instead of Docker.
- Outer orchestrator enforces quotas: max containers per session, resource caps, network isolation.
- Authentication: inner ShipIt authenticates to the broker (session token or shared secret).
- Network routing: inner session containers join a sub-network that the inner ShipIt can reach.

**Pros**: Clean separation of concerns. No Docker access in session container. Outer orchestrator maintains full control. Supports quotas and multi-tenancy. Most architecturally sound.
**Cons**: Significant new surface area (~2-3 weeks of work). New API to design, secure, and test. Adds latency to container operations. The broker must understand container lifecycle semantics that today live inside `SessionContainerManager`.

### Recommendation

**Start with Option 1** (non-containerized inner mode). It's the fastest path to a working self-hosted development loop and requires no Docker changes. The inner ShipIt runs as a "fat preview" — a complex process inside a session container.

**Graduate to Option 4** (container broker) if/when inner session isolation matters. Option 4 is the only approach that maintains security properties while enabling full recursive self-hosting. It's worth designing the broker API now (even if not building it) to ensure the non-containerized path doesn't introduce abstractions that conflict with it.

**Avoid Option 2** (socket passthrough) in multi-user deployments — the blast radius is too large. It's acceptable only for single-user self-hosted setups where the user already has root access.

**Avoid Option 3** (DinD) unless Sysbox is already in the deployment — the privileged container requirement negates the security benefits of containerization.

---

## Level 2 Networking: Nested Preview Routing

Regardless of which Docker option is chosen, the inner ShipIt's UI and previews must be reachable through the outer ShipIt's preview proxy.

### How it works today

```
Browser → GET {sessionId}--5173.localhost
  → Outer preview proxy
    → http://{container-bridge-ip}:5173
```

### How nested routing would work

```
Browser → GET {outerSessionId}--3000.localhost
  → Outer preview proxy
    → http://{container-bridge-ip}:3000  (inner ShipIt's Vite dev server)
      → Vite proxies /api/* and /ws to inner Fastify on :3001
        → Inner Fastify serves the inner ShipIt UI
        → Inner ShipIt's preview proxy handles inner session previews at /preview/*
```

For **Option 1** (non-containerized), inner previews are localhost processes in the same container. The inner preview proxy routes `/preview/{innerSessionId}/{port}/*` to `localhost:{port}` — standard path-based proxying with no container networking.

For **Options 2-4**, inner session containers live on a separate network. The inner ShipIt's preview proxy resolves container bridge IPs on that network. The browser still only talks to the outer preview proxy — everything else is server-side.

### HMR WebSocket Patch Fix

The current HMR patch (`preview-proxy.ts`) wraps `window.WebSocket` and rewrites any connection to `localhost:{knownPort}` to use the page's origin. This would break the inner ShipIt's application WebSocket (`/ws`), which is also on the same origin.

**Fix**: The HMR patch should only rewrite connections that match known dev server ports (e.g., 5173, 3000, 8080), not all WebSocket connections. Alternatively, check if the WebSocket URL path starts with `/ws` and skip rewriting for application WebSockets.

---

## Resource Estimates

### Level 1 (edit + test)

| Change | Effort | Risk |
|--------|--------|------|
| `shipit.yaml` resource hints (parse + plumb) | 2 days | Low |
| Write ShipIt's own `shipit.yaml` | 1 hour | Low |
| Validate toolchain in container | 1 day | Medium (native addon edge cases) |
| Contributor docs | 0.5 day | Low |
| **Total** | **~4 days** | |

### Level 2 Option 1 (non-containerized inner)

| Change | Effort | Risk |
|--------|--------|------|
| Harden in-process `SessionRunner` for production | 3 days | Medium |
| Dynamic port allocation for inner previews | 1 day | Low |
| HMR WebSocket patch scoping | 0.5 day | Low |
| E2E testing of nested instance | 2 days | Medium |
| **Total** | **~7 days** | |

### Level 2 Option 4 (container broker)

| Change | Effort | Risk |
|--------|--------|------|
| Design + implement broker API | 5 days | High |
| Broker-backed `SessionContainerManager` | 3 days | Medium |
| Network setup (sub-networks, routing) | 2 days | High |
| Auth + quota enforcement | 2 days | Medium |
| E2E testing | 3 days | High |
| **Total** | **~15 days** | |

---

## Open Questions

1. **Should resource hints be trusted or treated as requests?** If `shipit.yaml` says `memory: 8192`, should the orchestrator silently cap it or reject the session? Recommendation: silently cap with a log warning.
2. **Should Level 1 block on resource profiles?** Alternatively, we could just increase default limits deployment-wide for the self-hosted case (single-user, so contention is low). Simpler, but doesn't help multi-user deployments.
3. **Is the two-process dev server a blocker?** Can we simplify ShipIt's own dev mode to a single process (Fastify serves Vite-built assets + API on one port) for the self-hosted case? This would simplify the `shipit.yaml` significantly.
4. **What's the minimum viable "inner ShipIt"?** Does it need all features (deploy, GitHub integration, templates), or is a stripped-down "editor + Claude + preview" sufficient for self-development?
