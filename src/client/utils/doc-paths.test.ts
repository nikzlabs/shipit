import { describe, it, expect } from "vitest";
import {
  dirOf,
  basenameOf,
  siblingsOf,
  orderSiblingsForTabs,
  siblingTabLabel,
  hasTrackedPlanSibling,
  hasTrackedSibling,
  isChecklistPath,
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

describe("isChecklistPath", () => {
  it("returns true only for checklist.md paths", () => {
    expect(isChecklistPath("docs/095-foo/checklist.md")).toBe(true);
    expect(isChecklistPath("docs/095-foo/CHECKLIST.md")).toBe(true);
    expect(isChecklistPath("docs/095-foo/plan.md")).toBe(false);
    expect(isChecklistPath("checklist-notes.md")).toBe(false);
  });
});

describe("siblingsOf", () => {
  const entries: DocEntry[] = [
    { path: "docs/095-foo/plan.md", title: "Plan" },
    { path: "docs/095-foo/checklist.md", title: "Checklist" },
    { path: "docs/095-foo/readme.md", title: "Readme" },
    { path: "docs/096-bar/plan.md", title: "Other plan" },
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
  const entries: DocEntry[] = [
    { path: "docs/095-foo/plan.md", title: "Plan" },
    { path: "docs/095-foo/checklist.md", title: "Checklist" },
    { path: "docs/095-foo/notes.md", title: "Notes" },
    { path: "docs/100-issue/spec.md", title: "Spec", issue: "octo/repo#1" },
    { path: "docs/orphan/notes.md", title: "Notes" },
  ];

  it("treats a feature-directory plan.md as tracked", () => {
    expect(isTracked({ path: "docs/095-foo/plan.md" }, entries)).toBe(true);
  });

  it("treats a checklist.md as tracked", () => {
    expect(isTracked({ path: "docs/095-foo/checklist.md" }, entries)).toBe(true);
  });

  it("treats a doc with an issue pointer as tracked", () => {
    expect(
      isTracked({ path: "docs/100-issue/spec.md", issue: "octo/repo#1" }, entries),
    ).toBe(true);
  });

  it("treats a doc with a checklist.md sibling as tracked", () => {
    expect(isTracked({ path: "docs/095-foo/notes.md" }, entries)).toBe(true);
  });

  it("returns false for an incidental doc with no plan/issue/checklist", () => {
    expect(isTracked({ path: "docs/orphan/notes.md" }, entries)).toBe(false);
  });
});

describe("hasTrackedSibling", () => {
  const entries: DocEntry[] = [
    { path: "docs/095-foo/plan.md", title: "Plan" },
    { path: "docs/095-foo/checklist.md", title: "Checklist" },
    { path: "docs/orphan/notes.md", title: "Orphan notes" },
    { path: "docs/096-bar/plan.md", title: "Other plan" },
    { path: "docs/097-feature/plan.md", title: "X" },
    { path: "docs/097-feature/notes.md", title: "Notes" },
  ];

  it("returns true for checklist with a tracked plan sibling", () => {
    expect(hasTrackedSibling("docs/095-foo/checklist.md", entries)).toBe(true);
  });

  it("returns false when the only entry in the dir is the path itself", () => {
    expect(hasTrackedSibling("docs/orphan/notes.md", entries)).toBe(false);
  });

  it("ignores the entry itself when checking", () => {
    expect(hasTrackedSibling("docs/096-bar/plan.md", entries)).toBe(false);
  });

  it("treats a plan.md sibling as tracked", () => {
    expect(hasTrackedSibling("docs/097-feature/notes.md", entries)).toBe(true);
  });

  it("does not treat root-level files as siblings", () => {
    const rootEntries: DocEntry[] = [
      { path: "a.md", title: "A", issue: "octo/repo#1" },
      { path: "README.md", title: "Root readme" },
    ];
    expect(hasTrackedSibling("README.md", rootEntries)).toBe(false);
  });
});

describe("hasTrackedPlanSibling", () => {
  const entries: DocEntry[] = [
    { path: "docs/095-foo/plan.md", title: "Plan" },
    { path: "docs/095-foo/checklist.md", title: "Checklist" },
    { path: "docs/096-bar/plan.md", title: "Plan" },
    { path: "docs/096-bar/checklist.md", title: "Checklist" },
    { path: "docs/orphan/checklist.md", title: "Orphan checklist" },
    { path: "README.md", title: "Root readme" },
  ];

  it("returns true for a checklist with a plan sibling", () => {
    expect(hasTrackedPlanSibling("docs/095-foo/checklist.md", entries)).toBe(true);
    expect(hasTrackedPlanSibling("docs/096-bar/checklist.md", entries)).toBe(true);
  });

  it("returns false for non-checklist paths", () => {
    expect(hasTrackedPlanSibling("docs/095-foo/plan.md", entries)).toBe(false);
  });

  it("returns false when there is no plan sibling", () => {
    expect(hasTrackedPlanSibling("docs/orphan/checklist.md", entries)).toBe(false);
  });

  it("does not treat root-level files as feature siblings", () => {
    expect(hasTrackedPlanSibling("README.md", entries)).toBe(false);
  });
});
