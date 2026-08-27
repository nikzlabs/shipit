import { describe, it, expect } from "vitest";
import {
  MEMORY_PRESSURE_BANNER_THRESHOLD,
  MEMORY_PRESSURE_EVICT_THRESHOLD,
  bytesOverBudget,
  effectiveBudgetBytes,
  isUnderEvictionPressure,
  memoryUsedFraction,
} from "./memory-pressure.js";

const GB = 1024 ** 3;

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

  // docs/284 — the budget replaced the container count as the thing reclaim is
  // measured against.
  describe("effectiveBudgetBytes", () => {
    it("falls back to host memory when no budget is set (req 9)", () => {
      expect(effectiveBudgetBytes(16 * GB, null)).toBe(16 * GB);
      expect(effectiveBudgetBytes(16 * GB, undefined)).toBe(16 * GB);
    });

    it("uses the configured budget when it fits inside the host", () => {
      expect(effectiveBudgetBytes(64 * GB, 16 * 1024)).toBe(16 * GB);
    });

    // req 12 — otherwise a budget larger than the machine would switch the OOM
    // safety net off: usage could never reach it, so nothing would be reclaimed.
    it("clamps a budget larger than the host down to the host", () => {
      expect(effectiveBudgetBytes(8 * GB, 64 * 1024)).toBe(8 * GB);
    });

    it("returns 0 when the host total is unknown", () => {
      expect(effectiveBudgetBytes(0, 16 * 1024)).toBe(0);
    });
  });

  it("measures pressure against the budget, not the host (req 12)", () => {
    // 14 GB used on a 64 GB host is nothing; against a 16 GB budget it is 87%.
    const stats = { usedBytes: 14 * GB, totalBytes: 64 * GB, budgetBytes: 16 * GB };
    expect(memoryUsedFraction(stats)).toBeCloseTo(0.875, 3);
    expect(isUnderEvictionPressure(stats)).toBe(true);
    expect(isUnderEvictionPressure({ ...stats, budgetBytes: undefined })).toBe(false);
  });

  describe("bytesOverBudget", () => {
    it("is 0 while under the eviction threshold", () => {
      expect(bytesOverBudget({ usedBytes: 8 * GB, totalBytes: 16 * GB, budgetBytes: 16 * GB })).toBe(0);
      expect(bytesOverBudget(null)).toBe(0);
    });

    // The target is the threshold rather than the budget itself: reclaiming to
    // exactly the eviction line would put the next poll straight back into
    // pressure and the reclaim would oscillate.
    it("targets the eviction threshold, not the budget line", () => {
      const over = bytesOverBudget({ usedBytes: 100, totalBytes: 100, budgetBytes: 100 });
      expect(over).toBeCloseTo(100 - 100 * MEMORY_PRESSURE_EVICT_THRESHOLD, 6);
    });
  });
});
