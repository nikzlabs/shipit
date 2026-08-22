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

/** Minimum allowed value for a custom viewport dimension (px). */
export const CUSTOM_SIZE_MIN = 100;
/** Maximum allowed value for a custom viewport dimension (px). */
export const CUSTOM_SIZE_MAX = 2560;

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

/**
 * The synthetic preset for a freeform custom size. One builder for every
 * place a custom preset is constructed (the selector's Apply, and viewport
 * persistence on restore), so the shape can't drift between them.
 */
export function customPresetFor(size: { width: number; height: number }): DevicePreset {
  return {
    id: "custom",
    label: `${size.width}×${size.height}`,
    width: size.width,
    height: size.height,
    category: "custom",
  };
}
