
---
issue: roadmap#SHI-331
title: Persistent Preview Iframes
description: One iframe per (session, port) kept alive across switches, re-entering at the route it was last on.
---

# 089 — Persistent Preview Iframes

## Context

When switching sessions or ports, the preview iframe navigates to a new URL, destroying internal state (scroll position, form inputs, app state). In normal browser development you keep tabs open — each tab persists independently, even if the underlying dev server restarts. ShipIt should match that behavior.

Every (session, port) combination the user visits gets its own iframe that stays alive in the DOM. Hidden via CSS when not active, shown instantly when the user switches back. Cap at 20 retained iframes.

### Hidden means `display: none`, not `visibility: hidden`

A retained slot stays **mounted** — that is what preserves its state — but it must not keep **rendering**. `visibility: hidden` hides only the pixels and lets the document draw at full frame rate for the rest of the session; measured cross-origin over a 4-second hide, a background page drew **240 frames** that way and **1** under `display: none`. On an Android phone that surplus was a second WebGL renderer competing for the GPU with the preview the user was looking at, costing the visible one 9.5–13.5% of its frames across a matched A/B at both 60 Hz and 120 Hz (nikzlabs/shipit#2418).

**This costs focus inside the frame, knowingly.** Measured, a genuine browser tab switch restores the focused element, so `display: none` deviates from the "it feels like keeping tabs open" promise above. Everything else a person would notice survives it — no reload, typed text, inner and document scroll, the caret offset — and re-showing draws again in 21 ms against 18 ms, so switching back is still instant. A preview you were typing in comes back whole except that you must tap the field to resume typing. The design owner was shown the measurement and took that trade.

The alternative that also keeps focus is `invisible` plus a parking transform (`translateY(-200vh)`), which throttles equally well. It was dropped once focus was off the table: it needs two properties doing two different jobs, and it silently depends on that constant always clearing the viewport — a future layout placing this pane under a transformed or scrolled ancestor would stop it throttling with nothing to notice. `display: none` cannot fail that way, and it removes the frame from the tab order and the accessibility tree without a second property.

This does **not** replace the docs/146 visibility contract. Nothing here stops **audio**, which is precisely why that cooperative protocol exists. Rendering and audio are separate axes: the hiding mechanism settles rendering, the contract settles audio, and neither substitutes for the other.

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

**LRU eviction is the only thing that may drop a slot.** Dropping one is a
reload the user experiences as their preview resetting, so no other rule gets to
evict on its own judgement. A merged PR used to prune its session's background
slot (docs/064 item 6); it saved nothing — a mounted iframe does not keep a
container alive, since idle reclamation keys off attached viewers and agent turns
— and reliably destroyed exactly the preview the user came back to. Removed.

### Remembering where each preview was

A slot still gets recreated: LRU eviction, `PreviewFrame` unmounting (navigating
home, a page reload), a container restart. Recreating it at the origin root sends
the user back to the app's front page, which is the same loss the pool exists to
prevent — just less often.

The injected preview script (`preview-proxy.ts`) already posts a `path` message
on load and on every `pushState`/`replaceState`/`popstate`, so the current route
is known even for a client-side router. That value is stored in
`preview-store.previewPaths`, keyed by slot (`sessionId:port`) and mirrored to
localStorage. It deliberately lives **outside** `SessionPreviewSnapshot` and
outside component state: the key already carries the session, and the whole point
is to outlive everything that can drop the iframe. `computePreviewUrl` resolves
it against the slot's origin when creating the slot, so a recreated preview
re-enters where it left off.

`previewPaths` deliberately survives `preview-store.reset()`. That reset is the
*session-scoped* one — `resetSessionState()` calls it when the route leaves a
session for home or `/{slug}/new`, which on desktop is the same moment
`AppLayout` unmounts the right panel and with it the whole pool. Clearing there
would erase the map at exactly the moment it has to be read back. Only
`clearPreviewPaths()`, called from `fullResetAllStores`, empties it.

The path is authored by the previewed page, so it is untrusted:
`sanitizePreviewPath` requires a same-document absolute path and caps its
length, on both the message and the localStorage-load path. "Absolute path" is
read the way the URL parser reads it, not the way it looks — for a special
scheme, WHATWG parsing treats `\` as `/` and strips tab/CR/LF anywhere in the
input, so `//host/x`, `/\host/x` and `/<tab>/host/x` all resolve off-origin
despite two of them passing a naive "starts with one slash" test. `withPath`
re-checks the resolved origin before the value reaches an iframe `src`, and
`activeFullUrl` re-checks it again before the value reaches the clipboard.

### Auth-block detection must not fire on a revisit

The auth-gated-preview detector (`MAX_AUTH_TIMEOUT_MS`) reads "no `loaded`
message within 5s" as "the proxy is asking for authentication", and force-reloads
the iframe up to `MAX_AUTH_RETRIES` times before showing an overlay. Its premise
is that a fetch just happened — which is false on a revisit, where the cached
iframe is only being made visible again. `loadedSlotsRef` covers the slots that
came up cleanly, but a slot that never reported `loaded` (non-HTML root, failed
script injection, a 502 served during startup) was left unguarded and got
reloaded on every return. `authSettledRef` records the verdict for a slot whose
detection already concluded, so a revisit re-shows it instead of re-arming; a
manual refresh clears both, because that *is* a real fetch. The blocked state is
per-slot for the same reason the path is.

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
| `src/client/hooks/useIframePool.ts` | Slot map + LRU eviction |
| `src/client/hooks/usePreviewHealthPoller.ts` | Slot creation; enters at the remembered path |
| `src/client/stores/preview-store.ts` | Snapshot/restore per session; `previewPaths` |
| `src/client/stores/actions/session-actions.ts` | Snapshot on switch instead of reset |
| `src/client/hooks/usePreviewErrors.ts` | Origin-based session filtering |

## Verification

1. `npm run typecheck` + `npm run lint` — clean
2. `npm run test:dev` — existing tests pass
3. Manual: session A port 3000 → switch port 5173 → session B → back to A → both iframes intact
4. 21st iframe evicts the oldest
5. Background iframes don't pollute active session's error panel
