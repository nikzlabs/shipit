import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IssuesViewer, type IssuesViewerProps } from "./IssuesViewer.js";
import {
  distinctAssignees,
  distinctLabels,
  distinctStatuses,
  filterIssues,
  type IssueFilters,
} from "./issues-filter.js";
import { DEFAULT_SORT_PREFS, buildSections, collapsePredicate } from "./issues-sort.js";
import type { IssuePriorityLevel, TrackerInfo, TrackerIssue } from "../../server/shared/types.js";

// Force the container-width signal so we can exercise both layouts deterministically
// (jsdom has no layout, so the real ResizeObserver path always reads 0/desktop).
// Defaults to wide/desktop; individual tests flip `mockNarrow.value` to true.
const mockNarrow = vi.hoisted(() => ({ value: false }));
vi.mock("../hooks/useNarrowContainer.js", () => ({ useNarrowContainer: () => mockNarrow.value }));

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
    labels: new Set<string>(),
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
  const filtered = filterIssues(issues, filters);
  const base: IssuesViewerProps = {
    trackers: [LINEAR_CONFIGURED],
    activeTracker: "linear",
    issues,
    filteredIssues: filtered,
    desktopSections: buildSections(filtered, DEFAULT_SORT_PREFS, collapsePredicate({}, false)),
    mobileSections: buildSections(filtered, DEFAULT_SORT_PREFS, collapsePredicate({}, true)),
    sortPrefs: DEFAULT_SORT_PREFS,
    filters,
    statusOptions: distinctStatuses(issues),
    assigneeOptions: distinctAssignees(issues),
    labelOptions: distinctLabels(issues),
    priorityCounts: priorityCounts(issues),
    info: LINEAR_CONFIGURED,
    loading: false,
    error: null,
    canStart: true,
    includeDone: false,
    availableStatuses: [],
    canEditPriority: true,
    onSelectTracker: vi.fn(),
    onRefresh: vi.fn(),
    onToggleIncludeDone: vi.fn(),
    onSetSortPrefs: vi.fn(),
    onSetCollapsed: vi.fn(),
    onOpenIssue: vi.fn(),
    initialScrollTop: 0,
    onPersistScroll: vi.fn(),
    onSetStatus: vi.fn(async () => null),
    onSetPriority: vi.fn(async () => null),
    onStartSession: vi.fn(),
    onConnect: vi.fn(),
    onSetQuery: vi.fn(),
    onTogglePriority: vi.fn(),
    onToggleStatus: vi.fn(),
    onToggleAssignee: vi.fn(),
    onToggleLabel: vi.fn(),
    onClearFilters: vi.fn(),
  };
  // `filteredIssues` derives from issues+filters unless explicitly overridden;
  // the section sets follow whichever filtered list wins so rows render to match.
  const finalFiltered = overrides?.filteredIssues ?? base.filteredIssues;
  const finalPrefs = overrides?.sortPrefs ?? DEFAULT_SORT_PREFS;
  return {
    ...base,
    ...overrides,
    filteredIssues: finalFiltered,
    desktopSections: overrides?.desktopSections ?? buildSections(finalFiltered, finalPrefs, collapsePredicate({}, false)),
    mobileSections: overrides?.mobileSections ?? buildSections(finalFiltered, finalPrefs, collapsePredicate({}, true)),
  };
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

  it("renders sub-issues nested under their parent with a disclosure + count (docs/206)", () => {
    const props = defaultProps({
      issues: [
        makeIssue({ id: "p", identifier: "SHI-1", title: "Parent task" }),
        makeIssue({ id: "c", identifier: "SHI-2", title: "Child task", parentId: "p" }),
      ],
    });
    render(<IssuesViewer {...props} />);
    expect(screen.getByText("Parent task")).toBeInTheDocument();
    expect(screen.getByText("Child task")).toBeInTheDocument();
    // The parent carries a collapse control (only parents do).
    expect(screen.getByRole("button", { name: /Collapse SHI-1/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Collapse SHI-2/ })).toBeNull();
  });

  it("toggling a parent's disclosure records an explicit collapse (docs/206)", () => {
    const props = defaultProps({
      issues: [
        makeIssue({ id: "p", identifier: "SHI-1", title: "Parent" }),
        makeIssue({ id: "c", identifier: "SHI-2", title: "Child", parentId: "p" }),
      ],
    });
    render(<IssuesViewer {...props} />);
    // Default (desktop/wide) is expanded, so the disclosure collapses it.
    fireEvent.click(screen.getByRole("button", { name: /Collapse SHI-1/ }));
    expect(props.onSetCollapsed).toHaveBeenCalledWith("p", true);
    // The disclosure's stopPropagation keeps the row from also opening detail.
    expect(props.onOpenIssue).not.toHaveBeenCalled();
  });

  it("on the narrow card layout, collapses parents by default with a 'N nested issues' toggle (docs/206)", () => {
    mockNarrow.value = true;
    try {
      const props = defaultProps({
        issues: [
          makeIssue({ id: "p", identifier: "SHI-1", title: "Parent" }),
          makeIssue({ id: "c", identifier: "SHI-2", title: "Child", parentId: "p" }),
        ],
      });
      render(<IssuesViewer {...props} />);
      // Parent shows; the child is folded away behind the collapsed default.
      expect(screen.getByText("Parent")).toBeInTheDocument();
      expect(screen.queryByText("Child")).toBeNull();
      // Tapping the nested-issues row expands it (records an explicit expand).
      fireEvent.click(screen.getByRole("button", { name: /Show 1 nested issue in SHI-1/ }));
      expect(props.onSetCollapsed).toHaveBeenCalledWith("p", false);
    } finally {
      mockNarrow.value = false;
    }
  });

  it("flags an orphaned sub-issue whose parent is absent (docs/206)", () => {
    const props = defaultProps({
      issues: [makeIssue({ id: "o", identifier: "SHI-9", title: "Orphan", parentId: "gone", parentIdentifier: "SHI-1" })],
    });
    render(<IssuesViewer {...props} />);
    // Promoted to the top level with a hint at the missing parent.
    expect(screen.getByText("Orphan")).toBeInTheDocument();
    expect(screen.getByText("SHI-1")).toBeInTheDocument();
  });

  it("opens the sort & group modal from the sliders button (docs/206)", async () => {
    const user = userEvent.setup();
    const props = defaultProps({ issues: [makeIssue({})] });
    render(<IssuesViewer {...props} />);
    await user.click(screen.getByRole("button", { name: /Sort and group issues/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText("Primary sort key")).toBeInTheDocument();
    expect(screen.getByLabelText("Group by field")).toBeInTheDocument();
  });

  it("strips the repo path from GitHub identifiers in the ID column", () => {
    const props = defaultProps({
      issues: [makeIssue({ identifier: "nicolasalt/shipit#1047", title: "Self-updater" })],
    });
    render(<IssuesViewer {...props} />);
    // The narrow ID column shows the bare issue number, not the full repo path.
    expect(screen.getByText("1047")).toBeInTheDocument();
    expect(screen.queryByText("nicolasalt/shipit#1047")).not.toBeInTheDocument();
    // The row no longer links out to the tracker (docs/189) — the deep link
    // now lives only inside the inline detail view.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("opens the inline detail view when a row is clicked (docs/189)", () => {
    const issue = makeIssue({ title: "Openable" });
    const props = defaultProps({ issues: [issue] });
    render(<IssuesViewer {...props} />);
    fireEvent.click(screen.getByText("Openable"));
    expect(props.onOpenIssue).toHaveBeenCalledWith(issue);
  });

  it("edits a row's priority inline without opening the detail view (docs/191)", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ priority: { level: "low", sortOrder: 3, label: "Low" } });
    const props = defaultProps({ issues: [issue], canEditPriority: true });
    render(<IssuesViewer {...props} />);
    await user.click(screen.getByLabelText(/Change priority of SHI-1/));
    await user.click(screen.getByRole("menuitem", { name: "Urgent" }));
    expect(props.onSetPriority).toHaveBeenCalledWith(issue, "urgent");
    // The editor's stopPropagation keeps the row click from also firing.
    expect(props.onOpenIssue).not.toHaveBeenCalled();
  });

  it("edits a row's status inline from the tracker's statuses (docs/191)", async () => {
    const user = userEvent.setup();
    const issue = makeIssue({ status: { name: "Todo", type: "unstarted" } });
    const props = defaultProps({
      issues: [issue],
      availableStatuses: [
        { name: "Todo", type: "unstarted" },
        { name: "Done", type: "completed" },
      ],
    });
    render(<IssuesViewer {...props} />);
    await user.click(screen.getByLabelText(/Change status of SHI-1/));
    await user.click(screen.getByRole("menuitem", { name: "Done" }));
    expect(props.onSetStatus).toHaveBeenCalledWith(issue, "Done");
    expect(props.onOpenIssue).not.toHaveBeenCalled();
  });

  it("renders a read-only priority badge when priority isn't editable (GitHub)", () => {
    const issue = makeIssue({ priority: { level: "high", sortOrder: 1, label: "High" } });
    const props = defaultProps({ issues: [issue], canEditPriority: false });
    render(<IssuesViewer {...props} />);
    expect(screen.queryByLabelText(/Change priority of/)).toBeNull();
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("renders label chips under the title, capping with a +N overflow (SHI-92)", () => {
    const issue = makeIssue({
      labels: ["bug", "design", "infra", "ui", "git", "docs"].map((name) => ({ name })),
    });
    const props = defaultProps({ issues: [issue] });
    render(<IssuesViewer {...props} />);
    // First MAX_LABELS (4) render as chips; the rest collapse into "+N".
    expect(screen.getByText("bug")).toBeInTheDocument();
    expect(screen.getByText("ui")).toBeInTheDocument();
    expect(screen.queryByText("git")).toBeNull();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("does not open the detail view when Start session is clicked", () => {
    const issue = makeIssue();
    const props = defaultProps({ issues: [issue] });
    render(<IssuesViewer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Start session/i }));
    expect(props.onStartSession).toHaveBeenCalledWith(issue);
    expect(props.onOpenIssue).not.toHaveBeenCalled();
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

  // ---- docs/189: scroll restoration across the detail round-trip ----

  it("restores the saved scroll offset on mount and persists it on unmount", () => {
    const onPersistScroll = vi.fn();
    const props = defaultProps({
      issues: [makeIssue({ id: "1", title: "Row one" })],
      initialScrollTop: 120,
      onPersistScroll,
    });
    const { container, unmount } = render(<IssuesViewer {...props} />);
    const scroller = container.querySelector<HTMLElement>(".overflow-auto")!;
    // The layout effect restored the parent's stashed offset before paint.
    expect(scroller.scrollTop).toBe(120);
    // User scrolls further, then opens an issue (which unmounts the list).
    scroller.scrollTop = 340;
    unmount();
    expect(onPersistScroll).toHaveBeenCalledWith(340);
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
