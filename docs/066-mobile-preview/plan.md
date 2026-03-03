---
status: planned
---
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
| iPhone 14 | 390 | 844 | phone |
| iPhone 14 Pro Max | 430 | 932 | phone |
| Pixel 7 | 412 | 915 | phone |
| iPad Mini | 768 | 1024 | tablet |
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

Below the iframe (or in the header), show the active dimensions: `390 × 844` so the user always knows the exact viewport.

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

// New state fields
devicePreset: DevicePreset | null;     // null = responsive (fill panel)
isLandscape: boolean;                   // swap width/height when true
customSize: { width: number; height: number } | null;

// Actions
setDevicePreset: (preset: DevicePreset | null) => void;
toggleLandscape: () => void;
setCustomSize: (size: { width: number; height: number } | null) => void;
```

Persist the selected device preset ID in `localStorage` under `shipit:devicePreset` so it survives page reloads.

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
│    iPhone 14   390×844   │
│    iPhone 14+  430×932   │
│    Pixel 7     412×915   │
├──────────────────────────┤
│  Tablets                 │
│    iPad Mini   768×1024  │
│    iPad Air    820×1180  │
├──────────────────────────┤
│  Custom                  │
│  [ 390 ] × [ 844 ]      │
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
| `src/client/stores/preview-store.ts` | Add device preset state, landscape toggle, custom size |
| `src/client/components/PreviewFrame.tsx` | Add DeviceSelector, device frame wrapper, scaling logic |
| `src/client/components/DeviceSelector.tsx` | New component — dropdown with presets |
| `src/client/components/PreviewFrame.test.tsx` | Tests for device sizing, scaling, rotation |
| `src/client/components/DeviceSelector.test.tsx` | Tests for preset selection, custom input |

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
