import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { IssuesViewer, type IssuesViewerProps } from "./IssuesViewer.js";
import {
  distinctAssignees,
  distinctStatuses,
  filterIssues,
  type IssueFilters,
} from "./issues-filter.js";
import type { IssuePriorityLevel, TrackerInfo, TrackerIssue } from "../../server/shared/types.js";

const LINEAR_CONFIGURED: TrackerInfo = {
  id: "linear",
  label: "Linear",
  configured: true,
  binding: { key: "SHI", name: "ShipIt" },
};

const LINEAR_UNCONFIGURED: TrackerInfo = { id: "linear", label: "Linear", configured: false };

function makeIssue(overrides?: Partial<TrackerIssue>): TrackerIssue {
  return {
    id: "i1",
    identifier: "SHI-1",
    title: "Do the thing",
    url: "https://linear.app/x/SHI-1",
    priority: { level: "urgent", sortOrder: 0, label: "Urgent" },
    status: { name: "In Progress" },
    assignee: { name: "Nik" },
    ...overrides,
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

function priorityCounts(issues: TrackerIssue[]): Record<IssuePriorityLevel, number> {
  const counts: Record<IssuePriorityLevel, number> = { urgent: 0, high: 0, medium: 0, low: 0, none: 0 };
  for (const i of issues) counts[i.priority.level] += 1;
  return counts;
}

function defaultProps(overrides?: Partial<IssuesViewerProps>): IssuesViewerProps {
  const issues = overrides?.issues ?? [];
  const filters = overrides?.filters ?? emptyFilters();
  const base: IssuesViewerProps = {
    trackers: [LINEAR_CONFIGURED],
    activeTracker: "linear",
    issues,
    filteredIssues: filterIssues(issues, filters),
    filters,
    statusOptions: distinctStatuses(issues),
    assigneeOptions: distinctAssignees(issues),
    priorityCounts: priorityCounts(issues),
    info: LINEAR_CONFIGURED,
    loading: false,
    error: null,
    canStart: true,
    includeDone: false,
    onSelectTracker: vi.fn(),
    onRefresh: vi.fn(),
    onToggleIncludeDone: vi.fn(),
    onStartSession: vi.fn(),
    onConnect: vi.fn(),
    onSetQuery: vi.fn(),
    onTogglePriority: vi.fn(),
    onToggleStatus: vi.fn(),
    onToggleAssignee: vi.fn(),
    onClearFilters: vi.fn(),
  };
  // `filteredIssues` derives from issues+filters unless explicitly overridden.
  return { ...base, ...overrides, filteredIssues: overrides?.filteredIssues ?? base.filteredIssues };
}

describe("IssuesViewer", () => {
  afterEach(cleanup);

  it("shows a Connect empty state when the tracker is unconfigured", () => {
    const props = defaultProps({ trackers: [LINEAR_UNCONFIGURED], info: LINEAR_UNCONFIGURED });
    render(<IssuesViewer {...props} />);
    const connect = screen.getByRole("button", { name: /Connect Linear/i });
    fireEvent.click(connect);
    expect(props.onConnect).toHaveBeenCalledOnce();
  });

  it("renders the priority-sorted issue list passed in", () => {
    const props = defaultProps({
      issues: [
        makeIssue({ id: "i1", identifier: "SHI-1", title: "Urgent thing" }),
        makeIssue({ id: "i2", identifier: "SHI-2", title: "Low thing", priority: { level: "low", sortOrder: 3, label: "Low" } }),
      ],
    });
    render(<IssuesViewer {...props} />);
    expect(screen.getByText("Urgent thing")).toBeInTheDocument();
    expect(screen.getByText("Low thing")).toBeInTheDocument();
    expect(screen.getByText("SHI-1")).toBeInTheDocument();
    // Priority badge for urgent renders its label.
    expect(screen.getByText("Urgent")).toBeInTheDocument();
  });

  it("strips the repo path from GitHub identifiers in the ID column", () => {
    const props = defaultProps({
      issues: [makeIssue({ identifier: "nicolasalt/shipit#1047", title: "Self-updater" })],
    });
    render(<IssuesViewer {...props} />);
    // The narrow ID column shows the compact `#1047`, not the full repo path.
    expect(screen.getByText("#1047")).toBeInTheDocument();
    expect(screen.queryByText("nicolasalt/shipit#1047")).not.toBeInTheDocument();
    // The full identifier survives in the tracker-link tooltip.
    expect(
      screen.getByTitle("Open nicolasalt/shipit#1047 in the tracker"),
    ).toBeInTheDocument();
  });

  it("fires onStartSession for the clicked issue", () => {
    const issue = makeIssue();
    const props = defaultProps({ issues: [issue] });
    render(<IssuesViewer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Start session/i }));
    expect(props.onStartSession).toHaveBeenCalledWith(issue);
  });

  it("disables Start session when no repo is available", () => {
    const props = defaultProps({ issues: [makeIssue()], canStart: false });
    render(<IssuesViewer {...props} />);
    expect(screen.getByRole("button", { name: /Start session/i })).toBeDisabled();
  });

  it("renders one sub-tab per configured tracker and switches on click", () => {
    const props = defaultProps();
    render(<IssuesViewer {...props} />);
    // The sub-tab carries the bound team key ("Linear · SHI").
    const tab = screen.getByRole("button", { name: /Linear/i });
    fireEvent.click(tab);
    expect(props.onSelectTracker).toHaveBeenCalledWith("linear");
  });

  it("shows an empty-but-connected message when there are no open issues", () => {
    const props = defaultProps({ issues: [] });
    render(<IssuesViewer {...props} />);
    expect(screen.getByText(/No open issues/i)).toBeInTheDocument();
  });

  it("surfaces an error banner", () => {
    const props = defaultProps({ error: "Linear is down" });
    render(<IssuesViewer {...props} />);
    expect(screen.getByText("Linear is down")).toBeInTheDocument();
  });

  it("toggles the Show done control and reflects includeDone state", () => {
    const props = defaultProps({ issues: [makeIssue()] });
    render(<IssuesViewer {...props} />);
    const toggle = screen.getByRole("button", { name: /Show done/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(props.onToggleIncludeDone).toHaveBeenCalledOnce();
  });

  it("drops 'open' from the empty-state copy when includeDone is on", () => {
    const props = defaultProps({ issues: [], includeDone: true });
    render(<IssuesViewer {...props} />);
    expect(screen.getByText(/No issues in/i)).toBeInTheDocument();
    expect(screen.queryByText(/No open issues/i)).not.toBeInTheDocument();
  });

  // ---- docs/173: filters & search ----

  it("renders the filter bar with the three facets once issues are loaded", () => {
    const props = defaultProps({ issues: [makeIssue()] });
    render(<IssuesViewer {...props} />);
    // Desktop + mobile each render a trigger, hence getAllByText.
    expect(screen.getAllByText("Priority").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Status").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Assignee").length).toBeGreaterThan(0);
    expect(screen.getAllByPlaceholderText("Search issues…").length).toBeGreaterThan(0);
  });

  it("hides the filter bar entirely when there are no issues", () => {
    const props = defaultProps({ issues: [] });
    render(<IssuesViewer {...props} />);
    expect(screen.queryByPlaceholderText("Search issues…")).not.toBeInTheDocument();
  });

  it("shows a plain count with no filter and 'N of M' when filtered", () => {
    const issues = [
      makeIssue({ id: "1", identifier: "SHI-1", priority: { level: "urgent", sortOrder: 0, label: "Urgent" } }),
      makeIssue({ id: "2", identifier: "SHI-2", priority: { level: "low", sortOrder: 3, label: "Low" } }),
    ];
    const plain = defaultProps({ issues });
    const { rerender } = render(<IssuesViewer {...plain} />);
    expect(screen.getByTestId("issue-count").textContent).toContain("2 issues");

    const filters = emptyFilters({ priorities: new Set<IssuePriorityLevel>(["urgent"]) });
    const filtered = defaultProps({ issues, filters });
    rerender(<IssuesViewer {...filtered} />);
    const count = screen.getByTestId("issue-count").textContent ?? "";
    expect(count).toContain("1");
    expect(count).toContain("of 2");
  });

  it("shows the empty-filtered state with a Clear filters button", () => {
    const issues = [makeIssue({ priority: { level: "urgent", sortOrder: 0, label: "Urgent" } })];
    const filters = emptyFilters({ query: "no-match-zzz" });
    const props = defaultProps({ issues, filters });
    render(<IssuesViewer {...props} />);
    expect(screen.getByText(/No issues match your filters/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Clear filters/i }));
    expect(props.onClearFilters).toHaveBeenCalledOnce();
  });

  it("opens the status facet and toggles a status", () => {
    const issues = [makeIssue({ status: { name: "In Progress" } })];
    const props = defaultProps({ issues });
    render(<IssuesViewer {...props} />);
    // Open the desktop Priority/Status popover by clicking the first Status trigger.
    fireEvent.click(screen.getAllByText("Status")[0]);
    const option = screen.getByRole("menuitemcheckbox", { name: /In Progress/i });
    fireEvent.click(option);
    expect(props.onToggleStatus).toHaveBeenCalledWith("In Progress");
  });
});
