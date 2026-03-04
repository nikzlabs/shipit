import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PrLifecycleCard, PrStatusIcon } from "./PrLifecycleCard.js";
import { usePrStore } from "../stores/pr-store.js";
import type { PrCardState } from "../stores/pr-store.js";

beforeEach(() => {
  usePrStore.setState({
    statusBySession: {},
    cardBySession: {},
  });
});

afterEach(cleanup);

// ---- Helpers ----

function setCard(sessionId: string, card: PrCardState) {
  usePrStore.setState((s) => ({
    cardBySession: { ...s.cardBySession, [sessionId]: card },
  }));
}

function setStatus(sessionId: string, prState: "open" | "merged", checksState?: string) {
  usePrStore.setState({
    statusBySession: {
      ...usePrStore.getState().statusBySession,
      [sessionId]: {
        sessionId,
        prNumber: 1,
        prUrl: "https://github.com/o/r/pull/1",
        prTitle: "Test PR",
        prState,
        baseBranch: "main",
        headBranch: "feature",
        insertions: 10,
        deletions: 5,
        checks: {
          state: (checksState ?? "none") as "pending" | "success" | "failure" | "none",
          total: 0,
          passed: 0,
          failed: 0,
          pending: 0,
        },
        mergeable: true,
        autoMergeEnabled: false,
      },
    },
  });
}

const openPrCard: PrCardState = {
  cardId: "c1",
  phase: "open",
  pr: {
    number: 42,
    title: "Add feature",
    url: "https://github.com/o/r/pull/42",
    baseBranch: "main",
    headBranch: "feature-branch",
    insertions: 100,
    deletions: 20,
  },
};

// ---- PrLifecycleCard ----

