# Preview viewport modes

Implements `docs/278-preview-viewport-modes/requirements.md` (reqs 1–8), which
tracks planning#229.

## Prior art: docs/066-mobile-preview

The mechanism this issue describes already exists — docs/066-mobile-preview
shipped it (commit 59adb75a) before SHI-227 was migrated into planning#229.
This document therefore records two different things:

1. **The design as it stands** — inherited from docs/066 and re-verified here,
   requirement by requirement, against the running product.
2. **The delta** — what this pass found missing or broken and changed.

Where the two documents overlap, this one wins for the audit's findings;
docs/066 keeps the original build narrative.

## Design (inherited, verified)

### State

`preview-store.ts` carries `devicePreset: DevicePreset | null`,
`isLandscape`, and `customSize`, all part of `SessionPreviewSnapshot`
(req 8). `devicePreset === null` is Responsive (req 2); a freeform size is a
preset with `category: "custom"` whose dimensions live in `customSize`
(req 4). Presets are data in `components/device-presets.ts`.

### Sizing

`PreviewFrame/useDeviceFrame.ts` resolves the active size (rotation-aware,
req 3) and scale-to-fit against a ResizeObserver on the panel (req 6): scale
is `min(1, (panelW−32)/w, (panelH−32)/h)`; the panel background goes tertiary
and the active iframe gets explicit px width/height plus
`translate(-50%,-50%) scale(s)` centering with border/shadow (reqs 1, 5).
Background iframe-pool slots are untouched. Pure CSS on the iframe element —
no proxy, no injected script (req 7).

### Control

`DeviceSelector.tsx` renders in the toolbar's left group when a preview runs:
trigger shows the active label ("Responsive" or preset name / W×H); menu lists
Responsive, Phones, Tablets, and a custom W×H input pair validated to
100–2560px; rotate button beside it while any fixed size is active (req 3).
The size indicator `{w}×{h}` (+ `(NN%)` when scaled) sits after it and yields
first when the toolbar collapses (`usePreviewToolbarCollapse`) (req 5).

## Delta of this pass

The audit found the requirements met except for two defects, both fixed:

1. **Stale custom-size inputs across session switches** (req 8). The inputs
   seeded their value from `useState(customSize…)` at mount. A switch between
   two sessions that both have running previews swaps `customSize` in the
   store without unmounting the selector, so reopening the dropdown offered
   the previous session's numbers as the starting point for a new custom
   size. Fixed by syncing the inputs to the store value whenever it changes
   externally.
2. **"(100%)" scale artifact** (req 5). The indicator showed `(NN%)` when
   `scale < 1` but printed the *rounded* percentage: a surface at scale
   0.996 rendered "(100%)". The condition now tests the displayed integer.

## Decided not to build

- **Laptop/desktop presets** — see the resolved question in requirements.md:
  scaled-to-death in a split pane, and freeform covers the real need.
- **Drag-to-resize handles** — T3 Code's "freeform" is satisfied by typed
  entry; drag handles over a scaled, cross-origin iframe mean new pointer
  plumbing, min/max clamping UX, and handle rendering for one convenience.
  Revisit only if users ask.
- **Global persistence of the choice** — deliberately per-session (req 8);
  global "always phone-sized" is a footgun for every other repo's session.
- **UA spoofing, touch emulation, device bezels** — docs/066 non-goals,
  reaffirmed; the issue scopes this to breakpoint flipping via CSS size only.

## Key files

| File | Role |
|------|------|
| `src/client/components/device-presets.ts` | Preset data |
| `src/client/components/DeviceSelector.tsx` | Dropdown + rotate + custom entry |
| `src/client/components/PreviewFrame/useDeviceFrame.ts` | Active size + scale-to-fit |
| `src/client/components/PreviewFrame/PreviewFrame.tsx` | Applies sizing to the active slot |
| `src/client/components/PreviewFrame/PreviewToolbar.tsx` | Hosts selector + size indicator |
| `src/client/stores/preview-store.ts` | Viewport state + per-session snapshot |

## Verification

Unit tests co-located per convention (DeviceSelector.test.tsx,
PreviewFrame.test.tsx, preview-store.test.ts), plus a live check of the real
component tree in a real browser: harness page served by Vite mounting
`PreviewFrame` with a running-preview store state, exercising fill → preset →
rotate → freeform → back to fill, including the scaled-down case.
