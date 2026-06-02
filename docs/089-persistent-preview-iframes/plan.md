
# 089 — Persistent Preview Iframes

## Context

When switching sessions or ports, the preview iframe navigates to a new URL, destroying internal state (scroll position, form inputs, app state). In normal browser development you keep tabs open — each tab persists independently, even if the underlying dev server restarts. ShipIt should match that behavior.

Every (session, port) combination the user visits gets its own iframe that stays alive in the DOM. Hidden via CSS when not active, shown instantly when the user switches back. Cap at 20 retained iframes.

## Prior work

A first commit keeps the iframe alive across right-panel tab switches (preview → terminal → preview) by rendering `PreviewFrame` permanently with CSS visibility toggle.

## Design

### Iframe pool inside PreviewFrame

PreviewFrame already owns the UI chrome (top bar, port selector, error panel, overlays). Instead of managing one iframe, it maintains a **pool of iframes** keyed by `${sessionId}:${port}`.

```
interface IframeSlot {
  sessionId: string;
  port: number;
  url: string | null;   // set when polling confirms readiness
  ready: boolean;        // polling completed for this slot
}

state:
  slots: Map<slotKey, IframeSlot>
  slotOrder: string[]           // LRU, most recent first
  iframeRefs: Map<slotKey, HTMLIFrameElement | null>
```

**Active slot key:** `${sessionId}:${activePort}`

**Slot lifecycle:**
- When active (session, port) changes → check if slot exists
  - Exists: promote in LRU, show it (no re-polling, no reload)
  - New: create slot with `ready: false`, start polling, add to LRU
- When `slotOrder.length > 20`: evict oldest, remove from `slots` (React unmounts iframe)
- Manual refresh: re-poll only the active slot, re-assign `src` via ref

**Polling:** Only the active slot polls. Same health-check logic as today. When ready, set slot's `url`.

**Rendering:**
```tsx
{Array.from(slots.entries()).map(([key, slot]) => (
  slot.url && (
    <iframe
      key={key}
      ref={el => iframeRefs.current.set(key, el)}
      src={slot.url}
      className={`absolute inset-0 w-full h-full ${key !== activeKey ? "invisible" : ""}`}
    />
  )
))}
```

Top bar, error panel, overlays, auth detection — all operate on the active slot only.

### Per-session preview state (preview-store.ts)

The preview store is global and gets `reset()` on every session switch, wiping errors/crash info/config. Add snapshot/restore:

```
interface SessionPreviewSnapshot {
  status: PreviewStatus | null;
  selectedPort: number | null;
  errors: PreviewError[];
  startupSteps: StartupStep[];
  autoFixRetries: number;
  services: ManagedServiceState[];
  composeError: string | null;
}
```

New methods:
- `snapshotSession(sessionId)` — save current top-level state
- `restoreSession(sessionId)` — restore from snapshot or reset to defaults
- `getSnapshot(sessionId)` — read-only access for background frames

`autoFixEnabled` stays global (user preference). `reset()` clears everything including snapshots (used by `fullResetAllStores`).

### Session switch flow (session-actions.ts)

In `resumeSessionInternal()`, replace `usePreviewStore.getState().reset()`:
```ts
const preview = usePreviewStore.getState();
const outgoing = useSessionStore.getState().sessionId;
if (outgoing) preview.snapshotSession(outgoing);
preview.restoreSession(sessionId);
```

### Error filtering (usePreviewErrors.ts)

Multiple iframes emit `postMessage` errors. Extract sessionId from `event.origin` subdomain (`{sessionId}--{port}.hostname`) and compare with active session. Ignore background iframe errors.

## Key files

| File | Change |
|------|--------|
| `src/client/components/PreviewFrame.tsx` | Iframe pool (main change) |
| `src/client/stores/preview-store.ts` | Snapshot/restore per session |
| `src/client/stores/actions/session-actions.ts` | Snapshot on switch instead of reset |
| `src/client/hooks/usePreviewErrors.ts` | Origin-based session filtering |

## Verification

1. `npm run typecheck` + `npm run lint` — clean
2. `npm run test:dev` — existing tests pass
3. Manual: session A port 3000 → switch port 5173 → session B → back to A → both iframes intact
4. 21st iframe evicts the oldest
5. Background iframes don't pollute active session's error panel
