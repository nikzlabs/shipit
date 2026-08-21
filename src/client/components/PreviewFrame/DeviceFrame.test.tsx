import { describe, it, expect } from "vitest";
import { DEVICE_PADDING, resolveDeviceViewport } from "./DeviceFrame.js";
import { findPresetById } from "../device-presets.js";

const bigPanel = { containerWidth: 2000, containerHeight: 2000 };

const customPreset = {
  id: "custom",
  label: "500×900",
  width: 500,
  height: 900,
  category: "custom" as const,
};

describe("resolveDeviceViewport", () => {
  it("is inactive with zero dimensions when no preset is selected", () => {
    const m = resolveDeviceViewport({
      devicePreset: null,
      isLandscape: false,
      customSize: null,
      ...bigPanel,
    });
    expect(m.frameActive).toBe(false);
    expect(m.width).toBe(0);
    expect(m.height).toBe(0);
    expect(m.scale).toBe(1);
    expect(m.scalePercent).toBe(100);
  });

  it("resolves a named preset to its portrait dimensions", () => {
    const m = resolveDeviceViewport({
      devicePreset: findPresetById("iphone-16"),
      isLandscape: false,
      customSize: null,
      ...bigPanel,
    });
    expect(m.frameActive).toBe(true);
    expect(m.width).toBe(393);
    expect(m.height).toBe(852);
    expect(m.scale).toBe(1);
  });

  it("swaps width and height when rotated to landscape", () => {
    const m = resolveDeviceViewport({
      devicePreset: findPresetById("iphone-16"),
      isLandscape: true,
      customSize: null,
      ...bigPanel,
    });
    expect(m.width).toBe(852);
    expect(m.height).toBe(393);
  });

  it("uses the stored custom size for a custom preset", () => {
    const m = resolveDeviceViewport({
      devicePreset: customPreset,
      isLandscape: false,
      customSize: { width: 500, height: 900 },
      ...bigPanel,
    });
    expect(m.width).toBe(500);
    expect(m.height).toBe(900);
  });

  it("rotates a custom size too, not just named presets", () => {
    const m = resolveDeviceViewport({
      devicePreset: customPreset,
      isLandscape: true,
      customSize: { width: 500, height: 900 },
      ...bigPanel,
    });
    expect(m.width).toBe(900);
    expect(m.height).toBe(500);
  });

  it("falls back to the preset's own dimensions when a custom preset has no stored size", () => {
    // Possible after a restore of a snapshot written before the custom size was
    // retained: the synthetic preset still carries its dimensions.
    const m = resolveDeviceViewport({
      devicePreset: customPreset,
      isLandscape: false,
      customSize: null,
      ...bigPanel,
    });
    expect(m.width).toBe(500);
    expect(m.height).toBe(900);
  });

  it("scales a device that is taller than the panel, honoring the padding on both axes", () => {
    // iPad Air is 820×1180 in a 400×400 panel: the height axis binds.
    const m = resolveDeviceViewport({
      devicePreset: findPresetById("ipad-air"),
      isLandscape: false,
      customSize: null,
      containerWidth: 400,
      containerHeight: 400,
    });
    const available = 400 - DEVICE_PADDING * 2;
    expect(m.scale).toBeCloseTo(Math.min(1, available / 820, available / 1180), 10);
    expect(m.scale).toBeLessThan(1);
    expect(m.scalePercent).toBe(Math.round(m.scale * 100));
  });

  it("scales a device that is wider than the panel on its own axis", () => {
    // iPhone 16 landscape is 852×393; a 500×800 panel binds on width.
    const m = resolveDeviceViewport({
      devicePreset: findPresetById("iphone-16"),
      isLandscape: true,
      customSize: null,
      containerWidth: 500,
      containerHeight: 800,
    });
    const available = 500 - DEVICE_PADDING * 2;
    expect(m.scale).toBeCloseTo(available / 852, 10);
  });

  it("never scales above 1, whatever the panel size", () => {
    const m = resolveDeviceViewport({
      devicePreset: findPresetById("iphone-se"),
      isLandscape: false,
      customSize: null,
      ...bigPanel,
    });
    expect(m.scale).toBe(1);
    expect(m.scalePercent).toBe(100);
  });

  it("leaves the frame at natural scale until the container is measured", () => {
    const m = resolveDeviceViewport({
      devicePreset: findPresetById("ipad-air"),
      isLandscape: false,
      customSize: null,
      containerWidth: 0,
      containerHeight: 0,
    });
    expect(m.frameActive).toBe(true);
    expect(m.scale).toBe(1);
    expect(m.scalePercent).toBe(100);
  });
});