import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ChangedDocsStrip } from "./ChangedDocsStrip.js";
import { useFileStore } from "../stores/file-store.js";
import type { NotableFileChange } from "../../server/shared/types/github-types.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const files: NotableFileChange[] = [
  { path: "docs/205-pr-changed-docs/plan.md", title: "PR-scoped changed docs", kind: "doc", status: "A" },
  { path: "shipit.yaml", title: "shipit.yaml", kind: "config", status: "M" },
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
});
