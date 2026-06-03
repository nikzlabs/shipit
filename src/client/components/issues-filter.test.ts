import { describe, it, expect } from "vitest";
import {
  UNASSIGNED,
  activeFilterCount,
  anyFilterActive,
  distinctAssignees,
  distinctStatuses,
  filterIssues,
  type IssueFilters,
} from "./issues-filter.js";
import type { IssuePriorityLevel, TrackerIssue } from "../../server/shared/types.js";

function makeIssue(overrides?: Partial<TrackerIssue>): TrackerIssue {
  return {
    id: overrides?.id ?? "i1",
    identifier: overrides?.identifier ?? "SHI-1",
    title: overrides?.title ?? "Do the thing",
    url: overrides?.url ?? "https://linear.app/x/SHI-1",
    priority: overrides?.priority ?? { level: "urgent", sortOrder: 0, label: "Urgent" },
    status: "status" in (overrides ?? {}) ? overrides!.status : { name: "In Progress" },
    assignee: "assignee" in (overrides ?? {}) ? overrides!.assignee : { name: "Nik" },
    description: overrides?.description,
  };
}

function emptyFilters(over?: Partial<IssueFilters>): IssueFilters {
  return {
    query: "",
    priorities: new Set<IssuePriorityLevel>(),
    statuses: new Set<string>(),
    assignees: new Set<string>(),
    ...over,
  };
}

describe("filterIssues", () => {
  const issues = [
    makeIssue({ id: "1", identifier: "SHI-1", title: "Auth bug", priority: { level: "urgent", sortOrder: 0, label: "Urgent" }, status: { name: "In Progress" }, assignee: { name: "Nik" } }),
    makeIssue({ id: "2", identifier: "SHI-2", title: "Add dark mode", priority: { level: "high", sortOrder: 1, label: "High" }, status: { name: "Todo" }, assignee: { name: "Ana" } }),
    makeIssue({ id: "3", identifier: "SHI-3", title: "Refactor store", priority: { level: "low", sortOrder: 3, label: "Low" }, status: { name: "Todo" }, assignee: undefined }),
  ];

  it("returns everything when no filter is active", () => {
    expect(filterIssues(issues, emptyFilters())).toHaveLength(3);
  });

  it("OR within the priority facet", () => {
    const result = filterIssues(issues, emptyFilters({ priorities: new Set(["urgent", "high"]) }));
    expect(result.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("OR within the status facet", () => {
    const result = filterIssues(issues, emptyFilters({ statuses: new Set(["Todo"]) }));
    expect(result.map((i) => i.id)).toEqual(["2", "3"]);
  });

  it("AND across facets", () => {
    const result = filterIssues(
      issues,
      emptyFilters({ priorities: new Set(["high"]), statuses: new Set(["Todo"]) }),
    );
    expect(result.map((i) => i.id)).toEqual(["2"]);
  });

  it("matches the Unassigned bucket", () => {
    const result = filterIssues(issues, emptyFilters({ assignees: new Set([UNASSIGNED]) }));
    expect(result.map((i) => i.id)).toEqual(["3"]);
  });

  it("combines a real assignee with Unassigned (OR within facet)", () => {
    const result = filterIssues(issues, emptyFilters({ assignees: new Set(["Nik", UNASSIGNED]) }));
    expect(result.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("case-insensitive search over identifier, title and description", () => {
    expect(filterIssues(issues, emptyFilters({ query: "shi-2" })).map((i) => i.id)).toEqual(["2"]);
    expect(filterIssues(issues, emptyFilters({ query: "DARK" })).map((i) => i.id)).toEqual(["2"]);

    const withDesc = [makeIssue({ id: "9", title: "Nothing here", description: "hidden keyword inside" })];
    expect(filterIssues(withDesc, emptyFilters({ query: "keyword" })).map((i) => i.id)).toEqual(["9"]);
  });

  it("excludes statusless issues when a status facet is active", () => {
    const statusless = [makeIssue({ id: "x", status: undefined })];
    expect(filterIssues(statusless, emptyFilters({ statuses: new Set(["Todo"]) }))).toHaveLength(0);
  });
});

describe("distinctStatuses", () => {
  it("derives distinct names with counts, sorted by count then name", () => {
    const issues = [
      makeIssue({ id: "1", status: { name: "Todo" } }),
      makeIssue({ id: "2", status: { name: "Todo" } }),
      makeIssue({ id: "3", status: { name: "In Progress" } }),
      makeIssue({ id: "4", status: undefined }),
    ];
    expect(distinctStatuses(issues)).toEqual([
      { name: "Todo", count: 2 },
      { name: "In Progress", count: 1 },
    ]);
  });

  it("returns an empty list when nothing carries a status", () => {
    expect(distinctStatuses([makeIssue({ status: undefined })])).toEqual([]);
  });
});

describe("distinctAssignees", () => {
  it("derives assignees with counts plus a synthetic Unassigned bucket last", () => {
    const issues = [
      makeIssue({ id: "1", assignee: { name: "Nik", avatarUrl: "http://x/nik.png" } }),
      makeIssue({ id: "2", assignee: { name: "Nik" } }),
      makeIssue({ id: "3", assignee: { name: "Ana" } }),
      makeIssue({ id: "4", assignee: undefined }),
    ];
    const result = distinctAssignees(issues);
    expect(result).toEqual([
      { value: "Nik", label: "Nik", avatarUrl: "http://x/nik.png", count: 2 },
      { value: "Ana", label: "Ana", avatarUrl: undefined, count: 1 },
      { value: UNASSIGNED, label: "Unassigned", count: 1 },
    ]);
  });

  it("omits the Unassigned bucket when every issue has an assignee", () => {
    const result = distinctAssignees([makeIssue({ assignee: { name: "Nik" } })]);
    expect(result.some((o) => o.value === UNASSIGNED)).toBe(false);
  });
});

describe("anyFilterActive / activeFilterCount", () => {
  it("is false for empty filters", () => {
    expect(anyFilterActive(emptyFilters())).toBe(false);
    expect(activeFilterCount(emptyFilters())).toBe(0);
  });

  it("counts a whitespace-only query as inactive", () => {
    expect(anyFilterActive(emptyFilters({ query: "   " }))).toBe(false);
  });

  it("counts each selection plus a search tick", () => {
    const filters = emptyFilters({
      query: "bug",
      priorities: new Set(["urgent", "high"]),
      statuses: new Set(["Todo"]),
    });
    expect(anyFilterActive(filters)).toBe(true);
    expect(activeFilterCount(filters)).toBe(4); // 1 search + 2 priorities + 1 status
  });
});
