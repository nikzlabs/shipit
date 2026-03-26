# shipit.yaml and Compose Unification — Checklist

## Phase 1: shipit.yaml parser

- [x] Create `src/server/shared/shipit-config.ts` — parse `version`, `agent`, `compose`
- [x] Create `src/server/shared/shipit-config.test.ts`
- [x] Old-format keys (`preview`, `resources`, `capabilities`, `services`) emit warnings with migration hints
- [x] Update `src/server/shared/session-config.ts` — thin wrapper over new parser
- [x] Delete `src/server/session/preview-config.ts` and `preview-config.test.ts`
- [x] Update callers of old APIs:
  - [x] `container-lifecycle.ts` — no direct import; uses `session-config.ts` which already bridges to `shipit-config.ts`
  - [x] `container-session-runner.ts` — no direct import; manages preview via HTTP to worker
  - [x] `session-worker.ts` — no direct import; uses `PreviewManager` which now inlines preview config
  - [x] `preview-manager.ts` — inlined `PreviewConfig` types and `resolvePreviewConfig()` from deleted `preview-config.ts`
  - [x] `install-runner.ts` (reads install command — added `runInstallSteps`)
  - [x] Integration tests — no tests import `preview-config.ts` directly
- [x] Migrate root `shipit.yaml` to new format

## Phase 2: Compose infrastructure

- [x] Add Docker Compose CLI to orchestrator Dockerfiles (`Dockerfile.dev`, `Dockerfile.prod`)
- [x] Create `src/server/orchestrator/compose-generator.ts` — override file generation
  - [x] Handle long-syntax port definitions (object form with published/target)
  - [x] Manual services get `profiles: ["shipit-manual"]` (preserve user-defined profiles alongside)
  - [x] Inject labels, network, `cap_drop: [NET_RAW]`
  - [x] Validate compose file: reject `privileged`, `network_mode: host`, Docker socket mounts (unless `docker-socket: true`)
  - [x] Reject absolute paths and `../` bind mounts (both string and object form volumes)
  - [x] Skip named volumes (type: volume) during security validation
- [x] Create `src/server/orchestrator/service-manager.ts` — compose lifecycle, status, logs
  - [x] Log streaming via `docker compose logs -f` with multi-viewer broadcast
  - [x] Port extraction supports IP:port:container and port/protocol formats
- [x] Wire ServiceManager into orchestrator (WS handlers for start/stop, service manager registry)
- [ ] Complete ServiceManager wiring (replace services container usage end-to-end)

## Phase 3: Orchestrator migration

- [ ] Update `container-lifecycle.ts` — remove `createPreviewContainer()`
- [ ] Update `container-session-runner.ts` — use ServiceManager instead of HTTP to services container
- [ ] Update `sse-client.ts` — replace SSE from services container with `docker compose logs` + Docker events API
- [ ] Move file watching from services container session worker to orchestrator-direct `fs.watch`
  - Config changes (`shipit.yaml`, `docker-compose.yml`) → regenerate override, reconcile stack
  - Lockfile changes → re-run install (debounced 30s)
  - Workspace tree → notify browser for file explorer
- [ ] Agent container joins compose network (`docker network connect`), re-joins on network recreation

## Phase 4: Onboarding and agent docs

- [x] Create `src/server/shipit-docs/compose.md` — concise quick-start for agent-generated compose files
- [x] Update `src/server/orchestrator/agent-instructions.ts` — reference compose.md in system prompt
- [x] Update `src/server/shipit-docs/shipit-yaml.md` for new schema
- [x] Update `src/server/shipit-docs/preview.md` and `environment.md` for compose model
- [x] Onboarding UI in preview panel ("Set up live preview" + Generate button)
- [x] Programmatic message to agent on "Generate" click (via `init_preview_config` → compose-oriented prompt)

## Phase 5: Client updates

- [x] Define new WS message types for service status (`service_status`, `service_log`, `service_list`)
- [x] Define new WS client messages for service control (`start_service`, `stop_service`)
- [x] Update `preview-store.ts` — add per-service state (name, status, port, preview mode)
- [ ] Update `file-store.ts` — if file watching events change shape
- [x] Unified service list UI component (`ServiceList.tsx` — per-service status, start/stop controls, port links)
- [x] Preview panel states (onboarding, starting, ready, error, manual, services)
- [x] Wire `service_list`, `service_status`, `service_log` WS messages to preview store via `useMessageHandler`
- [x] Update client integration tests that mock old preview/services behavior

## Phase 6: Cleanup

- [ ] Delete `src/server/session/preview-manager.ts`
- [ ] Delete `src/server/session/install-runner.ts` (install moves to orchestrator)
- [ ] Delete session worker preview endpoints and SSE event stream for preview
- [ ] Delete auto-detection heuristics (Vite detection, port extraction, package manager detection)
- [ ] Update project templates — include docker-compose.yml and new shipit.yaml
- [x] Update docs 061 and 074 to cross-reference this doc

Note: `preview-config.ts` is deleted in Phase 1 (parser replacement).
`preview-manager.ts` is deleted in Phase 6 (after ServiceManager is wired up and
tested in Phases 2–3). This ordering avoids breaking the build mid-migration.
