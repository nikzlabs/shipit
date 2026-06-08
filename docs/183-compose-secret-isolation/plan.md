---
title: Compose service secret isolation
description: Keep compose-service secrets out of the agent-readable workspace while preserving per-service injection and explicit agent opt-in.
---

# 183 — Compose Service Secret Isolation

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
runs ShipIt itself inside the session for dogfooding, so it needs forwarded platform
credentials to boot authenticated. They were not declared `agent: true` and should not be
visible to the agent container.

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

The bug is especially sharp for platform-sourced secrets:

- `source: platform:claude_oauth`
- `source: platform:github_token`

Those are useful for the dogfood service, but they are high-value credentials and should
not land in the agent-readable workspace unless explicitly marked `agent: true`.

## Goals

- Keep all service-only compose secrets out of `/workspace`.
- Preserve per-service scoping: each compose service receives only the secrets it
  declared.
- Preserve the explicit `agent: true` path for values the agent actually needs.
- Avoid breaking existing compose stacks that rely on environment variables rather than
  reading Docker secret files directly.
- Keep the dogfood flow working: the repo's `dev` service should still receive forwarded
  Claude/GitHub credentials.
- Avoid adding migration machinery solely for existing leaked files. Existing
  installations can delete `.shipit/.env.<service-name>` files manually or recreate their
  sessions after the write path changes.

## Non-Goals

- This does not fully solve malicious service-code exfiltration. A service that receives
  a secret in its process environment can log it, write it to the workspace, or send it
  over the network. This feature fixes accidental agent-side readability of service-only
  secret files.
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

### 5. Dogfood compose continues to use service-only platform credentials

The ShipIt repo's `dev` service should keep:

```yaml
x-shipit-secrets:
  - { name: ANTHROPIC_API_KEY,    source: platform:claude_oauth }
  - { name: ANTHROPIC_AUTH_TOKEN, source: platform:claude_oauth }
  - { name: GITHUB_TOKEN,         source: platform:github_token }
```

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

agent cannot read <stateDir>/service-env from /workspace
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
- `docker-compose.yml` — no behavioral change intended; dogfood service keeps
  service-only platform credentials.

## Tests

Add focused coverage for the boundary:

- `secret-resolver.test.ts`: writing service env files to an external root returns paths
  under that root and does not create `.shipit/.env.<service-name>`.
- `compose-generator.test.ts`: override uses supplied absolute env-file paths and falls
  back to `.shipit/.env.<service-name>` when none are supplied.
- `service-manager.test.ts`: service-only secrets are written outside the workspace and
  the generated override references the external env file.
- Regression: with dogfood-style `platform:claude_oauth` / `platform:github_token`
  declarations and no `agent: true`, `.shipit/.env.dev` is absent while the external
  service env file exists.

## Rollout

1. Ship code that writes new service env files outside the workspace.
2. Restart active compose stacks through the normal reconcile path so generated overrides
   point at the new file locations.
3. Leave `.shipit/.env.agent` behavior unchanged.
4. Update docs to say service env files are orchestrator-private in containerized mode,
   with Docker-secrets mode available for stronger isolation.

## Open Questions

- Should local dogfood runtime use the external service env directory too, even when the
  state directory is intentionally configured inside the checkout for local development?
- Should `SHIPIT_SERVICE_ENV_DIR` be required in production deployments, or should the
  default `<stateDir>/service-env` be sufficient?
- Should the UI surface a warning when a repo declares high-value platform credentials in
  service env, even when they are service-only?
