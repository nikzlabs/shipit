# shipit.yaml Reference

Place `shipit.yaml` at the workspace root (`/workspace/shipit.yaml`) to
configure the agent container, install commands, and compose file path.

If no `shipit.yaml` exists, ShipIt auto-detects `docker-compose.yml` or
`compose.yml` at the workspace root. If no compose file is found, the
preview panel shows an onboarding UI.

## Full example

```yaml
version: 1

agent:
  memory: 2048
  cpu: 1.0
  pids: 4096
  install:
    - npm install
    - npx prisma generate

compose: docker-compose.yml
```

## Sections

### `version` (optional)

```yaml
version: 1
```

Schema version for forward compatibility. When present, the parser validates
against that version's schema. When absent, the latest version is assumed.

### `agent` (optional)

Configures the agent container (runs the AI coding agent — Claude Code or Codex, depending on the session's selected backend).

```yaml
agent:
  memory: 2048        # Memory in MB (default if omitted: 1536)
  cpu: 1.0            # CPU cores as float (default if omitted: 0.5)
  pids: 4096          # Max processes (default if omitted: 4096)
  install:            # Install commands, run sequentially
    - npm install
    - npx prisma generate
  dep-dirs:           # Dependency dirs for the overlay store (default: [node_modules])
    - node_modules
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory` | integer | 1536 | Memory limit in MB |
| `cpu` | float | 0.5 | CPU cores |
| `pids` | integer | 4096 | Max processes |
| `install` | string or string[] | none | Install commands, run sequentially |
| `dep-dirs` | string or string[] | `[node_modules]` | Dependency directories eligible for the overlay store |

A declared resource value is honored up to a deployment-level ceiling. By
default that ceiling tracks the host: memory is capped at ~75% of total host
RAM (never below the 1536 MB library default), CPU at the host core count, and
processes at a generous fork-bomb guard — so a session gets what it declares as
long as the host can back it, while one runaway session still can't exhaust the
box. An operator can override any ceiling with the `MAX_SESSION_MEMORY_MB`,
`MAX_SESSION_CPU`, and `MAX_SESSION_PIDS` env vars (e.g. to enforce stricter
per-session limits). When a declaration exceeds the active ceiling it is clamped
and the reason is surfaced in the session diagnostics panel. Invalid or negative
values fall back to defaults.

#### Install behavior

- Steps run sequentially in the agent container before services start.
- If any step fails, subsequent steps are skipped and the error is reported.
- The `.shipit/.install-done` marker is only written after all steps succeed.
  It is *stamped* with the source commit, the container's runtime fingerprint,
  and the install commands it ran.
- On resume, install is skipped only when that stamp still matches — i.e. the
  checked-out commit, the runtime, and the install commands are all unchanged.
  A new commit, a changed `install` in `shipit.yaml`, or a different runtime
  re-runs install (a warm dependency cache keeps the re-run fast).
- When `install` is a string, it's treated as a single-element list.

> **Python projects usually have no `install` step.** A Python virtualenv is
> pinned to the interpreter that creates it, so deps must be installed by the
> `python:3.12` preview service, not the agent container. The preview service
> installs its own deps in its compose `command`; `shipit.yaml` is just
> `compose: docker-compose.yml`. See
> [compose.md](compose.md) → "Python: the preview service owns its install".

#### Dependency directories (`dep-dirs`)

Declares which directories hold installed dependencies, so they can be served
from a shared, copy-on-write **overlay dependency store** instead of a full
per-session copy (faster fresh-session starts; far less disk). Defaults to
`[node_modules]`, which covers most Node projects with no configuration.

```yaml
agent:
  dep-dirs:
    - node_modules
    - packages/web/node_modules   # extra dirs in a monorepo
```

- **Literal relative paths only** — no globs. Each entry must be a relative path
  inside the workspace (not the root, no `..`). A monorepo lists each
  `node_modules` it wants covered explicitly.
- Invalid entries (absolute, glob, `..`-escaping, the root) are **ignored with a
  warning** — they never break the session; that directory just falls back to a
  plain install.
- An explicit empty list (`dep-dirs: []`) opts out entirely.
- The overlay store is rolling out behind a platform flag; until it is enabled
  this key is parsed and validated but has no runtime effect. See docs/183.

#### pnpm projects: shared store instead of overlay

pnpm is detected automatically — from `package.json`'s `packageManager: "pnpm@…"`
field, a `pnpm` command in `agent.install`, or a `pnpm-lock.yaml` at the root (in
that precedence order). For a pnpm repo, ShipIt **skips the `node_modules` overlay**
and instead points pnpm at a **shared, content-addressed store** on the same
filesystem as your workspace (via `npm_config_store_dir`). This is strictly better
for pnpm: installs become resolve + hardlink (seconds), per-session disk is ~zero,
and packages dedupe across versions and repos. `dep-dirs` is ignored for pnpm repos
— the store replaces the overlay, so there's nothing to declare. Like the overlay,
the store is behind the same platform flag and inert until enabled.

> **Caveat — in-place patching of installed packages.** Because the store hardlinks
> files into every `node_modules`, editing a dependency's files in place (the old
> `patch-package` style) would mutate the shared store and leak the change into other
> sessions. Use pnpm's built-in `pnpm patch` / `pnpm patch-commit` flow instead — it
> copies-on-write rather than mutating the linked original. pnpm also integrity-checks
> the store on link, so a corrupted store entry is detected, not silently propagated.

