import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Settings, type SettingsProps } from "./Settings.js";
import type { DeployTargetInfo } from "../../server/types.js";

afterEach(cleanup);

const defaultProps: SettingsProps = {
  initialContent: "",
  onSaveInstructions: vi.fn(),
  githubStatus: { authenticated: false },
  onGitHubTokenSubmit: vi.fn(),
  onGitHubLogout: vi.fn(),
  authUrl: null,
  onApiKey: vi.fn(),
  onClearApiKey: vi.fn(),
  deployTargets: [],
  deployConfigStatus: {},
  onDeployConfigure: vi.fn(),
  onDeployDeleteConfig: vi.fn(),
  hasActiveSession: false,
  onClose: vi.fn(),
};

describe("Settings", () => {
  it("renders dialog with correct role and aria-label", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Settings");
  });

  it("renders header title", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("calls onClose on backdrop click", () => {
    const onClose = vi.fn();
    render(<Settings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("settings-backdrop"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when clicking inside the modal", () => {
    const onClose = vi.fn();
    render(<Settings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText("Settings"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape key", () => {
    const onClose = vi.fn();
    render(<Settings {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on close button (x) click", () => {
    const onClose = vi.fn();
    render(<Settings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Settings - Agent tab", () => {
  it("shows Agent tab by default", () => {
    render(<Settings {...defaultProps} />);
    const tab = screen.getByText("Agent");
    expect(tab.className).toContain("font-medium");
  });

  it("shows authenticated state when authUrl is null", () => {
    render(<Settings {...defaultProps} authUrl={null} />);
    expect(screen.getByText("Claude CLI")).toBeInTheDocument();
    expect(screen.getByText("Authenticated")).toBeInTheDocument();
  });

  it("shows auth required state when authUrl is set", () => {
    render(<Settings {...defaultProps} authUrl="https://auth.example.com" />);
    expect(screen.getByText("Claude CLI")).toBeInTheDocument();
    expect(screen.getByText("Authentication required")).toBeInTheDocument();
  });

  it("shows API key input", () => {
    render(<Settings {...defaultProps} />);
    const input = screen.getByTestId("settings-api-key-input");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("submit button is disabled when input is empty", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("settings-api-key-submit")).toBeDisabled();
  });

  it("calls onApiKey with valid key on submit", () => {
    const onApiKey = vi.fn();
    render(<Settings {...defaultProps} onApiKey={onApiKey} />);
    fireEvent.change(screen.getByTestId("settings-api-key-input"), {
      target: { value: "sk-ant-test123" },
    });
    fireEvent.click(screen.getByTestId("settings-api-key-submit"));
    expect(onApiKey).toHaveBeenCalledWith("sk-ant-test123");
  });

  it("shows error for invalid API key format", () => {
    const onApiKey = vi.fn();
    render(<Settings {...defaultProps} onApiKey={onApiKey} />);
    fireEvent.change(screen.getByTestId("settings-api-key-input"), {
      target: { value: "invalid-key" },
    });
    fireEvent.click(screen.getByTestId("settings-api-key-submit"));
    expect(onApiKey).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-api-key-error")).toHaveTextContent("sk-ant-");
  });

  it("calls onApiKey on Enter in input", () => {
    const onApiKey = vi.fn();
    render(<Settings {...defaultProps} onApiKey={onApiKey} />);
    const input = screen.getByTestId("settings-api-key-input");
    fireEvent.change(input, { target: { value: "sk-ant-test123" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onApiKey).toHaveBeenCalledWith("sk-ant-test123");
  });

  it("clears error when input changes", () => {
    render(<Settings {...defaultProps} />);
    const input = screen.getByTestId("settings-api-key-input");
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.click(screen.getByTestId("settings-api-key-submit"));
    expect(screen.getByTestId("settings-api-key-error")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "sk-ant-new" } });
    expect(screen.queryByTestId("settings-api-key-error")).not.toBeInTheDocument();
  });

  it("shows Authenticate button when auth is required", () => {
    render(<Settings {...defaultProps} authUrl="https://auth.example.com" />);
    expect(screen.getByTestId("settings-api-key-submit")).toHaveTextContent("Authenticate");
  });

  it("shows Set API Key button when already authenticated", () => {
    render(<Settings {...defaultProps} authUrl={null} />);
    expect(screen.getByTestId("settings-api-key-submit")).toHaveTextContent("Set API Key");
  });

  it("shows Clear API Key button when authenticated", () => {
    render(<Settings {...defaultProps} authUrl={null} />);
    expect(screen.getByTestId("settings-clear-api-key")).toHaveTextContent("Clear API Key");
  });

  it("calls onClearApiKey when Clear API Key is clicked", () => {
    const onClearApiKey = vi.fn();
    render(<Settings {...defaultProps} authUrl={null} onClearApiKey={onClearApiKey} />);
    fireEvent.click(screen.getByTestId("settings-clear-api-key"));
    expect(onClearApiKey).toHaveBeenCalledOnce();
  });

  it("does not show Clear API Key button when auth is required", () => {
    render(<Settings {...defaultProps} authUrl="https://auth.example.com" />);
    expect(screen.queryByTestId("settings-clear-api-key")).not.toBeInTheDocument();
  });
});

describe("Settings - GitHub tab", () => {
  function renderOnGitHubTab(props: Partial<SettingsProps> = {}) {
    const result = render(<Settings {...defaultProps} {...props} />);
    fireEvent.click(screen.getByText("GitHub"));
    return result;
  }

  it("shows token input when not authenticated", () => {
    renderOnGitHubTab();
    const input = screen.getByTestId("settings-token-input");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("Connect button is disabled when input is empty", () => {
    renderOnGitHubTab();
    expect(screen.getByTestId("settings-connect")).toBeDisabled();
  });

  it("Connect button is enabled when input has a value", () => {
    renderOnGitHubTab();
    fireEvent.change(screen.getByTestId("settings-token-input"), {
      target: { value: "ghp_test123" },
    });
    expect(screen.getByTestId("settings-connect")).not.toBeDisabled();
  });

  it("calls onGitHubTokenSubmit with trimmed token on Connect click", () => {
    const onGitHubTokenSubmit = vi.fn();
    renderOnGitHubTab({ onGitHubTokenSubmit });
    fireEvent.change(screen.getByTestId("settings-token-input"), {
      target: { value: "  ghp_test123  " },
    });
    fireEvent.click(screen.getByTestId("settings-connect"));
    expect(onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_test123");
  });

  it("calls onGitHubTokenSubmit on Enter in input", () => {
    const onGitHubTokenSubmit = vi.fn();
    renderOnGitHubTab({ onGitHubTokenSubmit });
    const input = screen.getByTestId("settings-token-input");
    fireEvent.change(input, { target: { value: "ghp_test123" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_test123");
  });

  it("does not call onGitHubTokenSubmit on Enter with empty input", () => {
    const onGitHubTokenSubmit = vi.fn();
    renderOnGitHubTab({ onGitHubTokenSubmit });
    fireEvent.keyDown(screen.getByTestId("settings-token-input"), { key: "Enter" });
    expect(onGitHubTokenSubmit).not.toHaveBeenCalled();
  });

  it("shows connected state with username when authenticated", () => {
    renderOnGitHubTab({ githubStatus: { authenticated: true, username: "octocat" } });
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows Disconnect button when authenticated", () => {
    renderOnGitHubTab({ githubStatus: { authenticated: true, username: "octocat" } });
    expect(screen.getByTestId("settings-disconnect")).toHaveTextContent("Disconnect");
  });

  it("Disconnect button requires double-click confirmation", () => {
    const onGitHubLogout = vi.fn();
    renderOnGitHubTab({
      githubStatus: { authenticated: true, username: "octocat" },
      onGitHubLogout,
    });
    const btn = screen.getByTestId("settings-disconnect");
    fireEvent.click(btn);
    expect(onGitHubLogout).not.toHaveBeenCalled();
    expect(btn).toHaveTextContent("Click again to disconnect");
    fireEvent.click(btn);
    expect(onGitHubLogout).toHaveBeenCalledOnce();
  });

  it("Disconnect confirmation resets on blur", () => {
    renderOnGitHubTab({ githubStatus: { authenticated: true, username: "octocat" } });
    const btn = screen.getByTestId("settings-disconnect");
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

describe("Settings - Instructions tab", () => {
  function renderOnInstructionsTab(props: Partial<SettingsProps> = {}) {
    const result = render(<Settings {...defaultProps} {...props} />);
    fireEvent.click(screen.getByText("Instructions"));
    return result;
  }

  it("renders textarea with placeholder", () => {
    renderOnInstructionsTab();
    const textarea = screen.getByTestId("settings-textarea");
    expect(textarea).toHaveValue("");
    expect(textarea).toHaveAttribute("placeholder");
  });

  it("renders with existing content from initialContent", () => {
    renderOnInstructionsTab({ initialContent: "Always use TypeScript." });
    expect(screen.getByTestId("settings-textarea")).toHaveValue("Always use TypeScript.");
  });

  it("displays character count", () => {
    renderOnInstructionsTab({ initialContent: "Hello" });
    expect(screen.getByText("5 / 50,000")).toBeInTheDocument();
  });

  it("updates character count as user types", () => {
    renderOnInstructionsTab();
    fireEvent.change(screen.getByTestId("settings-textarea"), {
      target: { value: "Use strict mode." },
    });
    expect(screen.getByText("16 / 50,000")).toBeInTheDocument();
  });

  it("calls onSaveInstructions when Save is clicked", () => {
    const onSaveInstructions = vi.fn();
    renderOnInstructionsTab({ initialContent: "Original", onSaveInstructions });
    fireEvent.change(screen.getByTestId("settings-textarea"), {
      target: { value: "Updated content" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));
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
    expect(screen.getByTestId("settings-save")).toBeDisabled();
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
    fireEvent.change(screen.getByTestId("settings-textarea"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(onSaveInstructions).toHaveBeenCalledWith("");
  });
});

describe("Settings - Agent list", () => {
  it("calls onRequestAgentList on mount", () => {
    const onRequestAgentList = vi.fn();
    render(<Settings {...defaultProps} onRequestAgentList={onRequestAgentList} />);
    expect(onRequestAgentList).toHaveBeenCalledOnce();
  });
});

describe("Settings - Codex agent section", () => {
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
    render(<Settings {...defaultProps} agentList={[codexInstalled]} />);
    expect(screen.getByTestId("codex-agent-section")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("does not show Codex section when agentList is empty", () => {
    render(<Settings {...defaultProps} agentList={[]} />);
    expect(screen.queryByTestId("codex-agent-section")).not.toBeInTheDocument();
  });

  it("shows 'Not installed' when codex is not installed", () => {
    render(<Settings {...defaultProps} agentList={[codexNotInstalled]} />);
    expect(screen.getByText("Not installed")).toBeInTheDocument();
  });

  it("shows 'API key not set' when installed but not auth-configured", () => {
    render(<Settings {...defaultProps} agentList={[codexInstalled]} />);
    expect(screen.getByText("API key not set")).toBeInTheDocument();
  });

  it("shows 'Authenticated' when installed and auth-configured", () => {
    render(<Settings {...defaultProps} agentList={[codexAuthenticated]} />);
    expect(screen.getAllByText("Authenticated")).toHaveLength(2); // Claude + Codex
  });

  it("shows API key input when installed but not auth-configured", () => {
    render(<Settings {...defaultProps} agentList={[codexInstalled]} />);
    expect(screen.getByTestId("codex-api-key-input")).toBeInTheDocument();
    expect(screen.getByTestId("codex-api-key-input")).toHaveAttribute("type", "password");
  });

  it("hides API key input when auth is already configured", () => {
    render(<Settings {...defaultProps} agentList={[codexAuthenticated]} />);
    expect(screen.queryByTestId("codex-api-key-input")).not.toBeInTheDocument();
  });

  it("hides API key input when codex is not installed", () => {
    render(<Settings {...defaultProps} agentList={[codexNotInstalled]} />);
    expect(screen.queryByTestId("codex-api-key-input")).not.toBeInTheDocument();
  });

  it("Save button is disabled when codex key input is empty", () => {
    render(<Settings {...defaultProps} agentList={[codexInstalled]} />);
    expect(screen.getByTestId("codex-api-key-submit")).toBeDisabled();
  });

  it("calls onSetAgentEnv when Save is clicked with a key", () => {
    const onSetAgentEnv = vi.fn();
    render(<Settings {...defaultProps} agentList={[codexInstalled]} onSetAgentEnv={onSetAgentEnv} />);
    const input = screen.getByTestId("codex-api-key-input");
    fireEvent.change(input, { target: { value: "sk-test-key" } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    expect(onSetAgentEnv).toHaveBeenCalledWith("codex", "OPENAI_API_KEY", "sk-test-key");
  });

  it("calls onSetAgentEnv on Enter in codex key input", () => {
    const onSetAgentEnv = vi.fn();
    render(<Settings {...defaultProps} agentList={[codexInstalled]} onSetAgentEnv={onSetAgentEnv} />);
    const input = screen.getByTestId("codex-api-key-input");
    fireEvent.change(input, { target: { value: "sk-test-key" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSetAgentEnv).toHaveBeenCalledWith("codex", "OPENAI_API_KEY", "sk-test-key");
  });

  it("clears codex key input after submit", () => {
    const onSetAgentEnv = vi.fn();
    render(<Settings {...defaultProps} agentList={[codexInstalled]} onSetAgentEnv={onSetAgentEnv} />);
    const input = screen.getByTestId("codex-api-key-input");
    fireEvent.change(input, { target: { value: "sk-test-key" } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    expect(input).toHaveValue("");
  });
});

describe("Settings - Gemini agent section", () => {
  const geminiNotInstalled = {
    id: "gemini",
    name: "Gemini",
    installed: false,
    authConfigured: false,
    models: [],
  };

  it("shows Gemini section when gemini is in agentList", () => {
    render(<Settings {...defaultProps} agentList={[geminiNotInstalled]} />);
    expect(screen.getByTestId("gemini-agent-section")).toBeInTheDocument();
    expect(screen.getByText("Gemini")).toBeInTheDocument();
  });

  it("shows 'Not installed' for gemini when not installed", () => {
    render(<Settings {...defaultProps} agentList={[geminiNotInstalled]} />);
    expect(screen.getByText("Not installed")).toBeInTheDocument();
  });
});

describe("Settings - Advanced tab", () => {
  function renderOnAdvancedTab(props: Partial<SettingsProps> = {}) {
    const result = render(<Settings {...defaultProps} {...props} />);
    fireEvent.click(screen.getByText("Advanced"));
    return result;
  }

  it("renders Reset Container section", () => {
    renderOnAdvancedTab();
    expect(screen.getByText("Reset Container")).toBeInTheDocument();
    expect(screen.getByText(/Delete all sessions/)).toBeInTheDocument();
  });

  it("renders Reset Everything button", () => {
    renderOnAdvancedTab();
    expect(screen.getByTestId("settings-reset")).toHaveTextContent("Reset Everything");
  });

  it("first click shows confirmation text", () => {
    renderOnAdvancedTab();
    fireEvent.click(screen.getByTestId("settings-reset"));
    expect(screen.getByTestId("settings-reset")).toHaveTextContent("Click again to confirm reset");
  });

  it("confirmation resets on blur", () => {
    renderOnAdvancedTab();
    const btn = screen.getByTestId("settings-reset");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("Click again to confirm reset");
    fireEvent.blur(btn);
    expect(btn).toHaveTextContent("Reset Everything");
  });

  it("second click calls onFullReset", () => {
    const onFullReset = vi.fn();
    renderOnAdvancedTab({ onFullReset });
    const btn = screen.getByTestId("settings-reset");
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onFullReset).toHaveBeenCalledOnce();
  });

  it("button shows disabled state after confirmation", () => {
    const onFullReset = vi.fn();
    renderOnAdvancedTab({ onFullReset });
    const btn = screen.getByTestId("settings-reset");
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("Resetting...");
    expect(btn).toBeDisabled();
  });
});

describe("Settings - Sidebar groups", () => {
  it("renders General heading", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("renders Project heading", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("renders Deploy tab in sidebar", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("settings-tab-deploy")).toBeInTheDocument();
  });
});

describe("Settings - Deploy tab disabled", () => {
  it("Deploy tab is disabled when no active session", () => {
    render(<Settings {...defaultProps} hasActiveSession={false} />);
    expect(screen.getByTestId("settings-tab-deploy")).toBeDisabled();
  });

  it("Deploy tab has tooltip when disabled", () => {
    render(<Settings {...defaultProps} hasActiveSession={false} />);
    expect(screen.getByTestId("settings-tab-deploy")).toHaveAttribute("title", "Requires active session");
  });

  it("clicking disabled Deploy tab does not switch tabs", () => {
    render(<Settings {...defaultProps} hasActiveSession={false} />);
    fireEvent.click(screen.getByTestId("settings-tab-deploy"));
    expect(screen.getByTestId("settings-api-key-input")).toBeInTheDocument();
  });

  it("Deploy tab is enabled when session is active", () => {
    render(<Settings {...defaultProps} hasActiveSession={true} />);
    expect(screen.getByTestId("settings-tab-deploy")).not.toBeDisabled();
  });

  it("Deploy tab has no tooltip when enabled", () => {
    render(<Settings {...defaultProps} hasActiveSession={true} />);
    expect(screen.getByTestId("settings-tab-deploy")).not.toHaveAttribute("title");
  });
});

describe("Settings - Deploy tab", () => {
  const fakeTarget: DeployTargetInfo = {
    id: "vercel",
    name: "Vercel",
    description: "Deploy to Vercel",
    configFields: [
      { key: "token", label: "API Token", required: true, sensitive: true, placeholder: "tok_xxx" },
    ],
    supportsPreview: true,
  };

  const fakeTarget2: DeployTargetInfo = {
    id: "cloudflare",
    name: "Cloudflare Pages",
    description: "Deploy to Cloudflare",
    configFields: [
      { key: "token", label: "CF Token", required: true, sensitive: true },
      { key: "accountId", label: "Account ID", required: true, sensitive: false },
    ],
    supportsPreview: false,
  };

  function renderOnDeployTab(props: Partial<SettingsProps> = {}) {
    return render(
      <Settings
        {...defaultProps}
        hasActiveSession={true}
        deployTargets={[fakeTarget, fakeTarget2]}
        initialTab="deploy"
        {...props}
      />,
    );
  }

  it("shows Deploy Targets heading", () => {
    renderOnDeployTab();
    expect(screen.getByText("Deploy Targets")).toBeInTheDocument();
  });

  it("shows target list with all targets", () => {
    renderOnDeployTab();
    expect(screen.getByText("Vercel")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare Pages")).toBeInTheDocument();
  });

  it("shows empty state when no targets available", () => {
    renderOnDeployTab({ deployTargets: [] });
    expect(screen.getByText("No deployment targets available.")).toBeInTheDocument();
  });

  it("shows Configured badge for configured targets", () => {
    renderOnDeployTab({ deployConfigStatus: { vercel: { configured: true } } });
    expect(screen.getByText("Configured")).toBeInTheDocument();
  });

  it("shows Configure link for unconfigured targets", () => {
    renderOnDeployTab();
    expect(screen.getByTestId("deploy-target-configure-vercel")).toHaveTextContent("Configure");
  });

  it("shows Reconfigure link for configured targets", () => {
    renderOnDeployTab({ deployConfigStatus: { vercel: { configured: true } } });
    expect(screen.getByTestId("deploy-target-configure-vercel")).toHaveTextContent("Reconfigure");
  });

  it("shows Remove credentials for configured targets", () => {
    renderOnDeployTab({ deployConfigStatus: { vercel: { configured: true } } });
    expect(screen.getByTestId("deploy-target-remove-vercel")).toHaveTextContent("Remove credentials");
  });

  it("does not show Remove credentials for unconfigured targets", () => {
    renderOnDeployTab();
    expect(screen.queryByTestId("deploy-target-remove-vercel")).not.toBeInTheDocument();
  });

  it("calls onDeployDeleteConfig when Remove credentials is clicked", () => {
    const onDeployDeleteConfig = vi.fn();
    renderOnDeployTab({
      deployConfigStatus: { vercel: { configured: true } },
      onDeployDeleteConfig,
    });
    fireEvent.click(screen.getByTestId("deploy-target-remove-vercel"));
    expect(onDeployDeleteConfig).toHaveBeenCalledWith("vercel");
  });

  it("shows config form when Configure is clicked", () => {
    renderOnDeployTab();
    fireEvent.click(screen.getByTestId("deploy-target-configure-vercel"));
    expect(screen.getByText("Configure Vercel")).toBeInTheDocument();
    expect(screen.getByText("API Token")).toBeInTheDocument();
    expect(screen.getByTestId("deploy-config-save")).toHaveTextContent("Save Configuration");
  });

  it("shows back button on config form", () => {
    renderOnDeployTab();
    fireEvent.click(screen.getByTestId("deploy-target-configure-vercel"));
    fireEvent.click(screen.getByLabelText("Back to targets"));
    expect(screen.getByText("Vercel")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare Pages")).toBeInTheDocument();
  });

  it("calls onDeployConfigure when config form is submitted", () => {
    const onDeployConfigure = vi.fn();
    renderOnDeployTab({ onDeployConfigure });
    fireEvent.click(screen.getByTestId("deploy-target-configure-vercel"));
    fireEvent.change(screen.getByTestId("deploy-config-field-token"), {
      target: { value: "my-token" },
    });
    fireEvent.click(screen.getByTestId("deploy-config-save"));
    expect(onDeployConfigure).toHaveBeenCalledWith("vercel", { token: "my-token" }, undefined);
  });

  it("passes project name when provided", () => {
    const onDeployConfigure = vi.fn();
    renderOnDeployTab({ onDeployConfigure });
    fireEvent.click(screen.getByTestId("deploy-target-configure-vercel"));
    fireEvent.change(screen.getByTestId("deploy-config-field-token"), {
      target: { value: "my-token" },
    });
    fireEvent.change(screen.getByTestId("deploy-config-project-name"), {
      target: { value: "my-project" },
    });
    fireEvent.click(screen.getByTestId("deploy-config-save"));
    expect(onDeployConfigure).toHaveBeenCalledWith("vercel", { token: "my-token" }, "my-project");
  });

  it("pre-fills project name for configured targets", () => {
    renderOnDeployTab({
      deployConfigStatus: { vercel: { configured: true, projectName: "existing-project" } },
    });
    fireEvent.click(screen.getByTestId("deploy-target-configure-vercel"));
    expect(screen.getByTestId("deploy-config-project-name")).toHaveValue("existing-project");
  });

  it("shows multiple config fields for targets with multiple fields", () => {
    renderOnDeployTab();
    fireEvent.click(screen.getByTestId("deploy-target-configure-cloudflare"));
    expect(screen.getByText("CF Token")).toBeInTheDocument();
    expect(screen.getByText("Account ID")).toBeInTheDocument();
  });

  it("calls onDeployTabSelected when deploy tab is activated", () => {
    const onDeployTabSelected = vi.fn();
    render(<Settings {...defaultProps} hasActiveSession={true} onDeployTabSelected={onDeployTabSelected} />);
    fireEvent.click(screen.getByTestId("settings-tab-deploy"));
    expect(onDeployTabSelected).toHaveBeenCalled();
  });

  it("calls onDeployTabSelected on mount when initialTab is deploy", () => {
    const onDeployTabSelected = vi.fn();
    render(
      <Settings {...defaultProps} hasActiveSession={true} initialTab="deploy" onDeployTabSelected={onDeployTabSelected} />,
    );
    expect(onDeployTabSelected).toHaveBeenCalled();
  });
});

describe("Settings - Tab switching", () => {
  it("Agent tab is selected by default", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("settings-api-key-input")).toBeInTheDocument();
  });

  it("clicking GitHub tab switches to GitHub section", () => {
    render(<Settings {...defaultProps} />);
    fireEvent.click(screen.getByText("GitHub"));
    expect(screen.getByTestId("settings-token-input")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Instructions tab switches to instructions section", () => {
    render(<Settings {...defaultProps} />);
    fireEvent.click(screen.getByText("Instructions"));
    expect(screen.getByTestId("settings-textarea")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Advanced tab switches to advanced section", () => {
    render(<Settings {...defaultProps} />);
    fireEvent.click(screen.getByText("Advanced"));
    expect(screen.getByTestId("settings-reset")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Deploy tab switches to deploy section when session active", () => {
    render(<Settings {...defaultProps} hasActiveSession={true} deployTargets={[]} />);
    fireEvent.click(screen.getByTestId("settings-tab-deploy"));
    expect(screen.getByText("Deploy Targets")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Agent tab switches back", () => {
    render(<Settings {...defaultProps} />);
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.click(screen.getByText("Agent"));
    expect(screen.getByTestId("settings-api-key-input")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-token-input")).not.toBeInTheDocument();
  });
});
