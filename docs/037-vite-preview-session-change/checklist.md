## Implementation checklist

### Phase 1: Foundation

- [x] Install `yaml` npm package (not currently in package.json)
- [x] Create `src/server/preview-config.ts` — `PreviewConfig` / `PreviewMode` types with `install?: string` field, `resolvePreviewConfig()` with shipit.yaml → package.json → index.html → none fallback, port extraction from dev script strings, `command`/`html` mutual exclusivity validation, `install` field extraction from shipit.yaml
- [x] Write `src/server/preview-config.test.ts` — all 12 unit test cases from plan (command+single port, command+multiple ports, command-only, html mode, command+html rejection, directory, package.json fallback, port extraction, index.html fallback, no files, no dev script + no index.html, malformed yaml)

### Phase 2: PreviewManager

- [x] Create `src/server/preview-manager.ts` — extend EventEmitter, `start/stop/restart`, `running/port/ports/config` getters, `html` mode (reuse ViteManager's wrapper config + bundled binary on port 5173), `command` mode (shell spawn + port polling), auto-detect fallback, install step before preview start (uses install-runner.ts from [doc 039](../039-install-command/plan.md))
- [x] Delete `src/server/vite-manager.ts` after migrating its logic into PreviewManager
- [x] Update `StubViteManager` in `test-helpers.ts` → `StubPreviewManager` with `ports` array, `config` getter, matching the new interface

### Phase 3: Server integration (`index.ts`)

- [x] Replace all `viteManager` references with `previewManager` in `buildApp()`
- [x] Update `AppDeps` type — replace `viteManager` with `previewManager`
- [x] Update `getPreviewStatus()` — merge managed ports (after primary) with scanner-detected ports into `detectedPorts`; use `source: "managed"` for command mode, `"vite"` for html mode
- [x] Update `activateSession()` — on directory change: stop preview, clear `detectedPorts`, broadcast not-running status, clear log buffer, broadcast `clear_logs`, start preview for new dir, run fresh port scan
- [x] Update post-turn handler — `previewManager.start()` instead of `viteManager.start()`
- [x] Add FileWatcher integration — detect `shipit.yaml` in changed paths, call `previewManager.restart()`
- [x] Handle `init_preview_config` client message — send Claude a prompt to create shipit.yaml
- [x] Broadcast `preview_config_missing` / `preview_config_error` / `install_status` on PreviewManager events

### Phase 4: Types

- [x] Add `WsInstallStatus` to `WsServerMessage` union in `src/server/types/ws-server-messages.ts`
- [x] Add `WsPreviewConfigMissing`, `WsPreviewConfigError`, `WsInitPreviewConfig` to `src/server/types.ts`
- [x] Add `clear_logs` to `WsServerMessage` union (if not already present)
- [x] Update `WsPreviewStatus.source` to include `"managed"` alongside existing `"vite" | "detected"`

### Phase 5: Client

- [x] Handle `preview_config_missing` message — set state to show config-missing UI
- [x] Handle `preview_config_error` message — show error in preview pane
- [x] Handle `install_status` message — show install progress/error in preview pane
- [x] Handle `clear_logs` message — clear `logEntries` and `unreadLogCount`
- [x] Add `init_preview_config` send support — new callback for PreviewFrame
- [x] Update PreviewFrame — show "No preview server configured" + "Set up with Claude" button when config missing; show "Installing dependencies..." spinner during install; show install errors

### Phase 6: Templates (done)

- [x] Add `shipit.yaml` to every template in `templates.ts` that serves HTTP (all except node-cli-ts) — command mode templates get `install`+`command`+`ports`, static-html gets `html: index.html`

### Phase 7: Integration tests

- [x] Create `src/server/integration_tests/preview-config.test.ts` — preview status on connect, session switch broadcasts, init_preview_config sends Claude prompt

### Phase 8: Client tests

- [x] Test PreviewFrame renders config-missing prompt
- [x] Test config-missing button sends `init_preview_config`
- [x] Test install running state
- [x] Test install error state
- [x] Test managed source preview

### Phase 9: Final

- [x] Run full test suite (`npm test`), lint (`npm run lint`), typecheck (`npm run typecheck`)
- [x] Update plan.md status to `done`
