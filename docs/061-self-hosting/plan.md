---
status: planned
---

# 061 — Docker-Capable Sessions

Give session containers access to Docker so users can develop projects that use Docker Compose, run containerized services, or — the motivating case — develop ShipIt itself inside ShipIt with full fidelity.

## Motivation

Many real-world projects depend on Docker: microservice stacks with `docker-compose`, apps with database containers, build pipelines that produce images, and ShipIt itself. Today, session containers have no Docker access — Claude can edit Dockerfiles and compose files, but can't run them.

The acid test is self-hosting: developing ShipIt inside ShipIt, running the full containerized stack (orchestrator + session worker containers), and verifying it works exactly as it would standalone. If it works for ShipIt, it works for any Docker-using project.

### Why fidelity matters

A simulation or broker layer that makes Docker "sort of work" inside sessions would create a divergence: code that works in ShipIt might break when deployed, and vice versa. The goal is that `docker compose up` inside a session behaves identically to running it on a developer's laptop. This rules out:

- **Non-containerized fallbacks** — testing a different code path than production isn't useful for catching real bugs.
- **Broker/proxy APIs** — an abstraction between the app and Docker means the app's Docker configuration is never truly tested.

The app must talk to a real Docker daemon.

---

## Current State

Session containers are isolated by design (`session-container.ts`):

- No `/var/run/docker.sock` mount
- `SecurityOpt: ["no-new-privileges"]`
- Bridge network with no host port mappings
- 512 MB memory, 0.5 CPU, 256 PIDs

The `ContainerConfig` interface already supports per-session `memoryLimit`, `cpuQuota`, `pidsLimit`, and arbitrary `env` vars — but these are set at the orchestrator level, never from project config.

---

## Design

Two independent pieces: **(A)** giving sessions Docker access and **(B)** letting projects request adequate resources. Both are needed for full self-hosting, but each is useful on its own.

---

### Part A: Docker Access for Sessions

Three viable options. All give the session a real Docker daemon. They differ in isolation and deployment requirements.

#### Option 1: Docker Socket Passthrough

Mount the host's `/var/run/docker.sock` into the session container. The session talks to the same Docker daemon as the orchestrator.

```
Host Docker daemon
  ├── Orchestrator container
  ├── Session container (with docker.sock)
  │     └── user's docker-compose up
  │           ├── service-a (host-level sibling container)
  │           └── service-b (host-level sibling container)
  └── Other session containers...
```

**Changes required:**

1. **`shipit.yaml` capability flag:**
   ```yaml
   capabilities:
     docker: true
   ```

2. **`ContainerConfig` extension** — add optional `dockerAccess: boolean` field.

3. **`SessionContainerManager.create()`** — when `dockerAccess` is true:
   - Bind-mount `/var/run/docker.sock:/var/run/docker.sock`
   - Install Docker CLI in the session worker image (just the client binary, not the daemon)
   - Remove `no-new-privileges` (required for Docker socket access)
   - Pass `DOCKER_HOST=unix:///var/run/docker.sock` env var

4. **Container cleanup** — when a session is destroyed, also clean up any containers it spawned. Use label-based tracking: the session container sets `shipit-parent-session={sessionId}` on containers it creates (via `DOCKER_DEFAULT_LABELS` env var or a wrapper script). The orchestrator's `destroy()` method queries and removes child containers.

