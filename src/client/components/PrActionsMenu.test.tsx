import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrActionsMenu } from "./PrActionsMenu.js";
import { usePrStore, type PrCardState } from "../stores/pr-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useSessionStore } from "../stores/session-store.js";
import type { SessionInfo } from "../../server/shared/types.js";

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    title: overrides.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    remoteUrl: "https://github.com/o/r.git",
    ...overrides,
  };
}

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
  usePrStore.setState({ statusBySession: {}, cardBySession: {}, autoMergeBySession: {} });
  useGitStore.getState().reset();
  useSessionStore.setState({ activeRunnerSessions: new Set<string>(), sessions: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("PrActionsMenu", () => {
  it("renders the trigger even with no card/session (stable home for PR actions)", async () => {
    const user = userEvent.setup();
    render(<PrActionsMenu sessionId="s1" />);
    const trigger = screen.getByLabelText("Pull request actions");
    expect(trigger).toBeInTheDocument();
    await user.click(trigger);
    // No remote, no branch, no PR → no PR-scoped items.
    expect(screen.queryByRole("menuitem", { name: /^Sync with/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Copy branch name" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Close pull request" })).toBeNull();
  });

  it("shows Sync + Copy branch + Close for an open PR with a remote", async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ sessions: [makeSession({ id: "s1" })] });
    usePrStore.setState({ cardBySession: { s1: openCard } });
    render(<PrActionsMenu sessionId="s1" />);

    await user.click(screen.getByLabelText("Pull request actions"));
    expect(screen.getByRole("menuitem", { name: "Sync with main" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy branch name" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Close pull request" })).toBeInTheDocument();
  });

  it("hides Sync (remote-only) when the session has no remote", async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ sessions: [makeSession({ id: "s1", remoteUrl: "" })] });
    usePrStore.setState({ cardBySession: { s1: openCard } });
    render(<PrActionsMenu sessionId="s1" />);

    await user.click(screen.getByLabelText("Pull request actions"));
    expect(screen.queryByRole("menuitem", { name: /^Sync with/ })).toBeNull();
    // Copy + Close still available (not remote-gated).
    expect(screen.getByRole("menuitem", { name: "Copy branch name" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Close pull request" })).toBeInTheDocument();
  });

  it("omits Close when the PR is not open", async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ sessions: [makeSession({ id: "s1" })] });
    usePrStore.setState({ cardBySession: { s1: { ...openCard, phase: "merged" } } });
    render(<PrActionsMenu sessionId="s1" />);

    await user.click(screen.getByLabelText("Pull request actions"));
    expect(screen.queryByRole("menuitem", { name: "Close pull request" })).toBeNull();
  });
});
