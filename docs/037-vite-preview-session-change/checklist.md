## Implementation checklist

### Phase 1: Foundation

- [ ] Install `yaml` npm package (not currently in package.json)
- [ ] Create `src/server/preview-config.ts` — `PreviewConfig` / `PreviewMode` types with `install?: string` field, `resolvePreviewConfig()` with shipit.yaml → package.json → index.html → none fallback, port extraction from dev script strings, `command`/`html` mutual exclusivity validation, `install` field extraction from shipit.yaml
- [ ] Write `src/server/preview-config.test.ts` — all 16 unit test cases from plan (command+single port, command+multiple ports, command-only, html mode, command+html rejection, directory, package.json fallback, port extraction, index.html fallback, no files, no dev script + no index.html, malformed yaml, install field present, install field absent, non-string install rejected, package.json fallback has no install)

### Phase 1b: Install runner (done)

- [x] Create `src/server/install-runner.ts` — `parseInstallCommand()`, `isInstallDone()`, `markInstallDone()`, `clearInstallMarker()`, `runInstallCommand()` utility functions
- [x] Add `WsInstallStatus` type to `src/server/types/ws-server-messages.ts`
- [x] Add `"install"` to `WsLogEntry.source` union in `src/server/types/terminal-types.ts`
- [x] Wire install into `template-handlers.ts` — `runTemplateInstall()` helper runs install after template application (both `apply_template` and `home_create_repo_with_template`)
- [x] Add `shipit.yaml` with `install: npm install` to all templates with `package.json` in `templates.ts`
- [x] Add `shipit.yaml` with `preview: html: index.html` to static-html template (no install)

### Phase 2: PreviewManager

- [ ] Create `src/server/preview-manager.ts` — extend EventEmitter, `start/stop/restart`, `running/port/ports/config` getters, `html` mode (reuse ViteManager's wrapper config + bundled binary on port 5173), `command` mode (shell spawn + port polling), auto-detect fallback, install step before preview start (uses install-runner.ts)
- [ ] Delete `src/server/vite-manager.ts` after migrating its logic into PreviewManager
- [ ] Update `StubViteManager` in `test-helpers.ts` → `StubPreviewManager` with `ports` array, `config` getter, matching the new interface

### Phase 3: Server integration (`index.ts`)

- [ ] Replace all `viteManager` references with `previewManager` in `buildApp()`
- [ ] Update `AppDeps` type — replace `createViteManager` with `createPreviewManager` (or equivalent factory)
- [ ] Update `getPreviewStatus()` — merge managed ports (after primary) with scanner-detected ports into `detectedPorts`; use `source: "managed"` for command mode, `"vite"` for html mode
- [ ] Update `activateSession()` — on directory change: stop preview, `killProcessesOnPorts()`, clear `detectedPorts`, broadcast not-running status, clear log buffer, broadcast `clear_logs`, start preview for new dir, run fresh port scan
- [ ] Update `new_session` handler — stop preview, kill port processes, clear detected ports, broadcast status, clear logs
- [ ] Update post-turn handler — `previewManager.start()` instead of `viteManager.start()`
- [ ] Add FileWatcher integration — detect `shipit.yaml` in changed paths, call `previewManager.restart()` (also clears install marker so install re-runs with new config)
- [ ] Add `killProcessesOnPorts(ports, sessionsRoot)` helper — fuser + /proc/pid/cwd safety guard
- [ ] Handle `init_preview_config` client message — send Claude a prompt to create shipit.yaml (prompt now includes install field example)
- [ ] Broadcast `preview_config_missing` / `preview_config_error` / `install_status` on PreviewManager events

### Phase 4: Types

- [x] Add `WsInstallStatus` to `WsServerMessage` union in `src/server/types/ws-server-messages.ts`
- [ ] Add `WsPreviewConfigMissing`, `WsPreviewConfigError`, `WsInitPreviewConfig` to `src/server/types.ts`
- [ ] Add `clear_logs` to `WsServerMessage` union (if not already present)
- [ ] Update `WsPreviewStatus.source` to include `"managed"` alongside existing `"vite" | "detected"`

### Phase 5: Client

- [ ] Add preview state reset to `resumeSessionInternal()` in App.tsx — `setPreview(null)`, `setSelectedPort(null)`, `clearPreviewErrors()`, reset autofix state, clear logs
- [ ] Add preview state reset to `handleSessionNew()` in App.tsx — same resets
- [ ] Handle `preview_config_missing` message — set state to show config-missing UI
- [ ] Handle `preview_config_error` message — show error in preview pane
- [ ] Handle `install_status` message — show install progress/error in preview pane
- [ ] Handle `clear_logs` message — clear `logEntries` and `unreadLogCount`
- [ ] Add `init_preview_config` send support — new callback for PreviewFrame
- [ ] Update PreviewFrame — show "No preview server configured" + "Set up with Claude" button when config missing; show "Installing dependencies..." spinner during install; show install errors with "Retry" button

### Phase 6: Templates

- [x] Add `shipit.yaml` to every template in `templates.ts` that serves HTTP (all except node-cli-ts) — command mode templates get `install`+`command`+`ports`, static-html gets `html: index.html`

### Phase 7: Integration tests

- [ ] Create `src/server/integration_tests/session-switch-preview.test.ts` — preview restarts on switch, detected ports cleared, new session clears preview, same-session no-op, clear_logs broadcast, config-missing prompt, init_preview_config sends Claude prompt

### Phase 7b: Install integration tests

- [ ] Test install runs before preview (assert `install_status { status: "running" }` sent)
- [ ] Test install failure blocks preview (assert `install_status { status: "error" }`)
- [ ] Test install skipped when marker exists (no `install_status` message sent)
- [ ] Test install marker written on success (`.shipit/.install-done` exists)

### Phase 8: Client tests

- [ ] Test `resumeSessionInternal` resets preview state
- [ ] Test `handleSessionNew` resets preview state
- [ ] Test PreviewFrame renders config-missing prompt
- [ ] Test config-missing button sends `init_preview_config`
- [ ] Test PreviewFrame shows install progress spinner
- [ ] Test PreviewFrame shows install error with retry button

### Phase 9: Template tests

- [ ] Test all HTTP-serving templates include valid `shipit.yaml` with `preview.command`/`preview.ports` or `preview.html`
- [ ] Test all npm templates include `install: npm install` in their `shipit.yaml`

### Phase 10: Install runner unit tests

- [ ] Test `parseInstallCommand()` extracts install command from yaml string
- [ ] Test `parseInstallCommand()` returns undefined when no install field
- [ ] Test `isInstallDone()` / `markInstallDone()` / `clearInstallMarker()` marker lifecycle
- [ ] Test `runInstallCommand()` with a simple command (e.g. `echo hello`)

### Phase 11: Final

- [ ] Run full test suite (`npm test`), lint (`npm run lint`), typecheck (`npm run typecheck`)
- [ ] Update plan.md status to `done`, delete this checklist
