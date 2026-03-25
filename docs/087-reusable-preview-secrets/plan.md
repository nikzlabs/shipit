---
status: planned
---

# 087 — Reusable Preview Secrets

Follow-up to [086 — shipit.yaml and Compose](../086-shipit-yaml-and-compose/plan.md). Designs a complete secrets pipeline so environment variables (API keys, tokens, database URLs) flow reliably into preview containers — configured once and reused across every session and preview restart for a repo.

## Problem

Today secrets have gaps that make "develop ShipIt within ShipIt" painful:

1. **No auto-load on session start.** `setSecretsLoader()` exists on `ContainerSessionRunner` but is never wired up. Secrets only reach the preview when explicitly saved via `PUT /api/secrets` — if you restart a session or create a new one for the same repo, you must re-push secrets manually.

2. **Preview-only scope.** Secrets are pushed to the preview container's `process.env` but are *not* available inside the agent (session) container. If the agent needs to run a build step, migration, or test that requires a secret, it has no access.

3. **No secret references in shipit.yaml / compose.** There's no way to declare which secrets a project needs. Users must remember to configure them out-of-band.

4. **No "ShipIt-in-ShipIt" workflow.** When developing ShipIt itself inside ShipIt, the inner instance needs credentials (Claude OAuth, GitHub tokens, Docker socket access). There's no mechanism to forward the outer session's ambient credentials to the inner preview.

5. **No validation or feedback.** If a required secret is missing, the preview silently fails. There's no UI indication of which secrets are expected vs configured.

## Goals

- **Configure once, use everywhere.** Secrets saved for a repo auto-load into every new session and survive preview restarts.
- **Agent + preview access.** Secrets are available in both containers when needed.
- **Declarative requirements.** `shipit.yaml` (or compose env) can declare required secrets so the platform can validate and prompt.
- **ShipIt-in-ShipIt.** A first-class mechanism to forward platform credentials to inner previews.
- **Backward-compatible.** Existing `PUT /api/secrets` flow continues to work unchanged.

## Design

### 1. Auto-load secrets on session activation

Wire up the existing `setSecretsLoader` hook so secrets are pushed automatically when a session's preview container starts.

```
buildRunnerFactory() {
  const runner = new ContainerSessionRunner(...)
  runner.setSecretsLoader(async () => {
    return secretStore.loadSecrets(repoUrl)
  })
  return runner
}
```

In `startWorkerResources()`, the loader fires before the preview command starts — secrets are in `process.env` before the dev server spawns. This is the minimal fix and should ship first.

**Key files:**
- `src/server/orchestrator/app-lifecycle.ts` — wire `setSecretsLoader`
- `src/server/orchestrator/container-session-runner.ts` — already has the hook

### 2. Declarative secret requirements in shipit.yaml

Add an optional `secrets` field to `shipit.yaml`:

```yaml
secrets:
  - name: DATABASE_URL
    description: PostgreSQL connection string
    required: true
  - name: STRIPE_KEY
    description: Stripe API key for payment tests
```

The platform reads this at preview start and:
- Validates that all `required` secrets have values in the secret store.
- Emits a `secrets_missing` event (new server→client message) listing missing keys so the UI can prompt the user.
- Non-required secrets with descriptions appear in the secrets panel as placeholders.

When 086 lands with compose support, secrets declared here map to the compose environment block — the platform generates an env file or injects them into the override compose.

**Key files:**
- `src/server/session/preview-config.ts` (or new `shipit-config.ts` from 086) — parse `secrets` field
- `src/server/shared/types/domain-types.ts` — `SecretRequirement` type
- `src/server/shared/types/ws-server-messages.ts` — `secrets_missing` message type

### 3. Dual-container secret injection

Currently secrets only go to the preview container. Extend to support the agent container too, controlled by a scope field:

```yaml
secrets:
  - name: DATABASE_URL
    scope: preview          # default — only preview container
  - name: NPM_TOKEN
    scope: agent            # only agent container
  - name: SHARED_API_KEY
    scope: both             # both containers
```

Implementation:
- `ContainerSessionRunner.pushSecretsToSession(secrets)` — new method, mirrors `pushSecretsToPreview` but targets the session worker's new `PUT /secrets` endpoint.
- The session worker (session mode) adds a `/secrets` endpoint that sets `process.env` — same pattern as the existing preview-mode endpoint.
- `api-routes-secrets.ts` reads scope from the secret requirements and pushes to the appropriate container(s).

**Key files:**
- `src/server/orchestrator/container-session-runner.ts` — new `pushSecretsToSession()`
- `src/server/session/session-worker.ts` — add `/secrets` to session mode
- `src/server/orchestrator/api-routes-secrets.ts` — scope-aware push

### 4. Platform credential forwarding (ShipIt-in-ShipIt)

When developing ShipIt inside ShipIt, the inner instance needs the outer session's ambient credentials. Add a new secret source: **platform credentials**.

