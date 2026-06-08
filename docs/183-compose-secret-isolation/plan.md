---
title: Compose service secret isolation
description: Keep compose-service secrets out of the agent-readable workspace while preserving per-service injection and explicit agent opt-in.
---

# 183 — Compose Service Secret Isolation

> **Scope.** This doc covers isolating **user-supplied** service secrets from the agent.
> The separate, higher-severity problem — ShipIt auto-forwarding the user's *platform*
> identity (Claude/GitHub/MCP OAuth) into repo-declared services via `source: platform:*` —
> is removed outright in `docs/184-remove-platform-secret-forwarding/plan.md`. After 184 the
> motivating credentials below are user-supplied secrets, and this doc keeps them out of the
> agent-readable workspace.

## Overview

ShipIt's compose secrets pipeline intentionally separates two audiences:

- **Compose services** receive the secrets they declare in `x-shipit-secrets`.
- **The agent container** receives only secrets explicitly marked `agent: true`, plus MCP agent credentials.

That boundary is currently porous in the default env-file delivery mode. `ServiceManager`
writes service env files to `.shipit/.env.<service-name>` inside the session workspace, and
`compose.override.yml` references those files via `env_file:`. The workspace is mounted
read-write into the agent container, so a Codex or Claude session can read service-only
secrets just by opening the generated service env file.

This surfaced in a Codex session for the ShipIt repo: `.shipit/.env.dev` contained
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `GITHUB_TOKEN`. Those entries are
declared for the `dev` compose service in this repo's `docker-compose.yml`. That service
runs ShipIt itself inside the session for dogfooding, so it needs those credentials to
boot authenticated. They were not declared `agent: true` and should not be visible to the
agent container. (At the time they were forwarded from the user's platform identity via
`source: platform:*`; doc 184 removes that forwarding, so post-184 they are user-supplied
secrets — but they are still written to a service env file, so this isolation still
applies.)

## Problem

The credential-isolation work for provider accounts scoped `/credentials` correctly:

- Codex sessions get Codex credential files, not Claude credential files.
- Claude sessions get Claude credential files, not Codex credential files.
- Git identity is provided through a token-free generated git config.

Compose service secrets bypass that boundary because default env-file mode writes
plaintext service env files into the shared workspace. File mode `0600` does not help:
the agent runs as the same effective user that can read the workspace.

The current default therefore violates the `x-shipit-secrets` contract:

```yaml
x-shipit-secrets:
  - name: DATABASE_URL
    agent: true     # agent may see it
  - name: STRIPE_KEY
                    # service only, but still readable from .shipit/.env.api today
```

Any service-only secret the user provides — a database URL, an API key, a third-party
token — should not land in the agent-readable workspace unless explicitly marked
`agent: true`.

> The previously highest-value case here — platform-forwarded credentials
> (`source: platform:claude_oauth` / `platform:github_token`) — is no longer in this doc's
> scope: doc 184 stops forwarding the user's platform identity into services at all. This
> doc concerns the secrets the user *does* deliberately supply to their services.

## Goals

- Keep all service-only compose secrets out of `/workspace`.
- Preserve per-service scoping: each compose service receives only the secrets it
  declared.
- Preserve the explicit `agent: true` path for values the agent actually needs.
- Avoid breaking existing compose stacks that rely on environment variables rather than
  reading Docker secret files directly.
- Keep the dogfood flow working: the repo's `dev` service should still receive its
  (user-supplied, per doc 184) `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` — just not from a
  workspace-readable file.
- Avoid adding migration machinery solely for existing leaked files. Existing
  installations can delete `.shipit/.env.<service-name>` files manually or recreate their
  sessions after the write path changes.

## Non-Goals

- This does not fully solve malicious service-code exfiltration. A service that receives
  a secret in its process environment can log it, write it to the workspace, or send it
  over the network. This feature fixes accidental agent-side readability of service-only
  secret files. (For *platform* credentials specifically, doc 184 removes the exfiltration
  vector by not forwarding them to services at all; the residual risk here is for the
  user-supplied secrets the user deliberately hands to their own services.)
- This does not change the `agent: true` threat model. Values marked `agent: true` are
  intentionally available to the agent and remain exfiltratable.
- This does not replace the broader agent-containment work in
  `docs/172-agent-containment/plan.md`, especially egress control and short-lived tokens.

## Design

