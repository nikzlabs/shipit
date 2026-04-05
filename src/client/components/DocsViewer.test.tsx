import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DocsViewer } from "./DocsViewer.js";
import type { DocEntry } from "../../server/shared/types.js";

function makeDoc(overrides?: Partial<DocEntry>): DocEntry {
  return {
    path: "docs/001-test/plan.md",
    title: "Test",
    ...overrides,
  };
}

describe("DocsViewer", () => {
  const defaultProps = () => ({
    files: [] as DocEntry[],
    onFileClick: vi.fn(),
    onRefresh: vi.fn(),
  });

  afterEach(cleanup);

  describe("empty state", () => {
    it("shows empty message when no docs", () => {
      render(<DocsViewer {...defaultProps()} />);
      expect(screen.getByText("No docs found")).toBeInTheDocument();
    });

    it("shows refresh button in empty state", () => {
      const props = defaultProps();
      render(<DocsViewer {...props} />);
      fireEvent.click(screen.getByText("Refresh"));
      expect(props.onRefresh).toHaveBeenCalledOnce();
    });
  });

  describe("rendering docs", () => {
    it("renders doc titles for tracked docs", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001-auth/plan.md", title: "Auth", status: "planned" }),
        makeDoc({ path: "docs/002-deploy/plan.md", title: "Deploy", status: "done" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Auth")).toBeInTheDocument();
      expect(screen.getByText("Deploy")).toBeInTheDocument();
    });

    it("renders doc paths for untracked docs", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "README.md", title: "README" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("README.md")).toBeInTheDocument();
    });

    it("renders status badges for tracked docs", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "a.md", title: "A", status: "planned" }),
        makeDoc({ path: "b.md", title: "B", status: "in-progress" }),
        makeDoc({ path: "c.md", title: "C", status: "done" }),
        makeDoc({ path: "d.md", title: "D", status: "paused" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Planned")).toBeInTheDocument();
      expect(screen.getByText("In Progress")).toBeInTheDocument();
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.getByText("Paused")).toBeInTheDocument();
    });

    it("shows doc count in header", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "a.md", title: "A" }),
        makeDoc({ path: "b.md", title: "B" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("2 docs")).toBeInTheDocument();
    });

    it("shows singular 'doc' for single doc", () => {
      const props = defaultProps();
      props.files = [makeDoc()];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("1 doc")).toBeInTheDocument();
    });

    it("shows tabs when both tracked and untracked docs exist", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "a.md", title: "A", status: "in-progress" }),
        makeDoc({ path: "README.md", title: "README" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Tracked (1)")).toBeInTheDocument();
      expect(screen.getByText("Other (1)")).toBeInTheDocument();
    });

    it("shows section headers instead of tabs when only one group exists", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "a.md", title: "A", status: "planned" }),
        makeDoc({ path: "b.md", title: "B", status: "done" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Tracked")).toBeInTheDocument();
      expect(screen.queryByText(/Other/)).not.toBeInTheDocument();
    });

    it("sorts tracked docs by status then alphabetically by path", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/004-done/plan.md", title: "D-Done", status: "done" }),
        makeDoc({ path: "docs/001-planned/plan.md", title: "A-Planned", status: "planned" }),
        makeDoc({ path: "docs/003-paused/plan.md", title: "C-Paused", status: "paused" }),
        makeDoc({ path: "docs/002-inprog-b/plan.md", title: "B-InProgress", status: "in-progress" }),
        makeDoc({ path: "docs/005-inprog-a/plan.md", title: "A-InProgress", status: "in-progress" }),
      ];
      render(<DocsViewer {...props} />);
      const items = screen.getAllByRole("button").filter(
        (btn) => !btn.textContent?.includes("Reload") && !btn.textContent?.includes("Tracked") && !btn.textContent?.includes("Other"),
      );
      // in-progress first, sorted by path
      expect(items[0].textContent).toContain("B-InProgress");
      expect(items[1].textContent).toContain("A-InProgress");
      // then planned
      expect(items[2].textContent).toContain("A-Planned");
      // then paused
      expect(items[3].textContent).toContain("C-Paused");
      // then done
      expect(items[4].textContent).toContain("D-Done");
    });

    it("shows path context for tracked docs in subdirectories", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001-auth/plan.md", title: "Auth", status: "planned" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("docs/001-auth/")).toBeInTheDocument();
    });
  });

  describe("interactions", () => {
    it("calls onFileClick with path when a doc is clicked", () => {
      const props = defaultProps();
      props.files = [makeDoc({ path: "docs/001-auth/plan.md", title: "Auth", status: "planned" })];
      render(<DocsViewer {...props} />);
      fireEvent.click(screen.getByText("Auth"));
      expect(props.onFileClick).toHaveBeenCalledWith("docs/001-auth/plan.md");
    });

    it("calls onRefresh when Reload is clicked", () => {
      const props = defaultProps();
      props.files = [makeDoc()];
      render(<DocsViewer {...props} />);
      fireEvent.click(screen.getByText("Reload"));
      expect(props.onRefresh).toHaveBeenCalledOnce();
    });
  });
});
