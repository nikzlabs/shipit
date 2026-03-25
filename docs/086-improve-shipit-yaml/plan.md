---
status: planned
---

# Improve shipit.yaml

Redesign shipit.yaml for long-term stability and extensibility. Replace the single
`preview` block with named `services`, support multi-step installs, unify parsing,
and add strict validation.

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

## Design

### Full example (new format)

```yaml
install:
  - npm install
  - npx prisma generate

services:
  api:
    command: npm run server
    directory: packages/api
    port: 3000
    preview: off

  web:
    command: npm run dev
    directory: packages/web
    port: 5173
    preview: auto

  docs:
    html: docs/index.html
    preview: manual

resources:
  agent:
    memory: 2048
    cpu: 1.0
    pids: 512
  preview:
    memory: 1024
    cpu: 1.0
    pids: 2048

capabilities:
  docker: true
```

### Backward-compatible simple form

The common case (single service) stays concise. A top-level `preview` block is sugar
for a single anonymous service:

```yaml
install: npm install

preview:
  command: npm run dev
  ports: [5173]
```

Is equivalent to:

```yaml
install:
  - npm install

services:
  default:
    command: npm run dev
    port: 5173
    preview: auto
```

`preview` and `services` are mutually exclusive — specifying both is a validation error.

### Changes by section

#### `version` (optional, integer)

```yaml
version: 1
```

Optional for now. When present, the parser validates against that version's schema.
When absent, the parser infers the version from the shape (presence of `services` vs
`preview`). This gives us a clean upgrade path if we ever need a breaking change after
the project is public, without requiring it today.

The version field is forward-looking insurance, not a current necessity. Since the
project isn't public yet, we can freely change the schema. But once we ship, having
the field already in the wild means we can introduce `version: 2` without a flag day.

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

Steps run sequentially. If any step fails, subsequent steps are skipped and the error
is reported. The `.shipit/.install-done` marker is only written after all steps succeed.

When `install` is a string, it's normalized to a single-element list internally.

#### `services` (optional, map of named services)

Replaces `preview` as the primary way to define processes. Each service is a named
entry with its own command, directory, port, and preview visibility.

```yaml
services:
  <name>:
    command: <string>         # Shell command to start the service
    html: <string>            # OR: path to HTML file (mutually exclusive with command)
    directory: <string>       # Optional: subdirectory to run in
    port: <number>            # Optional: port this service listens on
    preview: auto | manual | off  # Optional: preview visibility (default: auto)
```

**Service fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | one of command/html | Shell command to start the process |
| `html` | string | one of command/html | Static HTML file path |
| `directory` | string | no | Subdirectory (relative to workspace root) |
| `port` | integer | no | Port the service listens on |
| `preview` | enum | no | Preview visibility (default: `auto`) |

**`preview` field values:**

| Value | Behavior |
|-------|----------|
| `auto` | Service preview is shown in the preview panel automatically when ready. This is the default for services that declare a `port` or use `html` mode. |
| `manual` | Service runs and port is proxied, but the preview panel doesn't auto-navigate to it. User can manually select it from a service picker. Good for secondary services (docs site, admin panel). |
| `off` | Service runs but is not exposed to the preview panel at all. Good for backend APIs, background workers, or processes that other services depend on but users don't browse directly. |

When `preview` is omitted:
- Services with `port` or `html` default to `auto`
- Services without `port` default to `off`

**Port detection:**

- If `port` is specified, ShipIt polls that port for readiness.
- If `port` is omitted, ShipIt scans stdout for `http://localhost:PORT` patterns
  (current behavior, applied per-service).
- A service with no port and no stdout detection is treated as a background process
  (always "ready" after spawn).

**Why `port` (singular) instead of `ports` (array):**

Each service should own exactly one port. The current `ports: [3000, 5173]` pattern
exists only because you can't define multiple services — it's working around the
single-preview limitation. With named services, each gets its own port. If a framework
binds multiple ports (e.g., dev server + HMR WebSocket), the secondary ports are
internal implementation details, not separate services.

#### `preview` (optional, backward-compatible)

The existing `preview` block is kept for backward compatibility and for the simple
single-service case. It desugars to a single service named `default`:

```yaml
# This:
preview:
  command: npm run dev
  ports: [5173]
  directory: packages/frontend

# Becomes internally:
services:
  default:
    command: npm run dev
    port: 5173
    directory: packages/frontend
    preview: auto
```

