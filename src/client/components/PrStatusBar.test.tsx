import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PrStatusBar, type PrStatusBarProps } from "./PrStatusBar.js";

afterEach(cleanup);

const defaultProps: PrStatusBarProps = {
  baseBranch: "main",
  headBranch: "feature-branch",
  insertions: 247,
  deletions: 38,
  prUrl: "https://github.com/test-user/test-repo/pull/42",
  prNumber: 42,
  checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
  autoMergeEnabled: false,
  mergeable: true,
  onMerge: vi.fn(),
};

describe("PrStatusBar", () => {
  it("renders branch flow correctly", () => {
    render(<PrStatusBar {...defaultProps} />);
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("feature-branch")).toBeTruthy();
  });

  it("renders diff stats with correct colors", () => {
    render(<PrStatusBar {...defaultProps} />);
    expect(screen.getByText("+247")).toBeTruthy();
    expect(screen.getByText("-38")).toBeTruthy();
  });

  it("renders View PR link with correct URL", () => {
    render(<PrStatusBar {...defaultProps} />);
    const link = screen.getByText("View PR");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://github.com/test-user/test-repo/pull/42");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("renders Merge button enabled when mergeable", () => {
    render(<PrStatusBar {...defaultProps} />);
    const mergeBtn = screen.getByText("Merge");
    expect(mergeBtn).toBeTruthy();
    expect(mergeBtn.hasAttribute("disabled")).toBe(false);
  });

  it("calls onMerge with default method on click", () => {
    const onMerge = vi.fn();
    render(<PrStatusBar {...defaultProps} onMerge={onMerge} />);
    fireEvent.click(screen.getByText("Merge"));
    expect(onMerge).toHaveBeenCalledWith("merge");
  });

  it("shows CI passed indicator", () => {
    render(
      <PrStatusBar
        {...defaultProps}
        checks={{ state: "success", total: 3, passed: 3, failed: 0, pending: 0 }}
      />,
    );
    expect(screen.getByText(/CI passed/)).toBeTruthy();
  });

  it("shows CI running indicator when pending", () => {
    render(
      <PrStatusBar
        {...defaultProps}
        checks={{ state: "pending", total: 3, passed: 1, failed: 0, pending: 2 }}
      />,
    );
    expect(screen.getByText(/CI running/)).toBeTruthy();
  });

  it("shows CI failed indicator", () => {
    render(
      <PrStatusBar
        {...defaultProps}
        checks={{ state: "failure", total: 3, passed: 1, failed: 2, pending: 0 }}
      />,
    );
    expect(screen.getByText(/CI failed/)).toBeTruthy();
  });

  it("disables merge button when checks fail", () => {
    render(
      <PrStatusBar
        {...defaultProps}
        checks={{ state: "failure", total: 3, passed: 1, failed: 2, pending: 0 }}
      />,
    );
    // The disabled merge button text includes the ⊘ character
    const mergeBtn = screen.getByText(/Merge/);
    expect(mergeBtn.closest("button")?.disabled).toBe(true);
  });

  it("disables merge button when not mergeable (conflicts)", () => {
    render(<PrStatusBar {...defaultProps} mergeable={false} />);
    const mergeBtn = screen.getByText(/Merge/);
    expect(mergeBtn.closest("button")?.disabled).toBe(true);
  });

  it("shows auto-merge styling when enabled", () => {
    render(<PrStatusBar {...defaultProps} autoMergeEnabled={true} />);
    expect(screen.getByText(/Auto-merge/)).toBeTruthy();
  });

  it("opens merge method dropdown on click", () => {
    render(<PrStatusBar {...defaultProps} />);
    // Click the dropdown button (▼)
    const dropdownBtn = screen.getByLabelText("Merge method");
    fireEvent.click(dropdownBtn);
    // "Merge commit" has a checkmark since it's selected by default
    expect(screen.getByText(/Merge commit/)).toBeTruthy();
    expect(screen.getByText("Squash and merge")).toBeTruthy();
    expect(screen.getByText("Rebase and merge")).toBeTruthy();
  });

  it("copy button copies branch name", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<PrStatusBar {...defaultProps} />);
    fireEvent.click(screen.getByLabelText("Copy branch name"));
    expect(writeText).toHaveBeenCalledWith("feature-branch");
  });
});
