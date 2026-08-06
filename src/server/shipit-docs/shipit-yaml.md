# shipit.yaml Reference

Place `shipit.yaml` at the workspace root (`/workspace/shipit.yaml`) to
configure the agent container, install commands, the compose file path, and the
issue trackers the repository declares.

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

issues:
  trackers:
    - kind: github
      repo: owner/planning
      name: planning
      title: Planning
    - kind: linear
      team: SHI
      name: roadmap
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
sized automatically from host capacity: a session's ceiling is half the usable
budget (host RAM minus a 10% orchestrator/OS reserve), clamped to a 4 GiB floor
and a 48 GiB cap. A Docker memory limit is a ceiling, not a reservation, so idle
sessions cost nothing and a single heavy session can use a large share of the
host. CPU is left unthrottled (the host scheduler shares cores under
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
- The `/session-state/.install-done` marker is only written after all steps succeed.
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

### `issues` (optional)

**Every issue tracker this repository uses is declared here.** ShipIt has no
built-in tracker and no implicit fallback: the trackers a session can reach are
the ones declared in this block, plus the session's own repository's GitHub
Issues. Each declaration renders as its own tab in the Issues panel, in
declaration order.

```yaml
issues:
  trackers:
    - kind: github           # which backend backs this tracker
      repo: owner/planning   # GitHub Issues: `owner/name`
      name: planning         # how references and operations address it
      title: Planning        # optional label for the Issues tab
    - kind: linear
      team: SHI              # Linear binds a tracker to one team
      name: roadmap
```

| Field | Type | Applies to | Description |
|-------|------|-----------|-------------|
| `kind` | string | required | Which backend: `github` or `linear`. |
| `name` | string | required | How every reference and operation addresses this tracker. Unique within the repository. Letters, digits, `.`, `_`, `-` — it has to be writable as `name#42`. |
| `title` | string | optional | What the Issues tab shows for this tracker. Free-form text; defaults to `name`. Purely cosmetic — references still use `name`. A blank or non-string `title` warns and falls back to `name`. |

Each *destination* may also be declared only once: two entries pointing at the
same repository or the same Linear team are not an alias, and the second is
ignored with a warning. Give a destination one name and use it.
| `repo` | string | `github` | The `owner/name` slug of the GitHub repository. |
| `team` | string | `linear` | The Linear team key (`SHI`) — also the prefix its issue keys carry, which is what lets a bare `SHI-304` resolve to this declaration. |

The *workspace* a `linear` declaration reads comes from the Linear credential
configured in ShipIt's settings, not from the declaration — which is why a Linear
tracker identifies itself by team. A credential names a destination nowhere; it
only authorizes reaching one.

Entries are a tagged union on `kind`: the identifying fields belong to the kind,
so a backend identified by something other than a repository needs no reshaping
of the block. An entry whose `kind` this version of ShipIt does not recognize is
**ignored with a warning** rather than failing the session, so a config written
against a newer ShipIt degrades gracefully. The same is true of a missing or
malformed identifying field, a missing `name`, and a duplicate `name`. Those
warnings are printed by `shipit issue` commands, so the agent can repair a broken
declaration.

**Addressing a tracker.** Three reference forms all resolve to the same issue:

| Form | Example |
|---|---|
| tracker name + backend id | `roadmap#SHI-304`, `planning#123` |
| tracker name + number | `roadmap#304` |
| the backend's canonical address | `SHI-304`, `owner/repo#42`, an issue URL |

A canonical address resolves through the declaration it identifies — a Linear key
by its team prefix, a GitHub address by its `owner/repo`. One that identifies no
declared tracker **fails closed**: ShipIt never substitutes another tracker for
it. A reference is resolved when it is *used*, so re-pointing a name at a
different repository or team re-targets every reference written against it.

A repository may declare **its own** repository, which gives it a name. Doing so
replaces the unnamed tab rather than adding a second one. Without a
self-declaration, the session's own GitHub Issues is still reachable — it is the
one destination an operation may address without naming it — but
`shipit issue create` will not file there, because a create always names its
destination.

Declaring a tracker controls **which trackers exist** — it is not an access
grant. Requests use the same credential as ShipIt's other operations against that
backend, and the backend authorizes the credential; a destination it cannot reach
shows an inline error on its tab.

ShipIt performs no check that a declared destination exists, is private, or has
Issues enabled — there is no connect step at which to check. Note that on a
**public** code repository, a declaration discloses what it declares in a
committed file.

## Config resolution

1. **shipit.yaml with `compose`** — use the referenced compose file
2. **shipit.yaml without `compose`** — auto-detect compose file at workspace root
3. **No shipit.yaml** — same auto-detection as (2)
4. **No compose file found** — preview panel shows onboarding UI

## Onboarding a repository

Nothing to add to `.gitignore` for ShipIt's sake. ShipIt keeps its own
per-session state **outside your repository**, in a directory that is a sibling
of the clone rather than inside it: the install marker, fetched CI logs, the
generated compose override and the agent env file all live there, and only the
parts the agent needs (the marker and the CI logs) are mounted, at
`/session-state`. Per-service secret env files are *not* in that directory and
are never mounted into the agent container at all — they go to a separate
orchestrator-private root (`<stateDir>/service-env/<sessionId>/`), so service-only
secrets stay out of the agent's reach entirely.

Earlier versions wrote state to `.shipit/` in the repo root, which is why older
projects often carry a `.shipit` line in `.gitignore` — it is no longer needed.
No current code writes there, and the one-time cleanup that removed such
leftovers has been retired now that it had nothing left to find. Two residues
are possible and both are yours to delete: a stray `.shipit/` left in an old
session's working tree, and copies already committed to your history. (A session
container that predates the change and has not been recreated still runs the old
worker, which writes `.shipit/.install-done` until it is recreated.)

## Config changes at runtime

- Editing `shipit.yaml` or the compose file triggers stack reconciliation
  (re-read `shipit.yaml`, regenerate override, `docker compose up -d`).
- The same re-read happens after a git operation that rewrites the working tree
  from outside the container — **syncing/rebasing onto the base branch, or
  rolling back to an earlier commit**. So a rebase that brings in a
  `shipit.yaml` declaring a new `compose:` path, new services, or a different
  `agent.install` is applied to the live session; you do not need to restart it.
- A changed `agent.install` re-runs (subject to the same 30s cooldown as a
  lockfile change). Removing the `compose:` block stops the stack.
- An invalid `shipit.yaml` (YAML syntax error, bad `compose:` shape) leaves the
  running stack alone and reports the error rather than tearing the preview down
  mid-edit.
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
