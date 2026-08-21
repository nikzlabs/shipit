---
issue: planning#229
title: Preview viewport — freeform resize and remembered choice (plan)
description: Design for drag handles on the constrained preview surface and localStorage-backed per-session viewport memory.
---

# Plan: freeform resize + viewport memory

Implements [requirements.md](./requirements.md). Extends the shipped Mobile Preview
feature (docs/066-mobile-preview) rather than replacing it; reqs 1/3/4/7/8 are
already live and stay untouched except where noted.

## 1. Freeform drag resize (req 2, req 5)

### Interaction

When the device frame is active (any preset or custom size), three handles render
just outside the constrained surface: right edge (width), bottom edge (height),
bottom-right corner (both). Dragging one resizes the surface live — the previewed
app reflows and its breakpoints flip while the pointer moves.

- **Detach:** dragging while a named preset is active converts the selection to
  Custom at the dragged size (req 2 resolved question). The dropdown trigger reads
  "Custom"; the toolbar indicator carries the live numbers.
- **Range:** per axis, `[CUSTOM_SIZE_MIN, max(available, current)]` where
  `available` is the panel minus the frame padding. The upper bound is
  `max(available, current)` rather than `available` so a surface that starts larger
  than the panel (scaled down) can be dragged smaller — continuously, with the scale
  rising smoothly to 1 as it passes the fit boundary — but never larger. There is no
  discontinuity anywhere in the gesture: at the clamp boundary the scale is exactly 1.
- **Geometry:** the surface is center-anchored, so moving an edge by Δ moves the
  size by 2Δ, divided by the gesture-start scale (`computeViewportResize`). All
  gesture inputs (start size, start scale, available box) are captured at
  pointerdown; each move applies the total delta to the captured start, so there is
  no per-move accumulation error and a mid-gesture scale change cannot make the
  mapping jump.
- **While dragging:** a small size badge (`W × H`) floats at the top of the panel —
  the toolbar indicator is live too, but the eye is on the surface (req 5). A
  transparent shield covers the panel so the iframe cannot swallow pointer events
  (same problem the app-level panel divider solves with `pointer-events-none` in
  `AppLayout.tsx`), and body cursor/user-select are pinned for the gesture with
  unmount-safe cleanup (pattern from `useResizablePanel.ts`).

### Pieces

- `PreviewFrame/ViewportResizeHandles.tsx` (new) — the three handles, the drag
  shield, the drag badge, and exported pure `computeViewportResize()` for tests.
  Renders from metrics passed by `PreviewFrame`; writes through
  `usePreviewStore.getState().setFreeformSize()`. Handles are pointer-only
  affordances (`aria-hidden`, not focusable): the accessible path to an exact size
  is the existing labelled width/height inputs in the menu.
- `DeviceFrame.tsx` — `useDeviceFrame` additionally exposes the available box
  (panel minus padding) for clamping and for the Freeform default.
- `PreviewFrame.tsx` — renders the handles into the device container next to the
  iframes (only while the frame is active and the pane visible).

### Store changes

- `setFreeformSize(width, height)` (new) — one atomic `set()`: synthetic Custom
  preset (`id: "custom"`, label `"Custom"`), `customSize`, `isLandscape: false`.
  Atomic because it runs per pointermove; three chained setters would render (and
  persist) partial states.
- The synthetic custom preset's label becomes the constant **"Custom"** (was
  `"W×H"`). The trigger no longer duplicates the indicator sitting next to it,
  stays stable during a drag, and can no longer disagree with the surface after a
  rotate.
- `toggleLandscape()` on a custom size swaps the stored `customSize` (and the
  synthetic preset dims) instead of flipping `isLandscape` — custom sizes are
  always stored as rendered (resolved question).
- `setCustomSize` is removed: `setFreeformSize` is its only caller's replacement,
  and a second entry point that sets half the state is exactly what produced the
  label/orientation mismatches above.

### Menu changes (`DeviceSelector.tsx`)

One new row at the top of the Custom group: **Freeform**, showing the size it will
activate (the current custom size, else the panel size on first use — passed down
from `useDeviceFrame`'s available box). Selecting it activates Custom at that size,
so the handles appear around what the user was already looking at. The rotate
button's tooltip on a custom size reads "Swap width and height" (it is not
portrait/landscape there).

## 2. Per-session viewport memory (req 6)

### Model

