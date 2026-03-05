# 061 — Self-Hosted Docker-Capable Sessions: Checklist

## Phase 1: Resource configuration

- [x] Create `src/server/shared/session-config.ts` with `resolveSessionConfig(sessionDir: string)`
  - [x] Parse `resources` block from `shipit.yaml` (`memory`, `cpu`, `pids`)
  - [x] Parse `capabilities` block from `shipit.yaml` (`docker: boolean`)
  - [x] Return typed config with defaults for missing fields
- [x] Read `shipit.yaml` in orchestrator's runner factory (`index.ts`) before container creation
- [x] Add deployment-level cap env vars: `MAX_SESSION_MEMORY_MB` (default 4096), `MAX_SESSION_CPU` (default 4), `MAX_SESSION_PIDS` (default 2048)
- [x] Apply caps in `resolveSessionConfig()` — `min(requested, cap)` for each resource
- [x] Plumb capped values through `buildConfig()` → `create()`
- [x] Unit tests for `resolveSessionConfig()`: valid config, missing fields (defaults), missing file (defaults), invalid values (capped/rejected)
- [ ] Integration test for resource override flow: session with `shipit.yaml` resources gets container with overridden limits

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
- [ ] Inject session-specific network

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

### Image endpoints (unscoped)
- [x] `GET /images/*` — passthrough
- [x] `POST /images/create` — passthrough
- [x] `POST /build` — passthrough (chunked streaming, no body buffering)
- [x] `DELETE /images/{id}` — passthrough

### System endpoints (unscoped)
- [x] `GET /_ping` — passthrough
- [x] `GET /version` — passthrough
- [x] `GET /info` — passthrough

### Default deny
- [x] All other endpoints return 403

### ContainerConfig and session container changes
- [x] Add `dockerAccess: boolean` to `ContainerConfig`
- [ ] Build `Dockerfile.session-worker.docker` — base image + Docker CLI binary (no daemon)
- [x] In `create()`, when `dockerAccess` is true: use Docker-capable image
- [x] Set `DOCKER_HOST=tcp://{orchestrator-bridge-ip}:{proxy-port}` env var
- [ ] Create session-specific bridge network `shipit-session-{sessionId}`
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
- [ ] Integration: proxy routing end-to-end (create → start → logs → stop → rm)
- [ ] Integration: network create/connect/disconnect/delete lifecycle
- [ ] Integration: volume create/delete lifecycle
- [ ] Integration: session cleanup removes all labeled resources

## Phase 4: Self-hosting validation

- [ ] Write `shipit.yaml` for the ShipIt repo (capabilities, resources, install, preview)
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
