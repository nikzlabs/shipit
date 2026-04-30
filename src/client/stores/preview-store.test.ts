import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { usePreviewStore } from "./preview-store.js";
import { findPresetById } from "../components/device-presets.js";
import { getSavedDevicePresetId, saveDevicePresetId, DEVICE_PRESET_KEY } from "../utils/local-storage.js";

describe("preview-store device viewport", () => {
  beforeEach(() => {
    localStorage.clear();
    usePreviewStore.getState().reset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("setDevicePreset", () => {
    it("updates the active preset in store state", () => {
      const preset = findPresetById("iphone-14")!;
      usePreviewStore.getState().setDevicePreset(preset);
      expect(usePreviewStore.getState().devicePreset?.id).toBe("iphone-14");
    });

    it("clears the preset when called with null", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-14"));
      usePreviewStore.getState().setDevicePreset(null);
      expect(usePreviewStore.getState().devicePreset).toBeNull();
    });

    it("clears customSize when switching to a non-custom preset", () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-14"));
      expect(usePreviewStore.getState().customSize).toBeNull();
    });
  });

  describe("toggleLandscape", () => {
    it("flips the isLandscape flag", () => {
      expect(usePreviewStore.getState().isLandscape).toBe(false);
      usePreviewStore.getState().toggleLandscape();
      expect(usePreviewStore.getState().isLandscape).toBe(true);
      usePreviewStore.getState().toggleLandscape();
      expect(usePreviewStore.getState().isLandscape).toBe(false);
    });
  });

  describe("setCustomSize", () => {
    it("stores a width/height pair", () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      expect(usePreviewStore.getState().customSize).toEqual({ width: 500, height: 900 });
    });

    it("clears when called with null", () => {
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });
      usePreviewStore.getState().setCustomSize(null);
      expect(usePreviewStore.getState().customSize).toBeNull();
    });
  });

  describe("localStorage persistence", () => {
    it("writes the preset id to localStorage when setDevicePreset is called", () => {
      const preset = findPresetById("ipad-mini")!;
      usePreviewStore.getState().setDevicePreset(preset);
      expect(localStorage.getItem(DEVICE_PRESET_KEY)).toBe("ipad-mini");
    });

    it("removes the preset id from localStorage when set to null", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-14"));
      expect(localStorage.getItem(DEVICE_PRESET_KEY)).toBe("iphone-14");
      usePreviewStore.getState().setDevicePreset(null);
      expect(localStorage.getItem(DEVICE_PRESET_KEY)).toBeNull();
    });

    it("round-trips preset id via getSavedDevicePresetId", () => {
      saveDevicePresetId("pixel-7");
      expect(getSavedDevicePresetId()).toBe("pixel-7");
      saveDevicePresetId(null);
      expect(getSavedDevicePresetId()).toBeNull();
    });

    it("findPresetById resolves a saved id back to the preset object", () => {
      saveDevicePresetId("iphone-14-pro-max");
      const restored = findPresetById(getSavedDevicePresetId());
      expect(restored?.id).toBe("iphone-14-pro-max");
      expect(restored?.width).toBe(430);
      expect(restored?.height).toBe(932);
    });

    it("findPresetById returns null for unknown id", () => {
      expect(findPresetById("nonexistent")).toBeNull();
      expect(findPresetById(null)).toBeNull();
      expect(findPresetById(undefined)).toBeNull();
    });
  });

  describe("reset()", () => {
    it("clears device state and localStorage", () => {
      usePreviewStore.getState().setDevicePreset(findPresetById("iphone-14"));
      usePreviewStore.getState().toggleLandscape();
      usePreviewStore.getState().setCustomSize({ width: 500, height: 900 });

      usePreviewStore.getState().reset();

      expect(usePreviewStore.getState().devicePreset).toBeNull();
      expect(usePreviewStore.getState().isLandscape).toBe(false);
      expect(usePreviewStore.getState().customSize).toBeNull();
      expect(localStorage.getItem(DEVICE_PRESET_KEY)).toBeNull();
    });
  });
});
