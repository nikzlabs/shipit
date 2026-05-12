import { describe, it, expect } from "vitest";
import {
  dirOf,
  basenameOf,
  siblingsOf,
  orderSiblingsForTabs,
  siblingTabLabel,
  hasTrackedSibling,
  isTracked,
} from "./doc-paths.js";
import type { DocEntry } from "../../server/shared/types.js";

describe("dirOf", () => {
  it("returns directory with trailing slash", () => {
    expect(dirOf("docs/095-foo/plan.md")).toBe("docs/095-foo/");
  });

  it("returns empty string when no slash", () => {
    expect(dirOf("readme.md")).toBe("");
  });

  it("handles nested paths", () => {
    expect(dirOf("a/b/c/d.md")).toBe("a/b/c/");
  });
});

describe("basenameOf", () => {
  it("returns last segment", () => {
    expect(basenameOf("docs/095-foo/plan.md")).toBe("plan.md");
  });

  it("returns the whole string when no slash", () => {
    expect(basenameOf("readme.md")).toBe("readme.md");
  });
});

describe("siblingsOf", () => {
  const entries: DocEntry[] = [
    { path: "docs/095-foo/plan.md", title: "Plan", status: "in-progress" },
    { path: "docs/095-foo/checklist.md", title: "Checklist" },
    { path: "docs/095-foo/readme.md", title: "Readme" },
    { path: "docs/096-bar/plan.md", title: "Other plan", status: "planned" },
    { path: "README.md", title: "Top readme" },
  ];

  it("returns all entries in the same directory, including the input path", () => {
    const result = siblingsOf("docs/095-foo/plan.md", entries);
    expect(result.map((e) => e.path)).toEqual([
      "docs/095-foo/plan.md",
      "docs/095-foo/checklist.md",
      "docs/095-foo/readme.md",
    ]);
  });

  it("does not match across directories", () => {
    const result = siblingsOf("docs/096-bar/plan.md", entries);
    expect(result.map((e) => e.path)).toEqual(["docs/096-bar/plan.md"]);
  });

  it("matches top-level files", () => {
    const result = siblingsOf("README.md", entries);
    expect(result.map((e) => e.path)).toEqual(["README.md"]);
  });
});

describe("orderSiblingsForTabs", () => {
  it("places plan first, checklist second, then alphabetical", () => {
    const siblings = [
      { path: "docs/x/zeta.md" },
      { path: "docs/x/checklist.md" },
      { path: "docs/x/readme.md" },
      { path: "docs/x/plan.md" },
      { path: "docs/x/alpha.md" },
    ];
    expect(orderSiblingsForTabs(siblings).map((s) => s.path)).toEqual([
      "docs/x/plan.md",
      "docs/x/checklist.md",
      "docs/x/alpha.md",
      "docs/x/readme.md",
      "docs/x/zeta.md",
    ]);
  });

  it("does not mutate input", () => {
    const input = [{ path: "docs/x/checklist.md" }, { path: "docs/x/plan.md" }];
    const before = input.map((s) => s.path);
    orderSiblingsForTabs(input);
    expect(input.map((s) => s.path)).toEqual(before);
  });
});

describe("siblingTabLabel", () => {
  it("capitalizes plan", () => {
    expect(siblingTabLabel("docs/x/plan.md")).toBe("Plan");
  });

  it("capitalizes checklist", () => {
    expect(siblingTabLabel("docs/x/checklist.md")).toBe("Checklist");
  });

  it("capitalizes arbitrary stems", () => {
    expect(siblingTabLabel("docs/x/competitors.md")).toBe("Competitors");
  });
});

describe("isTracked", () => {
  it("returns true for entries with a known status", () => {
    expect(isTracked({ status: "planned" })).toBe(true);
    expect(isTracked({ status: "in-progress" })).toBe(true);
    expect(isTracked({ status: "done" })).toBe(true);
    expect(isTracked({ status: "paused" })).toBe(true);
  });

  it("returns true for entries with a custom status", () => {
    expect(isTracked({ customStatus: "experimental" })).toBe(true);
    expect(isTracked({ customStatus: "blocked" })).toBe(true);
  });

  it("returns false when neither status nor customStatus is set", () => {
    expect(isTracked({})).toBe(false);
  });
});

describe("hasTrackedSibling", () => {
  const entries: DocEntry[] = [
    { path: "docs/095-foo/plan.md", title: "Plan", status: "in-progress" },
    { path: "docs/095-foo/checklist.md", title: "Checklist" },
    { path: "docs/orphan/checklist.md", title: "Orphan checklist" },
    { path: "docs/096-bar/plan.md", title: "Other plan", status: "planned" },
    { path: "docs/097-experimental/plan.md", title: "X", customStatus: "experimental" },
    { path: "docs/097-experimental/notes.md", title: "Notes" },
  ];

  it("returns true for checklist with a tracked plan sibling", () => {
    expect(hasTrackedSibling("docs/095-foo/checklist.md", entries)).toBe(true);
  });

  it("returns false for checklist with no tracked sibling", () => {
    expect(hasTrackedSibling("docs/orphan/checklist.md", entries)).toBe(false);
  });

  it("ignores the entry itself when checking", () => {
    expect(hasTrackedSibling("docs/095-foo/plan.md", entries)).toBe(false);
  });

  it("treats a custom-status sibling as tracked", () => {
    expect(hasTrackedSibling("docs/097-experimental/notes.md", entries)).toBe(true);
  });

  it("does not treat root-level files as siblings", () => {
    const rootEntries: DocEntry[] = [
      { path: "a.md", title: "A", status: "in-progress" },
      { path: "README.md", title: "Root readme" },
    ];
    expect(hasTrackedSibling("README.md", rootEntries)).toBe(false);
  });
});
