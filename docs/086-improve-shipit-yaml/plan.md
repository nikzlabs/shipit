---
status: planned
---

# Improve shipit.yaml

Redesign shipit.yaml as a minimal entry point for ShipIt configuration. Agent config
and install steps live here. Service definitions live in docker-compose.yml — ShipIt
does not reinvent a service definition format.

See [087-compose-unification](../087-compose-unification/plan.md) for how ShipIt
manages the compose stack.

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
6. **`install` is a flat string** — no way to express multi-step installs.
7. **Reinvents service definitions** — the `preview` block is a stripped-down,
   less-capable version of what docker-compose.yml already does. Adding features
   (env vars, volumes, health checks, dependencies) means reimplementing compose.

## Design

### Schema

```yaml
version: 1                      # Optional. Schema version for future-proofing.

agent:
  memory: 2048                   # Memory in MB (default: 1024, max: 4096)
  cpu: 1.0                       # CPU cores (default: 0.5, max: 4)
  pids: 512                      # Max processes (default: 256, max: 2048)
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

ShipIt reads the compose file, generates an override file with session labels, network,
and volume rewrites, and manages the stack via `docker compose`. See
[087-compose-unification](../087-compose-unification/plan.md) for full details.

Per-service ShipIt config is annotated in the compose file via `x-shipit-preview`:

```yaml
# docker-compose.yml
services:
  web:
    image: node:20
    command: npm run dev
    ports: ["5173:5173"]
    x-shipit-preview: auto

  db:
    image: postgres:16
    ports: ["5432:5432"]
    x-shipit-preview: manual
```

### No `services` block

shipit.yaml does **not** have a service definition format. Services are defined in
docker-compose.yml — a standard, portable, well-documented format that supports env
vars, volumes, health checks, dependencies, build contexts, and everything else
projects need. Reimplementing a subset of this in shipit.yaml adds maintenance burden
and limits capability.

For projects without a docker-compose.yml (new projects, simple setups), the preview
panel shows an onboarding UI. The user clicks "Generate" and the agent analyzes the
project and creates both docker-compose.yml and shipit.yaml. See "Onboarding flow" in
[087-compose-unification](../087-compose-unification/plan.md).

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
  memory?: number;                      // default: 1024
  cpu?: number;                         // default: 0.5
  pids?: number;                        // default: 256
  install?: string[];                   // default: [] (no install steps)
}

interface ComposeConfig {
  file: string;                         // path to compose file
  dockerSocket?: boolean;               // default: false
}
```

Service definitions come from parsing the compose file separately (doc 087). The
shipit.yaml parser only handles agent config and the compose file path.

**Parsing behavior:**
- Unknown top-level keys → warning (logged, not thrown)
- Unknown keys inside `agent` → warning
- Type mismatches → `ShipitConfigError` with clear message and field path
- All sections optional — an empty `shipit.yaml` is valid (everything defaults)

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

## Key files

| File | Role |
|------|------|
| `src/server/shared/shipit-config.ts` | **New.** Parser for shipit.yaml (agent + compose path) |
| `src/server/shared/shipit-config.test.ts` | **New.** Tests |
| `src/server/session/preview-config.ts` | **Delete.** Replaced by compose |
| `src/server/session/preview-config.test.ts` | **Delete.** |
| `src/server/shared/session-config.ts` | **Modify.** Thin wrapper over new parser |
| `src/server/shipit-docs/shipit-yaml.md` | **Modify.** Document new format |

## Migration

See [087-compose-unification § Migration](../087-compose-unification/plan.md#migration)
for the unified migration plan covering both the shipit.yaml schema change and the
services container → compose transition.

## Implementation order

1. **Parser** — `shipit-config.ts` with `agent` and `compose` fields.
2. **Wire up** — delete `preview-config.ts`, update `session-config.ts`, update callers.
3. **Migrate root shipit.yaml** — convert to new format, point to existing compose file.
4. **Update shipit-docs** — new shipit.yaml reference.
5. **Compose integration** — see [087-compose-unification](../087-compose-unification/plan.md).
