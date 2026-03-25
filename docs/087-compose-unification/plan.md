---
status: planned
---

# Compose Unification

Replace the dedicated services container with Docker Compose as the universal execution
model for all session services. Process services (from shipit.yaml) and container
services (from docker-compose.yml) become peers in a single compose stack managed by
the orchestrator.

## Motivation

Today ShipIt has two disconnected ways to run services:

1. **Process services** — the orchestrator creates a "services container" (formerly
   "preview container"), which runs a Fastify session worker that spawns preview
   commands as child processes. Managed via HTTP between orchestrator and container.

2. **Docker Compose services** — if the agent has `capabilities.docker: true`, Claude
   can run `docker compose up` in the agent container's terminal. These run as sibling
   Docker containers on the session network. ShipIt has no visibility into them — no
   status, no logs, no port detection, no preview panel integration.

This creates a split experience. A user with a React frontend + Postgres database has
their frontend managed by ShipIt and their database invisible to it. The two systems
use different lifecycle management, different networking paths, and different
configuration surfaces (shipit.yaml vs docker-compose.yml).

### What unification solves

- **Single service model** — all services (processes and containers) appear in the UI
  with consistent status, logs, and start/stop controls.
- **Eliminates the services container** — the dedicated container with its Fastify
  session worker, SSE event stream, HTTP API, and custom lifecycle management is
  replaced by compose. Less code, fewer moving parts.
- **Docker Compose becomes infrastructure** — users bring their existing
  docker-compose.yml. ShipIt reads it, augments it, and manages the stack. No need for
  Claude to manually run compose commands.
- **Consistent networking** — all services (process and container) share a compose
  network. Service discovery via DNS names works across both types.

## Prerequisites

- [086-improve-shipit-yaml](../086-improve-shipit-yaml/plan.md) — the `services` and
  `agent` config structure this design builds on.
- [061-self-hosting](../061-self-hosting/plan.md) — Docker API proxy, security policy,
  session-scoped networks and labels. Partially superseded: the proxy was designed for
  agent-initiated Docker access; this design adds orchestrator-initiated compose
  management.
- [074-preview-container-isolation](../074-preview-container-isolation/plan.md) —
  partially superseded. The dual-container topology (agent + preview) is replaced by
  agent container + compose stack. Secrets isolation model changes.

## Design

### Architecture

```
Orchestrator
  ├── reads shipit.yaml (services, agent config)
  ├── reads docker-compose.yml (container services)
  ├── generates merged compose file (.shipit/compose.yml)
  ├── runs `docker compose up -d` (has Docker socket + CLI)
  ├── monitors via `docker compose ps`, `docker logs`
  └── reports unified status to browser via WebSocket

Compose stack (per session)
  ├── web          (process service from shipit.yaml, runs in ShipIt base image)
  ├── api          (process service from shipit.yaml, runs in ShipIt base image)
  ├── db           (container service from docker-compose.yml, user-defined image)
  ├── redis        (container service from docker-compose.yml, user-defined image)
  ├── file-watcher (ShipIt sidecar, injected automatically)
  └── (session network, labels, shared workspace volume)

Agent container (separate, orchestrator-managed as today)
  ├── Claude CLI
  ├── Terminal PTY
  └── joins session compose network
```

The orchestrator is the single control plane. It generates a compose file that merges:
- Process services from shipit.yaml → compose services using the ShipIt base image
  with the user's command as entrypoint
- Container services from the user's docker-compose.yml → included as-is with ShipIt
  labels and network injected
- A file-watcher sidecar → lightweight container that watches the workspace and
  reports changes to the orchestrator

### Compose file generation

The orchestrator produces `.shipit/compose.yml` in the session workspace. This file
is the single source of truth for `docker compose` commands.

**For a shipit.yaml process service like:**
```yaml
services:
  web:
    command: npm run dev
    directory: packages/frontend
    port: 5173
```

**The orchestrator generates:**
```yaml
services:
  web:
    image: ${SHIPIT_SESSION_WORKER_IMAGE}
    command: ["sh", "-c", "npm run dev"]
    working_dir: /workspace/packages/frontend
    ports:
      - "5173"
    volumes:
      - ${WORKSPACE_VOLUME}:/workspace:subpath=sessions/${SESSION_ID}/workspace
    environment:
      HOST: "0.0.0.0"
    labels:
      shipit-parent-session: ${SESSION_ID}
      shipit-service-name: web
      shipit-service-type: process
    networks:
      - session
```

