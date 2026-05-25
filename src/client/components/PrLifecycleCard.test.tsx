import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { PrLifecycleCard, PrStateBadge } from "./PrLifecycleCard.js";
import { usePrStore } from "../stores/pr-store.js";
import type { PrCardState } from "../stores/pr-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useCommentStore } from "../stores/comment-store.js";
import type { PrMergeableState } from "../../server/shared/types.js";

beforeEach(() => {
  usePrStore.setState({
    statusBySession: {},
    cardBySession: {},
  });
  // Reset stores that the merge-conflict UI reads (rebaseStatus, agent running).
  // Without this, leftover state from a prior test (e.g. rebaseStatus = "in_progress")
  // would suppress the conflict UI and produce confusing test failures.
  useGitStore.getState().reset();
  useSessionStore.setState({ activeRunnerSessions: new Set<string>(), isLoading: false, activity: undefined });
  useCommentStore.setState({ commentsBySession: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

// ---- Helpers for merge-conflict tests ----

/**
 * Seed a minimal `statusBySession` entry with the given mergeable value.
 * The PR card reads `mergeable` directly from this slice, not from `cardBySession`.
 */
function setMergeable(sessionId: string, mergeable: PrMergeableState) {
  usePrStore.setState((s) => ({
    statusBySession: {
      ...s.statusBySession,
      [sessionId]: {
        sessionId,
        prNumber: 1,
        prUrl: "https://github.com/o/r/pull/1",
        prTitle: "Test PR",
        prBody: "",
        prState: "open",
        baseBranch: "main",
        headBranch: "feature",
        insertions: 10,
        deletions: 5,
        checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable,
        autoMergeEnabled: false,
      },
    },
  }));
}

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
        prBody: "",
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
        mergeable: "mergeable",
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

    render(<PrLifecycleCard sessionId="s1" onCreatePr={vi.fn()} />);

    expect(screen.getByText("+30")).toBeInTheDocument();
    expect(screen.getByText("-2")).toBeInTheDocument();
    expect(screen.getByText("Create PR")).toBeInTheDocument();
  });

  it("renders auto-merge toggle in the ready phase options", () => {
    setCard("s1", {
      cardId: "c1",
      phase: "ready",
      totalInsertions: 30,
      totalDeletions: 2,
    });

    render(<PrLifecycleCard sessionId="s1" onCreatePr={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("More options"));
    expect(screen.getByText("Auto-merge")).toBeInTheDocument();
  });

  it("keeps ready phase create button idle while a normal agent turn is running", () => {
    useSessionStore.setState({ isLoading: true, activity: { label: "Thinking..." } });
    setCard("s1", {
      cardId: "c1",
      phase: "ready",
      totalInsertions: 30,
      totalDeletions: 2,
    });

    render(<PrLifecycleCard sessionId="s1" onCreatePr={vi.fn()} />);

    const button = screen.getByRole("button", { name: "Create PR" });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    expect(screen.queryByText("Creating PR...")).not.toBeInTheDocument();
  });

  it("shows ready phase create button as creating for a PR creation turn", () => {
    useSessionStore.setState({ isLoading: true, activity: { label: "Creating PR..." } });
    setCard("s1", {
      cardId: "c1",
      phase: "ready",
      totalInsertions: 30,
      totalDeletions: 2,
    });

    render(<PrLifecycleCard sessionId="s1" />);

    const button = screen.getByRole("button", { name: /Creating PR/i });
    expect(button).toBeDisabled();
  });

  it("renders creating phase with spinner inside button", () => {
    setCard("s1", {
      cardId: "c1",
      phase: "creating",
      totalInsertions: 10,
      totalDeletions: 2,
    });

    render(<PrLifecycleCard sessionId="s1" />);

    const button = screen.getByRole("button", { name: /Creating PR/i });
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it("renders open phase with PR title (not branch name) and diff stats", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    // PR title replaces the "base ← head" branch label when a PR exists.
    // Branch name remains accessible via the button's aria-label (and is
    // copied to clipboard on click).
    expect(screen.getByText("Add feature")).toBeInTheDocument();
    expect(screen.queryByText("feature-branch")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Copy branch name feature-branch/i }),
    ).toBeInTheDocument();
    expect(screen.getByTitle("PR #42")).toBeInTheDocument();
    expect(screen.getByText(/CI/)).toBeInTheDocument();
  });

  it("shows pending review button when local line comments exist", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "pending", total: 1, passed: 0, failed: 0, pending: 1 },
    });

    const { rerender } = render(<PrLifecycleCard sessionId="s1" />);
    expect(screen.queryByRole("button", { name: /Send review/i })).not.toBeInTheDocument();

    useCommentStore.getState().addLineComment("s1", "src/a.ts", 10, "Needs a guard");
    rerender(<PrLifecycleCard sessionId="s1" />);
    expect(screen.getByRole("button", { name: /Send review \(1\)/i })).toBeInTheDocument();
  });

  it("submits pending review comments and clears them on success", async () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "pending", total: 1, passed: 0, failed: 0, pending: 1 },
    });
    useCommentStore.getState().addLineComment("s1", "src/a.ts", 10, "Needs a guard");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, count: 1 }),
    } as Response);

    render(<PrLifecycleCard sessionId="s1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send review \(1\)/i }));
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/pr/review", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        comments: [{ path: "src/a.ts", line: 10, body: "Needs a guard" }],
      }),
    }));
    expect(useCommentStore.getState().getCommentCount("s1")).toBe(0);
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

    expect(screen.getByText("Fix CI")).toBeInTheDocument();
  });

  it("shows auto-fix toggle when CI fails (inside overflow menu)", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    fireEvent.click(screen.getByLabelText("More options"));
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
    expect(screen.getByText("Fix CI")).toBeInTheDocument();
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

    expect(screen.queryByText("Fix CI")).toBeNull();
    // Auto-fix toggle should not appear even in overflow menu
    fireEvent.click(screen.getByLabelText("More options"));
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

  it("does not render merge button when checks status is undefined (poller hasn't run yet)", () => {
    // After PR creation, the card transitions to "open" before the poller has
    // delivered any check status. The merge button must stay hidden during
    // this gap — otherwise the user could merge before workflows register.
    setCard("s1", {
      ...openPrCard,
      // No `checks` field — simulates the moment between quick-create
      // returning and the first SSE pr_status update arriving.
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

  it("disables merge button when the agent is mid-turn", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
    });
    useSessionStore.setState({ activeRunnerSessions: new Set(["s1"]) });

    render(<PrLifecycleCard sessionId="s1" />);

    const button = screen.getByText("Squash and merge");
    expect(button).toBeDisabled();
    // The tooltip explains why so the disabled state isn't a mystery.
    expect(button.getAttribute("title")).toContain("Agent is still working");
  });

  it("re-enables merge button when the agent finishes mid-render", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
    });
    useSessionStore.setState({ activeRunnerSessions: new Set(["s1"]) });
    const { rerender } = render(<PrLifecycleCard sessionId="s1" />);
    expect(screen.getByText("Squash and merge")).toBeDisabled();

    useSessionStore.setState({ activeRunnerSessions: new Set<string>() });
    rerender(<PrLifecycleCard sessionId="s1" />);
    expect(screen.getByText("Squash and merge")).not.toBeDisabled();
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

  it("renders auto-merge toggle when CI passed (inside overflow menu)", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    fireEvent.click(screen.getByLabelText("More options"));
    expect(screen.getByText("Auto-merge")).toBeInTheDocument();
  });

  it("resets the 'Merging...' state when the sessionId prop changes", async () => {
    // Regression: switching sessions while a merge was in flight used to leave
    // the button stuck on "Merging..." against the new session because the
    // local React state in MergeButton survived the prop change.
    setCard("s1", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
    });
    setCard("s2", {
      ...openPrCard,
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
    });

    // Mock fetch with a never-resolving promise so the merge stays "in flight".
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    try {
      const { rerender } = render(<PrLifecycleCard sessionId="s1" />);

      // Click the merge button to flip merging=true.
      await act(async () => {
        fireEvent.click(screen.getByText("Squash and merge"));
      });
      expect(screen.getByText("Merging...")).toBeInTheDocument();

      // Switch sessions — the merging state for s1 must not bleed into s2.
      rerender(<PrLifecycleCard sessionId="s2" />);

      expect(screen.queryByText("Merging...")).toBeNull();
      expect(screen.getByText("Squash and merge")).toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
    }
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

    expect(screen.getByText(/Merged: Add feature/)).toBeInTheDocument();
    expect(screen.getByTitle("PR #42 merged")).toBeInTheDocument();
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
    // Generic errors do NOT show the "Sign in" action — that's reserved
    // for auth-classified errors so it stays meaningful when surfaced.
    expect(screen.queryByText("Sign in to GitHub")).toBeNull();
  });

  it("surfaces a Sign in to GitHub action when the error is auth-classified", () => {
    setCard("s1", {
      cardId: "c1",
      phase: "error",
      errorMessage: "Not authenticated with GitHub",
      errorKind: "auth",
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/Not authenticated with GitHub/)).toBeInTheDocument();
    expect(screen.getByText(/reconnect to keep pushing/)).toBeInTheDocument();
    expect(screen.getByText("Sign in to GitHub")).toBeInTheDocument();
  });

  // ---- 113: Inline merge-conflict UI ----

  describe("merge-conflict UI", () => {
    it("hides the merge button when GitHub reports the PR as conflicting", () => {
      setCard("s1", {
        ...openPrCard,
        checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
      });
      setMergeable("s1", "conflicting");

      render(<PrLifecycleCard sessionId="s1" />);

      expect(screen.queryByText("Squash and merge")).toBeNull();
    });

    it("keeps the merge button visible when mergeability is unknown (avoid post-push flicker)", () => {
      // GitHub returns UNKNOWN briefly after each push while it computes
      // mergeability. Gating the button on this state would flicker it
      // off-on every push — worse UX than letting an occasional click
      // fail with the existing 405 toast.
      setCard("s1", {
        ...openPrCard,
        checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
      });
      setMergeable("s1", "unknown");

      render(<PrLifecycleCard sessionId="s1" />);

      expect(screen.getByText("Squash and merge")).toBeInTheDocument();
    });

    it("renders the conflict indicator and Resolve conflicts button when conflicting", () => {
      setCard("s1", {
        ...openPrCard,
        checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
      });
      setMergeable("s1", "conflicting");

      render(<PrLifecycleCard sessionId="s1" />);

      expect(screen.getByText("Merge conflicts")).toBeInTheDocument();
      expect(screen.getByText("Resolve conflicts")).toBeInTheDocument();
    });

    it("hides the conflict UI when a rebase is already in progress", () => {
      // RebaseBanner takes over the surface during the rebase. The PR card
      // shouldn't double-render the same affordance.
      setCard("s1", {
        ...openPrCard,
        checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
      });
      setMergeable("s1", "conflicting");
      useGitStore.setState({ rebaseStatus: "in_progress" });

      render(<PrLifecycleCard sessionId="s1" />);

      expect(screen.queryByText("Merge conflicts")).toBeNull();
      expect(screen.queryByText("Resolve conflicts")).toBeNull();
    });

    it("disables the Resolve conflicts button while the agent is in a turn", () => {
      setCard("s1", {
        ...openPrCard,
        checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
      });
      setMergeable("s1", "conflicting");
      useSessionStore.setState({ activeRunnerSessions: new Set(["s1"]) });

      render(<PrLifecycleCard sessionId="s1" />);

      const button = screen.getByText("Resolve conflicts").closest("button");
      expect(button).toBeDisabled();
    });

    it("calls startRebase with the PR's base branch on click — no confirmation, no chat prefill", async () => {
      // The exception to "chat is the input surface" lives here: clicking
      // fires the rebase driver directly. There is no toast, no chat box
      // mutation, no second confirmation step.
      setCard("s1", {
        ...openPrCard,
        pr: {
          number: 42,
          title: "Add feature",
          url: "https://github.com/o/r/pull/42",
          baseBranch: "develop",
          headBranch: "feature-branch",
          insertions: 100,
          deletions: 20,
        },
        checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
      });
      setMergeable("s1", "conflicting");

      const startRebase = vi.fn().mockResolvedValue(undefined);
      useGitStore.setState({ startRebase });

      render(<PrLifecycleCard sessionId="s1" />);

      await act(async () => {
        fireEvent.click(screen.getByText("Resolve conflicts"));
      });

      expect(startRebase).toHaveBeenCalledTimes(1);
      expect(startRebase).toHaveBeenCalledWith("s1", "develop");
    });

    it("does not call startRebase if the agent is running when clicked", async () => {
      // Disabled buttons don't fire onClick by default in the DOM, but the
      // handler is also defensively guarded — verify both layers hold.
      setCard("s1", {
        ...openPrCard,
        checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
      });
      setMergeable("s1", "conflicting");
      useSessionStore.setState({ activeRunnerSessions: new Set(["s1"]) });

      const startRebase = vi.fn().mockResolvedValue(undefined);
      useGitStore.setState({ startRebase });

      render(<PrLifecycleCard sessionId="s1" />);

      await act(async () => {
        fireEvent.click(screen.getByText("Resolve conflicts"));
      });

      expect(startRebase).not.toHaveBeenCalled();
    });
  });
});

