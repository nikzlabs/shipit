import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { PrDetailPanel } from "./PrDetailPanel.js";
import { usePrStore } from "../stores/pr-store.js";
import type { PrCardState } from "../stores/pr-store.js";

beforeEach(() => {
  usePrStore.setState({ statusBySession: {}, cardBySession: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  describe("Phase 2 — editing", () => {
    it("edits the title via PATCH and optimistically updates", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ number: 42 }), { status: 200 }));
      setCard("s1", openPrCard);
      render(<PrDetailPanel sessionId="s1" />);

      fireEvent.click(screen.getByLabelText("Edit title"));
      const input = screen.getByLabelText("PR title") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "A better title" } });
      fireEvent.click(screen.getByLabelText("Save title"));

      await waitFor(() => {
        expect(screen.getByText("A better title")).toBeInTheDocument();
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/s1/pr/42",
        expect.objectContaining({ method: "PATCH" }),
      );
      // Optimistic store update applied.
      expect(usePrStore.getState().cardBySession.s1.pr?.title).toBe("A better title");
    });

    it("reverts the title and shows an error banner when the PATCH fails", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: "nope" }), { status: 500 }),
      );
      setCard("s1", openPrCard);
      render(<PrDetailPanel sessionId="s1" />);

      fireEvent.click(screen.getByLabelText("Edit title"));
      fireEvent.change(screen.getByLabelText("PR title"), {
        target: { value: "Broken title" },
      });
      fireEvent.click(screen.getByLabelText("Save title"));

      await waitFor(() => {
        expect(screen.getByText("nope")).toBeInTheDocument();
      });
      // Reverted to the original.
      expect(usePrStore.getState().cardBySession.s1.pr?.title).toBe("Add inline PR detail panel");
    });

    it("edits the description body via PATCH", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ number: 42 }), { status: 200 }));
      setCard("s1", openPrCard);
      render(<PrDetailPanel sessionId="s1" />);

      fireEvent.click(screen.getByLabelText("Edit description"));
      const textarea = screen.getByPlaceholderText(/Describe this pull request/i);
      fireEvent.change(textarea, { target: { value: "Updated body text" } });
      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => {
        expect(screen.getByText("Updated body text")).toBeInTheDocument();
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/s1/pr/42",
        expect.objectContaining({ method: "PATCH" }),
      );
    });

    it("does not offer editing affordances for a merged PR", () => {
      setCard("s1", { ...openPrCard, phase: "merged" });
      render(<PrDetailPanel sessionId="s1" />);
      expect(screen.queryByLabelText("Edit title")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Edit description")).not.toBeInTheDocument();
    });
  });
});
