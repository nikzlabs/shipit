import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SessionMessageProposalCard } from "./SessionMessageProposalCard.js";
import { useSessionStore } from "../stores/session-store.js";
import type { SessionMessageProposalCard as CardData } from "../../server/shared/types.js";

function card(over: Partial<CardData> = {}): CardData {
  return {
    cardId: "smp-1",
    targetSessionId: "ses_root",
    targetTitle: "Orchestrator",
    message: "docs/314 is implemented; the PR is open.",
    createdAt: "2026-09-22T10:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  useSessionStore.setState({ sessions: [], sessionId: undefined });
});
afterEach(() => cleanup());

describe("SessionMessageProposalCard", () => {
  // req 2 — the user sees the target and the whole message before acting.
  it("names the target session and shows the message", () => {
    render(<SessionMessageProposalCard card={card()} />);
    expect(screen.getByText("Orchestrator")).toBeInTheDocument();
    expect(screen.getByTestId("session-message-proposal-body")).toHaveTextContent(/docs\/314 is implemented/);
  });

  it("delivers on one click, passing the card id", async () => {
    const onDeliver = vi.fn<(cardId: string) => Promise<void>>(async () => {});
    render(<SessionMessageProposalCard card={card()} onDeliver={onDeliver} />);

    fireEvent.click(screen.getByRole("button", { name: /Send to Orchestrator/ }));
    await waitFor(() => expect(onDeliver).toHaveBeenCalledWith("smp-1"));
  });

  it("can show a long message in full, since the click approves that exact text", () => {
    const long = "Here is the full report of what happened. ".repeat(20);
    render(<SessionMessageProposalCard card={card({ message: long })} />);

    expect(screen.getByTestId("session-message-proposal-body")).toHaveClass("line-clamp-6");
    fireEvent.click(screen.getByRole("button", { name: /Show the whole message/ }));
    expect(screen.getByTestId("session-message-proposal-body")).not.toHaveClass("line-clamp-6");
  });

  // req 5 — delivered is terminal, so a second turn cannot be started by clicking again.
  it("offers no send button once delivered", () => {
    render(<SessionMessageProposalCard card={card({ state: "delivered", deliveredAt: "x" })} />);
    expect(screen.queryByRole("button", { name: /Send to/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("session-message-proposal-status")).toHaveTextContent(
      "Delivered to Orchestrator",
    );
  });

  it("says a delivery landed in the target's queue", () => {
    render(<SessionMessageProposalCard card={card({ state: "delivered", queued: true })} />);
    expect(screen.getByTestId("session-message-proposal-status")).toHaveTextContent(/Queued behind/);
  });

  it("shows why a delivery failed and offers a retry", () => {
    render(
      <SessionMessageProposalCard card={card({ state: "failed", errorMessage: "Orchestrator is archived" })} />,
    );
    expect(screen.getByTestId("session-message-proposal-error")).toHaveTextContent("archived");
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("surfaces a request that could not even be made", async () => {
    const onDeliver = vi.fn<(cardId: string) => Promise<void>>(async () => {
      throw new Error("Network down");
    });
    render(<SessionMessageProposalCard card={card()} onDeliver={onDeliver} />);

    fireEvent.click(screen.getByRole("button", { name: /Send to Orchestrator/ }));
    await waitFor(() =>
      expect(screen.getByTestId("session-message-proposal-error")).toHaveTextContent("Network down"),
    );
  });

  /**
   * A card loaded as `delivering` is a leftover — the live state always arrives
   * as an update — so it must stay clickable rather than spin forever.
   */
  it("stays clickable when it loads already delivering", () => {
    render(<SessionMessageProposalCard card={card({ state: "delivering" })} />);
    expect(screen.getByRole("button", { name: /Send to Orchestrator/ })).toBeEnabled();
  });

  it("opens the target session once delivered", () => {
    const onOpenSession = vi.fn();
    render(
      <SessionMessageProposalCard
        card={card({ state: "delivered" })}
        onOpenSession={onOpenSession}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open session/ }));
    expect(onOpenSession).toHaveBeenCalledWith("ses_root");
  });
});
