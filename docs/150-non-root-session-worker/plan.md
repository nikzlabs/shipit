---
title: Non-root session worker runtime
description: Run the session worker, agent CLI, terminal, install hooks, and MCP servers as an unprivileged user instead of root.
issue: https://linear.app/shipit-ai/issue/SHI-31
---

# 150 — Non-root Session Worker Runtime

## Problem

Session worker containers currently run as root. The container is already
hardened with resource limits, `no-new-privileges`, dropped capabilities, and a
per-session filesystem mount, but the worker process and every child it spawns
still execute as UID 0.

This increases blast radius for prompt-injected shell commands and ordinary
agent mistakes:

- System paths inside the container can be modified more easily.
- Root-only files are readable by the worker, agent CLI, terminal, install
  command, and MCP subprocesses.
- Generated files on writable mounts can become root-owned.
- Several runtime paths are coupled to `/root`, making future credential and
  filesystem isolation work harder.

This is defense-in-depth, not a complete sandbox boundary. The active agent's
own credential is intentionally present in the session container, and network
egress is still unrestricted. Non-root reduces local container blast radius; it
does not replace credential brokering or egress controls.

## Current State

The root assumption is spread across the image and process launch code:

- `docker/Dockerfile.session-worker.{dev,prod}` creates `/workspace` and
  `/credentials`, then symlinks `/root/.claude`, `/root/.claude.json`, and
  `/root/.codex` into `/credentials`.
- `container-lifecycle.ts` sets `HOME=/root` in the container environment.
- `claude.ts` and `terminal.ts` override child process envs back to `HOME=/root`.
- `codex-adapter.ts` checks `/root/.codex/auth.json`.
- `session-worker.ts` writes Codex MCP config under `CODEX_HOME` or
  `/root/.codex`. `installMcpPackage` shells out to `npm install -g` without a
  prefix override, relying on UID 0 to write into `/usr/local/lib/node_modules`.
- `agent.install`, MCP package installs, browser tools, and terminal shells all
  inherit the root-oriented environment.
- Playwright MCP browsers are downloaded at image build into the building
  user's cache (`/root/.cache/ms-playwright`); runtime currently finds them
  because the worker runs as root.

