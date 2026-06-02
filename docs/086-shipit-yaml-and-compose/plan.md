
# shipit.yaml and Compose Unification

Redesign shipit.yaml as a minimal entry point (agent config + compose file path) and
replace the dedicated services container with Docker Compose as the universal execution
model for all session services.

## Motivation

### shipit.yaml problems

The current shipit.yaml has grown organically and has several problems:

1. **Single preview only** — monorepos need shell `&` hacks to run multiple processes.
   There's no way to name, independently control, or selectively expose services.
2. **Split parsing** — `preview-config.ts` and `session-config.ts` parse the same file
   independently with inconsistent error handling (one throws, one silently defaults).
3. **Flat resources bug** — the project's own `shipit.yaml` uses `resources.memory`
   (flat), but the parser expects `resources.agent.memory` (nested). The flat form is
   silently ignored.
4. **Unknown fields silently ignored** — typos like `commmand` or `port` (vs `ports`)
   are never caught.
5. **`preview` required** — configs that only need `resources` or `capabilities` must
   still include a `preview` section or the parser throws.
6. **`install` is a flat string** — no way to express multi-step installs.
7. **Reinvents service definitions** — the `preview` block is a stripped-down,
   less-capable version of what docker-compose.yml already does. Adding features
   (env vars, volumes, health checks, dependencies) means reimplementing compose.

### Two disconnected execution models

Today ShipIt has two disconnected ways to run services:

1. **Process services** — the orchestrator creates a "services container" (formerly
   "preview container"), which runs a Fastify session worker that spawns preview
   commands as child processes. Managed via HTTP between orchestrator and container.

2. **Docker Compose services** — if the agent has `capabilities.docker: true`, Claude
   can run `docker compose up` in the agent container's terminal. These run as sibling
   Docker containers on the session network. ShipIt has no visibility into them — no
   status, no logs, no port detection, no preview panel integration.

### What this solves

- **Single execution model** — everything runs as compose. One code path, one
  lifecycle, one monitoring approach.
- **No custom service DSL** — services are defined in docker-compose.yml, a standard
  teams already know and can use locally.
- **Eliminates the services container** — the dedicated container with its Fastify
  session worker, SSE event stream, HTTP API, and custom lifecycle management is gone.
- **Unified UI** — all services appear with consistent status, logs, and start/stop.
- **Agent-generated config** — the agent creates compose files tailored to each
  project, replacing fragile auto-detection heuristics.

## Related docs

- [061-self-hosting](../061-self-hosting/plan.md) — **partially superseded.** Docker
  API proxy and security policy remain useful for compose container sanitization.
  `capabilities.docker` is replaced by `compose.docker-socket` (scoped to compose
  services, not the agent). Update that doc to cross-reference this one.
- [074-preview-container-isolation](../074-preview-container-isolation/plan.md) —
  **superseded.** The dual-container topology (agent + preview) is replaced by agent
  container + compose stack. Secrets isolation model changes (see open questions).
  Update that doc to cross-reference this one.
- [089-shipit-in-shipit](../089-shipit-in-shipit/plan.md) — uses
  `compose.docker-socket` as the mechanism for granting Docker access to the nested
  orchestrator. Requires proxy policy relaxations beyond what this doc covers.

## Design

### shipit.yaml schema

```yaml
version: 1                      # Optional. Schema version for future-proofing.

agent:
  memory: 2048                   # Memory in MB (default: 1536, max: 4096)
  cpu: 1.0                       # CPU cores (default: 0.5, max: 4)
  pids: 4096                     # Max processes (default: 4096, max: 4096)
  install:                       # Dependency installation commands
    - npm install
    - npx prisma generate

compose: docker-compose.yml      # String form: path to compose file

# Or object form with flags:
compose:
  file: docker-compose.yml
  docker-socket: true            # Grant Docker socket access to compose services
```

Three top-level keys: `version`, `agent`, `compose`.

### Examples

**Typical project:**
```yaml
agent:
  install: npm install

compose: docker-compose.yml
```

