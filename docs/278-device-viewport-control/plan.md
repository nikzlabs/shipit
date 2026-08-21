---
issue: planning#229
title: Device viewport control — design
description: Where the control lives, how preset/freeform/orientation compose, how the frame is scaled and centered, and what is deliberately missing.
---

# 278 — Device viewport control: design

**Requirements:** [`requirements.md`](./requirements.md) — human-owned, the
source of truth for what this does. Numbers like (req 3) point there.

## Provenance: what this issue re-runs against

The viewport feature has shipped in pieces, and this branch is the
planning#229 catch-up work against the current state of the product.

- `docs/066-mobile-preview` scoped the original build: presets, a device
  selector in the preview toolbar, a scaled centered iframe, per-session
  store state. It landed as "Implement Mobile Preview Feature" (PR #360) with
  the `DeviceSelector`, `device-presets`, `DeviceFrame` and store additions.
- Later passes (the aug-2026 toolbar work, notably "Preview toolbar: collapse
  labels to icons before the address shrinks") folded the control into the
  toolbar's collapse ladder and kept the tests green — 157 tests across the
  four touched suites passed at the head of this branch, all of them
  behaviour-level (iframe styles, dimension label, scale transform, snapshot
  round-trips).

So this branch owns the *finish*: the three defects below, the extraction of
the viewport math into a pure tested function, and the requirements/plan/
checklist record planning#229's issue never had.

## The three defects this change fixes

### 1. Choosing any named preset destroyed the freeform size (req 4)

`setDevicePreset` cleared `customSize` whenever a *named* preset was selected,
and the toolbar additionally nulled it on the way to "Responsive". The Custom
section's inputs then re-opened at 390×844 — the freeform size the user had
typed was gone the moment they peeked at any preset.

The fix makes `customSize` independent of the active preset, exactly like
`isLandscape` already was: it is the remembered freeform viewport (the
"Custom" mode's payload), replaced only by a new Apply, cleared only by the
session reset, and round-tripped through session snapshots like everything
else. Re-entering Custom restores the last size (req 4, and the resolved
question on preset/freeform relationship).

### 2. Escape was a dead key inside the Custom inputs

The Custom row stops keydown propagation so typing cannot activate menu rows
behind the inputs. That also swallowed `Escape` — Radix's menu-closing
keydown listener sits on the document, so the key did nothing while an input
had focus. Only `Escape` now escapes the propagation stop (reqs 4, 6).

### 3. Viewport math was inline in a hook, untestable at the decision level

`useDeviceFrame` computed rotation, custom-size resolution and scale-to-fit
inside the hook. The math is extracted into a pure function,
`resolveDeviceViewport` (`DeviceFrame.tsx`), which the hook calls with the
measured container; a `DeviceFrame.test.tsx` pins the decisions: portrait/
landscape swap for presets **and** custom sizes, the custom-preset fallback
when no stored size exists, the never-scale-above-1 clamp, and the exact
scale-to-fit formula with its 16 px padding (reqs 3–6).

## Design decisions

### Control placement (req 1)

A compact dropdown in the preview toolbar, immediately right of the
port/status group: `[Responsive ⌄]` with a device glyph, the active preset's
name (or the custom dimensions) as the label, and a rotate button appearing
beside it while a constrained size is active. The menu groups Phones, Tablets
and Custom; "Responsive" is the top entry and is the fill mode (req 2). The
control's label is the first to collapse on a narrow toolbar — the device icon
and tooltip carry it, and the *size indicator* collapses with it (req 6).

The toolbar reads and writes the viewport state directly through the preview
store; the `PreviewFrame` measures the panel and renders the frame.

### Freeform (req 4)

The Custom section opens with the stored custom size (or 390×844 defaults
when none exists), two number inputs and an Apply button. Apply is disabled
while either dimension is outside 100–2560 or non-numeric, with an inline
validity message; Enter applies (req 4, and the resolved sizing-constraints
question).

### Orientation (req 5)

One toggle button, `DeviceRotate`, shown whenever a constrained size is
active — presets and custom alike. It flips an `isLandscape` flag in the store
and the whole pipeline (frame dimensions, size indicator) reads the swapped
width/height. Fill has no rotate button and no orientation (req 5).

### Frame and size indicator (req 6)

- The active iframe gets explicit `width`/`height` matching the (rotated)
  viewport and is centred with `left/top: 50%` + `translate(-50%,-50%)`, with
  rounded corners, a hairline border and a subtle shadow isolating the surface
  from the neutral panel background.
- Scale-to-fit: `min(1, (panelW − 32)/deviceW, (panelH − 32)/deviceH)` — never
  enlarged, always ≤ 1, preserving aspect ratio. A `ResizeObserver` on the
  panel recomputes as the panel is dragged.
- The toolbar shows the active viewport as `393×852` and, when scaled, the
  factor as `(82%)` — the "size indicator" of req 6, positioned where the eye
  already is when the user thinks about size.

### Memory scope (reqs 3–6; resolved question)

Per session, in memory: `devicePreset`, `isLandscape` and `customSize` live in
`SessionPreviewSnapshot` (`preview-store.ts`), snapshotted on session switch
and restored on return. Not global, not persisted across reloads — the
viewport is inspection state about the app under review, like the selected
port, not a user preference.

## Deliberately not built

- **Drag-to-resize frame edges.** Freeform width/height covers the need with
  exact numbers; a drag affordance adds hit-region and clamping complexity for
  precision the typed inputs already give.
- **User-agent and device-pixel-ratio emulation.** The issue explicitly wants
  breakpoint flips *without* changing the user agent; UA spoofing would also
  break real-world checks (asset URLs, auth headers) for little gain.
- **Desktop/laptop presets.** Fill mode is already the desktop viewport; a
  third category would clutter the menu without adding a viewport fill cannot
  show.
- **Per-preset orientation memory.** Orientation is a session-level flag;
  remembering it per preset is cleverness nobody will rely on.
- **Cross-reload or global persistence.** Per-session memory is the decided
  scope (see above); persisting a "default viewport" would surprise across
  sessions.
- **Device bezels and status bars.** Cosmetic chrome; the hairline border and
  shadow do the separating work for a fraction of the pixels.

## Key files

- `src/client/components/device-presets.ts` — preset catalogue + `findPresetById`
- `src/client/components/DeviceSelector.tsx` — the toolbar control (menu, custom inputs, rotate)
- `src/client/components/PreviewFrame/DeviceFrame.tsx` — `resolveDeviceViewport` (pure math) + `useDeviceFrame` (panel measurement)
- `src/client/components/PreviewFrame/PreviewFrame.tsx` — renders the framed/scaled iframe
- `src/client/components/PreviewFrame/PreviewToolbar.tsx` — hosts the selector and the size indicator
- `src/client/stores/preview-store.ts` — `devicePreset` / `isLandscape` / `customSize` + snapshot round-trip

## Tests

- `DeviceFrame.test.tsx` (new) — the pure viewport math: rotation, custom resolution, scale-to-fit, clamps.
- `preview-store.test.ts` — custom-size retention across preset and fill switches (replaces the old "clears customSize" pin); snapshots unchanged.
- `DeviceSelector.test.tsx` — Escape closes the menu from inside the Custom inputs.
- `PreviewFrame.test.tsx` + `PreviewToolbar.test.tsx` — existing behaviour pins (iframe dimensions, rotation swap, dimension label, scale transform) unchanged and green.