The **orchestrator container** is a separate concern. It also runs as root
today, but it spawns no agent code on the user's behalf (in containerized
mode) — its `/root/.claude`, `/root/.claude.json`, `/root/.codex`,
`GIT_CONFIG_GLOBAL`, and `auth.ts`/`codex-auth.ts` references are not in
scope for this doc. The dogfood/local-mode caveat in
[Rollout](#rollout) below covers the one path where the orchestrator
*does* host agent processes.

The Docker host config already drops all capabilities, then adds back a small
set including `CHOWN`, `SETUID`, `SETGID`, `FOWNER`, `DAC_OVERRIDE`,
`NET_BIND_SERVICE`, and `KILL`. Once the worker runs unprivileged, most of those
add-backs should be revisited.

## Goals

1. Run the session worker process as a stable unprivileged user, e.g.
   `shipit` with UID/GID 1000.
2. Run all user-controllable child processes under the same unprivileged user:
   Claude, Codex, terminal shell, `agent.install`, MCP servers, Playwright MCP,
   and MCP package installs.
3. Preserve existing behavior for workspace writes, dependency installs, native
   addon builds, browser tools, Git operations, and agent authentication.
4. Remove hardcoded `/root` assumptions from session runtime code.
5. Avoid introducing passwordless sudo or broad privilege escalation paths.

## Non-goals

- Removing the active agent's own credential from the container.
- Implementing network egress filtering.
- Making `/credentials` read-only.
- Changing the orchestrator trust boundary or Docker-per-session architecture.
- Changing user compose service users. This doc covers the agent/session worker
  container, not user-declared service containers.

## Design

### 1. Add a dedicated runtime user

The `node:24-slim` base image already ships a `node` user at UID/GID 1000
(see [the upstream Dockerfile][node-docker]). Reusing that account avoids a
useradd collision and matches the upstream convention that "the
unprivileged identity in a node image is `node`". We rename it for clarity:

```dockerfile
RUN groupmod --new-name shipit node \
 && usermod --login shipit --move-home --home /home/shipit node \
 && chown -R shipit:shipit /home/shipit
```

Alternatively, `useradd --non-unique --uid 1000 …` after `userdel -r node`
works too, but the rename keeps the upstream user's existing home and
shell. Either way the runtime UID is stable at 1000, the home directory is
`/home/shipit`, and the doc never has to special-case "which 1000 user are
we talking about".

[node-docker]: https://github.com/nodejs/docker-node/blob/main/24/bookworm-slim/Dockerfile

### 2. Use a root entrypoint only for mount preparation

The safest migration is a tiny root entrypoint that prepares writable mounted
paths, then drops privileges before launching the worker. The session-worker
base image is `node:24-slim` (Debian), so use `gosu` (`apt-get install -y gosu`,
pinned) — `su-exec` is Alpine-only and not available via apt.

```sh
#!/bin/sh
set -eu

mkdir -p /workspace /uploads /dep-cache /credentials /home/shipit

# Skip the recursive chown on already-initialized mounts. `/workspace` and
# `/dep-cache` can hold large `node_modules` trees on warm reuse; chowning
# them on every boot is wasteful and, for `/dep-cache`, racy across
# concurrent sessions sharing the same dep cache. Atomic-claim via `mkdir`
# of the sentinel directory: only the winner of the race performs the walk,
# losers `mkdir` returns non-zero and they skip the chown.
#
# The `SHIPIT_SKIP_WORKSPACE_CHOWN` env var lets dev/local-mode launchers
# opt out of the `/workspace` chown when the host has bind-mounted the
# developer's source tree — chowning a bind mount rewrites *host*
# filesystem ownership, which is destructive in dev. The orchestrator sets
# this env var when `buildMounts()` falls through to the bind-mount branch
# (no `workspaceVolume`).
for d in /workspace /uploads /dep-cache /credentials /home/shipit; do
  case "$d" in
    /workspace) [ "${SHIPIT_SKIP_WORKSPACE_CHOWN:-0}" = "1" ] && continue ;;
  esac
  marker="$d/.shipit-uid-1000"
  if mkdir "$marker" 2>/dev/null; then
    chown -R shipit:shipit "$d"
    chown shipit:shipit "$marker"
  fi
done

exec gosu shipit:shipit "$@"
```

`SHIPIT_SKIP_WORKSPACE_CHOWN` exists because the entrypoint cannot
distinguish a tmpfs/volume-backed `/workspace` from a bind mount — it just
sees a directory. Letting `chown -R` run on a bind-mounted dev source
tree would change ownership of the developer's working copy on the host.
`buildMounts()` falls through to bind-mount mode not only for
`/workspace` but also for `/uploads`, `/credentials`, and `/dep-cache`
when `workspaceVolume`/`credentialsVolume` is unset — so the same flag
covers all four mounts in dev/dogfood mode. The orchestrator sets it
whenever it falls through to the bind-mount branch.

Note: dev mode therefore bypasses the non-root hardening end-to-end.
The container still drops to `shipit`, but the bind-mounted dirs stay
host-owned and `shipit` may lack write permission on them. Dev-mode
users either pre-chown the bind-mounted directories to UID 1000, set
their directory modes `0777`, or accept that dev mode bypasses the
non-root hardening. This is a deliberate tradeoff: protecting the
developer's host filesystem is more important than enforcing the
container hardening in a non-production environment.

The dep-cache sentinel uses `mkdir` for an atomic claim (only one of N
racing entrypoints wins) — but that only deduplicates the chown walk; it
does **not** make the cold-start race safe in the general case. If two
sessions for the same repo boot concurrently against a fresh `/dep-cache`,
the winner walks while the loser proceeds to `npm install` and writes
into the tree the walker is touching. The walk can skip newly-created
files or chown them mid-write. In practice the orchestrator serializes
warm-pool reactivation so this race is unlikely, but the safer fix is to
move `/dep-cache` ownership setup to an orchestrator-side step that runs
under a per-repo lock before the container is started.

Wire it up in every session-worker Dockerfile:

```dockerfile
COPY docker/session-worker/entrypoint.sh /usr/local/bin/shipit-entrypoint
RUN chmod 0755 /usr/local/bin/shipit-entrypoint
ENTRYPOINT ["/usr/local/bin/shipit-entrypoint"]
```

The explicit `ENTRYPOINT` matters: `container-lifecycle.ts` creates each
container with `Cmd: ["node", "--import", "tsx", …]`. Dockerode's `Cmd`
overrides the Dockerfile's `CMD` but **not** its `ENTRYPOINT`. Without an
`ENTRYPOINT` line the entrypoint script never runs and the worker boots
as root.

The entrypoint should only touch writable runtime mounts and the runtime home
directory. It must not recursively chown `/app`, `/usr/local/bin`,
`/opt/agent-cli`, or system directories.

`/credentials` is included in the sentinel-gated loop as a one-shot
bootstrap — it fixes the initial scaffold the orchestrator wrote before the
container started, and never runs again. **Any future orchestrator writer
into a per-session credentials subtree must route through the chown helper
in §7**, or the file will land `root:root` and stay unreadable to `shipit`
until session reset.

After this point, the worker process is non-root. The Dockerfile can either keep
the final `USER root` for the entrypoint and drop inside the script, or use a
minimal init wrapper. The important boundary is that `session-worker.ts` and its
children do not run as UID 0.

### 3. Introduce a single agent home constant

Replace hardcoded `/root` with one source of truth. **Resolve at call time, not
at module load**, because `codex-adapter.ts` and the agent registry are also
imported by the local-mode orchestrator (see step 9 below) which keeps
`AGENT_HOME=/root`:

```ts
export const DEFAULT_AGENT_HOME = "/home/shipit";
export function agentHome(): string {
  return process.env.AGENT_HOME || DEFAULT_AGENT_HOME;
}
```

Use this in:

- `container-lifecycle.ts` env builder (sets the env the container inherits).
- `claude.ts` child env.
- `terminal.ts` child env.
- `codex-adapter.ts` auth path (the `hasCodexFileAuth()` probe and the
  comment that points readers at `/root/.codex/auth.json`).
- `session-worker.ts` Codex MCP config path.
- Agent registry CLI credential probes that share `codex-adapter` constants.

Set both `HOME=/home/shipit` and `AGENT_HOME=/home/shipit` in the session
container environment. Keep `CODEX_HOME` optional, but default it to
`${agentHome()}/.codex`.

**Out of scope:** `src/server/orchestrator/auth.ts`,
`src/server/orchestrator/codex-auth.ts`,
`src/server/orchestrator/session-namer.ts`, and
`src/server/orchestrator/platform-credentials.ts` (which hardcodes
`/root/.claude` for the `platform:claude_oauth` MCP source) deliberately
keep their hardcoded `/root` paths. These run only inside the
orchestrator container (which this doc does not move off root) and the local-mode
caveats below depend on `/root` remaining the orchestrator's HOME.
`auth.ts` also depends on `HOME=/root` as an environment fallback (see
the `pty.spawn` env override and the symlink-target `readlinkSync`/`mkdirSync`
around `CLAUDE_CONFIG_DIR`), not just the hardcoded constant — a future
contributor "normalizing" the constant must leave the env fallback alone.

`session-worker.ts:463` calls `os.homedir()` to find `~/.codex/skills`.
The call resolves dynamically against the current `HOME`, so with
`HOME=/home/shipit` and the §4 symlink (`/home/shipit/.codex ->
/credentials/.codex`) it reaches the right place without code changes —
but the inline comment there asserts the path resolves to `/root/.codex`,
which will mislead a future reader. Update the comment to reflect the
migrated HOME.

### 4. Move credential symlinks to `/home/shipit`

Dockerfiles should create:

```sh
ln -s /credentials/.claude /home/shipit/.claude
ln -sf /credentials/.claude.json /home/shipit/.claude.json
ln -s /credentials/.codex /home/shipit/.codex
chown -h shipit:shipit /home/shipit/.claude /home/shipit/.claude.json /home/shipit/.codex
```

The per-session credential subtree remains mounted at `/credentials`. Existing
first-turn credential provisioning from doc 138 still applies; this change only
moves the home-directory views of those credentials.

### 5. Keep writable caches explicit

Continue using the existing cache env vars for package managers:

- `npm_config_cache=/dep-cache/npm`
- `YARN_CACHE_FOLDER=/dep-cache/yarn`
- `PNPM_STORE_DIR=/dep-cache/pnpm`

These paths must be owned by `shipit` before install commands run. This matters
for warm-pool preinstall, `agent.install`, ad-hoc terminal installs, and MCP
package installs.

### 6. Allow `npm install -g` for MCP packages as a non-root user

`SessionWorker.installMcpPackage` runs `npm install -g <pkg>` to satisfy the
`mcp.servers[].npmPackage` install path used by the integrated MCP catalog
(docs/088 / docs/MCP install hook). The default global prefix is `/usr/local`,
owned by root — installs as `shipit` would fail with EACCES.

Move npm's global prefix into the runtime user's home, in every session-worker
Dockerfile:

```dockerfile
ENV NPM_CONFIG_PREFIX=/home/shipit/.npm-global
ENV PATH=/home/shipit/.npm-global/bin:${PATH}
RUN mkdir -p /home/shipit/.npm-global /home/shipit/.npm \
 && chown -R shipit:shipit /home/shipit/.npm-global /home/shipit/.npm
```

`/home/shipit/.npm` is npm's per-user cache (separate from the
`npm_config_cache=/dep-cache/npm` env var that targets workspace installs).
The agent's terminal also picks up `NPM_CONFIG_PREFIX`, so manually-installed
CLIs land in the same place.

