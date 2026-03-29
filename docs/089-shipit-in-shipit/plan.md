---
status: planned
---

# ShipIt in ShipIt

Run a full ShipIt development instance inside a ShipIt session — same Docker-based
execution model, no special "local mode" bypass. Develop, test, and dogfood ShipIt
using ShipIt.

## Motivation

### The problem

ShipIt is a browser IDE that spawns Docker containers for each coding session. To
develop ShipIt itself, you currently need a bare-metal machine with Docker, Node, and
the right env vars. You can't use ShipIt to build ShipIt — the orchestrator needs
Docker access patterns that the Docker proxy explicitly blocks.

This means ShipIt is the one project that can't be vibe-coded in ShipIt.

### What this solves

- **Dogfooding** — develop ShipIt in ShipIt, catching UX and performance issues
  firsthand.
- **CI parity** — run the full integration test suite (which creates real containers)
  inside a session, not just unit tests.
- **Onboarding** — new contributors clone the repo in ShipIt and run `npm run dev`
  without any local Docker setup.

## Current architecture

```
┌─────────────────────────────────────────────────────────┐
│  Host                                                   │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Orchestrator container                           │  │
│  │  - Fastify server (port 3000)                     │  │
│  │  - Docker proxy (random port on bridge IP)        │  │
│  │  - /var/run/docker.sock mounted                   │  │
│  │                                                   │  │
│  │  ┌─────────────┐  ┌─────────────┐                │  │
│  │  │ Session A   │  │ Session B   │   ...           │  │
│  │  │ (agent)     │  │ (agent)     │                │  │
│  │  │ DOCKER_HOST │  │             │                │  │
│  │  │  → proxy    │  │             │                │  │
│  │  │  ┌───────┐  │  │             │                │  │
│  │  │  │compose│  │  │             │                │  │
│  │  │  │service│  │  │             │                │  │
│  │  │  └───────┘  │  │             │                │  │
│  │  └─────────────┘  └─────────────┘                │  │
│  └───────────────────────────────────────────────────┘  │
│  Docker daemon (dockerd)                                │
└─────────────────────────────────────────────────────────┘
```

Sessions get Docker access through the proxy, which enforces:

- No privileged containers
- No `CapAdd` (any capabilities)
- No host/container network/pid/ipc/uts modes
- Bind mounts restricted to workspace directory
- Resource limits capped at parent session's limits
- `SecurityOpt` stripped entirely
- `VolumesFrom` blocked
- Image deletion blocked

## What a nested ShipIt needs

When a session runs `npm run dev` (the ShipIt orchestrator), it becomes a **nested
orchestrator** that needs to:

1. **Create containers** with specific capabilities (`CapAdd` after `CapDrop: ALL`)
2. **Mount workspace paths** as volumes into child containers
3. **Create Docker networks** for child container communication
4. **Discover its own IP** on the bridge network (reads `/etc/hostname`, queries Docker API)
5. **Set `SecurityOpt: no-new-privileges`** on child containers
6. **Have enough resources** (RAM, CPU, PIDs) for itself + child containers

## Blockers and fixes

### Blocker 1: CapAdd is unconditionally rejected

**Current behavior** (`docker-proxy-sanitize.ts:32`):

```typescript
if (Array.isArray(hostConfig.CapAdd) && hostConfig.CapAdd.length > 0) {
  return { error: "Adding capabilities is not allowed" };
}
```

**Why it blocks**: The orchestrator creates session containers with:

```typescript
CapDrop: ["ALL"],
CapAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE",
         "NET_BIND_SERVICE", "KILL"],
```

These are a subset of Docker's default capabilities — they don't escalate beyond what
a normal `docker run` gets. The `CapDrop: ALL` + selective `CapAdd` is actually
*more restrictive* than the Docker default.

**Fix**: Allow a safe allowlist of capabilities when `CapDrop` includes `ALL`:

```typescript
const SAFE_CAPS = new Set([
  "CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE",
  "NET_BIND_SERVICE", "KILL",
]);

if (Array.isArray(hostConfig.CapAdd) && hostConfig.CapAdd.length > 0) {
  // If CapDrop: ALL is present, allow re-adding a safe subset
  const dropAll = Array.isArray(hostConfig.CapDrop)
    && hostConfig.CapDrop.includes("ALL");
  if (!dropAll) {
    return { error: "Adding capabilities is not allowed" };
  }
  for (const cap of hostConfig.CapAdd as string[]) {
    if (!SAFE_CAPS.has(cap)) {
      return { error: `Capability ${cap} is not in the allowlist` };
    }
  }
}
```

**Security impact**: Minimal. These caps are what Docker grants by default. The key
dangerous ones (`SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN`, `NET_RAW`) remain blocked.

### Blocker 2: Bind mount path translation (volume mode)

**Current behavior**: The orchestrator builds bind mounts using host-side paths:

```typescript
binds.push(`${hostWorkspaceDir}:${CONTAINER_WORKSPACE_DIR}:rw`);
```

