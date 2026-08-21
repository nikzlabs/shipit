---
issue: planning#229
title: Preview viewport resize — design
description: How the Preview tab's viewport control works, and what this branch added to the version that shipped in docs/066.
---

# Preview viewport resize — design

Implements [requirements.md](./requirements.md). Read that first; requirements
are cited below as `(req N)`.

## What was already there

**Most of this feature shipped in April 2026** as
[`docs/066-mobile-preview`](../066-mobile-preview/plan.md) — `59adb75a`, split
into its current files by `ad111cec`. `planning#229` came out of a July
competitive sweep of T3 Code and asked for a viewport control ShipIt already
had. Before this branch the Preview tab could already do reqs **1–7** and
**10**: a preset dropdown grouped into Phones and Tablets, typed freeform
width/height, a rotate button, the frame centred on `--color-bg-tertiary` and
scaled to fit, and a `393×852 (76%)` readout in the toolbar.

So the work here is the delta, not a second implementation:

| Requirement | State before | This branch |
|---|---|---|
| 8 — drag an edge to resize | absent | `ViewportResizeHandles` + `viewport-drag.ts` |
| 9 — survives a page reload | in-memory only | localStorage, still per-session |
| 7 — size readable, once | freeform printed its size twice, and rotating made the two disagree | preset label is `Custom`; the readout is the only place dimensions appear |

Everything else was left alone. The parts of `docs/066` this branch touches are
noted in its checklist; the rest of that doc still describes the product.

## Drag to resize (req 8)

Three handles — right edge, bottom edge, bottom-right corner. There is no
fourth: the frame is **centred**, so a left handle and a right handle would set
the same number.

`viewport-drag.ts` holds the arithmetic as pure functions, away from React, and
two things in it are easy to get wrong:

- **A centred frame moves each edge by half of any size change.** So a pointer
  delta has to buy *twice* as much viewport for the dragged edge to stay under
  the cursor. That is the `CENTRED_EDGE_FACTOR`.
- **Deltas are divided by the scale captured at drag start, never the live
  one.** Scale-to-fit shrinks the frame as the viewport grows, so a live divisor
  would be a feedback loop — each move changing the scale the next move is
  measured against. Anchored to the start scale, the edge tracks the pointer
  exactly until the viewport outgrows the panel; past that the frame pins at the
  panel edge while the number keeps climbing. That is how a 1280px viewport is
  reached in a 700px panel, and the readout says what is happening.

Landscape is applied at render time by swapping the stored width and height, so
a drag — which necessarily works in rendered space — swaps back before
committing (`toStoredSize`). Without it, rotating after a drag transposed the
size the user had just set.

**Pointer capture, not the repo's document-listener pattern.** The three other
draggables here (`useResizablePanel`, `useSidebarResize`,
`PreviewServicesDrawer`) attach `mousemove`/`mouseup` to `document` on
mousedown. That does not survive this case: the pointer crosses a **cross-origin
iframe**, which does not deliver mouse events to the parent document, and a
drag that dies the moment the cursor enters the preview is not a drag. Capture
also collapses the mouse and touch paths those hooks duplicate. The one thing it
does not carry across a document boundary is the **cursor**, so a shield div
covers the panel while a drag is live.

Arrow keys resize too, one 10px step per press, on whichever axis the handle
owns. That path deliberately skips the centred doubling: a key press asks for a
number of viewport pixels and has no pointer to keep under an edge, so the step
is the step. The single-axis handles are `role="slider"` with live
`aria-valuenow`, which is what makes the number readable without the toolbar.

## Remembering the choice (req 9)

`docs/066` had already decided **per-session over global**, for the right reason
— two sessions build two different apps — and put the choice in the in-memory
session snapshot. That survives switching away and back, and is lost by a
reload, which is the one action a user would call "coming back to it". Scope
kept, durability added.