`installMcpPackage` spawns `npm install -g` without an explicit cwd and
inherits the worker's `/app`. `/app` is owned by root post-migration and not
writable to `shipit`. `NPM_CONFIG_PREFIX` redirects the install target, but
the cwd's own `package.json` can subtly affect resolution. Pass
`cwd: agentHome()` (i.e. `/home/shipit`, which is already chowned and
writable) when spawning to keep the install hermetic — `/tmp` would also
work in principle, but some hardened base images mount `/tmp` as `tmpfs
noexec`, which would break npm lifecycle scripts.

### 7. Cross-container credential ownership

The orchestrator writes into each session's `/credentials` subtree at
runtime — both at provisioning time and on every turn. Concretely:

- `provisionAgentCredentials` (`session-credentials.ts`) `cpSync`s
  `/.claude`, `/.claude.json`, `/.codex` from the orchestrator's
  credentials root into the per-session subtree on the first turn.
- `syncAgentTokenIn` / `syncAgentTokenBack` (`session-credentials.ts`)
  `atomicCopyFile` the rotating OAuth token files in and out at every turn
  boundary.
- `writeContainerGitConfig` (`git-config.ts`) writes
  `/credentials/.gitconfig` with mode `0o600`.

These run inside the orchestrator container, which stays as root, so the
files land owned by `root:root`. Node's copy primitives preserve source
modes, and the upstream CLI credential files are `0600 root:root`. The
session container's entrypoint chown happens *only at boot*, so any
orchestrator-side write after the container starts is invisible to the
`shipit` user — auth, identity, and the brokering git credential helper all
break the first time the orchestrator refreshes the subtree.

