## Implementation checklist

### Phase 1: Install runner (done)

- [x] Create `src/server/install-runner.ts` — `parseInstallCommand()`, `isInstallDone()`, `markInstallDone()`, `clearInstallMarker()`, `runInstallCommand()` utility functions
- [x] Add `WsInstallStatus` type to `src/server/types/ws-server-messages.ts`
- [x] Add `"install"` to `WsLogEntry.source` union in `src/server/types/terminal-types.ts`
- [x] Add `shipit.yaml` with `install: npm install` to all templates with `package.json` in `templates.ts`
- [x] Add `shipit.yaml` with `preview: html: index.html` to static-html template (no install)
- [x] Add `"install"` to client `LogSource` type, filter UI, color/label maps in `TerminalPanel.tsx`

### Phase 2: Preview config integration

- [x] Add `install?: string` field to `PreviewConfig` type in `src/server/preview-config.ts`
- [x] Read `install` from shipit.yaml in `resolvePreviewConfig()`
- [x] Add install-related unit tests to `src/server/preview-config.test.ts` (install present, install absent, non-string rejected, package.json fallback has no install)

### Phase 3: PreviewManager integration

- [x] Add install step to `PreviewManager.start()` — run install command before preview, check marker, write marker on success
- [x] Emit `install_status` events from PreviewManager
- [x] Clear install marker when `shipit.yaml` changes (via `restart()` which calls `clearInstallMarker`)

### Phase 4: Client UI

- [x] Handle `install_status` message in App.tsx
- [x] Show "Installing dependencies..." spinner in PreviewFrame during install
- [x] Show install error in PreviewFrame

### Phase 5: Install runner unit tests

- [x] Test `parseInstallCommand()` extracts install command from yaml string
- [x] Test `parseInstallCommand()` returns undefined when no install field
- [x] Test `isInstallDone()` / `markInstallDone()` / `clearInstallMarker()` marker lifecycle
- [x] Test `runInstallCommand()` with a simple command (e.g. `echo hello`)

### Phase 6: Integration tests

- [x] Integration tests in `src/server/integration_tests/preview-config.test.ts`

### Phase 7: Template tests

- [x] Templates already include `install: npm install` in their `shipit.yaml` (verified via existing tests)

### Phase 8: Client tests

- [x] Test PreviewFrame shows install progress spinner
- [x] Test PreviewFrame shows install error
