# 087 — Reusable Preview Secrets Checklist

## Phase 1: Docker secrets injection + auto-load (depends on 086)
- [ ] Parse `x-shipit-secrets` (string form) from compose file in compose-generator
- [ ] Create `secret-resolver.ts` — resolve values, write per-secret files to orchestrator storage
- [ ] Create `secrets-entrypoint.sh` — POSIX shell wrapper exporting `/run/secrets/shipit-*` as env vars
- [ ] Bake entrypoint script into orchestrator Docker images
- [ ] Generate compose override with `secrets:` top-level + per-service references
- [ ] Inject entrypoint wrapper into compose override (preserve user entrypoint if set)
- [ ] Auto-load from `SecretStore` on session activation
- [ ] On `PUT /api/secrets`: rewrite secret files, run `docker compose up -d`
- [ ] Remove `pushSecretsToPreview()` and preview worker `/secrets` endpoint
- [ ] Test: new session with saved secrets → services start with correct env vars
- [ ] Test: save new secret → compose recreates affected containers
- [ ] Test: service only sees its own declared secrets
- [ ] Test: agent container cannot read service secrets

## Pre-086 stopgap (optional, can ship immediately)
- [ ] Wire `setSecretsLoader` in `app-lifecycle.ts` → `buildRunnerFactory()`

## Phase 2: Extended syntax + validation
- [ ] Add `SecretEntry` / `SecretRequirement` types to `domain-types.ts`
- [ ] Parse object form (`name`, `description`, `required`, `agent`, `source`)
- [ ] Validate required secrets on compose start
- [ ] Add `secrets_missing` WS message type
- [ ] Emit `secrets_missing` when required secrets are absent
- [ ] Client: "Configure secrets" banner on `secrets_missing`
- [ ] Client: show secret descriptions from compose file
- [ ] Update `src/server/shipit-docs/shipit-yaml.md` with `x-shipit-secrets` docs
- [ ] Create `src/server/shipit-docs/secrets.md` agent-facing docs

## Phase 3: Agent injection
- [ ] Collect `agent: true` entries from `x-shipit-secrets` across all services
- [ ] Write `.env.agent` to orchestrator storage (not workspace volume)
- [ ] Pass `--env-file` on agent container creation
- [ ] Runtime secret updates via session worker `/secrets` endpoint
- [ ] Client: agent scope indicator in secrets panel
- [ ] Test: `agent: true` secret available in agent container
- [ ] Test: non-agent secret NOT in agent container

## Phase 4: Platform credential forwarding
- [ ] Add platform credential lookup to `credential-store.ts`
- [ ] Implement `platform:claude_oauth` resolution via `AuthManager`
- [ ] Implement `platform:github_token` resolution via `GitHubAuthManager`
- [ ] Integrate platform sources into `secret-resolver.ts`
- [ ] Client: read-only platform credential display
- [ ] Test: inner ShipIt compose service receives outer Claude OAuth token
- [ ] Test: inner ShipIt compose service receives outer GitHub token

## Phase 5: UI polish
- [ ] Per-service scope display
- [ ] Required/optional indicators with description tooltips
- [ ] Undeclared (custom) secrets section
- [ ] Missing secrets banner in preview panel with configure link