```yaml
secrets:
  - name: ANTHROPIC_API_KEY
    source: platform:claude_oauth
  - name: GITHUB_TOKEN
    source: platform:github_token
  - name: DOCKER_HOST
    source: platform:docker_socket
```

The `source: platform:<credential>` syntax tells the orchestrator to resolve the value from the current session's credential store rather than the user-managed secret store. Available platform credentials:

| Source | Resolves to |
|--------|------------|
| `platform:claude_oauth` | The session's Claude OAuth token (from `AuthManager`) |
| `platform:github_token` | The session's GitHub token (from `GitHubAuthManager`) |
| `platform:docker_socket` | Mounts the Docker socket proxy into the preview container |

Platform credentials are:
- **Read-only** — they don't appear in the secrets UI and can't be edited.
- **Session-scoped** — they resolve fresh on each session activation (tokens may rotate).
- **Opt-in** — the project's `shipit.yaml` must explicitly request them.

For `docker_socket`, this isn't an env var — it triggers the orchestrator to configure the preview container with Docker socket access (similar to `capabilities.docker` but forwarding the *outer* socket proxy).

**Key files:**
- `src/server/orchestrator/credential-store.ts` — expose credential resolution API
- `src/server/orchestrator/container-session-runner.ts` — resolve platform sources before push
- `src/server/session/preview-config.ts` — parse `source` field

### 5. Secrets UI enhancements

Extend the existing secrets panel:

- **Required secrets indicator.** Show which secrets are declared in `shipit.yaml` with descriptions. Missing required secrets show a warning badge.
- **"Configure secrets" prompt.** When `secrets_missing` fires, show a non-blocking banner in the preview panel: "This project needs secrets to run. [Configure]".
- **Scope labels.** Show which container(s) each secret is injected into.
- **Platform credentials section.** Read-only display of forwarded platform credentials (name only, not values).

**Key files:**
- `src/client/components/` — secrets panel components
- `src/client/stores/settings-store.ts` — or new secrets store

## Data flow

```
shipit.yaml (declares requirements)
        │
        ▼
┌─────────────────┐    ┌──────────────┐
│  SecretStore     │    │ CredentialStore │
│  (user secrets)  │    │ (platform creds)│
└────────┬────────┘    └───────┬────────┘
         │                     │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────┐
         │  Secret Resolver │  ← merges user secrets + platform creds
         │  (orchestrator)  │     filters by scope
         └────────┬────────┘
                  │
          ┌───────┴───────┐
          ▼               ▼
   PUT /secrets      PUT /secrets
   (session worker)  (preview worker)
          │               │
          ▼               ▼
    process.env      process.env
    (agent container) (preview container)
```

## Implementation phases

### Phase 1: Auto-load (minimal fix)
- Wire `setSecretsLoader` in `app-lifecycle.ts`
- Secrets auto-push on session activation
- No schema changes

### Phase 2: Declarative requirements
- Add `secrets` field to shipit.yaml schema
- Parse and validate in preview config
- `secrets_missing` WS message
- UI prompt for missing secrets

### Phase 3: Dual-container injection
- Session worker `/secrets` endpoint
- `pushSecretsToSession()` on runner
- Scope field support (`preview` | `agent` | `both`)

### Phase 4: Platform credential forwarding
- `source: platform:*` resolution
- Integration with `AuthManager` and `GitHubAuthManager`
- Docker socket forwarding for inner ShipIt

### Phase 5: UI polish
- Required/optional indicators
- Scope labels
- Platform credentials display
- Missing secrets banner in preview panel

## Key files

**Existing (modify):**
- `src/server/orchestrator/app-lifecycle.ts` — wire secrets loader
- `src/server/orchestrator/container-session-runner.ts` — dual push, platform resolution
- `src/server/orchestrator/api-routes-secrets.ts` — scope-aware push
- `src/server/orchestrator/secret-store.ts` — no changes needed for phase 1
- `src/server/session/session-worker.ts` — `/secrets` endpoint in session mode
- `src/server/session/preview-config.ts` — parse secrets requirements
- `src/server/shared/types/domain-types.ts` — `SecretRequirement`, `SecretScope`
- `src/server/shared/types/ws-server-messages.ts` — `secrets_missing` message

**New:**
- `src/server/orchestrator/secret-resolver.ts` — merges user + platform secrets, filters by scope
- `src/server/shipit-docs/secrets.md` — agent-facing docs for secrets

## Relation to 086

086 replaces `shipit.yaml` with a minimal schema + Docker Compose. This design is compatible with both the current schema and 086's planned schema:

- **Pre-086:** `secrets` field lives in `shipit.yaml` alongside `preview` and `install`.
- **Post-086:** `secrets` field moves to the new minimal `shipit.yaml` (alongside `agent` and `compose`). Compose services reference secrets via standard compose `environment` blocks; the platform generates an `.env` file from the resolved secrets.

Phase 1 (auto-load) has no dependency on 086 and should ship immediately. Phases 2-4 should coordinate with 086 on the final schema shape.
