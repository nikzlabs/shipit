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

## Toolbar navigation (back / refresh)

The iframe is cross-origin (preview subdomain), so the toolbar cannot touch its
`history` or `location` directly. It posts `{source: "shipit-toolbar", type}`
messages that the script injected by `preview-proxy.ts` (`HMR_WS_PATCH`) acts on
inside the page: `back` / `forward` → `navigation.back()` / `navigation.forward()`,
`reload` → `location.reload()`.

**Back/forward go through the Navigation API, never `history.back()`.** A frame's
history entries are nested inside the top-level page's, and `history.back()`
traverses that *joint* session history — so a preview with no entry of its own
walks the **ShipIt tab** back, dropping the user out of their session. There is no
guard available on the legacy API: an iframe's `history.length` reports the joint
length (measured in Chromium: one own entry, `length` 9), so it can't distinguish
"the preview has somewhere to go" from "the app does". `navigation.entries()` is
scoped to the frame, so `canGoBack` answers the right question and
`navigation.back()` cannot move anything but the preview. The script checks
`canGoBack` first and swallows both result promises, since the call still rejects
with `InvalidStateError` if the entry list moves in between.

The script reports `canGoBack` on every `path` message, and `PreviewFrame` keeps
it per slot so the toolbar can disable Back when there is nothing behind — the
button greys out instead of silently doing nothing. It is only ever a boolean or
absent; absent means a browser with no Navigation API, where the slot stays
"unknown", Back stays enabled, and the injected script falls back to
`history.back()` rather than losing the button entirely.

**Refresh reloads the page the preview is currently on, not the slot's entry
URL.** Re-assigning the iframe's `src` — the obvious implementation, and what
this used to do — navigates back to the URL the pool slot was created with, so a
user who had clicked into a sub-page or an SPA route was silently dropped on the
front page. `PreviewFrame` therefore sends `reload` to any slot it has heard a
`loaded` message from (proof the injected script is running there), and only
falls back to the `src` re-assignment when it hasn't: a non-proxied local
preview, a 502, or an auth-gated response. That fallback is also what the
auth-blocked retry escalation needs, since a genuinely blocked slot must
re-fetch rather than reload a page that never rendered.

The "reloadable" bit is keyed by slot *and* stored as the reporting
`contentWindow`, so a remounted iframe (new element, script not yet run) doesn't
inherit the previous element's confirmation.

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
