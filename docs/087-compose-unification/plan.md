---
status: planned
---

# Compose Unification

Replace the dedicated services container with Docker Compose as the universal execution
model for all session services. shipit.yaml is always the entry point — it references
the compose file and configures the agent. The compose file stays standard, with only
`x-shipit-preview` annotations per service.

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
configuration surfaces.

### What unification solves

- **Single service model** — all services (processes and containers) appear in the UI
  with consistent status, logs, and start/stop controls.
- **Eliminates the services container** — the dedicated container with its Fastify
  session worker, SSE event stream, HTTP API, and custom lifecycle management is
  replaced by compose. Less code, fewer moving parts.
- **Teams keep their docker-compose.yml** — add `x-shipit-preview` annotations where
  needed, point shipit.yaml at the file, done.
- **Consistent networking** — all services share a compose network. Service discovery
  via DNS names works across all services.

## Prerequisites

- [086-improve-shipit-yaml](../086-improve-shipit-yaml/plan.md) — the shared config
  model (`ShipitConfig`, `ServiceConfig`) and the `compose` field in shipit.yaml.
- [061-self-hosting](../061-self-hosting/plan.md) — Docker API proxy, security policy,
  session-scoped networks and labels. Partially superseded: the proxy was designed for
  agent-initiated Docker access; this design adds orchestrator-initiated compose
  management.
- [074-preview-container-isolation](../074-preview-container-isolation/plan.md) —
  partially superseded. The dual-container topology (agent + preview) is replaced by
  agent container + compose stack.

## Design

### Config surface

shipit.yaml is always the entry point. It contains agent config, install steps, and
a reference to the compose file:

```yaml
# shipit.yaml
install: npm install

agent:
  memory: 2048

compose: docker-compose.yml
```

The compose file is standard docker-compose.yml. The only ShipIt-specific annotation
is `x-shipit-preview` per service:

```yaml
# docker-compose.yml
services:
  web:
    build: .
    command: npm run dev
    ports: ["5173:5173"]
    volumes:
      - .:/workspace
    x-shipit-preview: auto

  api:
    build: ./api
    command: npm run server
    ports: ["3000:3000"]

  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: dev
    ports: ["5432:5432"]
    x-shipit-preview: manual

  redis:
    image: redis:7
```

**Why shipit.yaml is always the entry point:**
- You need to know which compose file to read before you can read it
- Monorepos may have multiple compose files (`compose/dev.yml`, `packages/api/docker-compose.yml`)
- Agent config (memory, install) is a ShipIt concern, not a compose concern
- Keeps the compose file portable — it works with `docker compose up` locally with
  zero ShipIt dependencies

**`x-shipit-preview` per service:**

| Value | Behavior |
|-------|----------|
| `auto` | Service starts automatically, preview shown when ready. Default for services with `ports`. |
| `manual` | Service does not start until user clicks "Start" in UI. Default for services without `ports`. |

When omitted, services with `ports` default to `auto`, services without `ports`
default to `manual`.

**What ShipIt reads from standard compose fields:**

| Compose field | ShipIt uses for |
|---|---|
| `services.<name>` | Service name in UI |
| `ports` | Port detection, preview proxy routing, default preview mode |
| `build` / `image` | Determines if service needs image build |
| `depends_on` | Respected — compose handles startup ordering |

### Architecture

```
Orchestrator
  ├── reads shipit.yaml (agent, install, compose path)
  ├── reads docker-compose.yml (service definitions, x-shipit-preview)
  ├── generates .shipit/compose.override.yml (labels, network, volume rewrites)
  ├── runs `docker compose` CLI (has Docker socket)
  ├── watches workspace for config changes via fs.watch
  └── reports unified status to browser via WebSocket

Compose stack (per session)
  ├── web          (user-defined service)
  ├── api          (user-defined service)
  ├── db           (user-defined service)
  ├── redis        (user-defined service)
  └── (session network, labels, shared workspace volume)

Agent container (separate, orchestrator-managed)
  ├── Claude CLI, Terminal PTY
  └── joins session compose network for DNS resolution
```

### Compose override generation

The orchestrator does **not** modify the user's docker-compose.yml. It generates
`.shipit/compose.override.yml` that layers on top:

```yaml
# .shipit/compose.override.yml (generated)
services:
  web:
    labels:
      shipit-parent-session: ${SESSION_ID}
      shipit-service-name: web
    networks:
      - shipit-session
    volumes:
      - ${WORKSPACE_VOLUME}:/workspace:subpath=sessions/${SESSION_ID}/workspace
  db:
    labels:
      shipit-parent-session: ${SESSION_ID}
      shipit-service-name: db
    networks:
      - shipit-session
    profiles: ["shipit-manual"]

networks:
  shipit-session:
    name: shipit-session-${SESSION_ID}
```

