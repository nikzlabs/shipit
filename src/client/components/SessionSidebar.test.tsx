import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SessionSidebar } from "./SessionSidebar.js";
import type { SessionInfo } from "../../server/shared/types.js";

afterEach(cleanup);

const baseSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "sess-1",
  title: "My session",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
  ...overrides,
});

const defaultProps = {
  sessions: [],
  repos: [],
  currentSessionId: undefined,
  onResume: vi.fn(),
  onNew: vi.fn(),
  onNewSessionForRepo: vi.fn(),
  onArchive: vi.fn(),
  onRename: vi.fn(),
  onRefresh: vi.fn(),
  onAddRepo: vi.fn(),
  onRemoveRepo: vi.fn(),
  onViewAll: vi.fn(),
  collapsed: false,
  onToggleCollapse: vi.fn(),
};

describe("SessionSidebar", () => {
  it("renders header and Add Repository button", () => {
    render(<SessionSidebar {...defaultProps} />);
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("Add Repository")).toBeTruthy();
  });

  it("calls onAddRepo when Add Repository is clicked", () => {
    const onAddRepo = vi.fn();
    render(<SessionSidebar {...defaultProps} onAddRepo={onAddRepo} />);
    fireEvent.click(screen.getByText("Add Repository"));
    expect(onAddRepo).toHaveBeenCalledTimes(1);
  });

  it("renders session items", () => {
    const sessions = [baseSession({ title: "Alpha session" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} />);
    expect(screen.getByText("Alpha session")).toBeTruthy();
  });

  it("groups sessions by remoteUrl, shows group headers", () => {
    const sessions = [
      baseSession({ id: "s1", title: "Session A", remoteUrl: "https://github.com/owner/repo.git" }),
      baseSession({ id: "s2", title: "Session B", remoteUrl: "https://github.com/owner/repo.git" }),
    ];
    render(<SessionSidebar {...defaultProps} sessions={sessions} />);
    expect(screen.getByText("Session A")).toBeTruthy();
    expect(screen.getByText("Session B")).toBeTruthy();
    // Group header should show owner/repo label
    expect(screen.getByText("owner/repo")).toBeTruthy();
  });

  it("shows 'No Remote' group for sessions without remoteUrl", () => {
    const sessions = [baseSession({ id: "s1", title: "Untracked" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} />);
    expect(screen.getByText("No Remote")).toBeTruthy();
    expect(screen.getByText("Untracked")).toBeTruthy();
  });

  it("extracts owner/repo from GitHub HTTPS URLs", () => {
    const sessions = [
      baseSession({ id: "s1", remoteUrl: "https://github.com/alice/my-project.git" }),
    ];
    render(<SessionSidebar {...defaultProps} sessions={sessions} />);
    expect(screen.getByText("alice/my-project")).toBeTruthy();
  });

  it("extracts owner/repo from GitHub SSH URLs", () => {
    const sessions = [
      baseSession({ id: "s1", remoteUrl: "git@github.com:bob/cool-app.git" }),
    ];
    render(<SessionSidebar {...defaultProps} sessions={sessions} />);
    expect(screen.getByText("bob/cool-app")).toBeTruthy();
  });

  it("highlights the current session with green dot", () => {
    const sessions = [baseSession({ id: "s1", title: "Active" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
    // Active indicator is a span with success token class; session row should have distinct style
    const activeIndicator = document.querySelector(".bg-\\(--color-success\\)");
    expect(activeIndicator).toBeTruthy();
  });

  it("calls onResume when a non-current session is clicked", () => {
    const onResume = vi.fn();
    const sessions = [
      baseSession({ id: "s1", title: "Resume me" }),
    ];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" onResume={onResume} />);
    fireEvent.click(screen.getByText("Resume me"));
    expect(onResume).toHaveBeenCalledWith("s1");
  });

  it("does not call onResume when the current session is clicked", () => {
    const onResume = vi.fn();
    const sessions = [baseSession({ id: "s1", title: "Current" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" onResume={onResume} />);
    fireEvent.click(screen.getByText("Current"));
    expect(onResume).not.toHaveBeenCalled();
  });

  it("inline rename: form submit calls onRename, escape cancels", () => {
    const onRename = vi.fn();
    const sessions = [baseSession({ id: "s1", title: "Old name" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} onRename={onRename} />);

    // Click pencil button
    const pencilBtn = screen.getByTitle("Rename session");
    fireEvent.click(pencilBtn);

    // Input should now appear
    const input = screen.getByDisplayValue("Old name");
    expect(input).toBeTruthy();

    // Escape cancels
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("Old name")).toBeTruthy();

    // Re-open and submit via form submit event (what Enter triggers in a browser)
    fireEvent.click(screen.getByTitle("Rename session"));
    const input2 = screen.getByDisplayValue("Old name");
    fireEvent.change(input2, { target: { value: "New name" } });
    fireEvent.submit(input2.closest("form")!);
    expect(onRename).toHaveBeenCalledWith("s1", "New name");
  });

  it("shows archive button on non-current sessions", () => {
    const onArchive = vi.fn();
    const sessions = [baseSession({ id: "s1", title: "Archivable" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" onArchive={onArchive} />);
    const archiveBtn = screen.getByTitle("Archive session");
    expect(archiveBtn).toBeTruthy();
    fireEvent.click(archiveBtn);
    expect(onArchive).toHaveBeenCalledWith("s1");
  });

  it("does not show archive button on current session", () => {
    const sessions = [baseSession({ id: "s1", title: "Current" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
    expect(screen.queryByTitle("Archive session")).toBeNull();
  });

  it("shows collapsed state with expand button", () => {
    render(<SessionSidebar {...defaultProps} collapsed={true} />);
    expect(screen.getByLabelText("Expand sidebar")).toBeTruthy();
    // Should not show "Sessions" header text
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

  it("collapsible groups toggle on header click", () => {
    const sessions = [
      baseSession({ id: "s1", title: "Visible session", remoteUrl: "https://github.com/x/y.git" }),
    ];
    render(<SessionSidebar {...defaultProps} sessions={sessions} />);

    // Session is visible initially
    expect(screen.getByText("Visible session")).toBeTruthy();

    // Click the group header to collapse
    fireEvent.click(screen.getByText("x/y"));
    expect(screen.queryByText("Visible session")).toBeNull();

    // Click again to expand
    fireEvent.click(screen.getByText("x/y"));
    expect(screen.getByText("Visible session")).toBeTruthy();
  });

  it("shows per-repo New Session button on repo groups", () => {
    const repos = [
      { url: "https://github.com/owner/repo.git", addedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), status: "ready" as const },
    ];
    render(<SessionSidebar {...defaultProps} repos={repos} />);
    expect(screen.getByText("New Session")).toBeTruthy();
  });

  it("calls onNewSessionForRepo when per-repo button is clicked", () => {
    const onNewSessionForRepo = vi.fn();
    const repos = [
      { url: "https://github.com/owner/repo.git", addedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), status: "ready" as const },
    ];
    render(<SessionSidebar {...defaultProps} repos={repos} onNewSessionForRepo={onNewSessionForRepo} />);
    fireEvent.click(screen.getByText("New Session"));
    expect(onNewSessionForRepo).toHaveBeenCalledWith("https://github.com/owner/repo.git");
  });

  it("disables per-repo button when repo is cloning", () => {
    const repos = [
      { url: "https://github.com/owner/repo.git", addedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), status: "cloning" as const },
    ];
    render(<SessionSidebar {...defaultProps} repos={repos} />);
    const btn = screen.getByText("New Session");
    expect(btn).toBeDisabled();
  });

  it("shows cloning indicator on repo group with cloning status", () => {
    const repos = [
      { url: "https://github.com/owner/repo.git", addedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), status: "cloning" as const },
    ];
    render(<SessionSidebar {...defaultProps} repos={repos} />);
    expect(screen.getByText("cloning")).toBeTruthy();
  });

  it("highlights New Session button when newSessionRepoUrl matches", () => {
    const repos = [
      { url: "https://github.com/owner/repo.git", addedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), status: "ready" as const },
    ];
    render(<SessionSidebar {...defaultProps} repos={repos} newSessionRepoUrl="https://github.com/owner/repo.git" />);
    const btn = screen.getByText("New Session").closest("button")!;
    expect(btn.className).toContain("bg-(--color-bg-secondary)");
  });

  it("does not highlight New Session button when newSessionRepoUrl does not match", () => {
    const repos = [
      { url: "https://github.com/owner/repo.git", addedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), status: "ready" as const },
    ];
    render(<SessionSidebar {...defaultProps} repos={repos} newSessionRepoUrl="https://github.com/other/repo.git" />);
    const btn = screen.getByText("New Session").closest("button")!;
    // Should not have the active background class
    expect(btn.className).not.toContain("bg-(--color-bg-secondary)");
  });
});
