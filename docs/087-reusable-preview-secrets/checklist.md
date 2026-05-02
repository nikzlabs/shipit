# 087 — Reusable Preview Secrets Checklist

## Phase 1: env-file injection + auto-load (shipped, depends on 086)
- [x] Parse `x-shipit-secrets` (string form) from compose file in compose-generator
- [x] Create `secret-resolver.ts` — resolve values from `SecretStore`, write per-service env files
- [x] Generate compose override with `env_file: [.shipit/.env.<service>]` per service
- [x] Auto-load from `SecretStore` on session activation (wired in `setupServiceManager`)
- [x] On `PUT /api/secrets`: rewrite env files, run `docker compose up -d` for every active session backed by the repo
- [x] Sweep stale `.shipit/.env.<svc>` files on every reconcile
- [x] Remove `pushSecretsToPreview()` (already gone) and unused `setSecretsLoader()` skeleton on `ContainerSessionRunner`
- [x] Test: parsing of `x-shipit-secrets` string form (and object-form forward-compat)
- [x] Test: resolver writes per-service env files with correct scoping
- [x] Test: ServiceManager writes env files on `start()` and `refreshSecrets()`
- [x] Test: override emits `env_file:` only for services with declared secrets

## Phase 1 follow-up: Docker-secrets security upgrade
- [x] Create `secrets-entrypoint.sh` — POSIX shell wrapper exporting `/run/secrets/shipit-*` as env vars
- [x] Bake entrypoint script into orchestrator Docker images (`Dockerfile.dev`, `Dockerfile.prod`)
- [x] Add `writeIsolatedSecretFiles()` + `composeSecretFilePath()` to secret-resolver
- [x] Generate compose override with `secrets:` top-level + per-service references (replace env_file)
- [x] Inject entrypoint wrapper into compose override (preserve user entrypoint if set)
- [x] Plumb `dockerSecretsConfig` through ServiceManager + opt-in via `SHIPIT_SECRETS_INTERNAL_DIR` env vars
- [x] Test: writeIsolatedSecretFiles writes per-secret files with 0600 mode + sweeps stale entries
- [x] Test: ServiceManager Docker-secrets mode writes outside workspace + skips env_file emission
- [x] Test: ServiceManager sweeps leftover `.env.<svc>` files when switching to Docker-secrets mode

## Phase 2: Extended syntax + validation
- [x] Add `SecretEntry` / `SecretRequirement` types to `domain-types.ts`
- [x] Parse object form (`name`, `description`, `required`, `agent`, `source`)
- [x] Validate required secrets on compose start (surfaces via `missingRequiredByService`)
- [x] Add `secrets_status` WS message type (carries declared/missing/agentNames)
- [x] Emit `secrets_status` whenever syncSecrets runs (start/reconcile/refresh)
- [x] Client: "Configure secrets" banner on missing required secrets in PreviewFrame
- [x] Client: show secret descriptions from compose file
- [x] Update `src/server/shipit-docs/compose.md` with `x-shipit-secrets` pointer
- [x] Create `src/server/shipit-docs/secrets.md` agent-facing docs

## Phase 3: Agent injection
- [x] Collect `agent: true` entries from `x-shipit-secrets` across all services
- [x] Write `.shipit/.env.agent` to workspace (and remove when no agent: true entries remain)
- [x] Push agent values into the worker via `PUT /secrets` HTTP endpoint
- [x] Worker `/secrets` endpoint replaces process.env on every call (drops removed names)
- [x] Client: agent badge in declared-secrets panel
- [x] Test: `agent: true` secret appears in `agentValues` + agentEnv
- [x] Test: non-agent secret NOT in agentEnv
- [x] Test: worker /secrets endpoint validates input + injects + drops keys

## Phase 4: Platform credential forwarding
- [x] Create `platform-credentials.ts` with `PlatformCredentialProvider` interface
- [x] Implement `platform:claude_oauth` resolution (ANTHROPIC_API_KEY → .credentials.json fallback)
- [x] Implement `platform:github_token` resolution via GitHubAuthManager
- [x] Add `getToken()` getter on GitHubAuthManager for the platform pipeline
- [x] Integrate platform sources into `secret-resolver.ts` (platform value wins, falls back to user secret)
- [x] Wire provider through app-lifecycle / index → ServiceManager
- [x] Client: read-only platform credential rows in Settings → Secrets
- [x] Test: platform sources resolve correctly + fall back to user values when empty
- [x] Test: unknown sources return null without breaking
- [x] Test: malformed credentials.json handled gracefully

## Phase 5: UI polish
- [x] Per-service scope display (chips for each consumer service)
- [x] Required indicators (with warning style when missing)
- [x] Agent badge for `agent: true` declarations
- [x] Platform badge for `source: platform:*` declarations (with helpful "Provided automatically" copy)
- [x] Description display below each declared secret name
- [x] Custom (undeclared) secrets section — for ad-hoc env vars not yet in any compose service
- [x] Missing secrets banner in preview panel with one-click "Configure" button
- [x] Tests: declared section, required indicator, agent/platform badges, description display, save excludes platform rows