5. **Network isolation** — child containers created by the session should join a session-specific network (not the orchestrator's network). The session creates its own bridge network on startup. The orchestrator doesn't need to route to these containers — the session container can reach them directly.

**Pros:**
- Simplest implementation. ~3 days of work.
- Full Docker compatibility — compose, build, push, volumes, networks all work.
- No extra runtime dependencies.
- Zero performance overhead.

**Cons:**
- **No isolation from host Docker.** The session can see and control all containers on the host, including the orchestrator and other sessions. A `docker rm -f` in the session could take down ShipIt.
- Only safe for single-user self-hosted deployments where the user already has root.

**Mitigations (partial, not airtight):**
- Label-based filtering: session's Docker CLI is wrapped to auto-add `--filter label=shipit-parent-session=$SESSION_ID` to `docker ps` commands. But this is cosmetic, not enforced.
- Read-only socket mount + Docker auth plugin for stricter control. But auth plugins are complex and rarely used.

#### Option 2: Docker Socket Proxy

Instead of mounting the raw socket, run a filtering proxy (e.g., [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) or a custom one) that restricts which Docker API calls the session can make.

```
Host Docker daemon
  ← Docker socket proxy (per-session or shared)
    ← Session container (talks to proxy, not raw socket)
```

**Changes required:**

Everything from Option 1, plus:

1. **Proxy sidecar** — for each Docker-enabled session, the orchestrator also starts a proxy container (or process) that:
   - Listens on a Unix socket or TCP port
   - Forwards allowed Docker API calls to the real daemon
   - Rejects dangerous operations (container exec on non-child containers, image push, volume remove for non-session volumes, network connect to orchestrator network)
   - Injects labels on `container create` to enforce session ownership

2. **Session container mount** — instead of the real socket, mount the proxy's socket:
   ```
   /run/docker-proxy-{sessionId}.sock:/var/run/docker.sock
   ```

3. **Proxy configuration** — allowlist approach:
   - `POST /containers/create` — allowed, proxy injects `shipit-parent-session` label
   - `POST /containers/{id}/start` — allowed only for containers with matching label
   - `DELETE /containers/{id}` — allowed only for containers with matching label
   - `GET /containers/json` — filtered to only show session's containers
   - `POST /build` — allowed (building images is safe)
   - `GET /images/json` — allowed (read-only)
   - Block: `POST /containers/{id}/exec` on non-owned containers, network operations on orchestrator network, volume operations on orchestrator volumes

**Pros:**
- Session only sees its own containers. Can't interfere with orchestrator or other sessions.
- Full Docker Compose compatibility (compose uses standard Docker API).
- No `--privileged` required. No extra daemon.
- Enforceable isolation without trusting the session.

**Cons:**
- Proxy must be maintained — Docker API evolves, new endpoints need allowlisting.
- Per-session proxy adds ~50 MB memory overhead.
- Some Docker operations may break if the proxy doesn't handle them (e.g., `docker system prune`, `docker context`).
- Custom proxy is ~1-2 weeks of work. Off-the-shelf proxies (Tecnativa) are coarse-grained (enable/disable entire endpoint categories, no per-container filtering).

**Build-vs-buy for the proxy:**
- **Tecnativa/docker-socket-proxy**: Mature, widely used (6k+ GitHub stars). Env-var based allowlist (`CONTAINERS=1`, `IMAGES=1`, etc.). But filtering is at the endpoint level, not per-container. A session could still `docker rm` another session's container.
- **Custom proxy**: A lightweight Node.js HTTP proxy (~500 lines) that inspects request bodies and injects/validates labels. More work, but gives us per-session container isolation. Can be extracted as a standalone tool later.

#### Option 3: Docker-in-Docker (DinD) with Sysbox

Run a full Docker daemon inside the session container using the [Sysbox](https://github.com/nestybox/sysbox) container runtime. Each session gets its own isolated Docker environment.

```
Host Docker daemon (with Sysbox runtime)
  └── Session container (Sysbox-managed)
        └── Inner Docker daemon (fully isolated)
              ├── user's service-a
              └── user's service-b
```

**Changes required:**

1. **Sysbox installed on the host** — `apt install sysbox-ce` or equivalent. Requires Linux kernel 5.12+ with user-namespace support.

2. **Session container runtime override** — `SessionContainerManager.create()` passes `HostConfig.Runtime: "sysbox-runc"` for Docker-enabled sessions.

3. **Session worker image variant** — a `Dockerfile.session-worker.docker` that includes:
   - Docker daemon (`dockerd`) + CLI
   - An entrypoint that starts `dockerd` in the background, waits for readiness, then starts the session worker
   - Inner Docker uses `vfs` or `fuse-overlayfs` storage driver (overlay2-in-overlay2 doesn't work without Sysbox's special handling)

4. **Resource limits** — inner Docker daemon needs ~200 MB RAM overhead. Default memory for Docker-enabled sessions should be higher (2 GB+).

5. **Image caching** — cold start is slow because the inner daemon has no images. Options:
   - Pre-load common base images (node:24, python:3.12) into the session worker image
   - Mount a shared read-only image cache volume (Docker supports `--data-root` overlay)
   - Accept cold start penalty (~30s for first `docker pull`)

6. **Networking** — inner containers live on the inner Docker's bridge network, invisible to the host. The session container acts as the gateway. Port forwarding from session container to inner containers uses standard Docker `-p` mappings inside the session.

**Pros:**
- **True isolation.** Inner Docker daemon is completely invisible to the host. Session can't see or affect other sessions or the orchestrator.
- **Full Docker compatibility.** Inner daemon is a real Docker — compose, build, volumes, networks all work exactly as on a laptop.
- **Safe for multi-user deployments.** No socket access, no privilege escalation beyond the Sysbox-managed namespace.

**Cons:**
- **Sysbox dependency.** Must be installed on the host. Not available on all platforms (no macOS Docker Desktop, no Windows, some cloud VMs restrict it).
- **Performance overhead.** Nested overlay2 is slower. Inner daemon startup adds 5-10s to session activation.
- **Memory overhead.** ~200 MB for `dockerd` + ~100 MB for containerd, per Docker-enabled session.
- **Image cold start.** First `docker pull` in a session is slow unless images are pre-cached.
- **Complexity.** More moving parts: session worker entrypoint manages daemon lifecycle, health checks for both worker and inner daemon, storage driver configuration.

---

### Comparison

| | Socket Passthrough | Socket Proxy | DinD + Sysbox |
|---|---|---|---|
| **Isolation** | None — full host access | Per-session — enforced by proxy | Full — isolated daemon |
| **Docker compatibility** | 100% | ~95% (proxy may miss edge cases) | 100% |
| **Performance** | Zero overhead | ~50 MB/session (proxy) | ~300 MB/session (daemon) + 5-10s startup |
| **Host requirements** | Docker | Docker | Docker + Sysbox |
| **Implementation effort** | ~3 days | ~8 days (custom proxy) | ~5 days |
| **Safe for multi-user** | No | Yes (with custom proxy) | Yes |
| **Compose support** | Full | Full | Full |

### Recommendation

**Start with Option 1 (socket passthrough)** for the self-hosted single-user case. It's the fastest path to full Docker support with perfect fidelity. ShipIt is currently single-user, so the "session can see all containers" concern is moot — the user already owns the machine.

**Design Option 2 (socket proxy) as the upgrade path** for when multi-user matters. The proxy is a drop-in replacement: same socket mount from the session's perspective, just pointing at a proxy instead of the real daemon. No session-side changes needed.

**Option 3 (Sysbox DinD)** is the cleanest isolation model but adds a host dependency that limits where ShipIt can run. Keep it as a documented alternative for deployments that already have Sysbox.

The key architectural choice: **`capabilities.docker` in `shipit.yaml` is the stable API**. The backend implementation (raw socket, proxy, or DinD) is an orchestrator deployment decision, not a per-project decision. A project declares "I need Docker"; the orchestrator decides how to provide it.

---

### Part B: Configurable Resource Limits

**Problem**: Session containers default to 512 MB / 0.5 CPU / 256 PIDs. Running ShipIt (or any substantial Node project) needs 4x that. Running Docker inside a session needs even more.

**Design**: Add a `resources` block to `shipit.yaml`:

```yaml
resources:
  memory: 2048    # MB (default: 512, cap set by deployment)
  cpu: 2.0        # cores (default: 0.5)
  pids: 1024      # max PIDs (default: 256)
```

**Flow:**

1. User clones a repo that has `shipit.yaml` with `resources`.
2. Orchestrator reads `shipit.yaml` from the session directory *before* creating the container (today it's read by the session worker *after* the container starts — this must change).
3. Orchestrator applies deployment-level caps: `MAX_SESSION_MEMORY_MB` (default 4096), `MAX_SESSION_CPU` (default 4), `MAX_SESSION_PIDS` (default 2048).
4. Capped values are passed to `SessionContainerManager.buildConfig()`.

**Chicken-and-egg**: Today, `shipit.yaml` is parsed by the session worker inside the container. But resource limits must be known *before* the container is created. Fix: the orchestrator reads `shipit.yaml` directly from the session directory (which lives on a volume it can access) before calling `create()`. The session worker still reads it for preview config — no change there.

**Code changes:**

1. Add `resolveResourceConfig(sessionDir: string)` to a new shared module (or extend `preview-config.ts`) — parses just the `resources` and `capabilities` blocks from `shipit.yaml`.
2. In the runner factory (`index.ts` line ~308), call `resolveResourceConfig()` and pass results to `buildConfig()`.
3. Add `dockerAccess` to `ContainerConfig`, handle in `create()`.
4. Add deployment-level cap env vars, apply in `buildConfig()`.

---

### Part C: ShipIt Self-Hosting Configuration

With Parts A and B, ShipIt can host itself. The `shipit.yaml` for the ShipIt repo:

```yaml
capabilities:
  docker: true

resources:
  memory: 3072    # orchestrator + session workers + Claude CLI
  cpu: 2.0
  pids: 2048      # Docker daemon overhead + many child processes

install: npm ci

preview:
  command: |
    # Build session worker image (needed by orchestrator to spawn session containers)
    docker build -t shipit-session-worker:dev -f docker/Dockerfile.session-worker.dev .
    # Start Vite dev server (client HMR) and Fastify API server
    API_PORT=3001 npx vite --host 0.0.0.0 --port 3000 &
    WORKSPACE_VOLUME="" USE_CONTAINERS=true SESSION_WORKER_IMAGE=shipit-session-worker:dev \
      DOCKER_NETWORK=shipit-inner DOCKER_STACK=shipit-inner PORT=3001 npm run dev
  ports: [3000]
```

The Vite dev server on port 3000 serves the client and proxies `/api/*` and `/ws` to Fastify on port 3001. The outer ShipIt's preview proxy exposes port 3000 as `{sessionId}--3000.localhost`. The inner ShipIt's own session containers join a separate bridge network (`shipit-inner`), invisible to the outer orchestrator.

**Container cleanup**: When the session is destroyed, the orchestrator also kills containers with label `shipit-parent-session={sessionId}` *and* any containers on the `shipit-inner` network. This handles both the inner ShipIt's orchestrator container (there isn't one — it runs directly in the session) and the inner session worker containers.

---

## Networking: How Nested Previews Work

```
Browser
  → GET {outerSessionId}--3000.localhost
    → Outer preview proxy → session container bridge IP:3000
      → Vite dev server (proxies /api and /ws to localhost:3001)
        → Inner ShipIt Fastify (localhost:3001)
          → Inner preview proxy: /preview/{innerSessionId}/{port}/*
            → Inner session container bridge IP:{port}
              → User's dev server
```

The browser only talks to the outer ShipIt. The inner ShipIt's previews are accessed through its path-based preview proxy (`/preview/...`), which the outer preview proxy transparently forwards.

### HMR WebSocket Patch

Current patch (`preview-proxy.ts` line 57-68) rewrites *all* WebSocket connections from `localhost:*` to the page origin. This would break the inner ShipIt's application WebSocket at `/ws`.

**Fix**: Only rewrite when `a.port !== location.port` AND `a.pathname` does not match known application paths. Simpler: check if the port differs from the page's port — the inner ShipIt's `/ws` uses the same port as the page (both go through the Vite proxy on 3000), so the condition `a.port !== location.port` already skips it. The current patch should actually be fine for the self-hosting case — the rewrite only triggers when the port differs, which is only true for HMR connections to the raw dev server port.

---

## Implementation Plan

### Phase 1: Resource configuration (~2 days)

1. Add `resources` and `capabilities` parsing to `preview-config.ts` (or new `session-config.ts`).
2. Read `shipit.yaml` from session directory in the orchestrator's runner factory, before container creation.
3. Plumb resource overrides through `buildConfig()` → `create()`.
4. Add deployment-level cap env vars.
5. Tests: unit tests for config parsing, integration test for resource override flow.

### Phase 2: Docker socket passthrough (~3 days)

1. Add `dockerAccess: boolean` to `ContainerConfig`.
2. In `create()`, conditionally mount docker socket and remove `no-new-privileges`.
3. Install Docker CLI in session worker image (new Dockerfile layer).
4. Add `DOCKER_DEFAULT_LABELS` env var for child container tracking.
5. Extend `destroy()` to clean up child containers by label.
6. Tests: unit tests for mount logic, integration test with mock Docker.

### Phase 3: Self-hosting validation (~2 days)

1. Write `shipit.yaml` for the ShipIt repo.
2. Clone ShipIt in a ShipIt session with Docker access + elevated resources.
3. Validate: `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`.
4. Validate: `docker build` for session worker image.
5. Validate: inner ShipIt starts, serves UI through preview, spawns inner session containers.
6. Validate: editing code in inner ShipIt, running inner Claude, seeing inner previews.
7. Document remaining issues.

### Future: Socket proxy for multi-user (~8 days, not blocking)

1. Build custom Docker API proxy (Node.js HTTP proxy, ~500 lines).
2. Label injection on `container create`.
3. Per-container filtering on `start`, `stop`, `rm`, `exec`.
4. Orchestrator starts proxy sidecar per Docker-enabled session.
5. Mount proxy socket instead of real socket.
6. Tests: proxy filtering logic, multi-session isolation.

---

## Open Questions

1. **Should `capabilities.docker` require user confirmation in the UI?** A project's `shipit.yaml` requesting Docker access is a privilege escalation. The UI could show a prompt: "This project requests Docker access. Allow?" Default: allow for self-hosted, require confirmation for hosted.

2. **Docker image caching across sessions.** With socket passthrough, images are shared (same daemon). With DinD, each session has its own image store. Should we pre-pull common base images into the session worker image?

3. **Compose project naming.** Multiple sessions running the same compose file will collide on project name. Should we inject `COMPOSE_PROJECT_NAME={sessionId}` automatically?

4. **GPU passthrough.** Some projects (ML, CUDA) need GPU access. This is a separate capability (`capabilities.gpu: true`) with `--gpus` flag. Out of scope for this doc but worth noting as a future capability.

5. **Docker build context.** Building images inside a session uses the session directory. For ShipIt self-hosting, the full repo is the build context — this can be large. Consider `.dockerignore` guidance.
