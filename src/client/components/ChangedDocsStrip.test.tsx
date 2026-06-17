import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ChangedDocsStrip } from "./ChangedDocsStrip.js";
import { useFileStore } from "../stores/file-store.js";
import { useIssuesStore } from "../stores/issues-store.js";
import type { NotableFileChange } from "../../server/shared/types/github-types.js";
import type { IssueChipRef } from "../utils/pr-card-issue-refs.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const files: NotableFileChange[] = [
  { path: "docs/205-pr-changed-docs/plan.md", title: "PR-scoped changed docs", kind: "doc", status: "A" },
  { path: "shipit.yaml", title: "shipit.yaml", kind: "config", status: "M" },
  { path: "docs/205-pr-changed-docs/mockup.png", title: "mockup.png", kind: "image", status: "A" },
];

describe("ChangedDocsStrip", () => {
  let openPreview: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openPreview = vi.fn().mockResolvedValue(undefined);
    useFileStore.setState({ openPreview } as Partial<ReturnType<typeof useFileStore.getState>>);
  });

  it("renders a chip per notable file with its title", () => {
    render(<ChangedDocsStrip sessionId="s1" notableFiles={files} />);
    expect(screen.getByText("PR-scoped changed docs")).toBeInTheDocument();
    expect(screen.getByText("shipit.yaml")).toBeInTheDocument();
  });

  it("opens the file inline via openPreview when a chip is clicked", () => {
    render(<ChangedDocsStrip sessionId="s1" notableFiles={files} />);
    fireEvent.click(screen.getByText("PR-scoped changed docs"));
    expect(openPreview).toHaveBeenCalledWith("s1", "docs/205-pr-changed-docs/plan.md");
  });

  it("renders an image chip that opens the asset inline when clicked", () => {
    render(<ChangedDocsStrip sessionId="s1" notableFiles={files} />);
    fireEvent.click(screen.getByText("mockup.png"));
    expect(openPreview).toHaveBeenCalledWith("s1", "docs/205-pr-changed-docs/mockup.png");
  });

  it("renders nothing when there are no notable files", () => {
    const { container } = render(<ChangedDocsStrip sessionId="s1" notableFiles={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("exposes the full path and status in each chip's tooltip", () => {
    render(<ChangedDocsStrip sessionId="s1" notableFiles={files} />);
    expect(screen.getByText("shipit.yaml").closest("button")).toHaveAttribute(
      "title",
      "shipit.yaml · Modified",
    );
  });

  // ---- Related-issue chips (docs/206) ----

  const issueRefs: IssueChipRef[] = [
    { tracker: "linear", identifier: "SHI-90", issueId: "SHI-90", intent: "closes" },
    { tracker: "github", identifier: "o/r#5", issueId: "5", url: "https://github.com/o/r/issues/5", intent: "refs" },
  ];

  it("renders leading issue chips with their intent verbs", () => {
    render(<ChangedDocsStrip sessionId="s1" notableFiles={files} issueRefs={issueRefs} />);
    expect(screen.getByText("Closes")).toBeInTheDocument();
    expect(screen.getByText("SHI-90")).toBeInTheDocument();
    expect(screen.getByText("Refs")).toBeInTheDocument();
    expect(screen.getByText("o/r#5")).toBeInTheDocument();
  });

  it("renders for an issues-only PR (no notable files)", () => {
    const { container } = render(<ChangedDocsStrip sessionId="s1" notableFiles={[]} issueRefs={issueRefs} />);
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByText("SHI-90")).toBeInTheDocument();
  });

  it("opens the inline issue detail when an issue chip is clicked", () => {
    const openIssue = vi.fn();
    useIssuesStore.setState({ openIssue });
    render(<ChangedDocsStrip sessionId="s1" notableFiles={[]} issueRefs={issueRefs} />);
    fireEvent.click(screen.getByText("SHI-90"));
    expect(openIssue).toHaveBeenCalledWith(
      expect.objectContaining({ tracker: "linear", identifier: "SHI-90", id: "SHI-90" }),
    );
  });
});
