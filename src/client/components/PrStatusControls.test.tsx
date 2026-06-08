import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClosePrButton } from "./PrStatusControls.js";
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

beforeEach(() => {
  usePrStore.setState({ statusBySession: {}, cardBySession: { s1: openCard }, autoMergeBySession: {} });
  useSessionStore.setState({ activeRunnerSessions: new Set<string>() });
  useUiStore.setState({ toast: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("ClosePrButton — close pull request", () => {
  it("requires a second click to confirm before closing", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ number: 42, url: "u" }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(<ClosePrButton sessionId="s1" />);

    await user.click(screen.getByLabelText("More pull request actions"));
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
    render(<ClosePrButton sessionId="s1" />);

    await user.click(screen.getByLabelText("More pull request actions"));
    await user.click(screen.getByText("Close pull request"));
    expect(screen.getByText("Click again to confirm")).toBeInTheDocument();

    // Close the menu via the trigger, then reopen — the item is back to its
    // initial, un-armed label.
    await user.click(screen.getByLabelText("More pull request actions"));
    await user.click(screen.getByLabelText("More pull request actions"));
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

    render(<ClosePrButton sessionId="s1" />);

    await user.click(screen.getByLabelText("More pull request actions"));
    await user.click(screen.getByText("Close pull request"));
    await user.click(screen.getByText("Click again to confirm"));

    expect(useUiStore.getState().toast?.message).toContain("GitHub said no");
    expect(usePrStore.getState().cardBySession.s1?.phase).toBe("open");
  });
});
