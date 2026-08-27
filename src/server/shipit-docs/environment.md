# Environment

You are running inside a Docker container managed by ShipIt.

## Runtime user — non-root

You run as the unprivileged user **`shipit`**, **not** root. Your home directory
is `/home/shipit`, and `whoami` reports `shipit`. This is a defense-in-depth
boundary (docs/150): a prompt-injected or mistaken shell command can't modify
system paths or read root-only files.

**Your UID is per-session — never hardcode it.** `id -u` reports a number
allocated to this session alone, in the range 2000000–2999999, so that one
session cannot reach another's files (docs/270). Your **GID is 1000** and is
shared by every session; that is the group the workspace is owned by. Read the
values instead of assuming them:

```
$ id
uid=2000006(shipit) gid=1000(shipit) groups=1000(shipit)
```

The number this doc used to give was `1000` for both, which is now wrong for the
UID and was the reason agents wrote `user: "1000:1000"` into a compose service.
**Do not do that**: a Compose service pinned to a UID that is not this session's
cannot own the workspace, so git refuses it (`detected dubious ownership`) and
dependency caches fail with `EACCES`. Omit `user:` and ShipIt supplies the right
identity — see the "Services share the agent's user" section of
/shipit-docs/compose.md.

What this means in practice:

- **Writable:** `/workspace`, `/persist`, `/dep-cache`, `/credentials`,
  and your home `/home/shipit` (including `~/.claude`, `~/.codex`, `~/.grok`, the npm
  global prefix at `~/.npm-global`, and the npm cache at `~/.npm`).
- **Persistent scratch:** `/persist` is a writable, non-git directory that
  **survives container restarts** (like `/workspace`, but never committed). Put
  files here that should outlive the container without entering the repo — see
  the filesystem layout below.
- **Read-only data:** `/uploads` is mounted **read-only** (docs/172 Gap 6) —
  you can read the user's attached files but not modify or delete them. If you
  need to transform an upload, copy it into `/workspace` or `/persist` first.
