---
status: planned
---

# 061 — Self-Hosted Docker-Capable Sessions

Give session containers access to Docker so users running ShipIt locally can develop projects that use Docker Compose, run containerized services, or — the motivating case — develop ShipIt itself inside ShipIt.

## Scope

This doc covers **self-hosted ShipIt** — a single user running ShipIt on their own machine (macOS Docker Desktop, Linux, WSL2). The threat model is "protect the user from Claude mistakes," not "protect tenants from each other." Multi-tenant managed hosting is a separate concern with different isolation requirements — see [062-managed-shipit](../062-managed-shipit/plan.md).

## Motivation

Many real-world projects depend on Docker: microservice stacks with `docker-compose`, apps with database containers, build pipelines that produce images, and ShipIt itself. Today, session containers have no Docker access — Claude can edit Dockerfiles and compose files, but can't run them.

The acid test is self-hosting: developing ShipIt inside ShipIt, running the full containerized stack (orchestrator + session worker containers), and verifying it works exactly as it would standalone. If it works for ShipIt, it works for any Docker-using project.

### Why fidelity matters

A simulation or broker layer that makes Docker "sort of work" inside sessions would create a divergence: code that works in ShipIt might break when deployed, and vice versa. The goal is that `docker compose up` inside a session behaves identically to running it on a developer's laptop. The app must talk to a real Docker daemon.

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

### Key abstraction

`capabilities.docker` in `shipit.yaml` is the stable API. A project declares "I need Docker"; the orchestrator decides how to provide it. This decouples projects from the host's Docker access strategy and keeps the door open for the managed deployment model (doc 062) to use a completely different backend.

---

### Part A: Docker Access for Sessions

#### Recommended: Docker Socket Passthrough

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

**Why this is right for self-hosted:** The user already owns the machine. Their Claude process talking to their Docker daemon is no different from the user running Docker themselves. Adding a proxy or nested daemon would add complexity and failure modes with no security benefit in a single-user context. Note that mounting the Docker socket does weaken the session sandbox (doc 051) — Claude can create sibling containers outside the sandbox's filesystem and resource constraints. This is acceptable for self-hosted because the user already has full Docker access on their own machine.

**Changes required:**

1. **`shipit.yaml` capability flag:**
   ```yaml
   capabilities:
     docker: true
   ```

2. **`ContainerConfig` extension** — add optional `dockerAccess: boolean` field.

3. **Session worker image variant** — a `Dockerfile.session-worker.docker` that adds the Docker CLI binary (just the client, not the daemon) on top of the base session worker image. Docker-enabled sessions use this image; non-Docker sessions use the base image.

4. **`SessionContainerManager.create()`** — when `dockerAccess` is true:
   - Use the Docker-capable session worker image
   - Bind-mount `/var/run/docker.sock:/var/run/docker.sock`
   - Remove `no-new-privileges` (required for Docker socket access)
   - Pass `DOCKER_HOST=unix:///var/run/docker.sock` env var

5. **Container cleanup** — when a session is destroyed, also clean up any containers it spawned. Use label-based tracking: a `docker` wrapper script in the session worker image injects `--label shipit-parent-session={sessionId}` on `docker create` / `docker run` commands. The orchestrator's `destroy()` method queries and removes child containers by label.

