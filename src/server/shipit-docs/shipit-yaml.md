# shipit.yaml Reference

Place `shipit.yaml` at the workspace root (`/workspace/shipit.yaml`) to
configure the preview server, install commands, resource limits, and
capabilities.

If no `shipit.yaml` exists, ShipIt falls back to detecting `package.json`
(looks for a `dev` script) or `index.html` (static file mode).

## Full example

```yaml
install: npm install

preview:
  command: npm run dev
  ports: [5173]
  directory: packages/frontend

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

## Sections

### `install` (optional)

Shell command to run before the preview starts. Typically dependency
installation.

```yaml
install: npm install
```

- Runs once on first session start. Skipped on resume (tracked by a
  `.shipit/.install-done` marker file).
- Runs in the workspace root, or in `preview.directory` if specified.
- If it fails, the preview does not start.

### `preview` (required for live preview)

Two mutually exclusive modes:

#### Command mode

```yaml
preview:
  command: npm run dev      # Required. Shell command to start the dev server.
  ports: [5173]             # Optional. Ports to poll until they open.
  directory: packages/app   # Optional. Subdirectory to run in (relative to workspace root).
```

- `command`: The shell command to run. `HOST=0.0.0.0` is injected automatically
  so frameworks bind to all interfaces inside Docker.
- `ports`: If provided, ShipIt polls these ports (500ms intervals, 30s timeout)
  before marking the preview as ready. If omitted, ShipIt detects the port from
  stdout (`http://localhost:PORT` or `http://127.0.0.1:PORT`).
- `directory`: Run both the install and preview commands in this subdirectory.
  Useful for monorepos.

Multiple commands can be run in parallel using shell `&`:
```yaml
preview:
  command: >-
    npm run server &
    npm run client
  ports: [3000, 5173]
```

#### HTML mode

```yaml
preview:
  html: index.html    # Path to HTML file relative to workspace root.
```

Serves a static HTML file using a built-in Vite dev server with hot reload.
Good for simple HTML/CSS/JS projects without a build step.

### `resources` (optional)

Request compute resources for session containers. Resources are configured
separately for the agent container (runs Claude CLI) and the preview
container (runs dev server). Values are capped at deployment-level maximums.

```yaml
resources:
  agent:
    memory: 2048    # Memory in MB (default: 1024, max: 4096)
    cpu: 1.0        # CPU cores as float (default: 0.5, max: 4)
    pids: 512       # Max processes (default: 256, max: 2048)
  preview:
    memory: 1024    # Memory in MB (default: 512, max: 4096)
    cpu: 1.0        # CPU cores as float (default: 0.5, max: 4)
    pids: 2048      # Max processes (default: 1024, max: 2048)
```

Increase `agent.memory` for projects where the agent needs more headroom
(e.g., large codebases). Increase `preview.memory` and `preview.cpu` for
projects with heavy build steps (e.g., TypeScript compilation, Webpack).
Increase `preview.pids` for projects that spawn many child processes.

### `capabilities` (optional)

Enable additional container features.

```yaml
capabilities:
  docker: true    # Grant Docker access (default: false)
```

When `docker: true`, the session container can create and manage child Docker
containers through a secure proxy. Child containers join an isolated bridge
network scoped to the session.

## Adding to a repository

When adding `shipit.yaml` to a repository, also add `.shipit` to the
project's `.gitignore`. ShipIt uses the `.shipit/` directory for internal
state (e.g., `.shipit/.install-done`) and its contents should not be
committed.

```
# .gitignore
.shipit
```

## Config changes at runtime

- Editing `shipit.yaml` triggers an immediate preview restart.
- Changes to lockfiles are debounced (30s cooldown) to avoid install loops
  during dependency resolution.
- Resource and capability changes take effect on the next session container
  creation (not live).
