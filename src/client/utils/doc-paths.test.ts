import { describe, it, expect } from "vitest";
import {
  dirOf,
  basenameOf,
  siblingsOf,
  orderSiblingsForTabs,
  siblingTabLabel,
  buildDocIndex,
  hasTrackedPlanSiblingIn,
  hasTrackedSiblingIn,
  isChecklistPath,
  isTrackedIn,
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

describe("isTrackedIn", () => {
  const entries: DocEntry[] = [
    { path: "docs/095-foo/plan.md", title: "Plan" },
    { path: "docs/095-foo/checklist.md", title: "Checklist" },
    { path: "docs/095-foo/notes.md", title: "Notes" },
    { path: "docs/100-issue/spec.md", title: "Spec", issue: "octo/repo#1" },
    { path: "docs/orphan/notes.md", title: "Notes" },
  ];

  it("treats a feature-directory plan.md as tracked", () => {
    expect(isTrackedIn(buildDocIndex(entries), { path: "docs/095-foo/plan.md" })).toBe(true);
  });

  it("treats a checklist.md as tracked", () => {
    expect(isTrackedIn(buildDocIndex(entries), { path: "docs/095-foo/checklist.md" })).toBe(true);
  });

  it("treats a doc with an issue pointer as tracked", () => {
    expect(
      isTrackedIn(buildDocIndex(entries), { path: "docs/100-issue/spec.md", issue: "octo/repo#1" }),
    ).toBe(true);
  });

  it("treats a doc with a checklist.md sibling as tracked", () => {
    expect(isTrackedIn(buildDocIndex(entries), { path: "docs/095-foo/notes.md" })).toBe(true);
  });

  it("returns false for an incidental doc with no plan/issue/checklist", () => {
    expect(isTrackedIn(buildDocIndex(entries), { path: "docs/orphan/notes.md" })).toBe(false);
  });
});

describe("hasTrackedSiblingIn", () => {
  const entries: DocEntry[] = [
    { path: "docs/095-foo/plan.md", title: "Plan" },
    { path: "docs/095-foo/checklist.md", title: "Checklist" },
    { path: "docs/orphan/notes.md", title: "Orphan notes" },
    { path: "docs/096-bar/plan.md", title: "Other plan" },
    { path: "docs/097-feature/plan.md", title: "X" },
    { path: "docs/097-feature/notes.md", title: "Notes" },
  ];

  it("returns true for checklist with a tracked plan sibling", () => {
    expect(hasTrackedSiblingIn(buildDocIndex(entries), "docs/095-foo/checklist.md")).toBe(true);
  });

  it("returns false when the only entry in the dir is the path itself", () => {
    expect(hasTrackedSiblingIn(buildDocIndex(entries), "docs/orphan/notes.md")).toBe(false);
  });

  it("ignores the entry itself when checking", () => {
    expect(hasTrackedSiblingIn(buildDocIndex(entries), "docs/096-bar/plan.md")).toBe(false);
  });

  it("treats a plan.md sibling as tracked", () => {
    expect(hasTrackedSiblingIn(buildDocIndex(entries), "docs/097-feature/notes.md")).toBe(true);
  });

  it("does not treat root-level files as siblings", () => {
    const rootEntries: DocEntry[] = [
      { path: "a.md", title: "A", issue: "octo/repo#1" },
      { path: "README.md", title: "Root readme" },
    ];
    expect(hasTrackedSiblingIn(buildDocIndex(rootEntries), "README.md")).toBe(false);
  });
});

describe("hasTrackedPlanSiblingIn", () => {
  const entries: DocEntry[] = [
    { path: "docs/095-foo/plan.md", title: "Plan" },
    { path: "docs/095-foo/checklist.md", title: "Checklist" },
    { path: "docs/096-bar/plan.md", title: "Plan" },
    { path: "docs/096-bar/checklist.md", title: "Checklist" },
    { path: "docs/orphan/checklist.md", title: "Orphan checklist" },
    { path: "README.md", title: "Root readme" },
  ];

  it("returns true for a checklist with a plan sibling", () => {
    expect(hasTrackedPlanSiblingIn(buildDocIndex(entries), "docs/095-foo/checklist.md")).toBe(true);
    expect(hasTrackedPlanSiblingIn(buildDocIndex(entries), "docs/096-bar/checklist.md")).toBe(true);
  });

  it("returns false for non-checklist paths", () => {
    expect(hasTrackedPlanSiblingIn(buildDocIndex(entries), "docs/095-foo/plan.md")).toBe(false);
  });

  it("returns false when there is no plan sibling", () => {
    expect(hasTrackedPlanSiblingIn(buildDocIndex(entries), "docs/orphan/checklist.md")).toBe(false);
  });

  it("does not treat root-level files as feature siblings", () => {
    expect(hasTrackedPlanSiblingIn(buildDocIndex(entries), "README.md")).toBe(false);
  });
});

/**
 * A repeated path must not become its own sibling.
 *
 * `hasTrackedSiblingIn` answers from a per-directory count minus one for the
 * doc itself, where the scan it replaced excluded *every* entry matching the
 * queried path. Those agree only while paths are unique, so the index counts
 * each tracked path once rather than each entry. `listDocs` emits one entry per
 * file on disk, so this guards the utility's contract for any array, not a
 * state production can reach — which is exactly why it needs a test rather than
 * a reader noticing.
 */
describe("buildDocIndex with a repeated path", () => {
  it("does not let a duplicate entry make a doc its own tracked sibling", () => {
    const entries: DocEntry[] = [
      { path: "docs/095-foo/plan.md", title: "Plan" },
      { path: "docs/095-foo/plan.md", title: "Plan" },
    ];
    expect(hasTrackedSiblingIn(buildDocIndex(entries), "docs/095-foo/plan.md")).toBe(false);
  });

  it("still sees a genuinely different tracked sibling alongside a duplicate", () => {
    const entries: DocEntry[] = [
      { path: "docs/095-foo/plan.md", title: "Plan" },
      { path: "docs/095-foo/plan.md", title: "Plan" },
      { path: "docs/095-foo/checklist.md", title: "Checklist" },
    ];
    expect(hasTrackedSiblingIn(buildDocIndex(entries), "docs/095-foo/plan.md")).toBe(true);
  });
});

/**
 * The grouping `DocsViewer` runs in its render body, over a doc list the size of
 * a real repository's.
 *
 * This is a **cost** guard, and it is here because the cost was the bug. The
 * predicates used to take the doc list and answer by scanning it, and
 * `hasTrackedSibling` scanned it once per candidate sibling (it called
 * `isTracked` — itself a scan — before the cheap same-directory test), so
 * grouping n docs of which u are untracked was O(u²·n). Measured in Chrome on
 * this repository's list (n = 866, u = 96): 342–486 ms, paid on every render of
 * a component that re-renders with its parent — i.e. once per streamed token
 * while the Docs tab was open. Indexed, the same grouping is ~3 ms.
 *
 * The budget is deliberately far above what a correct implementation needs and
 * far below what the quadratic one costs, so neither CI load nor a fast machine
 * can decide the result. On the shape below the pre-fix implementation takes
 * seconds; the indexed one takes single-digit milliseconds.
 */
describe("grouping cost over a repository-sized doc list", () => {
  /** ~1,000 docs: feature dirs that are tracked, plus loose markdown that is not. */
  function repoSizedList(): DocEntry[] {
    const entries: DocEntry[] = [];
    for (let i = 0; i < 250; i++) {
      entries.push({ path: `docs/${i}-feature/plan.md`, title: "Plan" });
      entries.push({ path: `docs/${i}-feature/checklist.md`, title: "Checklist" });
    }
    // The expensive half: docs that are NOT tracked and have no tracked
    // sibling, so every "is there a tracked sibling?" question ran to the end
    // of the list instead of short-circuiting.
    for (let i = 0; i < 500; i++) {
      entries.push({ path: `notes/${i}/README.md`, title: "Readme" });
    }
    return entries;
  }

  it("groups the whole list without scanning it per doc", () => {
    const files = repoSizedList();

    const started = performance.now();
    const index = buildDocIndex(files);
    const tracked = files.filter(
      (f) => isTrackedIn(index, f) && !hasTrackedPlanSiblingIn(index, f.path),
    );
    const untracked = files.filter(
      (f) =>
        !isTrackedIn(index, f) &&
        !hasTrackedSiblingIn(index, f.path) &&
        !hasTrackedPlanSiblingIn(index, f.path),
    );
    const elapsed = performance.now() - started;

    // Grouped correctly: each feature dir contributes its plan (its checklist
    // is suppressed by the plan sibling), and every loose README is untracked.
    expect(tracked).toHaveLength(250);
    expect(untracked).toHaveLength(500);
    expect(elapsed).toBeLessThan(500);
  });
});
