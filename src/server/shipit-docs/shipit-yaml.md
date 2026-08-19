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
    - npm ci
    - npx prisma generate
  install-inputs:            # required once a step is not a plain dep install —
    - package.json           # otherwise the content-keyed install skip turns off
    - package-lock.json      # and ShipIt can no longer re-check deps after a sync
    - prisma/schema.prisma

compose: docker-compose.yml

issues:
  trackers:
    - kind: github
      repo: owner/planning
      name: planning
      label: Planning
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
    - npm ci
    - npx prisma generate
  dep-dirs:           # Dependency dirs for the overlay store (default: [node_modules])
    - node_modules
  install-inputs:     # Dependency input files for the content-keyed install skip
    - package.json
    - package-lock.json
    - prisma/schema.prisma
```

`npx prisma generate` is not a recognized dependency install, so it would switch
the content-keyed skip **off** for the whole `install` block — which also stops
ShipIt re-checking dependencies after it rewrites the tree. `install-inputs`
turns it back on, and must list the codegen step's own inputs
(`prisma/schema.prisma`) as well as the manifest and lockfile. See
[when `install-inputs` is the answer, and when it is a trap](#when-install-inputs-is-the-answer-and-when-it-is-a-trap)
before copying this — for a step like `npm run build` the fix is a different one.

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
- **A skipped install guarantees `dep-dirs`, and nothing else it wrote.** The
  stamp can match a checkout that never ran the install — a workspace reclaimed
  for disk and re-cloned, or a session that mounted an already-published
  dependency base for this commit. Those clones get the declared dependency
  directories and the committed files, and nothing else: a gitignored `dist/`, a
  generated client, or a compiled binary is simply absent, while the install
  still reports done. (An ordinary idle recreate keeps the same clone, so it
  usually looks fine — which is what makes this read as intermittent.) If a
  build step's output has to be there, declare its directory in `dep-dirs`
  alongside `node_modules` — **but only for a step whose inputs are
  enumerable.** Keeping a whole-source-tree build (`npm run build`, `tsc`, a
  bundler) inside `agent.install` and listing its output dir in `dep-dirs` is the
  configuration that disables content-keying, and it is what leaves you
  re-running the install by hand after every sync. That build belongs in the
  service `command:` instead — see
  [when `install-inputs` is the answer, and when it is a trap](#when-install-inputs-is-the-answer-and-when-it-is-a-trap).
- **`dep-dirs` is checked after the install, not only before it.** The exit
  status alone is not enough — an install command that ends in `|| true`, or in
  a fallback test like `|| [ -x node_modules/.bin/vite ]`, exits 0 while having
  installed nothing, and the gate would then open over a dependency tree that
  was never built, leaving the services crash-looping on a missing module. So
  two things are checked when the install commands finish, and either one fails
  the install: no marker is written, and services gated on the install
  (`x-shipit-depends-on-install`) are not started.
  - **Empty.** A declared directory that exists but holds nothing.
  - **Stale.** A declared directory npm reified — one holding a
    `.package-lock.json`, npm's own record of what it installed — whose record
    disagrees with the `package-lock.json` beside it. This is the case a leftover
    tree from an earlier commit used to pass: the directory is not empty, so only
    comparing it against the lockfile catches it. The `install_error` names the
    packages that disagree.

  If you hit either, the install genuinely failed (read the `install_error`
  message and the install log for the first error it swallowed) — or, for the
  empty case only, `dep-dirs` names a directory this install does not produce;
  narrow the list. An **absent** directory is not a failure: a project that
  manages no dependency directory at all is unaffected, and `dep-dirs: []` opts
  out entirely.

  **What the stale check will not tell you.** It is deliberately one-directional
  and narrow, so that a directory which is legitimately *partial* never starts
  failing. A directory with no `.package-lock.json` is not compared to anything —
  that covers a declared build output, a monorepo `node_modules` that is nearly
  empty because everything hoisted to the root, and any tree managed by yarn,
  pnpm, pip or uv. A tree holding *more* than the lockfile asks for is fine. Dev
  dependencies are required only when the tree already records some, so an
  install run with `--omit=dev` is unaffected. Optional, peer, bundled, linked
  and platform-restricted packages are never required. Within those limits a
  stale tree still reaches the services in the cases the check cannot see, so
  for a non-npm project the empty check remains the only post-install check.
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

##### When `install-inputs` is the answer, and when it is a trap

Content-keying is not just an optimization: it is also what lets ShipIt re-check
your dependencies after **it** rewrites the working tree (a sync onto the base, a
rollback, a post-merge reset). Without it, the install is left alone after every
such rewrite and you re-run it yourself. So an `install` with an extra step needs
a decision, and there are exactly two answers.

**(a) The extra step's inputs are enumerable.** Prisma codegen from a schema,
`protoc` over a fixed set of `.proto` files, any generator with a config file.
Declare `install-inputs` listing the manifest, the lockfile, **and** the step's
own inputs:

```yaml
agent:
  install:
    - npm ci
    - npx prisma generate
  install-inputs: [package.json, package-lock.json, prisma/schema.prisma]
