# Mobile Preview — Checklist

## Store & data layer

- [ ] Define `DevicePreset` interface and `DEVICE_PRESETS` constant array (presets table from plan)
- [ ] Add `devicePreset`, `isLandscape`, `customSize` state to `preview-store.ts`
- [ ] Add `setDevicePreset`, `toggleLandscape`, `setCustomSize` actions
- [ ] Persist selected preset ID to `localStorage` (`shipit:devicePreset`), restore on load
- [ ] Add `reset()` handling — clear device state on session reset

## DeviceSelector component

- [ ] Create `src/client/components/DeviceSelector.tsx`
- [ ] Dropdown trigger showing current preset label (or "Responsive")
- [ ] Dropdown menu grouped by category: Responsive, Phones, Tablets, Custom
- [ ] Show dimensions next to each preset label (e.g., `375 × 667`)
- [ ] Checkmark on active preset
- [ ] Custom size inputs — two number fields with `×` separator
- [ ] Validate custom size inputs (min 100, max 2560)
- [ ] Rotate button — visible only when a fixed-size preset is active
- [ ] Close dropdown on outside click and Escape key
- [ ] Keyboard navigation within dropdown (arrow keys, Enter)

## PreviewFrame changes

- [ ] Import and render `DeviceSelector` in preview header bar (after port indicator)
- [ ] Show dimension label in header when a fixed preset is active (e.g., `390 × 844`)
- [ ] Wrap iframe in device frame container `div`
- [ ] When preset active: set explicit `width`/`height` on iframe, center in container
- [ ] When preset active: change container background to `bg-gray-800`
- [ ] Add subtle border/outline around constrained iframe
- [ ] Implement scale-to-fit: `transform: scale()` when device size exceeds panel
- [ ] Use `ResizeObserver` to recalculate scale on panel resize
- [ ] Show scale percentage label when scale < 100% (e.g., "67%")
- [ ] When "Responsive" selected: iframe fills panel as before (no regression)

## Tests

- [ ] `DeviceSelector.test.tsx` — renders with "Responsive" default
- [ ] `DeviceSelector.test.tsx` — selecting a preset calls `onSelectPreset`
- [ ] `DeviceSelector.test.tsx` — rotate button swaps orientation
- [ ] `DeviceSelector.test.tsx` — custom size inputs call `onCustomSize`
- [ ] `DeviceSelector.test.tsx` — dropdown closes on outside click
- [ ] `PreviewFrame.test.tsx` — iframe has explicit dimensions when preset active
- [ ] `PreviewFrame.test.tsx` — iframe fills container when "Responsive"
- [ ] `PreviewFrame.test.tsx` — scale factor computed correctly for small container
- [ ] Store tests — `setDevicePreset`, `toggleLandscape`, `setCustomSize` update state
- [ ] Store tests — localStorage persistence round-trips correctly
