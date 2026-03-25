# 087 — Reusable Preview Secrets Checklist

## Phase 1: Env file injection + auto-load (depends on 086)
- [ ] Create `secret-resolver.ts` with env file writing logic
- [ ] Write `.shipit/.env` from `SecretStore` on session activation (in service manager)
- [ ] Add `env_file: [.shipit/.env]` to compose override generation
- [ ] On `PUT /api/secrets`: rewrite `.env`, run `docker compose up -d`
- [ ] Remove `pushSecretsToPreview()` and preview worker `/secrets` endpoint
- [ ] Test: new session for repo with saved secrets → services start with env vars
- [ ] Test: save new secret → compose recreates containers with updated env

## Pre-086 stopgap (optional, can ship immediately)
- [ ] Wire `setSecretsLoader` in `app-lifecycle.ts` → `buildRunnerFactory()`
- [ ] Test: secrets auto-push on session activation with current preview container

## Phase 2: Declarative requirements
- [ ] Add `SecretRequirement` type to `domain-types.ts`
- [ ] Add `secrets` top-level field to `shipit-config.ts` parser
- [ ] Validate required secrets on compose start
- [ ] Add `secrets_missing` WS message type
- [ ] Emit `secrets_missing` when required secrets are absent
- [ ] Per-service scoping: write `.shipit/.env.<service>` files
- [ ] Per-service `env_file:` references in compose override
- [ ] Client: "Configure secrets" banner on `secrets_missing`
- [ ] Client: show secret descriptions from shipit.yaml
- [ ] Update `src/server/shipit-docs/shipit-yaml.md` with secrets field
- [ ] Create `src/server/shipit-docs/secrets.md` agent-facing docs

## Phase 3: Agent injection
- [ ] Write `.shipit/.env.agent` for agent-scoped secrets
- [ ] Pass `--env-file .shipit/.env.agent` on agent container creation
- [ ] Runtime secret updates via session worker `/secrets` endpoint
- [ ] Client: agent scope indicator in secrets panel
- [ ] Test: `agent: true` secret available in agent container
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
- [ ] Required/optional indicators with description tooltips
- [ ] Per-service scope labels
- [ ] Undeclared (custom) secrets section
- [ ] Missing secrets banner in preview panel with configure link
