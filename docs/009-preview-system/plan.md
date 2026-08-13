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

**There is deliberately no `history.back()` fallback.** A browser without the
Navigation API offers no way to ask whether *this frame* can go back, so falling
back to `history.back()` would just reinstate the bug for those users. The script
instead refuses to traverse and reports `canGoBack: false`, so the button is
visibly disabled rather than silently inert. All three engines ship the API
(Chrome 102, Safari 18.2, Firefox 147), so this costs a button essentially nobody
has.

**The same containment covers the previewed page's own traversal, not just the
toolbar's.** The guard above is reached only by a `shipit-toolbar` message, so an
app that calls `history.back()` itself — a "< Back" control, a router's
`goBack()`, a `javascript:history.back()` link — still walked the ShipIt tab back
and switched the user's active session. The script therefore *replaces*
`back` / `forward` / `go` with the frame-scoped traversal, and it is first in
`<head>`, so it wins over app code that captures them later. Measured in
Chromium: an unpatched cross-origin frame's `history.back()` navigates the
*top-level* page, the patched one leaves it untouched and still goes back within
the frame.

Four details, each with a reason:

- **The patch goes on `History.prototype`, not on the `history` instance.** An
  own property leaves `History.prototype.back.call(history)` as a live route to
  the joint traversal, and it *shadows* — rather than composes with — a router or
  instrumentation library that wraps the prototype method later. Falls back to
  the instance where `History` isn't exposed.
- **`go(delta)` counts the FRAME's entries, deliberately unlike the platform.**
  Native `go` counts steps of the joint history, where a nested frame's
  navigation is also a step — so a native `go(-2)` can land somewhere the app
  never was, and past the frame's first entry it lands on ShipIt. There is no
  `canGoBack`-style predicate for `|delta| > 1`, so `navigation.entries()` is
  both the guard and the counter: an index outside the frame's own list is
  refused. That is also what a router asking for "two of my entries back" means.
  `go(0)` and a missing delta stay a `location.reload()`, as natively, and a
  reload never leaves the frame. The delta goes through `|0`, which is exactly
  the Web IDL `long` conversion (`go(4294967295)` is `go(-1)`).
- **`history.length` reports the frame's own entry count** when the Navigation
  API is available. Unpatched it is the *joint* length (Chromium: one own entry,
  `length` 9) — which is why nothing here can use it as a guard, and why the
  `history.length > 1` check an app puts in front of its own back button used to
  say "yes" on the preview's first page and walk straight into a refusal.
- **A refusal says so once, via `console.warn`.** It is otherwise invisible:
  History returns `undefined` and no event fires, so the app's Back button just
  looks broken. It is a bare `console.warn` rather than a posted
  `shipit-preview` console message precisely so it reaches devtools without
  becoming an app error or waking auto-fix.

**The injected script is ASCII-only**, pinned by a test. It is spliced into
whatever the app serves, and a document with no declared charset renders UTF-8
characters in it as mojibake.

**Known limits of the containment.** It reaches the documents ShipIt instruments
— proxied `text/html` `GET` responses. A nested `srcdoc`/third-party iframe
*inside* the preview, or a document the proxy did not rewrite, keeps the native
methods and can still traverse the tab. Separately, history is not the only way
out: container previews render without a `sandbox` attribute (non-container ones
get one at `PreviewFrame.tsx`), so `target="_top"`, `top.location`, and
`window.open(url, "_top")` can still replace the whole ShipIt page with user
activation. Sandboxing container previews would close that, at the cost of
changing behaviour for every previewed app (downloads, popups, top-level OAuth
redirects) — not attempted here.

The script reports `canGoBack` on every `path` message, and `PreviewFrame` keeps
it per slot — the pool leaves other sessions' iframes mounted and reporting, so a
single shared value would let a background preview at its own base grey out Back
for the preview on screen. The value is untrusted page-authored input like the
path beside it: a non-boolean is ignored, leaving the slot "unknown" and Back
enabled. Unknown is the right default there, because it is also the state of a
**non-proxied local preview** whose page never ran our script at all — clicking
Back posts a message nobody receives, which is inert but not a leak.

`rp` fires on `pushState` / `replaceState` (wrapped), `popstate`, `hashchange`,
**and `navigation`'s `currententrychange`**. That last one is not redundant: an
app that drives the Navigation API directly (`navigation.navigate()`, or a router
in navigation-API mode) changes the current entry without touching the History
methods we wrapped, so both the path display and `canGoBack` would otherwise
freeze at their load-time values.

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