**Monorepo with heavy agent needs:**
```yaml
agent:
  memory: 3072
  cpu: 2.0
  install:
    - npm install
    - npx prisma generate
    - npm run codegen

compose: docker-compose.yml
```

**Minimal (agent defaults, compose auto-detected):**
```yaml
compose: docker-compose.yml
```

**ShipIt-in-ShipIt (compose services need Docker socket):**
```yaml
agent:
  memory: 3072
  cpu: 2.0
  pids: 2048
  install: npm ci

compose:
  file: docker/local/dev/compose.yml
  docker-socket: true
```

### Sections

#### `version` (optional, integer)

```yaml
version: 1
```

Optional. When present, the parser validates against that version's schema. When
absent, the parser assumes the latest version. Forward-looking insurance for after the
project goes public.

#### `agent` (optional)

Configures the agent container (runs Claude CLI).

```yaml
agent:
  memory: 2048
  cpu: 1.0
  pids: 512
  install:
    - npm install
    - npx prisma generate
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory` | integer | 1024 | Memory limit in MB |
| `cpu` | float | 0.5 | CPU cores |
| `pids` | integer | 256 | Max processes |
| `install` | string or string[] | none | Install commands, run sequentially in agent |

Resource values are capped at deployment-level maximums from env vars
(`MAX_SESSION_MEMORY_MB`, etc.). Invalid or negative values fall back to defaults.

**Install behavior:**
- Steps run sequentially in the agent container before the compose stack starts.
- If any step fails, subsequent steps are skipped and the error is reported.
- The `.shipit/.install-done` marker is only written after all steps succeed.
- On resume, install is skipped (marker exists). Editing shipit.yaml clears the marker.
- When `install` is a string, it's normalized to a single-element list internally.

#### `compose` (optional, string or object)

Path to a Docker Compose file, relative to workspace root. Accepts a string (just the
path) or an object (path + flags):

```yaml
# String form (most projects)
compose: docker-compose.yml

# Object form (when flags are needed)
compose:
  file: docker-compose.yml
  docker-socket: true
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | required | Path to compose file (relative to workspace root) |
| `docker-socket` | boolean | false | Grant Docker socket access to compose services |

**`docker-socket`:** When true, the orchestrator does not strip Docker socket mounts
(`/var/run/docker.sock`) from the user's compose file. Required for projects whose
compose services need to create/manage Docker containers at runtime — the canonical
example is ShipIt running inside ShipIt, where the inner orchestrator (a compose
service) creates inner session containers dynamically. Other security policies (no
`--privileged`, label injection, capability dropping) still apply.

### No `services` block

shipit.yaml does **not** have a service definition format. Services are defined in
docker-compose.yml — a standard, portable, well-documented format that supports env
vars, volumes, health checks, dependencies, build contexts, and everything else
projects need. Reimplementing a subset of this in shipit.yaml adds maintenance burden
and limits capability.

For projects without a docker-compose.yml (new projects, simple setups), the preview
panel shows an onboarding UI. The user clicks "Generate" and the agent analyzes the
project and creates both docker-compose.yml and shipit.yaml.

### Config resolution

1. **shipit.yaml with `compose`** → read the referenced compose file, manage stack.
2. **shipit.yaml without `compose`** → check for docker-compose.yml / compose.yml at
   workspace root. If found, use it (as if `compose: docker-compose.yml` was set).
3. **No shipit.yaml** → same auto-detection as (2).
4. **No compose file found** → show onboarding UI in preview panel.

### Unified parser

**New:** `src/server/shared/shipit-config.ts`

```typescript
interface ShipitConfig {
  version?: number;
  agent?: AgentConfig;                  // optional, all fields have defaults
  compose?: ComposeConfig;              // optional, auto-detected if absent
}

interface AgentConfig {
  memory?: number;                      // default: 1536
  cpu?: number;                         // default: 0.5
  pids?: number;                        // default: 4096
  install?: string[];                   // default: [] (no install steps)
}

