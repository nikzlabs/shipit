import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SessionRenamedCard } from "./SessionRenamedCard.js";

/**
 * The session-renamed card (docs/250, requirement 9). Static payload, no
 * actions — it exists so a title that changed mid-session is explainable after
 * the fact, which means both the old and the new name have to be on screen.
 */

const CARD = {
  cardId: "session-renamed-1",
  from: "Fix the flaky test",
  to: "Harden the CI pipeline",
  createdAt: "2026-08-04T00:00:00.000Z",
};

afterEach(cleanup);

describe("SessionRenamedCard", () => {
  it("shows both the old and the new title", () => {
    render(<SessionRenamedCard card={CARD} />);
    expect(screen.getByTestId("session-renamed-card")).toBeTruthy();
    expect(screen.getByText("Fix the flaky test")).toBeTruthy();
    expect(screen.getByText("Harden the CI pipeline")).toBeTruthy();
  });

  it("tells the user their own rename is final", () => {
    render(<SessionRenamedCard card={CARD} />);
    // The card is the only place this precedence rule surfaces in the UI.
    expect(screen.getByText(/never changed again/i)).toBeTruthy();
  });

  it("offers no actions — the sidebar rename is the override", () => {
    render(<SessionRenamedCard card={CARD} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
