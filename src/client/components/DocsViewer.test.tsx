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

const LINEAR_URL = "https://linear.app/shipit-ai/issue/SHI-28/decouple";

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
    it("renders doc titles for tracked (plan.md) docs", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001-auth/plan.md", title: "Auth" }),
        makeDoc({ path: "docs/002-deploy/plan.md", title: "Deploy" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Auth")).toBeInTheDocument();
      expect(screen.getByText("Deploy")).toBeInTheDocument();
    });

    it("renders the frontmatter description under the title", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001-auth/plan.md",
          title: "Auth",
          description: "Adds login and session management.",
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Adds login and session management.")).toBeInTheDocument();
    });

    it("omits the description line when no description is present", () => {
      const props = defaultProps();
      props.files = [makeDoc({ path: "docs/001-auth/plan.md", title: "Auth" })];
      render(<DocsViewer {...props} />);
      expect(screen.queryByText("Adds login and session management.")).not.toBeInTheDocument();
    });

    it("renders doc paths for untracked docs", () => {
      const props = defaultProps();
      props.files = [makeDoc({ path: "README.md", title: "README" })];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("README.md")).toBeInTheDocument();
    });

    it("renders a jump-to-issue chip for docs with an issue pointer", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001-auth/plan.md", title: "Auth", issue: LINEAR_URL }),
      ];
      render(<DocsViewer {...props} />);
      const chip = screen.getByText("SHI-28");
      expect(chip).toBeInTheDocument();
      const link = chip.closest("a");
      expect(link).not.toBeNull();
      expect(link).toHaveAttribute("href", LINEAR_URL);
      expect(link).toHaveAttribute("target", "_blank");
    });

    it("treats a non-plan doc with an issue pointer as tracked", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/spec.md", title: "Spec", issue: "octo/repo#7" }),
        makeDoc({ path: "README.md", title: "README" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Tracked (1)")).toBeInTheDocument();
      expect(screen.getByText("Other (1)")).toBeInTheDocument();
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
        makeDoc({ path: "docs/001/plan.md", title: "A" }),
        makeDoc({ path: "README.md", title: "README" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Tracked (1)")).toBeInTheDocument();
      expect(screen.getByText("Other (1)")).toBeInTheDocument();
    });

    it("shows section headers instead of tabs when only one group exists", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "A" }),
        makeDoc({ path: "docs/002/plan.md", title: "B" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Tracked")).toBeInTheDocument();
      expect(screen.queryByText(/Other/)).not.toBeInTheDocument();
    });

    it("sorts tracked active docs newest-first by feature number", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/003-c/plan.md", title: "C-Doc" }),
        makeDoc({ path: "docs/001-a/plan.md", title: "A-Doc" }),
        makeDoc({ path: "docs/002-b/plan.md", title: "B-Doc" }),
      ];
      render(<DocsViewer {...props} />);
      const items = screen.getAllByRole("button").filter(
        (btn) => (btn.querySelector("span")?.textContent ?? "").endsWith("-Doc"),
      );
      // Highest feature number first (003 → 002 → 001), so the newest doc is at
      // the top of the list without scrolling.
      expect(items.map((btn) => btn.querySelector("span")?.textContent)).toEqual([
        "C-Doc",
        "B-Doc",
        "A-Doc",
      ]);
    });

    it("renders a checklist progress badge when the plan has checklist data", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001-feature/plan.md",
          title: "Feature",
          checklist: { total: 12, done: 7 },
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("7/12")).toBeInTheDocument();
    });

    it("does not render a checklist badge when checklist is missing", () => {
      const props = defaultProps();
      props.files = [makeDoc({ path: "docs/001/plan.md", title: "NoChecklist" })];
      render(<DocsViewer {...props} />);
      expect(screen.queryByText(/^\d+\/\d+$/)).not.toBeInTheDocument();
    });

    it("does not render a checklist badge for empty checklists (0/0)", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001/plan.md",
          title: "Empty",
          checklist: { total: 0, done: 0 },
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.queryByText("0/0")).not.toBeInTheDocument();
    });

    it("shows path context for tracked docs in subdirectories", () => {
      const props = defaultProps();
      props.files = [makeDoc({ path: "docs/001-auth/plan.md", title: "Auth" })];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("docs/001-auth/")).toBeInTheDocument();
    });

    it("hides a checklist sibling when a plan.md exists in the same directory", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001-exp/plan.md",
          title: "Experiment",
          description: "Primary plan summary.",
          checklist: { total: 4, done: 2 },
        }),
        makeDoc({
          path: "docs/001-exp/checklist.md",
          title: "Experiment",
          checklist: { total: 4, done: 2 },
          modifiedAt: "2026-01-03T00:00:00.000Z",
        }),
      ];
      render(<DocsViewer {...props} />);
      // The plan is the single primary row for the feature.
      expect(screen.getAllByText("Experiment")).toHaveLength(1);
      expect(screen.getByText("Primary plan summary.")).toBeInTheDocument();
      expect(screen.getByText("2/4")).toBeInTheDocument();
    });
  });

  describe("checklist-state grouping (Done collapse)", () => {
    it("keeps docs with no checklist in the Active list", () => {
      const props = defaultProps();
      props.files = [makeDoc({ path: "docs/001/plan.md", title: "Reference" })];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Reference")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Done \(/ })).toBeNull();
    });

    it("keeps docs with an incomplete checklist in the Active list", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "InProgress", checklist: { total: 4, done: 2 } }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("InProgress")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Done \(/ })).toBeNull();
    });

    it("collapses fully-complete docs under a Done toggle with the count", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Active", checklist: { total: 4, done: 2 } }),
        makeDoc({ path: "docs/002/plan.md", title: "Finished-One", checklist: { total: 3, done: 3 } }),
        makeDoc({ path: "docs/003/plan.md", title: "Finished-Two", checklist: { total: 1, done: 1 } }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Active")).toBeInTheDocument();
      expect(screen.queryByText("Finished-One")).not.toBeInTheDocument();
      expect(screen.queryByText("Finished-Two")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Done \(2\)/ })).toBeInTheDocument();
    });

    it("expands done docs when the toggle is clicked", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Active", checklist: { total: 4, done: 2 } }),
        makeDoc({ path: "docs/002/plan.md", title: "Finished", checklist: { total: 4, done: 4 } }),
      ];
      render(<DocsViewer {...props} />);
      const toggle = screen.getByRole("button", { name: /Done \(1\)/ });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Finished")).toBeInTheDocument();
      expect(screen.getByText("4/4")).toBeInTheDocument();
    });

    it("does not render the Done toggle when nothing is complete", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Active", checklist: { total: 4, done: 2 } }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.queryByRole("button", { name: /Done \(/ })).toBeNull();
    });
  });

  describe("modified-in-session group", () => {
    // `modifiedAt` (mtime) now only orders the group; membership is driven by
    // the server-computed `changedInSession` flag.
    const OLDER = "2026-01-02T00:00:00.000Z";
    const NEWER = "2026-01-03T00:00:00.000Z";

    it("does not render the group when no doc is flagged changedInSession", () => {
      const props = defaultProps();
      props.files = [makeDoc({ path: "docs/001/plan.md", title: "A", modifiedAt: NEWER })];
      render(<DocsViewer {...props} />);
      expect(screen.queryByText("Modified in this session")).not.toBeInTheDocument();
    });

    it("surfaces changedInSession docs at the top, sorted by recency", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001-old/plan.md", title: "Old", modifiedAt: OLDER }),
        makeDoc({ path: "docs/002-recent/plan.md", title: "Recent", changedInSession: true, modifiedAt: OLDER }),
        makeDoc({ path: "docs/003-newest/plan.md", title: "Newest", changedInSession: true, modifiedAt: NEWER }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Modified in this session")).toBeInTheDocument();
      const items = screen.getAllByRole("button").filter(
        (btn) =>
          btn.getAttribute("aria-label") !== "Search docs" &&
          !btn.textContent?.includes("Reload"),
      );
      expect(items[0].textContent).toContain("Newest");
      expect(items[1].textContent).toContain("Recent");
      // Old (not changed this session) appears in the regular Tracked section below.
      expect(items[2].textContent).toContain("Old");
    });

    it("renders a Modified badge on docs in the session-modified group", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "A", changedInSession: true }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Modified")).toBeInTheDocument();
    });

    it("excludes session-modified docs from the regular tab counts", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "A", changedInSession: true }),
        makeDoc({ path: "docs/002/plan.md", title: "B" }),
        makeDoc({ path: "README.md", title: "README" }),
      ];
      render(<DocsViewer {...props} />);
      // "A" was changed in session → moved to top group, leaving 1 tracked + 1 other.
      expect(screen.getByText("Tracked (1)")).toBeInTheDocument();
      expect(screen.getByText("Other (1)")).toBeInTheDocument();
    });

    it("includes untracked docs in the session-modified group", () => {
      const props = defaultProps();
      props.files = [makeDoc({ path: "NOTES.md", title: "NOTES", changedInSession: true })];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Modified in this session")).toBeInTheDocument();
      expect(screen.getByText("NOTES")).toBeInTheDocument();
    });

    it("hides an untracked sibling from the modified group when a tracked plan exists alongside it", () => {
      // Both `plan.md` and `checklist.md` for the same feature got touched in
      // this session. The two derive the same display title from the parent
      // directory name, so listing both would render as a visual duplicate.
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/124-feature/plan.md",
          title: "Feature",
          issue: LINEAR_URL,
          changedInSession: true,
        }),
        makeDoc({
          path: "docs/124-feature/checklist.md",
          title: "Feature",
          changedInSession: true,
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Modified in this session")).toBeInTheDocument();
      // Only the tracked plan renders — exactly one row, not two.
      expect(screen.getAllByText("Feature")).toHaveLength(1);
      // The plan's issue chip should still be present.
      expect(screen.getByText("SHI-28")).toBeInTheDocument();
    });
  });

  describe("interactions", () => {
    it("calls onFileClick with path when a doc is clicked", () => {
      const props = defaultProps();
      props.files = [makeDoc({ path: "docs/001-auth/plan.md", title: "Auth" })];
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