interface ComposeConfig {
  file: string;                         // path to compose file
  dockerSocket?: boolean;               // default: false
}
```

Service definitions come from parsing the compose file separately. The shipit.yaml
parser only handles agent config and the compose file path.

**Parsing behavior:**
- Unknown top-level keys → warning
- Unknown keys inside `agent` → warning
- Old-format keys (`preview`, `resources`, `capabilities`, `services`) → warning with
  migration hint (e.g., "The `preview` block has been removed. Define services in
  docker-compose.yml instead. See /shipit-docs/shipit-yaml.md.")
- Type mismatches → `ShipitConfigError` with clear message and field path
- All sections optional — an empty `shipit.yaml` is valid (everything defaults)

Warnings are logged server-side and surfaced as a banner in the preview panel so the
user sees them without blocking startup.

### What's gone

| Removed | Replacement |
|---------|-------------|
| `preview` block | docker-compose.yml services |
| `services` block | docker-compose.yml services |
| `resources.preview` / `resources.services` | compose resource limits per service |
| `capabilities.docker` | `compose.docker-socket` — scoped to compose services, not the agent |
| `preview.command`, `preview.html`, `preview.ports` | Compose `command`, `ports` fields |
| `preview.directory` | Compose `working_dir` field |
| Auto-detection heuristics (Vite, package manager) | Agent generates compose file |

## Compose architecture

### docker-compose.yml (service definitions)

```yaml
services:
  web:
    image: node:20
    command: npm run dev
    working_dir: /workspace
    ports: ["5173:5173"]
    volumes:
      - .:/workspace
    x-shipit-preview: auto

  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: dev
    ports: ["5432:5432"]
    x-shipit-preview: manual

  redis:
    image: redis:7
```

**No custom ShipIt images for services.** Services use standard images (`node:20`,
`python:3.12`, `postgres:16`, etc.). The agent picks the right image for the project.

**`x-shipit-preview` per service:**

| Value | Behavior |
|-------|----------|
| `auto` | Service starts automatically, preview shown when ready. Default for services with `ports`. |
| `manual` | Service does not start until user clicks "Start" in UI. Default for services without `ports`. |

When omitted, services with `ports` default to `auto`, services without default to
`manual`. The `x-` prefix means `docker compose` ignores it locally. If a service has
user-defined `profiles` in the compose file, ShipIt preserves them and adds the
`shipit-manual` profile alongside (it doesn't replace the user's profiles).

### Architecture overview

```
Orchestrator
  ├── reads shipit.yaml (agent config, compose path)
  ├── reads docker-compose.yml (service definitions, x-shipit-preview)
  ├── generates .shipit/compose.override.yml (labels, network, volume rewrites)
  ├── runs `docker compose` CLI (has Docker socket + workspace mounted)
  ├── watches workspace for config changes via fs.watch
  └── reports unified status to browser via WebSocket

Compose stack (per session)
  ├── web          (node:20 running npm run dev)
  ├── db           (postgres:16)
  ├── redis        (redis:7)
  └── (session network, labels, shared workspace volume)

Agent container (separate, orchestrator-managed)
  ├── Claude CLI, Terminal PTY
  └── joins session compose network for DNS resolution
