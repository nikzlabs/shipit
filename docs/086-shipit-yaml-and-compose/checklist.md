# shipit.yaml and Compose Unification — Checklist

## Phase 1: shipit.yaml parser

- [ ] Create `src/server/shared/shipit-config.ts` — parse `version`, `agent`, `compose`
- [ ] Create `src/server/shared/shipit-config.test.ts`
- [ ] Update `src/server/shared/session-config.ts` — thin wrapper over new parser
- [ ] Delete `src/server/session/preview-config.ts`
- [ ] Delete `src/server/session/preview-config.test.ts`
- [ ] Update all callers of old preview-config and session-config APIs
- [ ] Migrate root `shipit.yaml` to new format
- [ ] Update `src/server/shipit-docs/shipit-yaml.md` for new schema

## Phase 2: Compose infrastructure

- [ ] Add Docker Compose CLI to orchestrator Dockerfiles (`Dockerfile.dev`, `Dockerfile.prod`)
- [ ] Create `src/server/orchestrator/compose-generator.ts` — override file generation
- [ ] Create `src/server/orchestrator/service-manager.ts` — compose lifecycle, status, logs
- [ ] Wire ServiceManager into orchestrator (replace services container usage)

## Phase 3: Orchestrator migration

- [ ] Update `container-lifecycle.ts` — remove `createPreviewContainer()`
- [ ] Update `container-session-runner.ts` — use ServiceManager
- [ ] Update `sse-client.ts` — replace SSE with `docker compose logs`
- [ ] Move file watching to orchestrator-direct `fs.watch`
- [ ] Agent container joins compose network (`docker network connect`)

## Phase 4: Onboarding and agent docs

- [ ] Create `src/server/shipit-docs/compose.md` — agent guide for generating compose files
- [ ] Update `src/server/orchestrator/agent-instructions.ts` — reference compose.md
- [ ] Onboarding UI in preview panel ("Set up live preview" + Generate button)
- [ ] Programmatic message to agent on "Generate" click

## Phase 5: Client updates

- [ ] Unified service list UI (per-service status, logs, start/stop)
- [ ] Preview panel states (onboarding, starting, ready, error, manual)

## Phase 6: Cleanup

- [ ] Delete `src/server/session/preview-manager.ts`
- [ ] Delete `src/server/session/install-runner.ts` (if install moves to orchestrator)
- [ ] Delete session worker preview endpoints
- [ ] Delete auto-detection heuristics (Vite, port extraction, package manager detection)
- [ ] Update project templates — include docker-compose.yml and new shipit.yaml
- [ ] Update `preview.md` and `environment.md` in shipit-docs