The viewport choice moves out of the in-memory `SessionPreviewSnapshot` into a
localStorage-backed map, mirroring the `shipit:preview-paths` design one for one:

- `stores/viewport-memory.ts` (new) — `shipit:preview-viewport` key,
  `Record<sessionId, PersistedViewport>` where `PersistedViewport` is
  `{ preset: id, landscape?: true }` for named presets or `{ custom: {width, height} }`.
  Load-time validation drops anything unusable (unknown preset id — e.g. presets
  renamed by an update — or out-of-bounds custom dims) and caps entries at 100 with
  oldest-first truncation; writes re-insert the touched key so eviction is LRU.
  Responsive is stored as **absence** (the entry is deleted): the default needs no
  record, and the map stays small.
- `preview-store.ts` — holds the hydrated map in state (`viewportMemory`, exactly
  like `previewPaths`). Every viewport mutation (`setDevicePreset`,
  `toggleLandscape`, `setFreeformSize`) writes the map entry for the *current*
  session (`useSessionStore.getState().sessionId`, the blessed cross-store read)
  synchronously in the same `set()`, and schedules a debounced (300 ms) localStorage
  flush — a drag emits ~60 mutations/second and each flush serializes the whole map.
  The state map is always correct at mutation time, so a session switch racing the
  flush timer cannot attribute a choice to the wrong session; the flush just
  serializes whatever the map already holds.
- `restoreSession(sessionId)` resolves the viewport from the map in **both**
  branches (snapshot hit and miss). This is what makes reload work: on a cold load
  the URL→store sync effect runs `resumeSessionInternal` against a
  half-initialized store and an accidental defaults-snapshot exists by the time
  `restoreSession` runs, so "fall back to localStorage only when no snapshot
  exists" would never fire. The map is the single source of truth for the
  viewport; the snapshot no longer carries it at all.
- `reset()` keeps the map (same reasoning as `previewPaths`: session-scoped resets
  must not erase cross-session memory); the full reset clears it
  (`clearViewportMemory()`, called beside `clearPreviewPaths()` in
  `fullResetAllStores`).

### Why not persist the whole snapshot

The snapshot holds live status, errors, and startup steps — transport state that is
wrong to resurrect after a reload (the server re-sends the truth). Persisting the
one field that is a user *choice*, keyed by session, is the smallest thing that
satisfies req 6.

## 3. Decided against building

- **Device bezels / chrome.** The boundary already reads clearly; bezels are
  decoration that eats panel space.
- **User-agent / touch-event / devicePixelRatio emulation.** The issue is explicit
  that this is CSS-breakpoint flipping without UA changes; DPR emulation needs
  proxy/CDP machinery for marginal value.
- **A zoom control.** Auto scale-to-fit already answers "it doesn't fit"; a manual
  zoom would add a second number to reason about.
- **Global or per-repo memory scope.** See resolved question — per session matches
  how previews are used and how the rest of the preview state is scoped.
- **Left/top drag handles.** The surface is centered; right/bottom/corner cover
  both axes without doubling the hit-testing surface.
- **Breakpoint ruler / media-query markers.** Genuinely useful someday, but a
  separate feature with its own design questions (whose breakpoints?).
- **Renaming "Responsive".** T3 Code calls it "fill"; the shipped vocabulary is
  DevTools-familiar and renaming it would churn tests and muscle memory for zero
  behavior.

## Key files

| File | Role |
|---|---|
| `src/client/components/PreviewFrame/ViewportResizeHandles.tsx` | Handles, shield, badge, `computeViewportResize` |
| `src/client/components/PreviewFrame/DeviceFrame.tsx` | `useDeviceFrame` + available box |
| `src/client/components/PreviewFrame/PreviewFrame.tsx` | Renders handles in the device container |
| `src/client/components/PreviewFrame/PreviewToolbar.tsx` | Threads freeform default; routes custom entry through `setFreeformSize` |
| `src/client/components/DeviceSelector.tsx` | Freeform row; custom-aware rotate tooltip |
| `src/client/components/device-presets.ts` | Presets + `CUSTOM_SIZE_MIN/MAX` (moved here from DeviceSelector so the store side stays component-free) |
| `src/client/stores/viewport-memory.ts` | Persisted shape, load/validate/save, LRU |
| `src/client/stores/preview-store.ts` | `setFreeformSize`, write-through, restore-from-map |
| `src/client/stores/actions/session-actions.ts` | `clearViewportMemory()` on full reset |
