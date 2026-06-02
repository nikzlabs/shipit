
# 061 — Self-Hosted Docker-Capable Sessions

Give session containers access to Docker so users running ShipIt locally can develop projects that use Docker Compose, run containerized services, or — the motivating case — develop ShipIt itself inside ShipIt.

**Note:** The Docker API proxy and security policy from this doc remain relevant for compose container sanitization. The `capabilities.docker` config field has been replaced by `compose.docker-socket` in [086-shipit-yaml-and-compose](../086-shipit-yaml-and-compose/plan.md), which scopes Docker access to compose services rather than the agent container.

**Status:** Phases 1-3b (resource config, container hardening, Docker API proxy) are fully implemented and tested. Phase 4 (self-hosting validation — running ShipIt inside ShipIt) is tracked in [089-shipit-in-shipit](../089-shipit-in-shipit/plan.md), which identifies and fixes the remaining proxy policy gaps.

## Scope

This doc covers **self-hosted ShipIt** — a single user running ShipIt on their own machine (macOS Docker Desktop, Linux, WSL2). The threat model is "protect the user from Claude mistakes," not "protect tenants from each other." Multi-tenant managed hosting is a separate concern with different isolation requirements — see [062-managed-shipit](../062-managed-shipit/plan.md).

## Related docs

- [086-shipit-yaml-and-compose](../086-shipit-yaml-and-compose/plan.md) — supersedes the `capabilities.docker` config field with `compose.docker-socket`. The proxy and security policy from this doc remain the enforcement layer.
- [089-shipit-in-shipit](../089-shipit-in-shipit/plan.md) — addresses the Phase 4 self-hosting validation blockers. The proxy policy needs surgical relaxations (safe CapAdd allowlist, SecurityOpt `no-new-privileges`, volume allowlist) and volume context propagation to support a nested orchestrator.

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

### Part A: Docker Access via Orchestrator Proxy

#### Overview

Sessions get a real Docker CLI but **no Docker socket**. Instead, `DOCKER_HOST` points to a policy-enforcing proxy running inside the orchestrator. The proxy is the only path to the host Docker daemon — there is nothing to bypass inside the session container.

```
Session container (no socket, no daemon)
  └── docker CLI (DOCKER_HOST=tcp://172.17.0.1:2375)
        │
        ▼
Orchestrator
  └── Docker API proxy (shared, source-IP routing)
        │  - identifies session by container bridge IP
        │  - enforces policy (no --privileged, no host mounts, etc.)
        │  - injects labels and network
        ▼
Host Docker daemon (/var/run/docker.sock)
```

#### Why not mount the socket directly?

Docker socket access is equivalent to root on the host. A prompt injection could:
- Mount the host filesystem: `docker run -v /:/host alpine sh`
- Run privileged containers: `docker run --privileged`
- Use host networking: `docker run --net=host`
- Persist beyond session destruction by creating untracked containers

These bypass the session sandbox (doc 051) entirely. Even for a single-user self-hosted deployment, this is an unnecessary risk — the proxy provides full Docker compatibility without it.

#### How the proxy works

The orchestrator runs a single Docker API proxy server (`http.createServer`) bound to the Docker bridge gateway IP (e.g., `172.17.0.1`, resolved dynamically at startup via `docker network inspect bridge`). Binding to the bridge gateway rather than `0.0.0.0` ensures the proxy is only reachable from Docker containers, not from the host's LAN. It identifies which session is making the request by the source IP of the TCP connection — each session container has a unique bridge IP. Source-IP spoofing is prevented by dropping `NET_RAW` from session containers (see Security hardening below) and from child containers (see container create sanitization).

**Request flow:**

1. Session's `docker` CLI sends HTTP request to `DOCKER_HOST=tcp://{orchestrator-bridge-ip}:{proxy-port}`
2. Proxy resolves source IP → session ID via `SessionContainerManager`'s container metadata
3. Proxy verifies the resolved session has `dockerAccess: true` — rejects with 403 otherwise (all session containers share the bridge network, so non-Docker sessions can technically reach the proxy)
4. Proxy inspects the request and applies policy
5. Proxy forwards allowed requests to `/var/run/docker.sock`, injecting labels and network
6. Proxy returns the Docker daemon's response to the session

