import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Settings, type SettingsProps } from "./Settings.js";
import { useUiStore } from "../stores/ui-store.js";
import type { DeployTargetInfo } from "../../server/shared/types.js";

afterEach(() => {
  cleanup();
  useUiStore.getState().setSettingsTab(undefined);
});

const claudeAuthed = { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: ["claude-sonnet"] };
const claudeUnauthed = { ...claudeAuthed, authConfigured: false };

const defaultProps: SettingsProps = {
  initialContent: "",
  onSaveInstructions: vi.fn(),
  githubStatus: { authenticated: false },
  onGitHubTokenSubmit: vi.fn(),
  onGitHubLogout: vi.fn(),
  authUrl: null,
  onApiKey: vi.fn(),
  onClearApiKey: vi.fn(),
  onStartAuth: vi.fn(),
  onPasteCode: vi.fn(),
  agentList: [claudeAuthed],
  gitIdentity: { name: "", email: "" },
  onGitIdentitySave: vi.fn(),
  maxIdleContainers: 5,
  onMaxIdleContainersSave: vi.fn(),
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
    const { container } = render(<Settings {...defaultProps} onClose={onClose} />);
    const backdrop = container.querySelector('[aria-hidden="true"]')!;
    fireEvent.click(backdrop);
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

  it("renders ClaudeAuthCard", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("claude-auth-card")).toBeInTheDocument();
  });

  it("shows authenticated state when agent is auth-configured", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Authenticated")).toBeInTheDocument();
  });

  it("shows not-authenticated state when agent is not auth-configured", () => {
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} authUrl="https://auth.example.com" />);
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Not authenticated")).toBeInTheDocument();
  });

  it("shows API key input when authenticated (showApiKeyWhenAuthed)", () => {
    render(<Settings {...defaultProps} />);
    const input = screen.getByTestId("claude-api-key-input");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("calls onApiKey when API key is submitted", async () => {
    const onApiKey = vi.fn();
    render(<Settings {...defaultProps} onApiKey={onApiKey} />);
    fireEvent.change(screen.getByTestId("claude-api-key-input"), { target: { value: "sk-ant-test123" } });
    fireEvent.click(screen.getByTestId("claude-api-key-submit"));
    await waitFor(() => expect(onApiKey).toHaveBeenCalledWith("sk-ant-test123"));
  });

  it("shows Open Authentication Page link when authUrl is set", () => {
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} authUrl="https://auth.example.com" />);
    const link = screen.getByTestId("claude-open-auth-url");
    expect(link).toHaveTextContent("Open Authentication Page");
    expect(link).toHaveAttribute("href", "https://auth.example.com");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows Clear API Key button when authenticated", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("claude-clear-api-key")).toHaveTextContent("Clear API Key");
  });

  it("calls onClearApiKey when Clear API Key is clicked", () => {
    const onClearApiKey = vi.fn();
    render(<Settings {...defaultProps} onClearApiKey={onClearApiKey} />);
    fireEvent.click(screen.getByTestId("claude-clear-api-key"));
    expect(onClearApiKey).toHaveBeenCalledOnce();
  });

  it("does not show Clear API Key when not authenticated", () => {
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} authUrl="https://auth.example.com" />);
    expect(screen.queryByTestId("claude-clear-api-key")).not.toBeInTheDocument();
  });
});