**For a user's docker-compose.yml service like:**
```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: dev
    ports:
      - "5432:5432"
```

**The orchestrator merges it in, injecting labels and network:**
```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: dev
    ports:
      - "5432"
    labels:
      shipit-parent-session: ${SESSION_ID}
      shipit-service-name: db
      shipit-service-type: container
    networks:
      - session
```

**The file-watcher sidecar is always injected:**
```yaml
services:
  shipit-file-watcher:
    image: ${SHIPIT_SESSION_WORKER_IMAGE}
    command: ["node", "/app/file-watcher-sidecar.js"]
    volumes:
      - ${WORKSPACE_VOLUME}:/workspace:subpath=sessions/${SESSION_ID}/workspace
    labels:
      shipit-parent-session: ${SESSION_ID}
      shipit-service-type: internal
    networks:
      - session
```

### Compose CLI execution

The orchestrator shells out to `docker compose` for lifecycle management. Docker
Compose CLI + plugin must be added to the orchestrator's Dockerfile (one `curl` +
`tar` command, same pattern as `Dockerfile.session-worker.docker`).

The orchestrator has everything needed:
- **Workspace filesystem** — mounted at `/workspace` via the named volume. Can read
  `docker-compose.yml`, write `.shipit/compose.yml`. Relative paths in the user's
  compose file resolve correctly.
- **Docker socket** — `/var/run/docker.sock` is already mounted. Compose CLI uses it
  directly.
- **Volume name** — `WORKSPACE_VOLUME` env var (e.g., `shipit-dev_workspace`). Needed
  for generating volume mounts in the compose file.

Key commands:
- `docker compose -f .shipit/compose.yml up -d` — start/reconcile
- `docker compose -f .shipit/compose.yml ps --format json` — status
- `docker compose -f .shipit/compose.yml logs -f <service>` — log streaming
- `docker compose -f .shipit/compose.yml stop <service>` — stop one service
- `docker compose -f .shipit/compose.yml down` — session teardown

### shipit.yaml schema

Builds on [086-improve-shipit-yaml](../086-improve-shipit-yaml/plan.md). Adds a
`compose` top-level key:

```yaml
version: 1

install:
  - npm install

agent:
  memory: 2048
  cpu: 1.0
  capabilities:
    docker: true       # only if Claude needs interactive Docker access

compose:
  file: docker-compose.yml    # optional, auto-detected
  preview: manual              # default preview mode for compose services
  services:                    # optional per-service overrides
    web-app:
      preview: auto

services:
  resources:
    memory: 1024
    cpu: 1.0
    pids: 2048

  frontend:
    command: npm run dev
    port: 5173
```

**`compose` section:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | auto-detected | Path to docker-compose.yml relative to workspace root |
| `preview` | enum | `manual` | Default preview mode for all compose services |
| `services` | map | `{}` | Per-service overrides, keyed by compose service name |
| `services.<name>.preview` | enum | inherits from `compose.preview` | Override preview mode for this compose service |

Auto-detection: if no `compose` key is present but `docker-compose.yml` or
`compose.yml` exists in the workspace root, ShipIt treats it as
`compose: { preview: manual }`. This can be disabled with `compose: false`.

**`agent.capabilities.docker`** remains independent of `compose`. The `compose` block
tells ShipIt to manage a compose stack for preview infrastructure. The capability tells
ShipIt to give the agent container Docker CLI access so Claude can run arbitrary Docker
commands. A project can use one, both, or neither.

### Service lifecycle

**Startup flow:**
1. Orchestrator reads shipit.yaml + docker-compose.yml
2. Runs install steps (as `docker compose run --rm` one-off commands)
3. Generates `.shipit/compose.yml`
4. Runs `docker compose up -d` — starts all `preview: auto` services
5. Monitors ports for readiness (polls or stdout detection)
6. Reports status to browser

**`preview: manual` services:**
Excluded from the initial `docker compose up`. When the user clicks "Start" in the UI,
the orchestrator runs `docker compose up -d <service-name>` for that specific service.

