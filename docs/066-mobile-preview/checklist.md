# Mobile Preview — Checklist

## Store & data layer

- [x] Define `DevicePreset` interface and `DEVICE_PRESETS` constant array (presets table from plan)
- [x] Add `devicePreset`, `isLandscape`, `customSize` state to `preview-store.ts`
- [x] Add `setDevicePreset`, `toggleLandscape`, `setCustomSize` actions
- [x] Persist selected viewport state in the per-session preview snapshot, restore on session switch
- [x] Add `reset()` handling — clear device state on session reset

## DeviceSelector component

- [x] Create `src/client/components/DeviceSelector.tsx`
- [x] Dropdown trigger showing current preset label (or "Responsive")
- [x] Dropdown menu grouped by category: Responsive, Phones, Tablets, Custom
- [x] Show dimensions next to each preset label (e.g., `375 × 667`)
- [x] Checkmark on active preset
- [x] Custom size inputs — two number fields with `×` separator
- [x] Validate custom size inputs (min 100, max 2560)
- [x] Rotate button — visible only when a fixed-size preset is active
- [x] Close dropdown on outside click and Escape key (provided by Radix `DropdownMenu`)
- [x] Keyboard navigation within dropdown (arrow keys, Enter) (provided by Radix `DropdownMenu`)

## PreviewFrame changes

- [x] Import and render `DeviceSelector` in preview header bar (after port indicator)
- [x] Show dimension label in header when a fixed preset is active (e.g., `390 × 844`)
- [x] Wrap iframe in device frame container `div`
- [x] When preset active: set explicit `width`/`height` on iframe, center in container
- [x] When preset active: change container background to `bg-gray-800` (using `--color-bg-tertiary` token)
- [x] Add subtle border/outline around constrained iframe
- [x] Implement scale-to-fit: `transform: scale()` when device size exceeds panel
- [x] Use `ResizeObserver` to recalculate scale on panel resize
- [x] Show scale percentage label when scale < 100% (e.g., "67%")
- [x] When "Responsive" selected: iframe fills panel as before (no regression)

## Tests

- [x] `DeviceSelector.test.tsx` — renders with "Responsive" default
- [x] `DeviceSelector.test.tsx` — selecting a preset calls `onSelectPreset`
- [x] `DeviceSelector.test.tsx` — rotate button swaps orientation
- [x] `DeviceSelector.test.tsx` — custom size inputs call `onCustomSize`
- [x] `DeviceSelector.test.tsx` — dropdown closes on outside click (and Escape)
- [x] `PreviewFrame.test.tsx` — iframe has explicit dimensions when preset active
- [x] `PreviewFrame.test.tsx` — iframe fills container when "Responsive"
- [x] `PreviewFrame.test.tsx` — scale factor computed correctly for small container
- [x] Store tests — `setDevicePreset`, `toggleLandscape`, `setCustomSize` update state
- [x] Store tests — per-session viewport snapshot round-trips correctly
