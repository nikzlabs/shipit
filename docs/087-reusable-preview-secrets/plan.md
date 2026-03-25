---
status: planned
---

# 087 — Reusable Preview Secrets

Follow-up to [086 — shipit.yaml and Compose](../086-shipit-yaml-and-compose/plan.md). Designs a complete secrets pipeline so environment variables (API keys, tokens, database URLs) flow reliably into compose services — configured once and reused across every session for a repo.

## Context: 086 eliminates preview containers

086 replaces the dedicated preview/services container with Docker Compose stacks managed by the orchestrator. This fundamentally changes how secrets reach services:

| | Today (pre-086) | After 086 |
|---|---|---|
| **Service runtime** | Preview container (Fastify session worker) | Compose stack (standard Docker containers) |
| **Secret injection** | HTTP `PUT /secrets` → worker sets `process.env` | `.shipit/.env` file referenced by compose `env_file:` |
| **Secret push** | `ContainerSessionRunner.pushSecretsToPreview()` | Orchestrator writes `.env`, runs `docker compose up -d` |
| **Restart on change** | Worker detects diff, restarts child process | Compose recreates containers with new env |

The current HTTP-based push (`pushSecretsToPreview`, session worker `/secrets` endpoint) is eliminated along with the preview container. This design assumes 086's compose model.

## Problem

1. **No auto-load on session start.** `setSecretsLoader()` exists on `ContainerSessionRunner` but is never wired up. Secrets only reach services when explicitly saved via `PUT /api/secrets` — new sessions for the same repo start without secrets.

2. **No secret references in config.** There's no way to declare which secrets a project needs. Users must remember to configure them out-of-band for every repo.

3. **No per-service scoping.** All secrets go to all services. A database password shouldn't be visible to the frontend dev server.

4. **No agent access.** Secrets are injected into services but not available in the agent container. Build steps, migrations, and tests that need secrets fail.

5. **No "ShipIt-in-ShipIt" workflow.** The inner ShipIt instance needs the outer session's Claude OAuth, GitHub token, and Docker socket. There's no mechanism to forward platform credentials.

6. **No validation or feedback.** Missing required secrets cause silent failures. No UI indication of what's expected vs configured.

## Goals

- **Configure once, use everywhere.** Secrets saved for a repo auto-load into every new session and survive service restarts.
- **Compose-native injection.** Secrets flow through `.env` files and compose `env_file:` — no custom HTTP endpoints.
- **Per-service + agent scoping.** Control which services and whether the agent sees each secret.
- **Declarative requirements.** `shipit.yaml` declares required secrets so the platform can validate and prompt.
- **Platform credential forwarding.** First-class mechanism to forward outer session credentials to inner compose services.

## Design

### 1. Env file injection (compose-native)

The orchestrator writes secrets to `.shipit/.env` and references it from the generated compose override:

```yaml
# .shipit/compose.override.yml (generated)
services:
  web:
    env_file:
      - .shipit/.env
  api:
    env_file:
      - .shipit/.env
```

**Why `.env` file, not `environment:` in the override:**
- Compose `env_file:` is the standard pattern — teams already use it locally.
- The file is written once, read by all services. Adding a secret doesn't require regenerating the override.
- The file lives in `.shipit/` (gitignored, orchestrator-controlled). Not in the workspace root where the agent could accidentally commit it.

**Lifecycle:**
1. On session activation, orchestrator loads secrets from `SecretStore` for the repo.
2. Writes `.shipit/.env` (overwrite, not append — full reconciliation each time).
3. Generates compose override referencing `env_file: [.shipit/.env]` for applicable services.
4. Runs `docker compose up -d`. Compose injects env vars into containers.

**On secret change** (user saves via `PUT /api/secrets`):
1. Orchestrator rewrites `.shipit/.env`.
2. Runs `docker compose up -d`. Compose detects env change, recreates affected containers.

