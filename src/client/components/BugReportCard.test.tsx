import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { BugReportCard } from "./BugReportCard.js";
import { useBugReportStore, type BugReportCardState } from "../stores/bug-report-store.js";

/**
 * Tests for the in-chat `BugReportCard` (docs/164). The card reads its live
 * payload + lifecycle from the bug-report store keyed by cardId. These cover
 * the consent gate (Submit fires the handler with the edited fields), the
 * Stage-2 "didn't run" flag, the filed terminal state, and the scope-error
 * banner on a failed submit.
 */

const CARD_ID = "bug-card-1";

function seedCard(overrides: Partial<Omit<BugReportCardState, "phase">> = {}) {
  useBugReportStore.getState().reset();
  useBugReportStore.getState().upsertCard({
    cardId: CARD_ID,
    title: "Preview won't reload",
    body: "It broke.\n\n---\nFiled via ShipIt · build abc123 · source session",
    stage2Ran: true,
    producer: "session",
    filedAs: "octocat",
    ...overrides,
  });
}

beforeEach(() => {
  seedCard();
});

afterEach(() => {
  cleanup();
  useBugReportStore.getState().reset();
});

describe("BugReportCard", () => {
  it("renders the editable title/body and the author transparency line", () => {
    render(<BugReportCard cardId={CARD_ID} />);
    expect((screen.getByLabelText("Bug report title") as HTMLInputElement).value).toBe(
      "Preview won't reload",
    );
    expect(screen.getByText(/@octocat/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is sent until you click Submit/)).toBeInTheDocument();
  });

  it("flags a missed Stage-2 redaction pass", () => {
    useBugReportStore.getState().reset();
    seedCard({ stage2Ran: false });
    render(<BugReportCard cardId={CARD_ID} />);
    expect(screen.getByText(/deep privacy check didn’t run/)).toBeInTheDocument();
  });

  it("does not flag when Stage 2 ran", () => {
    render(<BugReportCard cardId={CARD_ID} />);
    expect(screen.queryByText(/deep privacy check didn’t run/)).not.toBeInTheDocument();
  });

  it("submits the edited title and body and moves to a filing state", () => {
    const onSubmit = vi.fn();
    render(<BugReportCard cardId={CARD_ID} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Bug report title"), {
      target: { value: "Edited title" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit report/i }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toBe(CARD_ID);
    expect(onSubmit.mock.calls[0][1]).toBe("Edited title");
    // The card optimistically flips to a disabled "Filing…" state.
    expect(screen.getByRole("button", { name: /filing/i })).toBeDisabled();
  });

  it("renders the filed terminal state with a View on GitHub link", () => {
    useBugReportStore.getState().setFiled(CARD_ID, 1234, "https://github.com/nicolasalt/shipit/issues/1234");
    render(<BugReportCard cardId={CARD_ID} />);
    expect(screen.getByText(/#1234/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /view on github/i });
    expect(link).toHaveAttribute("href", "https://github.com/nicolasalt/shipit/issues/1234");
  });

  it("surfaces a scope error and stays editable so the user can retry", () => {
    useBugReportStore.getState().setFiling(CARD_ID);
    useBugReportStore
      .getState()
      .setFailed(CARD_ID, "Your GitHub token can't file issues on the ShipIt repo. Reconnect …", true);
    render(<BugReportCard cardId={CARD_ID} />);
    expect(screen.getByText(/can't file issues on the ShipIt repo/)).toBeInTheDocument();
    // Back to an editable draft — Submit is available again.
    expect(screen.getByRole("button", { name: /submit report/i })).toBeEnabled();
  });

  it("dismisses the card on Cancel without invoking onSubmit", () => {
    const onSubmit = vi.fn();
    render(<BugReportCard cardId={CARD_ID} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/nothing was sent/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Bug report title")).not.toBeInTheDocument();
  });

  it("renders nothing when the card is unknown (e.g. after a reload)", () => {
    const { container } = render(<BugReportCard cardId="missing" />);
    expect(container).toBeEmptyDOMElement();
  });
});