// ---- PrStateBadge ----

describe("PrStateBadge", () => {
  it("renders branch badge when no status or card exists", () => {
    render(<PrStateBadge sessionId="empty" />);
    expect(screen.getByTitle("Branch")).toBeInTheDocument();
  });

  it("renders merged badge from poller status", () => {
    setStatus("s1", "merged");

    render(<PrStateBadge sessionId="s1" />);

    expect(screen.getByTitle("PR merged")).toBeInTheDocument();
  });

  it("renders open badge for open PR", () => {
    setStatus("s1", "open", "success");

    render(<PrStateBadge sessionId="s1" />);

    expect(screen.getByTitle("PR open")).toBeInTheDocument();
  });

  it("renders open badge regardless of CI state", () => {
    setStatus("s1", "open", "failure");

    render(<PrStateBadge sessionId="s1" />);

    expect(screen.getByTitle("PR open")).toBeInTheDocument();
  });

  it("renders branch badge for closed PR", () => {
    usePrStore.setState({
      statusBySession: {
        s1: {
          sessionId: "s1",
          prNumber: 1,
          prUrl: "https://github.com/o/r/pull/1",
          prTitle: "Test PR",
          prBody: "",
          prState: "closed",
          baseBranch: "main",
          headBranch: "feature",
          insertions: 10,
          deletions: 5,
          checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
          mergeable: "unknown",
          autoMergeEnabled: false,
        },
      },
    });

    render(<PrStateBadge sessionId="s1" />);

    expect(screen.getByTitle("PR closed")).toBeInTheDocument();
  });
});

