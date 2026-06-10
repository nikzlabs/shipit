import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { IssueDetail } from "./IssueDetail.js";
import type { IssueSelection } from "../stores/issues-store.js";
import type { TrackerInfo, TrackerIssue } from "../../server/shared/types.js";

/**
 * Tests for the inline single-issue detail view (docs/189): it paints the
 * hydrated issue (title, status, priority, labels, body), keeps the tracker
 * deep link as the ONLY escape hatch, and degrades to a skeleton / error state.
 */

const SELECTION: IssueSelection = {
  tracker: "linear",
  id: "node-1",
  identifier: "SHI-1",
  title: "Seed title",
  url: "https://linear.app/x/issue/SHI-1",
};

const INFO: TrackerInfo = { id: "linear", label: "Linear", configured: true };

function makeIssue(over: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: "node-1",
    identifier: "SHI-1",
    title: "Redesign the auth flow",
    url: "https://linear.app/x/issue/SHI-1",
    description: "Body paragraph here.",
    priority: { level: "urgent", sortOrder: 0, label: "Urgent" },
    status: { name: "In Progress", type: "started" },
    labels: ["security", "bug"],
    assignee: { name: "Nik" },
    ...over,
  };
}

function baseProps() {
  return {
    selection: SELECTION,
    detail: makeIssue(),
    loading: false,
    error: null as string | null,
    info: INFO,
    canStart: true,
    onBack: vi.fn(),
    onRefresh: vi.fn(),
    onStartSession: vi.fn(),
  };
}

afterEach(() => cleanup());

describe("IssueDetail (docs/189)", () => {
  it("renders the hydrated issue with title, status, priority, labels, and body", () => {
    render(<IssueDetail {...baseProps()} />);
    expect(screen.getByText("Redesign the auth flow")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Urgent")).toBeInTheDocument();
    expect(screen.getByText("security")).toBeInTheDocument();
    expect(screen.getByText("bug")).toBeInTheDocument();
    expect(screen.getByText("Nik")).toBeInTheDocument();
    expect(screen.getByText("Body paragraph here.")).toBeInTheDocument();
  });

  it("keeps the tracker deep link as the only external escape hatch", () => {
    render(<IssueDetail {...baseProps()} />);
    const link = screen.getByRole("link") as HTMLAnchorElement;
    expect(link.href).toBe("https://linear.app/x/issue/SHI-1");
    expect(link.target).toBe("_blank");
    expect(screen.getByText(/Open in Linear/)).toBeInTheDocument();
  });

  it("shows the skeleton when loading with no detail yet", () => {
    render(<IssueDetail {...baseProps()} detail={null} loading />);
    expect(screen.getByTestId("issue-detail-skeleton")).toBeInTheDocument();
  });

  it("shows an error state with retry when the fetch fails and there is no detail", () => {
    const props = { ...baseProps(), detail: null, error: "Issue not found" };
    render(<IssueDetail {...props} />);
    expect(screen.getByText("Issue not found")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    expect(props.onRefresh).toHaveBeenCalled();
  });

  it("fires onBack and onStartSession from the controls", () => {
    const props = baseProps();
    render(<IssueDetail {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Issues/i }));
    expect(props.onBack).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Start session/i }));
    expect(props.onStartSession).toHaveBeenCalledWith(props.detail);
  });

  it("renders an empty-description placeholder", () => {
    render(<IssueDetail {...baseProps()} detail={makeIssue({ description: undefined })} />);
    expect(screen.getByText("No description.")).toBeInTheDocument();
  });
});