**Policy enforcement on key endpoints:**

| Docker API endpoint | Policy |
|---|---|
| **Container lifecycle** | |
| `POST /containers/create` | Sanitize body (see container create policy below). **Overwrite** `shipit-parent-session` label with the requesting session's ID (never merge with client-supplied value — prevents a session from labeling containers as another session). Inject session-specific network. |
| `GET /containers/json` | Filter response to only containers with the session's label. |
| `GET /containers/{id}/json` | Only if container has the session's label. |
| `POST /containers/{id}/start` | Only if container has the session's label. |
| `POST /containers/{id}/stop` | Only if container has the session's label. |
| `POST /containers/{id}/restart` | Only if container has the session's label. |
| `POST /containers/{id}/kill` | Only if container has the session's label. |
| `DELETE /containers/{id}` | Only if container has the session's label. |
| `POST /containers/{id}/wait` | Only if container has the session's label. |
| **Container I/O** | |
| `GET /containers/{id}/logs` | Only if container has the session's label. Streaming. |
| `POST /containers/{id}/attach` | Only if container has the session's label. Streaming. |
| `POST /containers/{id}/exec` | Only if container has the session's label. |
| `POST /exec/{id}/start` | Only if parent container has the session's label. Streaming. |
| `GET /exec/{id}/json` | Only if parent container has the session's label. |
| **Images** | |
| `GET /images/*` | Allowed (read-only). |
| `POST /images/create` | Allowed (pull). |
| `POST /build` | Allowed. |
| `DELETE /images/{id}` | Allowed (only affects local image cache). |
| **Networks** | |
| `POST /networks/create` | **Overwrite** `shipit-parent-session` label (same semantics as container create). |
| `GET /networks` | Scoped to session-labeled networks. |
| `GET /networks/{id}` | Only if network has the session's label. |
| `DELETE /networks/{id}` | Only if network has the session's label. |
| `POST /networks/{id}/connect` | Only if both network and container have the session's label. |
| `POST /networks/{id}/disconnect` | Only if both network and container have the session's label. |
| **Volumes** | |
| `POST /volumes/create` | **Overwrite** `shipit-parent-session` label (same semantics as container create). |
| `GET /volumes` | Scoped to session-labeled volumes. |
| `GET /volumes/{id}` | Only if volume has the session's label. |
| `DELETE /volumes/{id}` | Only if volume has the session's label. |
| **System (read-only)** | |
| `GET /_ping` | Allowed. Required by Docker CLI and Compose to verify daemon connectivity. |
| `GET /version` | Allowed. Required by Compose for API version negotiation. |
| `GET /info` | Allowed. Read-only system info, no sensitive data. |
| **Everything else** | Deny with 403. |

**Container create sanitization** (`POST /containers/create` body inspection):

