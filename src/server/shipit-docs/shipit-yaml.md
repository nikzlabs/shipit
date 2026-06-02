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
  pids: 512
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
  memory: 2048        # Memory in MB (default: 1536, max: 4096)
  cpu: 1.0            # CPU cores as float (default: 0.5, max: 4)
  pids: 512           # Max processes (default: 256, max: 2048)
  install:            # Install commands, run sequentially
    - npm install
    - npx prisma generate
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory` | integer | 1536 | Memory limit in MB |
| `cpu` | float | 0.5 | CPU cores |
| `pids` | integer | 256 | Max processes |
| `install` | string or string[] | none | Install commands, run sequentially |

Resource values are capped at deployment-level maximums. Invalid or negative
values fall back to defaults.

#### Install behavior

- Steps run sequentially in the agent container before services start.
- If any step fails, subsequent steps are skipped and the error is reported.
- The `.shipit/.install-done` marker is only written after all steps succeed.
- On resume, install is skipped (marker exists). Editing `shipit.yaml` clears
  the marker.
- When `install` is a string, it's treated as a single-element list.

> **Python projects usually have no `install` step.** A Python virtualenv is
> pinned to the interpreter that creates it, so deps must be installed by the
> `python:3.12` preview service, not the agent container. The preview service
> installs its own deps in its compose `command`; `shipit.yaml` is just
> `compose: docker-compose.yml`. See
> [compose.md](compose.md) → "Python: the preview service owns its install".

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
    image: node:20
    command: npm run dev
    working_dir: /app
    ports: ["5173:5173"]
    volumes:
      - .:/app
```
