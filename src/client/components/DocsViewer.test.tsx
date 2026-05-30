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
      fireEvent.click(screen.getByRole("button", { name: /Archived \(1\)/ }));
      expect(screen.getByText("Deploy")).toBeInTheDocument();
    });

    it("renders the frontmatter description under the title", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001-auth/plan.md",
          title: "Auth",
          status: "planned",
          description: "Adds login and session management.",
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Adds login and session management.")).toBeInTheDocument();
    });

    it("omits the description line when no description is present", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001-auth/plan.md", title: "Auth", status: "planned" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.queryByText("Adds login and session management.")).not.toBeInTheDocument();
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
      fireEvent.click(screen.getByRole("button", { name: /Archived \(1\)/ }));
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
      fireEvent.click(screen.getByRole("button", { name: /Archived \(1\)/ }));
      const items = screen.getAllByRole("button").filter(
        (btn) =>
          btn.getAttribute("aria-label") !== "Search docs" &&
          !btn.textContent?.includes("Reload") &&
          !btn.textContent?.includes("Tracked") &&
          !btn.textContent?.includes("Other") &&
          !/^Archived \(\d+\)$/.test(btn.textContent ?? ""),
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
        (btn) =>
          btn.getAttribute("aria-label") !== "Search docs" &&
          !btn.textContent?.includes("Reload"),
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

    it("renders a priority badge for in-progress docs that have one", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001/plan.md",
          title: "Active",
          status: "in-progress",
          priority: "high",
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("High")).toBeInTheDocument();
      expect(screen.getByText("In Progress")).toBeInTheDocument();
    });

    it("does not render a priority badge for archived (done/rejected) docs", () => {
      // Defensive: even if the field somehow leaks through, the UI shouldn't show
      // priority in the compact archived rows.
      const props = defaultProps();
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
      fireEvent.click(screen.getByRole("button", { name: /Archived \(1\)/ }));
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.queryByText("High")).not.toBeInTheDocument();
    });

    it("sorts tracked docs by priority first, status second", () => {
      // A high-priority planned doc should beat an unset-priority in-progress
      // doc even though in-progress normally sorts above planned: priority is
      // the primary key.
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001-unset-inprog/plan.md", title: "Unset-InProgress", status: "in-progress" }),
        makeDoc({ path: "docs/002-high-planned/plan.md", title: "High-Planned", status: "planned", priority: "high" }),
        makeDoc({ path: "docs/003-high-inprog/plan.md", title: "High-InProgress", status: "in-progress", priority: "high" }),
        makeDoc({ path: "docs/004-low-inprog/plan.md", title: "Low-InProgress", status: "in-progress", priority: "low" }),
      ];
      render(<DocsViewer {...props} />);
      // Query the row buttons by the unique `-InProgress`/`-Planned` suffixes
      // we put in the test titles. Filtering by hand against "Reload" /
      // "Tracked" / "Archived" is fragile if a future header change adds a
      // stray button — anchoring on the doc titles makes the assertion stable.
      const items = screen.getAllByRole("button").filter(
        (btn) => /-(InProgress|Planned)$/.test(
          // Use the title span only so badge text never leaks in.
          btn.querySelector("span")?.textContent ?? "",
        ),
      );
      expect(items.map((btn) => btn.querySelector("span")?.textContent)).toEqual([
        // High bucket, in-progress before planned within the bucket.
        "High-InProgress",
        "High-Planned",
        // Low bucket (still beats unset).
        "Low-InProgress",
        // Unset priority sorts last regardless of status.
        "Unset-InProgress",
      ]);
    });

    it("shows path context for tracked docs in subdirectories", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001-auth/plan.md", title: "Auth", status: "planned" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("docs/001-auth/")).toBeInTheDocument();
    });

    it("renders a checklist progress badge when the plan has checklist data", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001-feature/plan.md",
          title: "Feature",
          status: "in-progress",
          checklist: { total: 12, done: 7 },
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("7/12")).toBeInTheDocument();
    });

    it("fuses status and count into one progress pill for in-progress docs with a checklist", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001-feature/plan.md",
          title: "Feature",
          status: "in-progress",
          checklist: { total: 75, done: 58 },
        }),
      ];
      render(<DocsViewer {...props} />);
      // The count is shown...
      const count = screen.getByText("58/75");
      expect(count).toBeInTheDocument();
      // ...but the separate "In Progress" status label is dropped — the partial
      // fill is the in-progress signal now.
      expect(screen.queryByText("In Progress")).not.toBeInTheDocument();
      // The pill carries a fill element sized to the completion fraction.
      const pill = count.closest("span")?.parentElement;
      const fill = pill?.querySelector("[aria-hidden]") as HTMLElement | null;
      expect(fill).not.toBeNull();
      expect(fill?.style.width).toBe("77%"); // round(58/75 * 100)
    });

    it("also fuses status and count for planned, paused, done, and rejected docs", () => {
      // The fused pill is no longer in-progress-only — every typed status that
      // carries a checklist collapses into one pill (status label dropped,
      // fill color signals status). Custom-status is intentionally excluded
      // since the raw label conveys information color can't replace.
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Planned-Doc", status: "planned", checklist: { total: 4, done: 1 } }),
        makeDoc({ path: "docs/002/plan.md", title: "Paused-Doc", status: "paused", checklist: { total: 4, done: 2 } }),
        makeDoc({ path: "docs/003/plan.md", title: "Done-Doc", status: "done", checklist: { total: 4, done: 4 } }),
        makeDoc({ path: "docs/004/plan.md", title: "Rejected-Doc", status: "rejected", checklist: { total: 4, done: 3 } }),
      ];
      render(<DocsViewer {...props} />);
      // Expand archived so done + rejected rows are visible too.
      fireEvent.click(screen.getByRole("button", { name: /Archived \(2\)/ }));
      // Counts are visible for every status.
      expect(screen.getByText("1/4")).toBeInTheDocument();
      expect(screen.getByText("2/4")).toBeInTheDocument();
      expect(screen.getByText("4/4")).toBeInTheDocument();
      expect(screen.getByText("3/4")).toBeInTheDocument();
      // Status labels are dropped — the fill color is the status signal now.
      expect(screen.queryByText("Planned")).not.toBeInTheDocument();
      expect(screen.queryByText("Paused")).not.toBeInTheDocument();
      expect(screen.queryByText("Done")).not.toBeInTheDocument();
      expect(screen.queryByText("Rejected")).not.toBeInTheDocument();
    });

    it("colors the fused pill fill by status", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Planned-Doc", status: "planned", checklist: { total: 4, done: 2 } }),
        makeDoc({ path: "docs/002/plan.md", title: "Done-Doc", status: "done", checklist: { total: 4, done: 4 } }),
      ];
      render(<DocsViewer {...props} />);
      fireEvent.click(screen.getByRole("button", { name: /Archived \(1\)/ }));
      const fillFor = (text: string): HTMLElement | null => {
        const pill = screen.getByText(text).closest("span")?.parentElement;
        return pill?.querySelector("[aria-hidden]") as HTMLElement | null;
      };
      // Planned uses the info-subtle fill; done uses success-subtle. We assert
      // the CSS variable name rather than the resolved color so the test is
      // theme-agnostic.
      expect(fillFor("2/4")?.style.backgroundColor).toBe("var(--color-info-subtle)");
      expect(fillFor("4/4")?.style.backgroundColor).toBe("var(--color-success-subtle)");
    });

    it("keeps the separate count + custom-status badges when status is a raw custom string", () => {
      // Custom-status docs aren't fused because the raw label ("blocked",
      // "experimental") conveys information that color alone can't replace.
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001/plan.md",
          title: "Blocked-Doc",
          customStatus: "blocked",
          checklist: { total: 4, done: 2 },
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("2/4")).toBeInTheDocument();
      expect(screen.getByText("blocked")).toBeInTheDocument();
    });

    it("keeps the separate status label for in-progress docs without a checklist", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001/plan.md",
          title: "NoChecklist",
          status: "in-progress",
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("In Progress")).toBeInTheDocument();
    });

    it("does not render a checklist badge when checklist is missing", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001/plan.md",
          title: "NoChecklist",
          status: "in-progress",
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.queryByText(/^\d+\/\d+$/)).not.toBeInTheDocument();
    });

    it("does not render a checklist badge for empty checklists (0/0)", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001/plan.md",
          title: "Empty",
          status: "in-progress",
          checklist: { total: 0, done: 0 },
        }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.queryByText("0/0")).not.toBeInTheDocument();
    });

    it("renders the checklist badge for done docs once expanded", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001/plan.md",
          title: "Shipped",
          status: "done",
          checklist: { total: 12, done: 12 },
        }),
      ];
      render(<DocsViewer {...props} />);
      // The Done group is collapsed by default — the badge should not show yet.
      expect(screen.queryByText("12/12")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Archived \(1\)/ }));
      expect(screen.getByText("12/12")).toBeInTheDocument();
    });
  });

  describe("custom status", () => {
    it("treats a doc with an unrecognized status: value as tracked", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001-exp/plan.md",
          title: "Experiment",
          customStatus: "experimental",
        }),
        makeDoc({ path: "README.md", title: "README" }),
      ];
      render(<DocsViewer {...props} />);
      // The custom-status doc should land in Tracked, not Other.
      expect(screen.getByText("Tracked (1)")).toBeInTheDocument();
      expect(screen.getByText("Other (1)")).toBeInTheDocument();
      // The raw custom status text renders as the badge label.
      expect(screen.getByText("experimental")).toBeInTheDocument();
    });

    it("hides an untracked sibling of a custom-status plan", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001-exp/plan.md",
          title: "Experiment",
          customStatus: "blocked",
        }),
        makeDoc({ path: "docs/001-exp/checklist.md", title: "Experiment" }),
      ];
      render(<DocsViewer {...props} />);
      // The checklist sibling should not show up in the "Other" tab, since its
      // tracked plan sibling already represents the feature.
      expect(screen.queryByText(/Other \(/)).not.toBeInTheDocument();
    });

    it("hides a tracked checklist when a tracked plan exists in the same directory", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/001-exp/plan.md",
          title: "Experiment",
          status: "in-progress",
          description: "Primary plan summary.",
          checklist: { total: 4, done: 2 },
        }),
        makeDoc({
          path: "docs/001-exp/checklist.md",
          title: "Experiment",
          status: "in-progress",
          checklist: { total: 4, done: 2 },
          modifiedAt: "2026-01-03T00:00:00.000Z",
        }),
      ];
      render(<DocsViewer {...props} />);

      // The checklist has its own status frontmatter, but the plan is still
      // the only primary list row for the feature.
      expect(screen.getAllByText("Experiment")).toHaveLength(1);
      expect(screen.getByText("Primary plan summary.")).toBeInTheDocument();
      expect(screen.getByText("2/4")).toBeInTheDocument();
    });

    it("sorts custom-status docs between paused and archived (done + rejected)", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001-rejected/plan.md", title: "E-Rejected", status: "rejected" }),
        makeDoc({ path: "docs/002-done/plan.md", title: "D-Done", status: "done" }),
        makeDoc({ path: "docs/003-custom/plan.md", title: "C-Custom", customStatus: "experimental" }),
        makeDoc({ path: "docs/004-paused/plan.md", title: "B-Paused", status: "paused" }),
        makeDoc({ path: "docs/005-inprog/plan.md", title: "A-InProgress", status: "in-progress" }),
      ];
      render(<DocsViewer {...props} />);
      // Expand the Archived group so done + rejected rows are visible too.
      fireEvent.click(screen.getByRole("button", { name: /Archived \(2\)/ }));
      const items = screen.getAllByRole("button").filter(
        (btn) =>
          btn.getAttribute("aria-label") !== "Search docs" &&
          !btn.textContent?.includes("Reload") &&
          !/^Archived \(\d+\)$/.test(btn.textContent ?? ""),
      );
      expect(items[0].textContent).toContain("A-InProgress");
      expect(items[1].textContent).toContain("B-Paused");
      expect(items[2].textContent).toContain("C-Custom");
      expect(items[3].textContent).toContain("D-Done");
      expect(items[4].textContent).toContain("E-Rejected");
    });
  });

  describe("archived docs collapse", () => {
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
      // The toggle reflects the count of hidden archived docs.
      expect(
        screen.getByRole("button", { name: /Archived \(2\)/ }),
      ).toBeInTheDocument();
    });

    it("expands done docs when the toggle is clicked", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Active", status: "in-progress" }),
        makeDoc({ path: "docs/002/plan.md", title: "Finished", status: "done" }),
      ];
      render(<DocsViewer {...props} />);
      const toggle = screen.getByRole("button", { name: /Archived \(1\)/ });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Finished")).toBeInTheDocument();
    });

    it("does not render the Archived toggle when there are no archived docs", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Active", status: "in-progress" }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.queryByRole("button", { name: /Archived \(/ })).toBeNull();
    });

    it("groups rejected docs together with done under the Archived toggle", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001/plan.md", title: "Active", status: "in-progress" }),
        makeDoc({ path: "docs/002/plan.md", title: "Shipped", status: "done" }),
        makeDoc({ path: "docs/003/plan.md", title: "Declined", status: "rejected" }),
      ];
      render(<DocsViewer {...props} />);
      // Active doc is visible; archived docs (done + rejected) are hidden.
      expect(screen.getByText("Active")).toBeInTheDocument();
      expect(screen.queryByText("Shipped")).not.toBeInTheDocument();
      expect(screen.queryByText("Declined")).not.toBeInTheDocument();
      // One toggle covers both archived statuses with a combined count.
      const toggle = screen.getByRole("button", { name: /Archived \(2\)/ });
      fireEvent.click(toggle);
      expect(screen.getByText("Shipped")).toBeInTheDocument();
      expect(screen.getByText("Declined")).toBeInTheDocument();
      // Both badges render with their distinct labels.
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.getByText("Rejected")).toBeInTheDocument();
    });
  });

  describe("modified-in-session group", () => {
    // `modifiedAt` (mtime) now only orders the group; membership is driven by
    // the server-computed `changedInSession` flag.
    const OLDER = "2026-01-02T00:00:00.000Z";
    const NEWER = "2026-01-03T00:00:00.000Z";

    it("does not render the group when no doc is flagged changedInSession", () => {
      const props = defaultProps();
      props.files = [makeDoc({ path: "a.md", title: "A", status: "planned", modifiedAt: NEWER })];
      render(<DocsViewer {...props} />);
      expect(screen.queryByText("Modified in this session")).not.toBeInTheDocument();
    });

    it("surfaces changedInSession docs at the top, sorted by recency", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "docs/001-old/plan.md", title: "Old", status: "planned", modifiedAt: OLDER }),
        makeDoc({ path: "docs/002-recent/plan.md", title: "Recent", status: "planned", changedInSession: true, modifiedAt: OLDER }),
        makeDoc({ path: "docs/003-newest/plan.md", title: "Newest", status: "in-progress", changedInSession: true, modifiedAt: NEWER }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Modified in this session")).toBeInTheDocument();
      const items = screen.getAllByRole("button").filter(
        (btn) =>
          btn.getAttribute("aria-label") !== "Search docs" &&
          !btn.textContent?.includes("Reload"),
      );
      // Most recently modified first (mtime tiebreaks within the changed set).
      expect(items[0].textContent).toContain("Newest");
      expect(items[1].textContent).toContain("Recent");
      // Old (not changed this session) appears in the regular Tracked section below.
      expect(items[2].textContent).toContain("Old");
    });

    it("renders a Modified badge on docs in the session-modified group", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "a.md", title: "A", status: "planned", changedInSession: true }),
      ];
      render(<DocsViewer {...props} />);
      expect(screen.getByText("Modified")).toBeInTheDocument();
    });

    it("excludes session-modified docs from the regular tab counts", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "a.md", title: "A", status: "in-progress", changedInSession: true }),
        makeDoc({ path: "b.md", title: "B", status: "planned" }),
        makeDoc({ path: "README.md", title: "README" }),
      ];
      render(<DocsViewer {...props} />);
      // "A" was changed in session → moved to top group, leaving 1 tracked + 1 other.
      expect(screen.getByText("Tracked (1)")).toBeInTheDocument();
      expect(screen.getByText("Other (1)")).toBeInTheDocument();
    });

    it("includes untracked (no-status) docs in the session-modified group", () => {
      const props = defaultProps();
      props.files = [
        makeDoc({ path: "NOTES.md", title: "NOTES", changedInSession: true }),
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
      const props = defaultProps();
      props.files = [
        makeDoc({
          path: "docs/124-feature/plan.md",
          title: "Feature",
          status: "planned",
          priority: "high",
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
