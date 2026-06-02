# 061 — Self-Hosted Docker-Capable Sessions: Checklist

## Phase 1: Resource configuration

- [x] Create `src/server/shared/session-config.ts` with `resolveSessionConfig(sessionDir: string)`
  - [x] Parse `resources` block from `shipit.yaml` (`memory`, `cpu`, `pids`)
  - [x] Parse `capabilities` block from `shipit.yaml` (`docker: boolean`)
  - [x] Return typed config with defaults for missing fields
- [x] Read `shipit.yaml` in orchestrator's runner factory (`index.ts`) before container creation
- [x] Add deployment-level cap env vars: `MAX_SESSION_MEMORY_MB` (default 4096), `MAX_SESSION_CPU` (default 4), `MAX_SESSION_PIDS` (default 4096)
- [x] Apply caps in `resolveSessionConfig()` — `min(requested, cap)` for each resource
- [x] Plumb capped values through `buildConfig()` → `create()`
- [x] Unit tests for `resolveSessionConfig()`: valid config, missing fields (defaults), missing file (defaults), invalid values (capped/rejected)
- [x] Integration test for resource override flow: session with `shipit.yaml` resources gets container with overridden limits

## Phase 2: Session container hardening

- [x] Add `CapDrop: ["ALL"]` to `SessionContainerManager.create()` for ALL session containers
- [x] Add `CapAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE", "NET_BIND_SERVICE", "KILL"]`
- [x] Verify existing tests pass (no session worker functionality depends on dropped caps)
- [x] Add test asserting container config includes `CapDrop` and `CapAdd`

## Phase 3: Docker API proxy

### Core proxy infrastructure
- [x] Create `src/server/orchestrator/docker-proxy.ts` with `createDockerProxy(deps)`
- [x] Bind to Docker bridge gateway IP (resolved via `docker network inspect bridge` at startup)
- [x] Source IP → session lookup via `containerManager.getSessionByContainerIp()` returning `{ sessionId, hostWorkspaceDir, dockerAccess }`
- [x] `dockerAccess` gate: reject requests from non-Docker sessions with 403
- [x] Request body size limit (10 MB); `POST /build` piped through without buffering
- [x] try/catch on all request handlers — malformed requests return 400
- [x] Forward to Unix socket via `http.request({ socketPath })`

### Container create sanitization (`POST /containers/create`)
- [x] Reject `Privileged: true`
- [x] Reject non-empty `CapAdd`
- [x] Inject `NET_RAW` into `CapDrop`
- [x] Reject `NetworkMode: "host"`
- [x] Reject `PidMode` set to `host` or `container:{id}`
- [x] Reject `IpcMode` set to `host` or `container:{id}`
- [x] Reject `UTSMode: "host"`
- [x] Reject non-empty `Devices`
- [x] Validate `Binds`: resolve each host path with `realpath()`, reject if outside session's host-side workspace directory
- [x] Validate `Mounts` with `Type: "bind"`: resolve `Source` with `realpath()`, same validation as `Binds`
- [x] Validate `Mounts` with `Type: "volume"`: verify named volume has session's label
- [x] Allow `Mounts` with `Type: "tmpfs"` (no host path)
- [x] Validate named `Volumes`: verify each has session's label
- [x] Reject non-empty `VolumesFrom`
- [x] Strip `SecurityOpt`
- [x] Strip `CgroupParent`
- [x] **Overwrite** `shipit-parent-session` label (never merge with client-supplied value)
- [x] Inject session-specific network

### Label-based scoping (container operations)
- [x] `GET /containers/json` — filter response to session-labeled containers only
- [x] `GET /containers/{id}/json` — label check
- [x] `POST /containers/{id}/start` — label check
- [x] `POST /containers/{id}/stop` — label check
- [x] `POST /containers/{id}/restart` — label check
- [x] `POST /containers/{id}/kill` — label check
- [x] `DELETE /containers/{id}` — label check
- [x] `POST /containers/{id}/wait` — label check

### Container I/O (label-scoped, some streaming)
- [x] `GET /containers/{id}/logs` — label check, streaming proxy
- [x] `POST /containers/{id}/attach` — label check, streaming proxy
- [x] `POST /containers/{id}/exec` — label check
- [x] `POST /exec/{id}/start` — resolve exec → parent container via Docker daemon's `GET /exec/{id}/json`, label check, streaming proxy
- [x] `GET /exec/{id}/json` — resolve exec → parent container, label check

### Network endpoints (label-scoped)
- [x] `POST /networks/create` — overwrite `shipit-parent-session` label
- [x] `GET /networks` — filter to session-labeled networks
- [x] `GET /networks/{id}` — label check
- [x] `DELETE /networks/{id}` — label check
- [x] `POST /networks/{id}/connect` — dual label check (network + container)
- [x] `POST /networks/{id}/disconnect` — dual label check (network + container)

### Volume endpoints (label-scoped)
- [x] `POST /volumes/create` — overwrite `shipit-parent-session` label
- [x] `GET /volumes` — filter to session-labeled volumes
- [x] `GET /volumes/{id}` — label check
- [x] `DELETE /volumes/{id}` — label check

### Image endpoints
- [x] `GET /images/*` — passthrough (read-only)
- [x] `POST /images/create` — passthrough (documented disk exhaustion risk)
- [x] `POST /build` — passthrough (chunked streaming, documented limitations)
- [x] `DELETE /images/{id}` — blocked (shared resource, cross-session DoS risk)

### System endpoints (unscoped)
- [x] `GET /_ping` — passthrough
- [x] `GET /version` — passthrough
- [x] `GET /info` — passthrough

