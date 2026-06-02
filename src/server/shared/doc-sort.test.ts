import { describe, it, expect } from "vitest";

import { compareDocsByRecency, sortDocsByRecency } from "./doc-sort.js";

/** Sort bare paths newest-first and return them. Convenience for assertions. */
function order(paths: string[]): string[] {
  return [...paths].sort(compareDocsByRecency);
}

describe("compareDocsByRecency", () => {
  describe("numeric feature ordering", () => {
    it("places a higher feature number before a lower one (newest first)", () => {
      expect(
        order([
          "docs/100-a/plan.md",
          "docs/168-b/plan.md",
          "docs/042-c/plan.md",
        ]),
      ).toEqual([
        "docs/168-b/plan.md",
        "docs/100-a/plan.md",
        "docs/042-c/plan.md",
      ]);
    });

    it("compares the prefix numerically, not lexically (99 vs 100)", () => {
      // The whole point of the change: lexical compare puts "100" before "99".
      expect(
        order(["docs/99-old/plan.md", "docs/100-new/plan.md"]),
      ).toEqual(["docs/100-new/plan.md", "docs/99-old/plan.md"]);
    });

    it("orders correctly across the 999 → 1000 boundary", () => {
      expect(
        order(["docs/999-x/plan.md", "docs/1000-y/plan.md"]),
      ).toEqual(["docs/1000-y/plan.md", "docs/999-x/plan.md"]);
    });

    it("treats zero-padded and unpadded numbers by value", () => {
      // "007" and "7" are the same feature number; padding must not change order.
      expect(
        order(["docs/007-a/plan.md", "docs/12-b/plan.md", "docs/9-c/plan.md"]),
      ).toEqual([
        "docs/12-b/plan.md",
        "docs/9-c/plan.md",
        "docs/007-a/plan.md",
      ]);
    });

    it("breaks ties between same-numbered dirs with stable ascending text", () => {
      // Shouldn't happen in practice (numbers are unique) but must be deterministic.
      expect(
        order(["docs/168-zebra/plan.md", "docs/168-alpha/plan.md"]),
      ).toEqual(["docs/168-alpha/plan.md", "docs/168-zebra/plan.md"]);
    });
  });

  describe("numbered vs un-numbered", () => {
    it("floats numbered features above un-numbered prose docs", () => {
      expect(
        order([
          "docs/architecture.md",
          "docs/168-feature/plan.md",
          "docs/glossary.md",
        ]),
      ).toEqual([
        "docs/168-feature/plan.md",
        "docs/architecture.md",
        "docs/glossary.md",
      ]);
    });

    it("does NOT let a high-lexical un-numbered doc jump the newest feature", () => {
      // "zzz" sorts last lexically descending would put it first — guard against it.
      expect(
        order(["docs/zzz-notes.md", "docs/168-feature/plan.md"]),
      ).toEqual(["docs/168-feature/plan.md", "docs/zzz-notes.md"]);
    });

    it("keeps un-numbered docs in ascending A→Z order among themselves", () => {
      expect(
        order(["docs/zulu.md", "docs/alpha.md", "docs/mike.md"]),
      ).toEqual(["docs/alpha.md", "docs/mike.md", "docs/zulu.md"]);
    });
  });

  describe("same-directory siblings", () => {
    it("orders siblings deterministically (ascending by filename)", () => {
      expect(
        order([
          "docs/168-feature/plan.md",
          "docs/168-feature/checklist.md",
        ]),
      ).toEqual([
        "docs/168-feature/checklist.md",
        "docs/168-feature/plan.md",
      ]);
    });

    it("sorts the directory level before the filename level", () => {
      // Newer dir wins even though its file sorts later alphabetically.
      expect(
        order([
          "docs/100-a/zeta.md",
          "docs/168-b/alpha.md",
        ]),
      ).toEqual([
        "docs/168-b/alpha.md",
        "docs/100-a/zeta.md",
      ]);
    });
  });

  describe("path depth", () => {
    it("orders a parent path before its own descendant", () => {
      expect(
        order(["docs/168-x/plan.md", "docs/168-x"]),
      ).toEqual(["docs/168-x", "docs/168-x/plan.md"]);
    });

    it("compares segment-by-segment, not on the joined string", () => {
      // A naive full-string compare could be fooled by separators; ensure the
      // feature number is what drives the result.
      expect(
        order([
          "docs/9-deep/nested/a.md",
          "docs/10-shallow.md",
        ]),
      ).toEqual([
        "docs/10-shallow.md",
        "docs/9-deep/nested/a.md",
      ]);
    });
  });

  describe("comparator contract", () => {
    it("returns 0 for identical paths", () => {
      expect(compareDocsByRecency("docs/1-a/plan.md", "docs/1-a/plan.md")).toBe(0);
    });

    it("is antisymmetric: sign(cmp(a,b)) === -sign(cmp(b,a))", () => {
      const paths = [
        "docs/168-b/plan.md",
        "docs/100-a/plan.md",
        "docs/architecture.md",
        "docs/168-b/checklist.md",
        "README.md",
        "docs/9-c/nested/x.md",
      ];
      for (const a of paths) {
        for (const b of paths) {
          // `|| 0` normalizes -0 → 0 so the self-comparison (both 0) matches.
          expect(Math.sign(compareDocsByRecency(a, b)) || 0).toBe(
            -Math.sign(compareDocsByRecency(b, a)) || 0,
          );
        }
      }
    });

    it("produces a total order stable under input permutation", () => {
      const canonical = order([
        "docs/200-z/plan.md",
        "docs/199-y/plan.md",
        "docs/199-y/checklist.md",
        "docs/architecture.md",
        "README.md",
      ]);
      // Re-sorting a shuffled copy must yield the same order.
      const shuffled = [
        "docs/architecture.md",
        "docs/199-y/checklist.md",
        "README.md",
        "docs/200-z/plan.md",
        "docs/199-y/plan.md",
      ];
      expect(order(shuffled)).toEqual(canonical);
    });
  });

  describe("edge cases", () => {
    it("handles an empty list", () => {
      expect(order([])).toEqual([]);
    });

    it("handles a single element", () => {
      expect(order(["docs/1-a/plan.md"])).toEqual(["docs/1-a/plan.md"]);
    });

    it("handles top-level (no slash) paths", () => {
      expect(order(["README.md", "CHANGELOG.md"])).toEqual([
        "CHANGELOG.md",
        "README.md",
      ]);
    });

    it("handles a number-only segment with no suffix", () => {
      expect(
        order(["docs/3", "docs/10", "docs/2"]),
      ).toEqual(["docs/10", "docs/3", "docs/2"]);
    });

    it("realistic ShipIt docs corpus lands newest-first with prose last", () => {
      expect(
        order([
          "docs/095-runner-ctx-simplification/plan.md",
          "docs/118-shipit-ui-local/plan.md",
          "docs/168-tracker-backed-priorities/plan.md",
          "docs/168-tracker-backed-priorities/checklist.md",
          "docs/116-android-webview-app/plan.md",
          "docs/glossary.md",
        ]),
      ).toEqual([
        "docs/168-tracker-backed-priorities/checklist.md",
        "docs/168-tracker-backed-priorities/plan.md",
        "docs/118-shipit-ui-local/plan.md",
        "docs/116-android-webview-app/plan.md",
        "docs/095-runner-ctx-simplification/plan.md",
        "docs/glossary.md",
      ]);
    });
  });
});

describe("sortDocsByRecency", () => {
  it("orders DocEntry-shaped objects by path and does not mutate the input", () => {
    const input = [
      { path: "docs/100-a/plan.md", title: "A" },
      { path: "docs/168-b/plan.md", title: "B" },
    ];
    const result = sortDocsByRecency(input);
    expect(result.map((d) => d.path)).toEqual([
      "docs/168-b/plan.md",
      "docs/100-a/plan.md",
    ]);
    // Original array order untouched.
    expect(input.map((d) => d.path)).toEqual([
      "docs/100-a/plan.md",
      "docs/168-b/plan.md",
    ]);
  });
});
