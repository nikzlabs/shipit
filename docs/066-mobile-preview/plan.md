# Mobile Preview (Device Viewport Sizing)

Let users preview their app at common mobile and tablet screen sizes directly in the preview pane, without needing browser DevTools.

## Problem

When building responsive web apps, users need to check how their UI looks at different viewport sizes. Today they must resize the browser window or open DevTools device emulation externally. ShipIt should provide this capability in-app so the vibe-coding loop stays tight: ask Claude to make it responsive, see the result at phone size immediately.

## Design

### Core concept

A **device frame toolbar** in the preview header lets users pick a viewport size. The iframe is resized to match the chosen device dimensions and centered within the preview pane. The surrounding area shows a neutral background so the constrained viewport is visually obvious.

### Viewport presets

| Preset | Width | Height | Category |
|--------|-------|--------|----------|
| Responsive (default) | 100% | 100% | — |
| iPhone SE | 375 | 667 | phone |
| iPhone 16 | 393 | 852 | phone |
| iPhone 16 Pro Max | 440 | 956 | phone |
| Pixel 9 | 412 | 916 | phone |
| iPad Mini | 744 | 1133 | tablet |
| iPad Air | 820 | 1180 | tablet |

Users can also type a custom width/height.

### UI changes

#### Preview header bar

Add a **device selector** to the existing preview header bar (left side, after the port indicator). The selector is a compact dropdown/button group:

```
[Responsive ▾]  [↻ Rotate]
```

- **Responsive** — default, iframe fills the panel (current behavior).
- **Dropdown** — opens a menu grouped by category (Phones, Tablets, Custom).
- **Rotate button** — swaps width/height for the active preset (portrait ↔ landscape). Only shown when a fixed-size preset is active.

#### Iframe container

When a device preset is active (not "Responsive"):

1. The iframe gets explicit `width` and `height` styles matching the preset.
2. The iframe is centered horizontally and vertically within the preview area.
3. The preview area background becomes `bg-gray-800` (dark neutral) so the device boundary is clear.
4. If the preset dimensions exceed the available panel space, the iframe is **scaled down** using `transform: scale()` to fit, maintaining aspect ratio. A small label shows the current scale percentage (e.g., "67%").
5. A subtle rounded border or device-frame outline around the iframe provides visual affordance.

#### Dimension label

Below the iframe (or in the header), show the active dimensions: `393 × 852` so the user always knows the exact viewport.

### State management

Add to the preview Zustand store (`preview-store.ts`):

```ts
interface DevicePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  category: "phone" | "tablet" | "custom";
}

// Session-specific state fields
devicePreset: DevicePreset | null;     // null = responsive (fill panel)
isLandscape: boolean;                   // swap width/height when true
customSize: { width: number; height: number } | null;

// Actions
setDevicePreset: (preset: DevicePreset | null) => void;
toggleLandscape: () => void;
setCustomSize: (size: { width: number; height: number } | null) => void;
```

Persist the viewport selection in the preview store's per-session snapshot (`SessionPreviewSnapshot`) along with preview status and selected port. This keeps each session's mobile/responsive mode independent when switching sessions. The selection is not a global `localStorage` preference.

#### Durable persistence across reloads

The snapshot above is in-memory only, so a page reload used to drop the choice
and forced the user to re-pick the device every reload — the exact loop
(reload → check a breakpoint) this feature serves. The store now also mirrors
the device state to localStorage under `shipit:preview-viewports`, keyed by
sessionId (per-session scope, still not global):

- `restoreSession(sessionId)` falls back to the mirror when no in-memory
  snapshot exists (a fresh page load), and records the session as
  `activeSessionId` — the key the device actions persist under.
- `setDevicePreset` / `toggleLandscape` / `setCustomSize` write through to the
  mirror for the active session. Returning to the defaults (Responsive,
  portrait, no custom size) deletes the entry rather than remembering a no-op.
- Loaded values are sanitized (localStorage is hand-editable): unknown preset
  ids, non-boolean landscape, out-of-range dimensions, and a "custom" preset
  without dimensions are dropped instead of restored.
- The map is capped at 50 sessions, evicting least-recently-touched entries
  first (writes re-insert at the end), matching `previewPaths`.
- Leaving a preset ("Responsive") resets rotation, since rotation is a
  property of a constrained frame; switching between presets keeps it, so
  comparing devices in landscape works.

### Consistency fixes

- A rotated custom size reports its rotated dimensions in the selector's
  trigger label (the applied preset label holds the portrait pair).
- The custom inputs re-prefill from the applied size on every open (they live
  in a child component that Radix's content unmount remounts; the previous
  inline state kept stale values after a session switch or an apply elsewhere).
- The custom preset is built by `customPresetFor()` in `device-presets.ts`,
  so the selector and the persistence layer cannot drift in shape.

### Verification harness