Inside a session container, the nested orchestrator sees `/workspace/...` but Docker
runs on the host where that path doesn't exist. The proxy validates bind paths against
`session.hostWorkspaceDir` (a host path), so even correctly-formed requests would fail
validation.

**When `WORKSPACE_VOLUME` is set**, the orchestrator already uses named volume mounts
with subpaths instead of bind mounts:

```typescript
mounts.push({
  Type: "volume",
  Source: workspaceVolume,
  Target: CONTAINER_WORKSPACE_DIR,
  VolumeOptions: { Subpath: relPath },
});
```

This avoids the path translation problem entirely — volume names are global Docker
identifiers, not filesystem paths.

**Fix**: Propagate volume context to sessions so nested orchestrators can use volume
mounts:

1. Add env vars to Docker-enabled session containers:
   - `WORKSPACE_VOLUME` — the named volume backing the workspace
   - `CREDENTIALS_VOLUME` — the named volume for credentials

2. The nested orchestrator picks these up (it already reads them from `process.env`
   in `app-lifecycle.ts`) and uses volume subpath mounts for its own child containers.

3. Relax the proxy's volume validation: currently `volumeBelongsToSession()` checks
   that a volume has the session's `shipit-parent-session` label. The workspace and
   credentials volumes are created externally and won't have this label. Add an
   exception for volumes explicitly listed in the session's allowed set.

**Volume mount flow for nested orchestrator**:

```
Host volume: "shipit-workspace"
  └── sessions/
       └── abc123/             ← outer session workspace (subpath mount)
            └── repos/
                 └── shipit/   ← ShipIt repo clone
                      └── ...

Outer orchestrator mounts:
  shipit-workspace (subpath: sessions/abc123) → /workspace

Nested orchestrator creates child session at /workspace/sessions/xyz789/
  and mounts:
  shipit-workspace (subpath: sessions/abc123/sessions/xyz789) → /workspace
```

The key insight: the nested orchestrator's `WORKSPACE_VOLUME` is the same volume as
the outer one, but its base path (`/workspace/`) maps to a deeper subpath. The nested
orchestrator writes session dirs under `/workspace/sessions/`, which resolve to deeper
subpaths in the same volume.

For this to work, the nested orchestrator must know its own subpath prefix so it can
compute correct subpaths for its children. New env var:
- `WORKSPACE_VOLUME_SUBPATH` — the subpath this container's `/workspace` maps to
  (e.g., `sessions/abc123`). The nested orchestrator prepends this when building
  child volume mounts.

### Blocker 3: SecurityOpt is stripped

**Current behavior** (`docker-proxy-sanitize.ts:112`):

```typescript
delete hostConfig.SecurityOpt;
```

**Why it blocks**: The orchestrator sets `SecurityOpt: ["no-new-privileges"]` on child
containers. Stripping it silently weakens child container security.

**Fix**: Allow `no-new-privileges` specifically:

```typescript
if (Array.isArray(hostConfig.SecurityOpt)) {
  hostConfig.SecurityOpt = (hostConfig.SecurityOpt as string[])
    .filter(opt => opt === "no-new-privileges");
  if (hostConfig.SecurityOpt.length === 0) {
    delete hostConfig.SecurityOpt;
  }
} else {
  delete hostConfig.SecurityOpt;
}
```

**Security impact**: Positive — `no-new-privileges` is a hardening flag. Allowing it
makes child containers *more* secure than stripping it.

### Blocker 4: Resource limits too tight for nested orchestrator

**Current defaults**: 1 GB RAM, 0.5 CPU, 256 PIDs.

A nested orchestrator needs to run itself (Node process ~200 MB) plus spawn child
session containers, each with their own worker process. The proxy caps child container
limits to the parent session's limits.

**Fix**: Use `shipit.yaml` in the ShipIt repo to declare higher limits:

```yaml
agent:
  memory: 4096    # 4 GB for orchestrator + headroom for child containers
  cpu: 4.0
  pids: 2048

compose:
  docker-socket: true
```

The proxy resource capping is correct behavior — child containers of the nested
orchestrator will be capped at these limits, which is fine for inner development
sessions.

**Note**: The `MAX_SESSION_*` env vars on the outer orchestrator must allow these
values. Default caps are 4096 MB / 4 CPU / 2048 PIDs, which matches exactly. For
heavier workloads the outer orchestrator's caps need raising.

### Blocker 5: Docker CLI + Compose not in standard session image

**Current state**: `Dockerfile.session-worker.docker` adds Docker CLI and Compose
plugin to the base session worker image. This image is selected when `dockerAccess` is
true (`SESSION_WORKER_DOCKER_IMAGE`).

The nested orchestrator doesn't need the Docker CLI directly (it uses `dockerode` over
`DOCKER_HOST`), but `ServiceManager` shells out to `docker compose` for managing
session services.

**Fix**: Already solved — sessions with `compose.docker-socket: true` already get the
Docker-capable image. The ShipIt repo's `shipit.yaml` enables this.

