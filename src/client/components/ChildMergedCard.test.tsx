import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ChildMergedCard } from "./ChildMergedCard.js";

/**
 * Tests for the in-chat `ChildMergedCard` (docs/196). The card is static — every
 * value is a prop persisted on the message row — so these pin the three
 * variants' copy: merged, closed-unmerged, and the planning#260 delivery-failure
 * follow-up that says the agent did NOT start.
 */

const BASE = {
  childSessionId: "child-1",
  childTitle: "Child API",
  branch: "shipit/child",
  prNumber: 7,
  prUrl: "https://github.com/o/r/pull/7",
  prTitle: "Foundation",
};

afterEach(cleanup);

describe("ChildMergedCard", () => {
  it("merged: success copy + merge SHA", () => {
    render(<ChildMergedCard {...BASE} outcome="merged" mergeSha="deadbeefcafe1234" />);
    expect(screen.getByText("Child PR merged")).toBeTruthy();
    expect(screen.getByText(/planned rebase \/ integration/)).toBeTruthy();
    expect(screen.getByText("deadbeefcafe")).toBeTruthy();
    expect(screen.getByTestId("child-merged-card").getAttribute("data-delivery-failed")).toBeNull();
  });

  it("closed-unmerged: warns that the work did not ship", () => {
    render(<ChildMergedCard {...BASE} outcome="closed-unmerged" />);
    expect(screen.getByText("Child PR closed — not merged")).toBeTruthy();
    expect(screen.getByText(/did not ship/)).toBeTruthy();
  });

  it("delivery failure: says the agent never started and how to continue (planning#260)", () => {
    render(
      <ChildMergedCard
        {...BASE}
        outcome="merged"
        mergeSha="deadbeefcafe1234"
        deliveryFailure={{ attempts: 5, error: "container could not be resumed" }}
      />,
    );

    expect(screen.getByText("Couldn't resume this session")).toBeTruthy();
    expect(screen.getByText(/5 attempts — the agent did not start/)).toBeTruthy();
    expect(screen.getByText(/Send a message here to continue/)).toBeTruthy();
    expect(screen.getByText("container could not be resumed")).toBeTruthy();
    expect(screen.getByTestId("child-merged-card").getAttribute("data-delivery-failed")).toBe("true");
    // The PR facts stay on the card so the user can act on the merge by hand.
    expect(screen.getByText("#7")).toBeTruthy();
    expect(screen.getByText("deadbeefcafe")).toBeTruthy();
    // The success copy must NOT also render.
    expect(screen.queryByText(/planned rebase \/ integration/)).toBeNull();
  });

  it("singularizes a one-attempt failure", () => {
    render(<ChildMergedCard {...BASE} outcome="closed-unmerged" deliveryFailure={{ attempts: 1 }} />);
    expect(screen.getByText(/1 attempt — the agent did not start/)).toBeTruthy();
  });
});
