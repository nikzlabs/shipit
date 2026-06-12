import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IssueDetail } from "./IssueDetail.js";
import type { IssueSelection } from "../stores/issues-store.js";
import type { TrackerComment, TrackerInfo, TrackerIssue } from "../../server/shared/types.js";

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
    labels: [{ name: "security" }, { name: "bug" }],
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
    comments: [] as TrackerComment[] | null,
    commentsLoading: false,
    commentsError: null as string | null,
    availableStatuses: [] as { name: string; type?: string }[],
    canEditPriority: true,
    onBack: vi.fn(),
    onRefresh: vi.fn(),
    onStartSession: vi.fn(),
    onPostComment: vi.fn(async () => null as string | null),
    onSetStatus: vi.fn(async () => null as string | null),
    onSetPriority: vi.fn(async () => null as string | null),
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

  it("edits the status inline from the detail view (docs/191)", async () => {
    const user = userEvent.setup();
    const props = {
      ...baseProps(),
      detail: makeIssue({
        availableStatuses: [
          { name: "In Progress", type: "started" },
          { name: "Done", type: "completed" },
        ],
      }),
    };
    render(<IssueDetail {...props} />);
    await user.click(screen.getByLabelText(/Change status/));
    await user.click(screen.getByRole("menuitem", { name: "Done" }));
    expect(props.onSetStatus).toHaveBeenCalledWith("Done");
  });

  it("offers an editable priority for Linear", () => {
    render(<IssueDetail {...baseProps()} />);
    expect(screen.getByLabelText(/Change priority/)).toBeInTheDocument();
  });

  it("renders priority read-only when the tracker can't edit it (GitHub)", () => {
    render(<IssueDetail {...baseProps()} canEditPriority={false} />);
    expect(screen.queryByLabelText(/Change priority/)).toBeNull();
    expect(screen.getByText("Urgent")).toBeInTheDocument();
  });

  it("renders an empty-description placeholder", () => {
    render(<IssueDetail {...baseProps()} detail={makeIssue({ description: undefined })} />);
    expect(screen.getByText("No description.")).toBeInTheDocument();
  });
});

describe("IssueDetail comments (docs/189 follow-up)", () => {
  const COMMENT: TrackerComment = {
    id: "c-1",
    body: "First reply on the thread.",
    author: { name: "Reviewer" },
    createdAt: "2026-06-01T00:00:00.000Z",
  };

  it("renders the comment thread with author and body", () => {
    render(<IssueDetail {...baseProps()} comments={[COMMENT]} />);
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("First reply on the thread.")).toBeInTheDocument();
    // The count chip reflects the thread length.
    expect(screen.getByText("· 1")).toBeInTheDocument();
  });

  it("shows a loading hint until the thread is fetched (comments null)", () => {
    render(<IssueDetail {...baseProps()} comments={null} commentsLoading />);
    expect(screen.getByText("Loading comments…")).toBeInTheDocument();
  });

  it("shows the empty state when the thread has no comments", () => {
    render(<IssueDetail {...baseProps()} comments={[]} />);
    expect(screen.getByText("No comments yet.")).toBeInTheDocument();
  });

  it("surfaces a fetch error for the thread", () => {
    render(<IssueDetail {...baseProps()} comments={null} commentsError="Linear unreachable" />);
    expect(screen.getByText("Linear unreachable")).toBeInTheDocument();
  });

  it("posts a comment and clears the draft on success", async () => {
    const props = baseProps();
    render(<IssueDetail {...props} />);
    const input = screen.getByTestId("issue-comment-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Looks good to me" } });
    fireEvent.click(screen.getByRole("button", { name: /^Comment$/i }));
    await waitFor(() => expect(props.onPostComment).toHaveBeenCalledWith("Looks good to me"));
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("keeps the draft and shows an error when posting fails", async () => {
    const props = { ...baseProps(), onPostComment: vi.fn(async () => "Posting failed") };
    render(<IssueDetail {...props} />);
    const input = screen.getByTestId("issue-comment-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Draft survives" } });
    fireEvent.click(screen.getByRole("button", { name: /^Comment$/i }));
    await waitFor(() => expect(screen.getByText("Posting failed")).toBeInTheDocument());
    expect(input.value).toBe("Draft survives");
  });

  it("disables the Comment button for an empty draft", () => {
    render(<IssueDetail {...baseProps()} />);
    expect(screen.getByRole("button", { name: /^Comment$/i })).toBeDisabled();
  });
});
