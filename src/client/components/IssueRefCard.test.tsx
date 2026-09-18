import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { IssueRefCard } from "./IssueRefCard.js";
import type { IssueRefCard as IssueRefCardData } from "../../server/shared/types.js";
import { useIssuesStore } from "../stores/issues-store.js";

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
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByTestId("issue-ref-card"));
    expect(onOpen).toHaveBeenCalledWith({
      tracker: "github",
      identifier: "octocat/hello#42",
      title: "An open issue",
      url: "https://github.com/octocat/hello/issues/42",
    });
  });

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