When `preview.ports` is an array with multiple values, the first port is used as the
service port. This maintains backward compatibility while nudging users toward the
`services` form for multi-port setups.

`preview.html` desugars similarly:

```yaml
preview:
  html: index.html
# → services.default = { html: "index.html", preview: auto }
```

#### `resources` (optional, unchanged)

No changes to the resources schema. The existing nested `agent`/`preview` form is
correct. The flat form (`resources.memory`) will emit a deprecation warning and be
ignored (it already doesn't work — making that explicit).

#### `capabilities` (optional, unchanged)

No changes. `docker: true` is the only capability today.

### Unified parser

Today's split parsing is merged into a single module:

**New:** `src/server/shared/shipit-config.ts`

```typescript
interface ShipitConfig {
  version?: number;
  install: string[];                    // normalized to array
  services: Map<string, ServiceConfig>; // parsed from services or desugared from preview
  resources: SessionResourceConfig;
  capabilities: SessionCapabilities;
  source: "shipit.yaml" | "package.json" | "index.html" | "none";
}

interface ServiceConfig {
  name: string;
  mode: { kind: "command"; command: string } | { kind: "html"; html: string };
  directory?: string;
  port?: number;
  preview: "auto" | "manual" | "off";
}
```

**Parsing behavior:**
- Single pass over the YAML document
- Unknown top-level keys → warning (logged, not thrown)
- Unknown keys inside known sections → warning
- Type mismatches → `ShipitConfigError` with clear message and field path
- All sections optional — an empty `shipit.yaml` is valid (everything defaults)

**Consumers:**
- `preview-config.ts` → replaced. PreviewManager reads `ShipitConfig.services`.
- `session-config.ts` → keeps `resolveSessionConfig()` as a thin wrapper that calls
  the unified parser and extracts resources + capabilities.
- `container-session-runner.ts` → file watcher still triggers restart on shipit.yaml
  change, but now re-parses via the unified parser.

### Fallback resolution (no shipit.yaml)

When no shipit.yaml exists, the current auto-detection logic is preserved:

1. `package.json` with `scripts.dev` → single `default` service in command mode
2. `index.html` at root → single `default` service in html mode
3. Nothing found → source: `"none"`

Auto-detected configs always produce a single service named `default` with
`preview: auto`.

### Preview panel changes

The preview panel currently shows a single preview. With services, it needs to support
multiple previewed services:

- **Service tabs/picker** — when multiple services have `preview: auto` or `manual`,
  show a tab bar or dropdown to switch between them.
- **Auto-navigate** — on session start, auto-navigate to the first `preview: auto`
  service that becomes ready.
- **Status per service** — each service has independent ready/error/stopped status.

This is a significant client change and should be implemented as a follow-up, not part
of the config parser work.

### Migration

Since the project isn't public yet, migration is straightforward:

1. Ship the unified parser that accepts both `preview` and `services` forms.
2. Update the root `shipit.yaml` to use the new format.
3. Update shipit-docs.
4. The old `preview` form continues to work indefinitely — it's not deprecated, just
   sugar for the common case.

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
| `src/server/shared/shipit-config.ts` | **New.** Unified parser for all shipit.yaml sections |
| `src/server/shared/shipit-config.test.ts` | **New.** Tests for unified parser |
| `src/server/session/preview-config.ts` | **Remove.** Replaced by unified parser |
| `src/server/session/preview-config.test.ts` | **Remove.** Tests move to unified parser |
| `src/server/shared/session-config.ts` | **Modify.** Thin wrapper over unified parser |
| `src/server/session/preview-manager.ts` | **Modify.** Accept `ServiceConfig[]` instead of `PreviewConfig` |
| `src/server/shipit-docs/shipit-yaml.md` | **Modify.** Document new format |
| `src/client/stores/preview-store.ts` | **Modify.** (follow-up) Multi-service preview state |

## Implementation order

1. **Unified parser** — `shipit-config.ts` with support for both `preview` and
   `services` forms, unknown-field warnings, multi-step install.
2. **Wire up parser** — replace `preview-config.ts` callers, update `session-config.ts`
   wrapper.
3. **PreviewManager multi-service** — start/stop/status per named service.
4. **Update docs** — shipit-yaml.md, preview.md.
5. **Client multi-service preview** — (follow-up PR) service picker, per-service status.
