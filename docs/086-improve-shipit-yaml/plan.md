---
status: planned
---

# Improve shipit.yaml

Redesign shipit.yaml for long-term stability and extensibility. Replace the single
`preview` block with named `services`, move agent config into its own section, support
multi-step installs, add compose file reference, unify parsing, and add strict
validation.

shipit.yaml is always the entry point for ShipIt configuration. It contains agent
config, install steps, and either process service definitions (`services`) or a
reference to a Docker Compose file (`compose`). See
[087-compose-unification](../087-compose-unification/plan.md) for the compose
integration design.

## Motivation

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
6. **`install` is a flat string** — no way to express multi-step installs (e.g.,
   `npm install` then `npx prisma generate`).
7. **`capabilities` and `resources` float at top level** — `docker: true` only affects
   the agent container, but nothing in the schema communicates that.

## Design

### Top-level structure

```yaml
version: 1          # Optional. Schema version for future-proofing.
install: ...        # Optional. Dependency installation commands (runs in agent).
agent: ...          # Optional. Agent container config (resources).
services: ...       # Optional. Named process services (mutually exclusive with compose).
compose: ...        # Optional. Path to docker-compose.yml (mutually exclusive with services).
```

`services` and `compose` are mutually exclusive. Use `services` for projects without
Docker. Use `compose` for projects with a docker-compose.yml.

### Example: process services (no Docker)

```yaml
install:
  - npm install
  - npx prisma generate

agent:
  memory: 2048
  cpu: 1.0

services:
  resources:
    memory: 1024
    cpu: 1.0
    pids: 2048

  api:
    command: npm run server
    directory: packages/api
    port: 3000

  web:
    command: npm run dev
    directory: packages/web
    port: 5173

  docs:
    html: docs/index.html
    preview: manual
```

### Example: Docker Compose project

```yaml
install: npm install

agent:
  memory: 2048

compose: docker-compose.yml
```

The compose file is a standard docker-compose.yml with optional `x-shipit-preview`
per-service annotations (see [087-compose-unification](../087-compose-unification/plan.md)):

```yaml
# docker-compose.yml — standard compose, team already has this
services:
  web:
    build: .
    command: npm run dev
    ports: ["5173:5173"]
    volumes:
      - .:/workspace

  db:
    image: postgres:16
    ports: ["5432:5432"]
    x-shipit-preview: manual
```

### Simple single-service form

The common case stays concise:

```yaml
install: npm install

services:
  default:
    command: npm run dev
    port: 5173
```

### Sections

#### `version` (optional, integer)

```yaml
version: 1
```

Optional. When present, the parser validates against that version's schema and gives
clear errors if the config uses fields from a different version. When absent, the
parser assumes the latest version.

This is forward-looking insurance. The project isn't public yet, so we can freely
change the schema now. But once we ship, having the field in the wild means we can
introduce `version: 2` without a flag day.

#### `install` (optional, string | string[])

Accepts either a single command or an ordered list:

```yaml
# Simple
install: npm install

# Multi-step
install:
  - npm install
  - npx prisma generate
  - npm run codegen
```

Steps run sequentially in the agent container. If any step fails, subsequent steps are
skipped and the error is reported. The `.shipit/.install-done` marker is only written
after all steps succeed.

When `install` is a string, it's normalized to a single-element list internally.

#### `agent` (optional)

Configures the agent container (runs Claude CLI). Resources live here because they
only affect this container.

```yaml
agent:
  memory: 2048        # Memory in MB (default: 1024, max: 4096)
  cpu: 1.0            # CPU cores (default: 0.5, max: 4)
  pids: 512           # Max processes (default: 256, max: 2048)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory` | integer | 1024 | Memory limit in MB |
| `cpu` | float | 0.5 | CPU cores |
| `pids` | integer | 256 | Max processes |

Resource values are capped at deployment-level maximums from env vars
(`MAX_SESSION_MEMORY_MB`, etc.). Invalid or negative values fall back to defaults.

#### `compose` (optional, string)

Path to a Docker Compose file, relative to workspace root:

```yaml
compose: docker-compose.yml
```

When present, ShipIt reads the compose file, generates an override file with session
labels/network/volumes, and manages the stack via `docker compose`. Per-service ShipIt
config is annotated in the compose file via `x-shipit-preview`. See
[087-compose-unification](../087-compose-unification/plan.md) for full details.

Mutually exclusive with `services`. Specifying both is a validation error.

#### `services` (optional, map of named services + optional `resources`)

Defines process services. Each runs as a compose service using the ShipIt base image.
Each key is a service name except `resources`, which is a reserved key for shared
resource limits.

Mutually exclusive with `compose`. Specifying both is a validation error.

```yaml
services:
  resources:                    # Reserved key: per-container resource limits
    memory: 1024
    cpu: 1.0
    pids: 2048

  <name>:                       # Service definition
    command: <string>           # Shell command to start the service
    html: <string>              # OR: path to HTML file (mutually exclusive with command)
    directory: <string>         # Optional: subdirectory to run in
    port: <number>              # Optional: port this service listens on
    preview: auto | manual      # Optional: startup behavior (default: auto)
```

