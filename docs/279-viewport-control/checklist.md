# Viewport control — checklist

## Audit

- [x] Read planning#229 and map each ask onto the shipped control
- [x] Trace preset / custom / landscape state machine in `preview-store.ts`
- [x] Confirm scale-to-fit + centering + readout in `DeviceFrame.tsx` / `PreviewFrame.tsx`
- [x] Confirm per-session snapshot persistence and restore
- [x] Confirm freeform validation bounds and inline error
- [x] Confirm toolbar collapse ladder treats viewport control as first-class

## Fixes

- [x] D1: `setDevicePreset` resets `isLandscape` on custom/`null` transitions and re-arms portrait on named presets
- [x] D2: `setCustomSize` installs/refreshes the synthetic custom preset itself
- [x] D3: rotate button hidden for custom sizes (`DeviceSelector` gating)
- [x] Toolbar call site drops the now-duplicated preset installation

## Tests

- [x] Store: landscape reset on → custom, → responsive, → other preset (D1)
- [x] Store: `setCustomSize` installs synthetic preset; refresh updates dimensions (D2)
- [x] Store: snapshot/restore round-trips the corrected state
- [x] Selector: rotate button hidden when active preset is custom (D3)
- [x] Existing 157 viewport tests still green

## Verification

- [x] Live harness: test-mode orchestrator + static preview server + real client via Vite proxy
- [x] Playwright: preset constrains page to 393×852, phone breakpoint renders
- [x] Playwright: rotate swaps to 852×393
- [x] Playwright: rotated preset → custom 800×600 applies exactly 800×600 (D1 live)
- [x] Playwright: Responsive restores full-panel surface

Not verified live (recorded, deliberately): per-session snapshot memory across
a **page reload** — the harness reload showed "Responsive" after iPhone 16 had
been set. That is the documented scope, not a defect: `SessionPreviewSnapshot`
is in-memory only (the store comment says so; `previewPaths` is the one state
with a localStorage mirror), so a reload resets it exactly as it resets the
chosen port and auto-fix. Session-*switch* memory — req 6's actual wording —
is covered by `preview-store.test.ts` ("persists device viewport state per
session snapshot"). A localStorage mirror for device state was considered and
declined (plan.md → Deliberately not built).

## Quality gates

- [x] `npm run typecheck`
- [x] `npm run lint:dev`
- [x] `npm run test:dev` + added tests