**File format:**
```env
# .shipit/.env — managed by ShipIt, do not edit
DATABASE_URL=postgres://localhost:5432/mydb
STRIPE_KEY=sk_test_abc123
```

Standard `KEY=VALUE` format. Values with special characters are quoted. The orchestrator uses a deterministic write (sorted keys) to minimize unnecessary container recreations.

### 2. Auto-load on session activation

Wire secrets loading into the session activation flow so secrets are always present before compose starts.

In the post-086 world, session activation looks like:
1. Orchestrator creates/activates session
2. Starts agent container
3. Runs install steps (`agent.install`)
4. **Loads secrets from SecretStore → writes `.shipit/.env`** ← new step
5. Generates compose override
6. Runs `docker compose up -d`

Step 4 is the key addition. The `SecretStore` already persists secrets per-repo in SQLite — we just need to read them and write the file before compose starts.

**Key files:**
- `src/server/orchestrator/service-manager.ts` (new from 086) — writes `.env` before `docker compose up`
- `src/server/orchestrator/secret-store.ts` — existing, no changes needed

### 3. Declarative secret requirements in shipit.yaml

Add an optional `secrets` top-level field to the shipit.yaml schema (alongside `agent` and `compose` from 086):

```yaml
agent:
  install: npm install

compose: docker-compose.yml

secrets:
  - name: DATABASE_URL
    description: PostgreSQL connection string
    required: true
  - name: STRIPE_KEY
    description: Stripe API key for payment tests
  - name: REDIS_URL
    description: Redis connection URL
    required: true
    services: [api, worker]    # only these compose services get this secret
```

**Schema:**

```typescript
interface SecretRequirement {
  name: string;               // env var name
  description?: string;       // shown in UI, helps user know what to fill in
  required?: boolean;         // default: false. Missing required → warning
  services?: string[];        // which compose services get this secret (default: all)
  agent?: boolean;            // also inject into agent container (default: false)
  source?: string;            // platform credential source (see section 5)
}
```

**Behavior on compose start:**
1. Parse `secrets` from shipit.yaml.
2. Load user-configured values from `SecretStore`.
3. For each `required` secret without a value, collect into a missing list.
4. If any missing → emit `secrets_missing` WS message to the browser. Compose still starts (partial secrets are better than nothing), but the UI shows a prompt.
5. Write `.shipit/.env` with the values we have.

**Per-service scoping via `services` field:**
When `services` is set, the orchestrator generates per-service env files instead of (or in addition to) the shared one:

```
.shipit/.env                 # secrets without services filter (shared)
.shipit/.env.api             # secrets scoped to api service
.shipit/.env.worker          # secrets scoped to worker service
```

The compose override references the appropriate files:
```yaml
services:
  web:
    env_file: [.shipit/.env]
  api:
    env_file: [.shipit/.env, .shipit/.env.api]
  worker:
    env_file: [.shipit/.env, .shipit/.env.worker]
```

This keeps database credentials out of the frontend dev server.

### 4. Agent container injection

Some secrets need to be available in the agent container (e.g., `NPM_TOKEN` for private registries during install, database URLs for running migrations). The `agent: true` field on a secret requirement controls this:

```yaml
secrets:
  - name: NPM_TOKEN
    agent: true              # inject into agent container
  - name: DATABASE_URL
    required: true
    agent: true              # agent needs it for migrations
    services: [api]          # only api service gets it too
```

Agent injection uses a different mechanism than compose since the agent container is orchestrator-managed (not in the compose stack):

- Orchestrator writes `.shipit/.env.agent` with agent-scoped secrets.
- When creating the agent container, pass `--env-file .shipit/.env.agent` to `docker create`.
- For secret changes after the agent is running, the orchestrator calls the existing session worker `PUT /secrets` endpoint (agent container still runs a session worker — only the preview/services container is eliminated by 086).

**Key files:**
- `src/server/orchestrator/container-lifecycle.ts` — pass `--env-file` on container create
- `src/server/session/session-worker.ts` — existing `/secrets` endpoint (session mode)