**Config change detection:**
File watcher sidecar detects changes to `shipit.yaml` or `docker-compose.yml` and
notifies the orchestrator. The orchestrator regenerates `.shipit/compose.yml` and runs
`docker compose up -d` which reconciles the stack (idempotent — only changed services
restart).

**Session teardown:**
`docker compose -f .shipit/compose.yml down` removes all containers, networks, and
volumes created by the stack. Session-label-based cleanup (from doc 061) handles any
orphans.

### Agent container integration

The agent container stays orchestrator-managed (not part of the compose stack). It
needs to communicate with compose services (e.g., Claude connecting to a database to
debug queries). The agent container joins the session's compose network:

```
docker network connect <session-compose-network> <agent-container-id>
```

The orchestrator does this after the compose stack starts. Compose services are then
reachable from the agent container by DNS name (e.g., `db`, `redis`, `web`).

### Unified service status

The orchestrator provides a single service list to the browser combining both types:

```typescript
interface ManagedService {
  name: string;
  origin: "shipit.yaml" | "docker-compose.yml";
  type: "process" | "container" | "internal";
  port?: number;
  preview: "auto" | "manual";
  status: "stopped" | "starting" | "ready" | "error";
  start(): Promise<void>;   // docker compose up -d <name>
  stop(): Promise<void>;    // docker compose stop <name>
  logs(): AsyncIterable<string>;  // docker compose logs -f <name>
}
```

Internal services (file-watcher sidecar) are hidden from the UI.

### What this replaces

| Current component | Replaced by |
|---|---|
| Services container (Fastify session worker) | Compose stack (process services run in base image, no Fastify wrapper) |
| PreviewManager (process spawning, port detection) | ServiceManager (compose lifecycle, Docker API status) |
| SSE event stream from services container | `docker compose logs` + Docker events API |
| HTTP commands to services container (`/preview/start`, etc.) | `docker compose up/stop` CLI |
| Custom file watcher protocol | File-watcher sidecar in compose stack |
| Preview proxy (per-container port routing) | Same proxy, but routes to compose service IPs |

## Open questions

### File watching
The file watcher currently runs inside the services container as part of the session
worker. With the services container gone, it needs a new home. The design above
proposes a lightweight sidecar container in the compose stack. But:
- How does the sidecar communicate file changes to the orchestrator? HTTP callback?
  Shared volume with an event file? The orchestrator would need an endpoint or polling
  mechanism.
- Is a whole container justified for file watching? Could the agent container run the
  watcher instead (it has the workspace)?
- Could the orchestrator watch files directly? It has the workspace mounted. The
  concern is scale — one `fs.watch` tree per session, all in the orchestrator process.

### Install execution
Install commands need the workspace and must complete before services start. Options:
- `docker compose run --rm install-step sh -c "npm install"` — one-off container with
  workspace mounted. Clean, but adds container creation overhead per install step.
- Run install as part of a service container's entrypoint (install then start). But
  this couples install to a specific service and doesn't work for multi-service setups
  where all services need the installed deps.
- Run install in the orchestrator process directly (it has the workspace). Simplest,
  but the orchestrator shouldn't be running user commands — it's a control plane, not
  an execution environment.

### Secrets injection
Today the orchestrator injects secrets into the services container via `PUT /secrets`
HTTP endpoint. The session worker holds them in memory and injects them as env vars
into spawned preview processes. With compose:
- Secrets must be in the generated compose file as `environment:` entries. This puts
  secrets on disk (in `.shipit/compose.yml`). Is that acceptable? The file is in the
  workspace volume, accessible to the agent container (Claude).
- Alternative: use Docker secrets or `env_file:` pointing to a file the orchestrator
  writes and controls. But compose `secrets:` has limitations (file-based, not env
  var injection for all images).
- Alternative: write a `.shipit/.env` file that the compose file references via
  `env_file:`. Orchestrator controls the file, can update it and restart services.
  Still on disk, but a single file to secure.
- Which compose services should receive secrets? All process services (from
  shipit.yaml)? Only explicitly opted-in services? Doc 074's position was that
  user-defined compose services do NOT get secrets by default.

