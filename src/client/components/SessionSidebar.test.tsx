import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionSidebar } from "./SessionSidebar.js";
import { AUTO_MERGE_ICON_CLASS } from "../design-tokens.js";
import { useSessionStore } from "../stores/session-store.js";
import { usePrStore, type PrCardState } from "../stores/pr-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import type { SessionInfo, RepoInfo } from "../../server/shared/types.js";

/**
 * Stub `window.matchMedia` so the sidebar's `useMediaQuery("(pointer: coarse)")`
 * resolves predictably. Pass `true` to simulate a touch device.
 */
function mockMatchMedia({ isTouch = false }: { isTouch?: boolean } = {}) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(pointer: coarse)" ? isTouch : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

beforeEach(() => {
  // Default to a non-touch (desktop) environment so existing tests keep their
  // hover-revealed overflow visibility semantics.
  mockMatchMedia();
});

afterEach(() => {
  cleanup();
  // Reset cross-test state so SessionStatusDot tests don't leak into others.
  useSessionStore.setState({ activeRunnerSessions: new Set<string>() });
  usePrStore.setState({ cardBySession: {}, statusBySession: {}, autoMergeBySession: {} });
  useUiStore.getState().setProjectSettingsRepoUrl(null);
  useRepoStore.setState({ collapsedParents: new Set<string>() });
});

const baseSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "sess-1",
  title: "My session",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
  remoteUrl: "",
  ...overrides,
});

const now = new Date().toISOString();
const repoA: RepoInfo = { url: "https://github.com/owner/repo.git", status: "ready", addedAt: now, lastUsedAt: now };
const repoB: RepoInfo = { url: "https://github.com/other/thing.git", status: "ready", addedAt: now, lastUsedAt: now };

const defaultProps = {
  sessions: [],
  currentSessionId: undefined,
  onResume: vi.fn(),
  onArchive: vi.fn(),
  onNewSessionForRepo: vi.fn(),
  collapsed: false,
  onToggleCollapse: vi.fn(),
  repos: [repoA],
  onAddRepo: vi.fn(),
  onCreateNewRepo: vi.fn(),
};

