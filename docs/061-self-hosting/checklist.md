# 061 — Self-Hosted Docker-Capable Sessions: Checklist

## Phase 1: Resource configuration

- [ ] Create `src/server/shared/session-config.ts` with `resolveSessionConfig(sessionDir: string)`
  - [ ] Parse `resources` block from `shipit.yaml` (`memory`, `cpu`, `pids`)
  - [ ] Parse `capabilities` block from `shipit.yaml` (`docker: boolean`)
  - [ ] Return typed config with defaults for missing fields
- [ ] Read `shipit.yaml` in orchestrator's runner factory (`index.ts`) before container creation
- [ ] Add deployment-level cap env vars: `MAX_SESSION_MEMORY_MB` (default 4096), `MAX_SESSION_CPU` (default 4), `MAX_SESSION_PIDS` (default 2048)
- [ ] Apply caps in `SessionContainerManager.buildConfig()` — `min(requested, cap)` for each resource
- [ ] Plumb capped values through `buildConfig()` → `create()`
- [ ] Unit tests for `resolveSessionConfig()`: valid config, missing fields (defaults), missing file (defaults), invalid values (capped/rejected)
- [ ] Integration test for resource override flow: session with `shipit.yaml` resources gets container with overridden limits

## Phase 2: Session container hardening

- [ ] Add `CapDrop: ["ALL"]` to `SessionContainerManager.create()` for ALL session containers
- [ ] Add `CapAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE", "NET_BIND_SERVICE", "KILL"]`
- [ ] Verify existing tests pass (no session worker functionality depends on dropped caps)
- [ ] Add test asserting container config includes `CapDrop` and `CapAdd`

## Phase 3: Docker API proxy

### Core proxy infrastructure
- [ ] Create `src/server/orchestrator/docker-proxy.ts` with `createDockerProxy(deps)`
- [ ] Bind to Docker bridge gateway IP (resolved via `docker network inspect bridge` at startup)
- [ ] Source IP → session lookup via `containerManager.getSessionByContainerIp()` returning `{ sessionId, hostWorkspaceDir, dockerAccess }`
- [ ] `dockerAccess` gate: reject requests from non-Docker sessions with 403
- [ ] Request body size limit (10 MB); `POST /build` piped through without buffering
- [ ] try/catch on all request handlers — malformed requests return 400
- [ ] Forward to Unix socket via `http.request({ socketPath })`

### Container create sanitization (`POST /containers/create`)
- [ ] Reject `Privileged: true`
- [ ] Reject non-empty `CapAdd`
- [ ] Inject `NET_RAW` into `CapDrop`
- [ ] Reject `NetworkMode: "host"`
- [ ] Reject `PidMode` set to `host` or `container:{id}`
- [ ] Reject `IpcMode` set to `host` or `container:{id}`
- [ ] Reject `UTSMode: "host"`
- [ ] Reject non-empty `Devices`
- [ ] Validate `Binds`: resolve each host path with `realpath()`, reject if outside session's host-side workspace directory
- [ ] Validate `Mounts` with `Type: "bind"`: resolve `Source` with `realpath()`, same validation as `Binds`
- [ ] Validate `Mounts` with `Type: "volume"`: verify named volume has session's label
- [ ] Allow `Mounts` with `Type: "tmpfs"` (no host path)
- [ ] Validate named `Volumes`: verify each has session's label
- [ ] Reject non-empty `VolumesFrom`
- [ ] Strip `SecurityOpt`
- [ ] Strip `CgroupParent`
- [ ] **Overwrite** `shipit-parent-session` label (never merge with client-supplied value)
- [ ] Inject session-specific network

### Label-based scoping (container operations)
- [ ] `GET /containers/json` — filter response to session-labeled containers only
- [ ] `GET /containers/{id}/json` — label check
- [ ] `POST /containers/{id}/start` — label check
- [ ] `POST /containers/{id}/stop` — label check
- [ ] `POST /containers/{id}/restart` — label check
- [ ] `POST /containers/{id}/kill` — label check
- [ ] `DELETE /containers/{id}` — label check
- [ ] `POST /containers/{id}/wait` — label check

### Container I/O (label-scoped, some streaming)
- [ ] `GET /containers/{id}/logs` — label check, streaming proxy
- [ ] `POST /containers/{id}/attach` — label check, streaming proxy
- [ ] `POST /containers/{id}/exec` — label check
- [ ] `POST /exec/{id}/start` — resolve exec → parent container via Docker daemon's `GET /exec/{id}/json`, label check, streaming proxy
- [ ] `GET /exec/{id}/json` — resolve exec → parent container, label check

### Network endpoints (label-scoped)
- [ ] `POST /networks/create` — overwrite `shipit-parent-session` label
- [ ] `GET /networks` — filter to session-labeled networks
- [ ] `GET /networks/{id}` — label check
- [ ] `DELETE /networks/{id}` — label check
- [ ] `POST /networks/{id}/connect` — dual label check (network + container)
- [ ] `POST /networks/{id}/disconnect` — dual label check (network + container)

### Volume endpoints (label-scoped)
- [ ] `POST /volumes/create` — overwrite `shipit-parent-session` label
- [ ] `GET /volumes` — filter to session-labeled volumes
- [ ] `GET /volumes/{id}` — label check
- [ ] `DELETE /volumes/{id}` — label check

### Image endpoints (unscoped)
- [ ] `GET /images/*` — passthrough
- [ ] `POST /images/create` — passthrough
- [ ] `POST /build` — passthrough (chunked streaming, no body buffering)
- [ ] `DELETE /images/{id}` — passthrough

### System endpoints (unscoped)
- [ ] `GET /_ping` — passthrough
- [ ] `GET /version` — passthrough
- [ ] `GET /info` — passthrough

### Default deny
- [ ] All other endpoints return 403

### ContainerConfig and session container changes
- [ ] Add `dockerAccess: boolean` to `ContainerConfig`
- [ ] Build `Dockerfile.session-worker.docker` — base image + Docker CLI binary (no daemon)
- [ ] In `create()`, when `dockerAccess` is true: use Docker-capable image
- [ ] Set `DOCKER_HOST=tcp://{orchestrator-bridge-ip}:{proxy-port}` env var
- [ ] Create session-specific bridge network `shipit-session-{sessionId}`
- [ ] Set `COMPOSE_PROJECT_NAME=shipit-{sessionId-prefix}` env var

### Cleanup
- [ ] On session destroy: query Docker for containers with `shipit-parent-session={sessionId}` label, stop and remove them
- [ ] On session destroy: remove session-labeled networks
- [ ] On session destroy: remove session-labeled volumes

### Proxy lifecycle
- [ ] Start proxy in `buildApp()` alongside Fastify server
- [ ] Shut down proxy on app close
- [ ] Inject proxy as dependency (testable)

### Tests
- [ ] Unit: each sanitization rule in container create (Privileged, CapAdd, CapDrop injection, NetworkMode, PidMode, IpcMode, UTSMode, Devices, Binds, Mounts bind, Mounts volume, VolumesFrom, SecurityOpt, CgroupParent, label overwrite)
- [ ] Unit: `dockerAccess` gate — non-Docker session gets 403
- [ ] Unit: label-scoping checks (container, network, volume)
- [ ] Unit: exec-to-container resolution
- [ ] Unit: unknown endpoint returns 403
- [ ] Unit: request body size limit (>10 MB rejected, `POST /build` exempt)
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