End-to-end verification without an inner preview (local mode has none):
`harness-server.ts` serves a responsive test page on :8080 that reports its
own `innerWidth/innerHeight`, flips CSS breakpoints, and shows its UA;
`src/client/mobile-preview-harness.html` + `mobile-preview-harness.tsx` mount
the real `PreviewFrame` against that port and seed the store for session
"harness" (reloading the page exercises the persistence restore). The page is
served by the dev Vite server (root is `src/client`, which is why it lives
there rather than in this folder); `vite build` only bundles `index.html`, so
it never reaches the production output. Run:

```bash
npx tsx docs/066-mobile-preview/harness-server.ts   # :8080
# then open /mobile-preview-harness.html through the dev service
```

### Component structure

```
PreviewFrame.tsx (modified)
├── Preview header bar (existing — add device selector)
│   ├── Port indicator (existing)
│   ├── DeviceSelector (new)
│   │   ├── Dropdown trigger: current preset label
│   │   ├── Dropdown menu: grouped presets + custom input
│   │   └── Rotate button (when preset active)
│   ├── Dimension label (new, when preset active)
│   └── Existing controls (errors, auto-fix, reload)
├── Device frame container (new wrapper)
│   ├── Scaled iframe (with explicit width/height when preset active)
│   └── Scale indicator label
└── Error panel (existing)
```

#### New component: `DeviceSelector`

A self-contained dropdown component. Props:

```ts
interface DeviceSelectorProps {
  activePreset: DevicePreset | null;
  isLandscape: boolean;
  onSelectPreset: (preset: DevicePreset | null) => void;
  onToggleLandscape: () => void;
  onCustomSize: (width: number, height: number) => void;
}
```

The dropdown menu structure:

```
┌──────────────────────────┐
│  ✓ Responsive            │
├──────────────────────────┤
│  Phones                  │
│    iPhone SE    375×667  │
│    iPhone 16   393×852   │
│    iPhone 16+  440×956   │
│    Pixel 9     412×916   │
├──────────────────────────┤
│  Tablets                 │
│    iPad Mini   744×1133  │
│    iPad Air    820×1180  │
├──────────────────────────┤
│  Custom                  │
│  [ 393 ] × [ 852 ]      │
└──────────────────────────┘
```

### Scaling logic

When the preview pane is smaller than the chosen device size:

```ts
const containerWidth = containerRef.current.clientWidth;
const containerHeight = containerRef.current.clientHeight;
const deviceWidth = isLandscape ? preset.height : preset.width;
const deviceHeight = isLandscape ? preset.width : preset.height;

const scale = Math.min(
  1,
  (containerWidth - PADDING * 2) / deviceWidth,
  (containerHeight - PADDING * 2) / deviceHeight
);
```

Apply via:
```css
.device-frame {
  width: ${deviceWidth}px;
  height: ${deviceHeight}px;
  transform: scale(${scale});
  transform-origin: top center;
}
```

Use `ResizeObserver` on the container to recalculate scale when the panel is resized via the drag handle.

### Mobile layout (narrow viewport)

When the ShipIt UI itself is on a mobile viewport (`useIsMobile()`), the device selector is still available but defaults to "Responsive" since the preview pane is already phone-sized. The selector remains useful for testing specific breakpoints smaller than the current pane.

## Key files to modify

| File | Changes |
|------|---------|
| `src/client/stores/preview-store.ts` | Device preset state, landscape toggle, custom size, durable per-session localStorage persistence |
| `src/client/components/PreviewFrame.tsx` | Add DeviceSelector, device frame wrapper, scaling logic |
| `src/client/components/DeviceSelector.tsx` | Dropdown with presets, custom inputs, rotated-custom label |
| `src/client/components/device-presets.ts` | Preset data, `customPresetFor()`, custom-size bounds |
| `src/client/components/PreviewFrame/PreviewToolbar.tsx` | Device controls wiring, size + scale indicator |
| `src/client/components/PreviewFrame.test.tsx` | Tests for device sizing, scaling, rotation |
| `src/client/components/DeviceSelector.test.tsx` | Tests for preset selection, custom input, label swap, prefill |
| `src/client/stores/preview-store.test.ts` | Store actions, snapshots, persistence round-trips |
| `src/client/mobile-preview-harness.html` / `.tsx` | End-to-end harness mounting the real PreviewFrame |
| `docs/066-mobile-preview/harness-server.ts` | Responsive test page for the harness |

## Non-goals (v1)

- **User-agent spoofing** — CSS-only viewport simulation; no UA changes.
- **Touch event emulation** — not simulating touch vs mouse.
- **Network throttling** — out of scope for viewport preview.
- **Device chrome/bezel rendering** — keep it minimal; just the viewport with a border.
- **Screenshot/export** — may add later but not in initial implementation.

## Future extensions

- Save custom presets per project.
- Quick-toggle between two sizes (e.g., "phone and desktop" split view).
- Orientation animation transition.
- Shareable device preview links.
