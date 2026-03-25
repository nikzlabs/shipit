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
- **Compose-native declaration and injection.** Secrets are declared per-service in docker-compose.yml via `x-shipit-secrets`, injected via `.env` files — same philosophy as `x-shipit-preview` from 086.
- **Per-service scoping by default.** Each service declares exactly which secrets it needs. No over-sharing.
- **Platform credential forwarding.** First-class mechanism to forward outer session credentials to inner compose services.

## Design

### 1. `x-shipit-secrets` in docker-compose.yml

Secret requirements are declared per-service in the compose file, following the same `x-shipit-*` convention as `x-shipit-preview` from 086:

```yaml
# docker-compose.yml
services:
  web:
    image: node:20
    command: npm run dev
    ports: ["5173:5173"]
    x-shipit-preview: auto
    environment:
      HOST: 0.0.0.0          # regular env var — not a secret
    x-shipit-secrets:
      - STRIPE_KEY

  api:
    image: node:20
    command: npm start
    ports: ["3000:3000"]
    x-shipit-secrets:
      - DATABASE_URL
      - REDIS_URL
      - STRIPE_KEY

  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: dev  # not a secret — dev-only default
```

**Why compose, not shipit.yaml:**
- 086's principle: services are defined in compose, not shipit.yaml. Secrets are per-service config — they belong with the service definition.
- Scoping is natural: each service lists exactly what it needs. No separate `services: [api, worker]` indirection.
- The agent (who generates compose files) already understands the service structure. Adding `x-shipit-secrets` alongside `environment` and `ports` is intuitive.
- Follows the `x-shipit-preview` pattern — compose extensions for ShipIt-specific metadata.

**What the orchestrator does with `x-shipit-secrets`:**
1. Parses compose file, extracts `x-shipit-secrets` from each service.
2. Collects all unique secret names across services.
3. Loads values from `SecretStore` (user-configured) and resolves platform sources.
4. Writes per-service env files (`.shipit/.env.<service>`).
5. Adds `env_file:` references to the compose override.
6. Reports missing secrets to the browser.

### 2. Extended syntax for descriptions and platform sources

The simple form is a string (just the env var name). The extended form is an object:

```yaml
x-shipit-secrets:
  # Simple — just the name
  - STRIPE_KEY

  # With description — helps the user know what to configure
  - name: DATABASE_URL
    description: PostgreSQL connection string
    required: true

  # Platform credential — resolved from the outer session
  - name: ANTHROPIC_API_KEY
    source: platform:claude_oauth

  - name: GITHUB_TOKEN
    source: platform:github_token
```

**Schema:**

```typescript
// Each entry in x-shipit-secrets is either a string or an object
type SecretEntry = string | SecretRequirement;

interface SecretRequirement {
  name: string;               // env var name
  description?: string;       // shown in UI
  required?: boolean;         // default: false. Missing required → warning
  source?: string;            // "platform:claude_oauth" | "platform:github_token"
}
```

**Platform credential sources:**

| Source | Resolves to |
|--------|------------|
| `platform:claude_oauth` | Claude OAuth token from `AuthManager` |
| `platform:github_token` | GitHub token from `GitHubAuthManager` |

Platform credentials are resolved fresh on each session activation (tokens rotate), written to `.env` files like any other secret, and shown as read-only in the UI.

Docker socket forwarding is handled separately by 086's `compose.docker-socket: true` — it's a container config concern, not a secret.

### 3. Env file injection

The orchestrator writes per-service env files and references them from the compose override:

```
.shipit/.env.web             # STRIPE_KEY
.shipit/.env.api             # DATABASE_URL, REDIS_URL, STRIPE_KEY
```

```yaml
# .shipit/compose.override.yml (generated by 086, now also includes env_file)
services:
  web:
    env_file: [.shipit/.env.web]
    labels: { ... }
    networks: [shipit-session]
  api:
    env_file: [.shipit/.env.api]
    labels: { ... }
    networks: [shipit-session]
  db:
    # no env_file — no x-shipit-secrets declared
    labels: { ... }
    networks: [shipit-session]
```

**Why per-service files (not one shared `.env`):**
- Scoping is the whole point. `web` shouldn't see `DATABASE_URL`.
- Compose `env_file:` is per-service anyway.
- Avoids leaking secrets to services that don't need them.

**File format:** Standard `KEY=VALUE`. Values with special characters are quoted. Keys are sorted for deterministic writes (minimizes unnecessary container recreations when compose detects env changes).

