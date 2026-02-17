# Preview System

The preview pane shows a live iframe of the user's app. Supports Vite (managed) and any other dev server (auto-detected via port scanning).

## Port detection

### Triggers

1. **After each Claude turn** (`done` event) — immediate scan
2. **Periodic interval** (every 5s, configurable via `portScanIntervalMs`) — catches servers started mid-turn via Bash tool. Interval starts when first client connects, stops when last disconnects.

### Port scanning

- `checkPort(port)` — TCP connect probe with 300ms timeout
- `scanPorts(ports, excludePorts)` — checks multiple ports concurrently
- `DEFAULT_SCAN_PORTS`: 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8888
- Excludes ShipIt server port (3000) and managed Vite port when running

### Priority logic in `getPreviewStatus()`

1. Vite running → use Vite (`source: "vite"`), include `detectedPorts`
2. Ports detected → use first detected port (`source: "detected"`), include all
3. Neither → not running

### Multi-port UI

- Single port: green badge (Vite) or yellow badge (auto-detected)
- Multiple ports: `<select>` dropdown in preview bar. User's `selectedPort` tracked in `App.tsx`. Resets if selected port disappears. Iframe `key` includes port to force reload on switch.

## Error capture & auto-debug

### Error capture flow

1. Vite plugin (`vite-error-plugin.ts`) injects script intercepting `window.onerror`, `unhandledrejection`, `console.error/warn`
2. Errors sent to parent frame via `postMessage` with `source: "shipit-preview"`
3. `usePreviewErrors` hook deduplicates (1s window), maintains rolling buffer (50 max)
4. Errors forwarded to server via `preview_error` WS message → terminal log with `source: "preview"`

### Auto-fix mode

- Opt-in toggle in preview header
- New errors auto-trigger "fix these errors" message to Claude (when idle)
- Safety: max 3 retries for same error signature, 5s cooldown between attempts, any manual user message disables auto-fix

### Error panel

Red badge on preview shows error count. Clicking opens collapsible panel with details, stack traces, per-error "Fix" buttons, and "Send to Claude" for all errors.

## Key files

- `src/server/port-scanner.ts` — `checkPort`, `scanPorts`, `DEFAULT_SCAN_PORTS`
- `src/server/vite-manager.ts` — Vite lifecycle, wrapper config with error plugin
- `src/server/vite-error-plugin.ts` — Error capture script injection
- `src/server/index.ts` — `runPortScan()`, `getPreviewStatus()`, periodic scan interval
- `src/client/hooks/usePreviewErrors.ts` — Error dedup, buffer
- `src/client/components/PreviewFrame.tsx` — Iframe, port selector, error badge/panel, auto-fix toggle
- `src/client/App.tsx` — Preview state, `selectedPort`, auto-fix effect with guardrails
