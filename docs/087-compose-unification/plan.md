---
status: planned
---

# Compose Unification

Replace the dedicated services container with Docker Compose as the universal execution
model for all session services. Teams with an existing docker-compose.yml annotate it
with `x-shipit` extensions — no separate shipit.yaml needed. ShipIt manages the
compose stack, presents all services (process and container) in a unified UI.

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
- **Teams keep their docker-compose.yml** — add a few `x-shipit` annotations, done.
  No separate config file to maintain.
- **Consistent networking** — all services share a compose network. Service discovery
  via DNS names works across process and container services.

## Prerequisites

- [086-improve-shipit-yaml](../086-improve-shipit-yaml/plan.md) — the shared config
  model (`ShipitConfig`, `ServiceConfig`) that both shipit.yaml and docker-compose.yml
  parsing produce.
- [061-self-hosting](../061-self-hosting/plan.md) — Docker API proxy, security policy,
  session-scoped networks and labels. Partially superseded: the proxy was designed for
  agent-initiated Docker access; this design adds orchestrator-initiated compose
  management.
- [074-preview-container-isolation](../074-preview-container-isolation/plan.md) —
  partially superseded. The dual-container topology (agent + preview) is replaced by
  agent container + compose stack.

## Design

### Config surface: `x-shipit` extensions in docker-compose.yml

Teams annotate their existing docker-compose.yml. ShipIt reads the standard compose
fields plus `x-shipit-*` extensions (ignored by `docker compose` when run locally).

**Full example:**

```yaml
x-shipit-agent:
  install:
    - npm install
    - npx prisma generate
  memory: 2048
  cpu: 1.0

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
    volumes:
      - .:/workspace

  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: dev
    ports: ["5432:5432"]
    x-shipit-preview: manual

  redis:
    image: redis:7
```

**`x-shipit-agent` (top-level extension):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `install` | string or string[] | none | Install commands, run in agent container |
| `memory` | integer | 1024 | Agent container memory in MB |
| `cpu` | float | 0.5 | Agent container CPU cores |
| `pids` | integer | 256 | Agent container max processes |

**`x-shipit-preview` (per-service extension):**

| Value | Behavior |
|-------|----------|
| `auto` | Service starts automatically, preview shown when ready. Default for services with `ports`. |
| `manual` | Service does not start until user clicks "Start" in UI. Default for services without `ports`. |

When `x-shipit-preview` is omitted, the default is inferred: services that declare
`ports` default to `auto`, services without `ports` default to `manual`.

**What ShipIt reads from standard compose fields:**

| Compose field | ShipIt uses for |
|---|---|
| `services.<name>` | Service name in UI |
| `ports` | Port detection, preview proxy routing |
| `build` / `image` | Determines if service needs image build |
| `volumes` | Rewritten to use workspace named volume (see below) |
| `depends_on` | Respected — compose handles startup ordering |
| `profiles` | Used for `preview: manual` implementation |

### How ShipIt uses the compose file

The orchestrator does **not** modify the user's docker-compose.yml. Instead, it
generates a `.shipit/compose.override.yml` that layers on top:

```yaml
# .shipit/compose.override.yml (generated, not user-edited)
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
    profiles: ["manual"]
  redis:
    labels:
      shipit-parent-session: ${SESSION_ID}
      shipit-service-name: redis
    networks:
      - shipit-session

networks:
  shipit-session:
    name: shipit-session-${SESSION_ID}
```

Compose natively merges override files. The user's file defines services; the override
adds ShipIt's labels, network, and volume rewrites. This is cleaner than generating a
single merged file — the user's file stays untouched.

**Volume rewriting:** The user's bind mounts (e.g., `.:/workspace`) are rewritten in
the override to use the workspace named volume with the correct subpath. The
orchestrator detects bind mounts that reference the workspace root and replaces them.

**Manual services via profiles:** Services with `x-shipit-preview: manual` (or
defaulting to manual) are assigned to the `manual` profile in the override. Compose
only starts profiled services when explicitly requested:
`docker compose up -d --profile manual <service-name>`.

### Architecture

```
Orchestrator
  ├── reads docker-compose.yml + x-shipit extensions
  ├── generates .shipit/compose.override.yml
  ├── runs `docker compose -f docker-compose.yml -f .shipit/compose.override.yml up -d`
  ├── monitors via `docker compose ps`, `docker logs`, Docker events API
  ├── watches workspace for config changes (shipit.yaml, docker-compose.yml)
  └── reports unified status to browser via WebSocket

Compose stack (per session)
  ├── web          (user-defined service, workspace mounted)
  ├── api          (user-defined service, workspace mounted)
  ├── db           (user-defined service, own image)
  ├── redis        (user-defined service, own image)
  └── (session network, labels)

Agent container (separate, orchestrator-managed)
  ├── Claude CLI, Terminal PTY
  └── joins session compose network for DNS resolution
```

