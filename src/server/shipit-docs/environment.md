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
| `/persist` | **Persistent, non-git scratch.** Writable; survives container restarts and checkout reclaim, but is never committed. Put files here that the user should still see tomorrow without polluting the repo (e.g. presented artifacts you don't want tracked). It is kept while the session is in use. After the session is archived or finished, ShipIt deletes it when a retention period ends — see [What survives what](#what-survives-what). A Compose service can mount it too: the `persist` volume in [compose.md](compose.md). |
| `/uploads` | User-uploaded files (outside git, never committed). **Read-only** — read attachments here, but copy elsewhere to modify. It has the same retention period as `/persist`. |
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
  `package-import-method=copy` explicitly on pnpm 10 and older.

That also answers the obvious worry about an **old `node_modules`**: it is a tree of copies
too, so nothing in it is shared with another session and there is nothing to rebuild. Edit
inside it freely.

`verify-store-integrity` is a local check on the store this session reads. It is left
at pnpm's default and is not a cross-session protection — the private store is.

**A pnpm session may get a shared `node_modules` base**, when ShipIt has built and verified one
for this repo, runtime and commit: a read-only tree under your own writable layer, so a warm
session skips most of the download. Your layer is on top, so a write to any file in it copies
that file up into your session and reaches no one else. A repo with no lockfile, pinned to
pnpm 10 or older, or with no verified base published gets none and installs privately instead —
the install works either way, it is just not warm, and there is nothing to configure.

**Everything you would do to `node_modules` still works, whether or not a base is under it.**
`pnpm install`, `pnpm add`, `pnpm rebuild` and `pnpm install --force` all behave normally, and
editing a file inside an installed package (a `patch-package`-style fix, or changing a
dependency to debug it) works and stays in your session. ShipIt pre-copies the base's
executable files into your own layer at container start precisely so that pnpm's `.bin`
relinking — which `chmod`s every one of them — operates on files your session owns.

The base is published **unbuilt**: its packages are installed with `--ignore-scripts`, so your
own `agent.install` runs over it and any install-time build runs here, as you. If a `pnpm`
command ever fails with `Operation not permitted` on a file under `node_modules`, that is
ShipIt's layer and not your repo — say so rather than working around it.

**A base deliberately does not carry every package.** Any dependency with an install-time build —
a `preinstall`/`install`/`postinstall` script, a `binding.gyp`, a `.hooks/` file — is left out of
it, because a shared read-only tree cannot carry the result of running one. Your own install
downloads exactly those into this session's private store and **builds them here, as you**, and the
rest of the tree is the shared base. So expect the first install after a container start to do
some real work rather than finish instantly, and expect a native package to be compiled or
downloaded in this session; that is the design, not a cache miss. Nothing about it needs
configuring, and every `pnpm` command still behaves normally.

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
  - **OpenCode with ChatGPT** reuses the same connected OpenAI account and quota. The image keeps the Codex CLI as a login and renewal dependency even when only the OpenCode harness is selected. This does not add Codex to the session picker. It gives OpenCode only an access token, account identity, and expiry; Codex's account machinery owns renewal. Managed OpenCode runs use a private XDG data root under `HOME/.local/share/opencode/shipit-data`. Terminal OpenCode logins do not configure this route. Use ShipIt's account settings and model selection; do not copy auth files. Existing conversation state is migrated automatically.
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
container start. To pick up a new pin, restart the agent container — see
[Restarting your agent container](#restarting-your-agent-container).

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

**ShipIt's pushes upload LFS objects first, and stop when the upload fails.**
Every push ShipIt makes for you (the auto-push after a turn, opening a pull
request, the force-push after a sync) runs `git lfs push` before it pushes the
branch. If that upload fails, the branch is **not pushed**: without its objects
the remote would name LFS files that no store holds, and every other clone would
get pointer stubs with a clean `git status`. The commits stay in the session's
local history, a notice in the chat quotes git-lfs's error, and every later push
retries the upload first. An upload still running after ShipIt's LFS time limit
(five minutes unless the deployment changed it) is stopped and counts as failed;
the notice then names the limit instead of an error. Objects that finished
uploading are not sent again. A branch that adds no new LFS objects still pushes
while the LFS server is down. To investigate, run `git lfs push origin <branch>`
and read its error. Do not get around it by pushing with the LFS upload skipped
(`--no-verify`, `GIT_LFS_SKIP_PUSH`); that publishes exactly the stubs this
refusal prevents.

Moving a repository to a new LFS server does not copy the objects already
pushed. A push uploads only the objects of commits the remote does not have yet,
so a commit that changes `lfs.url` and adds no LFS file uploads nothing.
`git lfs push --all origin` does not copy them either: with no ref named it
reads local refs only, and a session checkout has few local branches. It skips
the objects of the other remote branches, and fails with `(missing)` on an
object that neither the local store nor the new server holds. Instead, list
every object of every branch and tag, get the ones the local store lacks from
the old server, and push the list to the new server by object id:

```bash
git fetch --tags origin
git lfs ls-files --all --long | cut -d' ' -f1 | sort -u > /tmp/oids
git -c lfs.url=<old LFS URL> lfs fetch --all origin
git -c lfs.url=<new LFS URL> -c lfs.pushurl=<new LFS URL> \
  lfs push --object-id origin --stdin < /tmp/oids
```

For GitHub the old URL is `https://github.com/<owner>/<repo>.git/info/lfs`, and
GitHub bills that fetch as a download. Then check the result: send the new
server a download batch request (`POST <new LFS URL>/objects/batch`,
`"operation": "download"`) with the `oid` and `size` of every object, which
`git lfs ls-files --all --json` lists. Each object must come back with a
`download` action. Write the new `lfs.url` into `.lfsconfig` only after that
check passes. ShipIt commits the file when the turn ends, also when the turn
fails part-way, and a clone that reads the new `lfs.url` before the new server
holds the bytes gets pointer stubs with a clean `git status`.

Branches made before the move can need the copy again. A sync rebases such a
branch onto the new `lfs.url`, and the upload before its force-push sends every
LFS object of the rebased commits to the new server. If neither the session's
store nor the new server holds one of them, that upload fails with `(missing)`
and ShipIt does not push: run the copy in that session. A merge of the base into
the branch rewrites no commit, so the upload sends only the objects of commits
not pushed before. So a branch that reaches the base with no sync after the
move, or with only such a merge, makes the base name objects the new server
lacks. The list covers every remote branch, so run the copy and the check again
before such a branch merges, or immediately if it merged already. On a repeat,
also run `git lfs fetch --all origin` before the push: the push by object id
stops on an id the local store does not hold, and the new server then has
objects of its own.

**LFS objects are shared between sessions on one host.** ShipIt keeps one LFS
object store per repository per ShipIt host, beside its bare git cache. This is
what to use when you estimate LFS download volume:

- **What the store downloads.** The objects at the tip of the default branch,
  and nothing else: no other branch, no history. It fetches in the background
  every 3 minutes and right after a session's pull request merges, and it
  downloads only objects it does not hold yet.
- **What a new session gets.** Its clone hardlinks **every** object the store
  holds, not only those at its HEAD, so a workspace can show objects from old
  commits, all with a link count above 1 and older than the workspace. The
  session's own `git lfs pull` then downloads only what its checkout needs and
  the store lacked: objects on its branch but not on the default-branch tip.
- **What a fork gets.** The same links as a new session: the fork's clone of its
  parent's workspace hardlinks every object the store holds, and its
  `git lfs pull` downloads the rest. It gets nothing from the parent's own
  `.git/lfs`, so an object the parent committed but has not pushed yet stays a
  pointer stub in the fork until the parent pushes and the fork runs
  `git lfs pull`.
- **Objects a session creates** are uploaded by its push. Each host downloads
  them once more when they reach the default branch.
- **How long objects stay.** An object leaves the store only when no workspace
  on the host links it any more and it was downloaded more than 14 days ago
  (`DISK_JANITOR_LFS_OBJECT_DAYS`). Because every clone links every object, the
  store keeps an object while any workspace of that repository on the host exists.
- **A host with an empty store** (a new host, or one whose repository cache was
  reclaimed): the first sessions cloned before the store's first fetch link
  nothing and download every object at their HEAD themselves, and the store then
  downloads the default-branch tip's objects again. Expect about two full
  downloads of the tip's objects for the first session on a host, then only
  what is new.

A deployment can turn sharing off (`SHIPIT_GIT_LFS_SHARED_STORE=off`); then every
session downloads its own objects.

**An LFS server that is not GitHub needs an `lfs` declaration.** ShipIt
presents its GitHub credential to `github.com` only. A repository whose
committed `.lfsconfig` sets `lfs.url` to another host gets a credential for that
host only when `shipit.yaml` declares it:

```yaml
lfs:
  host: lfs.example.com
  credential: LFS_CREDENTIAL
```

The user stores the secret `LFS_CREDENTIAL` in **Project Settings → Secrets**
as one credential-store line, `https://<username>:<password>@lfs.example.com`.
ShipIt then presents it on its own uploads and downloads, and your `git lfs`
gets it through ShipIt's credential helper. Details and the refusal rules are in
`/shipit-docs/shipit-yaml.md` § `lfs`. The session reaches the host only if the
user allows it, and the storage host its server redirects downloads to (for
Cloudflare R2, the bucket's `r2.cloudflarestorage.com` or custom-domain host),
in the egress settings. Without the declaration, or when the secret names
another host, an LFS server that requires authentication fails ShipIt's uploads
and downloads, and the push refusal above says why.

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

### What survives what

`/persist` is the session's `scratch` directory on the host. A Compose service
that mounts the `persist` volume sees the same directory, so it has the same
lifecycle. A project's own named volumes are different:

| Event | `/persist`, and `persist` mounts in services | The project's named Compose volumes |
|---|---|---|
| Container restart (idle reclaim, a ShipIt update, Restart all, Restart agent container) | Kept | Kept |
| Idle reclaim that also stops the preview stack | Kept | Kept |
| 24 hours idle | Kept | Can be deleted |
| Checkout reclaim, then a fresh clone | Kept | Kept |
| Archive | Kept for the retention period, then **deleted** | Can be deleted |
| Restore from the archive | Kept, as it was, if the period did not end. Empty after that | Empty, if they were deleted |
| The pull request merged or closed, and the session was not used since | Kept for the retention period, then **deleted** | Can be deleted |
| Delete — there is no separate session delete; removing a repository archives its sessions | As archive | Can be deleted |
| **Full reset** (Settings → Advanced) | **Deleted** | Deleted |

So data that the session needs while it is in use goes in `/persist`, and a
service that must keep data mounts `persist` instead of declaring a named
volume. `/persist` is not an archive: data that must stay after the session is
finished belongs in git, or outside ShipIt.

### The retention period for `/persist` and `/uploads`

ShipIt deletes everything in `/persist` and `/uploads` when the retention
period of the session ends. That includes what a Compose service wrote through
a `persist` mount.

- **Which sessions.** A session that the user archived, and a session that is
  finished: its pull request merged or closed and it was not used since. A
  pinned session, and a session with **Keep preview running**, is not finished.
  A session in use keeps its files with no time limit.
- **How long.** 60 days. 14 days when the files use 100 MB or more. The person
  who deploys ShipIt can change these values.
- **From when.** For an archived session, from the archive. For a finished
  session, from the merge or close, or from the last time it was used or
  opened, the latest of these. A message in the session starts a new period.
- **What the user sees.** The session's row in **All sessions** shows the date.
  After the deletion, the transcript has a notice that says what was deleted,
  and your next turn in that session starts with a `[System]` line that says
  the same.
- **A sandbox session that has no remote** also loses its `/workspace` checkout
  when the period of its archive ends, because that checkout has no other copy.
  Restore gives it an empty workspace.

When a session holds data that the user must not lose — generated media that
cost money to make, a database file — say so before they archive it, and before
its pull request merges. To keep the data, the user restores or opens the
session before the date, or pins it.

### Restarting your agent container

When a change applies only from the next container start, restart the agent
container yourself — do not ask the user to:

```bash
shipit session restart --note "check that node -v prints 22, then run the tests"
```

That records the request; ShipIt restarts the agent container **after your
turn ends**, so the turn that asked is not cut off. The preview services keep
running. ShipIt then starts a new turn on the new container with your note, so
write in it what to check or do next. Say in your reply what you restart and
why. See [sessions.md](sessions.md) → `shipit session restart`.

You cannot ask for **Restart all** (it also stops and restarts the Compose
stack). When a session is wedged, or restarting the agent container did not
help, ask the user, and name the button and where it is: **Restart all**, on
the health strip at the top of the **Terminal** tab. Never say only "restart
the container" — the user cannot tell which control that means. To restart a
single preview service, use `shipit service restart <name>`.

Where ShipIt shows a **Restart to apply now** button next to the change itself
(Session settings, a plugin host grant card), point the user to that button
instead.

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

## Network

In both Network modes, no container in this session — this one, its Compose
services, plugin containers, and containers started with Docker access — can
reach the machine that runs ShipIt, private networks (the LAN, `10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`, link-local) or the tailnet. This keeps code
running in a session away from ShipIt's host and the user's other machines.
From this container, what stays reachable:

- ShipIt itself at `$SHIPIT_HOST:$SHIPIT_PORT`, and this session's own services
  on the session network, by their Compose service name (`http://dev:3000/`;
  a name with a dot, such as `dev.local`, does not resolve in a Contained
  session) or by the `url` ShipIt lists for them ([preview.md](preview.md)).
  Never through a port published on the host.
- An SSH destination granted to this session, on its SSH port only
  ([ssh.md](ssh.md)).
- The internet: any host in an **Open** session, the allowlist in a
  **Contained** one. An allowlisted name whose address is private stays blocked.

So a refused or timed-out connection to a local address is this block, not a
network fault, and no allowlist entry changes it. Tell the user which address
the work needed and why. If it is a machine they reach over SSH, a destination
grant in Session settings is the way in.

A host that cannot run ShipIt's egress sidecar cannot apply this block. There
ShipIt listens only on loopback, and contained sessions do not start. A Compose
service given the Docker socket controls this machine, so none of this holds
for it ([compose.md](compose.md)).
