## Implementation checklist

### Phase 1: Install runner (done)

- [x] Create `src/server/install-runner.ts` — `parseInstallCommand()`, `isInstallDone()`, `markInstallDone()`, `clearInstallMarker()`, `runInstallCommand()` utility functions
- [x] Add `WsInstallStatus` type to `src/server/types/ws-server-messages.ts`
- [x] Add `"install"` to `WsLogEntry.source` union in `src/server/types/terminal-types.ts`
- [x] Add `shipit.yaml` with `install: npm install` to all templates with `package.json` in `templates.ts`
- [x] Add `shipit.yaml` with `preview: html: index.html` to static-html template (no install)
- [x] Add `"install"` to client `LogSource` type, filter UI, color/label maps in `TerminalPanel.tsx`

### Phase 2: Preview config integration

- [ ] Add `install?: string` field to `PreviewConfig` type in `src/server/preview-config.ts`
- [ ] Read `install` from shipit.yaml in `resolvePreviewConfig()`
- [ ] Add install-related unit tests to `src/server/preview-config.test.ts` (install present, install absent, non-string rejected, package.json fallback has no install)

### Phase 3: PreviewManager integration

- [ ] Add install step to `PreviewManager.start()` — run install command before preview, check marker, write marker on success
- [ ] Emit `install_status` events from PreviewManager
- [ ] Clear install marker when `shipit.yaml` changes (FileWatcher integration)

### Phase 4: Client UI

- [ ] Handle `install_status` message in App.tsx
- [ ] Show "Installing dependencies..." spinner in PreviewFrame during install
- [ ] Show install error with "Retry" button in PreviewFrame

### Phase 5: Install runner unit tests

- [ ] Test `parseInstallCommand()` extracts install command from yaml string
- [ ] Test `parseInstallCommand()` returns undefined when no install field
- [ ] Test `isInstallDone()` / `markInstallDone()` / `clearInstallMarker()` marker lifecycle
- [ ] Test `runInstallCommand()` with a simple command (e.g. `echo hello`)

### Phase 6: Integration tests

- [ ] Test install runs before preview (assert `install_status { status: "running" }` sent)
- [ ] Test install failure blocks preview (assert `install_status { status: "error" }`)
- [ ] Test install skipped when marker exists (no `install_status` message sent)
- [ ] Test install marker written on success (`.shipit/.install-done` exists)

### Phase 7: Template tests

- [ ] Test all npm templates include `install: npm install` in their `shipit.yaml`

### Phase 8: Client tests

- [ ] Test PreviewFrame shows install progress spinner
- [ ] Test PreviewFrame shows install error with retry button
