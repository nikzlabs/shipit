import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoMergeToggle, ClosePrDropdownItem, MergeButton, useClosePr } from "./PrStatusControls.js";
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

/**
 * docs/266 — two states share the `managed` flag and they must not look alike.
 * `native-unavailable` is a repo misconfiguration the user is asked to fix;
 * `session-live` is ShipIt deliberately holding the merge until the session
 * stops working. Showing the first for the second sends the user to a settings
 * page to fix a repository that is configured correctly.
 */
describe("AutoMergeToggle — managed-merge explanation", () => {
  it("explains the live session, without the misconfiguration affordance", async () => {
    const user = userEvent.setup();
    render(
      <AutoMergeToggle
        sessionId="s1"
        autoMerge={{ enabled: true, mergeMethod: "squash", managed: true, managedReason: "session-live" }}
      />,
    );

    const info = screen.getByLabelText("Auto-merge is waiting for this session");
    expect(screen.queryByLabelText("Auto-merge requirements")).toBeNull();

    await user.hover(info);
    // Radix renders the tooltip body twice (visible + the aria live copy).
    expect((await screen.findAllByText(/This session is still working/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Configure in GitHub settings")).toBeNull();
  });

  it("still explains the GitHub-refused fallback and links to settings", async () => {
    const user = userEvent.setup();
    render(
      <AutoMergeToggle
        sessionId="s1"
        autoMerge={{
          enabled: true,
          mergeMethod: "squash",
          managed: true,
          managedReason: "native-unavailable",
          reason: "Allow auto-merge is turned off",
          settingsUrl: "https://github.com/o/r/settings",
        }}
      />,
    );

    const info = screen.getByLabelText("Auto-merge requirements");
    await user.hover(info);

    expect((await screen.findAllByText(/Allow auto-merge is turned off/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Configure in GitHub settings").length).toBeGreaterThan(0);
  });
});

/**
 * The merge button merges what is on GitHub. When the session holds commits
 * that never got there, every other gate on this button — CI green, mergeable,
 * approved — describes a commit the session has already moved past, and the
 * click ships the branch without that work.
 */
describe("MergeButton — unsynced local work", () => {
  const withSync = (branchSync: unknown) => {
    usePrStore.setState({
      statusBySession: { s1: { branchSync } as never },
      cardBySession: { s1: openCard },
    });
  };

  it("disables the merge, and says what is missing, while local commits are unpushed", () => {
    withSync({ state: "ahead", ahead: 2, behind: 0 });
    render(<MergeButton sessionId="s1" />);

    const merge = screen.getByText("Squash and merge");
    expect(merge).toBeDisabled();
    expect(merge.getAttribute("title")).toContain("2 local commits");
  });

  it("disables the merge when the branch has diverged from its remote", () => {
    withSync({ state: "diverged", ahead: 1, behind: 1 });
    render(<MergeButton sessionId="s1" />);

    const merge = screen.getByText("Squash and merge");
    expect(merge).toBeDisabled();
    expect(merge.getAttribute("title")).toContain("diverged");
  });

  it("keeps the dropdown reachable while the merge is held", async () => {
    // An unsynced branch can stay unsynced for a long time (a push that keeps
    // being rejected), and closing the PR or changing the merge method must not
    // be locked away behind that wait.
    const user = userEvent.setup();
    withSync({ state: "ahead", ahead: 1, behind: 0 });
    render(<MergeButton sessionId="s1" />);

    await user.click(screen.getByLabelText("Select merge method"));
    expect(screen.getByText("Close pull request")).toBeTruthy();
  });

  it.each([
    ["in sync", { state: "in-sync", ahead: 0, behind: 0 }],
    // The remote is a superset of local work — the merge ships more, not less.
    ["behind the remote", { state: "behind", ahead: 0, behind: 3 }],
    // "Cannot tell" is never a reason to block: a session whose workspace was
    // reclaimed has no tracking ref to read.
    ["unknown", undefined],
  ])("leaves the merge enabled when the branch is %s", (_case, branchSync) => {
    withSync(branchSync);
    render(<MergeButton sessionId="s1" />);

    expect(screen.getByText("Squash and merge")).not.toBeDisabled();
  });
});