```

### Compose override generation

The orchestrator does **not** modify the user's docker-compose.yml. It generates
`.shipit/compose.override.yml` that layers on top:

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
    profiles: ["shipit-manual"]
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
adds ShipIt's labels, network, and volume rewrites.

**Volume rewriting:** Bind mounts in the user's compose file are rewritten in the
override to use the workspace named volume with the correct subpath. The orchestrator
rewrites any bind mount whose source is `.` or `./` (the workspace root). Subdirectory
mounts (e.g., `./src:/code`) are rewritten to use the corresponding subpath within
the workspace volume. Mounts with absolute source paths or paths outside the workspace
(e.g., `../`) are rejected with a validation error.

**Manual services via profiles:** Services with `x-shipit-preview: manual` (or
defaulting to manual) are assigned to the `shipit-manual` profile in the override.
Compose only starts profiled services when explicitly requested.

### Compose CLI in the orchestrator

Docker Compose CLI must be added to the orchestrator's Dockerfile (one `curl` + `tar`,
same pattern as `Dockerfile.session-worker.docker`).

The orchestrator already has:
- **Workspace filesystem** — mounted at `/workspace` via the named volume. Can read
  docker-compose.yml, write override. Relative paths resolve correctly.
- **Docker socket** — `/var/run/docker.sock`.
- **Volume name** — `WORKSPACE_VOLUME` env var for volume rewrites.

Key commands:
```
docker compose -f docker-compose.yml -f .shipit/compose.override.yml up -d
docker compose ... ps --format json
docker compose ... logs -f <service>
docker compose ... up -d --profile shipit-manual <service>
docker compose ... stop <service>
docker compose ... down
```

### File watching

**App-level watching (hot reload)** — handled by dev tools inside containers. The
workspace volume is mounted in service containers. When Claude edits a file, the change
is visible via the shared volume. Vite, webpack, nodemon detect changes and hot-reload.
ShipIt doesn't need to do anything.

**Platform-level watching (config changes, file tree UI)** — handled by the
orchestrator directly. It has the workspace mounted at `/workspace` and watches:
- `shipit.yaml` / `docker-compose.yml` → regenerate override, `docker compose up -d`
- `package-lock.json`, `yarn.lock`, etc. → re-run install (debounced 30s)
- Workspace tree → notify browser for file explorer updates

No sidecar container needed. `fs.watch` on Linux uses inotify — kernel-level, cheap.
Today this watching runs in the services container's session worker — it moves to the
orchestrator since the services container is being eliminated.

### Agent container integration

The agent container stays orchestrator-managed (not in the compose stack). It joins the
session's compose network:

```
docker network connect shipit-session-${SESSION_ID} ${AGENT_CONTAINER_ID}
```

Services are reachable from the agent by DNS name (`db`, `redis`, `web`). If the
network is recreated on config change, the orchestrator re-joins the agent.

### Unified service status

```typescript
interface ManagedService {
  name: string;
  port?: number;
  preview: "auto" | "manual";
  status: "stopped" | "starting" | "ready" | "error";
  start(): Promise<void>;
  stop(): Promise<void>;
  logs(): AsyncIterable<string>;
}
```

`logs()` streams output from `docker compose logs -f <service>`, including startup
errors. Multiple consumers (browser tabs) can attach simultaneously — the
ServiceManager broadcasts to all via the same multi-viewer pattern used by the current
session runner.

### Docker socket access (`compose.docker-socket`)

The orchestrator manages compose stacks directly via its Docker socket. The agent
container does not need Docker access. If Claude needs to build an image or add a
service, it edits docker-compose.yml and ShipIt reconciles the stack.

For the rare case where a compose service itself needs Docker access (e.g.,
ShipIt-in-ShipIt, where the inner orchestrator creates containers dynamically),
shipit.yaml provides `compose.docker-socket: true`. This tells the orchestrator to
allow Docker socket mounts in the compose file rather than stripping them as a
security violation. Other security policies still apply.

This replaces the old `capabilities.docker` which granted Docker CLI access to the
agent container. The new model is more precise — Docker access is scoped to specific
compose services that declare a socket mount, not to the agent.

## Onboarding flow

When a project has no docker-compose.yml, the preview panel shows an onboarding UI
instead of a blank preview:

1. User creates session with existing repo (or new project from template).
2. ShipIt looks for `compose` in shipit.yaml and auto-detects compose files at the
   workspace root → none found.
3. Preview panel shows: **"Set up live preview"** with a "Generate" button and a brief
   explanation that ShipIt uses Docker Compose to run services.
4. User clicks "Generate."
5. The orchestrator sends a programmatic message to the agent (via the existing
   `send_message` WebSocket handler) with a prompt like: "Analyze this project and
   create a docker-compose.yml for the live preview. Read /shipit-docs/compose.md for
   ShipIt-specific conventions."
6. The agent uses the **session's already-running Claude process** — the same model and
   context the user is chatting with. No separate model or process. The message appears
   in the chat like any other exchange, so the user sees what the agent is doing and can
   follow up ("add Redis too", "use port 8080 instead").
7. Agent inspects the project (package.json, requirements.txt, Dockerfile, etc.),
   reads the compose guide from shipit-docs, picks appropriate base images and
   commands, writes docker-compose.yml (and shipit.yaml if needed).
8. ShipIt detects the new compose file (via `fs.watch`), starts the stack.
9. Preview panel switches to the live preview automatically.

For **new projects from templates**, the template includes both files — no onboarding
step. The user sees the preview immediately.

**No auto-detection heuristics.** The current code for detecting Vite, extracting
ports from scripts, inferring package managers — all of that is replaced by the agent,
which understands project structure far better than pattern matching. This removes
~150 lines of fragile heuristic code from `preview-config.ts`.

### Agent documentation for compose

The agent learns how to write compose files for ShipIt via `/shipit-docs/compose.md`
(new file, baked into the session worker image alongside the existing shipit-docs).

**`/shipit-docs/compose.md` should cover:**

- **Image selection** — use standard public images (`node:20`, `python:3.12`,
  `postgres:16`). Match the project's runtime version (check `engines.node` in
  package.json, `.python-version`, etc.). Never use a custom ShipIt image.
- **Port conventions** — expose ports via `ports: ["<port>:<port>"]`. Use the port the
  framework defaults to (Vite: 5173, Next.js: 3000, Django: 8000). Set
  `HOST=0.0.0.0` in `environment` so the server binds to all interfaces inside Docker.
- **Volume mounts** — mount the workspace as `.:/workspace` and set
  `working_dir: /workspace`. ShipIt's override rewrites this to the correct named
  volume at runtime.
- **`x-shipit-preview`** — set `x-shipit-preview: auto` on services the user wants to
  see in the preview panel (typically the dev server). Set `manual` on infrastructure
  services (databases, caches) that the user doesn't browse. Omit for services where
  the default behavior (auto if has ports, manual otherwise) is correct.
- **What not to do** — don't add `docker-socket` volumes (ShipIt manages that via
  shipit.yaml). Don't use `network_mode: host`. Don't set `privileged: true`.
  Don't use `build:` — use pre-built public images.

This is a concise quick-start guide (not a comprehensive reference). The agent can
read the full Docker Compose documentation if it needs advanced features.

### Preview panel states

| State | What user sees |
|-------|---|
| No compose file | Onboarding UI: "Set up live preview" + Generate button |
| Compose starting | Service list with spinner per service |
| Services ready | Live preview of first `auto` service with port |
| Service error | Error state with logs for the failing service |
| Manual service stopped | "Start" button next to service name |

## Decided

### Install execution
Install runs in the agent container before the compose stack starts (see `agent.install`
in the schema section for full behavior). This serializes startup but is acceptable —
install typically runs once and is skipped on resume.

### Resource management
Each service is a separate container. For self-hosted, don't cap user-defined compose
resources — the host enforces limits. For managed (doc 062), enforce caps at the
Kubernetes level, not in ShipIt.

### Execution model
Always use compose, even for simple single-service projects. One code path is simpler
than maintaining two execution models. The ~2s compose overhead is acceptable and
the current services container (Fastify wrapper, SSE, HTTP API) is arguably heavier.

## Open questions

### Security policy
The orchestrator runs compose directly against the Docker socket, bypassing the proxy.
The likely approach is policy-by-construction (orchestrator generates the override,
controls its contents — inject `cap_drop: [NET_RAW]`, no `privileged`, restrict
volumes) plus validation of user compose files before merging.

Validation runs when the orchestrator reads the compose file (on startup and on config
change). Invalid files produce a `ShipitConfigError` surfaced in the preview panel.
Likely validation rules:
- Reject `privileged: true`
- Reject `network_mode: host`
- Reject Docker socket mounts unless `compose.docker-socket: true`
- Reject absolute-path or `../` bind mounts (must stay within workspace)
- Inject `cap_drop: [NET_RAW]` via override

The exact enforcement model for managed deployments needs more thought.

### Secrets injection
Today the orchestrator injects secrets into the services container via HTTP (held in
memory, never on disk). With compose, secrets need a different mechanism:
- Write `.shipit/.env` that the override references via `env_file:`. Orchestrator
  controls the file. On disk but in a dotdir.
- Doc 074's agent-vs-secrets isolation (agent can't see secrets) was designed for the
  dual-container model which this supersedes. The workspace volume is shared, so
  secrets on disk are visible to the agent. Is this acceptable?
- Which services get secrets? All by default, or opt-in per service?

## What this replaces

| Current component | Replaced by |
|---|---|
| Services container (Fastify session worker) | Compose stack |
| PreviewManager | ServiceManager (compose lifecycle) |
| SSE event stream from services container | `docker compose logs` + Docker events API |
| HTTP commands to services container | `docker compose` CLI |
| File watcher in services container | Orchestrator-direct `fs.watch` |
| Preview proxy (per-container routing) | Same proxy, routes to compose container IPs |
| Auto-detection heuristics (Vite, npm, etc.) | Agent-generated compose file |
| `preview-config.ts` (~200 lines) | Deleted |
| `preview.command` / `preview.html` / `preview.ports` | Standard compose fields |

## Migration

### ShipIt's own config

The root `shipit.yaml` migrates from the old format to the new schema. The current
file:

```yaml
capabilities:
  docker: true

