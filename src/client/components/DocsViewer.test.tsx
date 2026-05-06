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
      // "Done" docs are collapsed by default — expand to view them.
      fireEvent.click(screen.getByRole("button", { name: /Done \(1\)/ }));
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
      expect(screen.getByText("Paused")).toBeInTheDocument();
      // The "Done" group is collapsed by default; the toggle header still
      // renders, but the per-doc Done badge only appears once expanded.
      fireEvent.click(screen.getByRole("button", { name: /Done \(1\)/ }));
      expect(screen.getByText("Done")).toBeInTheDocument();
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

    it("sorts tracked docs by status, planned by priority then descending path", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/004-done/plan.md", title: "D-Done", status: "done" }),
        makeDoc({ path: "docs/001-planned/plan.md", title: "A-Planned", status: "planned" }),
        makeDoc({ path: "docs/003-paused/plan.md", title: "C-Paused", status: "paused" }),
        makeDoc({ path: "docs/002-inprog-b/plan.md", title: "B-InProgress", status: "in-progress" }),
        makeDoc({ path: "docs/005-inprog-a/plan.md", title: "A-InProgress", status: "in-progress" }),
      ];
      render(<DocsViewer {...props} />);
      // Done items live behind a collapsed toggle — expand to assert ordering.
      fireEvent.click(screen.getByRole("button", { name: /Done \(1\)/ }));
      const items = screen.getAllByRole("button").filter(
        (btn) =>
          !btn.textContent?.includes("Reload") &&
          !btn.textContent?.includes("Tracked") &&
          !btn.textContent?.includes("Other") &&
          !/^Done \(\d+\)$/.test(btn.textContent ?? ""),
      );
      // in-progress first, sorted alphabetically by path (no priority)
      expect(items[0].textContent).toContain("B-InProgress");
      expect(items[1].textContent).toContain("A-InProgress");
      // then planned
      expect(items[2].textContent).toContain("A-Planned");
      // then paused
      expect(items[3].textContent).toContain("C-Paused");
      // then done (rendered below the toggle once expanded)
      expect(items[4].textContent).toContain("D-Done");
    });

    it("sorts planned docs by priority bucket, ties broken by reverse path order", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001-low/plan.md", title: "Z-Low", status: "planned", priority: "low" }),
        makeDoc({ path: "docs/002-unset/plan.md", title: "Y-Unset", status: "planned" }),
        makeDoc({ path: "docs/003-high-old/plan.md", title: "C-HighOld", status: "planned", priority: "high" }),
        makeDoc({ path: "docs/004-med/plan.md", title: "B-Med", status: "planned", priority: "medium" }),
        makeDoc({ path: "docs/005-high-new/plan.md", title: "A-HighNew", status: "planned", priority: "high" }),
      ];
      render(<DocsViewer {...props} />);
      const items = screen.getAllByRole("button").filter(
        (btn) => !btn.textContent?.includes("Reload"),
      );
      // high (newer path first), then medium, then low, then unset
      expect(items[0].textContent).toContain("A-HighNew");
      expect(items[1].textContent).toContain("C-HighOld");
      expect(items[2].textContent).toContain("B-Med");
      expect(items[3].textContent).toContain("Z-Low");
      expect(items[4].textContent).toContain("Y-Unset");
    });

    it("renders a priority badge for planned docs that have one", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Alpha", status: "planned", priority: "high" }),
        makeDoc({ path: "docs/002/plan.md", title: "Bravo", status: "planned", priority: "medium" }),
        makeDoc({ path: "docs/003/plan.md", title: "Charlie", status: "planned", priority: "low" }),
        makeDoc({ path: "docs/004/plan.md", title: "Delta", status: "planned" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("High")).toBeInTheDocument();
      expect(screen.getByText("Med")).toBeInTheDocument();
      expect(screen.getByText("Low")).toBeInTheDocument();
      // Delta has no priority — its title still renders, but no extra badge text.
      expect(screen.getByText("Delta")).toBeInTheDocument();
    });

    it("does not render a priority badge for non-planned docs", () => {
      const props = defaultProps();
      // Defensive: even if the field somehow leaks through, the UI shouldn't show it
      // when status !== "planned".
      props.files = [
        makeDoc({
          path: "docs/001/plan.md",
          title: "Finished Feature",
          status: "done",
          priority: "high",
        }),
      ];
      render(<DocsViewer {...props} />);
      // Done section is collapsed by default — expand it to inspect the badges.
      fireEvent.click(screen.getByRole("button", { name: /Done \(1\)/ }));
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.queryByText("High")).not.toBeInTheDocument();
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

  describe("done docs collapse", () => {
    it("collapses done docs by default and renders a toggle with the count", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Active", status: "in-progress" }),
        makeDoc({ path: "docs/002/plan.md", title: "Finished-One", status: "done" }),
        makeDoc({ path: "docs/003/plan.md", title: "Finished-Two", status: "done" }),
      ];
      render(<DocsViewer {...props} />);
      // Active doc is visible; done docs are hidden behind the toggle.
      expect(screen.getByText("Active")).toBeInTheDocument();
      expect(screen.queryByText("Finished-One")).not.toBeInTheDocument();
      expect(screen.queryByText("Finished-Two")).not.toBeInTheDocument();
      // The toggle reflects the count of hidden done docs.
      expect(
        screen.getByRole("button", { name: /Done \(2\)/ }),
      ).toBeInTheDocument();
    });

    it("expands done docs when the toggle is clicked", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Active", status: "in-progress" }),
        makeDoc({ path: "docs/002/plan.md", title: "Finished", status: "done" }),
      ];
      render(<DocsViewer {...props} />);
      const toggle = screen.getByRole("button", { name: /Done \(1\)/ });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Finished")).toBeInTheDocument();
    });

    it("does not render the Done toggle when there are no done docs", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Active", status: "in-progress" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.queryByRole("button", { name: /Done \(/ })).toBeNull();
    });
  });

  describe("modified-in-session group", () => {
    const SESSION_START = "2026-01-01T00:00:00.000Z";
    const BEFORE = "2025-12-01T00:00:00.000Z";
    const AFTER_1 = "2026-01-02T00:00:00.000Z";
    const AFTER_2 = "2026-01-03T00:00:00.000Z";

    it("does not render the group when sessionStartedAt is missing", () => {
      const props = defaultProps();
      props.files = [makeDoc({ path: "a.md", title: "A", status: "planned", modifiedAt: AFTER_1 })];
      render(<DocsViewer {...props} />);
      expect(screen.queryByText("Modified in this session")).not.toBeInTheDocument();
    });

    it("does not render the group when no doc was modified after session start", () => {
      const props = { ...defaultProps(), sessionStartedAt: SESSION_START };
      props.files = [makeDoc({ path: "a.md", title: "A", status: "planned", modifiedAt: BEFORE })];
      render(<DocsViewer {...props} />);
      expect(screen.queryByText("Modified in this session")).not.toBeInTheDocument();
    });

    it("surfaces session-modified docs at the top, sorted by recency", () => {
      const props = { ...defaultProps(), sessionStartedAt: SESSION_START };
      props.files = [
        makeDoc({ path: "docs/001-old/plan.md", title: "Old", status: "planned", modifiedAt: BEFORE }),
        makeDoc({ path: "docs/002-recent/plan.md", title: "Recent", status: "planned", modifiedAt: AFTER_1 }),
        makeDoc({ path: "docs/003-newest/plan.md", title: "Newest", status: "in-progress", modifiedAt: AFTER_2 }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Modified in this session")).toBeInTheDocument();
      const items = screen.getAllByRole("button").filter(
        (btn) => !btn.textContent?.includes("Reload"),
      );
      // Most recently modified first.
      expect(items[0].textContent).toContain("Newest");
      expect(items[1].textContent).toContain("Recent");
      // Old (modified before session) appears in the regular Tracked section below.
      expect(items[2].textContent).toContain("Old");
    });

    it("renders a Modified badge on docs in the session-modified group", () => {
      const props = { ...defaultProps(), sessionStartedAt: SESSION_START };
      props.files = [
        makeDoc({ path: "a.md", title: "A", status: "planned", modifiedAt: AFTER_1 }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Modified")).toBeInTheDocument();
    });

    it("excludes session-modified docs from the regular tab counts", () => {
      const props = { ...defaultProps(), sessionStartedAt: SESSION_START };
      props.files = [
        makeDoc({ path: "a.md", title: "A", status: "in-progress", modifiedAt: AFTER_1 }),
        makeDoc({ path: "b.md", title: "B", status: "planned", modifiedAt: BEFORE }),
        makeDoc({ path: "README.md", title: "README" }),
      ];
      render(<DocsViewer {...props} />);
      // "A" was modified in session → moved to top group, leaving 1 tracked + 1 other.
      expect(screen.getByText("Tracked (1)")).toBeInTheDocument();
      expect(screen.getByText("Other (1)")).toBeInTheDocument();
    });

    it("includes untracked (no-status) docs in the session-modified group", () => {
      const props = { ...defaultProps(), sessionStartedAt: SESSION_START };
      props.files = [
        makeDoc({ path: "NOTES.md", title: "NOTES", modifiedAt: AFTER_1 }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Modified in this session")).toBeInTheDocument();
      expect(screen.getByText("NOTES")).toBeInTheDocument();
    });

    it("hides an untracked sibling from the modified group when a tracked plan exists alongside it", () => {
      // Both `plan.md` and `checklist.md` for the same feature got touched in
      // this session. The two derive the same display title from the parent
      // directory name, so listing both would render as a visual duplicate.
      // The checklist remains reachable via the modal's sibling tabs.
      const props = { ...defaultProps(), sessionStartedAt: SESSION_START };
      props.files = [
        makeDoc({
          path: "docs/124-feature/plan.md",
          title: "Feature",
          status: "planned",
          priority: "high",
          modifiedAt: AFTER_1,
        }),
        makeDoc({
          path: "docs/124-feature/checklist.md",
          title: "Feature",
          modifiedAt: AFTER_2,
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Modified in this session")).toBeInTheDocument();
      // Only the tracked plan renders — exactly one row, not two.
      const titles = screen.getAllByText("Feature");
      expect(titles).toHaveLength(1);
      // The status/priority badges from plan.md should still be present.
      expect(screen.getByText("Planned")).toBeInTheDocument();
      expect(screen.getByText("High")).toBeInTheDocument();
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
