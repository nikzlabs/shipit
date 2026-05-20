import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PrDetailPanel } from "./PrDetailPanel.js";
import { usePrStore } from "../stores/pr-store.js";
import type { PrCardState } from "../stores/pr-store.js";

beforeEach(() => {
  usePrStore.setState({ statusBySession: {}, cardBySession: {} });
});

afterEach(cleanup);

function setCard(sessionId: string, card: PrCardState) {
  usePrStore.setState((s) => ({
    cardBySession: { ...s.cardBySession, [sessionId]: card },
  }));
}

const openPrCard: PrCardState = {
  cardId: "c1",
  phase: "open",
  pr: {
    number: 42,
    title: "Add inline PR detail panel",
    body: "## Summary\n\nThis PR adds the panel.",
    url: "https://github.com/o/r/pull/42",
    baseBranch: "main",
    headBranch: "feature-branch",
    insertions: 100,
    deletions: 20,
  },
  checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
};

describe("PrDetailPanel", () => {
  it("shows an empty state when the session has no PR", () => {
    render(<PrDetailPanel sessionId="none" />);
    expect(screen.getByText(/No pull request for this session/i)).toBeInTheDocument();
  });

  it("renders header, number, branches, and diff stats", () => {
    setCard("s1", openPrCard);
    render(<PrDetailPanel sessionId="s1" />);

    expect(screen.getByText("Add inline PR detail panel")).toBeInTheDocument();
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("feature-branch")).toBeInTheDocument();
    expect(screen.getByText("+100")).toBeInTheDocument();
    expect(screen.getByText("-20")).toBeInTheDocument();
  });

  it("renders the markdown description body", () => {
    setCard("s1", openPrCard);
    render(<PrDetailPanel sessionId="s1" />);
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("This PR adds the panel.")).toBeInTheDocument();
  });

  it("shows a placeholder when there is no description", () => {
    setCard("s1", { ...openPrCard, pr: { ...openPrCard.pr!, body: undefined } });
    render(<PrDetailPanel sessionId="s1" />);
    expect(screen.getByText(/No description provided/i)).toBeInTheDocument();
  });

  it("renders a passing checks summary in the Status section", () => {
    setCard("s1", openPrCard);
    render(<PrDetailPanel sessionId="s1" />);
    expect(screen.getByText("3/3 checks passed")).toBeInTheDocument();
  });

  it("lists failed checks when CI is failing", () => {
    setCard("s1", {
      ...openPrCard,
      checks: {
        state: "failure",
        total: 3,
        passed: 2,
        failed: 1,
        pending: 0,
        failedChecks: [{ name: "lint", summary: "2 errors" }],
      },
    });
    render(<PrDetailPanel sessionId="s1" />);
    expect(screen.getByText(/1 of 3 checks failing/i)).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
  });

  it("exposes the View on GitHub link in the overflow menu", () => {
    setCard("s1", openPrCard);
    render(<PrDetailPanel sessionId="s1" />);

    // Link is behind the overflow menu, not on the happy path (docs/133 §2).
    expect(screen.queryByText("View on GitHub")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("More options"));
    const link = screen.getByText("View on GitHub").closest("a");
    expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/42");
  });

  it("offers a View full diff button in the Files section", () => {
    setCard("s1", openPrCard);
    render(<PrDetailPanel sessionId="s1" />);
    expect(screen.getByText("View full diff")).toBeInTheDocument();
  });
});
