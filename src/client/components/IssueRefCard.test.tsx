import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { IssueRefCard } from "./IssueRefCard.js";
import type { IssueRefCard as IssueRefCardData } from "../../server/shared/types.js";

/**
 * Tests for the read-only `IssueRefCard` (docs/188, docs/189). The card renders
 * straight from its props (no store, no lifecycle). docs/189 changed the click
 * affordance: the card now opens ShipIt's inline detail view instead of linking
 * out to the tracker, so these cover the navigation line and the `onOpen` call.
 */

function card(over: Partial<IssueRefCardData> = {}): IssueRefCardData {
  return {
    cardId: "ref-1",
    tracker: "github",
    identifier: "octocat/hello#42",
    title: "An open issue",
    url: "https://github.com/octocat/hello/issues/42",
    status: "Open",
    statusType: "started",
    createdAt: "2026-06-03T00:00:00.000Z",
    ...over,
  };
}

afterEach(() => cleanup());

describe("IssueRefCard", () => {
  it("renders the viewed identifier, title, and status", () => {
    render(<IssueRefCard card={card()} />);
    expect(screen.getByText(/Agent viewed/)).toBeInTheDocument();
    expect(screen.getByText("octocat/hello#42")).toBeInTheDocument();
    expect(screen.getByText("An open issue")).toBeInTheDocument();
    expect(screen.getByText(/Open/)).toBeInTheDocument();
  });

  it("opens the inline detail view on click instead of linking out (docs/189)", () => {
    const onOpen = vi.fn();
    render(<IssueRefCard card={card()} onOpen={onOpen} />);
    // No external link — the deep link lives only inside the detail view now.
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByTestId("issue-ref-card"));
    expect(onOpen).toHaveBeenCalledWith({
      tracker: "github",
      identifier: "octocat/hello#42",
      title: "An open issue",
      url: "https://github.com/octocat/hello/issues/42",
    });
  });
});
