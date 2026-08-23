# Checklist — freeform resize + viewport memory

## Foundations

- [x] Move `CUSTOM_SIZE_MIN` / `CUSTOM_SIZE_MAX` into `device-presets.ts`; update importers
- [x] `viewport-memory.ts`: `PersistedViewport` type, load with validation (unknown preset id dropped, out-of-bounds custom dropped), LRU cap at 100, save, entry builder from live state
- [x] `viewport-memory.test.ts`: round-trip, validation drops, cap/LRU eviction, responsive-as-absence

## Store

- [x] `preview-store.ts`: hydrate `viewportMemory` into state; write-through on `setDevicePreset` / `toggleLandscape` / `setFreeformSize` keyed by current session; debounced flush
- [x] `setFreeformSize(width, height)` — atomic custom preset (label "Custom") + `customSize` + `isLandscape: false`
- [x] `toggleLandscape` on custom swaps stored dims instead of flipping the flag
- [x] Remove `setCustomSize`; drop viewport fields from `SessionPreviewSnapshot`; `restoreSession` resolves viewport from the map in both branches
- [x] `clearViewportMemory()`; wire into `fullResetAllStores`
- [x] `preview-store.test.ts`: rewrite viewport round-trip tests against the new mechanism (switch away/back, reload-shaped: fresh hydrate → restore), write-through keying, custom rotate swap, freeform atomicity

## Drag handles

- [x] `ViewportResizeHandles.tsx`: right/bottom/corner handles, drag shield, drag badge, `computeViewportResize` (2Δ/scale, clamp `[MIN, max(available, current)]`)
- [x] Body cursor/user-select pinned during drag with unmount-safe cleanup
- [x] `DeviceFrame.tsx`: expose available box from `useDeviceFrame`
- [x] `PreviewFrame.tsx`: render handles when frame active + pane visible
- [x] `ViewportResizeHandles.test.tsx`: math unit tests; drag converts preset → Custom; drag updates size; badge appears while dragging; handles absent when responsive

## Menu

- [x] `DeviceSelector.tsx`: Freeform row (activates custom at current custom size / panel-size default), custom-aware rotate tooltip
- [x] `PreviewToolbar.tsx` / `PreviewFrame.tsx`: thread freeform default size; route custom entry through `setFreeformSize`
- [x] `DeviceSelector.test.tsx`: Freeform row present + fires with expected size; existing tests updated for "Custom" label

## Amendment (2026-08-22, reqs 9–10)

- [x] Handles keyboard-operable (from `shipit/p_799e`): `role="slider"` + `aria-value*` on edges, `role="button"` corner, arrow-key steps via `computeKeyboardResize`, focus-visible grip
- [x] Custom inputs re-seed per menu open (from `shipit/yaoggm`): `CustomSizeInputs` child remounted by Radix, seeded from the applied size
- [x] Rotation behaviour explicitly unchanged (`setDevicePreset`, rotate-on-custom, landscape-across-presets)
- [x] Keyboard + re-seed tests; suites, typecheck, lint green; PR body updated

## Review fixes (2026-08-22, approved findings 2–5 + docs for 6)

- [x] Slider `aria-orientation` matches the arrow-key axis (width = horizontal, height = vertical)
- [x] Corner handle pointer-only again (`aria-hidden`, no role/tabIndex/keys)
- [x] `computeViewportResize` upper clamp includes `CUSTOM_SIZE_MAX`
- [x] Gesture captures its session and ends on a session change
- [x] Inputs seed from the applied viewport (incl. orientation-adjusted named presets); `CustomSizeInputs` keyed per open
- [x] Docs reworded: Freeform row enters at active custom size else panel size (finding 6 resolved as a doc fix)
- [x] Tests: orientation attrs, corner inertness, MAX clamp, session-change gesture drop, named-preset seed

## Verification

- [x] `npm run typecheck`, `npm run lint:dev`, `npm run test:dev` + all touched suites green
- [x] Dogfood: drag handles resize a real preview; detach from preset; badge readable; choice survives session switch and full page reload; Responsive unaffected
- [x] docs/066 plan updated with a pointer to this folder
