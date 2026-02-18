import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SessionSidebar } from "./SessionSidebar.js";
import type { SessionInfo } from "../../server/types.js";

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
  currentSessionId: undefined,
  onResume: vi.fn(),
  onNew: vi.fn(),
  onDelete: vi.fn(),
  onRename: vi.fn(),
  onRefresh: vi.fn(),
  collapsed: false,
  onToggleCollapse: vi.fn(),
};

describe("SessionSidebar", () => {
  it("renders header and New Session button", () => {
    render(<SessionSidebar {...defaultProps} />);
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("New Session")).toBeTruthy();
  });

  it("calls onNew when New Session is clicked", () => {
    const onNew = vi.fn();
    render(<SessionSidebar {...defaultProps} onNew={onNew} />);
    fireEvent.click(screen.getByText("New Session"));
    expect(onNew).toHaveBeenCalledTimes(1);
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
    // Active indicator is a span with emerald class; session row should have distinct style
    const activeIndicator = document.querySelector(".bg-emerald-400");
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

  it("shows delete button on non-current sessions", () => {
    const onDelete = vi.fn();
    const sessions = [baseSession({ id: "s1", title: "Deletable" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s2" onDelete={onDelete} />);
    const deleteBtn = screen.getByTitle("Delete session");
    expect(deleteBtn).toBeTruthy();
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith("s1");
  });

  it("does not show delete button on current session", () => {
    const sessions = [baseSession({ id: "s1", title: "Current" })];
    render(<SessionSidebar {...defaultProps} sessions={sessions} currentSessionId="s1" />);
    expect(screen.queryByTitle("Delete session")).toBeNull();
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
});
