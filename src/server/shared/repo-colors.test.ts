import { describe, it, expect } from "vitest";
import {
  REPO_COLOR_COUNT,
  REPO_COLOR_NAMES,
  isValidRepoColorIndex,
  pickRepoColorIndex,
  repoColorVar,
} from "./repo-colors.js";

describe("repo-colors", () => {
  it("names every palette entry", () => {
    expect(REPO_COLOR_NAMES).toHaveLength(REPO_COLOR_COUNT);
    expect(new Set(REPO_COLOR_NAMES).size).toBe(REPO_COLOR_COUNT);
  });

  // docs/254 req 8 — "big enough that a user with many repos rarely sees a
  // repeat". A shrink below this is a product regression, not a refactor.
  it("offers at least 16 colors", () => {
    expect(REPO_COLOR_COUNT).toBeGreaterThanOrEqual(16);
  });

  describe("isValidRepoColorIndex", () => {
    it("accepts in-range integers", () => {
      expect(isValidRepoColorIndex(0)).toBe(true);
      expect(isValidRepoColorIndex(REPO_COLOR_COUNT - 1)).toBe(true);
    });

    it("rejects out-of-range, fractional, and non-numeric values", () => {
      expect(isValidRepoColorIndex(-1)).toBe(false);
      expect(isValidRepoColorIndex(REPO_COLOR_COUNT)).toBe(false);
      expect(isValidRepoColorIndex(1.5)).toBe(false);
      expect(isValidRepoColorIndex(null)).toBe(false);
      expect(isValidRepoColorIndex(undefined)).toBe(false);
      expect(isValidRepoColorIndex("3")).toBe(false);
      expect(isValidRepoColorIndex(NaN)).toBe(false);
    });
  });

  describe("pickRepoColorIndex", () => {
    it("starts at 0 for the first repo", () => {
      expect(pickRepoColorIndex([])).toBe(0);
    });

    // req 5 — no two repos share a color while unused colors remain.
    it("never repeats while free colors remain", () => {
      const taken: number[] = [];
      for (let i = 0; i < REPO_COLOR_COUNT; i++) {
        const next = pickRepoColorIndex(taken);
        expect(taken).not.toContain(next);
        taken.push(next);
      }
      expect(new Set(taken).size).toBe(REPO_COLOR_COUNT);
    });

    // Lowest-free, not round-robin: removing a repo frees its slot for the next
    // add rather than shifting everyone along.
    it("reuses a freed slot rather than advancing", () => {
      expect(pickRepoColorIndex([0, 2, 3])).toBe(1);
    });

    it("wraps to the least-used color once the palette is exhausted", () => {
      const all = Array.from({ length: REPO_COLOR_COUNT }, (_, i) => i);
      // Every color used once, plus a second use of 0 — so 0 is now the only
      // index with two holders and must not be the next pick.
      expect(pickRepoColorIndex([...all, 0])).toBe(1);
    });

    it("ignores garbage in the taken list", () => {
      // A row written before the backfill migration has NULL -> filtered out by
      // the caller, but the picker must not be destabilised if one slips in.
      expect(pickRepoColorIndex([0, -5, 999, 1.5] as number[])).toBe(1);
    });
  });

  describe("repoColorVar", () => {
    it("maps an index to its custom property", () => {
      expect(repoColorVar(0)).toBe("var(--repo-color-0)");
      expect(repoColorVar(REPO_COLOR_COUNT - 1)).toBe(`var(--repo-color-${REPO_COLOR_COUNT - 1})`);
    });

    // Never emit `var(--repo-color-99)`, which resolves to nothing and renders
    // an invisible edge — fall back to a real color instead.
    it("falls back to a real color for an invalid index", () => {
      expect(repoColorVar(999)).toBe("var(--repo-color-0)");
      expect(repoColorVar(-1)).toBe("var(--repo-color-0)");
    });
  });
});