`shipit:preview-viewports` maps `sessionId → {presetId, landscape, width?,
height?}`, mirroring the existing `shipit:preview-paths` map next to it: same
oldest-first cap (50), same "re-insert on write so the survivors are the recent
ones", same tolerance of a garbage value. Only the *choice* is stored, never the
resolved dimensions of a named preset — a preset id is looked up in
`DEVICE_PRESETS` on the way back in, so one we later rename or drop degrades to
Responsive instead of restoring dimensions nothing offers. Responsive is stored
as **absence**, because an entry saying "the default" is a row that carries no
information.

Two call sites restore it, and they are not redundant:

- `restoreSession` — session switch. Falls back to the remembered choice only
  when this tab holds no in-memory snapshot for that session.
- `useSessionActivation`'s mount effect — arriving straight at a session URL.
  This is the reload path, and it goes nowhere near `resumeSessionInternal`.

Writes go through `rememberViewport`, which no-ops until a session is active —
so a component test poking the store cannot file a choice under a stranger's
name. The store holds `viewportSessionId` itself rather than reading
`useSessionStore`, which keeps a cross-store import out of it and makes the
persistence testable without standing up a session.

`setViewportSize` exists because both halves of a freeform size have to move
together: `setDevicePreset` clears `customSize` for any non-custom preset, so
"set the size, then set the preset" works and the other order silently discards
the size. It was two calls at the one call site that needed it, in the working
order, with nothing stopping the next caller getting it wrong.

## What this deliberately does not build

- **Desktop and laptop presets.** The panel is narrower than any desktop
  breakpoint, so such a preset renders scaled-down every time, and the handles
  now reach those widths anyway. Named rows for sizes that never render at 1:1
  are menu length without capability.
- **A device bezel or notch.** `docs/066` ruled this out and it is still right:
  the job is flipping breakpoints, and chrome around the frame costs panel space
  that the previewed app should have.
- **A separate zoom control.** Scale is already derived from fit and reported in
  the readout. A second control that changes the same number by a different
  route is two sources of truth for one measurement.
- **A mode switch between "device" and "responsive with handles"**, which is how
  Chrome DevTools does it. A preset is just a named point in the same space a
  freeform size lives in; dragging from one turns it into the other. A control
  whose only job is to gate another control is a control too many.
- **Snapping to common breakpoints while dragging.** Tempting, and wrong: the
  interesting question during a drag is *where does my layout break*, which is
  rarely the round number, and a snap hides exactly the pixel being looked for.
- **Persisting the choice across sessions or globally.** See req 9 — every new
  session would inherit the last app's phone view.
- **User-agent spoofing and touch emulation**, per req 2 and `docs/066`'s
  non-goals. The issue is explicit that only the surface is resized.

## Key files

| File | Role |
|---|---|
| `src/client/components/PreviewFrame/viewport-drag.ts` | Drag/keyboard arithmetic, pure and unit-tested |
| `src/client/components/PreviewFrame/ViewportResizeHandles.tsx` | The three handles, pointer capture, cursor shield |
| `src/client/components/PreviewFrame/PreviewFrame.tsx` | Mounts the handles inside the device container |
| `src/client/components/PreviewFrame/DeviceFrame.tsx` | Scale-to-fit metrics (unchanged) |
| `src/client/components/DeviceSelector.tsx` | Preset dropdown + typed freeform size (unchanged behaviour) |
| `src/client/components/device-presets.ts` | Presets, size bounds, the `Custom` synthetic preset |
| `src/client/stores/preview-store.ts` | `setViewportSize`, `restoreViewport`, localStorage mirror |
| `src/client/hooks/useSessionActivation.ts` | Restores the viewport when landing on a session URL |

## Verification

Unit and component tests are co-located. Beyond those, the control was driven in
a real browser against a real cross-origin iframe: a page that prints its own
`innerWidth`/`innerHeight` and current CSS breakpoint was served on a separate
port and framed by the actual `PreviewFrame`. Picking iPhone 16 flipped it to
`xs`; dragging the right handle took it to 1265px and `lg`, with the readout
tracking; rotate transposed it and a subsequent width drag still grew the right
axis; choosing iPad Mini, reloading the page, and finding it still on iPad Mini
confirmed req 9. The jsdom tests cannot see any of that — no layout, so no
scale, and no second document for a pointer to cross.