### 5. Platform credential forwarding (ShipIt-in-ShipIt)

For developing ShipIt inside ShipIt, the inner instance's compose services need the outer session's credentials. The `source` field resolves values from the platform instead of the user secret store:

```yaml
secrets:
  - name: ANTHROPIC_API_KEY
    source: platform:claude_oauth
    services: [orchestrator]
  - name: GITHUB_TOKEN
    source: platform:github_token
    services: [orchestrator]
```

The `source: platform:<credential>` syntax tells the orchestrator to resolve the value from the current session's credential store. Available sources:

| Source | Resolves to |
|--------|------------|
| `platform:claude_oauth` | Claude OAuth token from `AuthManager` |
| `platform:github_token` | GitHub token from `GitHubAuthManager` |

Platform credentials are:
- **Resolved at activation time** — tokens may rotate, so they're fetched fresh each session start.
- **Read-only in UI** — shown as "Platform credential" with the source label, not editable.
- **Written to `.env` like any other secret** — compose services don't know the difference.
- **Opt-in** — the project's `shipit.yaml` must explicitly request them.

**Docker socket forwarding** is handled separately by 086's `compose.docker-socket: true` flag, which allows socket mounts in the compose file. This is not a secret — it's a container configuration concern.

**Key files:**
- `src/server/orchestrator/secret-resolver.ts` (new) — merges user secrets + platform creds
- `src/server/orchestrator/credential-store.ts` — expose credential lookup API
- `src/server/orchestrator/auth.ts` — Claude OAuth token access
- `src/server/orchestrator/github-auth.ts` — GitHub token access

### 6. Secret resolver (orchestration layer)

New module that composes all secret sources and produces the final env files:

```typescript
// src/server/orchestrator/secret-resolver.ts

interface ResolvedSecrets {
  shared: Record<string, string>;           // .shipit/.env
  perService: Record<string, Record<string, string>>;  // .shipit/.env.<service>
  agent: Record<string, string>;            // .shipit/.env.agent
  missing: SecretRequirement[];             // required but no value
}

async function resolveSecrets(
  requirements: SecretRequirement[],
  userSecrets: Record<string, string>,      // from SecretStore
  platformCredentials: PlatformCredentials, // from AuthManager etc.
): ResolvedSecrets
```

Flow:
1. For each requirement, resolve the value: `source: platform:*` → credential store, otherwise → user secrets.
2. Partition by scope: `services` field → per-service files, `agent: true` → agent file, no scope → shared file.
3. Collect missing required secrets.
4. Return structured result for the service manager to write to disk.

### 7. Secrets UI enhancements

Extend the existing secrets panel to support declarative requirements:

- **Required secrets indicator.** Secrets declared in `shipit.yaml` appear as rows with descriptions. Missing required ones show a warning icon.
- **"Configure secrets" banner.** When `secrets_missing` fires, show in the preview panel: "This project needs secrets to run. [Configure]" — links to the secrets panel.
- **Scope display.** Show which services (and whether the agent) receive each secret.
- **Platform credentials section.** Read-only rows showing forwarded platform credentials (source label, no value).
- **Undeclared secrets.** User-added secrets not in `shipit.yaml` still work (backward compat) — shown in a separate "Custom" section.

## Data flow

```
shipit.yaml                 docker-compose.yml
(secret requirements)       (service definitions)
        │                          │
        ▼                          ▼
┌─────────────────┐    ┌──────────────────┐
│  SecretStore     │    │ CredentialStore   │
│  (user secrets)  │    │ (platform creds)  │
└────────┬────────┘    └───────┬──────────┘
         │                     │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────┐
         │  Secret Resolver │  ← merges sources, filters by scope
         │  (orchestrator)  │
         └────────┬────────┘
                  │
     ┌────────────┼────────────┐
     ▼            ▼            ▼
.shipit/.env  .shipit/.env.*  .shipit/.env.agent
  (shared)     (per-service)    (agent)
     │            │            │
     ▼            ▼            ▼
  compose      compose       docker create
  env_file     env_file      --env-file
     │            │            │
     ▼            ▼            ▼
  all services  scoped       agent container
               services       process.env
```

