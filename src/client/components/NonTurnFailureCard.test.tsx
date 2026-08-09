import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NonTurnFailureCard } from "./NonTurnFailureCard.js";

/**
 * docs/252 phase 7 (req 9) — the notice the user actually reads.
 *
 * Two things it must say and one it must not do: it names the SERVICE that
 * failed and what ShipIt did instead (the operation completed), and dismissing
 * it must not remove it — the row collapses to a muted line so a recurring
 * failure still leaves a trail.
 */
describe("NonTurnFailureCard", () => {
  const base = {
    sessionId: "s1",
    cardId: "ntf-1",
    purpose: "session-naming" as const,
    serviceName: "DeepSeek",
    billingMode: "key" as const,
    modelId: "deepseek-v4-flash",
    fallback: "The session kept its placeholder title.",
  };

  it("names the service and the fallback the operation completed with", () => {
    render(<NonTurnFailureCard {...base} detail="401 Unauthorized" onDismiss={() => {}} />);

    expect(screen.getByText(/Session naming failed/)).toBeTruthy();
    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText("The session kept its placeholder title.")).toBeTruthy();
    expect(screen.getByText("401 Unauthorized")).toBeTruthy();
  });

  it("distinguishes ShipIt's default from a model the user pinned", () => {
    const { rerender } = render(<NonTurnFailureCard {...base} onDismiss={() => {}} />);
    expect(screen.getByText(/ShipIt's default for background work/)).toBeTruthy();

    rerender(<NonTurnFailureCard {...base} pinned onDismiss={() => {}} />);
    expect(screen.getByText(/chosen in Settings for background work/)).toBeTruthy();
  });

  it("collapses to a dismissed line instead of disappearing", () => {
    const onDismiss = vi.fn();
    render(<NonTurnFailureCard {...base} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss this notice" }));

    expect(onDismiss).toHaveBeenCalledWith("ntf-1");
    const card = screen.getByTestId("non-turn-failure-card");
    expect(card.getAttribute("data-dismissed")).toBe("true");
    expect(card.textContent).toContain("dismissed");
  });

  // The dismissal is persisted server-side, so a reload rehydrates the card
  // already collapsed rather than re-showing a notice the user has read.
  it("renders collapsed when it was dismissed before this load", () => {
    render(<NonTurnFailureCard {...base} dismissedAt="2026-08-09T00:05:00.000Z" onDismiss={() => {}} />);
    expect(screen.getByTestId("non-turn-failure-card").getAttribute("data-dismissed")).toBe("true");
  });
});
