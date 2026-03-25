# 087 — Reusable Preview Secrets Checklist

## Phase 1: Env file injection + auto-load (depends on 086)
- [ ] Parse `x-shipit-secrets` (string form) from compose file in compose-generator
- [ ] Create `secret-resolver.ts` with per-service env file writing
- [ ] Write `.shipit/.env.<service>` from `SecretStore` on session activation
- [ ] Add `env_file:` to compose override generation
- [ ] On `PUT /api/secrets`: rewrite env files, run `docker compose up -d`
- [ ] Remove `pushSecretsToPreview()` and preview worker `/secrets` endpoint
- [ ] Test: new session with saved secrets → services start with correct env vars
- [ ] Test: save new secret → compose recreates affected containers
- [ ] Test: service only sees its own declared secrets

## Pre-086 stopgap (optional, can ship immediately)
- [ ] Wire `setSecretsLoader` in `app-lifecycle.ts` → `buildRunnerFactory()`

## Phase 2: Extended syntax + validation
- [ ] Add `SecretEntry` / `SecretRequirement` types to `domain-types.ts`
- [ ] Parse object form (`name`, `description`, `required`, `source`)
- [ ] Validate required secrets on compose start
- [ ] Add `secrets_missing` WS message type
- [ ] Emit `secrets_missing` when required secrets are absent
- [ ] Client: "Configure secrets" banner on `secrets_missing`
- [ ] Client: show secret descriptions from compose file
- [ ] Update `src/server/shipit-docs/shipit-yaml.md` with `x-shipit-secrets` docs
- [ ] Create `src/server/shipit-docs/secrets.md` agent-facing docs

## Phase 3: Agent injection
- [ ] Add `agent.secrets` field to shipit-config parser
- [ ] Write `.shipit/.env.agent` for agent-scoped secrets
- [ ] Pass `--env-file .shipit/.env.agent` on agent container creation
- [ ] Runtime secret updates via session worker `/secrets` endpoint
- [ ] Client: agent scope indicator in secrets panel
- [ ] Test: `agent.secrets` value available in agent container
- [ ] Test: service-only secret NOT in agent container

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