**On secret change** (user saves via `PUT /api/secrets`):
1. Orchestrator rewrites affected `.env.<service>` files.
2. Runs `docker compose up -d`. Compose detects env change, recreates affected containers.

### 4. Agent container injection

The agent container is orchestrator-managed (not in the compose stack), so it needs a separate mechanism. Agent secrets are declared in shipit.yaml — the only place where agent config lives:

```yaml
# shipit.yaml
agent:
  install: npm install
  secrets:                     # agent-scoped secrets
    - NPM_TOKEN
    - DATABASE_URL             # agent needs it for migrations

compose: docker-compose.yml
```

This is a natural fit: `agent` already has `memory`, `cpu`, `pids`, `install`. Adding `secrets` (list of env var names to inject) follows the same pattern.

**Injection mechanism:**
- Orchestrator writes `.shipit/.env.agent` with values from `SecretStore`.
- On agent container creation: `docker create --env-file .shipit/.env.agent ...`
- For runtime secret updates (user saves while agent is running): orchestrator calls the existing session worker `PUT /secrets` endpoint (agent container still has a session worker).

**Key files:**
- `src/server/orchestrator/container-lifecycle.ts` — pass `--env-file` on container create
- `src/server/session/session-worker.ts` — existing `/secrets` endpoint (session mode)

### 5. Auto-load on session activation

Session activation flow (post-086):
1. Orchestrator creates/activates session
2. Loads secrets from `SecretStore` for the repo
3. Parses `x-shipit-secrets` from compose file + `agent.secrets` from shipit.yaml
4. Resolves platform credentials
5. Writes `.shipit/.env.<service>` and `.shipit/.env.agent`
6. Starts agent container (with `--env-file`)
7. Runs install steps (`agent.install`)
8. Generates compose override (with `env_file:` references)
9. Runs `docker compose up -d`

Secrets are in place before anything starts. The `SecretStore` already persists per-repo — auto-load is just reading what's already there.

### 6. Secret resolver

New module that composes all secret sources and produces env files:

```typescript
// src/server/orchestrator/secret-resolver.ts

interface ResolvedSecrets {
  perService: Record<string, Record<string, string>>;  // service name → env vars
  agent: Record<string, string>;                        // agent env vars
  missing: SecretRequirement[];                         // required but no value
}

async function resolveSecrets(opts: {
  composeSecrets: Record<string, SecretEntry[]>;  // service name → x-shipit-secrets
  agentSecrets: string[];                          // from shipit.yaml agent.secrets
  userSecrets: Record<string, string>;             // from SecretStore
  platformCredentials: PlatformCredentials;         // from AuthManager etc.
}): Promise<ResolvedSecrets>
```

Flow:
1. For each service's `x-shipit-secrets`, resolve each entry: `source: platform:*` → credential store, otherwise → user secrets.
2. For `agent.secrets`, resolve from user secrets.
3. Collect missing required secrets.
4. Return structured result for the service manager to write to disk.

### 7. Secrets UI enhancements

- **Requirements from compose.** Parse `x-shipit-secrets` and show in the secrets panel with descriptions. Missing required secrets show a warning icon.
- **"Configure secrets" banner.** On `secrets_missing`, show in the preview panel: "This project needs secrets to run. [Configure]".
- **Per-service display.** Show which services need each secret.
- **Platform credentials.** Read-only rows showing source label, not editable.
- **Undeclared secrets.** User-added secrets not in any `x-shipit-secrets` still work — shown in a "Custom" section, injected into all services (backward compat).

### ShipIt-in-ShipIt example

```yaml
# shipit.yaml
agent:
  memory: 3072
  cpu: 2.0
  pids: 2048
  install: npm ci

compose:
  file: docker/local/dev/compose.yml
  docker-socket: true
```

```yaml
# docker/local/dev/compose.yml
services:
  orchestrator:
    image: node:20
    command: npx tsx watch src/server/orchestrator/index.ts
    ports: ["3000:3000"]
    volumes:
      - .:/workspace
      - /var/run/docker.sock:/var/run/docker.sock
    x-shipit-preview: auto
    x-shipit-secrets:
      - name: ANTHROPIC_API_KEY
        source: platform:claude_oauth
      - name: GITHUB_TOKEN
        source: platform:github_token

  vite:
    image: node:20
    command: npx vite dev --host 0.0.0.0 --port 5173
    ports: ["5173:5173"]
    volumes:
      - .:/workspace
    x-shipit-preview: auto
```

The orchestrator service gets the outer session's Claude and GitHub tokens via platform credential forwarding. The Docker socket mount is allowed by `compose.docker-socket: true`. The vite service gets no secrets — it doesn't need any.

