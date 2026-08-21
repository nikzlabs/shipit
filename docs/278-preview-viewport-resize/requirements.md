---
issue: planning#229
title: Preview viewport resize
description: Constrain the preview surface to a device preset or a freeform size, including by dragging its edge, so the previewed app's own CSS breakpoints respond.
---

# Preview viewport resize

What the Preview tab's viewport control must do. Stated at the level a user would
describe it; the mechanism is in [plan.md](./plan.md).

1. The preview panel can constrain the previewed app to a chosen viewport size, so
   the app's own CSS breakpoints respond as they would on a smaller screen.
2. The user agent the previewed app sees is unchanged. Only the rendered surface
   is resized — nothing is spoofed.
3. Named presets are offered for common phone and tablet sizes.
4. A freeform width and height can be set, within a range that keeps the result
   usable.
5. A constrained viewport can be flipped between portrait and landscape.
6. The constrained surface is centred in the panel, visually separated from the
   space around it, and scaled down to fit when it is larger than the panel.
7. The active viewport's pixel size is readable at all times, together with the
   scale factor whenever the surface is being scaled down.
8. The freeform size can also be set by dragging the edge of the constrained
   surface, and the size readout follows the drag as it happens.
9. The viewport choice is remembered per session and survives a page reload.
   Two sessions previewing two different apps do not share one choice.
10. Returning to "fill the panel" is one click away, and is what a session that
    has never chosen otherwise starts on.

## Open questions

None outstanding.

## Resolved questions

- 2026-08-21 — **Is this feature already built?** Yes, mostly. Requirements 1–7
  and 10 shipped in April 2026 as `docs/066-mobile-preview`
  (`59adb75a`, refactored by `ad111cec`): the preset dropdown, the freeform
  width/height inputs, the rotate button, centred scale-to-fit framing, and the
  `W×H (N%)` readout are all in the product. `planning#229` was filed on
  2026-07-23 from a competitive sweep of T3 Code and did not check what ShipIt
  already had. Verified by reading `DeviceSelector.tsx`, `PreviewFrame/DeviceFrame.tsx`
  and `preview-store.ts`, and by driving the control in a browser. The
  requirements above are therefore written for the **whole** feature, and this
  branch closes only the gaps: req 8 (drag), req 9 (survives reload), and one
  defect against req 7. *Benchmark assumption: rebuilding what works would be
  the wrong answer to the issue, so the issue is read as "make ShipIt's viewport
  control as good as the one the sweep described" rather than "add a viewport
  control".*
- 2026-08-21 — **How do preset and freeform relate?** A preset is a named point
  in the same space a freeform size lives in; picking a preset sets the size,
  and dragging from there turns it into a freeform size. There is no separate
  "freeform mode" to enter. *Benchmark assumption: the alternative — a mode
  switch between "device" and "responsive with handles", as Chrome DevTools has
  — adds a control whose only job is to gate another control, and the issue asks
  for one viewport control, not two.*
- 2026-08-21 — **At what scope is the choice remembered?** Per session, and
  across a page reload. `docs/066-mobile-preview` had already decided per-session
  over global, for the right reason (two sessions build two different apps); it
  put the choice in the in-memory session snapshot, which loses it on reload.
  Per-session is kept, durability is added. *Benchmark assumption: a global
  preference would make every session inherit the last app's phone view, and a
  choice that evaporates on refresh is not "remembered" in any sense a user would
  recognise.*
- 2026-08-21 — **Which edges can be dragged?** Right, bottom, and the
  bottom-right corner. *Benchmark assumption: the surface is centred, so a left
  handle and a right handle would do exactly the same thing; three handles cover
  width, height and both without a redundant fourth.*
- 2026-08-21 — **Should desktop/laptop presets be added?** No. *Benchmark
  assumption: the panel is narrower than any desktop breakpoint, so a desktop
  preset renders scaled-down every time — and the drag handles now reach those
  widths for anyone who wants them. Named rows for sizes that never render at
  1:1 are menu length without capability.*