Fix on the **writer** side, not the reader side: have every orchestrator
function that writes into a per-session credentials subtree chown its
output to UID/GID 1000 right after writing.

- Add a single helper in `session-credentials.ts`
  (`chownSessionCredentialsTree(sessionId)`) that recursively chowns the
  per-session dir to 1000:1000. Call it at the end of
  `ensureSessionCredentialsScaffold`, `provisionAgentCredentials`,
  `syncAgentTokenIn`, `syncAgentTokenBack`, and `repushAgentToken`. Any
  future writer that touches the per-session subtree must call it too,
  including any archive-restore path that recreates the subtree after a
  disk-janitor sweep — the entrypoint's sentinel-gated chown only runs at
  container start, so post-boot recreates need the orchestrator-side
  helper to do the work.
- Extend `writeContainerGitConfig` to chown the destination file to
  1000:1000 **after** all `git config --file <destPath> …` writes finish
  (keep the `0o600` mode — the only reader is `shipit`). Chowning between
  the empty-write and the subsequent `git config` calls would have the
  root orchestrator writing into a 1000-owned file; works today but is a
  trap if a future maintainer reorders the steps.
- Apply the same writer-side chown to user uploads.
  `services/files.ts:saveUploadedFile` `fs.writeFile`s into the
  per-session uploads dir from the orchestrator container; without a
  chown those files land `root:root` and the agent (running as `shipit`)
  cannot read its own attachments. Add a `chown(filePath, 1000, 1000)`
  call after the write, behind the same gating env var as the
  credentials helpers.