## Data flow

```
docker-compose.yml              shipit.yaml
(x-shipit-secrets per service)  (agent.secrets)
        │                              │
        ▼                              ▼
┌─────────────────┐    ┌──────────────────┐
│  SecretStore     │    │ CredentialStore   │
│  (user secrets)  │    │ (platform creds)  │
└────────┬────────┘    └───────┬──────────┘
         │                     │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────┐
         │  Secret Resolver │  ← merges sources, scopes per service
         │  (orchestrator)  │
         └────────┬────────┘
                  │
     ┌────────────┼────────────┐
     ▼            ▼            ▼
.shipit/       .shipit/      .shipit/
.env.web       .env.api      .env.agent
     │            │            │
     ▼            ▼            ▼
  compose      compose       docker create
  env_file     env_file      --env-file
     │            │            │
     ▼            ▼            ▼
  web service  api service   agent container
```

## Security considerations

- **`.shipit/` is gitignored.** The `.env` files are never committed. The orchestrator owns this directory.
- **Per-service isolation.** Each service only sees its declared secrets. No over-sharing by default.
- **Agent can read `.shipit/.env.*`.** The workspace volume is shared. An agent with filesystem access can read any env file. This is acceptable — the agent already has user trust to execute code. If stricter isolation is needed in the future, Docker secrets (mounted as files inside specific containers) could replace env files.
- **Platform credentials in `.env` files.** OAuth tokens written to disk is a tradeoff. Mitigations: `.shipit/` is tmpfs in production, files are 0600, tokens are session-scoped (short-lived).
- **No secrets in compose override.** The override YAML never contains secret values — only `env_file:` references. Safe to log/debug.

## Implementation phases

### Phase 1: Env file injection + auto-load
- Parse `x-shipit-secrets` (simple string form only) from compose file
- Write per-service `.shipit/.env.<service>` from `SecretStore` on session activation
- Add `env_file:` to compose override generation
- Rewrite on `PUT /api/secrets`, run `docker compose up -d` to apply
- Delete old `pushSecretsToPreview` HTTP flow
- **Depends on:** 086 compose infrastructure

### Phase 2: Extended syntax + validation
- Object form with `description`, `required`, `source`
- Validate required secrets, emit `secrets_missing` WS message
- UI: banner prompt for missing secrets, description display

### Phase 3: Agent injection
- `agent.secrets` field in shipit.yaml
- Write `.shipit/.env.agent`, pass `--env-file` on container create
- Runtime updates via session worker `/secrets`

### Phase 4: Platform credential forwarding
- `source: platform:*` resolution in secret resolver
- Integration with `AuthManager` and `GitHubAuthManager`
- UI: read-only platform credential display

### Phase 5: UI polish
- Per-service scope display
- Required/optional indicators with descriptions
- Undeclared (custom) secrets section
- Missing secrets banner in preview panel

## Key files

**New:**
- `src/server/orchestrator/secret-resolver.ts` — merges user + platform secrets, writes per-service env files
- `src/server/shipit-docs/secrets.md` — agent-facing docs for secrets in compose

**Modify (from 086):**
- `src/server/orchestrator/service-manager.ts` — call secret resolver before compose up
- `src/server/orchestrator/compose-generator.ts` — parse `x-shipit-secrets`, add `env_file:` to override
- `src/server/shared/shipit-config.ts` — parse `agent.secrets` field

**Modify (existing):**
- `src/server/orchestrator/api-routes-secrets.ts` — rewrite env files + compose up on save
- `src/server/orchestrator/container-lifecycle.ts` — `--env-file` for agent container
- `src/server/shared/types/domain-types.ts` — `SecretEntry`, `SecretRequirement` types
- `src/server/shared/types/ws-server-messages.ts` — `secrets_missing` message
- `src/server/orchestrator/credential-store.ts` — platform credential lookup
- `src/client/components/` — secrets panel enhancements

**Delete (post-086):**
- `ContainerSessionRunner.pushSecretsToPreview()` — replaced by env files
- Preview worker `PUT /secrets` endpoint — container no longer exists

## Relation to 086

This design **assumes 086 is implemented.** Phase 1 depends on 086's compose infrastructure (service manager, override generation, compose file parsing). `x-shipit-secrets` extends the compose file alongside `x-shipit-preview`. `agent.secrets` extends the `agent` block in shipit.yaml alongside `memory`, `cpu`, `pids`, `install`.

If work is needed before 086, the only pre-086 fix is wiring `setSecretsLoader` in `app-lifecycle.ts` (auto-load into the existing preview container). One-line change, no new design.
