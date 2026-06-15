---
issue: https://linear.app/shipit-ai/issue/SHI-95
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
- **`LogView.tsx`** — the xterm.js read-only log viewer (the unified viewer from
  docs/192; superseded the original `ServiceLogViewer`). The drawer embeds it for
  the selected-service drill-in and the single-service focus card. Mounts only
  when the Preview tab is actually visible (`active` prop), so xterm never opens
  against a hidden, zero-size container.
- **`ServiceList.tsx`** — the expanded list view, redesigned as **cards** (see
  "Visual redesign" below). Clicking a service's `:port` chip pivots the preview
  iframe to that port (`onSelectPreviewPort` → `preview-store.setSelectedPort`),
  tying the two surfaces together.

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

## Visual redesign

The drawer's contents were reworked from a flat row list into a polished,
card-based surface (the original was "barebones and ugly"). Frontend-only — no
backend or data-model changes; everything renders from the existing
`ManagedServiceState` (`name`, `status`, `port`, `preview`, `error`).

- **Service cards** (`ServiceList.tsx`): each service is a rounded card on
  `--color-bg-tertiary` with a status-colored left rail, a live status indicator
  (a pulsing `animate-ping` dot for *running*, a spinner for *starting*, a
  glowing dot for *crashed*, a flat dot for *stopped*), the service name (a
  button that opens its log view), a `Preview`/`Manual` mode badge derived from
  `preview`, a clickable `:port` chip, and hover-revealed icon actions.
- **Per-service actions**: open-in-new-tab (running services only — URL built
  client-side via `buildSubdomainUrl(sessionId, port, apiHost)`, hidden when no
  subdomain URL is possible, e.g. local mode), view logs, **restart**, and
  start/stop. Restart is *client-orchestrated*: send `stop_service` now, then
  `start_service` once the service reports `stopped` on the status stream
  (sending both at once would race the still-running container). Tracked in a
  `restartPendingRef` set, drained by an effect on the `services` prop.
- **Crash affordance**: an errored service shows an error strip (with an `OOM`
  badge when the message matches `/oom/i`) and an **"Ask the agent to fix →"**
  link that prefills the composer via the existing `onSendToAgent` path.
- **Header** (`PreviewServicesDrawer.tsx`): expanded, it shows a per-service
  health segment bar + "N of M running" and bulk controls (**Restart all** /
  **Stop all**, or **Start all** when nothing is running). Collapsed, it stays a
  thin strip: count + per-service status dots. The selected-service log toolbar
  also gained a Restart button.

All colors use design tokens; `--color-warning`/`--color-error` replaced the
ad-hoc `text-orange-400` the old rows used.

### Single-service focus card + left-grouped controls

Two refinements once the drawer shipped (visual reference:
`single-service-prototype.html`):

- **Lone service = the focus, not a list-of-one.** When exactly one service
  exists (the common case — e.g. a repo's single `dev` service), a narrow card
  left-aligned in a wide drawer looked stranded against a big void. Instead,
  `FocusServiceCard` (in `PreviewServicesDrawer.tsx`) renders a full-width card
  whose **live log is shown directly** beneath a compact identity+controls row —
  no drill-in, no "open log" hop. It fills the drawer with the one genuinely
  useful thing (per CLAUDE.md §1–2). The header sheds its health bar + bulk
  buttons in this mode (the card carries the per-service controls), and a
  crashed service shows its error + "Ask the agent to fix" above the log.
  Multiple services still render the compact `ServiceList`, and clicking one
  drills into the existing toolbar+log view.
- **Controls grouped on the left.** The per-service action buttons used to be
  pushed to the far right by a `flex-1` spacer on the name column, so on wide
  monitors the cursor had to travel the whole drawer to reach them. The spacer
  is gone; controls now sit next to the name. Bulk controls were already
  left-grouped.

## Key files

- `src/client/components/PreviewServicesDrawer.tsx` — the drawer + `FocusServiceCard` (new)
- `docs/175-preview-services-drawer/single-service-prototype.html` — design reference for the focus card / left-grouped controls
- `src/client/components/LogView.tsx` — unified xterm log viewer (docs/192), embedded by the drawer
- `src/client/components/ServiceList.tsx` — card-based service list (redesigned)
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
