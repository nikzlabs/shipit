# Environment

You are running inside a Docker container managed by ShipIt.

## Runtime user — non-root

You run as the unprivileged user **`shipit`** (UID/GID 1000), **not** root. Your
home directory is `/home/shipit`. `whoami` reports `shipit` and `id -u` reports
`1000`. This is a defense-in-depth boundary (docs/150): a prompt-injected or
mistaken shell command can't modify system paths or read root-only files.

What this means in practice:

- **Writable:** `/workspace`, `/persist`, `/dep-cache`, `/credentials`,
  and your home `/home/shipit` (including `~/.claude`, `~/.codex`, the npm
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
| `/credentials` | OAuth tokens (managed by ShipIt). Holds **only the credentials for this session's agent** — a Claude session sees `~/.claude` but not `~/.codex`, and vice versa. The agent is pinned on the first message and can't be changed afterward. Symlinked into your home (`~/.claude`, `~/.claude.json`, `~/.codex` → `/credentials/...`). Write-protected (see below). |
| `/dep-cache` | Shared npm/yarn/pnpm cache across sessions for the same repo. |
| `/home/shipit` | Your home directory. Agent credentials (via symlink), npm global prefix, and caches live here. |

### Write-protected paths

The Claude agent runs under an explicit permission policy (`/etc/shipit/managed-settings.json`). Editing under `/workspace` and elsewhere is unrestricted, but the file-edit tools (Edit/Write/MultiEdit/NotebookEdit) are **denied** on a few infrastructure paths:

- `/etc/shipit/**` — ShipIt's managed settings and hooks (the agent must not rewrite its own permission policy).
- The OAuth / CLI-config credential files: `~/.claude/.credentials.json`, `~/.claude/auth.json`, `~/.claude.json`, `~/.claude/settings*.json` (and the same files under `/credentials/.claude`, which `~/.claude` symlinks to).

These are infrastructure, not your project — you should never need to write to them. An attempt is refused with a permission error rather than silently succeeding.

Note: your own memory under `~/.claude/projects/<cwd>/memory/` is **not** restricted — the deny list targets the specific credential files, not the whole `~/.claude` tree, precisely so memory updates keep working. Confidentiality of the credentials (reads, exfil) is handled at the network/credential layer, not by these file-edit rules.

## Installed tools

- **Node.js 24** (with npm; `pnpm` and `yarn` are available via corepack — it reads the repo's `packageManager` field and fetches the pinned version)
- **git**, **curl**
- **python3**, **make**, **g++** (for native npm addons)
- **Agent CLIs** — both `claude` (Claude Code) and `codex` (Codex) are installed; ShipIt invokes whichever the user selected for the session

  Codex authentication has two modes — they are not interchangeable:

  - **ChatGPT subscription** (preferred). The user signs in with `Sign in with ChatGPT` in the UI; the credentials are written to `~/.codex/auth.json` (a symlink onto the credentials volume). Bills against their ChatGPT plan / Codex credits.
  - **`OPENAI_API_KEY` env var**. Bills against their OpenAI Platform account. ShipIt only injects this into the agent process when no ChatGPT login is present — when both are configured, the env var is stripped so the user isn't double-billed.
- **Playwright** with headless Chrome (available via browser tools)
- **Android build toolchain** — JDK 17 (`JAVA_HOME=/opt/java`), the Android SDK (`ANDROID_SDK_ROOT=/opt/android-sdk` — `sdkmanager`, `adb`, platforms 34/35, build-tools), and Gradle 8.7. Always present, so any Android/Gradle repo builds, lints, and runs JVM/snapshot tests with no per-repo setup (no `shipit.yaml` Android fields). See [android.md](android.md).

## Automatic behaviors

**Git commits**: ShipIt auto-commits your changes after each turn. Do not run
`git commit`, `git add`, or `git push` — this is handled automatically. The
commit message is derived from your turn summary.

**Hot reload**: When you edit files, compose services with mounted volumes
pick up changes automatically. No need to restart dev servers after code edits.

**Dependency detection**: Changes to a dependency file — a lockfile
(`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) or the manifest your
install reads — trigger an automatic install + service restart (throttled with
a 30s cooldown). This covers **git operations** (`git reset`/`checkout`/`rebase`
that change the dependency tree), not just direct edits — so a reset to a commit
that added a dependency reinstalls and restarts the preview automatically.

**Compose services**: Project services (dev servers, databases, caches) run as
Docker Compose containers managed by ShipIt. Define them in
`docker-compose.yml`. See [compose.md](compose.md) for details.

## Session container lifecycle — idle containers are destroyed, not paused

When a session sits idle (no one viewing it and no agent turn running), ShipIt
**stops and removes** its container to reclaim host resources. The UI may call
this "shutting down" or "pausing," but it is a full teardown — `docker stop` +
`docker rm`, **not** `docker pause`. The container is not frozen and later
thawed; it is deleted. When the user sends the next message, a **brand-new**
container is created and `/workspace` is re-cloned from git.

**What this means for you:**

- **In-container background work does not survive.** Anything you start at
  runtime — a `setInterval`, a `sleep && …`, a backgrounded `node script.js`,
  a cron entry, a polling loop, an in-memory queue or timer — is killed on
  eviction and does **not** come back. The next message lands in a fresh
  container with none of it running.
- **`/workspace` (the git repo) and `/persist` (non-git scratch) persist** —
  `/workspace` via re-clone, `/persist` because it's host-backed and re-mounted.
  In-memory state, processes, and files written *elsewhere* (outside `/workspace`,
  `/persist`, and declared volumes) are gone after eviction.
- **There is a grace period of 10 minutes** after the last viewer detaches
  before a container becomes eligible for eviction (host memory pressure can
  cut this short). A short-lived timer may fire within that window, but **do
  not rely on it** — it is a cushion, not a guarantee.

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

Agent containers have deployment-owned default limits (1536 MB memory, 0.5 CPU,
4096 PIDs). Operators can change them with `MAX_SESSION_MEMORY_MB`,
`MAX_SESSION_CPU`, and `MAX_SESSION_PIDS` on the ShipIt deployment. These are
not repository settings in `shipit.yaml`. Service containers have their own
resource limits set in `docker-compose.yml`.