**`services.resources` fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory` | integer | 512 | Memory limit in MB (per service container) |
| `cpu` | float | 0.5 | CPU cores |
| `pids` | integer | 1024 | Max processes |

Resource values are capped at deployment-level maximums. Invalid or negative values
fall back to defaults.

**Service fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | one of command/html | Shell command to start the process |
| `html` | string | one of command/html | Static HTML file path |
| `directory` | string | no | Subdirectory (relative to workspace root) |
| `port` | integer | no | Port the service listens on |
| `preview` | enum | no | Startup behavior (default: `auto`) |

**`preview` field values:**

| Value | Behavior |
|-------|----------|
| `auto` | Service starts automatically when the session begins. Once ready, its preview is shown in the preview panel. This is the default. |
| `manual` | Service does **not** start until the user explicitly starts it from the service picker in the UI. Useful for expensive services (heavy build steps, large databases) or services only needed occasionally (docs site, admin panel, seed scripts). |

Default is `auto` for all services.

**Reserved service names:** `resources` is reserved. Using it as a service name is a
validation error with a clear message.

**Port detection:**

- If `port` is specified, ShipIt polls that port for readiness.
- If `port` is omitted, ShipIt scans stdout for `http://localhost:PORT` patterns
  (current behavior, applied per-service).
- A service with no port and no stdout detection is considered ready immediately
  after spawn.

**Why `port` (singular) instead of `ports` (array):**

Each service should own exactly one port. The old `ports: [3000, 5173]` pattern
existed only because you couldn't define multiple services — it was working around the
single-preview limitation. With named services, each gets its own port. If a framework
binds multiple ports (e.g., dev server + HMR WebSocket), the secondary ports are
internal implementation details, not separate services.

### Unified parser

Today's split parsing is merged into a single module:

**New:** `src/server/shared/shipit-config.ts`

```typescript
interface ShipitConfig {
  version?: number;
  install: string[];                    // normalized to array
  agent: AgentConfig;
  services: {
    resources: ContainerResourceConfig;
    definitions: Map<string, ServiceConfig>;
  };
  compose?: string;                     // path to docker-compose.yml
  source: "shipit.yaml" | "package.json" | "index.html" | "none";
}

interface AgentConfig {
  memory: number;
  cpu: number;
  pids: number;
}

interface ServiceConfig {
  name: string;
  mode: { kind: "command"; command: string } | { kind: "html"; html: string };
  directory?: string;
  port?: number;
  preview: "auto" | "manual";
}
```

When `compose` is set, `services.definitions` is populated by parsing the compose file
and extracting `x-shipit-preview` annotations. The same `ServiceConfig` model
represents both process services and compose services.

**Parsing behavior:**
- Single pass over the YAML document
- Unknown top-level keys → warning (logged, not thrown)
- Unknown keys inside known sections → warning
- Type mismatches → `ShipitConfigError` with clear message and field path
- All sections optional — an empty `shipit.yaml` is valid (everything defaults)
- `services` + `compose` both present → validation error

**Consumers:**
- `preview-config.ts` → deleted. ServiceManager reads `ShipitConfig`.
- `session-config.ts` → thin wrapper over unified parser, extracts agent resources.
- `container-session-runner.ts` → file watcher triggers re-parse on shipit.yaml or
  docker-compose.yml change.

### Fallback resolution (no shipit.yaml)

When no shipit.yaml exists, auto-detection logic:

1. `package.json` with `scripts.dev` → single `default` service in command mode
2. `index.html` at root → single `default` service in html mode
3. Nothing found → source: `"none"`

Auto-detected configs produce a single service named `default` with `preview: auto`.

### Preview panel changes

The preview panel currently shows a single preview. With services, it needs to support
multiple services:

- **Service picker** — show all defined services with their status (stopped, starting,
  ready, error). `auto` services start immediately; `manual` services show a "Start"
  button.
- **Auto-navigate** — on session start, auto-navigate to the first `auto` service
  that becomes ready.
- **Status per service** — each service has independent ready/error/stopped status.
- **Manual start/stop** — users can start `manual` services and stop any running
  service from the picker.

This is a significant client change and should be implemented as a follow-up, not part
of the config parser work.

### What's deferred

| Topic | Reason |
|-------|--------|
| `env` block | Risks becoming docker-compose-lite. Secrets need a proper story first (SecretStore integration, `.env` file support, etc.). Revisit after secrets redesign. |
| Service dependencies (`depends_on`) | Over-engineering for now. Services start in parallel. If ordering matters, the install step can handle setup, and services can poll for readiness internally. |
| Health checks | Current port-polling is sufficient. Named health check endpoints can be added later as an optional field on services. |
| Restart policies | All services restart on shipit.yaml change. Per-service restart policies add complexity without clear user demand. |

## Key files

| File | Role |
|------|------|
| `src/server/shared/shipit-config.ts` | **New.** Unified parser for shipit.yaml (+ compose x-shipit) |
| `src/server/shared/shipit-config.test.ts` | **New.** Tests for unified parser |
| `src/server/session/preview-config.ts` | **Delete.** Replaced by unified parser |
| `src/server/session/preview-config.test.ts` | **Delete.** Tests move to unified parser |
| `src/server/shared/session-config.ts` | **Modify.** Thin wrapper over unified parser |
| `src/server/session/preview-manager.ts` | **Modify.** Accept `ServiceConfig[]` instead of `PreviewConfig` |
| `src/server/shipit-docs/shipit-yaml.md` | **Modify.** Document new format |
| `src/client/stores/preview-store.ts` | **Modify.** (follow-up) Multi-service preview state |

## Implementation order

1. **Unified parser** — `shipit-config.ts` with `agent`, `services`, `compose`,
   unknown-field warnings, multi-step install.
2. **Wire up parser** — delete `preview-config.ts`, update `session-config.ts` wrapper,
   update all callers.
3. **PreviewManager multi-service** — start/stop/status per named service.
4. **Update docs** — shipit-yaml.md, preview.md.
5. **Client multi-service preview** — (follow-up PR) service picker, per-service status.
6. **Compose integration** — see [087-compose-unification](../087-compose-unification/plan.md).
