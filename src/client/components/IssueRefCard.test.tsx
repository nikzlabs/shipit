import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { IssueRefCard } from "./IssueRefCard.js";
import type { IssueRefCard as IssueRefCardData } from "../../server/shared/types.js";
import { useIssuesStore } from "../stores/issues-store.js";

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

  // docs/248-declared-issue-trackers req 16 — a reference resolves when it is USED. A read card records
  // the name it was addressed through, so re-pointing that name in shipit.yaml
  // re-targets the card, exactly as it re-targets a write card.
  it("opens the name's CURRENT destination after a re-point", () => {
    useIssuesStore.setState({
      trackers: [
        {
          id: "github:acme/moved",
          kind: "github",
          label: "planning",
          name: "planning",
          configured: true,
        },
      ],
    });
    const onOpen = vi.fn();
    render(
      <IssueRefCard
        card={card({ tracker: "github:acme/original", trackerName: "planning" })}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByTestId("issue-ref-card"));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ tracker: "github:acme/moved" }),
    );
  });

  // The name is gone from shipit.yaml entirely — fall back to the destination the
  // read actually reached rather than dropping the affordance.
  it("falls back to the recorded destination when the name is no longer declared", () => {
    useIssuesStore.setState({ trackers: [] });
    const onOpen = vi.fn();
    render(
      <IssueRefCard
        card={card({ tracker: "github:acme/original", trackerName: "planning" })}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByTestId("issue-ref-card"));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ tracker: "github:acme/original" }),
    );
  });
});
