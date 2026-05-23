---
status: planned
priority: medium
title: Non-root session worker runtime
description: Run the session worker, agent CLI, terminal, install hooks, and MCP servers as an unprivileged user instead of root.
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
  `/root/.codex`.
- `agent.install`, MCP package installs, browser tools, and terminal shells all
  inherit the root-oriented environment.

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

Each session worker image creates a stable user:

```dockerfile
RUN groupadd --gid 1000 shipit \
 && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash shipit
```

The stable UID keeps file ownership predictable across bind mounts and named
volume subpaths. The home directory becomes `/home/shipit`.

### 2. Use a root entrypoint only for mount preparation

The safest migration is a tiny root entrypoint that prepares writable mounted
paths, then drops privileges before launching the worker:

```sh
#!/bin/sh
set -eu

mkdir -p /workspace /uploads /dep-cache /credentials /home/shipit
chown -R shipit:shipit /workspace /uploads /dep-cache /credentials /home/shipit

exec su-exec shipit:shipit "$@"
```

Equivalent tools such as `gosu` are fine. The entrypoint should only touch
writable runtime mounts and the runtime home directory. It must not recursively
chown `/app`, `/usr/local/bin`, `/opt/agent-cli`, or system directories.

After this point, the worker process is non-root. The Dockerfile can either keep
the final `USER root` for the entrypoint and drop inside the script, or use a
minimal init wrapper. The important boundary is that `session-worker.ts` and its
children do not run as UID 0.

### 3. Introduce a single agent home constant

Replace hardcoded `/root` with one source of truth:

```ts
export const DEFAULT_AGENT_HOME = "/home/shipit";
export const AGENT_HOME = process.env.AGENT_HOME || DEFAULT_AGENT_HOME;
```

Use this in:

- `container-lifecycle.ts` env builder.
- `claude.ts` child env.
- `terminal.ts` child env.
- `codex-adapter.ts` auth path.
- `session-worker.ts` Codex MCP config path.
- Any agent registry or auth probe that checks CLI credential files.

Set both `HOME=/home/shipit` and `AGENT_HOME=/home/shipit` in the container
environment. Keep `CODEX_HOME` optional, but default it to
`${AGENT_HOME}/.codex`.

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

### 6. Revisit Docker capabilities after migration

Once the worker no longer runs as root, normal operation should not require:

- `DAC_OVERRIDE`
- `FOWNER`
- `SETUID`
- `SETGID`
- `CHOWN`

The entrypoint may need ownership-changing power before it drops privileges, but
the running worker should not. After validation, tighten `CapAdd` to the minimum
required set, likely just `KILL` and possibly `NET_BIND_SERVICE` if any worker
path binds a privileged port. The worker normally listens on 9100, so
`NET_BIND_SERVICE` may also be removable.

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
- `src/server/shipit-docs/environment.md`

## Risks and Mitigations

### Mount ownership drift

Bind mounts and Docker volume subpaths may be created by the orchestrator as
root. The entrypoint handles this by chowning only known writable mount points
before dropping privileges.

### CLI auth regressions

Claude and Codex both expect credentials under the user's home directory. Moving
home to `/home/shipit` requires updating every auth probe and symlink target in
the same change.

### Install regressions

Native npm addon builds need write access to the workspace, dependency cache,
and temporary directories. Validation must include `npm install`, `npm ci`,
package manager cache hits, and a native module build.

### Browser tool regressions

Playwright MCP writes under `/tmp/.playwright-mcp` and may use browser cache
paths. The entrypoint or Dockerfile must ensure the relevant runtime paths are
writable by `shipit`.

### Incomplete capability tightening

Capability removal should follow, not precede, the user switch. First preserve
behavior with the new UID, then remove add-backs one by one with targeted tests.

## Acceptance Criteria

- Agent Bash reports a non-zero UID and `whoami` reports `shipit`.
- The browser terminal also runs as `shipit`.
- Claude can start, resume, use hooks, and access only its per-session
  credentials.
- Codex can detect `~/.codex/auth.json`, start `codex app-server`, and load the
  managed review MCP config.
- `agent.install` works for a project with native Node dependencies.
- `npm`, Yarn, and pnpm caches remain writable and reusable.
- Files created under `/workspace` are not root-owned.
- In-container `git fetch`, `git pull`, and `git push` still use the brokered
  credential helper.
- Warm-pool preinstall still works.
- Container lifecycle unit tests and worker integration tests pass.
- `src/server/shipit-docs/environment.md` documents the non-root runtime home.

## Rollout

1. Land the `AGENT_HOME` abstraction and tests while still pointing it at
   `/root`.
2. Update Dockerfiles and entrypoint to create and use `/home/shipit`.
3. Flip `AGENT_HOME` and `HOME` to `/home/shipit`.
4. Validate agent auth, terminal, install, MCP, browser tools, Git, and warm
   pool behavior.
5. Tighten capability add-backs after the non-root runtime is stable.
6. Update doc 067 to keep non-root as a tracked hardening item with this doc as
   the detailed design.