### `compose` (optional)

Path to a Docker Compose file, relative to workspace root. Accepts a string
(just the path) or an object (path + flags):

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
| `file` | string | required | Path to compose file |
| `docker-socket` | boolean | false | Grant Docker socket access to compose services |

When `compose` is omitted, ShipIt auto-detects `docker-compose.yml`,
`docker-compose.yaml`, `compose.yml`, or `compose.yaml` at the workspace root.

#### `docker-socket`

When true, Docker socket mounts (`/var/run/docker.sock`) in the compose file
are allowed instead of being rejected. Required for projects whose compose
services need to create Docker containers at runtime (e.g., ShipIt running
inside ShipIt). Other security policies still apply.

## Config resolution

1. **shipit.yaml with `compose`** — use the referenced compose file
2. **shipit.yaml without `compose`** — auto-detect compose file at workspace root
3. **No shipit.yaml** — same auto-detection as (2)
4. **No compose file found** — preview panel shows onboarding UI

## Onboarding a repository

When onboarding a repository, also add `.shipit` to the project's
`.gitignore`. ShipIt uses the `.shipit/` directory for internal
state (e.g., `.shipit/.install-done`) and its contents should not be
committed.

```
# .gitignore
.shipit
```

## Config changes at runtime

- Editing `shipit.yaml` or the compose file triggers stack reconciliation
  (regenerate override, `docker compose up -d`).
- Changes to lockfiles are debounced (30s cooldown) to avoid install loops.
- Resource changes take effect on the next session container creation (not live).

## Services

Services are defined in `docker-compose.yml`, not in shipit.yaml. See
[compose.md](compose.md) for how to write compose files for ShipIt.

## Migration from old format

If you have a shipit.yaml with the old format (`preview`, `resources`,
`capabilities`), migrate to the new schema:

| Old | New |
|-----|-----|
| `resources.agent.memory` / `resources.memory` | `agent.memory` |
| `resources.agent.cpu` | `agent.cpu` |
| `resources.agent.pids` | `agent.pids` |
| `install: npm install` (top-level) | `agent.install: npm install` |
| `capabilities.docker: true` | `compose.docker-socket: true` |
| `preview.command` / `preview.html` | Compose `command` / static file service |
| `preview.ports` | Compose `ports` field |
| `preview.directory` | Compose `working_dir` field |
| `resources.preview` | Per-service resource limits in compose |

### Before / after

```yaml
# Before (old format) — shipit.yaml
install: npm install
preview:
  command: npm run dev
  ports: [5173]
```

```yaml
# After — shipit.yaml
version: 1

agent:
  install: npm install

compose: docker-compose.yml
```

```yaml
# After — docker-compose.yml
services:
  web:
    image: node:24-slim
    command: npm run dev
    working_dir: /app
    ports: ["5173:5173"]
    volumes:
      - .:/app
```
