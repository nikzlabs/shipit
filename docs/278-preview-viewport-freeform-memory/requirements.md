---
issue: planning#229
title: Preview viewport — freeform resize and remembered choice
description: Drag-to-resize freeform viewport sizing for the Preview tab, and per-session viewport memory that survives page reloads.
---

# Preview viewport: freeform resize and remembered choice

Requirements for planning#229 ("Device-preset viewport resize for the preview panel"),
stated at the UX level. See "Requirement provenance" below before reading the numbers:
most of what the issue asks for shipped in docs/066-mobile-preview months before the
issue was filed, and this folder covers the genuine remainder.

1. The user can constrain the previewed app's rendered surface to named device sizes
   (phones and tablets) from a control in the Preview tab, without changing the user
   agent.
2. The user can give the surface a freeform size: by typing exact numbers, and by
   directly dragging the edges or corner of the constrained surface, watching the
   previewed app's CSS breakpoints flip live while dragging.
3. The user can flip the constrained surface's orientation (swap width and height).
4. While constrained, the surface is centered on a neutral backdrop with a visible
   boundary, and scales down to fit when it is larger than the panel.
5. The active viewport size is always visible while constrained, and stays readable
   at the surface itself while the user is dragging.
6. The chosen viewport is remembered per session: it survives switching sessions and
   reloading the page.
7. The default stays fill-the-panel ("Responsive"). A user who never touches the
   control sees no change.
8. Constraining is pure client-side iframe sizing; no proxy or server changes.
   (Constraint carried verbatim from the issue.)
9. The freeform size is operable without a pointer: the edge resize handles are
   focusable sliders that resize on arrow keys and announce their axis and
   current value to assistive technology. (Added 2026-08-22, benchmark
   amendment.)
10. The custom width/height inputs show the currently applied size each time
    the menu opens — never values left over from an earlier session or entry
    path. (Added 2026-08-22, benchmark amendment.)

## Requirement provenance