### shipit.yaml process services in compose

When using shipit.yaml (no docker-compose.yml), the orchestrator generates a full
compose file from the service definitions. A shipit.yaml process service:

```yaml
services:
  web:
    command: npm run dev
    directory: packages/frontend
    port: 5173
```

Becomes a compose service:

```yaml
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

The ShipIt base image provides Node.js and standard dev tooling. The user's command
runs directly — no Fastify session worker wrapper.

### Compose CLI in the orchestrator

The orchestrator shells out to `docker compose` for lifecycle management. Docker
Compose CLI must be added to the orchestrator's Dockerfile (one `curl` + `tar`,
same pattern as `Dockerfile.session-worker.docker`).

The orchestrator already has everything else needed:
- **Workspace filesystem** — mounted at `/workspace` via the named volume. Can read
  `docker-compose.yml`, write `.shipit/compose.override.yml`. Relative paths in the
  user's compose file resolve correctly.
- **Docker socket** — `/var/run/docker.sock` is already mounted.
- **Volume name** — `WORKSPACE_VOLUME` env var. Needed for generating volume mounts.

Key commands:
```
docker compose -f docker-compose.yml -f .shipit/compose.override.yml up -d
docker compose ... ps --format json
docker compose ... logs -f <service>
docker compose ... up -d --profile manual <service>
docker compose ... stop <service>
docker compose ... down
```

### File watching

Two kinds of file watching serve different purposes:

**App-level watching (hot reload)** — handled by dev tools inside containers. The
workspace volume is mounted in each service container. When Claude edits a file, the
change is visible inside the container via the shared volume. Vite, webpack, nodemon,
etc. detect the change via their own `fs.watch` and hot-reload. This works the same
way teams' existing docker-compose setups work locally. ShipIt doesn't need to do
anything here.

**Platform-level watching (config changes, file tree UI)** — handled by the
orchestrator directly. The orchestrator has the workspace mounted at `/workspace`. It
watches a small set of files per session:
- `shipit.yaml` / `docker-compose.yml` → regenerate override, `docker compose up -d`
  to reconcile
- `package-lock.json`, `yarn.lock`, etc. → re-run install (debounced 30s)
- Workspace tree → notify browser for file explorer updates

This eliminates the file-watcher sidecar container. The orchestrator uses `fs.watch`
on Linux (inotify, kernel-level, cheap). One watcher per session is lightweight —
comparable to the per-session state the orchestrator already holds.

### Agent container integration

The agent container stays orchestrator-managed (not part of the compose stack). It
joins the session's compose network so Claude can reach services by DNS name:

```
docker network connect shipit-session-${SESSION_ID} ${AGENT_CONTAINER_ID}
```

The orchestrator does this after the compose stack starts. Services are then reachable
from the agent by name (e.g., `db`, `redis`, `web`).

If the compose network is recreated (config change), the orchestrator re-joins the
agent container.

### Unified service status

The orchestrator provides a single service list to the browser:

```typescript
interface ManagedService {
  name: string;
  origin: "shipit.yaml" | "docker-compose.yml";
  type: "process" | "container";
  port?: number;
  preview: "auto" | "manual";
  status: "stopped" | "starting" | "ready" | "error";
  start(): Promise<void>;   // docker compose up -d [--profile manual] <name>
  stop(): Promise<void>;    // docker compose stop <name>
  logs(): AsyncIterable<string>;  // docker compose logs -f <name>
}
```

### What this replaces

| Current component | Replaced by |
|---|---|
| Services container (Fastify session worker) | Compose stack (services run directly, no wrapper) |
| PreviewManager (process spawning, port detection) | ServiceManager (compose lifecycle, Docker events) |
| SSE event stream from services container | `docker compose logs` + Docker events API |
| HTTP commands to services container | `docker compose` CLI |
| File watcher in services container | Orchestrator-direct `fs.watch` |
| Preview proxy (per-container port routing) | Same proxy, routes to compose service container IPs |
| `capabilities.docker` for compose | Not needed — orchestrator manages compose directly |

### Config resolution order

1. **docker-compose.yml with `x-shipit-agent`** → compose mode. ShipIt reads the
   compose file, generates override, manages stack.
2. **shipit.yaml with `services`** → generate compose from shipit.yaml services.
3. **shipit.yaml with no `services`** + **docker-compose.yml without `x-shipit`** →
   ShipIt ignores the compose file (not opted in). Falls back to auto-detection.
4. **package.json with `scripts.dev`** → single `default` service.
5. **index.html** → single `default` service in html mode.
6. **Nothing** → source: `"none"`.

shipit.yaml and docker-compose.yml with `x-shipit` are mutually exclusive. If both
exist and both have ShipIt config, the parser warns and prefers docker-compose.yml.

## Open questions

### Install execution
Install commands run in the agent container (it has the workspace and is long-lived).
But install needs to happen before services start, and the agent container is created
independently of the compose stack. Timing:
- Orchestrator creates agent container → runs install in agent → then starts compose
  stack. This serializes startup. Is that acceptable?
- Alternative: run install as a one-off compose container
  (`docker compose run --rm <service> npm install`). The installed deps land in the
  workspace volume, visible to all services. But which service's image to use? The
  ShipIt base image?

### Secrets injection
Today the orchestrator injects secrets into the services container via HTTP. With
compose, options are:
- Write a `.shipit/.env` file that the override references via `env_file:`.
  Orchestrator controls the file. On disk, but in a dotdir.
- Inject secrets as `environment:` in the override file. Also on disk.
- Both are accessible to the agent container (Claude) via the workspace volume. Doc
  074 intentionally isolated secrets from the agent. Does this isolation still matter?
  If so, secrets injection needs a different mechanism for compose services.

### Security policy for compose-created containers
The orchestrator runs `docker compose up` directly against the Docker socket — not
through the proxy. Security policies (no `privileged`, bind mount validation, cap
drop) must be applied differently:
- **Policy-by-construction**: the orchestrator generates the override file and controls
  what goes in it. It can inject `cap_drop: [NET_RAW]`, restrict volumes, ensure no
  `privileged: true`.
- **User compose file validation**: before merging, the orchestrator parses the user's
  compose file and rejects dangerous options (same checks as the proxy's container
  create sanitization, but at the YAML level).
- This is defense-in-depth — the orchestrator both validates input and controls output.

### Resource management
Each service is now a separate container:
- `services.resources` in shipit.yaml sets limits per container. Each process service
  gets these limits. Compose container services may have their own
  `deploy.resources` — should ShipIt cap these?
- The total resource usage across all services is unbounded unless the host enforces
  limits. Is this acceptable for self-hosted? For managed (doc 062)?

### Non-compose fast path
For simple projects (single `npm run dev`), compose adds overhead:
- Container per service (vs child process in shared container)
- Compose CLI parsing and reconciliation
- Override file generation

Possible approach: always use compose. The overhead is small (compose is fast for
single-service stacks) and one code path is simpler than two. The current services
container with its Fastify wrapper, SSE stream, and HTTP API is arguably more overhead
than a compose service running the command directly.

## Key files

| File | Role |
|------|------|
| `src/server/orchestrator/service-manager.ts` | **New.** Compose lifecycle, status, log streaming |
| `src/server/orchestrator/compose-generator.ts` | **New.** Generates override compose file |
| `src/server/shared/shipit-config.ts` | **Modify.** Add docker-compose.yml x-shipit parsing |
| `src/server/session/preview-manager.ts` | **Delete.** Replaced by ServiceManager |
| `src/server/session/preview-config.ts` | **Delete.** Replaced by unified config (doc 086) |
| `src/server/orchestrator/container-lifecycle.ts` | **Modify.** Remove services container creation |
| `src/server/orchestrator/container-session-runner.ts` | **Modify.** Use ServiceManager |
| `src/server/orchestrator/sse-client.ts` | **Modify.** Replace services container SSE with docker logs |
| `docker/Dockerfile.dev` | **Modify.** Add docker compose CLI |
| `docker/Dockerfile.prod` | **Modify.** Add docker compose CLI |

## Implementation order

1. **Add compose CLI to orchestrator image** — Dockerfile change.
2. **x-shipit parser** — extend `shipit-config.ts` to read docker-compose.yml with
   `x-shipit` extensions, produce the same `ShipitConfig` model.
3. **Compose override generator** — generates `.shipit/compose.override.yml` from
   config.
4. **ServiceManager** — wraps compose CLI for lifecycle, status, logs.
5. **Wire up orchestrator** — replace services container creation with compose stack
   management.
6. **Orchestrator file watching** — `fs.watch` for config files and workspace tree.
7. **Agent network integration** — join agent container to compose network.
8. **Client updates** — unified service list in preview panel.
9. **Remove services container code** — delete session worker preview endpoints, SSE
   stream, HTTP client code.
