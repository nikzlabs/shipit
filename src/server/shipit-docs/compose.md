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
| FastAPI / Uvicorn | 8000 |
| Streamlit | 8501 |
| Gradio | 7860 |
| Dash | 8050 |
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

## Hot reload (HMR) needs polling

Dev servers in a preview service run in their **own container**, watching the
workspace through the shared named volume. The agent edits files from a
**different** container (`/workspace`). inotify events do not cross the
mount-namespace boundary between the two containers, so a native file watcher
never hears the agent's edits and hot reload silently no-ops.

The fix is **polling-based watching**, which is namespace-independent. Enable it
in the dev server's config, not the compose file:

- **Vite** — `server.watch: { usePolling: true, interval: 200 }`
- **Astro** (Vite under the hood) — `vite.server.watch: { usePolling: true, interval: 200 }`
- **Next.js / webpack** — set `WATCHPACK_POLLING=true` in the service's
  `environment:`, or `config.watchOptions = { poll: 800, aggregateTimeout: 300 }`.

Do **not** pin `hmr.clientPort` — ShipIt's preview proxy rewrites the HMR
WebSocket URL to the page origin, and a hardcoded port fights that rewrite.

ShipIt's built-in project templates already include the polling config. Add it
yourself only when scaffolding a dev server by hand.

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

## `x-shipit-depends-on-install`

Gates a service on `agent.install` (from `shipit.yaml`) completing before it
starts. This prevents preview services that need `node_modules` (or other
install output) from racing the agent on cold boot and crash-looping.

| Value | Behavior |
|-------|----------|
| `true` | Held until `agent.install` finishes, then started exactly once. If install fails, the service is marked `error` (`agent.install failed — dependent service not started`). **Default for `auto` services.** |
| `false` | Starts immediately, in parallel with install. **Default for `manual` services.** |

```yaml
services:
  preview:
    image: node:24-slim
    command: npm run dev -- --host 0.0.0.0 --port 3000
    ports: ["3000:3000"]
    x-shipit-preview: auto
    x-shipit-depends-on-install: true   # default for auto — gate on install
```

When omitted, it defaults to `true` for `auto` services and `false` for
`manual` ones. Set it to `false` to opt a preview service out of the gate when
it genuinely doesn't depend on install output. Editing `shipit.yaml` or a
lockfile re-runs install and briefly restarts gated services against the
fresh dependency tree. The `x-` prefix means Docker Compose ignores it.

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

## Python: the preview service owns its install

Python web apps (Streamlit, FastAPI/Uvicorn, Gradio, Dash) are the **one
exception** to the "don't install in a service `command`" rule below. For these,
the **preview service installs its own dependencies in its `command`** — and
that is correct, not a workaround.

**Why:** a Python virtualenv is hard-pinned to the interpreter that created it
(`.venv/bin/python` is an absolute symlink, `pyvenv.cfg` records its home, and
any compiled wheels are ABI-pinned to it). `agent.install` runs in the **agent
container** (Debian's `python3`), but the app runs in the **`python:3.12`
preview service** — a different interpreter at a different path. A venv built by
one is broken for the other. So the dependencies must be installed by the same
python that runs the app, which means the install lives in the preview service.

**Why it's safe:** the npm rule below exists to prevent a *two-writer race* —
the agent container and a compose service both installing into one bind-mounted
tree at once. Here only the preview service ever installs Python deps (the agent
never runs pip), so there is no second writer and no race. This is **single-writer
by construction**. Do **not** add a Python `agent.install` step as well.

Pattern — the service creates its venv, installs, then `exec`s the server:

```yaml
# docker-compose.yml
services:
  web:
    image: python:3.12
    working_dir: /app
    command: sh -c "test -d .venv || python -m venv .venv; .venv/bin/pip install -q -r requirements.txt && exec .venv/bin/streamlit run streamlit_app.py --server.port 8501 --server.address 0.0.0.0 --server.headless true --server.enableCORS false --server.enableXsrfProtection false"
    ports: ["8501:8501"]
    volumes: [".:/app"]
    x-shipit-preview: auto
    x-shipit-depends-on-install: false   # no agent.install to gate on
```

```yaml
# shipit.yaml — no Python install step; the service self-installs
compose: docker-compose.yml
```

Notes:

- **Bind to `0.0.0.0`**, not `127.0.0.1`, or the preview proxy can't reach the
  server. Each framework has its own flag/argument for this (there is no shared
  `HOST` env var convention like Node's): Streamlit `--server.address 0.0.0.0`,
  Uvicorn `--host 0.0.0.0`, Gradio `launch(server_name="0.0.0.0")`, Dash
  `app.run(host="0.0.0.0")`.
- **Streamlit needs `--server.headless true`** so it doesn't try to open a
  browser or prompt for an email on first run.
- **Streamlit needs `--server.enableCORS false --server.enableXsrfProtection
  false`** to run behind the preview proxy. Streamlit's WebSocket handler
  rejects any origin that isn't its own host, and through the proxy the
  browser's origin is `<sessionId>--8501.localhost` — so without these flags it
  logs `Rejecting WebSocket connection from disallowed origin` and the app never
  connects. Both flags are required: with XSRF protection left on, Streamlit
  silently overrides `enableCORS` back to `true`.
- **Gradio works behind the proxy with no extra flags** — just
  `launch(server_name="0.0.0.0", server_port=7860)`. The preview proxy forwards
  `X-Forwarded-Host`/`X-Forwarded-Proto`, which Gradio uses to compute its
  public root URL, so its frontend's `/gradio_api/...` calls target the
  browser-facing host instead of `localhost:7860` (which would resolve to the
  user's machine, not the container).
- `test -d .venv || python -m venv .venv` keeps the venv across restarts; the
  `pip install` line re-runs each boot but is a fast no-op once satisfied.
- **`exec`** hands the server the service's main PID so signals and shutdown
  work cleanly.
- **Default ports:** Streamlit 8501, FastAPI/Uvicorn 8000, Gradio 7860, Dash
  8050.

### The package manager is the project's choice

ShipIt provides `pip`, the stdlib `venv`, and the `uv` binary in the image, but
it does not mandate one. Pick the command from what the repo ships, exactly as
for JS (a `pnpm-lock.yaml` means pnpm): a `requirements.txt` → `pip install -r
requirements.txt`, a `uv.lock` → `uv sync`, a `poetry.lock` → `poetry install`.
`uv` is dramatically faster for cold installs, so prefer it when a repo already
uses it.

### v1 limitation: the agent can't import project deps

Because the deps live only in the preview service's venv, the agent's own shell
cannot `import` them in an ad-hoc `python -c '...'`. The agent edits source and
the running app reflects the change via the mounted volume, but it can't execute
the project's Python directly. This is expected for now.

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

> **Python is the exception.** This rule targets the JS two-writer race. Python
> deps live in a venv pinned to the interpreter that runs the app, so the
> *preview service* installs them in its `command` and the agent never does —
> single-writer, no race. See "Python: the preview service owns its install"
> above.

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
  other — see "Where to put `npm install`" above. (Python is the documented
  exception: its venv is interpreter-pinned, so the preview service installs
  its own deps and the agent never does — single-writer, no race.)

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