## Security considerations

- **`.shipit/` is gitignored.** The `.env` files are never committed. The orchestrator owns this directory.
- **Agent can read `.shipit/.env`.** The workspace volume is shared between the agent and compose services. An agent with filesystem access can read the env files. This is acceptable — the agent already has the user's trust to execute code. If isolation between agent and service secrets is needed in the future, compose secrets (Docker secrets mounted as files) could replace env files.
- **Platform credentials in `.env` files.** OAuth tokens written to disk is a tradeoff. Mitigations: `.shipit/` is tmpfs in production (not persisted), files are 0600, and tokens are session-scoped (short-lived).
- **No secrets in compose override.** The override YAML never contains secret values — only `env_file:` references. Safe to log/debug.

## Implementation phases

### Phase 1: Env file injection + auto-load
- Write `.shipit/.env` from `SecretStore` on session activation
- Reference via `env_file:` in compose override
- Rewrite on `PUT /api/secrets`, run `docker compose up -d` to apply
- Delete old `pushSecretsToPreview` HTTP flow
- **Depends on:** 086 compose infrastructure (service manager, override generation)

### Phase 2: Declarative requirements
- Add `secrets` top-level field to shipit.yaml schema
- Parse in `shipit-config.ts` (from 086)
- Validate required secrets, emit `secrets_missing` WS message
- UI: banner prompt for missing secrets, description display
- Per-service scoping via `.env.<service>` files

### Phase 3: Agent injection
- Write `.shipit/.env.agent` for agent-scoped secrets
- Pass `--env-file` on agent container creation
- Runtime updates via existing session worker `/secrets` endpoint
- UI: agent scope indicator

### Phase 4: Platform credential forwarding
- Create `secret-resolver.ts` — merge user + platform sources
- Implement `platform:claude_oauth` and `platform:github_token` resolution
- UI: read-only platform credential display
- Docker socket handled by 086's `compose.docker-socket` (no work here)

### Phase 5: UI polish
- Required/optional indicators with descriptions
- Per-service scope labels
- Undeclared (custom) secrets section
- Missing secrets banner in preview panel

## Key files

**New:**
- `src/server/orchestrator/secret-resolver.ts` — merges user + platform secrets, writes env files
- `src/server/shipit-docs/secrets.md` — agent-facing docs for secrets in compose

**Modify (from 086):**
- `src/server/orchestrator/service-manager.ts` — call secret resolver before compose up
- `src/server/orchestrator/compose-generator.ts` — add `env_file:` to override
- `src/server/shared/shipit-config.ts` — parse `secrets` field

**Modify (existing):**
- `src/server/orchestrator/api-routes-secrets.ts` — rewrite env file + compose up on save
- `src/server/orchestrator/container-lifecycle.ts` — `--env-file` for agent container
- `src/server/shared/types/domain-types.ts` — `SecretRequirement` type
- `src/server/shared/types/ws-server-messages.ts` — `secrets_missing` message
- `src/server/orchestrator/credential-store.ts` — platform credential lookup
- `src/client/components/` — secrets panel enhancements

**Delete (post-086):**
- `ContainerSessionRunner.pushSecretsToPreview()` — replaced by env file
- Preview worker `PUT /secrets` endpoint — container no longer exists

## Relation to 086

This design **assumes 086 is implemented.** Phase 1 depends on 086's compose infrastructure (service manager, override generation, elimination of preview container). The `secrets` field becomes the fourth top-level key in shipit.yaml alongside `version`, `agent`, and `compose`.

If any work needs to happen before 086, the only pre-086 fix is wiring `setSecretsLoader` in `app-lifecycle.ts` (auto-load into the existing preview container). This is a one-line change that improves the status quo without new design.