- Apply the same chown to every orchestrator-side write into
  `sessionDir` / `workspaceDir`. The known writers are:
    - `services/github-ci-fix.ts:fetchCIFailureLogs` — writes
      `<sessionDir>/.shipit/ci-logs/<name>.log` and creates the
      enclosing dir + `.gitignore` entry. The agent then reads these
      logs as `shipit`.
    - `services/claim-session.ts`, `services/session-fork-merge.ts`,
      `services/child-sessions.ts`, `warm-pool-manager.ts` — drive
      `simpleGit(workspaceDir).raw(...)` after the container is up
      (warm-pool reactivation, fork-merge, claim-onto-existing-warm).
      Each `git` invocation can write to `.git/`; those writes land
      `root:root` and break later `shipit`-side `git` operations.
    - `repo-git.ts:cloneFromCache` — fine on first clone (entrypoint
      handles it), but any post-boot reclone/refetch needs the chown.

  Audit pass: grep `services/` and `orchestrator/` for `writeFile*`,
  `mkdir*`, `cpSync`, `renameSync`, and `simpleGit(...)` callers that
  target `sessionDir` / `workspaceDir` / `uploadsDir`, and route every
  one through a shared `chownToSessionWorker(path)` helper. The
  entrypoint's per-mount sentinel chown is a one-shot bootstrap; it does
  not cover any of these post-boot writers.
- Gate every orchestrator-side chown on a single env var
  `SHIPIT_SESSION_WORKER_UID` (unset = no chown, preserving today's
  behavior). The entrypoint uses the same env var so the orchestrator and
  the worker can never disagree on which UID owns the mounts — a single
  deploy flips both sides.

This is symmetric to how the in-container entrypoint chowns mounts on
boot. The reader-side approach (world-readable mode, POSIX ACLs) was
rejected because (a) credentials must remain `0600`-equivalent — exposing
them group/other-readable inside the container weakens the very boundary
this doc adds, and (b) ACL support is filesystem-dependent and not
guaranteed on the underlying volume.

The orchestrator must run with capabilities to chown to a different UID
(it does today — it runs as root). No new privilege is needed.

### 8. Playwright browser cache must be reachable by `shipit`

`docker/Dockerfile.session-worker.{dev,prod}` calls
`playwright-mcp install-browser chrome-for-testing` at image-build time.
That installer writes the browser under the *building user's* cache
(`$HOME/.cache/ms-playwright`, i.e. `/root/.cache/ms-playwright`). The
running worker, now `shipit`, looks under `/home/shipit/.cache/ms-playwright`
and finds nothing — the first `browser_navigate` call fails.

Pin the browsers to a stable path readable by both the build and the
runtime user. Override `HOME` for the install line as well — Chrome touches
`$HOME` during the post-install probe and leaves prefs/font caches behind
that the runtime user otherwise cannot read:

```dockerfile
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN mkdir -p /opt/playwright-browsers \
 && playwright install-deps chromium \
 && HOME=/opt/playwright-browsers playwright-mcp install-browser chrome-for-testing \
 && chmod -R a+rX /opt/playwright-browsers
```

`playwright install-deps` shells out to `apt-get` for system libraries and
does not touch `$HOME`. The `HOME=` override is only load-bearing on
`install-browser`, where Chrome's post-install probe writes prefs/font
caches into `$HOME/.cache`.

The same `PLAYWRIGHT_BROWSERS_PATH` env must be set in
`container-lifecycle.ts` so the launched browser uses the same path at
runtime. `chmod a+rX` (capital X = "directory or already-executable") gives
the runtime user read+traverse access without making every file
executable.

