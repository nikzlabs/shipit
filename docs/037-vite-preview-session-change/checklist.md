## Implementation checklist

### Phase 1: Foundation

- [ ] Install `yaml` npm package (not currently in package.json)
- [ ] Create `src/server/preview-config.ts` — `PreviewConfig` type, `resolvePreviewConfig()` with shipit.yaml → package.json → none fallback, port extraction from dev script strings
- [ ] Write `src/server/preview-config.test.ts` — all 9 unit test cases from plan (single port, multiple ports, no ports, directory, package.json fallback, port extraction, missing files, no dev script, malformed yaml)

### Phase 2: PreviewManager

- [ ] Create `src/server/preview-manager.ts` — extend EventEmitter, `start/stop/restart`, `running/port/ports/config` getters, bare-`vite` special case (reuse ViteManager's wrapper config + bundled binary logic), general shell command path, port polling (all configured ports or scan-port auto-detect)
- [ ] Delete `src/server/vite-manager.ts` after migrating its logic into PreviewManager
- [ ] Update `StubViteManager` in `test-helpers.ts` → `StubPreviewManager` with `ports` array, `config` getter, matching the new interface

### Phase 3: Server integration (`index.ts`)

- [ ] Replace all `viteManager` references with `previewManager` in `buildApp()`
- [ ] Update `AppDeps` type — replace `createViteManager` with `createPreviewManager` (or equivalent factory)
- [ ] Update `getPreviewStatus()` — merge managed ports (after primary) with scanner-detected ports into `detectedPorts`; use `source: "managed"` instead of `"detected"` for config-driven previews
- [ ] Update `activateSession()` — on directory change: stop preview, `killProcessesOnPorts()`, clear `detectedPorts`, broadcast not-running status, clear log buffer, broadcast `clear_logs`, start preview for new dir, run fresh port scan
- [ ] Update `new_session` handler — stop preview, kill port processes, clear detected ports, broadcast status, clear logs
- [ ] Update post-turn handler — `previewManager.start()` instead of `viteManager.start()`
- [ ] Add FileWatcher integration — detect `shipit.yaml` in changed paths, call `previewManager.restart()`
- [ ] Add `killProcessesOnPorts(ports, sessionsRoot)` helper — fuser + /proc/pid/cwd safety guard
- [ ] Handle `init_preview_config` client message — send Claude a prompt to create shipit.yaml
- [ ] Broadcast `preview_config_missing` / `preview_config_error` on PreviewManager events

### Phase 4: Types

- [ ] Add `WsPreviewConfigMissing`, `WsPreviewConfigError`, `WsInitPreviewConfig` to `src/server/types.ts`
- [ ] Add `clear_logs` to `WsServerMessage` union (if not already present)
- [ ] Update `WsPreviewStatus.source` to include `"managed"` alongside existing `"vite" | "detected"`

### Phase 5: Client

- [ ] Add preview state reset to `resumeSessionInternal()` in App.tsx — `setPreview(null)`, `setSelectedPort(null)`, `clearPreviewErrors()`, reset autofix state, clear logs
- [ ] Add preview state reset to `handleSessionNew()` in App.tsx — same resets
- [ ] Handle `preview_config_missing` message — set state to show config-missing UI
- [ ] Handle `preview_config_error` message — show error in preview pane
- [ ] Handle `clear_logs` message — clear `logEntries` and `unreadLogCount`
- [ ] Add `init_preview_config` send support — new callback for PreviewFrame
- [ ] Update PreviewFrame — show "No preview server configured" + "Set up with Claude" button when config missing; spinner while waiting

### Phase 6: Templates

- [ ] Add `shipit.yaml` to every template in `templates.ts` that serves HTTP (all except node-cli-ts) — `preview:\n  command: ...\n  ports: [...]`

### Phase 7: Integration tests

- [ ] Create `src/server/integration_tests/session-switch-preview.test.ts` — preview restarts on switch, detected ports cleared, new session clears preview, same-session no-op, clear_logs broadcast, config-missing prompt, init_preview_config sends Claude prompt

### Phase 8: Client tests

- [ ] Test `resumeSessionInternal` resets preview state
- [ ] Test `handleSessionNew` resets preview state
- [ ] Test PreviewFrame renders config-missing prompt
- [ ] Test config-missing button sends `init_preview_config`

### Phase 9: Template tests

- [ ] Test all HTTP-serving templates include valid `shipit.yaml` with `preview.command` and `preview.ports`

### Phase 10: Final

- [ ] Run full test suite (`npm test`), lint (`npm run lint`), typecheck (`npm run typecheck`)
- [ ] Update plan.md status to `done`, delete this checklist
