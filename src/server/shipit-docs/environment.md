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

- **Writable:** `/workspace`, `/persist`, `/dep-cache`, `/session-state`,
  `/credentials`, and your home `/home/shipit` (including `~/.claude`, `~/.codex`,
  `~/.grok` and the npm global prefix at `~/.npm-global`). npm's cache is at
  `/session-state/npm-cache` for a repo-backed session — see
  [The npm cache is split](#the-npm-cache-is-split) — and at `~/.npm` otherwise.
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
| `/dep-cache` | Shared download cache across sessions for the same repo: yarn's cache and npm's *package content*. See [The npm cache is split](#the-npm-cache-is-split). |
| `/workspace/.pnpm-store` | **This session's own pnpm store.** Not shared with any other session — see [The pnpm store is yours alone](#the-pnpm-store-is-yours-alone). |
| `/session-state/npm-cache` | **`npm_config_cache` points here** — your session's own npm cache. Private to this session. |
| `/home/shipit` | Your home directory. Agent credentials (via symlink), npm global prefix, and caches live here. |

### The npm cache is split

`npm_config_cache` is `/session-state/npm-cache`, which only this session can
reach, and its `_cacache/content-v2` is a symlink to the repo's shared store under
`/dep-cache`. So npm's **resolution data** (which version and which bytes a name
resolves to) is yours alone, while downloaded **package content** is still shared
with the repo's other sessions — content is addressed by the hash of its own bytes
and re-hashed on every read, so sharing it cannot make you install something else.
Resolution data has no such property, and a session that could write yours would
be choosing what your `npm install` runs.

`npm install`, `npm ci`, `npm install <pkg>`, `npm install -g` and
`npm cache clean --force` all work normally. Three consequences to know:

- **`npm install --offline <pkg>` fails** with `ENOTCACHED` for a package this
  session has never resolved, even when another session has already downloaded it.
  Resolution is what is private; the download is not. Drop the flag, or use
  `--prefer-offline` (which is what ShipIt's own install command uses): it reads
  the cache first and asks the registry only for what is missing.
- **`npm cache verify` and `npm doctor` fail** on a split cache, with
  `Cannot read properties of null (reading 'toString')` — npm's garbage collector
  walks the content directory and does not expect it to be a link. Neither damages
  anything: the shared store is byte-identical afterwards. You do not need them —
  npm treats a bad cache entry as a miss and re-downloads, which is exactly what
  `cache verify` would repair. If a cache problem really is in the way, use
  `npm cache clean --force`, or `npm install --cache /tmp/fresh-cache` for a one-off.
- **`npm cache clean --force` removes the link** along with the rest of your cache
  (the repo's shared content is left intact). Your next install re-downloads
  privately; the link is restored the next time the container starts.

`yarn` is unaffected by this and still uses `/dep-cache` directly. `pnpm` has its own
arrangement — see below.

### The pnpm store is yours alone

In a repo-backed session, `/workspace/.pnpm-store` is **private to this session** — a
directory under this session's own state, mounted at that path because a `node_modules`
records the store it was built against and refuses another. No other session can read
or write it, so nothing another session installs can decide what yours does. It survives
a container restart and is removed with the session. (Elsewhere pnpm uses its own
in-container default, which is private too but does not survive a restart.)

Consequences for the commands you run:

- `pnpm install`, `pnpm add` and `pnpm store` all work normally, against your store.
  `pnpm store prune` and `pnpm store path` affect nothing outside this session.
- **Downloads are not shared with other sessions.** A cold container installs cold.
- You can edit a file inside an installed package — a `patch-package`-style fix, or
  instrumenting a dependency to debug it — and the edit stays in this session.
- The files under `node_modules` are **copies**, not hardlinks into the store
  (`stat -c %h <file>` reports 1), and this costs you nothing: your store is mounted
  separately from your workspace, and Linux refuses a hardlink across two mounts even when
  they sit on one filesystem, so pnpm copies here whatever it is asked to do. ShipIt sets
  `package-import-method=copy` explicitly on pnpm 10 and older, and on newer pnpm when a
  shared base is mounted (below), where the import has to cross the overlay as well.

That also answers the obvious worry about an **old `node_modules`**: it is a tree of copies
too, so nothing in it is shared with another session and there is nothing to rebuild. Edit
inside it freely.

`verify-store-integrity` is a local check on the store this session reads. It is left
at pnpm's default and is not a cross-session protection — the private store is.

ShipIt may also mount a shared `node_modules` **base** read-only under your own writable
layer. It builds one itself, from the repo's committed manifests and `pnpm-lock.yaml` at
the default-branch commit, after a session's declared install succeeds on that commit —
never from any session's installed tree, and only when every package in the lockfile is a
registry download whose digest the registry confirms. You still run your own
`pnpm install` over it, so your own lockfile and your own approved builds decide what the
tree ends up as, and everything above still holds.

**No new base is built** — so until one was published, every session installs from
scratch into its private store — when:

- the lockfile pins anything that is not a plain registry package (`workspace:`, `link:`,
  `file:`, a git URL, or a `patchedDependencies` entry);
- the repo loads pnpm plugin code (a `.pnpmfile.mjs`, `configDependencies`, or a
  `pnpmfile` setting in `.npmrc` / `pnpm-workspace.yaml`);
- the install output is not one self-contained `node_modules` (`modulesDir`,
  `virtualStoreDir` or a non-isolated `nodeLinker`), or `agent.dep-dirs` declares a
  directory besides `node_modules`;
- `.npmrc` points at a registry the operator did not authorize;
- `package.json` declares pnpm 10 or older, through `packageManager` or
  `devEngines.packageManager`. pnpm resolves its store as `<store>/v<N>` and records that
  path; pnpm 10 would recreate the whole tree rather than read a base pnpm 12 built.

Introducing one of these into a repo that already published a base stops the *next* base
from being built; it does not retire the one already published, so sessions keep mounting
it until the base is rebuilt or reclaimed.

Two things are decided from **your checkout** rather than the default branch, and each
means no base is mounted for this session at all: a checkout with **no `pnpm-lock.yaml`**
(with no lockfile pnpm would take its version choices from the base rather than resolving
your own), and a checkout declaring pnpm 10 or older. Only the manifest is read for that
second one — if you run an older pnpm through the command itself (`npx pnpm@10 install`),
the install still succeeds, but it recreates the tree instead of reading the base.

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
- **Agent CLIs** — the harnesses this install selected (`claude` / Claude Code, `codex` / Codex and `opencode` / OpenCode are installed by default; `grok` / Grok Build and `antigravity` / Antigravity are available but off by default, and an install can narrow or widen the set) are installed; ShipIt invokes whichever the user selected for the session

  Codex authentication has two modes — they are not interchangeable:

  - **ChatGPT subscription** (preferred). The user signs in with `Sign in with ChatGPT` in the UI; the credentials are written to `~/.codex/auth.json` (a symlink onto the credentials volume). Bills against their ChatGPT plan / Codex credits.
  - **OpenCode with ChatGPT** reuses the same connected OpenAI account and quota. ShipIt currently offers GPT-5.5 on this route. The image keeps the Codex CLI as a login and renewal dependency even when only the OpenCode harness is selected. This does not add Codex to the session picker. It gives OpenCode only an access token, account identity, and expiry; Codex's account machinery owns renewal. Managed OpenCode runs use a private XDG data root under `HOME/.local/share/opencode/shipit-data`. Terminal OpenCode logins do not configure this route. Use ShipIt's account settings and model selection; do not copy auth files. Existing conversation state is migrated automatically.
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

**pnpm repos re-validate on content, never on the commit alone.** For every other
package manager a container start skips `agent.install` when the commit it last ran on
is unchanged. A pnpm session does not: it skips only when the dependency *content* hash
matches, and `pnpm-workspace.yaml` is always part of that hash — so changing your build
approvals (`onlyBuiltDependencies`) re-runs the install that performs the build, even on
the same commit. The consequence to know about: if your `agent.install` is not
content-keyable (no `install-inputs`, and a command ShipIt cannot map to dependency
files), a pnpm session re-runs it on every container start. Declaring `install-inputs` in
`shipit.yaml` restores the skip.

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
head -c 120 path/to/asset.png
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

**Three things cause it, and the fastest one is not a timer.**

**Memory pressure**, the steady-state one: ShipIt reclaims when it is over its
**memory budget** (Settings → Advanced). With none set, the default is the whole
machine on a server deployment and half of it on a local install, where the user
is working on the same machine. `shipit settings get advanced.memoryBudgetMb`
reads what the user configured — a number, or `not set` meaning the default
above. It is the configured value, not the enforced one: ShipIt clamps a budget
larger than the host's memory, so quote the number as what was set rather than
as what is in force (`/shipit-docs/settings.md`). It takes the longest-idle session first. Two tiers, in
order: the session's **agent container** goes first and its Compose services
keep running — an idle session's preview stays up and reachable — and only if
that did not free enough does the **preview stack** stop too. So a session you
left an hour ago may still have both, and a preview may outlive the agent
container that started it.

**A ShipIt update**: when ShipIt itself is updated, every container left on the
old image that is genuinely idle at that moment is destroyed and *not* replaced —
regardless of how much memory is free. A fresh one starts when the session is
next opened. "Genuinely idle" excludes a live turn, a turn the agent woke itself
for, an outstanding background task, a running terminal, an `agent.install` in
flight, an attached viewer, and a session with **Keep preview running** enabled.

**Idle age**, on a much longer clock: a session untouched for **24 hours** drops
a disk tier, which disposes its runner and destroys its container (and by two
days to two weeks, depending on whether its work merged, reclaims the checkout
itself). This one *is* time-driven — the "no fixed grace period" below is about
the memory path, not this ladder.

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
- **A *tracked* background task defers memory-path reclaim — but it is not a
  job lifetime.** A job you start with the Bash tool's `run_in_background`
  (rather than a bare `&` or `nohup`) is reported to ShipIt, and while it is
  outstanding the session counts as busy and is not reclaimed for memory.
  Two limits. It holds only while the agent CLI process stays resident — when
  that exits, its background work dies with it and the count goes to zero at
  once. And ShipIt honours the last reported task list for **one hour after
  that list last changed**, not one hour per task: a running task emits nothing
  in between, not even when it prints output, so a single long job coasts on
  one timestamp — while any *other* task starting or finishing restarts the
  window for everything still outstanding. Treat it as cover for a build or a
  test run, never as a guarantee your job runs to completion. Nothing about it
  survives eviction once that does happen.
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
- **There is no grace period you can count on.** On the memory path a session
  is reclaimed only when ShipIt is over its budget, longest-idle first — so a
  timer may well outlive the turn that started it, and may equally be killed
  minutes later if the machine fills up. A ShipIt update can take it at any
  moment, and 24 hours idle takes it regardless. **Do not rely on any of it** —
  the cushion is incidental, not a guarantee.

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

Session containers are sized automatically from host capacity — the repo cannot
set its own limits, and there is no `shipit.yaml` field for them. Memory is a
generous ceiling (roughly half the host's usable RAM), PIDs are capped at 8192,
and CPU is capped at **about half the host's cores after a reserve**, so one
session running a full test suite cannot claim the whole machine and starve the
orchestrator.

A CPU quota does not narrow what most tools see, so `nproc` and Node's
`os.availableParallelism()` can report more cores than the container may
actually use. A pool sized from that number oversubscribes the quota, which
costs context switching and memory and can end up slower than a right-sized
pool. When a test run or build is CPU-heavy, pass an explicit worker count
(`vitest run --maxWorkers=4`, `make -j4` — bare `make -j` is unlimited, which is
worse) rather than letting the tool guess.

Service containers declared in `docker-compose.yml` are separate containers, so
they do **not** draw on the session's CPU budget — they get their own. ShipIt
gives them a low scheduling weight so they yield to the platform under
contention; set your own `deploy.resources` limits if a service needs a cap.
