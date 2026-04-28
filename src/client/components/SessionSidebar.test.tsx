import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SessionSidebar } from "./SessionSidebar.js";
import type { SessionInfo, RepoInfo } from "../../server/shared/types.js";

afterEach(cleanup);

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

  it("shows archive button on sessions", () => {
    const onArchive = vi.fn();
    const sessions = [baseSession({ id: "s1", title: "Archivable", remoteUrl: repoA.url })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" onArchive={onArchive} />);
    const archiveBtn = screen.getByLabelText("Archive session");
    expect(archiveBtn).toBeTruthy();
    fireEvent.click(archiveBtn);
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

  it("shows inline New Session button per repo group", () => {
    render(<SessionSidebar {...defaultProps} />);
    expect(screen.getByText("New Session")).toBeTruthy();
  });

  it("calls onNewSessionForRepo when New Session is clicked", () => {
    const onNewSessionForRepo = vi.fn();
    render(<SessionSidebar {...defaultProps} onNewSessionForRepo={onNewSessionForRepo} />);
    fireEvent.click(screen.getByText("New Session"));
    expect(onNewSessionForRepo).toHaveBeenCalledWith(repoA.url);
  });

  it("shows cloning indicator in repo group header", () => {
    const cloningRepo: RepoInfo = { url: repoA.url, status: "cloning", addedAt: now, lastUsedAt: now };
    render(<SessionSidebar {...defaultProps} repos={[cloningRepo]} />);
    expect(screen.getByText("cloning")).toBeTruthy();
  });

  it("shows View All button in repo group header", () => {
    render(<SessionSidebar {...defaultProps} />);
    expect(screen.getByText("View All")).toBeTruthy();
  });

  it("shows 'No sessions' when a repo group has no sessions", () => {
    render(<SessionSidebar {...defaultProps} sessions={[]} />);
    expect(screen.getByText("No sessions")).toBeTruthy();
  });

  it("shows Add Repository button in the top bar", () => {
    render(<SessionSidebar {...defaultProps} />);
    expect(screen.getByLabelText("Add Repository")).toBeTruthy();
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
