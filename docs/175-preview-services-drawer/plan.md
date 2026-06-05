---
description: Fold the standalone Services tab into a collapsible, resizable drawer at the bottom of the Preview tab.
---

# Services drawer inside the Preview tab

## Why

Services (Docker Compose status + logs) lived in their own top-level right-panel
tab, a peer of Preview. But the two are routinely wanted **at the same time** —
you tail a dev server's log while watching the page it serves render. Mutually
exclusive tabs made that impossible: looking at a log meant losing sight of the
preview, and vice-versa.

This moves Services *into* the Preview tab as a collapsible, drag-resizable
drawer docked at the bottom. Collapsed, it's a thin status strip (running/total
count + per-service status dots). Expanded, you drag the divider to trade
vertical space between the live render and the logs — a sliver for a glance,
near-full-height for reading a stack trace. That single gesture covers both
"quick status check" and "watch logs while previewing" without a mode switch.

This keeps with the product principle that everything the user needs is visible
inside one surface (CLAUDE.md §1–2): the log and the render now coexist instead
of competing for a tab.

## How it works

- **`PreviewServicesDrawer.tsx`** — the drawer. Reads the compose `services`
  list (passed as a prop from `App.tsx`, sourced from `preview-store`). Owns:
  - `expanded` (collapse toggle) and `height` (drag-resize), both persisted to
    `localStorage` (`shipit:preview-services:expanded` / `:height`).
  - `selectedService` — list view vs single-service log view, mirroring the old
    panel's two-view design.
  - Plain-text log accumulation for the "Send to Agent" button (same
    inline-during-render approach the old `ServicesPanel` used).
  - A self-contained **vertical** drag-resize (the shared `useResizablePanel`
    hook is horizontal-only). Height is clamped so the preview above always
    keeps at least `MIN_PREVIEW_PX`.
- **`ServiceLogViewer.tsx`** — the xterm.js read-only log viewer, extracted
  verbatim from the old `ServicesPanel` so the drawer can embed it. Mounts only
  when the Preview tab is actually visible (`active` prop), so xterm never opens
  against a hidden, zero-size container.
- **`ServiceList.tsx`** — unchanged; reused for the expanded list view. Clicking
  a service's `:port` chip now pivots the preview iframe to that port
  (`onSelectPreviewPort` → `preview-store.setSelectedPort`), tying the two
  surfaces together.

### App.tsx wiring

- The Preview container is now a vertical flex column: `PreviewFrame` in a
  `flex-1 min-h-0` wrapper with the drawer (`shrink-0`) docked below. The
  PreviewFrame stays always-mounted (iframe-state preservation) and simply
  shrinks when the drawer expands.
- The standalone **Services tab button and its render branch were removed**.
- `"services"` was **deleted from the `RightTab` union** (`ui-store`) and from
  `VALID_RIGHT_TABS` (`local-storage`). A legacy persisted `"services"` value
  now fails the membership check in `getSavedRightTab()` and falls back to
  `"preview"` — so the coercion happens at the storage boundary, and no runtime
  `=== "services"` branch is needed in `App`.
- `previewVisible` is computed once and used both to toggle the container's
  visibility and to gate the drawer's xterm mount.

### PreviewFrame empty state

When the compose stack is up but nothing is running, `PreviewFrame` used to
render an **inline `ServiceList`** in its overlay (with Start/Stop) for the
manual-only dogfooding case. That duplicated the drawer, so it was removed: the
overlay is now just a "No preview running" nudge with a **Show services** button
that expands the drawer (`setServicesDrawerExpanded(true)`). `PreviewFrame` no
longer imports `ServiceList` or takes `onStartService`/`onStopService` props.

## Key files

- `src/client/components/PreviewServicesDrawer.tsx` — the drawer (new)
- `src/client/components/ServiceLogViewer.tsx` — extracted xterm log viewer (new)
- `src/client/components/ServiceList.tsx` — reused list rows (unchanged)
- `src/client/App.tsx` — flex-column layout, tab removal, `rightTab` coercion
- `src/client/stores/ui-store.ts` — `RightTab` (no longer includes `"services"`)
- `src/client/utils/local-storage.ts` — `VALID_RIGHT_TABS` (drops `"services"`;
  the sanitization point for legacy persisted values)
- `src/client/stores/preview-store.ts` — `servicesDrawerExpanded` flag + setter

## Notes / trade-offs

- `"services"` is gone from both the `RightTab` union and `VALID_RIGHT_TABS`.
  Sanitizing a legacy persisted value in `getSavedRightTab()` (it already
  validates membership and falls back to `"preview"`) is cleaner than carrying a
  dead enum member plus a runtime coercion branch.
- The drawer lives inside the always-mounted (but CSS-hidden when inactive)
  preview container. Drawer state therefore persists across tab switches; the
  `active` gate prevents the log viewer from running while hidden.
