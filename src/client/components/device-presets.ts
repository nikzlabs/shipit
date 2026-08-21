/**
 * Device viewport presets for the Mobile Preview feature.
 *
 * The preview pane can constrain the iframe to one of these widths/heights so
 * users can verify responsive layouts without leaving ShipIt.
 */

export type DeviceCategory = "phone" | "tablet" | "custom";

export interface DevicePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  category: DeviceCategory;
}

export const DEVICE_PRESETS: DevicePreset[] = [
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667, category: "phone" },
  { id: "iphone-16", label: "iPhone 16", width: 393, height: 852, category: "phone" },
  { id: "iphone-16-pro-max", label: "iPhone 16 Pro Max", width: 440, height: 956, category: "phone" },
  { id: "pixel-9", label: "Pixel 9", width: 412, height: 916, category: "phone" },
  { id: "ipad-mini", label: "iPad Mini", width: 744, height: 1133, category: "tablet" },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180, category: "tablet" },
];

export function findPresetById(id: string | null | undefined): DevicePreset | null {
  if (!id) return null;
  return DEVICE_PRESETS.find((p) => p.id === id) ?? null;
}

/** Minimum allowed value for a viewport dimension (px). */
export const VIEWPORT_SIZE_MIN = 100;
/** Maximum allowed value for a viewport dimension (px). */
export const VIEWPORT_SIZE_MAX = 2560;

/** Id of the synthetic preset that stands for a freeform size. */
export const CUSTOM_PRESET_ID = "custom";

/** Round to whole pixels and hold inside the allowed range. */
export function clampViewportSize(value: number): number {
  if (!Number.isFinite(value)) return VIEWPORT_SIZE_MIN;
  return Math.min(VIEWPORT_SIZE_MAX, Math.max(VIEWPORT_SIZE_MIN, Math.round(value)));
}

/**
 * The synthetic preset that represents a freeform size — typed into the
 * selector, or reached by dragging a resize handle.
 *
 * The label is the constant "Custom" and NOT the dimensions. The toolbar prints
 * `W×H` immediately to the right of this label, so dimensions here were shown
 * twice; worse, they were the dimensions as *entered*, which a rotate left
 * stale — a rotated 500×900 read "500×900 900×500". A drag would have churned
 * that label on every pointer move as well.
 */
export function customPreset(width: number, height: number): DevicePreset {
  return { id: CUSTOM_PRESET_ID, label: "Custom", width, height, category: "custom" };
}
