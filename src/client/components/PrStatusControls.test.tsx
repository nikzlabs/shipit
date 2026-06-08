import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClosePrDropdownItem, MergeButton, useClosePr } from "./PrStatusControls.js";
import { OverflowMenu } from "./ui/overflow-menu.js";
import { usePrStore } from "../stores/pr-store.js";
import type { PrCardState } from "../stores/pr-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";

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

// Mirrors how PrLifecycleCard / PrStatusSection host the close item inside a
// Radix OverflowMenu: the menu owner holds the useClosePr state and resets it
// on close so a partial confirm never carries over.
function OverflowCloseHarness({ sessionId }: { sessionId: string }) {
  const state = useClosePr(sessionId);
  return (
    <OverflowMenu
      label="More pull request actions"
      onOpenChange={(open) => { if (!open) state.reset(); }}
    >
      <ClosePrDropdownItem state={state} />
    </OverflowMenu>
  );
}

beforeEach(() => {
  usePrStore.setState({ statusBySession: {}, cardBySession: { s1: openCard }, autoMergeBySession: {} });
  useSessionStore.setState({ activeRunnerSessions: new Set<string>() });
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

// Close lives in two places, both backed by the shared useClosePr state machine:
// the merge button's bespoke dropdown (regular, mergeable case) and a Radix
// overflow menu (shown when the merge button is hidden, e.g. merge conflicts).
// The confirm / re-arm / failure contract is asserted against both.
const surfaces = [
  {
    name: "MergeButton dropdown",
    render: () => render(<MergeButton sessionId="s1" />),
    open: (user: ReturnType<typeof userEvent.setup>) =>
      user.click(screen.getByLabelText("Select merge method")),
    // Bespoke dropdown: clicking the caret again closes it.
    close: (user: ReturnType<typeof userEvent.setup>) =>
      user.click(screen.getByLabelText("Select merge method")),
  },
  {
    name: "overflow menu",
    render: () => render(<OverflowCloseHarness sessionId="s1" />),
    open: (user: ReturnType<typeof userEvent.setup>) =>
      user.click(screen.getByLabelText("More pull request actions")),
    // Radix menu: Escape dismisses it (firing onOpenChange(false) → reset).
    close: (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}"),
  },
] as const;

describe.each(surfaces)("close pull request via $name", ({ render: renderSurface, open, close }) => {
  it("requires a second click to confirm before closing", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ number: 42, url: "u" }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    renderSurface();

    await open(user);
    await user.click(screen.getByText("Close pull request"));

    // First click only arms the confirm — no request yet.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Click again to confirm")).toBeInTheDocument();

    await user.click(screen.getByText("Click again to confirm"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/pr/42/close",
      expect.objectContaining({ method: "POST" }),
    );
    expect(usePrStore.getState().cardBySession.s1?.phase).toBe("closed");
  });

  it("re-arms (does not stay confirmed) after the menu is reopened", async () => {
    const user = userEvent.setup();
    renderSurface();

    await open(user);
    await user.click(screen.getByText("Close pull request"));
    expect(screen.getByText("Click again to confirm")).toBeInTheDocument();

    // Dismiss the menu, then reopen — the item is back to its un-armed label.
    await close(user);
    await open(user);
    expect(screen.getByText("Close pull request")).toBeInTheDocument();
    expect(screen.queryByText("Click again to confirm")).not.toBeInTheDocument();
  });

  it("surfaces a toast and keeps the PR open when the close request fails", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "GitHub said no" }),
    }) as typeof fetch;

    renderSurface();

    await open(user);
    await user.click(screen.getByText("Close pull request"));
    await user.click(screen.getByText("Click again to confirm"));

    expect(useUiStore.getState().toast?.message).toContain("GitHub said no");
    expect(usePrStore.getState().cardBySession.s1?.phase).toBe("open");
  });
});
