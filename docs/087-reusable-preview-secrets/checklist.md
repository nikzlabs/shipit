# 087 — Reusable Preview Secrets Checklist

## Phase 1: Auto-load (minimal fix)
- [ ] Wire `setSecretsLoader` in `app-lifecycle.ts` → `buildRunnerFactory()`
- [ ] Verify secrets auto-push on session activation
- [ ] Test: new session for repo with saved secrets gets them in preview env
- [ ] Test: preview restart retains secrets

## Phase 2: Declarative requirements
- [ ] Add `SecretRequirement` type to `domain-types.ts`
- [ ] Add `secrets` field to shipit.yaml parser
- [ ] Validate required secrets against secret store on preview start
- [ ] Add `secrets_missing` WS message type
- [ ] Emit `secrets_missing` when required secrets are absent
- [ ] Client: show "Configure secrets" banner on `secrets_missing`
- [ ] Update `src/server/shipit-docs/shipit-yaml.md` with secrets field docs
- [ ] Create `src/server/shipit-docs/secrets.md` agent-facing docs

## Phase 3: Dual-container injection
- [ ] Add `PUT /secrets` endpoint to session-worker in session mode
- [ ] Add `pushSecretsToSession()` to `ContainerSessionRunner`
- [ ] Add `scope` field to `SecretRequirement` (`preview` | `agent` | `both`)
- [ ] Route secrets to correct container(s) based on scope
- [ ] Test: agent-scoped secret available in session container
- [ ] Test: preview-scoped secret NOT in session container

## Phase 4: Platform credential forwarding
- [ ] Create `secret-resolver.ts` — merge user + platform secrets
- [ ] Implement `platform:claude_oauth` source resolution
- [ ] Implement `platform:github_token` source resolution
- [ ] Implement `platform:docker_socket` forwarding
- [ ] Test: inner ShipIt preview can authenticate with Claude
- [ ] Test: inner ShipIt preview can access GitHub API
- [ ] Coordinate with 086 on compose env file generation

## Phase 5: UI polish
- [ ] Show required/optional indicators in secrets panel
- [ ] Show scope labels per secret
- [ ] Read-only platform credentials section
- [ ] Missing secrets banner in preview panel with link to configure
