import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ProjectSettings, type ProjectSettingsProps } from "./ProjectSettings.js";

afterEach(cleanup);

const defaultProps: ProjectSettingsProps = {
  initialContent: "",
  onSaveInstructions: vi.fn(),
  githubStatus: { authenticated: false },
  onGitHubTokenSubmit: vi.fn(),
  onGitHubLogout: vi.fn(),
  authUrl: null,
  onApiKey: vi.fn(),
  onClearApiKey: vi.fn(),
  onClose: vi.fn(),
};

describe("ProjectSettings", () => {
  it("renders dialog with correct role and aria-label", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Project Settings");
  });

  it("renders header title", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByText("Project Settings")).toBeInTheDocument();
  });

  it("calls onClose on backdrop click", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("project-settings-backdrop"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when clicking inside the modal", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText("Project Settings"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape key", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on close button (x) click", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ProjectSettings - Agent tab", () => {
  it("shows Agent tab by default", () => {
    render(<ProjectSettings {...defaultProps} />);
    const tab = screen.getByText("Agent");
    expect(tab.className).toContain("font-medium");
  });

  it("shows authenticated state when authUrl is null", () => {
    render(<ProjectSettings {...defaultProps} authUrl={null} />);
    expect(screen.getByText("Claude CLI")).toBeInTheDocument();
    expect(screen.getByText("Authenticated")).toBeInTheDocument();
  });

  it("shows auth required state when authUrl is set", () => {
    render(<ProjectSettings {...defaultProps} authUrl="https://auth.example.com" />);
    expect(screen.getByText("Claude CLI")).toBeInTheDocument();
    expect(screen.getByText("Authentication required")).toBeInTheDocument();
  });

  it("shows API key input", () => {
    render(<ProjectSettings {...defaultProps} />);
    const input = screen.getByTestId("project-settings-api-key-input");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("submit button is disabled when input is empty", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByTestId("project-settings-api-key-submit")).toBeDisabled();
  });

  it("calls onApiKey with valid key on submit", () => {
    const onApiKey = vi.fn();
    render(<ProjectSettings {...defaultProps} onApiKey={onApiKey} />);
    fireEvent.change(screen.getByTestId("project-settings-api-key-input"), {
      target: { value: "sk-ant-test123" },
    });
    fireEvent.click(screen.getByTestId("project-settings-api-key-submit"));
    expect(onApiKey).toHaveBeenCalledWith("sk-ant-test123");
  });

  it("shows error for invalid API key format", () => {
    const onApiKey = vi.fn();
    render(<ProjectSettings {...defaultProps} onApiKey={onApiKey} />);
    fireEvent.change(screen.getByTestId("project-settings-api-key-input"), {
      target: { value: "invalid-key" },
    });
    fireEvent.click(screen.getByTestId("project-settings-api-key-submit"));
    expect(onApiKey).not.toHaveBeenCalled();
    expect(screen.getByTestId("project-settings-api-key-error")).toHaveTextContent("sk-ant-");
  });

  it("calls onApiKey on Enter in input", () => {
    const onApiKey = vi.fn();
    render(<ProjectSettings {...defaultProps} onApiKey={onApiKey} />);
    const input = screen.getByTestId("project-settings-api-key-input");
    fireEvent.change(input, { target: { value: "sk-ant-test123" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onApiKey).toHaveBeenCalledWith("sk-ant-test123");
  });

  it("clears error when input changes", () => {
    render(<ProjectSettings {...defaultProps} />);
    const input = screen.getByTestId("project-settings-api-key-input");
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.click(screen.getByTestId("project-settings-api-key-submit"));
    expect(screen.getByTestId("project-settings-api-key-error")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "sk-ant-new" } });
    expect(screen.queryByTestId("project-settings-api-key-error")).not.toBeInTheDocument();
  });

  it("shows Authenticate button when auth is required", () => {
    render(<ProjectSettings {...defaultProps} authUrl="https://auth.example.com" />);
    expect(screen.getByTestId("project-settings-api-key-submit")).toHaveTextContent("Authenticate");
  });

  it("shows Set API Key button when already authenticated", () => {
    render(<ProjectSettings {...defaultProps} authUrl={null} />);
    expect(screen.getByTestId("project-settings-api-key-submit")).toHaveTextContent("Set API Key");
  });

  it("shows Clear API Key button when authenticated", () => {
    render(<ProjectSettings {...defaultProps} authUrl={null} />);
    expect(screen.getByTestId("project-settings-clear-api-key")).toHaveTextContent("Clear API Key");
  });

  it("calls onClearApiKey when Clear API Key is clicked", () => {
    const onClearApiKey = vi.fn();
    render(<ProjectSettings {...defaultProps} authUrl={null} onClearApiKey={onClearApiKey} />);
    fireEvent.click(screen.getByTestId("project-settings-clear-api-key"));
    expect(onClearApiKey).toHaveBeenCalledOnce();
  });

  it("does not show Clear API Key button when auth is required", () => {
    render(<ProjectSettings {...defaultProps} authUrl="https://auth.example.com" />);
    expect(screen.queryByTestId("project-settings-clear-api-key")).not.toBeInTheDocument();
  });

  it("calls onRequestAgentList on mount", () => {
    const onRequestAgentList = vi.fn();
    render(<ProjectSettings {...defaultProps} onRequestAgentList={onRequestAgentList} />);
    expect(onRequestAgentList).toHaveBeenCalledOnce();
  });
});

describe("ProjectSettings - Codex agent section", () => {
  const codexInstalled = {
    id: "codex",
    name: "Codex",
    installed: true,
    authConfigured: false,
    models: ["codex-mini-latest"],
  };

  const codexAuthenticated = {
    ...codexInstalled,
    authConfigured: true,
  };

  const codexNotInstalled = {
    id: "codex",
    name: "Codex",
    installed: false,
    authConfigured: false,
    models: ["codex-mini-latest"],
  };

  it("shows Codex section when codex is in agentList", () => {
    render(<ProjectSettings {...defaultProps} agentList={[codexInstalled]} />);
    expect(screen.getByTestId("codex-agent-section")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("does not show Codex section when agentList is empty", () => {
    render(<ProjectSettings {...defaultProps} agentList={[]} />);
    expect(screen.queryByTestId("codex-agent-section")).not.toBeInTheDocument();
  });

  it("shows 'Not installed' when codex is not installed", () => {
    render(<ProjectSettings {...defaultProps} agentList={[codexNotInstalled]} />);
    expect(screen.getByText("Not installed")).toBeInTheDocument();
  });

  it("shows 'API key not set' when installed but not auth-configured", () => {
    render(<ProjectSettings {...defaultProps} agentList={[codexInstalled]} />);
    expect(screen.getByText("API key not set")).toBeInTheDocument();
  });

  it("shows 'Authenticated' when installed and auth-configured", () => {
    render(<ProjectSettings {...defaultProps} agentList={[codexAuthenticated]} />);
    expect(screen.getAllByText("Authenticated")).toHaveLength(2); // Claude + Codex
  });

  it("shows API key input when installed but not auth-configured", () => {
    render(<ProjectSettings {...defaultProps} agentList={[codexInstalled]} />);
    expect(screen.getByTestId("codex-api-key-input")).toBeInTheDocument();
    expect(screen.getByTestId("codex-api-key-input")).toHaveAttribute("type", "password");
  });

  it("hides API key input when auth is already configured", () => {
    render(<ProjectSettings {...defaultProps} agentList={[codexAuthenticated]} />);
    expect(screen.queryByTestId("codex-api-key-input")).not.toBeInTheDocument();
  });

  it("hides API key input when codex is not installed", () => {
    render(<ProjectSettings {...defaultProps} agentList={[codexNotInstalled]} />);
    expect(screen.queryByTestId("codex-api-key-input")).not.toBeInTheDocument();
  });

  it("Save button is disabled when codex key input is empty", () => {
    render(<ProjectSettings {...defaultProps} agentList={[codexInstalled]} />);
    expect(screen.getByTestId("codex-api-key-submit")).toBeDisabled();
  });

  it("calls onSetAgentEnv when Save is clicked with a key", () => {
    const onSetAgentEnv = vi.fn();
    render(<ProjectSettings {...defaultProps} agentList={[codexInstalled]} onSetAgentEnv={onSetAgentEnv} />);
    const input = screen.getByTestId("codex-api-key-input");
    fireEvent.change(input, { target: { value: "sk-test-key" } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    expect(onSetAgentEnv).toHaveBeenCalledWith("codex", "OPENAI_API_KEY", "sk-test-key");
  });

  it("calls onSetAgentEnv on Enter in codex key input", () => {
    const onSetAgentEnv = vi.fn();
    render(<ProjectSettings {...defaultProps} agentList={[codexInstalled]} onSetAgentEnv={onSetAgentEnv} />);
    const input = screen.getByTestId("codex-api-key-input");
    fireEvent.change(input, { target: { value: "sk-test-key" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSetAgentEnv).toHaveBeenCalledWith("codex", "OPENAI_API_KEY", "sk-test-key");
  });

  it("clears codex key input after submit", () => {
    const onSetAgentEnv = vi.fn();
    render(<ProjectSettings {...defaultProps} agentList={[codexInstalled]} onSetAgentEnv={onSetAgentEnv} />);
    const input = screen.getByTestId("codex-api-key-input");
    fireEvent.change(input, { target: { value: "sk-test-key" } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    expect(input).toHaveValue("");
  });
});

describe("ProjectSettings - GitHub tab", () => {
  function renderOnGitHubTab(props: Partial<ProjectSettingsProps> = {}) {
    const result = render(<ProjectSettings {...defaultProps} {...props} />);
    fireEvent.click(screen.getByText("GitHub"));
    return result;
  }

  it("shows token input when not authenticated", () => {
    renderOnGitHubTab();
    const input = screen.getByTestId("project-settings-token-input");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("Connect button is disabled when input is empty", () => {
    renderOnGitHubTab();
    expect(screen.getByTestId("project-settings-connect")).toBeDisabled();
  });

  it("Connect button is enabled when input has a value", () => {
    renderOnGitHubTab();
    fireEvent.change(screen.getByTestId("project-settings-token-input"), {
      target: { value: "ghp_test123" },
    });
    expect(screen.getByTestId("project-settings-connect")).not.toBeDisabled();
  });

  it("calls onGitHubTokenSubmit with trimmed token on Connect click", () => {
    const onGitHubTokenSubmit = vi.fn();
    renderOnGitHubTab({ onGitHubTokenSubmit });
    fireEvent.change(screen.getByTestId("project-settings-token-input"), {
      target: { value: "  ghp_test123  " },
    });
    fireEvent.click(screen.getByTestId("project-settings-connect"));
    expect(onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_test123");
  });

  it("calls onGitHubTokenSubmit on Enter in input", () => {
    const onGitHubTokenSubmit = vi.fn();
    renderOnGitHubTab({ onGitHubTokenSubmit });
    const input = screen.getByTestId("project-settings-token-input");
    fireEvent.change(input, { target: { value: "ghp_test123" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_test123");
  });

  it("does not call onGitHubTokenSubmit on Enter with empty input", () => {
    const onGitHubTokenSubmit = vi.fn();
    renderOnGitHubTab({ onGitHubTokenSubmit });
    fireEvent.keyDown(screen.getByTestId("project-settings-token-input"), { key: "Enter" });
    expect(onGitHubTokenSubmit).not.toHaveBeenCalled();
  });

  it("shows connected state with username when authenticated", () => {
    renderOnGitHubTab({ githubStatus: { authenticated: true, username: "octocat" } });
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows Disconnect button when authenticated", () => {
    renderOnGitHubTab({ githubStatus: { authenticated: true, username: "octocat" } });
    expect(screen.getByTestId("project-settings-disconnect")).toHaveTextContent("Disconnect");
  });

  it("Disconnect button requires double-click confirmation", () => {
    const onGitHubLogout = vi.fn();
    renderOnGitHubTab({
      githubStatus: { authenticated: true, username: "octocat" },
      onGitHubLogout,
    });
    const btn = screen.getByTestId("project-settings-disconnect");
    fireEvent.click(btn);
    expect(onGitHubLogout).not.toHaveBeenCalled();
    expect(btn).toHaveTextContent("Click again to disconnect");
    fireEvent.click(btn);
    expect(onGitHubLogout).toHaveBeenCalledOnce();
  });

  it("Disconnect confirmation resets on blur", () => {
    renderOnGitHubTab({ githubStatus: { authenticated: true, username: "octocat" } });
    const btn = screen.getByTestId("project-settings-disconnect");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("Click again to disconnect");
    fireEvent.blur(btn);
    expect(btn).toHaveTextContent("Disconnect");
  });

  it("links to GitHub token settings page", () => {
    renderOnGitHubTab();
    const link = screen.getByText("GitHub Settings");
    expect(link).toHaveAttribute("href", "https://github.com/settings/tokens/new");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("mentions classic token requirement", () => {
    renderOnGitHubTab();
    expect(screen.getByText("classic")).toBeInTheDocument();
    expect(screen.getByText(/fine-grained tokens are not supported/i)).toBeInTheDocument();
  });
});

describe("ProjectSettings - Instructions tab", () => {
  function renderOnInstructionsTab(props: Partial<ProjectSettingsProps> = {}) {
    const result = render(<ProjectSettings {...defaultProps} {...props} />);
    fireEvent.click(screen.getByText("Instructions"));
    return result;
  }

  it("renders textarea with placeholder", () => {
    renderOnInstructionsTab();
    const textarea = screen.getByTestId("project-settings-textarea");
    expect(textarea).toHaveValue("");
    expect(textarea).toHaveAttribute("placeholder");
  });

  it("renders with existing content from initialContent", () => {
    renderOnInstructionsTab({ initialContent: "Always use TypeScript." });
    expect(screen.getByTestId("project-settings-textarea")).toHaveValue("Always use TypeScript.");
  });

  it("displays character count", () => {
    renderOnInstructionsTab({ initialContent: "Hello" });
    expect(screen.getByText("5 / 50,000")).toBeInTheDocument();
  });

  it("updates character count as user types", () => {
    renderOnInstructionsTab();
    fireEvent.change(screen.getByTestId("project-settings-textarea"), {
      target: { value: "Use strict mode." },
    });
    expect(screen.getByText("16 / 50,000")).toBeInTheDocument();
  });

  it("calls onSaveInstructions when Save is clicked", () => {
    const onSaveInstructions = vi.fn();
    renderOnInstructionsTab({ initialContent: "Original", onSaveInstructions });
    fireEvent.change(screen.getByTestId("project-settings-textarea"), {
      target: { value: "Updated content" },
    });
    fireEvent.click(screen.getByTestId("project-settings-save"));
    expect(onSaveInstructions).toHaveBeenCalledWith("Updated content");
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    renderOnInstructionsTab({ onClose });
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables Save when content exceeds 50,000 characters", () => {
    renderOnInstructionsTab({ initialContent: "x".repeat(50_001) });
    expect(screen.getByTestId("project-settings-save")).toBeDisabled();
  });

  it("shows CLAUDE.md note", () => {
    renderOnInstructionsTab();
    expect(screen.getByText(/CLAUDE\.md/)).toBeInTheDocument();
  });

  it("calls onSaveInstructions on Ctrl+Enter", () => {
    const onSaveInstructions = vi.fn();
    renderOnInstructionsTab({ initialContent: "Test content", onSaveInstructions });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(onSaveInstructions).toHaveBeenCalledWith("Test content");
  });

  it("saves with empty string when content is cleared", () => {
    const onSaveInstructions = vi.fn();
    renderOnInstructionsTab({ initialContent: "Existing", onSaveInstructions });
    fireEvent.change(screen.getByTestId("project-settings-textarea"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("project-settings-save"));
    expect(onSaveInstructions).toHaveBeenCalledWith("");
  });
});

describe("ProjectSettings - Gemini agent section", () => {
  const geminiNotInstalled = {
    id: "gemini",
    name: "Gemini",
    installed: false,
    authConfigured: false,
    models: [],
  };

  it("shows Gemini section when gemini is in agentList", () => {
    render(<ProjectSettings {...defaultProps} agentList={[geminiNotInstalled]} />);
    expect(screen.getByTestId("gemini-agent-section")).toBeInTheDocument();
    expect(screen.getByText("Gemini")).toBeInTheDocument();
  });

  it("shows 'Not installed' for gemini when not installed", () => {
    render(<ProjectSettings {...defaultProps} agentList={[geminiNotInstalled]} />);
    expect(screen.getByText("Not installed")).toBeInTheDocument();
  });
});

describe("ProjectSettings - Advanced tab", () => {
  function renderOnAdvancedTab(props: Partial<ProjectSettingsProps> = {}) {
    const result = render(<ProjectSettings {...defaultProps} {...props} />);
    fireEvent.click(screen.getByText("Advanced"));
    return result;
  }

  it("renders Reset Container section", () => {
    renderOnAdvancedTab();
    expect(screen.getByText("Reset Container")).toBeInTheDocument();
    expect(screen.getByText(/Delete all sessions, chat history/)).toBeInTheDocument();
  });

  it("renders Reset Everything button", () => {
    renderOnAdvancedTab();
    expect(screen.getByTestId("project-settings-reset")).toHaveTextContent("Reset Everything");
  });

  it("first click shows confirmation text", () => {
    renderOnAdvancedTab();
    const btn = screen.getByTestId("project-settings-reset");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("Click again to confirm reset");
  });

  it("confirmation resets on blur", () => {
    renderOnAdvancedTab();
    const btn = screen.getByTestId("project-settings-reset");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("Click again to confirm reset");
    fireEvent.blur(btn);
    expect(btn).toHaveTextContent("Reset Everything");
  });

  it("second click calls onFullReset", () => {
    const onFullReset = vi.fn();
    renderOnAdvancedTab({ onFullReset });
    const btn = screen.getByTestId("project-settings-reset");
    fireEvent.click(btn);
    expect(onFullReset).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(onFullReset).toHaveBeenCalledOnce();
  });

  it("button shows disabled/loading state after confirmation click", () => {
    const onFullReset = vi.fn();
    renderOnAdvancedTab({ onFullReset });
    const btn = screen.getByTestId("project-settings-reset");
    fireEvent.click(btn); // first click — confirm
    fireEvent.click(btn); // second click — trigger
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Resetting...");
  });
});

describe("ProjectSettings - Tab switching", () => {
  it("Agent tab is selected by default", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByTestId("project-settings-api-key-input")).toBeInTheDocument();
  });

  it("clicking GitHub tab switches to GitHub section", () => {
    render(<ProjectSettings {...defaultProps} />);
    fireEvent.click(screen.getByText("GitHub"));
    expect(screen.getByTestId("project-settings-token-input")).toBeInTheDocument();
    expect(screen.queryByTestId("project-settings-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Instructions tab switches to instructions section", () => {
    render(<ProjectSettings {...defaultProps} />);
    fireEvent.click(screen.getByText("Instructions"));
    expect(screen.getByTestId("project-settings-textarea")).toBeInTheDocument();
    expect(screen.queryByTestId("project-settings-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Advanced tab switches to advanced section", () => {
    render(<ProjectSettings {...defaultProps} />);
    fireEvent.click(screen.getByText("Advanced"));
    expect(screen.getByTestId("project-settings-reset")).toBeInTheDocument();
    expect(screen.queryByTestId("project-settings-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Agent tab switches back", () => {
    render(<ProjectSettings {...defaultProps} />);
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.click(screen.getByText("Agent"));
    expect(screen.getByTestId("project-settings-api-key-input")).toBeInTheDocument();
    expect(screen.queryByTestId("project-settings-token-input")).not.toBeInTheDocument();
  });
});
