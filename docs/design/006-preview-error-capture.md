# Design Doc 006: Preview Error Capture & Auto-Debug Loop

## Status: Proposed

## Problem

The biggest friction point in vibe coding today: the preview breaks, the user sees a white screen or a console error, and they have to manually open devtools, copy the error, and paste it into chat. This breaks the flow completely.

Specific pain points:
1. **Invisible errors** — runtime errors in the preview iframe are invisible to the ShipIt UI.
2. **Manual copy-paste** — users must open browser devtools, find the error, copy it, switch to chat, paste it.
3. **No auto-fix** — even after surfacing an error, the user must manually ask Claude to fix it.

## Goals

1. Capture runtime errors and console.error output from the preview iframe.
2. Surface captured errors in the ShipIt UI (preview tab badge + error panel).
3. One-click "Send to Claude" to fix errors.
4. Optional auto-fix loop with safety guardrails.

## Non-Goals

- Capturing network request failures (XHR/fetch errors).
- Source map resolution for stack traces.
- Capturing errors from non-JavaScript preview content.

## Design

### Architecture

The preview iframe runs on a different port (5173 for Vite, or an auto-detected port). Same-origin policy prevents direct console capture. Solution: **inject a tiny error-reporting script** into the preview.

#### Approach: Vite Plugin (for managed Vite previews)

Create a Vite plugin that injects a small `<script>` into the HTML that:
1. Listens for `window.onerror` and `window.onunhandledrejection`.
2. Overrides `console.error` and `console.warn`.
3. Sends captured errors to the parent window via `window.parent.postMessage()`.

```javascript
// Injected into preview (< 1KB)
(function() {
  const send = (type, data) =>
    window.parent.postMessage({ source: 'shipit-preview', type, ...data }, '*');

  window.onerror = (msg, src, line, col, err) => {
    send('error', { message: msg, source: src, line, col, stack: err?.stack });
    return false;
  };

  window.addEventListener('unhandledrejection', (e) => {
    send('error', { message: String(e.reason), stack: e.reason?.stack });
  });

  const origError = console.error;
  console.error = (...args) => {
    send('console', { level: 'error', args: args.map(String) });
    origError.apply(console, args);
  };

  const origWarn = console.warn;
  console.warn = (...args) => {
    send('console', { level: 'warn', args: args.map(String) });
    origWarn.apply(console, args);
  };
})();
```

#### Approach: Proxy mode (for non-Vite auto-detected servers)

For non-Vite servers (detected via port scanning), ShipIt's Fastify server acts as a reverse proxy for the preview port, injecting the error-capture script into HTML responses.

### Client Changes

#### New: `usePreviewErrors` hook

```typescript
interface PreviewError {
  id: string;
  type: 'error' | 'console';
  level?: 'error' | 'warn';
  message: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
  timestamp: string;
}

function usePreviewErrors(): {
  errors: PreviewError[];
  clearErrors: () => void;
  hasErrors: boolean;
}
```

Listens for `message` events on `window`, filters by `source === 'shipit-preview'`, deduplicates rapid-fire errors, maintains a rolling buffer.

#### PreviewFrame enhancements

- Red error badge on the Preview tab when errors exist (similar to terminal's unread badge).
- Expandable error panel at the bottom of the preview: list of errors with stack traces.
- "Send to Claude" button on each error (or "Send all errors") — composes a message like:

```
The preview is showing these errors:

1. TypeError: Cannot read properties of undefined (reading 'map')
   at App.tsx:42:15

Please fix these errors.
```

- "Auto-fix" toggle: when enabled, new errors are automatically sent to Claude (with debounce and a max retry count of 3 to prevent infinite loops).

#### TerminalPanel integration

- Preview console errors also appear in the Terminal tab with a new source: `"preview"`.
- Color-coded: preview errors in orange (distinct from stderr red).

### Server Changes

Minimal — the error capture is entirely client-side (preview → parent window postMessage → React state):

- `ViteManager`: add a Vite plugin that injects the error-capture snippet into `index.html`.
- Optional: new proxy route for non-Vite previews (`/preview-proxy/:port/*`).

### Protocol Changes

New log source for terminal integration:

```typescript
// Preview errors forwarded to terminal
interface WsLogEntry {
  type: "log_entry";
  source: "stderr" | "stdout" | "server" | "preview";  // add "preview"
  text: string;
  timestamp: string;
}

// Client → Server
interface WsPreviewError {
  type: "preview_error";
  message: string;
  stack?: string;
  source?: string;
  line?: number;
}
```

### Auto-Fix Loop Safety

The auto-fix feature needs strict guardrails:
- **Max retries:** 3 consecutive auto-fix attempts per unique error signature.
- **Cooldown:** 5 seconds between auto-fix sends (debounce).
- **Kill switch:** any user message cancels auto-fix mode.
- **Visual indicator:** pulsing orange border on preview when auto-fix is active, with a "Stop" button.

### File Layout

| File | Change |
|------|--------|
| `src/client/hooks/usePreviewErrors.ts` | New — hook for capturing postMessage errors |
| `src/client/hooks/usePreviewErrors.test.ts` | New — tests with fake postMessage events |
| `src/client/components/PreviewFrame.tsx` | Error badge, error panel, "Send to Claude" button |
| `src/client/components/PreviewFrame.test.tsx` | Component tests for error UI |
| `src/client/App.tsx` | Wire `usePreviewErrors`, handle auto-fix toggle |
| `src/server/vite-manager.ts` | Add Vite plugin to inject error-capture script |
| `src/server/types.ts` | Add `"preview"` to log source, add `WsPreviewError` type |
| `src/server/integration.test.ts` | Test `preview_error` relay to terminal log buffer |

### Quality Checklist

- [ ] Input validation: `preview_error` messages validated (string type, max length).
- [ ] Component tests: `usePreviewErrors` hook — deduplication, buffer limits. PreviewFrame — error badge, panel expand/collapse, "Send to Claude" wiring.
- [ ] Integration tests: Verify `preview_error` messages are relayed to terminal log buffer.
- [ ] Edge cases: Handle rapid-fire errors (dedup), handle errors from multiple iframes, handle auto-fix loop exhaustion gracefully.
