import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { IssuesViewer, type IssuesViewerProps } from "./IssuesViewer.js";
import type { TrackerInfo, TrackerIssue } from "../../server/shared/types.js";

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
    ...overrides,
  };
}

function defaultProps(overrides?: Partial<IssuesViewerProps>): IssuesViewerProps {
  return {
    trackers: [LINEAR_CONFIGURED],
    activeTracker: "linear",
    issues: [],
    info: LINEAR_CONFIGURED,
    loading: false,
    error: null,
    canStart: true,
    onSelectTracker: vi.fn(),
    onRefresh: vi.fn(),
    onStartSession: vi.fn(),
    onConnect: vi.fn(),
    ...overrides,
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
});
