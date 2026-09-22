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

/**
 * jsdom lays nothing out, so `line-clamp-6` never reports an overflow on its
 * own — the component's clipping check would read false for every message and
 * the expander test would prove nothing. Drive the measurement explicitly.
 */
function setBodyOverflow(overflowing: boolean): void {
  const body = screen.getByTestId("session-message-proposal-body");
  Object.defineProperty(body, "scrollHeight", { value: overflowing ? 200 : 40, configurable: true });
  Object.defineProperty(body, "clientHeight", { value: 40, configurable: true });
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

  // req 5 — one approval is one delivery, so an impatient second click while the
  // first request is still open must not produce a second one.
  it("ignores a click while a delivery is in flight", async () => {
    let release = (): void => {};
    const onDeliver = vi.fn<(cardId: string) => Promise<void>>(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    render(<SessionMessageProposalCard card={card()} onDeliver={onDeliver} />);

    fireEvent.click(screen.getByRole("button", { name: /Send to Orchestrator/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Sending/ })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /Sending/ }));

    expect(onDeliver).toHaveBeenCalledTimes(1);
    release();
  });

  /**
   * req 2 — the text the user approves must be reachable in full. The offer is
   * driven by MEASURED overflow, not by a character count: six short lines, or a
   * narrow column that wraps, clip a message far under any cap. The failing case
   * is exactly this one — short enough to look safe, clipped anyway.
   */
  it("offers the expander for a SHORT message the clamp still clips", () => {
    const sixLinesPlus = "one\ntwo\nthree\nfour\nfive\nsix\nand the part that matters";
    expect(sixLinesPlus.length).toBeLessThan(280);
    const { rerender } = render(<SessionMessageProposalCard card={card({ message: sixLinesPlus })} />);

    setBodyOverflow(true);
    rerender(<SessionMessageProposalCard card={card({ message: `${sixLinesPlus} ` })} />);

    fireEvent.click(screen.getByRole("button", { name: /Show the whole message/ }));
    expect(screen.getByTestId("session-message-proposal-body")).not.toHaveClass("line-clamp-6");
  });

  it("offers no expander for a message that fits", () => {
    const { rerender } = render(<SessionMessageProposalCard card={card()} />);
    setBodyOverflow(false);
    rerender(<SessionMessageProposalCard card={card({ message: `${card().message} ` })} />);

    expect(screen.queryByRole("button", { name: /Show the whole message/ })).not.toBeInTheDocument();
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

  it("shows why a delivery failed and retries on click", () => {
    const onDeliver = vi.fn<(cardId: string) => Promise<void>>(async () => {});
    render(
      <SessionMessageProposalCard
        card={card({ state: "failed", errorMessage: "Orchestrator is archived" })}
        onDeliver={onDeliver}
      />,
    );
    expect(screen.getByTestId("session-message-proposal-error")).toHaveTextContent("archived");
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(onDeliver).toHaveBeenCalledWith("smp-1");
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