### Default deny
- [x] All other endpoints return 403

### ContainerConfig and session container changes
- [x] Add `dockerAccess: boolean` to `ContainerConfig`
- [x] Build `Dockerfile.session-worker.docker` — base image + Docker CLI binary (no daemon)
- [x] In `create()`, when `dockerAccess` is true: use Docker-capable image
- [x] Set `DOCKER_HOST=tcp://{orchestrator-bridge-ip}:{proxy-port}` env var
- [x] Create session-specific bridge network `shipit-session-{sessionId}`
- [x] Set `COMPOSE_PROJECT_NAME=shipit-{sessionId-prefix}` env var

### Cleanup
- [x] On session destroy: query Docker for containers with `shipit-parent-session={sessionId}` label, stop and remove them
- [x] On session destroy: remove session-labeled networks
- [x] On session destroy: remove session-labeled volumes

### Proxy lifecycle
- [x] Start proxy in `buildApp()` alongside Fastify server
- [x] Shut down proxy on app close
- [x] Inject proxy as dependency (testable)

### Tests
- [x] Unit: each sanitization rule in container create (Privileged, CapAdd, CapDrop injection, NetworkMode, PidMode, IpcMode, UTSMode, Devices, VolumesFrom, label overwrite)
- [x] Unit: `dockerAccess` gate — non-Docker session gets 403
- [x] Unit: label-scoping checks (container, network, volume)
- [x] Unit: exec-to-container resolution
- [x] Unit: unknown endpoint returns 403
- [x] Unit: request body size limit (>10 MB rejected)
- [x] Integration: proxy routing end-to-end (create → start → logs → stop → rm)
- [x] Integration: network create/connect/disconnect/delete lifecycle
- [x] Integration: volume create/delete lifecycle
- [x] Integration: session cleanup removes all labeled resources

## Phase 3b: Review hardening (post-implementation)

### Container create sanitization (additional)
- [x] Reject `NetworkMode: "container:{id}"` (network namespace sharing)
- [x] Reject unknown mount types (only `bind`, `volume`, `tmpfs` allowed)
- [x] Strip `Sysctls`, `UsernsMode`, `CgroupnsMode`, `Runtime`
- [x] Strip `ReadonlyPaths`, `MaskedPaths`, `GroupAdd`
- [x] `Privileged` check uses truthy (not `=== true`) to prevent type coercion bypass
- [x] Enforce resource limits on child containers (memory, CPU quota, CPU period, PIDs) capped at session's own limits
- [x] Reject negative resource limit values (`-1` = unlimited in Docker)
- [x] Cap `CpuPeriod` to 100ms max to prevent effective CPU limit bypass

### Volume create sanitization
- [x] Block `DriverOpts` (prevents host-path escape via local driver bind mounts)
- [x] Block non-`local` volume drivers

### Proxy robustness
- [x] `dockerRes.on("error")` handler in `pipeToDocker` (crash prevention)
- [x] Client disconnect aborts upstream Docker request (`res.on("close")`)
- [x] `readBody` listener cleanup on rejection (prevent double-resolve)
- [x] Explicit `POST /containers/{id}/rename` and `/update` routes with clear error messages
- [x] `GET /networks/create` and `GET /volumes/create` return 403 instead of void
- [x] Block `DELETE /images/{id}` (shared resource protection)

### Session container lifecycle
- [x] Cache session config at container creation time (not re-read on every proxy request)
- [x] Store `hostWorkspaceDir`, `dockerAccess`, `sessionNetworkName`, `resourceLimits` on `SessionContainer`
- [x] `rediscover()` skips containers without valid workspace dir (not empty string)
- [x] `rediscover()` populates `resourceLimits` from session config
- [x] `create()` cleans up Docker container on late failures (inspect/health check)
- [x] `destroy()` stops session container before cleaning child resources (race fix)
- [x] Health monitor skips containers in `"stopping"` state (no duplicate events)
- [x] Health monitor cleans up `standbySessionIds` on container death
- [x] `cleanupSessionDockerResources` logs warnings instead of swallowing errors
- [x] Network creation errors logged (not silently swallowed)

### Test coverage
- [x] 59 unit tests, 9 integration tests for Docker proxy
- [x] Resource limit capping verified against actual `hostConfig` values (not just status)
- [x] `HostConfig` field stripping verified (Sysctls, UsernsMode, Runtime, SecurityOpt, CgroupParent)
- [x] Bind mount rejection, volume DriverOpts rejection, network connect foreign network
- [x] Container rename/update blocking, image deletion blocking
- [x] `NET_RAW` injection verified via `hostConfig.CapDrop`
- [x] Content-type validation in mock daemon

## Phase 4: Self-hosting validation

Blocked by proxy policy gaps — see [089-shipit-in-shipit](../089-shipit-in-shipit/plan.md) for the fixes needed.

- [x] Write `shipit.yaml` for the ShipIt repo (capabilities, resources, install, preview)
- [ ] Clone ShipIt in a ShipIt session with Docker access + elevated resources
- [ ] Validate: `npm ci` completes
- [ ] Validate: `npm test` passes
- [ ] Validate: `npm run typecheck` passes
- [ ] Validate: `npm run lint` passes
- [ ] Validate: `docker build` for session worker image succeeds
- [ ] Validate: inner ShipIt starts and serves UI through preview
- [ ] Validate: inner ShipIt spawns inner session containers
- [ ] Validate: editing code in inner ShipIt works
- [ ] Validate: running inner Claude works
- [ ] Validate: seeing inner previews works
- [ ] Document remaining issues
