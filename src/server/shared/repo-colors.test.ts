import { describe, it, expect } from "vitest";
import {
  REPO_COLOR_ASSIGNMENT_ORDER,
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

  it("assigns from a permutation of the whole palette", () => {
    expect(REPO_COLOR_ASSIGNMENT_ORDER).toHaveLength(REPO_COLOR_COUNT);
    expect(new Set(REPO_COLOR_ASSIGNMENT_ORDER).size).toBe(REPO_COLOR_COUNT);
    for (const i of REPO_COLOR_ASSIGNMENT_ORDER) expect(isValidRepoColorIndex(i)).toBe(true);
  });

  describe("pickRepoColorIndex", () => {
    it("starts the first repo at the head of the assignment order", () => {
      expect(pickRepoColorIndex([])).toBe(REPO_COLOR_ASSIGNMENT_ORDER[0]);
    });

    it("hands out colors in assignment order, not palette order", () => {
      const taken: number[] = [];
      for (let i = 0; i < 4; i++) taken.push(pickRepoColorIndex(taken));
      expect(taken).toEqual(REPO_COLOR_ASSIGNMENT_ORDER.slice(0, 4));
    });

    it("never repeats while free colors remain", () => {
      const taken: number[] = [];
      for (let i = 0; i < REPO_COLOR_COUNT; i++) {
        const next = pickRepoColorIndex(taken);
        expect(taken).not.toContain(next);
        taken.push(next);
      }
      expect(new Set(taken).size).toBe(REPO_COLOR_COUNT);
    });

    it("reuses a freed slot rather than advancing", () => {
      const [first, second, third] = REPO_COLOR_ASSIGNMENT_ORDER;
      expect(pickRepoColorIndex([first, third])).toBe(second);
    });

    it("wraps to the least-used color once the palette is exhausted", () => {
      const all = Array.from({ length: REPO_COLOR_COUNT }, (_, i) => i);
      const [first, second] = REPO_COLOR_ASSIGNMENT_ORDER;
      expect(pickRepoColorIndex(all)).toBe(first);
      expect(pickRepoColorIndex([...all, first])).toBe(second);
    });

    it("ignores garbage in the taken list", () => {
      const [first, second] = REPO_COLOR_ASSIGNMENT_ORDER;
      expect(pickRepoColorIndex([first, -5, 999, 1.5] as number[])).toBe(second);
    });
  });

  describe("repoColorVar", () => {
    it("maps an index to its custom property", () => {
      expect(repoColorVar(0)).toBe("var(--repo-color-0)");
      expect(repoColorVar(REPO_COLOR_COUNT - 1)).toBe(`var(--repo-color-${REPO_COLOR_COUNT - 1})`);
    });

    it("falls back to a real color for an invalid index", () => {
      expect(repoColorVar(999)).toBe("var(--repo-color-0)");
      expect(repoColorVar(-1)).toBe("var(--repo-color-0)");
    });
  });
});
