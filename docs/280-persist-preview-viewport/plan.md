# Remember the preview viewport choice

Implements [requirements.md](requirements.md).

## Audit finding this rests on

planning#229 ("Device-preset viewport resize for the preview panel") asks for
what docs/066-mobile-preview already shipped: fill (Responsive), device
presets with orientation, freeform width×height, a centred scaled frame and a
size indicator — all client-side iframe sizing. Verified on main: components
(`DeviceSelector.tsx`, `PreviewFrame/DeviceFrame.tsx`), store state
(`preview-store.ts` `devicePreset`/`isLandscape`/`customSize`) and 136 passing
co-located tests. The only part of the issue's intent still unmet is
persistence across a reload (req 1). This doc therefore covers a small
enhancement, not the control itself.

## Design

One localStorage key holding the last-picked viewport triple, written by the
three existing store setters, read once at store creation.

- **Key**: `shipit:preview-viewport`, next to the store's existing
  `shipit:preview-paths` / `shipit:preview-services:expanded`. Shape:
  `{ presetId: string | null, landscape: boolean, custom: { width, height } | null }`.
- **Write** (req 1): `setDevicePreset`, `toggleLandscape` and `setCustomSize`
  persist the resulting triple after each `set(...)`, mirroring how
  `setServicesDrawerExpanded` writes its key inline.
- **Read** (reqs 2–3): `loadViewportState()` runs once in `initialState`.
  It parses defensively through the existing `getLocalStorageObject` helper,
  resolves `presetId` via `findPresetById`, rebuilds a custom preset from
  stored dimensions validated against the same min/max the selector enforces,
  and falls back to Responsive (`null/false/null`) on anything malformed or
  out of range.
- **Custom preset identity**: the synthetic `{ id: "custom", … }` object the
  toolbar builds on apply moves into a `customPreset(width, height)` helper in
  `device-presets.ts`, shared by the toolbar and the loader so both sides of a
  reload produce identical objects.

### Key files

| File | Change |
|---|---|
| `src/client/components/device-presets.ts` | `CUSTOM_SIZE_MIN/MAX` move here; new `customPreset()` |
| `src/client/components/DeviceSelector.tsx` | imports the constants from their new home (no external importers existed) |
| `src/client/stores/preview-store.ts` | load/save of `shipit:preview-viewport`; initial state from storage |
| `src/client/stores/preview-store.test.ts` | round-trip, malformed-value, unknown-preset, out-of-range tests |
| `src/client/components/PreviewToolbar.test.tsx` | custom preset still applies after the helper refactor |

## Decided not to build

- **Width-only freeform mode** (constrain width, let height fill the panel).
  The issue's "freeform size" is satisfied by arbitrary width×height; a mixed
  constrained axis adds a third UI state, scroll coupling questions, and a
  second kind of indicator for marginal gain over setting a tall custom size.
- **Desktop presets** (e.g. 1280×800). The panel is typically ~400–700 px
  wide; scale-to-fit would render them at 30–50 % where text is illegible —
  worse than useless as one-click presets. Custom size already reaches 2560 px
  for anyone who genuinely needs it.
- **Per-session reload persistence.** Rejected under requirement 2's resolved
  question; snapshots keep covering within-visit session switches.
- **DPR / zoom / user-agent emulation.** Explicitly outside the issue
  ("without changing the user agent").

## Test plan

Co-located vitest additions (store round-trip incl. reload semantics via
localStorage, malformed JSON, unknown id, out-of-range custom dims, landscape
flag persistence; toolbar custom-preset regression), then the real thing in
the running product: pick iPhone in the live preview pane, reload, confirm
the frame, label and rotate button come back; apply a custom size, reload,
confirm it too; choose Responsive, reload, confirm it stays off.