Compose natively merges override files. The user's file defines services; the override
adds ShipIt's labels, network, and volume rewrites.

**Volume rewriting:** Bind mounts in the user's compose file (e.g., `.:/workspace`)
are rewritten in the override to use the workspace named volume with the correct
subpath. The orchestrator detects bind mounts referencing the workspace root and
replaces them.

**Manual services via profiles:** Services with `x-shipit-preview: manual` are
assigned to the `shipit-manual` profile in the override. Compose only starts profiled
services when explicitly requested. To start a manual service:
`docker compose ... up -d --profile shipit-manual <service-name>`.

### shipit.yaml process services in compose

When shipit.yaml uses `services` (no compose file), the orchestrator generates a full
compose file from the service definitions:

```yaml
# shipit.yaml
services:
  web:
    command: npm run dev
    directory: packages/frontend
    port: 5173
```

Becomes:

```yaml
# .shipit/compose.yml (generated)
services:
  web:
    image: ${SHIPIT_BASE_IMAGE}
    command: ["sh", "-c", "npm run dev"]
    working_dir: /workspace/packages/frontend
    ports: ["5173"]
    volumes:
      - ${WORKSPACE_VOLUME}:/workspace:subpath=sessions/${SESSION_ID}/workspace
    environment:
      HOST: "0.0.0.0"
    labels:
      shipit-parent-session: ${SESSION_ID}
      shipit-service-name: web
    networks:
      - shipit-session
```

Same execution model either way — everything runs as compose.

### Compose CLI in the orchestrator

Docker Compose CLI must be added to the orchestrator's Dockerfile (one `curl` + `tar`,
same pattern as `Dockerfile.session-worker.docker`).

The orchestrator already has everything else needed:
- **Workspace filesystem** — mounted at `/workspace` via the named volume. Can read
  docker-compose.yml, write `.shipit/compose.override.yml`. Relative paths in the
  user's compose file resolve correctly.
- **Docker socket** — `/var/run/docker.sock` is already mounted.
- **Volume name** — `WORKSPACE_VOLUME` env var. Needed for volume rewrites.

Key commands:
```
# With user's compose file:
docker compose -f docker-compose.yml -f .shipit/compose.override.yml up -d
docker compose ... ps --format json
docker compose ... logs -f <service>
docker compose ... up -d --profile shipit-manual <service>
docker compose ... stop <service>
docker compose ... down

# With generated compose (shipit.yaml services):
docker compose -f .shipit/compose.yml up -d
```

### File watching

Two kinds of file watching serve different purposes:

**App-level watching (hot reload)** — handled by dev tools inside containers. The
workspace volume is mounted in each service container. When Claude edits a file, the
change is visible inside the container via the shared volume. Vite, webpack, nodemon,
etc. detect the change and hot-reload. This works the same way teams' existing
docker-compose setups work locally. ShipIt doesn't need to do anything.

**Platform-level watching (config changes, file tree UI)** — handled by the
orchestrator directly. The orchestrator has the workspace mounted at `/workspace`. It
watches a small set of files per session:
- `shipit.yaml` / `docker-compose.yml` → regenerate override, `docker compose up -d`
  to reconcile
- `package-lock.json`, `yarn.lock`, etc. → re-run install (debounced 30s)
- Workspace tree → notify browser for file explorer updates

No file-watcher sidecar needed. The orchestrator uses `fs.watch` on Linux (inotify,
kernel-level, cheap). One watcher per session is lightweight.

### Agent container integration

The agent container stays orchestrator-managed (not part of the compose stack). It
joins the session's compose network so Claude can reach services by DNS name:

```
docker network connect shipit-session-${SESSION_ID} ${AGENT_CONTAINER_ID}
```

The orchestrator does this after the compose stack starts. Services are reachable from
the agent by name (e.g., `db`, `redis`, `web`).

If the compose network is recreated (config change), the orchestrator re-joins the
agent container.

### Unified service status

The orchestrator provides a single service list to the browser:

```typescript
interface ManagedService {
  name: string;
  origin: "shipit.yaml" | "docker-compose.yml";
  port?: number;
  preview: "auto" | "manual";
  status: "stopped" | "starting" | "ready" | "error";
  start(): Promise<void>;
  stop(): Promise<void>;
  logs(): AsyncIterable<string>;
}
```

### `capabilities.docker` and compose

With compose, the orchestrator manages the compose stack directly via its Docker
socket. The agent container does **not** need Docker access for this — compose services
are created by the orchestrator, not by Claude.