### 1. Move default service env files out of the workspace

Introduce a service-env root owned by the orchestrator, separate from the session
workspace:

```text
<stateDir>/service-env/<sessionId>/.env.<service-name>
```

`ServiceSecretsResolver` writes service env files there by default. The generated compose
override references those files with absolute `env_file:` paths:

```yaml
services:
  <service-name>:
    env_file:
      - <stateDir>/service-env/<sessionId>/.env.<service-name>
```

The exact root is configurable:

- `SHIPIT_SERVICE_ENV_DIR` if set.
- Otherwise `<stateDir>/service-env` in containerized runtime.
- Tests and legacy/local paths can still inject no root and fall back to the old
  workspace `.shipit/.env.<service-name>` behavior where needed.

**Why `<stateDir>/service-env` is agent-invisible in production — and not by accident.**
The isolation does not come from the path string "looking outside" `/workspace`; in
production `stateDir` defaults to the workspace-volume root, so this directory resolves to
`/workspace/service-env` on disk. It is invisible to the agent because the agent container
mounts the workspace volume with a **subpath** of `sessions/<sessionId>/workspace`
(`container-lifecycle.ts`, `VolumeOptions.Subpath`), so a `service-env/` directory at the
volume root is simply outside the agent's mount even though both live on the same Docker
volume. This subpath dependency is load-bearing and must be stated wherever the default is
described — an implementer who assumes "any path under `stateDir` is safe" will reintroduce
the leak in any context that lacks the subpath mount (see local/dogfood mode below).

**Local/dogfood mode requires an explicit external root.** In local mode the `dev` compose
service sets `SHIPIT_STATE_DIR=/workspace/.inner-shipit` (`docker-compose.yml`,
`docs/118`), which is *inside* the inner-agent-visible workspace tree. There is no subpath
mount in local mode — the inner agent sees the whole checkout — so the `<stateDir>/service-env`
fallback lands somewhere the inner agent can read and the leak persists. Since the
motivating incident was a ShipIt-repo dogfood session, this path is in scope and must not
fall back. For local/inner sessions, require a workspace-external `SHIPIT_SERVICE_ENV_DIR`
(or mandate Docker-secrets mode via `SHIPIT_SECRETS_INTERNAL_DIR`); refuse to write service
env files under a `stateDir` that lives inside the workspace.

Why this is the first fix:

- It preserves the current env-var semantics inside the service container.
- It avoids requiring Docker daemon host-path configuration.
- It removes the plaintext service env file from the agent-readable workspace.
- It is smaller and less compatibility-risky than making Docker secrets the default.

### 2. Keep `.shipit/.env.agent` as the only workspace env file with agent-bound values

The agent env file remains under `.shipit/.env.agent` because it is explicitly the agent
delivery path:

- compose `agent: true` entries
- MCP `mcp__*` secrets
- MCP platform OAuth tokens rewrapped as worker env vars

The important invariant becomes:

```text
.shipit/.env.agent        allowed to contain agent-bound values
.shipit/.env.<service-name>
                          must not be written in normal containerized sessions
```

### 3. Extend compose override generation with service env-file paths

`generateComposeOverride()` currently assumes each service env file lives at
`.shipit/.env.<service-name>`. Add an optional service env-file map:

```ts
serviceEnvFiles?: Record<string, string>;
```

When present, service entries use that path:

```ts
entry.env_file = [serviceEnvFiles[svc.name]];
```

When absent, retain the current `.shipit/.env.<service-name>` fallback for tests and
non-container setups.

### 4. Keep Docker-secrets mode as stronger opt-in hardening

Docker-secrets mode already exists and writes per-secret files outside the workspace,
then mounts them into only the services that declared them. It is stronger file-system
isolation than env files, but it changes service startup by inserting an entrypoint
wrapper and requires a Docker-daemon-visible host path.

This feature should not remove Docker-secrets mode. Instead:

- Default containerized sessions use out-of-workspace env files.
- Operators that can provide `SHIPIT_SECRETS_INTERNAL_DIR` and
  `SHIPIT_SECRETS_HOST_DIR` can opt into Docker-secrets mode.
- The docs should describe Docker-secrets mode as the stronger service-file isolation
  option, not the only way to avoid workspace leaks.

### 5. Dogfood compose keeps service-only secrets out of the workspace

The ShipIt repo's `dev` service declares service-only secrets:

