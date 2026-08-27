import { describe, it, expect } from "vitest";
import {
  BUDGET_BANNER_THRESHOLD,
  MEMORY_PRESSURE_BANNER_THRESHOLD,
  MEMORY_PRESSURE_EVICT_THRESHOLD,
  bytesOverBudget,
  isUnderBannerPressure,
  isUnderEvictionPressure,
  memoryUsedFraction,
  resolveMemoryTargets,
} from "./memory-pressure.js";

/** A snapshot as the poller stamps it: raw reading + resolved targets. */
function snapshot(usedGb: number, hostGb: number, budgetMb: number | null) {
  return {
    usedBytes: usedGb * 1024 ** 3,
    totalBytes: hostGb * 1024 ** 3,
    ...resolveMemoryTargets(hostGb * 1024 ** 3, budgetMb),
  };
}

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
  describe("resolveMemoryTargets", () => {
    it("keeps the host fractions when no budget is set (req 9)", () => {
      const t = resolveMemoryTargets(16 * GB, null);
      expect(t.budgetBytes).toBe(16 * GB);
      expect(t.warnAtBytes).toBe(16 * GB * MEMORY_PRESSURE_BANNER_THRESHOLD);
      expect(t.evictAtBytes).toBe(16 * GB * MEMORY_PRESSURE_EVICT_THRESHOLD);
    });

    // reqs 3 and 5 — the user's number is taken literally. Reclaiming at 85% of
    // a 16 GB budget would stop previews with 2.4 GB of the allowance unspent.
    it("reclaims AT an explicit budget, warning before it", () => {
      const t = resolveMemoryTargets(64 * GB, 16 * 1024);
      expect(t.budgetBytes).toBe(16 * GB);
      expect(t.evictAtBytes).toBe(16 * GB);
      expect(t.warnAtBytes).toBe(16 * GB * BUDGET_BANNER_THRESHOLD);
    });

    // req 12 — otherwise a budget larger than the machine would switch the OOM
    // safety net off: usage could never reach it, so nothing would be reclaimed.
    it("clamps a budget larger than the host down to the host", () => {
      expect(resolveMemoryTargets(8 * GB, 64 * 1024).budgetBytes).toBe(8 * GB);
    });

    it("returns zeroes when the host total is unknown", () => {
      expect(resolveMemoryTargets(0, 16 * 1024)).toEqual({ budgetBytes: 0, warnAtBytes: 0, evictAtBytes: 0 });
    });
  });

  it("measures pressure against the budget, not the host (req 12)", () => {
    // 15 GB used on a 64 GB host is nothing; against a 16 GB budget it warns.
    const withBudget = snapshot(15, 64, 16 * 1024);
    expect(memoryUsedFraction(withBudget)).toBeCloseTo(0.9375, 4);
    expect(isUnderBannerPressure(withBudget)).toBe(true);
    expect(isUnderEvictionPressure(withBudget)).toBe(false); // not AT the budget yet

    const noBudget = snapshot(15, 64, null);
    expect(isUnderBannerPressure(noBudget)).toBe(false);
  });

  it("reclaims once usage passes an explicit budget", () => {
    expect(isUnderEvictionPressure(snapshot(16.5, 64, 16 * 1024))).toBe(true);
    expect(bytesOverBudget(snapshot(16.5, 64, 16 * 1024))).toBeCloseTo(0.5 * GB, 0);
  });

  describe("bytesOverBudget", () => {
    it("is 0 while under the evict line", () => {
      expect(bytesOverBudget(snapshot(8, 16, null))).toBe(0);
      expect(bytesOverBudget(null)).toBe(0);
    });

    it("with no budget set, targets 85% of host as before", () => {
      const s = snapshot(16, 16, null);
      expect(bytesOverBudget(s)).toBeCloseTo(16 * GB * (1 - MEMORY_PRESSURE_EVICT_THRESHOLD), 0);
    });
  });

  it("banner fires before reclaim in both regimes (hysteresis)", () => {
    const host = resolveMemoryTargets(16 * GB, null);
    expect(host.warnAtBytes).toBeLessThan(host.evictAtBytes);
    const budget = resolveMemoryTargets(64 * GB, 16 * 1024);
    expect(budget.warnAtBytes).toBeLessThan(budget.evictAtBytes);
  });
});