describe("SessionSidebar", () => {
  it("renders repo name as group header", () => {
    render(<SessionSidebar {...defaultProps} />);
    expect(screen.getByText("repo")).toBeTruthy();
  });

  it("shows 'No repositories yet' when no repos", () => {
    render(<SessionSidebar {...defaultProps} repos={[]} />);
    expect(screen.getByText("No repositories yet.")).toBeTruthy();
  });

  it("renders sessions grouped under their repo", () => {
    const sessions = [
      baseSession({ id: "s1", title: "In repo A", remoteUrl: repoA.url }),
      baseSession({ id: "s2", title: "In repo B", remoteUrl: repoB.url }),
    ];
    render(<SessionSidebar {...defaultProps} repos={[repoA, repoB]} sessions={sessions} />);
    expect(screen.getByText("In repo A")).toBeTruthy();
    expect(screen.getByText("In repo B")).toBeTruthy();
  });

  it("highlights the current session with active background", () => {
    const sessions = [baseSession({ id: "s1", title: "Active", remoteUrl: repoA.url })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
    const activeRow = document.querySelector(".bg-\\(--color-bg-secondary\\)");
    expect(activeRow).toBeTruthy();
  });

  it("calls onResume when a non-current session is clicked", () => {
    const onResume = vi.fn();
    const sessions = [
      baseSession({ id: "s1", title: "Resume me", remoteUrl: repoA.url }),
    ];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" onResume={onResume} />);
    fireEvent.click(screen.getByText("Resume me"));
    expect(onResume).toHaveBeenCalledWith("s1");
  });

  it("does not call onResume when the current session is clicked", () => {
    const onResume = vi.fn();
    const sessions = [baseSession({ id: "s1", title: "Current", remoteUrl: repoA.url })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" onResume={onResume} />);
    fireEvent.click(screen.getByText("Current"));
    expect(onResume).not.toHaveBeenCalled();
  });

  it("invokes onArchive when the row's overflow Archive item is selected", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const sessions = [baseSession({ id: "s1", title: "Archivable", remoteUrl: repoA.url })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" onArchive={onArchive} />);
    await user.click(screen.getByLabelText("Session actions"));
    await user.click(await screen.findByText("Archive"));
    expect(onArchive).toHaveBeenCalledWith("s1");
  });

  it("shows collapsed state with expand button", () => {
    render(<SessionSidebar {...defaultProps} collapsed={true} />);
    expect(screen.getByLabelText("Expand sidebar")).toBeTruthy();
  });

  it("calls onToggleCollapse when collapse button is clicked", () => {
    const onToggleCollapse = vi.fn();
    render(<SessionSidebar {...defaultProps} onToggleCollapse={onToggleCollapse} />);
    fireEvent.click(screen.getByLabelText("Collapse sidebar"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleCollapse when expand button is clicked in collapsed state", () => {
    const onToggleCollapse = vi.fn();
    render(<SessionSidebar {...defaultProps} collapsed={true} onToggleCollapse={onToggleCollapse} />);
    fireEvent.click(screen.getByLabelText("Expand sidebar"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("shows inline New Session row per repo group", () => {
    render(<SessionSidebar {...defaultProps} />);
    expect(screen.getByText("New session")).toBeTruthy();
  });

  it("calls onNewSessionForRepo when New session row is clicked", () => {
    const onNewSessionForRepo = vi.fn();
    render(<SessionSidebar {...defaultProps} onNewSessionForRepo={onNewSessionForRepo} />);
    fireEvent.click(screen.getByText("New session"));
    expect(onNewSessionForRepo).toHaveBeenCalledWith(repoA.url);
  });

  it("shows cloning indicator in repo group header", () => {
    const cloningRepo: RepoInfo = { url: repoA.url, status: "cloning", addedAt: now, lastUsedAt: now };
    render(<SessionSidebar {...defaultProps} repos={[cloningRepo]} />);
    expect(screen.getByText("cloning")).toBeTruthy();
  });

  it("shows kebab menu on repo header with View All Sessions, Project Settings and Remove Repository", async () => {
    const user = userEvent.setup();
    render(<SessionSidebar {...defaultProps} />);
    await user.click(screen.getByLabelText("repo repository menu"));
    expect(screen.getByText("View All Sessions")).toBeTruthy();
    expect(screen.getByText("Project Settings")).toBeTruthy();
    expect(screen.getByText("Remove Repository")).toBeTruthy();
  });

  it("opens the per-repo Project Settings dialog from the menu", async () => {
    const user = userEvent.setup();
    render(<SessionSidebar {...defaultProps} />);
    await user.click(screen.getByLabelText("repo repository menu"));
    await user.click(screen.getByText("Project Settings"));
    expect(useUiStore.getState().projectSettingsRepoUrl).toBe(repoA.url);
  });

  it("requires a second click to confirm Remove Repository", async () => {
    const user = userEvent.setup();
    render(<SessionSidebar {...defaultProps} />);
    await user.click(screen.getByLabelText("repo repository menu"));
    // First click on Remove keeps the menu open and swaps the label to confirmation.
    await user.click(screen.getByText("Remove Repository"));
    expect(screen.getByText("Click again to confirm")).toBeTruthy();
    expect(screen.queryByText("Remove Repository")).toBeNull();
  });

  it("shows 'No sessions' when a repo group has no sessions", () => {
    render(<SessionSidebar {...defaultProps} sessions={[]} />);
    expect(screen.getByText("No sessions")).toBeTruthy();
  });

  it("shows Repository switcher in the top bar", () => {
    render(<SessionSidebar {...defaultProps} />);
    // The expanded sidebar exposes a Repository switcher in the top bar — this
    // dropdown houses "Add Repository" as one of its items, replacing the old
    // standalone "+" button (which was easy to mis-click when intending to start
    // a new session).
    expect(screen.getByLabelText("Repository")).toBeTruthy();
  });

  it("sorts non-merged sessions by createdAt desc, with merged sessions at the bottom", () => {
    const t0 = "2024-01-01T00:00:00.000Z";
    const t1 = "2024-01-02T00:00:00.000Z";
    const t2 = "2024-01-03T00:00:00.000Z";
    const t3 = "2024-01-04T00:00:00.000Z";
    const sessions = [
      // Most-recently-used overall is merged — should still sink below active sessions.
      baseSession({
        id: "s-merged-recent",
        title: "Merged recent",
        remoteUrl: repoA.url,
        createdAt: t0,
        lastUsedAt: t3,
        mergedAt: t3,
      }),
      // Older session, but recently touched — must NOT bubble up.
      baseSession({
        id: "s-active-old",
        title: "Active old",
        remoteUrl: repoA.url,
        createdAt: t1,
        lastUsedAt: t3,
      }),
      // Newer session, untouched recently — must stay at top.
      baseSession({
        id: "s-active-new",
        title: "Active new",
        remoteUrl: repoA.url,
        createdAt: t2,
        lastUsedAt: t0,
      }),
      baseSession({
        id: "s-merged-old",
        title: "Merged old",
        remoteUrl: repoA.url,
        createdAt: t0,
        lastUsedAt: t0,
        mergedAt: t0,
      }),
    ];
    render(<SessionSidebar {...defaultProps} sessions={sessions} />);

    // Active sessions ordered by createdAt desc, then merged ordered by mergedAt desc.
    const expectedOrder = ["Active new", "Active old", "Merged recent", "Merged old"];
    const renderedTitles = expectedOrder
      .map((t) => screen.getByText(t))
      .map((el) => ({
        title: el.textContent,
        // compareDocumentPosition is reliable in jsdom for ordering checks.
        node: el,
      }));
    for (let i = 1; i < renderedTitles.length; i++) {
      const prev = renderedTitles[i - 1].node;
      const curr = renderedTitles[i].node;
      // DOCUMENT_POSITION_FOLLOWING (4) means curr comes after prev.
      expect(prev.compareDocumentPosition(curr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("does not reorder sessions when lastUsedAt changes", () => {
    // Regression test: the order must be derived from createdAt (stable), not lastUsedAt
    // (which updates on every agent event during a turn). Otherwise running agents would
    // reshuffle the sidebar under the user's cursor.
    const tOld = "2024-01-01T00:00:00.000Z";
    const tNew = "2024-01-02T00:00:00.000Z";
    const tNewer = "2024-01-03T00:00:00.000Z";
    const sessions = [
      baseSession({ id: "s-older", title: "Older", remoteUrl: repoA.url, createdAt: tOld, lastUsedAt: tOld }),
      baseSession({ id: "s-newer", title: "Newer", remoteUrl: repoA.url, createdAt: tNew, lastUsedAt: tOld }),
    ];
    const { rerender } = render(<SessionSidebar {...defaultProps} sessions={sessions} />);
    const newerNode1 = screen.getByText("Newer");
    const olderNode1 = screen.getByText("Older");
    expect(newerNode1.compareDocumentPosition(olderNode1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Simulate an agent event in the older session bumping its lastUsedAt past the newer one.
    // With MRU sorting this would reorder; with createdAt sorting the order must stay.
    const updated = [
      { ...sessions[0], lastUsedAt: tNewer },
      sessions[1],
    ];
    rerender(<SessionSidebar {...defaultProps} sessions={updated} />);

    const newerNode2 = screen.getByText("Newer");
    const olderNode2 = screen.getByText("Older");
    expect(newerNode2.compareDocumentPosition(olderNode2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe("SessionStatusDot priority", () => {
    const failingChecks: PrCardState = {
      cardId: "card-1",
      phase: "open",
      checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
    };

    it("shows the agent-running indicator when CI failed but the agent is currently working", () => {
      // The agent may already be addressing the failure (e.g. user followed up on a CI break);
      // surfacing a stale 'CI failed' icon while it works misrepresents the session state.
      usePrStore.setState({ cardBySession: { "s1": failingChecks } });
      useSessionStore.setState({ activeRunnerSessions: new Set(["s1"]) });

      const sessions = [baseSession({ id: "s1", title: "Working session", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" />);

      expect(screen.getByTitle("Agent running")).toBeTruthy();
      expect(screen.queryByTitle(/CI failed/)).toBeNull();
    });

    it("shows the CI-failed indicator when CI failed and the agent is idle", () => {
      usePrStore.setState({ cardBySession: { "s1": failingChecks } });
      useSessionStore.setState({ activeRunnerSessions: new Set<string>() });

      const sessions = [baseSession({ id: "s1", title: "Idle session", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" />);

      expect(screen.getByTitle("CI failed 2 of 3")).toBeTruthy();
      expect(screen.queryByTitle("Agent running")).toBeNull();
    });

    it("shows the auto-fix indicator (not agent-running) when auto-fix is in progress", () => {
      // Auto-fix is a more specific kind of agent activity — keep the wrench icon
      // so the user sees that ShipIt is automatically remediating the CI break.
      const card: PrCardState = {
        ...failingChecks,
        autoFix: { enabled: true, status: "running", attemptCount: 1, maxAttempts: 3 },
      };
      usePrStore.setState({ cardBySession: { "s1": card } });
      useSessionStore.setState({ activeRunnerSessions: new Set(["s1"]) });

      const sessions = [baseSession({ id: "s1", title: "Auto-fixing session", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" />);

      expect(screen.getByTitle("Auto-fix running")).toBeTruthy();
      expect(screen.queryByTitle("Agent running")).toBeNull();
      expect(screen.queryByTitle(/CI failed/)).toBeNull();
    });

    it("shows the auto-merge badge alongside the CI status when auto-merge is armed", () => {
      const card: PrCardState = {
        cardId: "card-1",
        phase: "open",
        checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
      };
      usePrStore.setState({ cardBySession: { "s1": card }, autoMergeBySession: { "s1": { enabled: true, mergeMethod: "squash" } } });

      const sessions = [baseSession({ id: "s1", title: "Armed session", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" />);

      // CI status and the auto-merge attribute are independent indicators.
      expect(screen.getByTitle("CI passed 3/3")).toBeTruthy();
      expect(screen.getByTitle("Auto-merge enabled")).toHaveClass(AUTO_MERGE_ICON_CLASS);
    });

    it("shows the auto-merge indicator even with no CI/PR yet (preference is session-level)", () => {
      // Auto-merge can be armed before any PR exists, so the badge must not be
      // gated on CI/PR state.
      usePrStore.setState({ autoMergeBySession: { "s1": { enabled: true, mergeMethod: "squash" } } });

      const sessions = [baseSession({ id: "s1", title: "Armed pre-PR session", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" />);

      expect(screen.getByTitle("Auto-merge enabled")).toBeTruthy();
    });

    it("shows no auto-merge indicator when the preference is off", () => {
      usePrStore.setState({ autoMergeBySession: { "s1": { enabled: false, mergeMethod: "squash" } } });

      const sessions = [baseSession({ id: "s1", title: "Unarmed session", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" />);

      expect(screen.queryByTitle(/Auto-merge enabled/)).toBeNull();
    });
  });

  describe("spawned-children collapse", () => {
    const parent = baseSession({ id: "parent-1", title: "Parent", remoteUrl: repoA.url });
    const childA = baseSession({ id: "child-a", title: "Child A", remoteUrl: repoA.url, parentSessionId: "parent-1" });
    const childB = baseSession({ id: "child-b", title: "Child B", remoteUrl: repoA.url, parentSessionId: "parent-1" });

    it("shows a caret on a parent that has spawned children", () => {
      render(<SessionSidebar {...defaultProps} sessions={[parent, childA, childB]} />);
      // Default: expanded — caret says "Hide ...".
      expect(screen.getByLabelText("Hide 2 spawned sessions")).toBeTruthy();
      expect(screen.getByText("Child A")).toBeTruthy();
      expect(screen.getByText("Child B")).toBeTruthy();
    });

    it("hides children when the parent caret is clicked", async () => {
      const user = userEvent.setup();
      render(<SessionSidebar {...defaultProps} sessions={[parent, childA, childB]} />);
      await user.click(screen.getByLabelText("Hide 2 spawned sessions"));
      expect(screen.queryByText("Child A")).toBeNull();
      expect(screen.queryByText("Child B")).toBeNull();
      // Parent stays visible with a "Show" caret.
      expect(screen.getByText("Parent")).toBeTruthy();
      expect(screen.getByLabelText("Show 2 spawned sessions")).toBeTruthy();
    });

    it("does not render a caret on sessions without spawned children", () => {
      const solo = baseSession({ id: "solo", title: "Solo", remoteUrl: repoA.url });
      render(<SessionSidebar {...defaultProps} sessions={[solo]} />);
      expect(screen.queryByLabelText(/spawned session/)).toBeNull();
    });

    it("clicking the caret does not trigger onResume on the parent row", async () => {
      const onResume = vi.fn();
      const user = userEvent.setup();
      render(<SessionSidebar {...defaultProps} sessions={[parent, childA]} currentSessionId="other" onResume={onResume} />);
      await user.click(screen.getByLabelText("Hide 1 spawned session"));
      expect(onResume).not.toHaveBeenCalled();
    });
  });

  describe("row overflow menu (docs/156)", () => {
    it("hides the overflow trigger by default on an inactive desktop row", () => {
      const sessions = [baseSession({ id: "s1", title: "Inactive", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="other" />);
      const trigger = screen.getByLabelText("Session actions");
      // The trigger is still rendered (so it's reachable by keyboard); it just
      // hover-reveals via opacity. Its wrapper carries `opacity-0`.
      const wrapper = trigger.closest("div");
      expect(wrapper?.className).toContain("opacity-0");
      expect(wrapper?.className).toContain("group-hover:opacity-100");
    });

    it("always shows the overflow trigger on the active row", () => {
      const sessions = [baseSession({ id: "s1", title: "Active", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
      const trigger = screen.getByLabelText("Session actions");
      const wrapper = trigger.closest("div");
      expect(wrapper?.className).toContain("opacity-100");
      expect(wrapper?.className).not.toContain("opacity-0");
    });

    it("always shows the overflow trigger on touch devices (pointer: coarse)", () => {
      mockMatchMedia({ isTouch: true });
      const sessions = [baseSession({ id: "s1", title: "Inactive", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="other" />);
      const trigger = screen.getByLabelText("Session actions");
      const wrapper = trigger.closest("div");
      expect(wrapper?.className).toContain("opacity-100");
      expect(wrapper?.className).not.toContain("opacity-0");
    });

    it("offers Rename + Archive on a non-archived row", async () => {
      const user = userEvent.setup();
      const sessions = [baseSession({ id: "s1", title: "Live", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
      await user.click(screen.getByLabelText("Session actions"));
      expect(await screen.findByText("Rename")).toBeInTheDocument();
      expect(screen.getByText("Archive")).toBeInTheDocument();
      expect(screen.queryByText("Restore")).toBeNull();
    });

    it("offers Restore (and not Rename/Archive) on an archived row", async () => {
      const user = userEvent.setup();
      const sessions = [baseSession({ id: "s1", title: "Old", remoteUrl: repoA.url, archived: true })];
      const onArchive = vi.fn();
      // For archived rows the sidebar passes a Restore handler via the
      // AllSessionsDialog path; here we just verify the menu shape.
      render(<SessionSidebar {...defaultProps} sessions={sessions} onArchive={onArchive} />);
      await user.click(screen.getByLabelText("Session actions"));
      // Archived rows show only Restore — Rename + Archive are intentionally hidden.
      expect(screen.queryByText("Rename")).toBeNull();
      expect(screen.queryByText("Archive")).toBeNull();
    });

    it("inline-renames the session via the Rename menu item, submitting on Enter", async () => {
      const user = userEvent.setup();
      const renameSession = vi.fn();
      useSessionStore.setState({ renameSession });
      const sessions = [baseSession({ id: "s1", title: "Old name", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);

      await user.click(screen.getByLabelText("Session actions"));
      await user.click(await screen.findByText("Rename"));

      const input = await screen.findByLabelText("Session name") as HTMLInputElement;
      expect(input.value).toBe("Old name");

      // Clear and type a new name, then submit with Enter.
      await user.clear(input);
      await user.type(input, "Fresh name{Enter}");

      expect(renameSession).toHaveBeenCalledWith("s1", "Fresh name");
    });

    it("cancels inline rename on Escape without calling renameSession", async () => {
      const user = userEvent.setup();
      const renameSession = vi.fn();
      useSessionStore.setState({ renameSession });
      const sessions = [baseSession({ id: "s1", title: "Stay", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);

      await user.click(screen.getByLabelText("Session actions"));
      await user.click(await screen.findByText("Rename"));

      const input = await screen.findByLabelText("Session name") as HTMLInputElement;
      await user.clear(input);
      await user.type(input, "Discarded{Escape}");

      expect(renameSession).not.toHaveBeenCalled();
      // The original title is shown again.
      expect(screen.getByText("Stay")).toBeInTheDocument();
    });
  });

  describe("ops sessions (docs/128)", () => {
    it("renders an ops session under the pinned 'Host / Ops' group, not a repo group", () => {
      const sessions = [
        baseSession({ id: "ops-1", title: "Ops — prod-host", kind: "ops", remoteUrl: "" }),
        baseSession({ id: "s1", title: "Regular work", remoteUrl: repoA.url }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      expect(screen.getByText("Host / Ops")).toBeTruthy();
      expect(screen.getByText("Ops — prod-host")).toBeTruthy();
      // The ops badge marks the row.
      expect(screen.getByText("ops")).toBeTruthy();
    });

    it("does not render a 'Host / Ops' group when there are no ops sessions", () => {
      const sessions = [baseSession({ id: "s1", title: "Regular work", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      expect(screen.queryByText("Host / Ops")).toBeNull();
    });

    it("keeps an ops session out of its repo group even if it carries a remoteUrl", () => {
      // Defensive: kind wins over remoteUrl for grouping, so a stray remote on an
      // ops session never pulls it into a repo bucket.
      const sessions = [
        baseSession({ id: "ops-1", title: "Ops host", kind: "ops", remoteUrl: repoA.url }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      const opsRow = screen.getByText("Ops host");
      const opsGroupHeader = screen.getByText("Host / Ops");
      // Ops row should appear after the Host/Ops header (same group), and the repo
      // group should report no sessions.
      expect(opsGroupHeader.compareDocumentPosition(opsRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByText("No sessions")).toBeTruthy();
    });
  });

  it("renders multiple repo groups for multi-repo", () => {
    const sessions = [
      baseSession({ id: "s1", title: "Frontend fix", remoteUrl: repoA.url }),
      baseSession({ id: "s2", title: "API migration", remoteUrl: repoB.url }),
    ];
    render(<SessionSidebar {...defaultProps} repos={[repoA, repoB]} sessions={sessions} />);
    expect(screen.getByText("repo")).toBeTruthy();
    expect(screen.getByText("thing")).toBeTruthy();
    expect(screen.getByText("Frontend fix")).toBeTruthy();
    expect(screen.getByText("API migration")).toBeTruthy();
  });
});