```

**(b) The extra step consumes the whole source tree.** `npm run build`, `tsc`, a
bundler, a Docker-less asset pipeline. There is no finite input list, so
`install-inputs` is a **trap**: listing only the manifest and lockfile makes the
skip fire whenever *only source* changed, and the build then never re-runs. That
trades a loud staleness notice for a silent stale build, which is worse — the
output is present, plausible, and wrong.

For (b), take the build out of `agent.install` entirely:

```yaml
# shipit.yaml — install is now a pure dependency install, so content-keying works
agent:
  install: npm ci
  dep-dirs: [node_modules]   # NOT dist/ — the service builds it, not the install
```

```yaml
# docker-compose.yml — the build moves into the service that needs it
services:
  web:
    command: sh -c "npm run build && npm start"
    x-shipit-depends-on-install: true   # wait for node_modules, then build
```

The build then re-runs whenever the service starts, against whatever the tree
currently holds, and its output directory is no longer something a skipped
install can claim to have produced.

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

It is not only an optimization: **this list is also what survives a container
replacement when the install is skipped** (see § Install behavior above). A
directory your install writes and git ignores is restored only if it is here.

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
      label: Planning        # optional label for the Issues tab
    - kind: linear
      team: SHI              # Linear binds a tracker to one team
      name: roadmap
```

| Field | Type | Applies to | Description |
|-------|------|-----------|-------------|
| `kind` | string | required | Which backend: `github` or `linear`. |
| `name` | string | required | How every reference and operation addresses this tracker. Unique within the repository. Letters, digits, `.`, `_`, `-` — it has to be writable as `name#42`. |
| `label` | string | optional | What the Issues tab shows for this tracker — its display text, *not* an issue label. Free-form; defaults to `name`. Purely cosmetic: references still use `name`. A blank or non-string `label` warns and falls back to `name`. |

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
  from outside the container — **syncing/rebasing onto the base branch, rolling
  back to an earlier commit, or resetting the branch onto the base after a
  merge**. So a rebase that brings in a `shipit.yaml` declaring a new `compose:`
  path, new services, or a different `agent.install` is applied to the live
  session; you do not need to restart it.
- **`agent.install` is re-checked after those rewrites too**, not only after an
  edit the in-container file watcher reports. A sync that brings in a changed
  lockfile re-runs the install and restarts the services gated on it; one that
  does not is a fast no-op (the install marker is content-keyed on the same
  input files). A project whose `install` is not content-keyable — a codegen
  step or a shell script, so no `install-inputs` can be inferred and none are
  declared — is left alone, and you re-run its install yourself after a sync.
- **When ShipIt cannot re-check, or the re-check fails, it says so** rather than
  leaving you to diagnose it. Both cases post a notice in chat, prefix the
  agent's next turn with a `[System]` instruction to run the install (repeated
  every turn until an install clears it), and add a `Dependencies:` line to
  `shipit service list` (and to `GET /api/sessions/:id/services` as a
  `dependencies` field). Read that line before
  you read an unresolvable-import error as a code fault: a service can report
  `running` while every request it serves fails, and restarting it does not help
  because the usual compose guard is `[ -d node_modules ] || npm ci` and the
  directory exists — it just holds the pre-rewrite contents. Declaring
  `agent.install-inputs` lets ShipIt do the check itself instead.
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