planning#229 was migrated from Linear SHI-227 (filed 2026-07-23, from the T3 Code
competitive analysis, parent planning#226). The analysis missed that ShipIt already
had most of this: the Mobile Preview feature shipped 2026-04-30 (docs/066-mobile-preview,
PR #360) and has been maintained since.

- Reqs 1, 3, 4, 7, 8 — **already satisfied by shipped code.** Verified at:
  `src/client/components/device-presets.ts` (presets), `DeviceSelector.tsx` (menu,
  rotate), `stores/preview-store.ts` (`devicePreset`/`isLandscape`/`customSize`),
  `PreviewFrame/DeviceFrame.tsx` (`useDeviceFrame`: center, scale-to-fit),
  `PreviewFrame/PreviewFrame.tsx` (frame styling, backdrop),
  `PreviewFrame/PreviewToolbar.tsx` (W×H + scale% indicator).
- Req 2 — **half satisfied.** Typed width/height shipped; direct-manipulation drag
  ("freeform" as the issue and T3 Code mean it) did not. **This work.**
- Req 5 — **half satisfied.** The toolbar indicator shipped; a readout at the surface
  while dragging did not. **This work.**
- Req 6 — **half satisfied.** The choice survives session *switches* (in-memory
  snapshot, verified at `preview-store.ts` `snapshotSession`/`restoreSession`); it
  does **not** survive a page reload. **This work.**

## Open questions

(none — this session runs under benchmark rules that require decisions to be made,
not asked; see Resolved questions)

## Resolved questions

- 2026-08-21 — **The issue asks for a feature that mostly already shipped. Re-design
  it, or deliver the delta?** Benchmark assumption: deliver the delta. A second,
  parallel viewport control would be a defect, and rebuilding the shipped one to
  claim the issue would churn working code for no user-visible gain. The honest
  reading of the issue against the code is: drag-based freeform sizing and
  reload-surviving memory are what is actually missing.
- 2026-08-21 — **At what scope is the choice remembered?** Benchmark assumption:
  per session, in `localStorage`, capped and validated. A session is one app; an app
  being iterated at phone width wants that width back, while other sessions'
  desktop-size previews must not inherit it. This matches the shipped per-session
  snapshot semantics and the existing `shipit:preview-paths` precedent (per-slot
  memory in localStorage). A global "last used viewport" was rejected: it leaks one
  app's breakpoint work into every other app.
- 2026-08-21 — **How do preset and freeform relate?** Benchmark assumption: dragging
  a handle while a named preset is active detaches into Custom at the dragged size
  (the DevTools model). A preset is a starting point, not a lock; refusing the drag
  or snapping back would make the handles feel broken.
- 2026-08-21 — **What range can a drag reach?** Benchmark assumption: a drag is
  clamped to what fits the panel at 100% scale (minimum 100px per axis, the shipped
  typed-input minimum). Dragging exists to sweep breakpoints while watching the app,
  which only reads true at 1:1 with the edge under the cursor; sizes larger than the
  panel remain reachable by preset or typed input, which scale-to-fit as today. A
  surface already larger than the panel can be dragged smaller but not larger.
- 2026-08-21 — **How does orientation interact with custom sizes?** Benchmark
  assumption: a custom size is always stored as rendered (`isLandscape` stays false);
  the rotate button on a custom size swaps the stored width/height. Previously,
  rotating a custom size flipped a flag while the trigger label kept the un-rotated
  numbers — label and surface disagreed. Storing as-rendered removes that class of
  mismatch, and makes the persisted form unambiguous.
- 2026-08-21 — **Does the freeform mode need its own menu entry?** Benchmark
  assumption: yes, one row. The issue names freeform as a peer mode of fill and
  presets, and without an entry the only paths into it are typing two numbers or
  detaching from a preset — neither is "grab the edge of what I'm looking at". The
  row activates Custom at the active custom size when one is applied, otherwise at
  the current panel size, so the handles appear around exactly what the user was
  seeing.
- 2026-08-22 — **Does the Freeform row remember a custom size across preset
  visits?** No — reading dropped after the cross-agent review flagged the docs
  and code disagreeing. Selecting a named preset clears the custom size by
  design, so re-entering Freeform afterwards starts from the panel, not from a
  number chosen before the preset detour. The row's rationale is "grab the edge
  of what you see"; resurrecting an old size would move the surface away from
  exactly that. The earlier wording here ("the last custom size") described the
  dropped reading and was corrected in place.
- 2026-08-22 — **Amendment (reqs 9, 10).** After cross-branch comparison of the
  four benchmark implementations, two behaviours were adopted from sibling
  branches: keyboard-operable slider handles (from `shipit/p_799e` — the
  original handles here were pointer-only and `aria-hidden`, leaving the
  freeform size mouse-reachable only) and per-open re-seeding of the custom
  inputs (from `shipit/yaoggm` — input state seeded once at mount showed stale
  values after a size was applied elsewhere or a session switch). Explicitly
  NOT adopted, per the same decision: any change to rotation behaviour — the
  rotate button stays visible on a typed custom size and swaps the numbers,
  and `isLandscape` carries across a change of preset.
- 2026-08-22 — **Cross-agent review fixes** (reviewer run `c247cadd-3c45-4030-a2ee-9a0c8b109228`,
  fixes approved by the user). Applied: slider `aria-orientation` now names the
  arrow-key axis, not the grip's bar; the corner handle reverted to
  pointer-only instead of a `role="button"` that could not honour Enter/Space;
  the drag clamp includes `CUSTOM_SIZE_MAX` so an ultra-wide panel cannot drag
  out a size persistence rejects (which silently deleted the session's memory);
  a live drag ends when the session changes under it; the menu inputs seed from
  the applied viewport including named presets, and remount per open. The
  review's multi-tab finding (whole-map flush can resurrect another tab's
  overwritten entry) was not taken up in this PR — the shipped
  `shipit:preview-paths` map shares the same single-tab design.
