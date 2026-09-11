import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionSidebar } from "./SessionSidebar.js";
import { GROUP_GAP_CLASS, BAND_CLEARANCE_CLASS, ROW_GAP_CLASS, groupBandFill } from "./SessionSidebar/SessionGroup.js";
import { AUTO_MERGE_ICON_CLASS } from "../design-tokens.js";
import { useSessionStore } from "../stores/session-store.js";
import { usePrStore, type PrCardState } from "../stores/pr-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import type { SessionInfo, RepoInfo } from "../../server/shared/types.js";

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

  mockMatchMedia();
});

afterEach(() => {
  cleanup();

  useSessionStore.setState({
    activeRunnerSessions: new Set<string>(),
    messages: [],
    rewindRecoveries: {},
    allSessionsDialogOpen: false,
    allSessionsDialogRepoUrl: undefined,
  });
  usePrStore.setState({ cardBySession: {}, statusBySession: {}, autoMergeBySession: {} });
  useUiStore.getState().setProjectSettingsRepoUrl(null);
  useRepoStore.setState({
    collapsedParents: new Set<string>(),
    collapsedResolved: new Set<string>(),
    expandedResolvedChildren: new Set<string>(),
  });
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

  it("closes the mobile sidebar when the current session is clicked", () => {
    const onResume = vi.fn();
    const onClose = vi.fn();
    const sessions = [baseSession({ id: "s1", title: "Current", remoteUrl: repoA.url })];
    render(
      <SessionSidebar
        {...defaultProps}
        sessions={sessions}
        currentSessionId="s1"
        onResume={onResume}
        mobile
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText("Current"));

    expect(onClose).toHaveBeenCalledTimes(1);
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

  describe("relocated chat actions (Download chat, Recover recent rewind)", () => {
    it("shows Download chat only in the active session's menu", async () => {
      const user = userEvent.setup();
      const sessions = [baseSession({ id: "s1", title: "Active", remoteUrl: repoA.url })];

      const { unmount } = render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
      await user.click(screen.getByLabelText("Session actions"));
      expect(await screen.findByText("Download chat")).toBeTruthy();
      unmount();

      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="other" />);
      await user.click(screen.getByLabelText("Session actions"));
      expect(screen.queryByText("Download chat")).toBeNull();
    });

    it("serializes the current session's messages when Download chat is selected", async () => {
      const user = userEvent.setup();
      useSessionStore.setState({ messages: [{ role: "user", text: "hello" }] });
      const createObjectURL = vi.fn().mockReturnValue("blob:x");
      const revokeObjectURL = vi.fn();
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

      const sessions = [baseSession({ id: "s1", title: "Active", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
      await user.click(screen.getByLabelText("Session actions"));
      await user.click(await screen.findByText("Download chat"));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("places Investigate in Ops session below Download chat on the active session menu", async () => {
      const user = userEvent.setup();
      const sessions = [baseSession({ id: "s1", title: "Active", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
      await user.click(screen.getByLabelText("Session actions"));

      const download = await screen.findByText("Download chat");
      const investigate = screen.getByText("Investigate in Ops session");
      expect(download.compareDocumentPosition(investigate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("separates Investigate in Ops session from archive actions when download is absent", async () => {
      const user = userEvent.setup();
      const sessions = [baseSession({ id: "s1", title: "Inactive", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="other" />);
      await user.click(screen.getByLabelText("Session actions"));

      expect(await screen.findByRole("separator")).toBeTruthy();
      expect(screen.queryByText("Download chat")).toBeNull();
      expect(screen.getByText("Investigate in Ops session")).toBeTruthy();
    });

    it("separates Download chat from archive actions when investigate is absent", async () => {
      const user = userEvent.setup();
      const sessions = [baseSession({ id: "s1", title: "Ops", remoteUrl: repoA.url, kind: "ops" })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
      await user.click(screen.getByLabelText("Session actions"));

      expect((await screen.findAllByRole("separator")).length).toBeGreaterThan(0);
      expect(screen.getByText("Download chat")).toBeTruthy();
      expect(screen.queryByText("Investigate in Ops session")).toBeNull();
    });

    it("shows Recover recent rewind only when a non-expired recovery exists for the current session", async () => {
      const user = userEvent.setup();
      useSessionStore.setState({
        rewindRecoveries: { s1: { sessionId: "s1", action: "both", expiresAt: Date.now() + 60_000 } },
      });
      const sessions = [baseSession({ id: "s1", title: "Active", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
      await user.click(screen.getByLabelText("Session actions"));
      expect(await screen.findByText("Recover recent rewind")).toBeTruthy();
    });

    it("hides Recover recent rewind when no recovery is available", async () => {
      const user = userEvent.setup();
      useSessionStore.setState({ rewindRecoveries: {} });
      const sessions = [baseSession({ id: "s1", title: "Active", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
      await user.click(screen.getByLabelText("Session actions"));
      expect(screen.queryByText("Recover recent rewind")).toBeNull();
    });

    it("dispatches the rewind-restore event for the session when selected", async () => {
      const user = userEvent.setup();
      useSessionStore.setState({
        rewindRecoveries: { s1: { sessionId: "s1", action: "both", expiresAt: Date.now() + 60_000 } },
      });
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");
      const sessions = [baseSession({ id: "s1", title: "Active", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
      await user.click(screen.getByLabelText("Session actions"));
      await user.click(await screen.findByText("Recover recent rewind"));

      const restoreEvent = dispatchSpy.mock.calls
        .map((c) => c[0])
        .find((e): e is CustomEvent => e instanceof CustomEvent && e.type === "shipit:restore-rewind");
      expect(restoreEvent?.detail).toEqual({ sessionId: "s1" });
    });
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

  it("scopes View All Sessions to the clicked repo, not the current session's repo", async () => {
    const user = userEvent.setup();

    useRepoStore.setState({ activeRepoUrl: repoA.url });
    const sessions = [baseSession({ id: "s1", title: "In repo A", remoteUrl: repoA.url })];
    render(
      <SessionSidebar {...defaultProps} repos={[repoA, repoB]} sessions={sessions} currentSessionId="s1" />,
    );
    await user.click(screen.getByLabelText("thing repository menu"));
    await user.click(screen.getByText("View All Sessions"));
    expect(useSessionStore.getState().allSessionsDialogOpen).toBe(true);
    expect(useSessionStore.getState().allSessionsDialogRepoUrl).toBe(repoB.url);
    // Looking at a repo's sessions must not move the active repo, which is

    expect(useRepoStore.getState().activeRepoUrl).toBe(repoA.url);
  });

  it("opens the per-repo Project Settings dialog from the menu", async () => {
    const user = userEvent.setup();
    render(<SessionSidebar {...defaultProps} />);
    await user.click(screen.getByLabelText("repo repository menu"));
    await user.click(screen.getByText("Project Settings"));
    expect(useUiStore.getState().projectSettingsRepoUrl).toBe(repoA.url);
  });

  it("opens a confirmation dialog (not an inline confirm) from Remove Repository", async () => {
    const user = userEvent.setup();
    render(<SessionSidebar {...defaultProps} />);
    await user.click(screen.getByLabelText("repo repository menu"));
    await user.click(screen.getByText("Remove Repository"));

    expect(screen.getByText("Remove repository")).toBeTruthy();
    expect(screen.getByText(/Nothing on GitHub is changed/)).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("removes the repo only after confirming in the dialog", async () => {
    const user = userEvent.setup();
    const removeRepo = vi.fn(async () => true);
    useRepoStore.setState({ removeRepo });
    render(<SessionSidebar {...defaultProps} />);
    await user.click(screen.getByLabelText("repo repository menu"));
    await user.click(screen.getByText("Remove Repository"));

    await user.click(screen.getByText("Cancel"));
    expect(removeRepo).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText("repo repository menu"));
    await user.click(screen.getByText("Remove Repository"));
    await user.click(screen.getByText("Remove repository"));
    expect(removeRepo).toHaveBeenCalledWith(repoA.url);
  });

  it("shows no placeholder text when a repo group has no sessions (the 'New session' button is always present)", () => {
    render(<SessionSidebar {...defaultProps} sessions={[]} />);
    expect(screen.queryByText("No sessions")).toBeNull();

    expect(screen.getByText("New session")).toBeTruthy();
  });

  it("shows Repository switcher in the top bar", () => {
    render(<SessionSidebar {...defaultProps} />);

    expect(screen.getByLabelText("Repository")).toBeTruthy();
  });

  it("sorts non-merged sessions by createdAt desc, with merged sessions at the bottom", () => {
    const t0 = "2024-01-01T00:00:00.000Z";
    const t1 = "2024-01-02T00:00:00.000Z";
    const t2 = "2024-01-03T00:00:00.000Z";
    const t3 = "2024-01-04T00:00:00.000Z";
    const sessions = [

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

      expect(prev.compareDocumentPosition(curr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("sinks an archived merged session below a non-archived merged one", () => {

    // that group the archived one must sink below the live-but-merged one even

    const t0 = "2024-01-01T00:00:00.000Z";
    const t1 = "2024-01-02T00:00:00.000Z";
    const sessions = [
      baseSession({
        id: "s-archived",
        title: "Archived merged",
        remoteUrl: repoA.url,
        createdAt: t1,
        lastUsedAt: t1,
        mergedAt: t1,                                          
        archived: true,
      }),
      baseSession({
        id: "s-merged",
        title: "Live merged",
        remoteUrl: repoA.url,
        createdAt: t0,
        lastUsedAt: t0,
        mergedAt: t0,
      }),
    ];
    render(<SessionSidebar {...defaultProps} sessions={sessions} />);

    const live = screen.getByText("Live merged");
    const archived = screen.getByText("Archived merged");

    expect(live.compareDocumentPosition(archived) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sinks an archived child below live siblings within a parent's brood", () => {
    const parent = baseSession({ id: "parent-1", title: "Parent", remoteUrl: repoA.url });
    const liveChild = baseSession({
      id: "child-live",
      title: "Live child",
      remoteUrl: repoA.url,
      parentSessionId: "parent-1",
      rootSessionId: "parent-1",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    const archivedChild = baseSession({
      id: "child-archived",
      title: "Archived child",
      remoteUrl: repoA.url,
      parentSessionId: "parent-1",
      rootSessionId: "parent-1",

      createdAt: "2024-01-02T00:00:00.000Z",
      userArchived: true,
    });
    render(<SessionSidebar {...defaultProps} sessions={[parent, archivedChild, liveChild]} />);

    const live = screen.getByText("Live child");
    const archived = screen.getByText("Archived child");

    expect(live.compareDocumentPosition(archived) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not reorder sessions when lastUsedAt changes", () => {
    // Regression test: the order must be derived from createdAt (stable), not lastUsedAt

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

  describe("docs/161: Active vs Recently resolved grouping", () => {
    it("renders a 'Recently resolved' subheader with merged-not-reopened sessions below it", () => {
      const sessions = [
        baseSession({
          id: "s-active",
          title: "Active work",
          remoteUrl: repoA.url,
          createdAt: "2024-01-02T00:00:00.000Z",
          lastUsedAt: "2024-01-02T00:00:00.000Z",
        }),
        baseSession({
          id: "s-merged",
          title: "Merged work",
          remoteUrl: repoA.url,
          createdAt: "2024-01-01T00:00:00.000Z",
          lastUsedAt: "2024-01-01T00:00:00.000Z",
          mergedAt: "2024-01-01T00:00:00.000Z",
        }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);

      const header = screen.getByText("Recently resolved");
      const merged = screen.getByText("Merged work");
      const active = screen.getByText("Active work");

      expect(active.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(header.compareDocumentPosition(merged) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("sinks a closed-without-merge session under 'Recently resolved', same as a merge", () => {
      const sessions = [
        baseSession({
          id: "s-active",
          title: "Active work",
          remoteUrl: repoA.url,
          createdAt: "2024-01-02T00:00:00.000Z",
          lastUsedAt: "2024-01-02T00:00:00.000Z",
        }),
        baseSession({
          id: "s-closed",
          title: "Closed work",
          remoteUrl: repoA.url,
          createdAt: "2024-01-01T00:00:00.000Z",
          lastUsedAt: "2024-01-01T00:00:00.000Z",
          closedAt: "2024-01-01T00:00:00.000Z",
        }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);

      const header = screen.getByText("Recently resolved");
      const closed = screen.getByText("Closed work");
      const active = screen.getByText("Active work");
      expect(active.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(header.compareDocumentPosition(closed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("does not render a 'Recently resolved' subheader when there are no resolved sessions", () => {
      const sessions = [baseSession({ id: "s1", title: "Just active", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      expect(screen.queryByText("Recently resolved")).toBeNull();
    });

    it("keeps a reopened merged session (lastUsedAt > mergedAt) in the Active group", () => {
      // A merged session worked in since the merge rejoins Active — it must NOT

      const sessions = [
        baseSession({
          id: "s-reopened",
          title: "Reopened merged",
          remoteUrl: repoA.url,
          createdAt: "2024-01-01T00:00:00.000Z",
          lastUsedAt: "2024-02-01T00:00:00.000Z",                             
          mergedAt: "2024-01-15T00:00:00.000Z",
        }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);

      expect(screen.queryByText("Recently resolved")).toBeNull();
      expect(screen.getByText("Reopened merged")).toBeTruthy();
    });

    it("keeps a resolved parent with visible children in the Active group", () => {
      const sessions = [
        baseSession({
          id: "s-parent",
          title: "Parent work",
          remoteUrl: repoA.url,
          createdAt: "2024-01-03T00:00:00.000Z",
          lastUsedAt: "2024-01-03T00:00:00.000Z",
          mergedAt: "2024-01-03T00:00:00.000Z",
        }),
        baseSession({
          id: "s-child",
          title: "Spawned child",
          remoteUrl: repoA.url,
          createdAt: "2024-01-04T00:00:00.000Z",
          lastUsedAt: "2024-01-04T00:00:00.000Z",
          parentSessionId: "s-parent",
          rootSessionId: "s-parent",
        }),
        baseSession({
          id: "s-resolved",
          title: "Other resolved",
          remoteUrl: repoA.url,
          createdAt: "2024-01-02T00:00:00.000Z",
          lastUsedAt: "2024-01-02T00:00:00.000Z",
          closedAt: "2024-01-02T00:00:00.000Z",
        }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);

      const parent = screen.getByText("Parent work");
      const child = screen.getByText("Spawned child");
      const header = screen.getByText("Recently resolved");
      const otherResolved = screen.getByText("Other resolved");
      expect(parent.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(child.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(header.compareDocumentPosition(otherResolved) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("renders the Recently resolved sub-section expanded by default", () => {
      const sessions = [
        baseSession({
          id: "s-merged",
          title: "Merged work",
          remoteUrl: repoA.url,
          createdAt: "2024-01-01T00:00:00.000Z",
          lastUsedAt: "2024-01-01T00:00:00.000Z",
          mergedAt: "2024-01-01T00:00:00.000Z",
        }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);

      expect(screen.getByText("Merged work")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Collapse recently resolved" })).toBeTruthy();
    });

    it("collapses the Recently resolved rows on click and remembers it per repo", async () => {
      const user = userEvent.setup();
      const sessions = [
        baseSession({
          id: "s-active",
          title: "Active work",
          remoteUrl: repoA.url,
          createdAt: "2024-01-02T00:00:00.000Z",
          lastUsedAt: "2024-01-02T00:00:00.000Z",
        }),
        baseSession({
          id: "s-merged",
          title: "Merged work",
          remoteUrl: repoA.url,
          createdAt: "2024-01-01T00:00:00.000Z",
          lastUsedAt: "2024-01-01T00:00:00.000Z",
          mergedAt: "2024-01-01T00:00:00.000Z",
        }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);

      await user.click(screen.getByRole("button", { name: "Collapse recently resolved" }));

      expect(screen.queryByText("Merged work")).toBeNull();
      expect(screen.getByText("Active work")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Expand recently resolved" })).toBeTruthy();

      expect(useRepoStore.getState().collapsedResolved.has(repoA.url)).toBe(true);
    });
  });

  describe("docs/110: pinned sub-section", () => {
    it("renders the 'Pinned' subheader above New session, which sits above active sessions", () => {
      const sessions = [
        baseSession({
          id: "s-active",
          title: "Active work",
          remoteUrl: repoA.url,
          createdAt: "2024-02-01T00:00:00.000Z",
          lastUsedAt: "2024-02-01T00:00:00.000Z",
        }),
        baseSession({
          id: "s-pinned",
          title: "Pinned work",
          remoteUrl: repoA.url,
          createdAt: "2024-01-01T00:00:00.000Z",                                        
          lastUsedAt: "2024-01-01T00:00:00.000Z",
          pinnedAt: "2024-06-01T00:00:00.000Z",
        }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);

      const header = screen.getByText("Pinned");
      const pinned = screen.getByText("Pinned work");
      const newSession = screen.getByText("New session");
      const active = screen.getByText("Active work");

      expect(header.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(pinned.compareDocumentPosition(newSession) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(newSession.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps a pinned session above active even though it is older (pin outranks recency)", () => {
      const sessions = [
        baseSession({
          id: "s-pinned",
          title: "Old but pinned",
          remoteUrl: repoA.url,
          createdAt: "2020-01-01T00:00:00.000Z",
          lastUsedAt: "2020-01-01T00:00:00.000Z",
          pinnedAt: "2024-06-01T00:00:00.000Z",
        }),
        baseSession({
          id: "s-new",
          title: "Brand new",
          remoteUrl: repoA.url,
          createdAt: "2024-05-01T00:00:00.000Z",
          lastUsedAt: "2024-05-01T00:00:00.000Z",
        }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      const pinned = screen.getByText("Old but pinned");
      const newer = screen.getByText("Brand new");
      expect(pinned.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("does not render a 'Pinned' subheader when nothing is pinned", () => {
      const sessions = [baseSession({ id: "s1", title: "Just active", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      expect(screen.queryByText("Pinned")).toBeNull();
    });

    it("separates pinned from active sessions with a divider", () => {
      const sessions = [
        baseSession({ id: "s-active", title: "Active work", remoteUrl: repoA.url }),
        baseSession({ id: "s-pinned", title: "Pinned work", remoteUrl: repoA.url, pinnedAt: "2024-06-01T00:00:00.000Z" }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      const divider = screen.getByTestId("pinned-divider");
      const pinned = screen.getByText("Pinned work");
      const active = screen.getByText("Active work");

      expect(pinned.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(divider.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("renders the divider even with pins but no active or resolved sessions (New session row follows it)", () => {
      const sessions = [
        baseSession({ id: "p-only", title: "Only pin", remoteUrl: repoA.url, pinnedAt: "2024-06-01T00:00:00.000Z" }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      const divider = screen.getByTestId("pinned-divider");
      const pinned = screen.getByText("Only pin");
      const newSession = screen.getByText("New session");

      expect(pinned.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(divider.compareDocumentPosition(newSession) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps the list's row gap inside a pin's drag shell, so a pinned session and its children are not flush", () => {
      const sessions = [
        baseSession({ id: "p1", title: "Pinned root", remoteUrl: repoA.url, pinnedAt: "2024-06-01T00:00:00.000Z" }),
        baseSession({ id: "c1", title: "Spawned child", remoteUrl: repoA.url, parentSessionId: "p1", rootSessionId: "p1" }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      const shell = screen.getByTestId("pinned-tree");

      expect(within(shell).getByText("Pinned root")).toBeTruthy();
      expect(within(shell).getByText("Spawned child")).toBeTruthy();
      for (const cls of ["flex", "flex-col", ROW_GAP_CLASS]) {
        expect(shell.className.split(/\s+/)).toContain(cls);
      }

      expect(screen.getByTestId("group-session-list").className.split(/\s+/)).toContain(ROW_GAP_CLASS);
    });

    it("makes pinned rows draggable only when there is more than one pin", () => {
      const onePin = [
        baseSession({ id: "p1", title: "Solo pin", remoteUrl: repoA.url, pinnedAt: "2024-06-02T00:00:00.000Z" }),
      ];
      const { rerender } = render(<SessionSidebar {...defaultProps} sessions={onePin} />);
      expect(screen.getByText("Solo pin").closest('[draggable="true"]')).toBeNull();

      const twoPins = [
        ...onePin,
        baseSession({ id: "p2", title: "Second pin", remoteUrl: repoA.url, pinnedAt: "2024-06-01T00:00:00.000Z" }),
      ];
      rerender(<SessionSidebar {...defaultProps} sessions={twoPins} />);
      expect(screen.getByText("Solo pin").closest('[draggable="true"]')).not.toBeNull();
      expect(screen.getByText("Second pin").closest('[draggable="true"]')).not.toBeNull();
    });

    it("dragging one pin onto another calls reorderPins with the new order", () => {
      const reorderSpy = vi.fn().mockResolvedValue(undefined);
      useSessionStore.setState({ reorderPins: reorderSpy });
      const sessions = [
        baseSession({ id: "p-top", title: "Top pin", remoteUrl: repoA.url, pinnedAt: "2024-06-02T00:00:00.000Z" }),
        baseSession({ id: "p-bottom", title: "Bottom pin", remoteUrl: repoA.url, pinnedAt: "2024-06-01T00:00:00.000Z" }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);

      const top = screen.getByText("Top pin").closest('[draggable="true"]')!;
      const bottom = screen.getByText("Bottom pin").closest('[draggable="true"]')!;

      const data: Record<string, string> = {};
      const dataTransfer = {
        setData: (k: string, v: string) => { data[k] = v; },
        getData: (k: string) => data[k] ?? "",
        effectAllowed: "",
        dropEffect: "",
      };
      fireEvent.dragStart(top, { dataTransfer });
      fireEvent.dragOver(bottom, { dataTransfer, clientY: 1000 });                        
      fireEvent.drop(bottom, { dataTransfer });

      expect(reorderSpy).toHaveBeenCalledWith(repoA.url, ["p-bottom", "p-top"]);
    });
  });

  describe("docs/161: disk-tier badge", () => {
    it("shows a 'stored' indicator on an evicted (not user-archived) session", () => {
      const sessions = [
        baseSession({ id: "s1", title: "Evicted", remoteUrl: repoA.url, diskTier: "evicted" }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      expect(screen.getByTitle(/Workspace stored to save disk/)).toBeTruthy();
    });

    it("shows a 'dependencies cleared' indicator on a light session", () => {
      const sessions = [
        baseSession({ id: "s1", title: "Light", remoteUrl: repoA.url, diskTier: "light" }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      expect(screen.getByTitle(/Dependencies cleared to save disk/)).toBeTruthy();
    });

    it("shows no disk-tier indicator on a hot session", () => {
      const sessions = [
        baseSession({ id: "s1", title: "Hot", remoteUrl: repoA.url, diskTier: "hot" }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      expect(screen.queryByTitle(/save disk/)).toBeNull();
    });

    it("suppresses the disk-tier badge for a user-archived session (archive icon covers it)", () => {

      const sessions = [
        baseSession({ id: "s1", title: "Hidden", remoteUrl: repoA.url, archived: true, userArchived: true, diskTier: "evicted" }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      expect(screen.queryByTitle(/save disk/)).toBeNull();
    });
  });

  describe("SessionStatusDot priority", () => {
    const failingChecks: PrCardState = {
      cardId: "card-1",
      phase: "open",
      checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
    };

    it("shows the agent-running indicator when CI failed but the agent is currently working", () => {

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

      const card: PrCardState = {
        ...failingChecks,
        autoFix: { status: "running", attemptCount: 1, maxAttempts: 3 },
      };
      usePrStore.setState({ cardBySession: { "s1": card } });
      useSessionStore.setState({ activeRunnerSessions: new Set(["s1"]) });

      const sessions = [baseSession({ id: "s1", title: "Auto-fixing session", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" />);

      expect(screen.getByTitle("Auto-fix running")).toBeTruthy();
      expect(screen.queryByTitle("Agent running")).toBeNull();
      expect(screen.queryByTitle(/CI failed/)).toBeNull();
    });

    const mergedPr = {
      number: 42,
      title: "Shipped",
      url: "https://github.com/o/r/pull/42",
      baseBranch: "main",
      headBranch: "feature",
      insertions: 1,
      deletions: 0,
    };

    it("shows the auto-merge badge alongside the CI status when auto-merge is armed", () => {
      const card: PrCardState = {
        cardId: "card-1",
        phase: "open",
        checks: { state: "success", total: 3, passed: 3, failed: 0, pending: 0 },
      };
      usePrStore.setState({ cardBySession: { "s1": card }, autoMergeBySession: { "s1": { enabled: true, mergeMethod: "squash" } } });

      const sessions = [baseSession({ id: "s1", title: "Armed session", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" />);

      expect(screen.getByTitle("CI passed 3/3")).toBeTruthy();
      expect(screen.getByTitle("Auto-merge enabled")).toHaveClass(AUTO_MERGE_ICON_CLASS);
    });

    it("shows the auto-merge indicator even with no CI/PR yet (preference is session-level)", () => {
      // Auto-merge can be armed before any PR exists, so the badge must not be

      usePrStore.setState({ autoMergeBySession: { "s1": { enabled: true, mergeMethod: "squash" } } });

      const sessions = [baseSession({ id: "s1", title: "Armed pre-PR session", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" />);

      expect(screen.getByTitle("Auto-merge enabled")).toBeTruthy();
    });

    it("shows no auto-merge indicator once the arming's PR has merged", () => {

      // badge must ALSO stay off when that update was missed and the entry is

      const card: PrCardState = { cardId: "card-1", phase: "merged", pr: mergedPr };
      usePrStore.setState({
        cardBySession: { "s1": card },
        autoMergeBySession: { "s1": { enabled: true, mergeMethod: "squash", armedForPrNumber: 42 } },
      });

      const sessions = [baseSession({ id: "s1", title: "Merged session", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" />);

      expect(screen.queryByTitle(/Auto-merge enabled/)).toBeNull();
    });

    it("keeps the indicator for a merged session armed for its NEXT PR", () => {

      const card: PrCardState = { cardId: "card-1", phase: "merged", pr: mergedPr };
      usePrStore.setState({
        cardBySession: { "s1": card },
        autoMergeBySession: { "s1": { enabled: true, mergeMethod: "squash" } },
      });

      const sessions = [baseSession({ id: "s1", title: "Re-armed session", remoteUrl: repoA.url })];
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
    const childA = baseSession({ id: "child-a", title: "Child A", remoteUrl: repoA.url, parentSessionId: "parent-1", rootSessionId: "parent-1" });
    const childB = baseSession({ id: "child-b", title: "Child B", remoteUrl: repoA.url, parentSessionId: "parent-1", rootSessionId: "parent-1" });

    it("shows a caret on a parent that has spawned children", () => {
      render(<SessionSidebar {...defaultProps} sessions={[parent, childA, childB]} />);

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

  describe("resolved children hidden behind a per-brood control", () => {
    const parent = baseSession({ id: "parent-1", title: "Parent", remoteUrl: repoA.url });
    const liveChild = baseSession({
      id: "child-live",
      title: "Live child",
      remoteUrl: repoA.url,
      parentSessionId: "parent-1",
      rootSessionId: "parent-1",
    });
    const mergedChild = baseSession({
      id: "child-merged",
      title: "Merged child",
      remoteUrl: repoA.url,
      parentSessionId: "parent-1",
      rootSessionId: "parent-1",
      createdAt: "2024-01-01T00:00:00.000Z",
      lastUsedAt: "2024-01-01T00:00:00.000Z",
      mergedAt: "2024-01-02T00:00:00.000Z",
    });
    const closedChild = baseSession({
      id: "child-closed",
      title: "Closed child",
      remoteUrl: repoA.url,
      parentSessionId: "parent-1",
      rootSessionId: "parent-1",
      createdAt: "2024-01-01T00:00:00.000Z",
      lastUsedAt: "2024-01-01T00:00:00.000Z",
      closedAt: "2024-01-02T00:00:00.000Z",
    });

    it("hides a merged child by default and offers a control to show it", () => {
      render(<SessionSidebar {...defaultProps} sessions={[parent, liveChild, mergedChild]} />);
      expect(screen.getByText("Live child")).toBeTruthy();
      expect(screen.queryByText("Merged child")).toBeNull();
      expect(screen.getByText("1 resolved")).toBeTruthy();
      expect(screen.getByLabelText("Show 1 resolved spawned session")).toBeTruthy();
    });

    it("counts closed-without-merge children as resolved too", () => {
      render(<SessionSidebar {...defaultProps} sessions={[parent, mergedChild, closedChild]} />);
      expect(screen.queryByText("Merged child")).toBeNull();
      expect(screen.queryByText("Closed child")).toBeNull();
      expect(screen.getByLabelText("Show 2 resolved spawned sessions")).toBeTruthy();
    });

    it("reveals the resolved children on click and remembers it per root session", async () => {
      const user = userEvent.setup();
      render(<SessionSidebar {...defaultProps} sessions={[parent, liveChild, mergedChild]} />);
      await user.click(screen.getByLabelText("Show 1 resolved spawned session"));
      expect(screen.getByText("Merged child")).toBeTruthy();
      expect(screen.getByLabelText("Hide 1 resolved spawned session")).toBeTruthy();
      expect(useRepoStore.getState().expandedResolvedChildren.has("parent-1")).toBe(true);
    });

    it("renders no control when the brood has no resolved member", () => {
      render(<SessionSidebar {...defaultProps} sessions={[parent, liveChild]} />);
      expect(screen.queryByTestId("resolved-children-toggle")).toBeNull();
    });

    it("still counts hidden resolved children in the parent's collapse caret", () => {
      render(<SessionSidebar {...defaultProps} sessions={[parent, liveChild, mergedChild]} />);
      expect(screen.getByLabelText("Hide 2 spawned sessions")).toBeTruthy();
    });

    it("hides the control along with the brood when the parent is collapsed", async () => {
      const user = userEvent.setup();
      render(<SessionSidebar {...defaultProps} sessions={[parent, liveChild, mergedChild]} />);
      await user.click(screen.getByLabelText("Hide 2 spawned sessions"));
      expect(screen.queryByTestId("resolved-children-toggle")).toBeNull();
      expect(screen.queryByText("Live child")).toBeNull();
    });

    it("keeps a merged child visible when it is pinned", () => {

      const pinnedMerged = baseSession({
        ...mergedChild,
        title: "Pinned merged child",
        pinnedAt: "2024-01-03T00:00:00.000Z",
      });
      render(<SessionSidebar {...defaultProps} sessions={[parent, liveChild, pinnedMerged]} />);
      expect(screen.getByText("Pinned merged child")).toBeTruthy();
      expect(screen.queryByTestId("resolved-children-toggle")).toBeNull();
    });

    it("keeps a merged child visible when it has its own children in the brood", () => {

      const mergedMiddle = baseSession({
        id: "child-merged",
        title: "Merged middle",
        remoteUrl: repoA.url,
        parentSessionId: "parent-1",
        rootSessionId: "parent-1",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastUsedAt: "2024-01-01T00:00:00.000Z",
        mergedAt: "2024-01-02T00:00:00.000Z",
      });
      const grandchild = baseSession({
        id: "grand-1",
        title: "Grandchild",
        remoteUrl: repoA.url,
        parentSessionId: "child-merged",
        rootSessionId: "parent-1",
      });
      render(<SessionSidebar {...defaultProps} sessions={[parent, mergedMiddle, grandchild]} />);
      expect(screen.getByText("Merged middle")).toBeTruthy();
      expect(screen.getByText("Grandchild")).toBeTruthy();
      expect(screen.queryByTestId("resolved-children-toggle")).toBeNull();
    });
  });

  describe("docs/201 nested brood (grandchildren)", () => {

    const root = baseSession({ id: "root-1", title: "Root", remoteUrl: repoA.url });
    const child = baseSession({
      id: "child-1",
      title: "Child",
      remoteUrl: repoA.url,
      parentSessionId: "root-1",
      rootSessionId: "root-1",
    });
    const grandchild = baseSession({
      id: "grand-1",
      title: "Grandchild",
      remoteUrl: repoA.url,
      parentSessionId: "child-1",
      rootSessionId: "root-1",
    });

    it("renders a grandchild under its root (the pre-docs/201 bug hid it)", () => {
      render(<SessionSidebar {...defaultProps} sessions={[root, child, grandchild]} />);
      // All three visible — the grandchild used to vanish because the sidebar

      expect(screen.getByText("Root")).toBeTruthy();
      expect(screen.getByText("Child")).toBeTruthy();
      expect(screen.getByText("Grandchild")).toBeTruthy();

      expect(screen.getByLabelText("Hide 2 spawned sessions")).toBeTruthy();
    });

    it("collapsing the root hides the entire brood, grandchild included", async () => {
      const user = userEvent.setup();
      render(<SessionSidebar {...defaultProps} sessions={[root, child, grandchild]} />);
      await user.click(screen.getByLabelText("Hide 2 spawned sessions"));
      expect(screen.queryByText("Child")).toBeNull();
      expect(screen.queryByText("Grandchild")).toBeNull();
      expect(screen.getByText("Root")).toBeTruthy();
    });

    it("still shows a grandchild at top level when its root is absent from the group", () => {

      // renders the brood members at top level so they never disappear.
      render(<SessionSidebar {...defaultProps} sessions={[child, grandchild]} />);
      expect(screen.getByText("Child")).toBeTruthy();
      expect(screen.getByText("Grandchild")).toBeTruthy();
    });
  });

  describe("row overflow menu (docs/156)", () => {
    it("hides the overflow trigger by default on an inactive desktop row", () => {
      const sessions = [baseSession({ id: "s1", title: "Inactive", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="other" />);
      const trigger = screen.getByLabelText("Session actions");

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
      expect(screen.getByText("Investigate in Ops session")).toBeInTheDocument();
      expect(screen.queryByText("Restore")).toBeNull();
    });

    it("creates a target-seeded ops session and navigates to it from the row menu (docs/128)", async () => {
      const user = userEvent.setup();
      const onResume = vi.fn();
      const createOpsSession = vi.fn().mockResolvedValue("ops-new");
      useSessionStore.setState({ createOpsSession });
      const sessions = [baseSession({ id: "s1", title: "Broken", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" onResume={onResume} />);

      await user.click(screen.getByLabelText("Session actions"));
      await user.click(await screen.findByText("Investigate in Ops session"));

      expect(createOpsSession).toHaveBeenCalledWith("s1");
      await vi.waitFor(() => expect(onResume).toHaveBeenCalledWith("ops-new"));
    });

    it("hides 'Investigate in Ops session' on an ops row (no self-investigation)", async () => {
      const user = userEvent.setup();
      const sessions = [baseSession({ id: "s1", title: "Host", kind: "ops" })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
      await user.click(screen.getByLabelText("Session actions"));
      expect(await screen.findByText("Rename")).toBeInTheDocument();
      expect(screen.queryByText("Investigate in Ops session")).toBeNull();
    });

    it("offers Restore (and not Rename/Archive) on an archived row", async () => {
      const user = userEvent.setup();
      const sessions = [baseSession({ id: "s1", title: "Old", remoteUrl: repoA.url, archived: true })];
      const onArchive = vi.fn();

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

      expect(screen.getByText("ops")).toBeTruthy();
    });

    it("does not render a 'Host / Ops' group when there are no ops sessions", () => {
      const sessions = [baseSession({ id: "s1", title: "Regular work", remoteUrl: repoA.url })];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      expect(screen.queryByText("Host / Ops")).toBeNull();
    });

    it("keeps an ops session out of its repo group even if it carries a remoteUrl", () => {

      // ops session never pulls it into a repo bucket.
      const sessions = [
        baseSession({ id: "ops-1", title: "Ops host", kind: "ops", remoteUrl: repoA.url }),
      ];
      render(<SessionSidebar {...defaultProps} sessions={sessions} />);
      const opsRow = screen.getByText("Ops host");
      const opsGroupHeader = screen.getByText("Host / Ops");

      expect(opsGroupHeader.compareDocumentPosition(opsRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByText("No sessions")).toBeNull();
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

  describe("repo group separation", () => {
    const colored = (r: RepoInfo, colorIndex: number): RepoInfo => ({ ...r, colorIndex });

    it("draws each repo group's edge in its own palette color", () => {
      render(
        <SessionSidebar
          {...defaultProps}
          repos={[colored(repoA, 0), colored(repoB, 5)]}
        />,
      );
      const groups = document.querySelectorAll("[data-repo-color-index]");
      expect(groups).toHaveLength(2);
      expect((groups[0] as HTMLElement).style.borderLeftColor).toBe("var(--repo-color-0)");
      expect((groups[1] as HTMLElement).style.borderLeftColor).toBe("var(--repo-color-5)");
      expect((groups[0] as HTMLElement).style.borderLeftWidth).toBe("3px");
    });

    it("suppresses the treatment when there is only one group", () => {
      render(<SessionSidebar {...defaultProps} repos={[colored(repoA, 0)]} />);
      expect(document.querySelector("[data-repo-color-index]")).toBeNull();
    });

    it("applies the treatment to a lone repo when an ops group is also present", () => {
      const sessions = [
        baseSession({ id: "s1", title: "In repo A", remoteUrl: repoA.url }),
        baseSession({ id: "ops1", title: "Host work", remoteUrl: "", kind: "ops" }),
      ];
      render(<SessionSidebar {...defaultProps} repos={[colored(repoA, 2)]} sessions={sessions} />);
      const repoGroup = document.querySelector("[data-repo-color-index]") as HTMLElement | null;
      expect(repoGroup?.style.borderLeftColor).toBe("var(--repo-color-2)");
    });

    // req 10 — non-repo groups use their own semantic color, never a palette one.
    it("marks ops and sandbox groups with their semantic colors", () => {
      const sessions = [
        baseSession({ id: "s1", title: "In repo A", remoteUrl: repoA.url }),
        baseSession({ id: "ops1", title: "Host work", remoteUrl: "", kind: "ops" }),
        baseSession({ id: "sb1", title: "Scratch", remoteUrl: "", kind: "sandbox" }),
      ];
      render(<SessionSidebar {...defaultProps} repos={[colored(repoA, 0)]} sessions={sessions} />);
      const ops = screen.getByTestId("ops-group");
      const sandbox = screen.getByTestId("sandbox-group");
      expect(ops.style.borderLeftColor).toBe("var(--color-warning)");
      expect(sandbox.style.borderLeftColor).toBe("var(--color-sandbox)");
      expect(ops.getAttribute("data-repo-color-index")).toBeNull();
    });

    // it must render plainly rather than with an invisible or arbitrary edge.
    it("draws no edge for a repo with no stored color", () => {
      render(<SessionSidebar {...defaultProps} repos={[repoA, repoB]} />);
      expect(document.querySelector("[data-repo-color-index]")).toBeNull();
    });

    it("separates adjacent group edges with a gap", () => {
      render(<SessionSidebar {...defaultProps} repos={[colored(repoA, 0), colored(repoB, 5)]} />);
      const groups = document.querySelectorAll("[data-repo-color-index]");
      expect(groups.length).toBeGreaterThan(1);
      for (const g of groups) expect(g.className).toContain(GROUP_GAP_CLASS);
    });

    it("insets rows from the band and the edge's end by the row-to-row gap", () => {
      render(<SessionSidebar {...defaultProps} repos={[colored(repoA, 0), colored(repoB, 5)]} />);
      const list = within(document.querySelector<HTMLElement>("[data-repo-color-index]")!)
        .getByTestId("group-session-list");
      expect(list.className).toContain(BAND_CLEARANCE_CLASS);

      expect(list.className).toContain("gap-1");
      expect(BAND_CLEARANCE_CLASS).toBe("pt-1 pb-1");
      expect(list.className).not.toContain("pb-2");
    });

    it("keeps the previous spacing when the treatment is off", () => {
      render(<SessionSidebar {...defaultProps} repos={[colored(repoA, 0)]} />);
      const group = screen.getByText("repo").closest("div")?.parentElement?.parentElement;
      expect(group?.className ?? "").not.toContain(GROUP_GAP_CLASS);

      const list = screen.getByTestId("group-session-list");
      expect(list.className).not.toContain(BAND_CLEARANCE_CLASS);
      expect(list.className).toContain("pb-2");                                   
    });

    // The edge MUST be on the group, not the sticky header — on the header it

    it("puts the edge on the group element, not on the sticky header", () => {
      render(<SessionSidebar {...defaultProps} repos={[colored(repoA, 0), colored(repoB, 1)]} />);
      const group = document.querySelector<HTMLElement>("[data-repo-color-index]")!;
      const header = group.querySelector<HTMLElement>(".sticky")!;
      expect(header).toBeTruthy();
      expect(header.style.borderLeftWidth).toBe("");
    });

    it("washes each group's header band with that group's own color", () => {
      render(<SessionSidebar {...defaultProps} repos={[colored(repoA, 0), colored(repoB, 5)]} />);
      const groups = document.querySelectorAll<HTMLElement>("[data-repo-color-index]");
      const bandOf = (g: HTMLElement) => g.querySelector<HTMLElement>(".sticky")!.style.backgroundColor;
      expect(bandOf(groups[0])).toBe(groupBandFill("var(--repo-color-0)"));
      expect(bandOf(groups[1])).toBe(groupBandFill("var(--repo-color-5)"));
      expect(bandOf(groups[0])).not.toBe(bandOf(groups[1]));
    });

    describe("keeps the sticky header opaque", () => {
      const headerOf = (el: HTMLElement) => el.querySelector<HTMLElement>(".sticky")!;

      it("when the group carries a wash — mixed over the rail, not alpha", () => {
        render(<SessionSidebar {...defaultProps} repos={[colored(repoA, 0), colored(repoB, 5)]} />);
        const washed = headerOf(document.querySelector<HTMLElement>("[data-repo-color-index]")!);
        expect(washed.style.backgroundColor).toContain("var(--color-bg-primary)");
        expect(washed.className).toContain("bg-(--color-bg-primary)");
      });

      it("when the sidebar is unseparated", () => {
        render(<SessionSidebar {...defaultProps} repos={[colored(repoA, 0)]} />);
        const plain = screen.getByText("repo").closest<HTMLElement>(".sticky")!;
        expect(plain.style.backgroundColor).toBe("");
        expect(plain.className).toContain("bg-(--color-bg-primary)");
      });

      // test named and never actually rendered.
      it("when a separated repo has no stored color", () => {
        render(<SessionSidebar {...defaultProps} repos={[repoA, colored(repoB, 5)]} />);
        const uncolored = screen.getByText("repo").closest<HTMLElement>(".sticky")!;
        expect(uncolored.style.backgroundColor).toBe("");
        expect(uncolored.className).toContain("bg-(--color-bg-primary)");
      });

      it("on the Ops and Sandbox groups", () => {
        const sessions = [
          baseSession({ id: "s1", title: "In repo A", remoteUrl: repoA.url }),
          baseSession({ id: "ops1", title: "Host work", remoteUrl: "", kind: "ops" }),
          baseSession({ id: "sb1", title: "Scratch", remoteUrl: "", kind: "sandbox" }),
        ];
        render(<SessionSidebar {...defaultProps} repos={[colored(repoA, 0)]} sessions={sessions} />);
        for (const [id, token] of [["ops-group", "--color-warning"], ["sandbox-group", "--color-sandbox"]] as const) {
          const header = headerOf(screen.getByTestId(id));
          expect(header.style.backgroundColor).toBe(groupBandFill(`var(${token})`));
          expect(header.style.backgroundColor).toContain("var(--color-bg-primary)");
          expect(header.className).toContain("bg-(--color-bg-primary)");
        }
      });
    });
  });
});

describe("SessionSidebar needs-attention view", () => {
  afterEach(() => {
    useUiStore.getState().setSidebarView("all");
  });

  const waiting = () => [
    baseSession({ id: "s1", title: "Needs me", remoteUrl: repoA.url }),
    baseSession({ id: "s2", title: "Also needs me", remoteUrl: repoB.url }),
  ];

  const findSwitch = () => screen.getByRole("button", { name: /need you/ });

  it("puts the switch beside the collapse control, not among the create controls", () => {

    // right-hand cluster is create/act controls the switch must not join.
    render(<SessionSidebar {...defaultProps} sessions={waiting()} />);
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapse.nextElementSibling).toBe(findSwitch());
  });

  it("is the first control on the mobile bar, which has no collapse button", () => {

    render(<SessionSidebar {...defaultProps} sessions={waiting()} mobile />);
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    expect(findSwitch().parentElement?.firstElementChild).toBe(findSwitch());
  });

  it("carries the count in BOTH views, so the second one is discoverable", () => {

    render(<SessionSidebar {...defaultProps} repos={[repoA, repoB]} sessions={waiting()} />);
    expect(findSwitch().textContent).toContain("2");

    fireEvent.click(findSwitch());

    expect(findSwitch().textContent).toContain("2");
  });

  it("swaps the repo tree for a flat list with no repo headers", () => {

    render(<SessionSidebar {...defaultProps} repos={[repoA, repoB]} sessions={waiting()} />);

    expect(screen.getByText("repo").closest(".sticky")).toBeTruthy();
    expect(screen.getAllByText("New session").length).toBe(2);

    fireEvent.click(findSwitch());
    expect(screen.queryByText("New session")).toBeNull();
    // "repo" survives only as a row's repo NAME (req 12), never as a header.
    expect(screen.getByText("repo").closest(".sticky")).toBeNull();
    expect(screen.getByText("Needs me")).toBeTruthy();
    expect(screen.getByText("Also needs me")).toBeTruthy();

    expect(screen.queryByText(/Needs you/)).toBeNull();
  });

  it("remembers the chosen view", () => {

    render(<SessionSidebar {...defaultProps} sessions={waiting()} />);
    fireEvent.click(findSwitch());
    expect(useUiStore.getState().sidebarView).toBe("attention");
    expect(localStorage.getItem("shipit-sidebar-view")).toBe("attention");
  });

  it("adds no second switch to the collapsed rail", () => {

    render(<SessionSidebar {...defaultProps} sessions={waiting()} collapsed />);
    expect(screen.queryByRole("button", { name: /need you/ })).toBeNull();
  });

  describe("the collapse control", () => {
    it("leaves the view on the first press and collapses on the next", () => {
      const onToggleCollapse = vi.fn();
      render(
        <SessionSidebar {...defaultProps} sessions={waiting()} onToggleCollapse={onToggleCollapse} />,
      );
      fireEvent.click(findSwitch());
      expect(useUiStore.getState().sidebarView).toBe("attention");

      fireEvent.click(screen.getByRole("button", { name: "Back to all sessions" }));
      expect(onToggleCollapse).not.toHaveBeenCalled();
      expect(useUiStore.getState().sidebarView).toBe("all");
      expect(screen.getAllByText("New session").length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    });

    it("names itself for the press it will make, so the state is not hidden", async () => {

      const user = userEvent.setup();
      render(<SessionSidebar {...defaultProps} sessions={waiting()} />);
      expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Back to all sessions" })).toBeNull();

      fireEvent.click(findSwitch());
      const control = screen.getByRole("button", { name: "Back to all sessions" });
      expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();

      await user.hover(control);
      expect(await screen.findAllByText("Back to all sessions")).not.toHaveLength(0);
    });

    it("does not borrow the switch's own name, which collides at a count of zero", () => {

      render(<SessionSidebar {...defaultProps} sessions={[]} />);
      fireEvent.click(screen.getByRole("button", { name: "Show sessions that need you" }));
      expect(screen.getAllByRole("button", { name: "Show all sessions" })).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Back to all sessions" })).toBeTruthy();
    });

    it("expands into the remembered view, where the header press still leaves it", () => {

      const onToggleCollapse = vi.fn();
      function Harness() {
        const [collapsed, setCollapsed] = useState(true);
        return (
          <SessionSidebar
            {...defaultProps}
            sessions={waiting()}
            collapsed={collapsed}
            onToggleCollapse={() => {
              onToggleCollapse();
              setCollapsed((c) => !c);
            }}
          />
        );
      }
      useUiStore.getState().setSidebarView("attention");
      render(<Harness />);

      fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
      expect(useUiStore.getState().sidebarView).toBe("attention");

      fireEvent.click(screen.getByRole("button", { name: "Back to all sessions" }));
      expect(useUiStore.getState().sidebarView).toBe("all");

      expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    });
  });
});