`capabilities.docker` (from doc 061) remains available as a separate, independent
concern for the rare case where Claude needs to run ad-hoc Docker commands (build
images, debug containers, etc.). Most projects that use compose will not need it.

### What this replaces

| Current component | Replaced by |
|---|---|
| Services container (Fastify session worker) | Compose stack (services run directly, no wrapper) |
| PreviewManager (process spawning, port detection) | ServiceManager (compose lifecycle, Docker events) |
| SSE event stream from services container | `docker compose logs` + Docker events API |
| HTTP commands to services container | `docker compose` CLI |
| File watcher in services container | Orchestrator-direct `fs.watch` |
| Preview proxy (per-container port routing) | Same proxy, routes to compose service container IPs |

### Config resolution order

1. **shipit.yaml with `compose`** → compose mode. Read the referenced compose file,
   generate override, manage stack.
2. **shipit.yaml with `services`** → generate compose from shipit.yaml services.
3. **shipit.yaml with neither** → fall through to auto-detection.
4. **No shipit.yaml** → auto-detection:
   a. `package.json` with `scripts.dev` → single `default` service
   b. `index.html` → single `default` service in html mode
   c. Nothing → source: `"none"`

## Open questions

### Install execution
Install commands run in the agent container (it has the workspace and is long-lived).
Install needs to happen before services start:
- Orchestrator creates agent container → runs install → starts compose stack.
  This serializes startup. Acceptable?
- Alternative: run install as a one-off compose container
  (`docker compose run --rm <service> npm install`). Deps land in the workspace
  volume. But which image to use?

### Secrets injection
Today the orchestrator injects secrets into the services container via HTTP. With
compose:
- Write a `.shipit/.env` file that the override references via `env_file:`.
  Orchestrator controls the file. On disk, but in a dotdir.
- Inject secrets as `environment:` in the override file. Also on disk.
- Both are accessible to the agent container (Claude) via the workspace volume. Doc
  074 intentionally isolated secrets from the agent. Does this isolation still matter?

### Security policy for compose-created containers
The orchestrator runs `docker compose up` directly against the Docker socket, not
through the proxy:
- **Policy-by-construction**: the orchestrator generates the override and controls
  what goes in it. Inject `cap_drop: [NET_RAW]`, restrict volumes, no `privileged`.
- **User compose file validation**: parse and reject dangerous options before merging.
- Defense-in-depth: validate input and control output.

### Resource management
Each service is now a separate container:
- `services.resources` in shipit.yaml sets limits per container for process services.
- User-defined compose services may have their own `deploy.resources`. Should ShipIt
  cap these?
- Total resource usage across all services is unbounded unless the host enforces
  limits. Acceptable for self-hosted? For managed (doc 062)?

### Non-compose fast path
For simple projects (single `npm run dev`), compose adds container creation and CLI
parsing overhead. But the current services container with its Fastify wrapper, SSE
stream, and HTTP API is arguably heavier. One code path (always compose) is simpler
than maintaining two. Is the tradeoff worth it?

## Key files

| File | Role |
|------|------|
| `src/server/orchestrator/service-manager.ts` | **New.** Compose lifecycle, status, log streaming |
| `src/server/orchestrator/compose-generator.ts` | **New.** Generates override compose file |
| `src/server/shared/shipit-config.ts` | **Modify.** Parse compose file x-shipit-preview |
| `src/server/session/preview-manager.ts` | **Delete.** Replaced by ServiceManager |
| `src/server/session/preview-config.ts` | **Delete.** Replaced by unified config (doc 086) |
| `src/server/orchestrator/container-lifecycle.ts` | **Modify.** Remove services container creation |
| `src/server/orchestrator/container-session-runner.ts` | **Modify.** Use ServiceManager |
| `src/server/orchestrator/sse-client.ts` | **Modify.** Replace services container SSE with docker logs |
| `docker/Dockerfile.dev` | **Modify.** Add docker compose CLI |
| `docker/Dockerfile.prod` | **Modify.** Add docker compose CLI |

## Implementation order

1. **Add compose CLI to orchestrator image** — Dockerfile change.
2. **Compose file parser** — extend `shipit-config.ts` to read compose file and
   `x-shipit-preview` annotations, produce `ServiceConfig[]`.
3. **Compose override generator** — generates `.shipit/compose.override.yml`.
4. **ServiceManager** — wraps compose CLI for lifecycle, status, logs.
5. **Wire up orchestrator** — replace services container creation with compose stack
   management.
6. **Orchestrator file watching** — `fs.watch` for config files and workspace tree.
7. **Agent network integration** — join agent container to compose network.
8. **Client updates** — unified service list in preview panel.
9. **Remove services container code** — delete session worker preview endpoints, SSE
   stream, HTTP client code.
