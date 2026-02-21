import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HomeScreen } from "./HomeScreen.js";
import type { HomeScreenProps } from "./HomeScreen.js";
import type { SessionInfo } from "../../server/types.js";

afterEach(cleanup);

const baseSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "sess-1",
  title: "My session",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
  remoteUrl: "https://github.com/owner/repo.git",
  ...overrides,
});

const defaultProps: HomeScreenProps = {
  sessions: [],
  githubStatus: { authenticated: true, username: "testuser" },
  templates: [
    { id: "react", name: "React", description: "React app", icon: "react", category: "frontend" },
  ],
  onRequestTemplates: vi.fn(),
  onSendWithRepo: vi.fn(),
  onNewRepo: vi.fn(),
  onSearchRepos: vi.fn(),
  searchResults: [],
  disabled: false,
  permissionMode: "auto",
  onPermissionModeChange: vi.fn(),
  pendingFiles: [],
  onRemoveFile: vi.fn(),
  onAddFile: vi.fn(),
  fileTree: [],
  creatingRepo: false,
  selectedRepoUrl: null,
  onSelectRepo: vi.fn(),
};

describe("HomeScreen", () => {
  it("renders RepoSelector and MessageInput", () => {
    render(<HomeScreen {...defaultProps} />);
    // RepoSelector renders an input with placeholder
    expect(screen.getByPlaceholderText("Select a repository...")).toBeTruthy();
    // MessageInput renders a textarea with its placeholder
    expect(
      screen.getByPlaceholderText("Describe what to build... (type @ to attach files)"),
    ).toBeTruthy();
    // MessageInput renders a Send button
    expect(screen.getByText("Send")).toBeTruthy();
  });

  it("disables MessageInput when no repo is selected", () => {
    render(<HomeScreen {...defaultProps} selectedRepoUrl={null} />);
    const textarea = screen.getByPlaceholderText(
      "Describe what to build... (type @ to attach files)",
    ) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    const sendBtn = screen.getByText("Send") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it("enables MessageInput when a repo is selected", () => {
    render(
      <HomeScreen
        {...defaultProps}
        selectedRepoUrl="https://github.com/owner/repo.git"
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "Describe what to build... (type @ to attach files)",
    ) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
  });

  it("calls onSendWithRepo with repo URL and text when message is sent", () => {
    const onSendWithRepo = vi.fn();
    render(
      <HomeScreen
        {...defaultProps}
        selectedRepoUrl="https://github.com/owner/repo.git"
        onSendWithRepo={onSendWithRepo}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "Describe what to build... (type @ to attach files)",
    );
    fireEvent.change(textarea, { target: { value: "Build a landing page" } });
    fireEvent.click(screen.getByText("Send"));
    expect(onSendWithRepo).toHaveBeenCalledWith(
      "https://github.com/owner/repo.git",
      "Build a landing page",
      undefined,
    );
  });

  it("does not call onSendWithRepo when no repo is selected", () => {
    const onSendWithRepo = vi.fn();
    render(
      <HomeScreen
        {...defaultProps}
        selectedRepoUrl={null}
        onSendWithRepo={onSendWithRepo}
      />,
    );
    // Even if we could somehow fire the send, it should not call onSendWithRepo
    // The textarea is disabled, but let's verify the guard in handleSend
    // We can't directly invoke handleSend, but we can confirm the input is disabled
    const textarea = screen.getByPlaceholderText(
      "Describe what to build... (type @ to attach files)",
    ) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(onSendWithRepo).not.toHaveBeenCalled();
  });

  it("shows hint text when no repo is selected", () => {
    render(<HomeScreen {...defaultProps} selectedRepoUrl={null} />);
    expect(
      screen.getByText("Select a repository above or create a new one to get started."),
    ).toBeTruthy();
  });

  it("hides hint text when a repo is selected", () => {
    render(
      <HomeScreen
        {...defaultProps}
        selectedRepoUrl="https://github.com/owner/repo.git"
      />,
    );
    expect(
      screen.getByText("Select a repository above or create a new one to get started."),
    ).toHaveClass("invisible");
  });

  it("opens NewRepoDialog when 'New repository' option is clicked in RepoSelector", () => {
    render(
      <HomeScreen
        {...defaultProps}
        githubStatus={{ authenticated: true, username: "testuser" }}
      />,
    );
    // Focus the repo selector input to open the dropdown
    const repoInput = screen.getByPlaceholderText("Select a repository...");
    fireEvent.focus(repoInput);
    // Click "New repository" button in the dropdown
    fireEvent.click(screen.getByText("New repository"));
    // NewRepoDialog should now be visible
    expect(screen.getByText("Create New Repository")).toBeTruthy();
  });

  it("requests templates when opening NewRepoDialog with empty templates", () => {
    const onRequestTemplates = vi.fn();
    render(
      <HomeScreen
        {...defaultProps}
        templates={[]}
        onRequestTemplates={onRequestTemplates}
        githubStatus={{ authenticated: true, username: "testuser" }}
      />,
    );
    const repoInput = screen.getByPlaceholderText("Select a repository...");
    fireEvent.focus(repoInput);
    fireEvent.click(screen.getByText("New repository"));
    expect(onRequestTemplates).toHaveBeenCalledOnce();
  });

  it("does not show NewRepoDialog when githubStatus.username is absent", () => {
    render(
      <HomeScreen
        {...defaultProps}
        githubStatus={{ authenticated: false }}
      />,
    );
    // Open dropdown and click new repo
    const repoInput = screen.getByPlaceholderText("Select a repository...");
    fireEvent.focus(repoInput);
    fireEvent.click(screen.getByText("New repository"));
    // Dialog should NOT appear because username is undefined
    expect(screen.queryByText("Create New Repository")).toBeNull();
  });

  it("closes NewRepoDialog when onClose is triggered", () => {
    render(
      <HomeScreen
        {...defaultProps}
        githubStatus={{ authenticated: true, username: "testuser" }}
      />,
    );
    // Open dialog
    const repoInput = screen.getByPlaceholderText("Select a repository...");
    fireEvent.focus(repoInput);
    fireEvent.click(screen.getByText("New repository"));
    expect(screen.getByText("Create New Repository")).toBeTruthy();
    // Close via Cancel button
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Create New Repository")).toBeNull();
  });

  it("calls onNewRepo and keeps dialog open on submit", () => {
    const onNewRepo = vi.fn();
    render(
      <HomeScreen
        {...defaultProps}
        githubStatus={{ authenticated: true, username: "testuser" }}
        templates={[
          { id: "react", name: "React", description: "React app", icon: "react", category: "frontend" },
        ]}
        onNewRepo={onNewRepo}
      />,
    );
    // Open dialog
    const repoInput = screen.getByPlaceholderText("Select a repository...");
    fireEvent.focus(repoInput);
    fireEvent.click(screen.getByText("New repository"));
    // Fill in name
    const nameInput = screen.getByPlaceholderText("my-project");
    fireEvent.change(nameInput, { target: { value: "new-app" } });
    // Select template
    fireEvent.click(screen.getByText("React"));
    // Submit
    fireEvent.click(screen.getByText("Create & Setup"));
    expect(onNewRepo).toHaveBeenCalledWith("new-app", "", true, "react");
    // Dialog stays open while creation is in progress (closes when redirect unmounts HomeScreen)
    expect(screen.queryByText("Create New Repository")).not.toBeNull();
  });

  it("disables both RepoSelector and MessageInput when disabled prop is true", () => {
    render(<HomeScreen {...defaultProps} disabled={true} selectedRepoUrl="https://github.com/owner/repo.git" />);
    const repoInput = screen.getByPlaceholderText("Select a repository...") as HTMLInputElement;
    expect(repoInput.disabled).toBe(true);
    const textarea = screen.getByPlaceholderText(
      "Describe what to build... (type @ to attach files)",
    ) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    const sendBtn = screen.getByText("Send") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it("sends message via Enter key", () => {
    const onSendWithRepo = vi.fn();
    render(
      <HomeScreen
        {...defaultProps}
        selectedRepoUrl="https://github.com/owner/repo.git"
        onSendWithRepo={onSendWithRepo}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "Describe what to build... (type @ to attach files)",
    );
    fireEvent.change(textarea, { target: { value: "Hello world" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSendWithRepo).toHaveBeenCalledWith(
      "https://github.com/owner/repo.git",
      "Hello world",
      undefined,
    );
  });

  it("does not send on Shift+Enter (allows newline)", () => {
    const onSendWithRepo = vi.fn();
    render(
      <HomeScreen
        {...defaultProps}
        selectedRepoUrl="https://github.com/owner/repo.git"
        onSendWithRepo={onSendWithRepo}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "Describe what to build... (type @ to attach files)",
    );
    fireEvent.change(textarea, { target: { value: "Hello world" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSendWithRepo).not.toHaveBeenCalled();
  });

  it("does not send when textarea is empty", () => {
    const onSendWithRepo = vi.fn();
    render(
      <HomeScreen
        {...defaultProps}
        selectedRepoUrl="https://github.com/owner/repo.git"
        onSendWithRepo={onSendWithRepo}
      />,
    );
    // Send button should be disabled when text is empty
    const sendBtn = screen.getByText("Send") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    fireEvent.click(sendBtn);
    expect(onSendWithRepo).not.toHaveBeenCalled();
  });

  it("passes onSelectRepo to RepoSelector and selects a session repo", () => {
    const onSelectRepo = vi.fn();
    const sessions = [baseSession({ remoteUrl: "https://github.com/alice/project.git" })];
    render(
      <HomeScreen
        {...defaultProps}
        sessions={sessions}
        onSelectRepo={onSelectRepo}
      />,
    );
    // Open the dropdown
    const repoInput = screen.getByPlaceholderText("Select a repository...");
    fireEvent.focus(repoInput);
    // Click the session repo
    fireEvent.click(screen.getByText("alice/project"));
    expect(onSelectRepo).toHaveBeenCalledWith("https://github.com/alice/project.git");
  });
});
