import { describe, it, expect } from "vitest";
import {
  MEMORY_PRESSURE_BANNER_THRESHOLD,
  MEMORY_PRESSURE_EVICT_THRESHOLD,
  isUnderEvictionPressure,
  memoryUsedFraction,
} from "./memory-pressure.js";

describe("memory-pressure", () => {
  describe("memoryUsedFraction", () => {
    it("returns null when stats are missing", () => {
      expect(memoryUsedFraction(null)).toBeNull();
    });

    it("returns null when totalBytes is zero (avoids divide-by-zero)", () => {
      expect(memoryUsedFraction({ usedBytes: 1024, totalBytes: 0 })).toBeNull();
    });

    it("returns the used/total fraction", () => {
      expect(memoryUsedFraction({ usedBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 })).toBe(0.5);
    });
  });

  describe("isUnderEvictionPressure", () => {
    it("is false when stats are unavailable", () => {
      expect(isUnderEvictionPressure(null)).toBe(false);
    });

    it("is false below the eviction threshold", () => {
      expect(isUnderEvictionPressure({
        usedBytes: 0.84 * 16 * 1024 ** 3,
        totalBytes: 16 * 1024 ** 3,
      })).toBe(false);
    });

    it("is true at or above the eviction threshold", () => {
      expect(isUnderEvictionPressure({
        usedBytes: MEMORY_PRESSURE_EVICT_THRESHOLD * 16 * 1024 ** 3,
        totalBytes: 16 * 1024 ** 3,
      })).toBe(true);
      expect(isUnderEvictionPressure({
        usedBytes: 0.95 * 16 * 1024 ** 3,
        totalBytes: 16 * 1024 ** 3,
      })).toBe(true);
    });
  });

  it("banner threshold sits below eviction threshold (hysteresis)", () => {
    expect(MEMORY_PRESSURE_BANNER_THRESHOLD).toBeLessThan(MEMORY_PRESSURE_EVICT_THRESHOLD);
  });
});