| Field | Policy |
|---|---|
| `Privileged` | Must be `false` or absent. |
| `CapAdd` | Must be empty or absent. |
| `CapDrop` | Proxy injects `NET_RAW` into `CapDrop` on every create request. Docker's default capability set includes `NET_RAW`, which would let child containers spoof source IPs at the proxy. Dropping it from child containers extends the same protection applied to session containers (Phase 2). |
| `NetworkMode` | Must not be `host`. |
| `PidMode` | Must be empty or absent (no `host`, no `container:{id}`). |
| `IpcMode` | Must be empty or absent (no `host`, no `container:{id}`). |
| `UTSMode` | Must not be `host`. |
| `Devices` | Must be empty or absent. |
| `Binds` | Each host path is resolved with `realpath()` and must be under the session's host-side workspace directory. Prevents symlink traversal. |
| `Mounts` | Each entry with `Type: "bind"` has its `Source` resolved with `realpath()` and validated the same as `Binds`. Docker's create API accepts bind mounts via both `HostConfig.Binds` (legacy) and top-level `Mounts` (structured) — both must be validated or the `Binds` check is bypassable. Entries with `Type: "volume"` are validated like named `Volumes` (session label check). Entries with `Type: "tmpfs"` are allowed (no host path). |
| `Volumes` (named) | Each named volume is verified to have the session's label. Prevents cross-session volume access. |
| `VolumesFrom` | Must be empty or absent (prevents inheriting another container's mounts). |
| `SecurityOpt` | Stripped (prevent overriding `no-new-privileges` or AppArmor). |
| `CgroupParent` | Stripped. |

The proxy is ~300-400 lines of Node.js. It's an HTTP reverse proxy that reads the request body as JSON for mutation endpoints, inspects/modifies it, then forwards to the Unix socket. For streaming endpoints (`logs`, `exec`, `attach`), it pipes the TCP connection through without buffering.

**Proxy robustness:**
- Request body size capped at 10 MB (Docker API bodies are small; `POST /build` uses chunked streaming and is piped through without buffering).
- Every request handler is wrapped in try/catch — malformed requests return 400, never crash the orchestrator process.
- Node.js's built-in HTTP parser handles Content-Length/Transfer-Encoding correctly, preventing HTTP smuggling.

#### Security hardening (prerequisite)

The proxy's source-IP routing relies on session containers not being able to spoof their bridge IP. This requires hardening the session container config in `session-container.ts` (applies to ALL session containers, not just Docker-enabled ones):

1. **Drop all capabilities, add back only what's needed:**
   ```
   CapDrop: ["ALL"]
   CapAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE",
            "NET_BIND_SERVICE", "KILL"]
   ```
   This drops `NET_RAW` (raw sockets, required for IP spoofing) and `SYS_CHROOT` (unnecessary). The retained capabilities are the minimum for a Node.js session worker (package installs need `CHOWN`/`FOWNER`, workspace volume files may be owned by a non-root host UID so `DAC_OVERRIDE` is needed, dev servers need `NET_BIND_SERVICE`, process management needs `KILL`, user switching needs `SETUID`/`SETGID`).

2. **This is a doc 051 hardening improvement** that benefits all session containers, not just Docker-enabled ones. Session containers have no legitimate need for `NET_RAW`, `MKNOD`, `AUDIT_WRITE`, `FSETID`, `SETPCAP`, or `SETFCAP`. It's listed as Phase 2 here because the proxy's source-IP security depends on it, but it could ship independently as a standalone security improvement.

#### Why source-IP routing (not per-session proxy instances)

A single proxy server handles all sessions. No additional processes, no additional memory. The orchestrator already knows which bridge IP belongs to which session container (it created them). Source IP lookup is O(1) via a Map.

Per-session proxy instances would add ~30-40 MB each (Node.js V8 overhead) or require a second language (Go/Rust) in the build pipeline. Neither is justified — Docker API traffic is low-volume (tens of requests during `docker compose up`, near-zero at steady state).

For the managed model (doc 062), per-pod sidecar proxies in Go make sense for crash isolation between tenants. That's a 062 decision.

#### Changes required

1. **`shipit.yaml` capability flag:**
   ```yaml
   capabilities:
     docker: true
   ```

2. **`ContainerConfig` extension** — add optional `dockerAccess: boolean` field.

3. **Session worker image variant** — a `Dockerfile.session-worker.docker` that adds the Docker CLI binary (just the client, not the daemon) on top of the base session worker image. Docker-enabled sessions use this image; non-Docker sessions use the base image.

4. **Docker API proxy** — new module `src/server/orchestrator/docker-proxy.ts`:
   - `createDockerProxy(deps: { containerManager, socketPath })` returns an `http.Server`
   - Source IP → session ID resolution via `containerManager.getSessionByContainerIp()`, which returns `{ sessionId, hostWorkspaceDir, dockerAccess }` — workspace path is needed for `Binds`/`Mounts` validation, `dockerAccess` is checked before any request is processed
   - Policy enforcement as described above
   - Exec-to-container resolution: `POST /exec/{id}/start` and `GET /exec/{id}/json` query the Docker daemon's `GET /exec/{id}/json` to find the parent container ID, then check that container's `shipit-parent-session` label
   - Forward to Unix socket via `http.request({ socketPath })`
   - Streaming support for `logs`, `exec/start`, `attach` endpoints

5. **`SessionContainerManager.create()`** — when `dockerAccess` is true:
   - Use the Docker-capable session worker image
   - Pass `DOCKER_HOST=tcp://{orchestrator-bridge-ip}:{proxy-port}` env var
   - Keep `no-new-privileges` (no socket mount needed)
   - Create session-specific bridge network `shipit-session-{sessionId}`
   - Set `COMPOSE_PROJECT_NAME=shipit-{sessionId-prefix}` to avoid project name collisions

6. **Container cleanup** — when a session is destroyed, orchestrator queries Docker for containers/networks/volumes with `shipit-parent-session={sessionId}` label and removes them.

7. **Proxy lifecycle** — started in `buildApp()` alongside the Fastify server. Shut down on app close.

**Pros:**
- Full Docker compatibility — real CLI, real API, real responses. `docker compose up` works because compose is just an HTTP client that reads `DOCKER_HOST`.
- No socket in the session. No bypass path. Claude cannot escalate to host root.
- `no-new-privileges` stays in place (no socket mount to require its removal).
- Zero per-session memory overhead (shared proxy).
- Works everywhere Docker runs (macOS Docker Desktop, Linux, WSL2).

**Cons:**
- ~5 days of work (vs ~3 days for raw socket passthrough).
- Proxy must handle Docker API evolution (new endpoints need allowlisting). Mitigated by deny-by-default — unknown endpoints return 403, which surfaces clearly.
- Streaming endpoints (`exec`, `logs`, `attach`) need careful TCP proxying.

#### Not implemented: DinD with Sysbox

Sysbox (fully isolated Docker daemon per session) is deferred to [062-managed-shipit](../062-managed-shipit/plan.md) where the isolation benefit justifies the complexity. For self-hosted, the orchestrator proxy provides sufficient isolation without requiring Sysbox on the host. See doc 062 for the full Sysbox design.

---

### Part B: Configurable Resource Limits

**Problem**: Session containers default to 512 MB / 0.5 CPU / 256 PIDs. Running ShipIt (or any substantial Node project) needs 4x that. Running Docker inside a session needs even more.

**Design**: Add a `resources` block to `shipit.yaml`:

```yaml
resources:
  memory: 2048    # MB (default: 512, cap set by deployment)
  cpu: 2.0        # cores (default: 0.5)
  pids: 4096      # max PIDs (default: 4096)
```

**Flow:**

1. User clones a repo that has `shipit.yaml` with `resources`.
2. Orchestrator reads `shipit.yaml` from the session directory *before* creating the container (today it's read by the session worker *after* the container starts — this must change).
3. Orchestrator applies deployment-level caps: `MAX_SESSION_MEMORY_MB` (default 4096), `MAX_SESSION_CPU` (default 4), `MAX_SESSION_PIDS` (default 4096).
4. Capped values are passed to `SessionContainerManager.buildConfig()`.

**Chicken-and-egg**: Today, `shipit.yaml` is parsed by the session worker inside the container. But resource limits must be known *before* the container is created. Fix: the orchestrator reads `shipit.yaml` directly from the session directory (which lives on a volume it can access) before calling `create()`. The session worker still reads it for preview config — no change there.

**Code changes:**

1. Add `resolveSessionConfig(sessionDir: string)` to a new `src/server/shared/session-config.ts` — parses `resources` and `capabilities` blocks from `shipit.yaml`. This lives in `shared/` (not `session/preview-config.ts`) because the orchestrator calls it before container creation while the session worker hasn't started yet. The session worker's `preview-config.ts` continues to parse preview-specific config independently.
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
  pids: 4096      # many child processes from compose services, session workers, etc.

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

**Container cleanup**: The general label-based cleanup (Part A, change #6) handles this automatically — the inner ShipIt's session worker containers are created via the proxy with the `shipit-parent-session={sessionId}` label. The `shipit-inner` bridge network is also cleaned up as a session-labeled network.

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

1. Add `resources` and `capabilities` parsing to `src/server/shared/session-config.ts`.
2. Read `shipit.yaml` from session directory in the orchestrator's runner factory, before container creation.
3. Plumb resource overrides through `buildConfig()` → `create()`.
4. Add deployment-level cap env vars.
5. Tests: unit tests for config parsing, integration test for resource override flow.

### Phase 2: Session container hardening (~0.5 days)

1. Add `CapDrop: ["ALL"]` and minimal `CapAdd` to `SessionContainerManager.create()`.
2. Verify existing tests pass (no session worker functionality depends on dropped caps).
3. Add test asserting container config includes capability restrictions.

### Phase 3: Docker API proxy (~5 days)

1. Implement `docker-proxy.ts` — `http.createServer` bound to Docker bridge gateway IP (resolved via `docker network inspect bridge`), proxying to Docker Unix socket.
2. Add source IP → session ID resolution via `SessionContainerManager`. Verify resolved session has `dockerAccess: true`.
3. Implement container create sanitization: reject `Privileged`, `CapAdd`, host `NetworkMode`/`PidMode`/`IpcMode`/`UTSMode`, `Devices`, `VolumesFrom`, `SecurityOpt`, `CgroupParent`. Inject `CapDrop: ["NET_RAW"]`. Validate `Binds` AND `Mounts` bind entries with `realpath()` against session's host-side directory. Validate named volumes (in both `Volumes` and `Mounts` type=volume) have session label. Overwrite `shipit-parent-session` label (never merge).
4. Implement label-based scoping for container operations (start, stop, kill, rm, exec, logs, attach, wait).
5. Implement network connect/disconnect with dual label check (network + container).
6. Implement streaming proxy for `exec/start`, `logs`, `attach` endpoints.
7. Add request body size limit (10 MB) and try/catch on all handlers.
8. Add `dockerAccess: boolean` to `ContainerConfig`.
9. Build `Dockerfile.session-worker.docker` — base image + Docker CLI (no wrapper script needed — the proxy enforces everything).
10. In `create()`, conditionally use Docker image, set `DOCKER_HOST`, create session network.
11. Extend `destroy()` to clean up labeled containers, networks, and volumes.
12. Start proxy in `buildApp()`, inject as dependency.
13. Tests: unit tests for each sanitization rule (including `Mounts` bind validation, `CapDrop` injection, label overwrite), test for `dockerAccess` gate (non-Docker session gets 403), label-scoping checks, integration tests for proxy routing, test for 403 on unknown endpoints, test for request body size limit.

### Phase 4: Self-hosting validation (~2 days)

1. Write `shipit.yaml` for the ShipIt repo.
2. Clone ShipIt in a ShipIt session with Docker access + elevated resources.
3. Validate: `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`.
4. Validate: `docker build` for session worker image.
5. Validate: inner ShipIt starts, serves UI through preview, spawns inner session containers.
6. Validate: editing code in inner ShipIt, running inner Claude, seeing inner previews.
7. Document remaining issues.

---

## Decisions

1. **`capabilities.docker` does not require UI confirmation for self-hosted.** The user chose to run ShipIt on their machine and already has Docker access. Showing a permission prompt would add friction with no security benefit. (Managed hosting will require confirmation — see doc 062.)

2. **No `.dockerignore` guidance in this doc.** Docker build context size is a general Docker best practice, not a ShipIt concern. If the ShipIt repo's `docker build` is slow, we add a `.dockerignore` to the repo like any other project.

3. **Orchestrator proxy over raw socket passthrough.** Raw socket gives Claude root-equivalent access to the host. The proxy adds ~2 days of work but closes this hole entirely — no socket in the session, no bypass path, `no-new-privileges` stays in place.

4. **Single shared proxy (source-IP routing) over per-session instances.** Docker API traffic is low-volume. A single `http.createServer` in the orchestrator process handles all sessions with zero additional memory. Per-session Go/Rust proxies are deferred to the managed model (doc 062) where crash isolation between tenants justifies the overhead.

## Future capabilities (out of scope)

- **GPU passthrough** — `capabilities.gpu: true` with `--gpus` flag. Separate feature, separate doc.