### Blocker 6: Orchestrator IP discovery

The orchestrator calls `resolveOwnContainerIp()` at startup, which:

1. Reads `/etc/hostname` to get its container ID
2. Queries `GET /containers/{id}/json` via `/var/run/docker.sock`
3. Extracts its IP from `NetworkSettings.Networks[networkName]`

Inside a session container, there's no `/var/run/docker.sock` — Docker access goes
through the proxy at `DOCKER_HOST`. But `resolveOwnContainerIp()` hardcodes the
socket path.

**Fix**: Make `resolveOwnContainerIp()` use `DOCKER_HOST` when set, falling back to
the Unix socket. The proxy already allows `GET /containers/{id}/json` for
session-owned containers — but the orchestrator's own container isn't labeled as
belonging to its session.

Alternative: skip the Docker query entirely when running nested. The nested
orchestrator can determine its own IP from the network interface directly
(`os.networkInterfaces()`), which doesn't require Docker API access.

### Blocker 7: DOCKER_NETWORK required at startup

The outer orchestrator creates and manages its own bridge network. The nested
orchestrator also requires `DOCKER_NETWORK` but should reuse the session-specific
network (`SHIPIT_SESSION_NETWORK`) rather than creating a new one.

**Fix**: When `SHIPIT_SESSION_NETWORK` is set, use it as `DOCKER_NETWORK` default.
The `ensureNetwork()` call should skip creation if the network already exists (it
already handles `already exists` errors, so this works today).

## Implementation plan

### Phase 1: Proxy policy relaxation (safe for all sessions)

These changes improve security or have no downside for non-nested use:

1. **Allow safe CapAdd with CapDrop: ALL** — `docker-proxy-sanitize.ts`
2. **Allow `no-new-privileges` in SecurityOpt** — `docker-proxy-sanitize.ts`
3. **Allow workspace/credentials volumes by name** — `docker-proxy-sanitize.ts`,
   add volume allowlist to `SessionInfo`

### Phase 2: Volume context propagation

4. **Pass volume env vars to Docker-enabled sessions** — `container-lifecycle.ts`
   `buildEnv()`: add `WORKSPACE_VOLUME`, `CREDENTIALS_VOLUME`,
   `WORKSPACE_VOLUME_SUBPATH`
5. **Compute nested subpaths** — `buildMounts()`: when `WORKSPACE_VOLUME_SUBPATH` is
   set, prepend it to the subpath calculation

### Phase 3: Network and discovery

6. **Use `DOCKER_HOST` in `resolveOwnContainerIp()`** — or switch to
   `os.networkInterfaces()` when `DOCKER_HOST` is set
7. **Default `DOCKER_NETWORK` from `SHIPIT_SESSION_NETWORK`** — `session-container.ts`
   constructor
8. **Pass `DOCKER_NETWORK` to Docker-enabled sessions** — `container-lifecycle.ts`
   `buildEnv()`

### Phase 4: ShipIt repo configuration

9. **Add `shipit.yaml`** to the ShipIt repo:

```yaml
agent:
  memory: 4096
  cpu: 4.0
  pids: 2048

compose:
  docker-socket: true
```

10. **Validate end-to-end** — open ShipIt repo in ShipIt, run `npm run dev`, create a
    session in the nested instance, verify agent works.

## Nesting depth

This design supports exactly **two levels**: outer ShipIt → session → nested ShipIt →
inner session. Deeper nesting (ShipIt in ShipIt in ShipIt) would work in theory since
each level propagates volume context, but resource limits compound — a 3rd level would
have very tight limits and no practical use case. No special depth-limiting code is
needed; resource caps are the natural bound.

## Testing

- **Unit tests**: `docker-proxy-sanitize.test.ts` — new cases for safe CapAdd
  allowlist, SecurityOpt filtering, volume allowlist
- **Integration test**: create a session with `dockerAccess: true`, verify it can
  create a child container with the capabilities the orchestrator uses
- **Manual smoke test**: run ShipIt dev inside a ShipIt session, create an inner
  session, send a message to the inner agent

## Key files

| File | Change |
|------|--------|
| `src/server/orchestrator/docker-proxy-sanitize.ts` | Allow safe CapAdd, SecurityOpt allowlist |
| `src/server/orchestrator/docker-proxy-auth.ts` | Volume allowlist for workspace/credentials volumes |
| `src/server/orchestrator/docker-proxy-helpers.ts` | Add `allowedVolumes` to `SessionInfo` |
| `src/server/orchestrator/container-lifecycle.ts` | Pass volume env vars, compute nested subpaths |
| `src/server/orchestrator/session-container.ts` | Propagate `allowedVolumes` to proxy session info |
| `src/server/orchestrator/docker-proxy.ts` | Use DOCKER_HOST fallback in resolveOwnContainerIp |
| `src/server/orchestrator/app-lifecycle.ts` | Default DOCKER_NETWORK from SHIPIT_SESSION_NETWORK |
| `shipit.yaml` | New file — ShipIt's own session config |
