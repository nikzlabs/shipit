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
    working_dir: /app
    ports: ["5173:5173"]
    environment:
      HOST: "0.0.0.0"
    volumes:
      - .:/app
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
inside Docker. Without this, the preview won't be accessible. If your
framework config already binds to `0.0.0.0` (e.g. in `vite.config.ts` or
`next.config.js`), the `HOST` env var can be omitted.

## Volume mounts

Mount the workspace as `.:/app` and set `working_dir: /app`.
ShipIt rewrites `.` bind mounts to the correct named volume at runtime.
Use `/app` (not `/workspace`) to avoid conflicts with the agent container's
own `/workspace` directory.

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

## `x-shipit-secrets`

Declare which env vars (API keys, connection strings, tokens) each service
needs. The user configures values once in **Settings → Secrets**;
ShipIt auto-injects them into every session for the repo:

```yaml
services:
  api:
    image: node:20
    x-shipit-secrets:
      - STRIPE_SECRET_KEY            # string shorthand
      - name: DATABASE_URL           # object form with metadata
        description: PostgreSQL URL
        required: true
```

Required secrets that lack values surface as a "Configure secrets" banner
above the preview. See [secrets.md](secrets.md) for the full reference
(extended syntax, `required`, `agent`, `source`, security model).

## Examples

### Node.js (Vite)

```yaml
services:
  web:
    image: node:20
    command: npm run dev
    working_dir: /app
    ports: ["5173:5173"]
    environment:
      HOST: "0.0.0.0"
    volumes:
      - .:/app
```

### Next.js

```yaml
services:
  web:
    image: node:20
    command: npm run dev
    working_dir: /app
    ports: ["3000:3000"]
    environment:
      HOSTNAME: "0.0.0.0"
    volumes:
      - .:/app
```

### Full-stack (Node + Postgres + Redis)

```yaml
services:
  web:
    image: node:20
    command: npm run dev
    working_dir: /app
    ports: ["3000:3000"]
    environment:
      HOST: "0.0.0.0"
      DATABASE_URL: postgresql://dev:dev@db:5432/app
      REDIS_URL: redis://redis:6379
    volumes:
      - .:/app
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
    working_dir: /app
    ports: ["8000:8000"]
    volumes:
      - .:/app
```

## Service control API

You can manage compose services programmatically via HTTP endpoints on
`localhost:9100`. This is useful for starting/stopping services as part of
a workflow without asking the user to do it manually in the UI.

### List services

```bash
curl http://localhost:9100/services/list
```

Returns:
```json
{
  "services": [
    { "name": "web", "status": "running", "port": 5173, "preview": "auto" },
    { "name": "db", "status": "stopped", "port": 5432, "preview": "manual" }
  ]
}
```

### Start a service

```bash
curl -X POST http://localhost:9100/services/start \
  -H 'Content-Type: application/json' \
  -d '{"name": "db"}'
```

### Stop a service

```bash
curl -X POST http://localhost:9100/services/stop \
  -H 'Content-Type: application/json' \
  -d '{"name": "db"}'
```

### Restart a service

```bash
curl -X POST http://localhost:9100/services/restart \
  -H 'Content-Type: application/json' \
  -d '{"name": "web"}'
```

All mutation endpoints return `{ "ok": true, "name": "...", "status": "..." }`
on success or an error with an HTTP 500 status if the operation fails. Service
names must match those defined in docker-compose.yml.

## Where to put `npm install`

Put dependency installation in `agent.install` (in `shipit.yaml`), **not**
in the compose service's `command`. The agent container and compose
services both bind-mount the same workspace, so running `npm install` from
two places simultaneously corrupts `node_modules` and leaves dev servers
unable to start.

Recommended:

```yaml
# shipit.yaml
agent:
  install:
    - npm install
compose: docker-compose.yml
```

```yaml
# docker-compose.yml
services:
  web:
    image: node:20
    command: npm run dev          # plain run, no install gate
    working_dir: /app
    ports: ["5173:5173"]
    volumes: [".:/app"]
```

The dev server may exit on its first cold-boot attempt while `node_modules`
is still being populated — ShipIt restarts it with backoff while
`agent.install` is in flight, then does one final restart pass once
install finishes. Do not paper over this with `(test -x ... || npm
install) && npm run dev` in the compose `command`; that re-introduces the
race the install-in-agent-only pattern avoids.

## What not to do

- **Don't mount the Docker socket** (`/var/run/docker.sock`) — ShipIt manages
  that through `shipit.yaml` when needed.
- **Don't use `network_mode: host`** — use explicit port mappings.
- **Don't set `privileged: true`** — not allowed for security.
- **Don't use `build:`** — use pre-built public images. If you need custom
  setup, run commands in the `command` field or use multi-step entrypoints.
- **Don't use absolute volume paths** — all paths must be relative to the
  workspace root.
- **Don't run `npm install` (or pnpm/yarn/bun install) in a service's
  `command`** when the same install lives in `agent.install`. Two
  containers writing to the same bind-mounted `node_modules` race each
  other — see "Where to put `npm install`" above.

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