describe("PrLifecycleCard", () => {
  it("renders nothing when no card exists for session", () => {
    const { container } = render(<PrLifecycleCard sessionId="no-card" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders ready phase with diff stats and create button", () => {
    setCard("s1", {
      cardId: "c1",
      phase: "ready",
      totalInsertions: 30,
      totalDeletions: 2,
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText("+30")).toBeInTheDocument();
    expect(screen.getByText("-2")).toBeInTheDocument();
    expect(screen.getByText("Create Pull Request")).toBeInTheDocument();
  });

  it("renders creating phase with spinner text", () => {
    setCard("s1", { cardId: "c1", phase: "creating" });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText("Creating pull request...")).toBeInTheDocument();
  });

  it("renders open phase with branch flow and diff stats", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/main.*feature-branch/)).toBeInTheDocument();
    expect(screen.getByText("View PR")).toBeInTheDocument();
    expect(screen.getByText(/CI/)).toBeInTheDocument();
  });

  it("renders open phase with failing checks", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByTitle(/CI failed/)).toBeInTheDocument();
  });

  // ---- Phase 2: per-check failure list ----

  it("renders failed checks list when CI fails with failedChecks details", () => {
    setCard("s1", {
      ...openPrCard,
      checks: {
        state: "failure",
        total: 3,
        passed: 1,
        failed: 2,
        pending: 0,
        failedChecks: [
          { name: "lint", summary: "ESLint errors" },
          { name: "test", summary: "3 tests failed" },
        ],
      },
    });

    const { container } = render(<PrLifecycleCard sessionId="s1" />);

    // Check names and summaries appear in the rendered output
    expect(container.textContent).toContain("lint");
    expect(container.textContent).toContain("ESLint errors");
    expect(container.textContent).toContain("test");
    expect(container.textContent).toContain("3 tests failed");
  });

  it("shows Fix CI Issues button when CI fails and auto-fix is off", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText("Fix CI Issues")).toBeInTheDocument();
  });

  it("shows auto-fix toggle when CI fails", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText("Auto-fix")).toBeInTheDocument();
  });

  it("shows auto-fix running state with attempt counter", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
      autoFix: { enabled: true, status: "running", attemptCount: 2, maxAttempts: 3 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/Auto-fixing \(attempt 2\/3\)/)).toBeInTheDocument();
  });

  it("shows auto-fix exhausted state", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
      autoFix: { enabled: true, status: "exhausted", attemptCount: 3, maxAttempts: 3 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/Auto-fix exhausted/)).toBeInTheDocument();
    // Should show Fix CI Issues button as fallback
    expect(screen.getByText("Fix CI Issues")).toBeInTheDocument();
  });

  it("hides Fix CI button when auto-fix is enabled and running", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
      autoFix: { enabled: true, status: "running", attemptCount: 1, maxAttempts: 3 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.queryByText("Fix CI Issues")).toBeNull();
  });

  it("does not show failure list or fix button when CI passes", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.queryByText("Fix CI Issues")).toBeNull();
    expect(screen.queryByText("Auto-fix")).toBeNull();
  });

  // ---- Phase 3: merge button, auto-merge toggle, error messages ----

  it("renders merge button when CI passed", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText("Squash and merge")).toBeInTheDocument();
  });

  it("does not render merge button when CI is pending", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "pending", total: 3, passed: 1, failed: 0, pending: 2 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.queryByText("Squash and merge")).toBeNull();
  });

  it("does not render merge button when CI has failed", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.queryByText("Squash and merge")).toBeNull();
  });

  it("renders merge button with selected method label", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
      autoMerge: { enabled: false, mergeMethod: "rebase" },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText("Rebase and merge")).toBeInTheDocument();
  });

  it("renders auto-merge toggle when CI passed", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText("Auto-merge")).toBeInTheDocument();
  });

  it("hides merge button when auto-merge is enabled", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
      autoMerge: { enabled: true, mergeMethod: "squash" },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.queryByText("Squash and merge")).toBeNull();
  });

  it("shows 'Will merge when CI passes' when auto-merge enabled and CI pending", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "pending", total: 3, passed: 1, failed: 0, pending: 2 },
      autoMerge: { enabled: true, mergeMethod: "squash" },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText("Will merge when CI passes")).toBeInTheDocument();
  });

  it("renders auto-merge error with settings link", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
      autoMerge: {
        enabled: false,
        mergeMethod: "squash",
        error: {
          code: "auto_merge_not_enabled",
          message: "Auto-merge is not enabled for this repository.",
          settingsUrl: "https://github.com/owner/repo/settings",
        },
      },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/Auto-merge is not enabled/)).toBeInTheDocument();
    expect(screen.getByText("Enable in repository settings")).toBeInTheDocument();
  });

  it("renders auto-merge error for missing branch protection", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
      autoMerge: {
        enabled: false,
        mergeMethod: "squash",
        error: {
          code: "no_branch_protection",
          message: "Auto-merge requires branch protection rules.",
          settingsUrl: "https://github.com/owner/repo/settings/branches",
        },
      },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/Auto-merge requires branch protection/)).toBeInTheDocument();
    expect(screen.getByText("Configure branch protection")).toBeInTheDocument();
  });

  it("renders merged phase", () => {
    setCard("s1", {
      cardId: "c1",
      phase: "merged",
      pr: {
        number: 42,
        title: "Add feature",
        url: "https://github.com/o/r/pull/42",
        baseBranch: "main",
        headBranch: "feature-branch",
        insertions: 100,
        deletions: 20,
      },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/PR #42 merged into main/)).toBeInTheDocument();
    expect(screen.getByText("View PR")).toBeInTheDocument();
  });

  it("renders error phase with message and retry button", () => {
    setCard("s1", {
      cardId: "c1",
      phase: "error",
      errorMessage: "Branch has no commits",
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/Failed to create PR/)).toBeInTheDocument();
    expect(screen.getByText(/Branch has no commits/)).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});

// ---- PrStatusIcon ----

describe("PrStatusIcon", () => {
  it("renders nothing when no status or card exists", () => {
    const { container } = render(<PrStatusIcon sessionId="empty" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders merged icon from poller status", () => {
    setStatus("s1", "merged");

    render(<PrStatusIcon sessionId="s1" />);

    const icon = screen.getByTitle("PR merged");
    expect(icon).toBeInTheDocument();
  });

  it("renders CI passed icon for open PR with success checks", () => {
    setStatus("s1", "open", "success");

    render(<PrStatusIcon sessionId="s1" />);

    const icon = screen.getByTitle("CI passed");
    expect(icon).toBeInTheDocument();
  });

  it("renders CI failed icon for open PR with failed checks", () => {
    setStatus("s1", "open", "failure");

    render(<PrStatusIcon sessionId="s1" />);

    const icon = screen.getByTitle("CI failed");
    expect(icon).toBeInTheDocument();
  });

  it("renders CI running icon for open PR with pending checks", () => {
    setStatus("s1", "open", "pending");

    render(<PrStatusIcon sessionId="s1" />);

    const icon = screen.getByTitle("CI running");
    expect(icon).toBeInTheDocument();
  });

  it("renders plain open icon when no CI", () => {
    setStatus("s1", "open", "none");

    render(<PrStatusIcon sessionId="s1" />);

    const icon = screen.getByTitle("PR open");
    expect(icon).toBeInTheDocument();
  });
});
