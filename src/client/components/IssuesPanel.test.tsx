import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IssuesPanel } from "./IssuesPanel.js";
import { useIssuesStore } from "../stores/issues-store.js";
import { UNASSIGNED } from "./issues-filter.js";
import type { TrackerIssue } from "../../server/shared/types.js";

function makeIssue(over: Partial<TrackerIssue> & { id: string }): TrackerIssue {
  return {
    identifier: over.id,
    title: over.title ?? "title",
    url: "https://linear.app/x",
    priority: over.priority ?? { level: "urgent", sortOrder: 0, label: "Urgent" },
    status: "status" in over ? over.status : { name: "Todo" },
    assignee: "assignee" in over ? over.assignee : { name: "Nik" },
    ...over,
  };
}

afterEach(() => {
  cleanup();
  useIssuesStore.getState().reset();
  useIssuesStore.setState({ trackers: [], activeTracker: "linear", infoByTracker: {} });
});

describe("IssuesPanel", () => {
  // Regression for React error #185 (Maximum update depth exceeded): selecting
  // `issuesByTracker[active] ?? []` with a fresh `[]` literal made
  // useSyncExternalStore see a new snapshot every render and loop forever — the
  // exact state on tab open, before the first fetch populates the store.
  it("renders with an empty store without an infinite render loop", () => {
    expect(() =>
      render(
        <MemoryRouter>
          <IssuesPanel onStartSession={() => {}} onConnect={() => {}} />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });

  it("renders when the active tracker has no issues entry yet", () => {
    useIssuesStore.setState({
      trackers: [{ id: "linear", label: "Linear", configured: true }],
      activeTracker: "linear",
      infoByTracker: { linear: { id: "linear", label: "Linear", configured: true } },
    });
    expect(() =>
      render(
        <MemoryRouter>
          <IssuesPanel onStartSession={() => {}} onConnect={() => {}} />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });

  // Stable-reference regression with filters active: derived arrays
  // (filteredIssues, distinct statuses/assignees) must be memoized, not freshly
  // computed each render, or the panel loops into React #185.
  it("renders without a loop when filters are active", () => {
    useIssuesStore.setState({
      trackers: [{ id: "linear", label: "Linear", configured: true }],
      activeTracker: "linear",
      infoByTracker: { linear: { id: "linear", label: "Linear", configured: true } },
      issuesByTracker: {
        linear: [makeIssue({ id: "SHI-1", title: "Auth bug", status: { name: "Todo" } })],
      },
    });
    useIssuesStore.getState().togglePriority("urgent");
    useIssuesStore.getState().setQuery("bug");
    expect(() =>
      render(
        <MemoryRouter>
          <IssuesPanel onStartSession={() => {}} onConnect={() => {}} />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });
});

describe("issues-store filter pruning", () => {
  afterEach(() => {
    useIssuesStore.getState().reset();
    useIssuesStore.setState({ trackers: [], activeTracker: "linear", infoByTracker: {} });
  });

  it("prunes stale statuses/assignees on tracker switch but keeps query, priorities and Unassigned", () => {
    useIssuesStore.setState({
      activeTracker: "linear",
      issuesByTracker: {
        linear: [makeIssue({ id: "SHI-1", status: { name: "In Review" }, assignee: { name: "Ana" } })],
        github: [makeIssue({ id: "gh-1", status: { name: "Open" }, assignee: undefined })],
      },
    });
    const store = useIssuesStore.getState();
    store.setQuery("auth");
    store.togglePriority("high");
    store.toggleStatus("In Review"); // exists on linear, not github
    store.toggleAssignee("Ana"); // exists on linear, not github
    store.toggleAssignee(UNASSIGNED); // synthetic — must always survive

    useIssuesStore.getState().setActiveTracker("github");

    const { filters } = useIssuesStore.getState();
    expect(filters.query).toBe("auth"); // universal — persists
    expect([...filters.priorities]).toEqual(["high"]); // universal — persists
    expect([...filters.statuses]).toEqual([]); // "In Review" not in github list — pruned
    expect(filters.assignees.has("Ana")).toBe(false); // pruned
    expect(filters.assignees.has(UNASSIGNED)).toBe(true); // synthetic — survives
  });
});
