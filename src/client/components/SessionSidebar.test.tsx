import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionSidebar } from "./SessionSidebar.js";
import type { SessionInfo } from "../../server/shared/types.js";

afterEach(cleanup);

const baseSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "sess-1",
  title: "My session",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
  remoteUrl: "",
  ...overrides,
});

const defaultProps = {
  sessions: [],
  activeRepoUrl: "https://github.com/owner/repo.git",
  activeRepoName: "repo",
  activeRepoStatus: "ready" as const,
  currentSessionId: undefined,
  onResume: vi.fn(),
  onArchive: vi.fn(),
  onNewSession: vi.fn(),
  collapsed: false,
  onToggleCollapse: vi.fn(),
  repos: [],
  onSelectRepo: vi.fn(),
  onAddRepo: vi.fn(),
  onCreateNewRepo: vi.fn(),
};

describe("SessionSidebar", () => {
  it("renders active repo name and Sessions header", () => {
    render(<SessionSidebar {...defaultProps} />);
    expect(screen.getByText("repo")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
  });

  it("shows 'No repository' when no active repo", () => {
    render(<SessionSidebar {...defaultProps} activeRepoUrl={undefined} activeRepoName="" />);
    expect(screen.getByText("No repository")).toBeTruthy();
  });

  it("opens repo switcher dropdown when gear is clicked", async () => {
    const user = userEvent.setup();
    render(<SessionSidebar {...defaultProps} />);
    await user.click(screen.getByLabelText("Change repository"));
    // DropdownMenu renders "Add Repository" item in a portal
    expect(await screen.findByText("Add Repository")).toBeTruthy();
  });

  it("renders session items filtered to active repo", () => {
    const sessions = [
      baseSession({ id: "s1", title: "Matching", remoteUrl: "https://github.com/owner/repo.git" }),
      baseSession({ id: "s2", title: "Other repo", remoteUrl: "https://github.com/other/thing.git" }),
    ];
    render(<SessionSidebar {...defaultProps} sessions={sessions} />);
    expect(screen.getByText("Matching")).toBeTruthy();
    expect(screen.queryByText("Other repo")).toBeNull();
  });

  it("shows sessions without remoteUrl when no active repo", () => {
    const sessions = [
      baseSession({ id: "s1", title: "No remote session" }),
      baseSession({ id: "s2", title: "Has remote", remoteUrl: "https://github.com/owner/repo.git" }),
    ];
    render(<SessionSidebar {...defaultProps} activeRepoUrl={undefined} activeRepoName="" sessions={sessions} />);
    expect(screen.getByText("No remote session")).toBeTruthy();
    expect(screen.queryByText("Has remote")).toBeNull();
  });

  it("highlights the current session with active background", () => {
    const sessions = [baseSession({ id: "s1", title: "Active", remoteUrl: "https://github.com/owner/repo.git" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
    const activeRow = document.querySelector(".bg-\\(--color-bg-secondary\\)");
    expect(activeRow).toBeTruthy();
  });

  it("calls onResume when a non-current session is clicked", () => {
    const onResume = vi.fn();
    const sessions = [
      baseSession({ id: "s1", title: "Resume me", remoteUrl: "https://github.com/owner/repo.git" }),
    ];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" onResume={onResume} />);
    fireEvent.click(screen.getByText("Resume me"));
    expect(onResume).toHaveBeenCalledWith("s1");
  });

  it("does not call onResume when the current session is clicked", () => {
    const onResume = vi.fn();
    const sessions = [baseSession({ id: "s1", title: "Current", remoteUrl: "https://github.com/owner/repo.git" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" onResume={onResume} />);
    fireEvent.click(screen.getByText("Current"));
    expect(onResume).not.toHaveBeenCalled();
  });

  it("shows archive button on non-current sessions", () => {
    const onArchive = vi.fn();
    const sessions = [baseSession({ id: "s1", title: "Archivable", remoteUrl: "https://github.com/owner/repo.git" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" onArchive={onArchive} />);
    const archiveBtn = screen.getByLabelText("Archive session");
    expect(archiveBtn).toBeTruthy();
    fireEvent.click(archiveBtn);
    expect(onArchive).toHaveBeenCalledWith("s1");
  });

  it("shows archive button on current session", () => {
    const sessions = [baseSession({ id: "s1", title: "Current", remoteUrl: "https://github.com/owner/repo.git" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
    expect(screen.queryByLabelText("Archive session")).not.toBeNull();
  });

  it("shows collapsed state with expand button", () => {
    render(<SessionSidebar {...defaultProps} collapsed={true} />);
    expect(screen.getByLabelText("Expand sidebar")).toBeTruthy();
    expect(screen.queryByText("Sessions")).toBeNull();
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

  it("shows New Session button at the bottom", () => {
    render(<SessionSidebar {...defaultProps} />);
    expect(screen.getByText("New Session")).toBeTruthy();
  });

  it("calls onNewSession when New Session button is clicked", () => {
    const onNewSession = vi.fn();
    render(<SessionSidebar {...defaultProps} onNewSession={onNewSession} />);
    fireEvent.click(screen.getByText("New Session"));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it("disables New Session button when no active repo", () => {
    render(<SessionSidebar {...defaultProps} activeRepoUrl={undefined} activeRepoName="" />);
    const btn = screen.getByText("New Session").closest("button")!;
    expect(btn).toBeDisabled();
  });

  it("disables New Session button when repo is cloning", () => {
    render(<SessionSidebar {...defaultProps} activeRepoStatus="cloning" />);
    const btn = screen.getByText("New Session").closest("button")!;
    expect(btn).toBeDisabled();
  });

  it("shows cloning indicator in repo header", () => {
    render(<SessionSidebar {...defaultProps} activeRepoStatus="cloning" />);
    expect(screen.getByText("cloning")).toBeTruthy();
  });

  it("shows View All button in sessions header", () => {
    render(<SessionSidebar {...defaultProps} />);
    expect(screen.getByText("View All")).toBeTruthy();
  });

  it("shows 'No sessions yet.' when filtered list is empty", () => {
    render(<SessionSidebar {...defaultProps} sessions={[]} />);
    expect(screen.getByText("No sessions yet.")).toBeTruthy();
  });
});
