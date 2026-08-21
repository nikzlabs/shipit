description: Implements docs/279-viewport-control requirements — the audit of the shipped viewport control, the state-machine fixes it found, and how the feature was verified live.
---

# Viewport control: audit, fixes, verification

Implements [`requirements.md`](./requirements.md) (reqs 1–8).

## What already existed (and why this is not a from-scratch build)

planning#229 describes ShipIt's preview viewport control as a gap to close.
The control has existed since April 2026:

- **docs/066-mobile-preview** (`PR #360`) — `DeviceSelector` dropdown in the
  preview toolbar; presets + custom size + rotate; iframe constrained,
  centered, scaled to fit; per-session snapshot persistence. 157 co-located
  tests across `DeviceSelector.test.tsx`, `PreviewFrame.test.tsx`,
  `preview-store.test.ts`, and `PreviewToolbar.test.tsx`.
- **June 2026 modernization** (`637ae7fd`) — preset list refreshed to
  iPhone 16 lineup / Pixel 9 / 6th-gen iPad Mini with correct logical CSS
  viewports.
- **August 2026 toolbar collapse** (`88978dab`) — the viewport label is the
  first label sacrificed when the panel narrows; the device icon, the
  trigger tooltip, and the always-visible `W×H (%)` readout carry the
  information afterwards.

The July-filed issue predates none of this so much as duplicates it — a
competitive-analysis artifact (its parent issue tracks the T3 Code analysis,
not a user report). The honest unit of work here was therefore an **audit of
the shipped behavior against requirements**, fixing what failed them, and
recording the live verification the original feature never did.

## Audit results

| Req | Verdict |
|-----|---------|
| 1 constrain to preset / freeform | held |
| 2 fill mode default + one action back | held ("Responsive") |
| 3 framed, centered, dimensioned surface | held (`bg-tertiary` surround, border+shadow frame, `393×852` label) |
| 4 scale-to-fit with percent | held (`transform: scale()`, `(67%)`) |
| 5 orientation swap | held for presets — **but see defect D1** |
| 6 per-session memory | held (`SessionPreviewSnapshot`) |
| 7 no UA / URL / reload change | held (pure client-side iframe sizing) |
| 8 freeform range validation | held (`CUSTOM_SIZE_MIN/MAX`, inline error) |

## Defects fixed

All three are state-machine defects in `preview-store.ts`; each silently
composed a viewport the user had not chosen.

**D1 — landscape leaked into custom size** (`setDevicePreset`). Rotate a
preset to landscape, then pick Custom and apply 800×500: `isLandscape` stayed
`true` and `useDeviceFrame` swapped the typed dimensions to 500×800 while
every label kept reading `customSize`. The fix clears `isLandscape` whenever
the active size stops being a rotated named preset — i.e. on any transition
to `null` or to `category: "custom"` — and re-arms it fresh (portrait) when a
named preset is picked.

**D2 — stale preset under a new custom size** (`setCustomSize`). The store
action wrote `customSize` without touching `devicePreset`. The toolbar wires
`onCustomSize` to also set the synthetic `{id: "custom"}` preset, so the UI
path masked this — but the action is the store's API, and any caller that
followed its contract alone left `devicePreset` pointing at the previous
preset whose dimensions were now ignored by `useDeviceFrame`
(`category === "custom"` reads `customSize`), while the toolbar's checkmark
and trigger still named the old preset. The fix makes `setCustomSize` install
(or refresh) the synthetic custom preset itself, and drops the duplicated
half of that dance from the toolbar call site.

**D3 — rotate applied to custom sizes.** With a custom size active the rotate
button rendered (it keys on "a preset is active", which the synthetic custom
preset satisfies) and swapping width/height contradicts what the user typed —
the same reasoning as the resolved question in requirements.md. The fix moves
the visibility rule onto `activePreset.category !== "custom"`, in
`DeviceSelector`, where the rest of the button's gating lives.

## Key files

| File | Role |
|------|------|
| `src/client/stores/preview-store.ts` | State machine: preset / custom / landscape transitions |
| `src/client/components/device-presets.ts` | Preset list + `findPresetById` |
| `src/client/components/DeviceSelector.tsx` | Dropdown UI: Responsive / Phones / Tablets / Custom + rotate |
| `src/client/components/PreviewFrame/DeviceFrame.tsx` | Scale-to-fit metrics from panel size |
| `src/client/components/PreviewFrame/PreviewToolbar.tsx` | Control placement + `W×H (%)` readout |
| `src/client/components/PreviewFrame/PreviewFrame.tsx` | Constrained iframe styling + centering |

## Verification

The repo runs inside itself, but neither documented loop can show this
feature: the inner orchestrator is `RUNTIME_MODE=local`, which constructs no
ServiceManager and serves no preview (docs/118 v1 cut), and the outer
instance denies session-container origins on every non-opted route by design
(docs/201). The dogfood image itself was also unbuildable at audit time
(`docker/agent-cli/package-lock.json` out of sync with its manifest —
upstream, not this branch).

So verification drove the real product stack end to end instead:

1. A test-mode orchestrator (`serveStatic: false`, the integration-test
   configuration) listens on a local port; a session is created through
   `POST /api/_test/sessions`.
2. The runner's `detectedPorts` setter — the exact seam a real compose
   service populates (`container-session-runner.ts:setServiceManager` →
   `buildDetectedPortsFromServices`) — is pointed at a static HTTP server
   serving a page whose script reports its own `window.innerWidth/Height`
   and applies named CSS breakpoints.
3. Vite's dev server proxies `/api` and `/ws` to that orchestrator, and the
   real browser opens the real client at `/session/{id}`.
4. Through Playwright: pick iPhone 16 → the page reports 393×852 and renders
   the phone breakpoint; rotate → 852×393; apply custom 800×600 after a
   rotated preset → exactly 800×600 (D1 regression, live); Responsive → full
   panel again. Screenshots at each step.

That exercises the production path — WS `preview_status` → preview store →
`deriveEffectivePreviewStatus` → health poller → iframe slot → device-frame
sizing — with only the *container* faked, which is the one thing this
client-only feature never touches.

## Deliberately not built

- **More devices.** Six presets cover the breakpoint space worth checking;
  a phone zoo adds menu length, not information (req 1 asks to flip
  breakpoints, not to enumerate SKUs).
- **UA spoofing / touch emulation / DPR control.** Explicit non-goals of the
  issue ("without changing the user agent") and of docs/066.
- **Global or localStorage persistence.** Per-session is the defensible scope
  (resolved question 3); persisting globally would leak frames between
  projects, and surviving reloads would make a stale constraint look like a
  broken preview.
- **Freeform drag handles on the frame.** The number inputs give exactness;
  drag handles would add hit-target chrome around a surface whose whole point
  is precise breakpoints, plus a second resize grammar to maintain.
- **Per-preset landscape memory.** One flag, reset on preset change (D1),
  keeps the state machine two fields wide. Remembering rotation per preset
  buys nothing once switching presets re-enters portrait predictably.