### Security policy for compose-created containers
The orchestrator runs `docker compose up` directly against the Docker socket — not
through the proxy. This means the proxy's security policies (no `--privileged`, bind
mount validation, capability dropping, label injection) are not automatically applied.
Options:
- Point compose at the proxy instead of the socket. But the proxy identifies sessions
  by source IP (container bridge IP), and the orchestrator isn't a session container.
  Would need a bypass or separate auth mechanism.
- Apply policies in the compose file itself — the orchestrator generates the file, so
  it controls what's in it. It can ensure no `privileged: true`, inject `cap_drop:
  [NET_RAW]`, restrict volumes. This is policy-by-construction rather than
  policy-by-enforcement.
- For user-provided docker-compose.yml, the orchestrator parses and validates the file
  before merging, rejecting dangerous options. Same validation as the proxy's container
  create sanitization, but at the compose file level.

### Resource management
The current services container has a single resource limit (memory, cpu, pids) shared
by all preview processes. With compose, each service is a separate container:
- Do process services (from shipit.yaml) each get their own resource limits? Or share
  a combined limit?
- `services.resources` in shipit.yaml sets a pool. How is this divided across compose
  services? Equal split? Weighted? Let compose handle it (no limits on individual
  services, rely on the host)?
- User-defined compose services may specify their own `deploy.resources`. Should ShipIt
  cap these at the session limit?

### Non-compose fast path
For simple projects (single `npm run dev`, no docker-compose.yml), using compose adds:
- Compose CLI parsing and stack reconciliation
- A container per service (vs child process in shared container)
- File-watcher sidecar container
- More orchestrator complexity

Is this overhead acceptable for all cases? Or should ShipIt keep the current
direct-container path for simple single-service projects and only use compose when
docker-compose.yml exists or multiple services are defined?

### Compose profiles for manual services
`preview: manual` services should not start with `docker compose up`. Compose profiles
are the native mechanism for this — services assigned to a profile only start when that
profile is explicitly activated. But profiles have ergonomic issues (must be specified
on every `up` command). Alternative: generate manual services into a separate compose
file and only invoke it on demand.

### Agent container lifecycle
The agent container stays outside the compose stack. But:
- It needs to join the compose network for DNS resolution. When does this happen?
  After every `docker compose up` (network may be recreated)?
- If compose recreates the network on config change, the agent loses connectivity
  until re-joined.
- Should the agent container move into the compose stack too? This would unify
  lifecycle but means compose manages Claude CLI, which has different lifecycle
  requirements (long-running, stateful).

## Key files

| File | Role |
|------|------|
| `src/server/orchestrator/service-manager.ts` | **New.** Compose lifecycle, status, log streaming |
| `src/server/orchestrator/compose-generator.ts` | **New.** Generates merged compose file |
| `src/server/session/preview-manager.ts` | **Delete.** Replaced by ServiceManager |
| `src/server/session/preview-config.ts` | **Delete.** Replaced by unified config (doc 086) |
| `src/server/orchestrator/container-lifecycle.ts` | **Modify.** Remove services container creation |
| `src/server/orchestrator/container-session-runner.ts` | **Modify.** Use ServiceManager instead of HTTP to services container |
| `src/server/orchestrator/sse-client.ts` | **Modify.** Replace services container SSE with docker logs |
| `docker/Dockerfile.dev` | **Modify.** Add docker compose CLI |
| `docker/Dockerfile.prod` | **Modify.** Add docker compose CLI |

## Implementation order

1. **Add compose CLI to orchestrator image** — Dockerfile change.
2. **Compose generator** — reads shipit.yaml + docker-compose.yml, produces merged
   compose file.
3. **ServiceManager** — wraps compose CLI for lifecycle, status, logs. Replaces
   PreviewManager.
4. **Wire up orchestrator** — replace services container creation with compose stack
   management. Update container-session-runner.
5. **File watcher migration** — move file watching to sidecar or orchestrator.
6. **Install via compose** — run install steps as one-off compose containers.
7. **Agent network integration** — join agent container to compose network.
8. **Client updates** — unified service list in preview panel.
9. **Remove services container code** — delete session worker preview endpoints, SSE
   stream, HTTP client code.
