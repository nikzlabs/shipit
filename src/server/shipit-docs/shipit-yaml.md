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
  install:            # Install commands, run sequentially
    - npm install
    - npx prisma generate
  dep-dirs:           # Dependency dirs for the overlay store (default: [node_modules])
    - node_modules
  install-inputs:     # Dependency input files for the content-keyed install skip
    - package.json
    - package-lock.json
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `install` | string or string[] | none | Install commands, run sequentially |
| `dep-dirs` | string or string[] | `[node_modules]` | Dependency directories eligible for the overlay store |
| `install-inputs` | string or string[] | auto (from `install`) | Dependency input files whose content keys the install-skip (see below) |

#### Container sizing is automatic

You do **not** configure container memory, CPU, or processes. Session memory is
sized automatically from host capacity: a session gets a generous host-derived
ceiling (a Docker memory limit is a ceiling, not a reservation, so idle sessions
cost nothing), CPU is left unthrottled (the host scheduler shares cores under
contention), and processes carry a fixed fork-bomb guard.

The old `agent.memory` / `agent.cpu` / `agent.pids` fields are **removed**. A
shipit.yaml that still sets them is accepted but the fields are ignored with a
warning in the session diagnostics panel.

Operators can override the automatic memory sizing with two optional
deployment-level env vars: `DEFAULT_SESSION_MEMORY_MB` (the per-session
baseline) and `MAX_SESSION_MEMORY_MB` (a hard ceiling). When neither is set,
sizing is fully automatic.

#### Install behavior

- Steps run sequentially in the agent container before services start.
- If any step fails, subsequent steps are skipped and the error is reported.
- The `.shipit/.install-done` marker is only written after all steps succeed.
  It is *stamped* with the source commit, the container's runtime fingerprint,
  and the install commands it ran.
- On resume, install is skipped when the stamp still matches. The runtime and
  the install commands must always match; given those, the deps are current when
  **either** the checked-out commit is unchanged **or** the dependency input
  files hash identically to the last install (the *content key* — see
  `install-inputs` below). So a new commit that only edits source or docs — but
  not `package.json`/the lockfile — still skips install. A different runtime or a
  changed `install` always re-runs (a warm dependency cache keeps it fast).
- When `install` is a string, it's treated as a single-element list.

#### Content-keyed install skip (`install-inputs`)

The install-skip is also keyed on the **content of your dependency files**, not
just the commit. When a resume lands on a new commit, ShipIt compares a hash of
the dependency input files against the last install; if they're identical, the
deps are already correct and install is skipped.

By default the input files are inferred from your `install` commands when **every**
command is a recognized pure dependency install:

| Command (common flags tolerated) | Hashed input files |
|---|---|
| `npm install` / `npm ci` / `npm i` | `package.json`, `package-lock.json` |
| `pnpm install` | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` |
| `yarn` / `yarn install` | `package.json`, `yarn.lock` |
| `pip install -r <file>` | the named requirements file(s) |
| `uv sync` | `pyproject.toml`, `uv.lock` |

If **any** `install` command is something else (a build, codegen, a custom
script — e.g. `npx prisma generate`), content-keying is **disabled** and the skip
falls back to commit-only, because the install's output isn't fully described by
those files. To opt back in, declare the inputs explicitly:

```yaml
agent:
  install:
    - npm ci
    - npx prisma generate
  install-inputs:        # replaces the inferred set; opts content-keying back on
    - package.json
    - package-lock.json
    - prisma/schema.prisma
```

- **Literal relative paths only** — no globs, no `..`, not the workspace root.
  Invalid entries are ignored with a warning.
- An explicit list **replaces** the inferred set (it does not add to it), so list
  every file whose change should re-run install.
- Omit the key to use the inferred set. A missing or mismatched hash only ever
  causes a (safe, one-time) reinstall — it can never cause a stale skip.

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
- An explicit empty list (`dep-dirs: []`) opts out entirely — that directory
  falls back to a plain install.
- The overlay store is **enabled by default**, so this key takes effect
  automatically. (A platform operator can disable the store for a release via
  the `OVERLAY_DEP_STORE=0` kill switch, in which case dep dirs fall back to a
  plain install.) See docs/183.

#### pnpm projects: shared store instead of overlay

pnpm is detected automatically — from `package.json`'s `packageManager: "pnpm@…"`
field, a `pnpm` command in `agent.install`, or a `pnpm-lock.yaml` at the root (in
that precedence order). For a pnpm repo, ShipIt **skips the `node_modules` overlay**
and instead mounts a **shared, content-addressed store** on the same filesystem as
your workspace. The store is mounted at `/workspace/.pnpm-store` — which is exactly
where pnpm 11 relocates its store when its default location is on a different device
(it ignores `store-dir` config in that case), so pnpm uses the shared store with no
configuration; older pnpm versions are pointed there via `npm_config_store_dir` too.
This is strictly better for pnpm: installs become resolve + hardlink (seconds),
per-session disk is ~zero, and packages dedupe across versions and repos. `dep-dirs`
is ignored for pnpm repos — the store replaces the overlay, so there's nothing to
declare. The store directory (`.pnpm-store/`) is auto-excluded from git per session,
so it never lands in a commit. Like the overlay, the pnpm store is enabled by
default and shares the same `OVERLAY_DEP_STORE` operator kill switch.

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
| `resources.agent.memory` / `resources.memory` | _removed — sizing is automatic_ |
| `resources.agent.cpu` | _removed — sizing is automatic_ |
| `resources.agent.pids` | _removed — sizing is automatic_ |
| `agent.memory` / `agent.cpu` / `agent.pids` | _removed — sizing is automatic_ |
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
