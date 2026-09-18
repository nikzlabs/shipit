import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PrMergeActions } from "./PrStatusActions.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { PrCardState } from "../../stores/pr-store.js";
import { useSessionStore } from "../../stores/session-store.js";

const openCard: PrCardState = {
  cardId: "c1",
  phase: "open",
  pr: {
    number: 42,
    title: "Add feature",
    url: "https://github.com/o/r/pull/42",
    baseBranch: "main",
    headBranch: "feature",
    insertions: 10,
    deletions: 5,
  },
};

function setState(opts: { branchSync?: unknown; autoMergeEnabled?: boolean }) {
  usePrStore.setState({
    statusBySession: { s1: { mergeable: "mergeable", ...(opts.branchSync ? { branchSync: opts.branchSync } : {}) } as never },
    cardBySession: { s1: openCard },
    autoMergeBySession: opts.autoMergeEnabled
      ? ({ s1: { enabled: true, managed: true, mergeMethod: "squash" } } as never)
      : {},
  });
}

beforeEach(() => {
  usePrStore.setState({ statusBySession: {}, cardBySession: { s1: openCard }, autoMergeBySession: {} });
  useSessionStore.setState({ activeRunnerSessions: new Set<string>() });
});

afterEach(cleanup);

/**
 * With auto-merge armed the merge button is not rendered, so its tooltip —
 * previously the only user-visible account of why the PR never merges — is not
 * reachable either. The hold has to say itself.
 */
describe("PrMergeActions — branch-sync hold", () => {
  it("names the unpushed commits when auto-merge is armed", () => {
    setState({ autoMergeEnabled: true, branchSync: { state: "ahead", ahead: 2, behind: 0 } });
    render(<PrMergeActions card={openCard} sessionId="s1" canAutoMerge />);
    expect(screen.getByText("2 commits not on GitHub yet")).toBeTruthy();
  });

  it("uses the singular for one commit", () => {
    setState({ autoMergeEnabled: true, branchSync: { state: "ahead", ahead: 1, behind: 0 } });
    render(<PrMergeActions card={openCard} sessionId="s1" canAutoMerge />);
    expect(screen.getByText("1 commit not on GitHub yet")).toBeTruthy();
  });

  it("names a diverged branch, which ShipIt will not repair on its own", () => {
    setState({ autoMergeEnabled: true, branchSync: { state: "diverged", ahead: 1, behind: 3 } });
    render(<PrMergeActions card={openCard} sessionId="s1" canAutoMerge />);
    expect(screen.getByText("Branch has diverged from its remote")).toBeTruthy();
  });

  it.each([
    ["in-sync", { state: "in-sync", ahead: 0, behind: 0 }],
    ["behind", { state: "behind", ahead: 0, behind: 3 }],
    ["unknown", undefined],
  ])("stays silent when the branch is %s", (_case, branchSync) => {
    setState({ autoMergeEnabled: true, ...(branchSync ? { branchSync } : {}) });
    const { container } = render(<PrMergeActions card={openCard} sessionId="s1" canAutoMerge />);
    expect(container.textContent).not.toContain("GitHub yet");
    expect(container.textContent).not.toContain("diverged");
  });

  // The button is the better surface when it exists: it carries the same fact
  // and the affordance it blocks.
  it("defers to the merge button's own tooltip when the button is rendered", () => {
    setState({ branchSync: { state: "ahead", ahead: 2, behind: 0 } });
    const mergeable = { ...openCard, checks: { state: "success", passed: 1, failed: 0, total: 1 } } as PrCardState;
    const { container } = render(<PrMergeActions card={mergeable} sessionId="s1" />);
    expect(screen.getByText("Squash and merge")).toBeDisabled();
    expect(container.textContent).not.toContain("GitHub yet");
  });

  it("renders the hold even on a card that would otherwise show no merge row", () => {
    setState({ autoMergeEnabled: true, branchSync: { state: "ahead", ahead: 4, behind: 0 } });
    render(<PrMergeActions card={openCard} sessionId="s1" />);
    expect(screen.getByText("4 commits not on GitHub yet")).toBeTruthy();
  });
});