### 9. Local-mode (dogfood) compatibility

In `RUNTIME_MODE=local` the orchestrator process *is* the agent host:
`buildLocalAgentFactory` in `app-di.ts` imports `claude-adapter` and
`codex-adapter` into the orchestrator process. The orchestrator container
stays as root and has no `shipit` user. If `AGENT_HOME` defaults to
`/home/shipit` everywhere, the dogfood orchestrator reads credentials from
a non-existent home and authentication breaks.

The function-scoped `agentHome()` (step 3) handles this naturally: local
mode keeps `AGENT_HOME=/root` in the orchestrator container's env (set by
the inner `Dockerfile.dogfood`-style image or `dev` compose service), so
the resolved value at call time is `/root`. The plan must:

- Leave `Dockerfile.dogfood` (and any dev/local-mode launcher) on UID 0
  with `AGENT_HOME=/root` and `HOME=/root`. Do not create the `shipit` user
  in that image.
- Document in `docs/118-shipit-ui-local/plan.md` that local mode
  intentionally diverges from the containerized hardening.
- Cover local mode with a smoke test that boots the dogfood orchestrator
  and verifies `hasCodexFileAuth()` and the Claude auth probe still
  resolve to `/root/.codex/auth.json` and `/root/.claude/*`.

**Outer-session bind-mount of the ShipIt source tree.** When the ShipIt
repo is opened in production ShipIt for dogfooding, the *outer* session
container bind-mounts the developer's working copy of the ShipIt source
as `/workspace`. If the outer entrypoint were to `chown -R shipit:shipit
/workspace`, it would rewrite host filesystem ownership of the
developer's checkout. The `SHIPIT_SKIP_WORKSPACE_CHOWN=1` toggle in §2
exists for exactly this case — the orchestrator sets it whenever
`buildMounts()` falls through to the bind-mount branch (no
`workspaceVolume`), covering both dev and dogfood.

**Dogfood `dev` compose service interaction.** The `dev` service runs the
inner orchestrator as root and shares the outer agent container's
bind-mounted `/workspace/node_modules` (see the dogfood section of
`CLAUDE.md` and `docs/118-shipit-ui-local`). After this migration that
tree is written by `shipit` (UID 1000) in the outer container. Root in
the `dev` service can still read it, but any *writes* the `dev` service
does (e.g. `npm install` if dependencies drift) would land as
`root:root`, which the agent's `shipit` user could not subsequently
read. Either:

