import { describe, it, expect } from "vitest";
import type { TrackerIssue } from "../../server/shared/types.js";
import {
  DEFAULT_SORT_PREFS,
  buildIssueTree,
  buildSections,
  compareIssues,
  describeSort,
  flattenTree,
  groupRoots,
  isNonDefaultSort,
  type SortPrefs,
} from "./issues-sort.js";

/** Minimal issue factory — only the fields the sort/tree logic reads. */
function issue(partial: Partial<TrackerIssue> & { id: string; identifier: string }): TrackerIssue {
  return {
    title: partial.identifier,
    url: `https://example/${partial.identifier}`,
    priority: { level: "none", sortOrder: 4, label: "No priority" },
    ...partial,
  };
}

const PRI = {
  urgent: { level: "urgent" as const, sortOrder: 0, label: "Urgent" },
  high: { level: "high" as const, sortOrder: 1, label: "High" },
  medium: { level: "medium" as const, sortOrder: 2, label: "Medium" },
  low: { level: "low" as const, sortOrder: 3, label: "Low" },
  none: { level: "none" as const, sortOrder: 4, label: "No priority" },
};

function prefs(p: Partial<SortPrefs>): SortPrefs {
  return { ...DEFAULT_SORT_PREFS, ...p };
}

describe("compareIssues", () => {
  it("sorts by primary key ascending", () => {
    const a = issue({ id: "a", identifier: "T-1", priority: PRI.low });
    const b = issue({ id: "b", identifier: "T-2", priority: PRI.urgent });
    const sorted = [a, b].sort((x, y) => compareIssues(x, y, prefs({ primary: "priority", secondary: "none" })));
    expect(sorted.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("respects descending direction", () => {
    const a = issue({ id: "a", identifier: "T-1", priority: PRI.low });
    const b = issue({ id: "b", identifier: "T-2", priority: PRI.urgent });
    const sorted = [a, b].sort((x, y) =>
      compareIssues(x, y, prefs({ primary: "priority", primaryDir: -1, secondary: "none" })),
    );
    expect(sorted.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("breaks ties with the secondary key", () => {
    // Same priority; secondary = status (started < completed by rank).
    const a = issue({ id: "a", identifier: "T-1", priority: PRI.high, status: { name: "Done", type: "completed" } });
    const b = issue({ id: "b", identifier: "T-2", priority: PRI.high, status: { name: "In Progress", type: "started" } });
    const sorted = [a, b].sort((x, y) =>
      compareIssues(x, y, prefs({ primary: "priority", secondary: "status" })),
    );
    expect(sorted.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("falls back to the identifier tiebreak (numeric-aware)", () => {
    const a = issue({ id: "a", identifier: "T-10", priority: PRI.high });
    const b = issue({ id: "b", identifier: "T-2", priority: PRI.high });
    const sorted = [a, b].sort((x, y) => compareIssues(x, y, prefs({ primary: "priority", secondary: "none" })));
    // "T-2" before "T-10" thanks to numeric collation, not lexical.
    expect(sorted.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("sorts unassigned last when sorting by assignee ascending", () => {
    const a = issue({ id: "a", identifier: "T-1" }); // unassigned
    const b = issue({ id: "b", identifier: "T-2", assignee: { name: "Ava" } });
    const sorted = [a, b].sort((x, y) => compareIssues(x, y, prefs({ primary: "assignee", secondary: "none" })));
    expect(sorted.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("'Last updated' ascending puts the most recent first", () => {
    const a = issue({ id: "a", identifier: "T-1", updatedAt: "2026-01-01T00:00:00Z" });
    const b = issue({ id: "b", identifier: "T-2", updatedAt: "2026-06-01T00:00:00Z" });
    const sorted = [a, b].sort((x, y) => compareIssues(x, y, prefs({ primary: "updated", secondary: "none" })));
    expect(sorted.map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("buildIssueTree", () => {
  it("nests children under their parent, sorted within the parent", () => {
    const parent = issue({ id: "p", identifier: "T-1", priority: PRI.high });
    const childA = issue({ id: "ca", identifier: "T-3", parentId: "p", priority: PRI.low });
    const childB = issue({ id: "cb", identifier: "T-2", parentId: "p", priority: PRI.urgent });
    const tree = buildIssueTree([parent, childA, childB], prefs({ primary: "priority", secondary: "none" }));
    expect(tree).toHaveLength(1);
    expect(tree[0].issue.id).toBe("p");
    // Children sorted by priority within the parent: urgent (cb) before low (ca).
    expect(tree[0].children.map((c) => c.issue.id)).toEqual(["cb", "ca"]);
    expect(tree[0].children[0].depth).toBe(1);
  });

  it("keeps a high-priority child from reordering the top level", () => {
    const p1 = issue({ id: "p1", identifier: "T-1", priority: PRI.low });
    const p2 = issue({ id: "p2", identifier: "T-2", priority: PRI.medium });
    const urgentChild = issue({ id: "c", identifier: "T-3", parentId: "p1", priority: PRI.urgent });
    const tree = buildIssueTree([p1, p2, urgentChild], prefs({ primary: "priority", secondary: "none" }));
    // Top level ordered by the PARENTS only — p1(low) still sorts after p2(medium)?
    // low=3 > medium=2, so p2 first. The urgent child does NOT lift p1.
    expect(tree.map((n) => n.issue.id)).toEqual(["p2", "p1"]);
  });

  it("recurses to arbitrary depth", () => {
    const a = issue({ id: "a", identifier: "T-1" });
    const b = issue({ id: "b", identifier: "T-2", parentId: "a" });
    const c = issue({ id: "c", identifier: "T-3", parentId: "b" });
    const d = issue({ id: "d", identifier: "T-4", parentId: "c" });
    const tree = buildIssueTree([a, b, c, d], DEFAULT_SORT_PREFS);
    expect(tree[0].children[0].children[0].children[0].issue.id).toBe("d");
    expect(tree[0].children[0].children[0].children[0].depth).toBe(3);
  });

  it("promotes an orphan whose parent is absent, flagging it", () => {
    const orphan = issue({ id: "o", identifier: "T-9", parentId: "missing", parentIdentifier: "T-1" });
    const tree = buildIssueTree([orphan], DEFAULT_SORT_PREFS);
    expect(tree).toHaveLength(1);
    expect(tree[0].issue.id).toBe("o");
    expect(tree[0].orphan).toBe(true);
    expect(tree[0].depth).toBe(0);
  });

  it("does not recurse forever on a parentId cycle", () => {
    const a = issue({ id: "a", identifier: "T-1", parentId: "b" });
    const b = issue({ id: "b", identifier: "T-2", parentId: "a" });
    // Both reference each other; neither is a 'true' root, but the build must terminate.
    const tree = buildIssueTree([a, b], DEFAULT_SORT_PREFS);
    expect(tree.length).toBeGreaterThan(0);
  });
});

describe("flattenTree", () => {
  const parent = issue({ id: "p", identifier: "T-1" });
  const child = issue({ id: "c", identifier: "T-2", parentId: "p" });

  it("includes children when expanded", () => {
    const tree = buildIssueTree([parent, child], DEFAULT_SORT_PREFS);
    const rows = flattenTree(tree, new Set());
    expect(rows.map((r) => r.issue.id)).toEqual(["p", "c"]);
    expect(rows[0].hasChildren).toBe(true);
    expect(rows[0].collapsed).toBe(false);
  });

  it("omits a collapsed parent's subtree but keeps the parent", () => {
    const tree = buildIssueTree([parent, child], DEFAULT_SORT_PREFS);
    const rows = flattenTree(tree, new Set(["p"]));
    expect(rows.map((r) => r.issue.id)).toEqual(["p"]);
    expect(rows[0].collapsed).toBe(true);
  });
});

describe("groupRoots + buildSections", () => {
  it("groups top-level issues by status in workflow order", () => {
    const todo = issue({ id: "t", identifier: "T-1", status: { name: "Todo", type: "unstarted" } });
    const done = issue({ id: "d", identifier: "T-2", status: { name: "Done", type: "completed" } });
    const tree = buildIssueTree([done, todo], DEFAULT_SORT_PREFS);
    const groups = groupRoots(tree, "status");
    expect(groups.map((g) => g.label)).toEqual(["Todo", "Done"]);
  });

  it("buildSections returns one label-less section when ungrouped", () => {
    const a = issue({ id: "a", identifier: "T-1" });
    const sections = buildSections([a], prefs({ group: "none" }), new Set());
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBeNull();
  });

  it("buildSections keeps a child nested inside its parent's section", () => {
    const parent = issue({ id: "p", identifier: "T-1", status: { name: "Todo", type: "unstarted" } });
    const child = issue({ id: "c", identifier: "T-2", parentId: "p", status: { name: "Done", type: "completed" } });
    const sections = buildSections([parent, child], prefs({ group: "status" }), new Set());
    // One section (Todo, the parent's status); the child rides along nested, not
    // hoisted into a separate "Done" section.
    expect(sections.map((s) => s.label)).toEqual(["Todo"]);
    expect(sections[0].rows.map((r) => r.issue.id)).toEqual(["p", "c"]);
  });
});

describe("describeSort + isNonDefaultSort", () => {
  it("flags non-default prefs", () => {
    expect(isNonDefaultSort(DEFAULT_SORT_PREFS)).toBe(false);
    expect(isNonDefaultSort(prefs({ primary: "title" }))).toBe(true);
  });

  it("describes the active order", () => {
    expect(describeSort(prefs({ primary: "priority", secondary: "status" }))).toBe("Priority ↑ → Status ↑");
    expect(describeSort(prefs({ primary: "title", secondary: "none", group: "assignee" }))).toBe(
      "Title ↑  ·  grouped by Assignee",
    );
  });
});
