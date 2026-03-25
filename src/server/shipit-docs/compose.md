# Docker Compose for ShipIt

ShipIt uses Docker Compose to run project services (dev servers, databases,
caches, etc.). When a project needs a live preview, create a
`docker-compose.yml` at the workspace root.

## Quick start

```yaml
services:
  web:
    image: node:20
    command: npm run dev
    working_dir: /workspace
    ports: ["5173:5173"]
    environment:
      HOST: "0.0.0.0"
    volumes:
      - .:/workspace
    x-shipit-preview: auto
```

## Image selection

Use standard public images — never custom ShipIt images:

- **Node.js**: `node:20` or `node:22` (match `engines.node` in package.json)
- **Python**: `python:3.12` (match `.python-version` or `pyproject.toml`)
- **PostgreSQL**: `postgres:16`
- **Redis**: `redis:7`
- **MySQL**: `mysql:8`

## Port conventions

Expose ports via `ports: ["<port>:<port>"]`. Use the framework's default port:

| Framework | Default port |
|-----------|-------------|
| Vite | 5173 |
| Next.js | 3000 |
| Create React App | 3000 |
| Django | 8000 |
| Flask | 5000 |
| Express | 3000 |
| Rails | 3000 |

Set `HOST=0.0.0.0` in `environment` so the server binds to all interfaces
inside Docker. Without this, the preview won't be accessible.

## Volume mounts

Mount the workspace as `.:/workspace` and set `working_dir: /workspace`.
ShipIt rewrites this to the correct named volume at runtime.

For subdirectory mounts (monorepos):
```yaml
volumes:
  - ./packages/frontend:/app
```

## `x-shipit-preview`

Controls how ShipIt treats each service:

| Value | Behavior |
|-------|----------|
| `auto` | Starts automatically, preview shown when ready. Default for services with `ports`. |
| `manual` | User clicks "Start" in UI. Default for services without `ports`. |

```yaml
services:
  web:
    image: node:20
    ports: ["5173:5173"]
    x-shipit-preview: auto     # Shown in preview pane

  db:
    image: postgres:16
    ports: ["5432:5432"]
    x-shipit-preview: manual   # User starts when needed
```

When omitted, the default is `auto` if the service has `ports`, `manual`
otherwise. The `x-` prefix means Docker Compose ignores it.

## Examples

### Node.js (Vite)

```yaml
services:
  web:
    image: node:20
    command: npm run dev
    working_dir: /workspace
    ports: ["5173:5173"]
    environment:
      HOST: "0.0.0.0"
    volumes:
      - .:/workspace
```

### Next.js

```yaml
services:
  web:
    image: node:20
    command: npm run dev
    working_dir: /workspace
    ports: ["3000:3000"]
    environment:
      HOSTNAME: "0.0.0.0"
    volumes:
      - .:/workspace
```

### Full-stack (Node + Postgres + Redis)

```yaml
services:
  web:
    image: node:20
    command: npm run dev
    working_dir: /workspace
    ports: ["3000:3000"]
    environment:
      HOST: "0.0.0.0"
      DATABASE_URL: postgresql://dev:dev@db:5432/app
      REDIS_URL: redis://redis:6379
    volumes:
      - .:/workspace
    depends_on:
      - db
      - redis

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: app
    ports: ["5432:5432"]
    x-shipit-preview: manual

  redis:
    image: redis:7
    x-shipit-preview: manual
```

### Python (Django)

```yaml
services:
  web:
    image: python:3.12
    command: python manage.py runserver 0.0.0.0:8000
    working_dir: /workspace
    ports: ["8000:8000"]
    volumes:
      - .:/workspace
```

## What not to do

- **Don't mount the Docker socket** (`/var/run/docker.sock`) — ShipIt manages
  that through `shipit.yaml` when needed.
- **Don't use `network_mode: host`** — use explicit port mappings.
- **Don't set `privileged: true`** — not allowed for security.
- **Don't use `build:`** — use pre-built public images. If you need custom
  setup, run commands in the `command` field or use multi-step entrypoints.
- **Don't use absolute volume paths** — all paths must be relative to the
  workspace root.

## Pairing with shipit.yaml

The minimal `shipit.yaml` to reference a compose file:

```yaml
compose: docker-compose.yml
```

Or with agent configuration:

```yaml
agent:
  install: npm install

compose: docker-compose.yml
```

See [shipit-yaml.md](shipit-yaml.md) for the full shipit.yaml reference.