resources:
  memory: 3072
  cpu: 2.0
  pids: 2048

install: NODE_ENV=development npm install
preview:
  command: >-
    ./node_modules/.bin/tsx watch src/server/orchestrator/index.ts &
    ./node_modules/.bin/vite dev --host 0.0.0.0 --port 5173
  ports: [5173]
```

Becomes:

```yaml
agent:
  memory: 3072
  cpu: 2.0
  pids: 2048
  install: NODE_ENV=development npm install

compose:
  file: docker/local/dev/compose.yml
  docker-socket: true
```

- The existing `docker/local/dev/compose.yml` already defines the orchestrator and
  session worker services — no new compose file needed.
- `docker-socket: true` because the inner ShipIt orchestrator (a compose service)
  creates inner session containers dynamically.
- Fixes the flat resources bug: current `resources.memory` is silently ignored by the
  parser (expects `resources.agent.memory`).
- `capabilities.docker` → `compose.docker-socket` — scoped to compose services, not
  the agent.
- `preview` block → compose services with `x-shipit-preview` annotations (already
  defined in the existing compose file, may need `x-shipit-preview: auto` added to
  the Vite service).

## Key files

| File | Role |
|------|------|
| `src/server/shared/shipit-config.ts` | **New.** Parser for shipit.yaml (agent + compose path) |
| `src/server/shared/shipit-config.test.ts` | **New.** Tests |
| `src/server/orchestrator/service-manager.ts` | **New.** Compose lifecycle, status, log streaming |
| `src/server/orchestrator/compose-generator.ts` | **New.** Generates override compose file |
| `src/server/shipit-docs/compose.md` | **New.** Agent guide for generating compose files |
| `src/server/session/preview-config.ts` | **Delete.** Replaced by compose |
| `src/server/session/preview-config.test.ts` | **Delete.** |
| `src/server/session/preview-manager.ts` | **Delete.** Replaced by ServiceManager |
| `src/server/shared/session-config.ts` | **Modify.** Thin wrapper over new parser |
| `src/server/orchestrator/container-lifecycle.ts` | **Modify.** Remove services container |
| `src/server/orchestrator/container-session-runner.ts` | **Modify.** Use ServiceManager |
| `src/server/orchestrator/sse-client.ts` | **Modify.** Replace SSE with docker logs |
| `src/server/orchestrator/agent-instructions.ts` | **Modify.** Reference compose.md |
| `docker/Dockerfile.dev` | **Modify.** Add docker compose CLI |
| `docker/Dockerfile.prod` | **Modify.** Add docker compose CLI |
| `src/server/shipit-docs/shipit-yaml.md` | **Modify.** New format |