```yaml
x-shipit-secrets:
  - { name: ANTHROPIC_API_KEY }
  - { name: ANTHROPIC_AUTH_TOKEN }
  - { name: GITHUB_TOKEN }
```

(These are user-supplied secrets after doc 184 removes `source: platform:*` forwarding.)
Those entries should remain service-only. The fix is not to add `agent: true`; the fix is
to stop service-only env files from being written into the workspace.

## Data Flow

Before:

```text
x-shipit-secrets
  -> resolveSecrets()
  -> .shipit/.env.<service-name> in /workspace
  -> compose env_file
  -> service process.env

agent can read /workspace/.shipit/.env.<service-name>
```

After:

```text
x-shipit-secrets
  -> resolveSecrets()
  -> <stateDir>/service-env/<sessionId>/.env.<service-name>
  -> compose env_file
  -> service process.env

agent cannot read <stateDir>/service-env: in production the agent's workspace
mount is a sessions/<id>/workspace subpath of the volume, so service-env/ at the
volume root is outside the agent's mount (see Design §1 for the local-mode caveat)
```

For `agent: true` entries:

```text
x-shipit-secrets[agent: true]
  -> resolveSecrets()
  -> .shipit/.env.agent and worker /secrets
  -> agent process.env
```

## Key Files

- `src/server/orchestrator/secret-resolver.ts` — write service env files to a configurable
  root outside the workspace.
- `src/server/orchestrator/service-secrets-resolver.ts` — carry service env-file metadata
  from secret sync to compose override generation.
- `src/server/orchestrator/compose-generator.ts` — accept per-service env-file paths.
- `src/server/orchestrator/service-manager.ts` — pass the env-file metadata into the
  override on start and secret refresh.
- `src/server/orchestrator/index.ts` — derive the default `serviceEnvDir` from
  `SHIPIT_SERVICE_ENV_DIR` or `stateDir`.
- `src/server/shipit-docs/secrets.md` — document that service-only env files do not live
  under the workspace in containerized mode.
- `docker-compose.yml` — no behavioral change from *this* doc; dogfood service keeps its
  service-only secrets (the `source: platform:*` removal is doc 184's change).

## Tests

Add focused coverage for the boundary:

- `secret-resolver.test.ts`: writing service env files to an external root returns paths
  under that root and does not create `.shipit/.env.<service-name>`.
- `compose-generator.test.ts`: override uses supplied absolute env-file paths and falls
  back to `.shipit/.env.<service-name>` when none are supplied.
- `service-manager.test.ts`: service-only secrets are written outside the workspace and
  the generated override references the external env file.
- Regression: with dogfood-style service-only secrets (`ANTHROPIC_API_KEY`,
  `GITHUB_TOKEN`) and no `agent: true`, `.shipit/.env.dev` is absent while the external
  service env file exists.

## Rollout

1. Ship code that writes new service env files outside the workspace.
2. Restart active compose stacks through the normal reconcile path so generated overrides
   point at the new file locations.
3. Leave `.shipit/.env.agent` behavior unchanged.
4. Update docs to say service env files are orchestrator-private in containerized mode,
   with Docker-secrets mode available for stronger isolation.

## Resolved Decisions

- **`SHIPIT_SERVICE_ENV_DIR` is not required in production; it is required in local/dogfood
  mode.** In production `stateDir` defaults to the workspace-volume root and the agent
  mounts only the `sessions/<id>/workspace` subpath, so the default `<stateDir>/service-env`
  is genuinely outside the agent's mount — sufficient, no override needed. In local mode
  `stateDir` lives inside the agent-visible checkout and there is no subpath mount, so an
  external `SHIPIT_SERVICE_ENV_DIR` is mandatory (Design §1). Enforce both with a startup
  assertion: the resolved service-env root must not resolve inside any agent workspace
  mount; refuse to boot (or refuse to write service env files) otherwise, rather than
  silently leaking. This makes "is the default safe here?" a checked invariant instead of a
  per-deployment judgment call.

- **No UI warning for platform credentials in service env — moot.** This was about
  high-value `platform:*` credentials landing in service env. Doc 184 removes `source:
  platform:*` forwarding entirely, so those credentials no longer reach service env by this
  path; there is nothing left to warn about. Doc 184 instead warns when a compose file
  still *declares* a now-unhonored `source: platform:*`, which is the useful signal.
