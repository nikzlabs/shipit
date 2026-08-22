---
issue: planning#229
title: Device-preset viewport resize for the preview panel
description: Constrain the preview iframe to device-sized viewports from the Preview tab, without leaving ShipIt.
---

# Device-preset viewport resize for the preview panel

The Preview tab lets the user constrain the preview iframe to common device
sizes — fill, a freeform size, or a named device preset — so responsive
layouts can be checked at phone and tablet widths without leaving ShipIt or
opening browser DevTools.

1. The Preview tab offers three viewport modes: **fill** ("Responsive" — the
   iframe fills the panel), **freeform** (a user-entered width and height),
   and **device presets** (named phone and tablet sizes).
2. A **rotate** control swaps the width and height of the active fixed-size
   viewport (portrait ↔ landscape).
3. A fixed-size viewport centers the iframe in the panel, and a **size
   indicator** shows the viewport's current dimensions.
4. Constraining the viewport flips CSS breakpoints inside the preview
   **without changing the user agent**.
5. Sizing is pure client-side iframe styling; the preview proxy needs no
   changes.
6. A chosen viewport larger than the panel is scaled down to fit, keeping its
   aspect ratio, and the size indicator shows the scale.
7. The viewport choice is **per-session**: switching between sessions
   restores each session's own mode; sessions share no default.
8. The per-session viewport choice survives a page reload.
9. The controls are part of the preview toolbar in the running product.
10. The selector and the size indicator always agree with the on-screen
    frame — a rotated freeform size is reported with its rotated dimensions,
    and a size restored by a session switch appears as-is.

## Open questions

None.

## Resolved questions

- 2026-08-22 — **Is the viewport choice remembered, and at what scope?**
  (benchmark assumption — recorded by the implementing agent, no human
  available to ask) — Remembered per session, durably: persisted to
  localStorage keyed by sessionId, restored on a page reload. The in-memory
  per-session snapshots continue to cover session switches within one page
  load. Not a global preference: the choice describes the project being
  previewed, so it follows the session.
- 2026-08-22 — **How does the user enter a freeform size?** (benchmark
  assumption) — Typed width/height inputs in the selector menu, clamped to
  100–2560 px. Drag-to-resize handles are not built: nothing in the issue
  asks for them, and a drag affordance on the frame would collide with the
  panel's own resize handle.
- 2026-08-22 — **Does the constrained viewport render device chrome?**
  (benchmark assumption) — No bezel or device mockup beyond the existing
  frame outline; the issue asks for the viewport, not a device. Already a
  non-goal in plan.md.
- 2026-08-22 — **Are custom sizes saved as reusable named presets?**
  (benchmark assumption) — No. The last applied custom size is remembered for
  the session (req 7, 8); a saved-preset library is a future extension in
  plan.md.