- Run the `dev` service's npm operations as `shipit` (`docker compose
  run --user 1000 dev npm install`), or
- Treat the shared `node_modules` mount as read-only from the `dev`
  service side and rely on the outer container to manage installs.

The latter is simpler and matches the existing dogfood model where the
inner orchestrator does not own dependency installation.

### 10. Revisit Docker capabilities after migration

**Note on capability scoping.** Linux capabilities are a container-wide
bounding set, not per-process. PID 1 (the entrypoint) and the unprivileged
worker share the same set. The entrypoint needs `CHOWN`, `SETUID`, `SETGID`,
and `FOWNER` to do its bootstrap work and to call `gosu`, so those caps
**must stay in `CapAdd`**.

The security benefit comes from the worker being non-root after `gosu`.
At `execve`, the kernel zeros the worker's permitted/effective/inheritable
capability sets because the new EUID is non-zero and the target binary
has no file capabilities — so the worker cannot exercise `CHOWN`,
`SETUID`, etc. even though the container's bounding set still carries
them. `no-new-privileges` does separate work: it blocks any later
re-elevation via setuid binaries or file capabilities that might be added
to the image. Both protections compose; shrinking the bounding set is
neither.

`gosu` itself is intentionally **not** installed setuid in Debian — it
relies on PID 1's existing `CAP_SETUID`/`CAP_SETGID` to do the privilege
drop, which composes cleanly with `no-new-privileges`. A future
"hardening" PR that flips `gosu` to setuid root, or drops `SETUID`/
`SETGID` from `CapAdd`, breaks the boot path in a non-obvious way. The
acceptance smoke check above (`id -u == 1000`) is the canary.

Given the capability-scoping note above, the only cap on today's
`CapAdd` list that this migration plausibly lets us drop is `DAC_OVERRIDE`
(the worker never needed it to read root-owned files once it stopped
*being* root). `CHOWN`, `SETUID`, `SETGID`, `FOWNER` remain because the
entrypoint requires them. `NET_BIND_SERVICE` is also a candidate to drop
— the worker listens on 9100, not a privileged port.

After validation, audit `CapAdd` and remove `DAC_OVERRIDE` and
`NET_BIND_SERVICE` if no regressions surface in the worker, terminal, or
MCP tool exercises.

## Touchpoints

- `docker/Dockerfile.session-worker.dev`
- `docker/Dockerfile.session-worker.prod`
- `docker/Dockerfile.session-worker.docker`
- `docker/Dockerfile.dogfood` if local dogfood agent processes should match the
  same home semantics.
- `src/server/orchestrator/container-lifecycle.ts`
- `src/server/orchestrator/container-lifecycle.test.ts`
- `src/server/session/claude.ts`
- `src/server/session/terminal.ts`
- `src/server/session/agents/codex-adapter.ts`
- `src/server/session/session-worker.ts`
- Agent registry/auth probing code that references root-home credential paths.
- `src/server/orchestrator/session-credentials.ts` — chown each per-session
  credential write to UID 1000 (see §7).
- `src/server/orchestrator/git-config.ts` —
  `writeContainerGitConfig` must chown its output to UID 1000.
- `src/server/orchestrator/services/files.ts` —
  `saveUploadedFile` must chown each upload to UID 1000 (see §7).
- `src/server/shipit-docs/environment.md`
- `docs/118-shipit-ui-local/plan.md` — note the local-mode divergence (§9).

## Risks and Mitigations

### Mount ownership drift

Bind mounts and Docker volume subpaths may be created by the orchestrator as
root. The entrypoint handles this by chowning only known writable mount points
before dropping privileges.

### CLI auth regressions

Claude and Codex both expect credentials under the user's home directory. Moving
home to `/home/shipit` requires updating every auth probe and symlink target in
the same change. The orchestrator-side credential writers (§7) must also chown
their output, or the new symlink targets are unreadable to `shipit`.

### Install regressions

Native npm addon builds need write access to the workspace, dependency cache,
and temporary directories. Validation must include `npm install`, `npm ci`,
package manager cache hits, and a native module build.

### Browser tool regressions

Playwright MCP writes under `/tmp/.playwright-mcp` and reads the browser binary
from `PLAYWRIGHT_BROWSERS_PATH` (or the default `$HOME/.cache/ms-playwright`).
The build-time install lands under the *building* user's home; without the §8
pin to a shared `/opt/playwright-browsers` path, the first `browser_*` call
under `shipit` returns "browser not installed".

### MCP install regressions

`installMcpPackage` shells out to `npm install -g`. Without the §6
`NPM_CONFIG_PREFIX` override, the install fails with EACCES the first time
a session enables an `npmPackage` MCP server.

### Incomplete capability tightening

Capability removal should follow, not precede, the user switch. First preserve
behavior with the new UID, then remove add-backs one by one with targeted tests.

## Acceptance Criteria

- Agent Bash reports `id -u == 1000` and `whoami` reports `shipit`.
- `/app`, `/app/node_modules`, `/opt/agent-cli/node_modules`, and the shim
  binaries at `/usr/local/bin/{gh,shipit,shipit-git-credential}` remain
  readable and traversable by `shipit` (the worker process is spawned
  from `/app` and execs these shims). Tested by a smoke check that
  starts a fresh session, runs `gh pr list`, and runs `node
  /app/src/server/session/session-worker.ts --version` as `shipit`.
- The browser terminal also runs as `shipit`.
- Claude can start, resume, use hooks, and access only its per-session
  credentials.
- Codex can detect `~/.codex/auth.json`, start `codex app-server`, and load the
  managed review MCP config.
- `agent.install` works for a project with native Node dependencies.
- `npm`, Yarn, and pnpm caches remain writable and reusable.
- An MCP server declared with `npmPackage` (e.g. one of the docs/088 catalog
  entries) installs and starts on first use.
- Browser tools (`browser_navigate`, `browser_take_screenshot`) work on first
  call in a fresh session.
- A user-uploaded attachment (drag-drop image, file paste) is readable by
  the agent's `shipit` user — `saveUploadedFile` chowns to UID 1000.
- The orchestrator's mid-session credential writes
  (`provisionAgentCredentials`, `syncAgentTokenIn`, `syncAgentTokenBack`,
  `writeContainerGitConfig`) remain readable by `shipit` after the entrypoint
  drop. The contract is: a session that goes idle, then takes a turn that
  refreshes the OAuth token, must still authenticate on the next turn.
- After a full session lifecycle (create → claim → first turn → CI-fix
  log fetch → warm-pool resume → archive-restore), every file under
  `/workspace`, `/uploads`, `/credentials`, and `/dep-cache` inside the
  container is owned by `shipit:shipit` and writable by `shipit` per its
  declared mode. This covers every orchestrator-side writer in §7's
  audit list, not just the credential paths.
- In-container `git fetch`, `git pull`, and `git push` still use the brokered
  credential helper.
- The agent hooks at `/etc/shipit/agent-hooks/*` (PreToolUse branch-block,
  Stop PR enforcement) remain executable by `shipit` after the migration. A
  future tightening of those modes that breaks PR enforcement should fail
  this criterion.
- Warm-pool preinstall still works.
- Container lifecycle unit tests and worker integration tests pass.
- Dogfood/local mode (`RUNTIME_MODE=local`) still resolves agent credentials
  with the orchestrator container running as root (no `shipit` user, HOME =
  `/root`).
- `src/server/shipit-docs/environment.md` documents the non-root runtime home.

## Rollout

1. Land the `agentHome()` abstraction and tests while still resolving to
   `/root` (the resolver's default stays `/root` until step 3; `AGENT_HOME`
   is read at call time so the swap takes effect without re-importing modules
   — see §3, §9). Land the orchestrator-side `chown` helpers from §7,
   gated on a new `SHIPIT_SESSION_WORKER_UID` env var on the orchestrator
   process (default unset = no chown, preserving today's
   root-writes-everything behavior).
2. Build the new session-worker image with the `shipit` user, entrypoint,
   `gosu`, `NPM_CONFIG_PREFIX` (§6), pinned `PLAYWRIGHT_BROWSERS_PATH`
   (§8), and per-mount sentinel-gated chown (§2). The image's entrypoint
   reads `SHIPIT_SESSION_WORKER_UID` (default 1000) so it stays in sync
   with the orchestrator.
3. **Single atomic deploy** that simultaneously (a) ships the new image
   to production and (b) sets `SHIPIT_SESSION_WORKER_UID=1000` plus
   `AGENT_HOME=/home/shipit` and `HOME=/home/shipit` on the orchestrator.
   The two sides must move together — a window where the new image is
   live but the orchestrator still writes `root:root` (or vice versa)
   breaks auth on every fresh session. The session-worker image's
   entrypoint also reads `SHIPIT_SESSION_WORKER_UID` so a single env
   change flips both sides. Keep `Dockerfile.dogfood` / dev / local-mode
   launchers on `/root` (§9), and have the orchestrator set
   `SHIPIT_SKIP_WORKSPACE_CHOWN=1` on bind-mount workspaces (§2).
4. Validate agent auth (including the per-turn token sync round-trip),
   terminal, install, MCP `npmPackage` install, browser tools, Git, warm
   pool, archive-restore, fork-merge, CI-fix log fetch, and
   dogfood/local mode.
5. Tighten capability add-backs (§10) after the non-root runtime is
   stable.
6. Update doc 067 to keep non-root as a tracked hardening item with this
   doc as the detailed design.

The orchestrator must also fail-fast at startup if its DB contains
sessions with containers that boot under UID 1000 but the orchestrator
itself has `SHIPIT_SESSION_WORKER_UID` unset (e.g. after a config-rollback
regression). Without that guard, an env-var drift silently flips back to
root-writes-into-1000-readable-mounts and breaks auth one session at a
time.
