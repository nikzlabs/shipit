import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { IssueWriteCard } from "./IssueWriteCard.js";
import { useIssueWriteStore } from "../stores/issue-write-store.js";
import type { IssueWriteCard as IssueWriteCardData } from "../../server/shared/types.js";

/**
 * Tests for the redesigned issue-write provenance card (docs/189). The card
 * reads its payload + undo lifecycle from the issue-write store keyed by cardId.
 * These cover: the content-led layout (explicit verb + bold identifier, faint
 * title, verb-specific line 2), the dropped attribution line, and the undone
 * terminal state.
 */

const CARD_ID = "iw-1";

const base: IssueWriteCardData = {
  cardId: CARD_ID,
  tracker: "linear",
  issueId: "SHI-48",
  identifier: "SHI-48",
  title: "Rewind handle hugs long user bubbles",
  url: "https://linear.app/x/issue/SHI-48",
  verb: "comment",
  summary: "commented on SHI-48",
  attribution: "workspace",
  undo: { kind: "comment", commentId: "c-1" },
  undoState: "available",
  createdAt: "2026-06-05T00:00:00.000Z",
};

function seed(overrides: Partial<IssueWriteCardData> = {}) {
  useIssueWriteStore.getState().reset();
  useIssueWriteStore.getState().upsertCard({ ...base, ...overrides });
}

afterEach(() => {
  cleanup();
  useIssueWriteStore.getState().reset();
});

describe("IssueWriteCard (docs/189)", () => {
  it("renders nothing when the card is unknown (e.g. after a reload)", () => {
    useIssueWriteStore.getState().reset();
    const { container } = render(<IssueWriteCard cardId="missing" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("never renders the attribution / workspace-token line", () => {
    seed({ attribution: "workspace" });
    render(<IssueWriteCard cardId={CARD_ID} />);
    expect(screen.queryByText(/workspace token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/by the ShipIt agent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/by you/i)).not.toBeInTheDocument();
  });

  it("leads with an explicit verb + the identifier and shows the faint title", () => {
    seed({ verb: "comment", content: { comment: "Confirmed on staging." } });
    render(<IssueWriteCard cardId={CARD_ID} />);
    expect(screen.getByText("Commented on")).toBeInTheDocument();
    // Identifier appears exactly once (no duplicate chip).
    expect(screen.getAllByText("SHI-48")).toHaveLength(1);
    expect(screen.getByText("Rewind handle hugs long user bubbles")).toBeInTheDocument();
    expect(screen.getByText("Confirmed on staging.")).toBeInTheDocument();
  });

  it("renders a title delta and 'description updated' for an edit", () => {
    seed({
      verb: "edit",
      summary: "edited title & description on SHI-48",
      content: {
        title: { before: "Rewind handle bug", after: "Rewind handle hugs long user bubbles" },
        descriptionChanged: true,
      },
    });
    render(<IssueWriteCard cardId={CARD_ID} />);
    expect(screen.getByText("Edited")).toBeInTheDocument();
    expect(screen.getByText("Rewind handle bug")).toBeInTheDocument();
    expect(screen.getByText("description updated")).toBeInTheDocument();
  });

  it("renders a status transition for a status write", () => {
    seed({
      verb: "status",
      summary: "set SHI-48 → In Review",
      content: { status: { from: "In Progress", to: "In Review" } },
    });
    render(<IssueWriteCard cardId={CARD_ID} />);
    expect(screen.getByText("Set status of")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("In Review")).toBeInTheDocument();
  });

  it("renders the new assignee for an assignee write", () => {
    seed({ verb: "assignee", summary: "assigned SHI-48 → Nik", content: { assignee: "Nik Zherebtsov" } });
    render(<IssueWriteCard cardId={CARD_ID} />);
    expect(screen.getByText("Assigned")).toBeInTheDocument();
    expect(screen.getByText("Nik Zherebtsov")).toBeInTheDocument();
  });

  it("shows 'Unassigned' and no assignee line when the assignee was cleared", () => {
    seed({ verb: "assignee", summary: "unassigned SHI-48", content: { assignee: null } });
    render(<IssueWriteCard cardId={CARD_ID} />);
    expect(screen.getByText(/Unassigned/)).toBeInTheDocument();
  });

  it("fires onUndo with the cardId and disables while undoing", () => {
    const onUndo = vi.fn();
    seed({ undoState: "undoing" });
    render(<IssueWriteCard cardId={CARD_ID} onUndo={onUndo} />);
    const btn = screen.getByRole("button", { name: /undoing/i });
    expect(btn).toBeDisabled();
  });

  it("calls onUndo (and not onOpen) when Undo is clicked", () => {
    const onUndo = vi.fn();
    const onOpen = vi.fn();
    seed();
    render(<IssueWriteCard cardId={CARD_ID} onUndo={onUndo} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /^undo$/i }));
    expect(onUndo).toHaveBeenCalledWith(CARD_ID);
    // Undo stops propagation so it doesn't also open the issue.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens the inline detail view (not a link-out) when the card is clicked", () => {
    const onOpen = vi.fn();
    seed();
    render(<IssueWriteCard cardId={CARD_ID} onOpen={onOpen} />);
    // The whole card is the open affordance — no separate glyph.
    fireEvent.click(screen.getByTestId("issue-write-card"));
    expect(onOpen).toHaveBeenCalledWith({
      tracker: "linear",
      identifier: "SHI-48",
      title: "Rewind handle hugs long user bubbles",
      url: "https://linear.app/x/issue/SHI-48",
    });
  });

  it("opens the issue on Enter/Space when the card is focused (keyboard)", () => {
    const onOpen = vi.fn();
    seed();
    render(<IssueWriteCard cardId={CARD_ID} onOpen={onOpen} />);
    fireEvent.keyDown(screen.getByTestId("issue-write-card"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("collapses to a struck-through summary with no Undo once undone", () => {
    seed({ undoState: "undone", content: { comment: "Confirmed on staging." } });
    render(<IssueWriteCard cardId={CARD_ID} />);
    expect(screen.getByText(/Commented on SHI-48/)).toBeInTheDocument();
    expect(screen.getByText(/undone/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /undo/i })).not.toBeInTheDocument();
    // Line 2 (comment preview) is suppressed in the terminal state.
    expect(screen.queryByText("Confirmed on staging.")).not.toBeInTheDocument();
  });

  it("re-offers Undo and surfaces the error after a failed undo", () => {
    seed({ undoState: "failed", errorMessage: "Linear API rejected the delete" });
    render(<IssueWriteCard cardId={CARD_ID} />);
    expect(screen.getByText(/Linear API rejected the delete/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry undo/i })).toBeEnabled();
  });
});
