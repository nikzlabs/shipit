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

// ---- PrLifecycleCard ----

describe("PrLifecycleCard", () => {
  it("renders nothing when no card exists for session", () => {
    const { container } = render(<PrLifecycleCard sessionId="no-card" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders ready phase with file list and create button", () => {
    setCard("s1", {
      cardId: "c1",
      phase: "ready",
      files: [
        { path: "src/app.ts", status: "M", insertions: 10, deletions: 2 },
        { path: "src/new.ts", status: "A", insertions: 20, deletions: 0 },
      ],
      totalInsertions: 30,
      totalDeletions: 2,
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/changed 2 files/)).toBeInTheDocument();
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("src/new.ts")).toBeInTheDocument();
    expect(screen.getByText("Create Pull Request")).toBeInTheDocument();
    expect(screen.getByText("Create with options...")).toBeInTheDocument();
  });

  it("renders creating phase with spinner text", () => {
    setCard("s1", { cardId: "c1", phase: "creating" });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText("Creating pull request...")).toBeInTheDocument();
  });

  it("renders open phase with PR info", () => {
    setCard("s1", {
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
      checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/PR #42: Add feature/)).toBeInTheDocument();
    expect(screen.getByText("View PR")).toBeInTheDocument();
    expect(screen.getByText(/CI passed/)).toBeInTheDocument();
  });

  it("renders open phase with failing checks", () => {
    setCard("s1", {
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
      checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/CI failed/)).toBeInTheDocument();
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

    expect(screen.getByText("Failed to create pull request")).toBeInTheDocument();
    expect(screen.getByText(/"Branch has no commits"/)).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("shows singular 'file' for 1 file in ready phase", () => {
    setCard("s1", {
      cardId: "c1",
      phase: "ready",
      files: [
        { path: "src/app.ts", status: "M", insertions: 5, deletions: 1 },
      ],
      totalInsertions: 5,
      totalDeletions: 1,
    });

    render(<PrLifecycleCard sessionId="s1" />);

    expect(screen.getByText(/changed 1 file$/)).toBeInTheDocument();
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