6. **Network isolation** — child containers created by the session should join a session-specific network (not the orchestrator's network). The orchestrator creates a bridge network `shipit-session-{sessionId}` before starting the session container, and passes it via `DOCKER_NETWORK` env var. The session's `docker` wrapper adds `--network $DOCKER_NETWORK` to container creation commands. The orchestrator removes the network on session destroy.

**Pros:**
- Simplest implementation. ~3 days of work.
- Full Docker compatibility — compose, build, push, volumes, networks all work.
- No extra runtime dependencies. Works everywhere Docker runs (macOS Docker Desktop, Linux, WSL2).
- Zero performance overhead.

**Cons:**
- No isolation from host Docker. The session can see all containers on the host.
- Only appropriate for single-user self-hosted deployments.

**UX polish (cosmetic, not security boundaries):**
- The `docker` wrapper filters `docker ps` output to the session's own containers by default (adds `--filter label=shipit-parent-session=$SESSION_ID`). Users can bypass with `docker --raw ps` or by calling `/usr/bin/docker` directly.
- The wrapper sets `COMPOSE_PROJECT_NAME=shipit-{sessionId-prefix}` so multiple sessions running the same compose file don't collide on project name.

#### Alternative: DinD with Sysbox (Linux-only)

For users who want stronger isolation on Linux, Sysbox provides a fully isolated Docker daemon per session. This is **not the default** because of platform constraints.

```
Host Docker daemon (with Sysbox runtime)
  └── Session container (Sysbox-managed)
        └── Inner Docker daemon (fully isolated)
              ├── user's service-a
              └── user's service-b
```

**Requirements:**
- Linux host with kernel 5.12+ (or 5.4+ on Ubuntu/Debian with shiftfs)
- `apt install sysbox-ce` on the host
- Does NOT work on macOS Docker Desktop, Windows, or most managed container platforms

**Changes (on top of the base implementation):**
- `SessionContainerManager.create()` passes `HostConfig.Runtime: "sysbox-runc"` for Docker-enabled sessions
- A separate image variant (`Dockerfile.session-worker.sysbox`) extends the Docker-capable image with `dockerd`, an entrypoint that starts the inner daemon and waits for readiness
- Inner Docker uses `vfs` or `fuse-overlayfs` storage driver
- Higher default memory (2 GB+) for the inner daemon overhead (~300 MB)

**Trade-offs vs socket passthrough:**
- True isolation (inner daemon is invisible to host) — but unnecessary for single-user
- ~300 MB memory overhead + 5-10s startup per session
- Image cold start unless pre-cached
- More moving parts (daemon lifecycle, health checks, storage driver config)

**When to use:** Linux servers where the operator wants defense-in-depth, or as a stepping stone to evaluate DinD before the managed model. Not the default recommendation for self-hosted.

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

1. Add `resolveSessionConfig(sessionDir: string)` to a new shared module (or extend `preview-config.ts`) — parses `resources` and `capabilities` blocks from `shipit.yaml`.
2. In the runner factory (`index.ts` line ~308), call `resolveSessionConfig()` and pass results to `buildConfig()`.
3. Add deployment-level cap env vars, apply in `buildConfig()`.
4. Add `dockerAccess` to `ContainerConfig`, handle in `create()` (this bridges Parts A and B — capabilities parsing feeds into container creation).

---

### Part C: ShipIt Self-Hosting Configuration

With Parts A and B, ShipIt can host itself. The `shipit.yaml` for the ShipIt repo:

```yaml
capabilities:
  docker: true

resources:
  memory: 3072    # orchestrator + session workers + Claude CLI
  cpu: 2.0
  pids: 2048      # many child processes from compose services, session workers, etc.

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

**Container cleanup**: The general label-based cleanup (Part A, change #5) handles this automatically — the inner ShipIt's session worker containers are created via the Docker socket with the `shipit-parent-session={sessionId}` label. The `shipit-inner` bridge network is also cleaned up as the session-specific network (Part A, change #6).

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

Current patch (`preview-proxy.ts` line 57-68) rewrites WebSocket connections from `localhost:*` to the page origin, but only when `a.port !== location.port`. The inner ShipIt's application WebSocket at `/ws` goes through the Vite proxy on the same port as the page (3000), so this condition is false and the rewrite is skipped. The current patch should work for self-hosting without changes.

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
2. Build `Dockerfile.session-worker.docker` — base image + Docker CLI + wrapper script.
3. In `create()`, conditionally use Docker image, mount socket, remove `no-new-privileges`.
4. Implement `docker` wrapper script (label injection, network injection, ps filtering).
5. Create session-specific bridge network on session start, remove on destroy.
6. Extend `destroy()` to clean up child containers by label.
7. Tests: unit tests for mount logic, integration test with mock Docker.

### Phase 3: Self-hosting validation (~2 days)

1. Write `shipit.yaml` for the ShipIt repo.
2. Clone ShipIt in a ShipIt session with Docker access + elevated resources.
3. Validate: `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`.
4. Validate: `docker build` for session worker image.
5. Validate: inner ShipIt starts, serves UI through preview, spawns inner session containers.
6. Validate: editing code in inner ShipIt, running inner Claude, seeing inner previews.
7. Document remaining issues.

---

## Open Questions

1. **Should `capabilities.docker` require user confirmation in the UI?** A project's `shipit.yaml` requesting Docker access is a privilege escalation. The UI could show a prompt: "This project requests Docker access. Allow?" Default: allow for self-hosted.

2. **Docker image caching across sessions.** With socket passthrough, images are shared (same daemon), which is a free advantage. No cold start penalty.

3. **GPU passthrough.** Some projects (ML, CUDA) need GPU access. This is a separate capability (`capabilities.gpu: true`) with `--gpus` flag. Out of scope for this doc but worth noting as a future capability.

4. **Docker build context.** Building images inside a session uses the session directory. For ShipIt self-hosting, the full repo is the build context — this can be large. Consider `.dockerignore` guidance.
