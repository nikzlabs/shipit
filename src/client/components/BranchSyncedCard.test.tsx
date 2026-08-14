import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BranchSyncedCard as BranchSyncedCardData } from "../../server/shared/types.js";
import { BranchSyncedCard } from "./BranchSyncedCard.js";

const baseCard: BranchSyncedCardData = {
  cardId: "sync-1",
  base: "main",
  headFromSha: "1111111aaaaaaaa",
  headToSha: "2222222bbbbbbbb",
  baseFromSha: "3333333cccccccc",
  baseToSha: "4444444dddddddd",
  forcePushed: true,
  createdAt: "2026-07-31T00:00:00.000Z",
};

afterEach(cleanup);

describe("BranchSyncedCard", () => {
  it("presents a non-merged rebase as a branch update", () => {
    render(<BranchSyncedCard card={baseCard} />);

    expect(screen.getByText(/Branch updated to latest/)).toBeInTheDocument();
    expect(screen.getByText(/Rebased this branch/)).toBeInTheDocument();
    expect(screen.getByText("branch")).toBeInTheDocument();
  });

  it("describes a local-base-only update truthfully", () => {
    render(<BranchSyncedCard card={{ ...baseCard, headToSha: baseCard.headFromSha }} />);

    expect(screen.getByText(/Updated your local/)).toBeInTheDocument();
    expect(screen.queryByText("branch")).not.toBeInTheDocument();
  });

  it("confirms an already-current manual sync without claiming a move", () => {
    render(<BranchSyncedCard card={{
      ...baseCard,
      headToSha: baseCard.headFromSha,
      baseToSha: baseCard.baseFromSha!,
    }} />);

    expect(screen.getByText(/already includes the latest/)).toBeInTheDocument();
    expect(screen.queryByText(/was/)).not.toBeInTheDocument();
  });

  // planning#369 — a sync that rebases nothing can still push: the branch held
  // commits origin had never seen, which is exactly what kept the PR marked
  // conflicting. Reading "nothing happened" while the PR state just changed is
  // how the user concluded the button was broken.
  it("reports a push made without a rebase", () => {
    render(<BranchSyncedCard card={{
      ...baseCard,
      headToSha: baseCard.headFromSha,
      baseToSha: baseCard.baseFromSha!,
      forcePushed: true,
    }} />);

    expect(screen.getByText(/already includes the latest/)).toBeInTheDocument();
    expect(screen.getByText(/Pushed local commits missing from the remote/)).toBeInTheDocument();
  });

  it("stays silent about a push when there was none", () => {
    render(<BranchSyncedCard card={{
      ...baseCard,
      headToSha: baseCard.headFromSha,
      baseToSha: baseCard.baseFromSha!,
      forcePushed: false,
    }} />);

    expect(screen.queryByText(/Pushed local commits/)).not.toBeInTheDocument();
  });
});
