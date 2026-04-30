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
  { id: "iphone-14", label: "iPhone 14", width: 390, height: 844, category: "phone" },
  { id: "iphone-14-pro-max", label: "iPhone 14 Pro Max", width: 430, height: 932, category: "phone" },
  { id: "pixel-7", label: "Pixel 7", width: 412, height: 915, category: "phone" },
  { id: "ipad-mini", label: "iPad Mini", width: 768, height: 1024, category: "tablet" },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180, category: "tablet" },
];

export function findPresetById(id: string | null | undefined): DevicePreset | null {
  if (!id) return null;
  return DEVICE_PRESETS.find((p) => p.id === id) ?? null;
}