// ---- Card → PR detail tab (docs/133) ----

describe("PrLifecycleCard — open PR details", () => {
  it("calls onOpenDetails when the card body is clicked (open PR)", () => {
    setCard("s1", openPrCard);
    const onOpenDetails = vi.fn();
    const { container } = render(
      <PrLifecycleCard sessionId="s1" onOpenDetails={onOpenDetails} />,
    );
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onOpenDetails when an interactive control is clicked", () => {
    setCard("s1", {
      ...openPrCard,
      checks: { state: "failure", total: 3, passed: 2, failed: 1, pending: 0 },
      autoFix: { enabled: false, status: "idle", attemptCount: 0, maxAttempts: 3 },
    });
    const onOpenDetails = vi.fn();
    render(<PrLifecycleCard sessionId="s1" onOpenDetails={onOpenDetails} />);

    // Opening the overflow menu (a button) must not switch the tab.
    fireEvent.click(screen.getByLabelText("More options"));
    expect(onOpenDetails).not.toHaveBeenCalled();

    // Toggling auto-fix (a button inside the menu) must not switch the tab.
    fireEvent.click(screen.getByText("Auto-fix"));
    expect(onOpenDetails).not.toHaveBeenCalled();
  });

  it("is not clickable in the ready phase (no PR yet)", () => {
    setCard("s1", { cardId: "c1", phase: "ready", totalInsertions: 5, totalDeletions: 1 });
    const onOpenDetails = vi.fn();
    const { container } = render(
      <PrLifecycleCard sessionId="s1" onOpenDetails={onOpenDetails} />,
    );
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onOpenDetails).not.toHaveBeenCalled();
  });
});
