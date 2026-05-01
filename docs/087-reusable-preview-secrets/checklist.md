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
- [ ] Create `secrets-entrypoint.sh` — POSIX shell wrapper exporting `/run/secrets/shipit-*` as env vars
- [ ] Bake entrypoint script into orchestrator Docker images (`Dockerfile.dev`, `Dockerfile.prod`)
- [ ] Mount a host-shared secrets directory readable by the Docker daemon
- [ ] Generate compose override with `secrets:` top-level + per-service references (replace env_file)
- [ ] Inject entrypoint wrapper into compose override (preserve user entrypoint if set)
- [ ] Test: agent container cannot read service secrets from the workspace

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