describe("Settings - GitHub tab", () => {
  function renderOnGitHubTab(props: Partial<SettingsProps> = {}) {
    const result = render(<Settings {...defaultProps} {...props} />);
    fireEvent.click(screen.getByText("GitHub"));
    return result;
  }

  it("shows GitHubTokenForm when not authenticated", () => {
    renderOnGitHubTab();
    expect(screen.getByTestId("github-token-form")).toBeInTheDocument();
  });

  it("calls onGitHubTokenSubmit with trimmed token", async () => {
    const onGitHubTokenSubmit = vi.fn();
    renderOnGitHubTab({ onGitHubTokenSubmit });
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "  ghp_test123  " } });
    fireEvent.click(screen.getByTestId("github-token-submit"));
    await waitFor(() => expect(onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_test123"));
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
});

describe("Settings - Git tab", () => {
  function renderOnGitTab(props: Partial<SettingsProps> = {}) {
    const result = render(<Settings {...defaultProps} {...props} />);
    fireEvent.click(screen.getByText("Git"));
    return result;
  }

  it("shows description text", () => {
    renderOnGitTab();
    expect(screen.getByText(/git identity used for automatic commits/i)).toBeInTheDocument();
  });

  it("shows name and email inputs", () => {
    renderOnGitTab();
    expect(screen.getByTestId("settings-git-name")).toBeInTheDocument();
    expect(screen.getByTestId("settings-git-email")).toBeInTheDocument();
  });

  it("pre-fills inputs from gitIdentity prop", () => {
    renderOnGitTab({ gitIdentity: { name: "Alice", email: "alice@example.com" } });
    expect(screen.getByTestId("settings-git-name")).toHaveValue("Alice");
    expect(screen.getByTestId("settings-git-email")).toHaveValue("alice@example.com");
  });

  it("Save button is disabled when name is empty", () => {
    renderOnGitTab({ gitIdentity: { name: "", email: "a@b.com" } });
    expect(screen.getByTestId("settings-git-save")).toBeDisabled();
  });

  it("Save button is disabled when email is empty", () => {
    renderOnGitTab({ gitIdentity: { name: "Alice", email: "" } });
    fireEvent.change(screen.getByTestId("settings-git-email"), { target: { value: "" } });
    expect(screen.getByTestId("settings-git-save")).toBeDisabled();
  });

  it("calls onGitIdentitySave with trimmed values on Save click", () => {
    const onGitIdentitySave = vi.fn();
    renderOnGitTab({ onGitIdentitySave });
    fireEvent.change(screen.getByTestId("settings-git-name"), { target: { value: "  Bob  " } });
    fireEvent.change(screen.getByTestId("settings-git-email"), { target: { value: "  bob@test.com  " } });
    fireEvent.click(screen.getByTestId("settings-git-save"));
    expect(onGitIdentitySave).toHaveBeenCalledWith("Bob", "bob@test.com");
  });

  it("shows Saved label after saving", () => {
    const onGitIdentitySave = vi.fn();
    renderOnGitTab({ onGitIdentitySave });
    fireEvent.change(screen.getByTestId("settings-git-name"), { target: { value: "Bob" } });
    fireEvent.change(screen.getByTestId("settings-git-email"), { target: { value: "bob@test.com" } });
    fireEvent.click(screen.getByTestId("settings-git-save"));
    expect(screen.getByTestId("settings-git-save")).toHaveTextContent("Saved");
  });

  it("resets Saved label when input changes", () => {
    const onGitIdentitySave = vi.fn();
    renderOnGitTab({ onGitIdentitySave });
    fireEvent.change(screen.getByTestId("settings-git-name"), { target: { value: "Bob" } });
    fireEvent.change(screen.getByTestId("settings-git-email"), { target: { value: "bob@test.com" } });
    fireEvent.click(screen.getByTestId("settings-git-save"));
    expect(screen.getByTestId("settings-git-save")).toHaveTextContent("Saved");
    fireEvent.change(screen.getByTestId("settings-git-name"), { target: { value: "Charlie" } });
    expect(screen.getByTestId("settings-git-save")).toHaveTextContent("Save");
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

describe("Settings - Codex agent section", () => {
  const codexInstalled = {
    id: "codex",
    name: "Codex",
    installed: true,
    authConfigured: false,
    models: ["codex-mini-latest"],
  };

  it("shows CodexAuthCard when codex is in agentList", () => {
    render(<Settings {...defaultProps} agentList={[claudeAuthed, codexInstalled]} />);
    expect(screen.getByTestId("codex-auth-card")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("does not show CodexAuthCard when agentList has no codex", () => {
    render(<Settings {...defaultProps} agentList={[claudeAuthed]} />);
    expect(screen.queryByTestId("codex-auth-card")).not.toBeInTheDocument();
  });

  it("calls onSetAgentEnv when codex API key is submitted", async () => {
    const onSetAgentEnv = vi.fn();
    render(<Settings {...defaultProps} agentList={[claudeAuthed, codexInstalled]} onSetAgentEnv={onSetAgentEnv} />);
    fireEvent.change(screen.getByTestId("codex-api-key-input"), { target: { value: "sk-test-key" } });
    fireEvent.click(screen.getByTestId("codex-api-key-submit"));
    await waitFor(() => expect(onSetAgentEnv).toHaveBeenCalledWith("codex", "OPENAI_API_KEY", "sk-test-key"));
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

  it("renders Max Idle Containers section", () => {
    renderOnAdvancedTab();
    expect(screen.getByText("Max Idle Containers")).toBeInTheDocument();
    expect(screen.getByTestId("settings-max-idle-containers")).toHaveValue(5);
  });

  it("calls onMaxIdleContainersSave when save is clicked", () => {
    const onMaxIdleContainersSave = vi.fn();
    renderOnAdvancedTab({ maxIdleContainers: 3, onMaxIdleContainersSave });
    const input = screen.getByTestId("settings-max-idle-containers");
    expect(input).toHaveValue(3);
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.click(screen.getByTestId("settings-max-idle-containers-save"));
    expect(onMaxIdleContainersSave).toHaveBeenCalledWith(7);
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
    expect(screen.getByTestId("claude-api-key-input")).toBeInTheDocument();
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
    useUiStore.getState().setSettingsTab("deploy");
    return render(
      <Settings
        {...defaultProps}
        hasActiveSession={true}
        deployTargets={[fakeTarget, fakeTarget2]}
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

  it("calls onDeployTabSelected on mount when settingsTab is deploy", () => {
    const onDeployTabSelected = vi.fn();
    useUiStore.getState().setSettingsTab("deploy");
    render(
      <Settings {...defaultProps} hasActiveSession={true} onDeployTabSelected={onDeployTabSelected} />,
    );
    expect(onDeployTabSelected).toHaveBeenCalled();
  });
});

describe("Settings - Tab switching", () => {
  it("Agent tab is selected by default", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("claude-api-key-input")).toBeInTheDocument();
  });

  it("clicking GitHub tab switches to GitHub section", () => {
    render(<Settings {...defaultProps} />);
    fireEvent.click(screen.getByText("GitHub"));
    expect(screen.getByTestId("github-token-form")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Git tab switches to git section", () => {
    render(<Settings {...defaultProps} />);
    fireEvent.click(screen.getByText("Git"));
    expect(screen.getByTestId("settings-git-name")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Instructions tab switches to instructions section", () => {
    render(<Settings {...defaultProps} />);
    fireEvent.click(screen.getByText("Instructions"));
    expect(screen.getByTestId("settings-textarea")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Advanced tab switches to advanced section", () => {
    render(<Settings {...defaultProps} />);
    fireEvent.click(screen.getByText("Advanced"));
    expect(screen.getByTestId("settings-reset")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Deploy tab switches to deploy section when session active", () => {
    render(<Settings {...defaultProps} hasActiveSession={true} deployTargets={[]} />);
    fireEvent.click(screen.getByTestId("settings-tab-deploy"));
    expect(screen.getByText("Deploy Targets")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-api-key-input")).not.toBeInTheDocument();
  });

  it("clicking Agent tab switches back", () => {
    render(<Settings {...defaultProps} />);
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.click(screen.getByText("Agent"));
    expect(screen.getByTestId("claude-api-key-input")).toBeInTheDocument();
    expect(screen.queryByTestId("github-token-form")).not.toBeInTheDocument();
  });
});