- **Read-only to you:** `/app` (the worker), `/opt/agent-cli` (the agent CLIs),
  `/usr/local/bin` shims (`gh`, `shipit`, `shipit-git-credential`), and system
  dirs. You can run them, but not modify them. Some deployments additionally run
  with a **read-only root filesystem** (docs/172 Gap 5): the writable paths above
  are unchanged (they're mounts or tmpfs), but writing *elsewhere* on the rootfs
  fails. Keep scratch under `/persist` (persistent) or your home and you'll never
  notice.
- **`npm install -g`** works — the global prefix is `~/.npm-global` (on your
  `PATH`), not the root-owned `/usr/local`. Manually-installed CLIs land there.
- **`sudo` is not available** and there is no passwordless privilege escalation.
  If something needs system-level changes, do it via the image / `shipit.yaml`,
  not at runtime.

## Filesystem layout

| Path | Description |
|------|-------------|
| `/workspace` | Project root. This is the git repo. Your working directory. |
| `/persist` | **Persistent, non-git scratch.** Writable; survives container restarts but is never committed. Put files here that the user should still see tomorrow without polluting the repo (e.g. presented artifacts you don't want tracked). Cleared only by a full session reset. |
| `/uploads` | User-uploaded files (outside git, never committed). **Read-only** — read attachments here, but copy elsewhere to modify. |
| `/credentials` | OAuth tokens (managed by ShipIt). Holds **only the credentials for this session's agent** — a Claude session sees `~/.claude` but not `~/.codex`, `~/.local/share/opencode` or `~/.grok`, and vice versa. The agent is pinned on the first message and can't be changed afterward. Symlinked into your home (`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.grok` → `/credentials/...`). Write-protected (see below). |
| `/dep-cache` | Shared npm/yarn/pnpm cache across sessions for the same repo. |
| `/home/shipit` | Your home directory. Agent credentials (via symlink), npm global prefix, and caches live here. |

### Write-protected paths

The Claude agent runs under an explicit permission policy (`/etc/shipit/managed-settings.json`). Editing under `/workspace` and elsewhere is unrestricted, but the file-edit tools (Edit/Write/MultiEdit/NotebookEdit) are **denied** on a few infrastructure paths:

- `/etc/shipit/**` — ShipIt's managed settings and hooks (the agent must not rewrite its own permission policy).
- The OAuth / CLI-config credential files: `~/.claude/.credentials.json`, `~/.claude/auth.json`, `~/.claude.json`, `~/.claude/settings*.json` (and the same files under `/credentials/.claude`, which `~/.claude` symlinks to).

These are infrastructure, not your project — you should never need to write to them. An attempt is refused with a permission error rather than silently succeeding.

Note: your own memory under `~/.claude/projects/<cwd>/memory/` is **not** restricted — the deny list targets the specific credential files, not the whole `~/.claude` tree, precisely so memory updates keep working. Confidentiality of the credentials (reads, exfil) is handled at the network/credential layer, not by these file-edit rules.

## Installed tools

- **Node.js** (with npm; `pnpm` and `yarn` are available via corepack — it reads the repo's `packageManager` field and fetches the pinned version). The container bakes Node 24, but **a repo's own Node pin wins** — see [Node version](#node-version) below.
- **git**, **git-lfs**, **curl** (see [Git LFS](#git-lfs) below)
- **python3**, **make**, **g++** (for native npm addons)
- **Agent CLIs** — the harnesses this install selected (`claude` / Claude Code, `codex` / Codex and `opencode` / OpenCode are installed by default; `grok` / Grok Build is available but off by default, and an install can narrow or widen the set) are installed; ShipIt invokes whichever the user selected for the session

  Codex authentication has two modes — they are not interchangeable:

  - **ChatGPT subscription** (preferred). The user signs in with `Sign in with ChatGPT` in the UI; the credentials are written to `~/.codex/auth.json` (a symlink onto the credentials volume). Bills against their ChatGPT plan / Codex credits.
  - **`OPENAI_API_KEY` env var**. Bills against their OpenAI Platform account. ShipIt only injects this into the agent process when no ChatGPT login is present — when both are configured, the env var is stripped so the user isn't double-billed.
- **Playwright** with headless Chrome (available via browser tools)
- **Android build toolchain** — JDK 17 (`JAVA_HOME=/opt/java`), the Android SDK (`ANDROID_SDK_ROOT=/opt/android-sdk` — `sdkmanager`, `adb`, platforms 34/35, build-tools), and Gradle 8.7. Always present, so any Android/Gradle repo builds, lints, and runs JVM/snapshot tests with no per-repo setup (no `shipit.yaml` Android fields). See [android.md](android.md).

## Node version

ShipIt honors the repository's Node version pin. Before your first turn and
before `agent.install` runs, it reads:

1. **`.nvmrc`** at the workspace root — takes precedence.
2. **`package.json` `engines.node`** — used when there is no `.nvmrc`.

If the container's baked Node already satisfies the pin (the usual case for a
range like `>=20`), nothing happens. Otherwise the matching version is
downloaded, verified, and put first on `PATH`, so `node`, `npm`, and anything
you build or run in the session use the version the project targets — native
addons compile against the right ABI, and the Node that installs dependencies
matches the Node a Compose service pins for the same workspace.

Other pin files (`.node-version`, `volta.node`, `mise.toml`, `.tool-versions`)
are **not** read. Neither is a pin honored when it resolves below Node 20 — the
agent CLIs resolve `node` through the same `PATH` and require 20+.

When a pin can't be honored — an unsupported form like `lts/*`, a version below
that floor, or a failed download — the session keeps running on the container's
Node and **you are told on your first turn**, in a `<system>` block ahead of the
user's message, naming the version you're running, what the repo asked for, and
why it couldn't be provisioned. Treat that as real: native addons you build
target the wrong ABI, tooling behaviour may differ from CI, and a failure you do
or don't reproduce may not reflect the project's target runtime. Say so if it
turns out to matter for the task rather than silently working around it.

The same information is in **session diagnostics** (the panel behind the session
health strip) under "Node runtime", which is where the user can see it too. It is
never silently ignored — if `node -v` surprises you, that panel says why.

Changing `.nvmrc` mid-session does not re-provision; the pin is resolved once at
container start. Restart the container to pick up a new pin.

## Automatic behaviors

**Git commits**: ShipIt auto-commits your changes after each turn. Do not run
`git commit`, `git add`, or `git push` — this is handled automatically. The
commit message is derived from your turn summary.

The auto-commit runs **with the repository's git hooks disabled**, and so does
every other git operation ShipIt itself performs on the workspace (merge,
rebase, checkout, push). ShipIt's git runs outside your container with more
privilege than your container has, so it does not execute hooks the repository
carries. A project's `pre-commit` formatter therefore does **not** run on the
auto-commit — if the repository expects one, run it yourself as part of your
turn. Hooks are unaffected when *you* run git inside the session container.

**Hot reload**: When you edit files, compose services with mounted volumes
pick up changes automatically. No need to restart dev servers after code edits.

**Dependency detection**: Changes to a dependency file — a lockfile
(`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) or the manifest your
install reads — trigger an automatic install + service restart (throttled with
a 30s cooldown). This covers **git operations** (`git reset`/`checkout`/`rebase`
that change the dependency tree), not just direct edits — so a reset to a commit
that added a dependency reinstalls and restarts the preview automatically. It
also covers the rewrites **ShipIt itself** performs on the session from outside
the container (syncing/rebasing onto the base, a rollback, a post-merge reset
onto the base), which are reported directly rather than through the file
watcher. The one case it does not cover is an `agent.install` that is not
content-keyable — a codegen step or a shell script with no declared
`install-inputs`; there ShipIt has no way to tell a dependency change from any
other, and you re-run the install yourself. **You are told when that happens**,
and when a re-install fails: both post a `[System]` note and add a
`Dependencies:` line to `shipit service list`. Check that line before treating a
`Failed to resolve import` as a code fault — the service will still report
`running`, and restarting it will not help.

**Compose services**: Project services (dev servers, databases, caches) run as
Docker Compose containers managed by ShipIt. Define them in
`docker-compose.yml`. See [compose.md](compose.md) for details.

**claude.ai connectors are off**: the connectors on the signed-in claude.ai
account (Gmail, Google Calendar, Drive, and similar) are **not** mounted as MCP
servers here. A session container is headless, so their OAuth flow can never be
completed from inside one — they would boot permanently unauthenticated, cost
startup time, and offer tools you cannot use. Do not tell the user to authorize
them; the capability is disabled by ShipIt, not merely unauthenticated. The MCP
servers you do get (Playwright, `present`, `voice_note`, and the rest) are
unaffected.

## Git LFS

`git-lfs` is installed and its filters are registered system-wide, so a repo that
tracks assets with Git LFS works normally: `git checkout` materializes real
content and committing a new tracked binary stores a pointer. ShipIt runs
`git lfs pull` when it provisions the workspace, so LFS-tracked files should
already hold their real bytes when your session starts.

It runs the same restore after anything ShipIt does that rewrites your working
tree from **outside** the session — a sync/rebase onto the base, a reset of a
merged branch, a rewind, a pull, a merge from another session, a release prepare.
Those run a git with the LFS smudge filter turned off, so without the restore
they would write pointer text over your assets.

The restore is best-effort. When it fails, ShipIt says so — a toast for a sync, a
note appended to the system message for a merged-branch reset — and then your
assets ARE stubs. Treat that message as a job: run `git lfs pull` before reading,
building with, or rendering any LFS-tracked file.

**A session forked from an LFS repo tells you the same way.** If the fork's
`git lfs pull` did not finish, your first turn starts with a `[System]` line
saying so and naming the cause. Read it as the same job: the tree looks complete
and every tracked file is present, so nothing else will tell you the contents are
pointers. If the line says ShipIt could not present a credential to the LFS
endpoint, that is a ShipIt fault worth reporting; if it says the LFS server
refused the credential, the connected GitHub account may simply not have access
to that repository's LFS storage.

**When they don't, you will see pointer stubs, not an error.** An LFS pointer is
a ~130-byte text file starting with `version https://git-lfs.github.com/spec/v1`.
That failure mode is easy to misdiagnose — images render broken, audio fails with
`Unable to decode audio data`, and the obvious suspects (sandbox networking,
headless-browser codec support, a corrupt asset) all look plausible. **Before
chasing any of those, check the file itself**:

```bash
head -c 120 path/to/asset.png     # a "git-lfs.github.com/spec/v1" header means it's a stub
```

If it is a stub, fetch the content rather than debugging the renderer:

```bash
git lfs pull
```

Two things make this hard to spot on your own, so check deliberately rather than
waiting to notice: the pointer in the index never changes, so `git status`
reports the tree **clean**, and only the paths a rewrite touched go stale while
every other LFS file keeps its real content.

A deployment can disable automatic LFS downloads (`SHIPIT_GIT_LFS=off`) to avoid
the bandwidth cost on asset-heavy repos; a manual `git lfs pull` still works.

## Session container lifecycle — idle containers are destroyed, not paused

When a session sits idle (no one viewing it and no agent turn running), ShipIt
may **stop and remove** its container to reclaim host resources. The UI may call
this "shutting down" or "pausing," but it is a full teardown — `docker stop` +
`docker rm`, **not** `docker pause`. The container is not frozen and later
thawed; it is deleted. When the user sends the next message, a **brand-new**
container is created and re-mounted onto the same host clone at `/workspace`.

**Idle time alone never causes this.** ShipIt reclaims only when it is over its
configured **memory budget** (Settings → Advanced; the whole machine when the
user has set none), and it takes the longest-idle session first. Two tiers, in
order: the session's **agent container** goes first and its Compose services
keep running — an idle session's preview stays up and reachable — and only if
that did not free enough does the **preview stack** stop too. So a session you
left an hour ago may still have both, and a preview may outlive the agent
container that started it.

The user can explicitly enable **Keep preview running** for a session from its
overflow menu. While enabled, ShipIt reserves that session's container and its
`x-shipit-preview: auto` Compose services across viewer disconnects, idle cleanup,
memory-pressure eviction, and orchestrator restarts. Capacity is deliberately
limited by the deployment (one reservation by default). This reservation is for
managed preview services only: arbitrary shell background processes still have
no durability guarantee and belong in `docker-compose.yml`.

**What this means for you:**

- **In-container background work does not survive.** Anything you start at
  runtime — a `setInterval`, a `sleep && …`, a backgrounded `node script.js`,
  a cron entry, a polling loop, an in-memory queue or timer — is killed on
  eviction and does **not** come back. The next message lands in a fresh
  container with none of it running.
- **`/workspace` (the git repo) and `/persist` (non-git scratch) persist** —
  both are host-backed and re-mounted onto the new container. In-memory state,
  processes, and files written *elsewhere* (outside `/workspace`, `/persist`,
  and declared volumes) are gone after eviction.
- **Only committed work is guaranteed.** ShipIt may reclaim an idle session's
  checkout for disk and re-clone it from git on the next message. Committed
  files come back, and so do the dependency directories declared in
  `agent.dep-dirs`; anything else that is gitignored — a `dist/`, a scratch
  file at the repo root — does not. Nothing warns you first, so put scratch that
  must survive in `/persist` and declare build output you depend on
  ([shipit-yaml.md](shipit-yaml.md) → Dependency directories).
- **There is no fixed grace period.** A session is reclaimed only when ShipIt
  is over its memory budget, and the longest-idle one goes first — so a timer
  may well outlive the turn that started it, and may equally be killed minutes
  later if the machine fills up. **Do not rely on either** — the cushion is
  incidental, not a guarantee.

**If something needs to keep running or run on every (re)start, declare it —
don't start it at runtime:**

| Need | Use |
|------|-----|
| Long-running process (dev server, scheduler, log tailer, queue worker) | A `docker-compose.yml` service — ShipIt rebuilds it on every container (re)start. See [compose.md](compose.md). |
| One-time setup on a fresh container (install, codegen, migrations) | `agent.install` in `shipit.yaml` — re-runs when a new container starts. See [shipit-yaml.md](shipit-yaml.md). |
| A recurring task the user wants run | Ask in chat — a new turn re-warms the container. |

A timer you install with a shell command is the wrong primitive: it's invisible
to ShipIt and dies on the next eviction. Move it into compose or
`agent.install` so it's reconstructed deterministically.

## Resource limits

Agent containers have default limits (1536 MB memory, 0.5 CPU, 256 PIDs) that
can be increased via the `agent` section in `shipit.yaml`. See
[shipit-yaml.md](shipit-yaml.md) for details. Service containers have their
own resource limits set in `docker-compose.yml`.
