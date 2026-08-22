# Remember the preview viewport choice — Checklist

## Store

- [x] Move `CUSTOM_SIZE_MIN`/`CUSTOM_SIZE_MAX` into `device-presets.ts`; re-export from `DeviceSelector`
- [x] Add `customPreset(width, height)` helper; use it in `PreviewToolbar`
- [x] Load `shipit:preview-viewport` once at store creation (defensive parse, req 3)
- [x] Persist the viewport triple from `setDevicePreset`, `toggleLandscape`, `setCustomSize` (req 1)

## Tests

- [x] Store: picked preset survives a simulated reload (fresh store, same localStorage)
- [x] Store: custom size + landscape survive a simulated reload
- [x] Store: Responsive survives a simulated reload
- [x] Store: malformed JSON, unknown preset id, out-of-range custom dims all fall back to Responsive
- [x] Toolbar: applying a custom size still produces the exact active preset object

## Verification

- [x] Real-browser check in the running product: preset, custom size, orientation and Responsive each survive a page reload
