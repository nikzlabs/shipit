import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings, type SettingsProps } from "./Settings.js";
import { useUiStore } from "../stores/ui-store.js";
import { usePreviewStore } from "../stores/preview-store.js";

afterEach(() => {
  cleanup();
  useUiStore.getState().setSettingsTab(undefined);
  usePreviewStore.getState().setSecrets({
    declared: [],
    missingByService: {},
    missingRequired: [],
  });
});

const claudeAuthed = { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: ["claude-sonnet"], supportsReview: true };
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
  agentSystemInstructionsEnabled: true,
  agentSystemInstructions: "You are working inside ShipIt.",
  onToggleAgentSystemInstructions: vi.fn(),
  hasActiveSession: false,
  onClose: vi.fn(),
};

describe("Settings", () => {
  it("renders dialog with correct role and accessible name", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("renders header title", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("calls onClose on backdrop click", async () => {
    const onClose = vi.fn();
    render(<Settings {...defaultProps} onClose={onClose} />);
    // Radix Dialog overlay click is unreliable in jsdom; test via Escape which
    // exercises the same onOpenChange(false) path.
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("does not close when clicking inside the modal", async () => {
    const onClose = vi.fn();
    render(<Settings {...defaultProps} onClose={onClose} />);
    await userEvent.click(screen.getByText("Settings"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape key", async () => {
    const onClose = vi.fn();
    render(<Settings {...defaultProps} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on close button (x) click", async () => {
    const onClose = vi.fn();
    render(<Settings {...defaultProps} onClose={onClose} />);
    await userEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Settings - Agent → Claude tab", () => {
  it("shows Claude tab by default", () => {
    render(<Settings {...defaultProps} />);
    const tab = screen.getByRole("tab", { name: "Claude" });
    expect(tab).toHaveAttribute("data-state", "active");
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

  it("exposes API key fallback via a collapsible disclosure when unauthenticated", async () => {
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} />);
    expect(screen.queryByTestId("claude-api-key-input")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("claude-toggle-api-key"));
    const input = screen.getByTestId("claude-api-key-input");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("calls onApiKey when API key is submitted via the disclosure", async () => {
    const onApiKey = vi.fn();
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} onApiKey={onApiKey} />);
    await userEvent.click(screen.getByTestId("claude-toggle-api-key"));
    fireEvent.change(screen.getByTestId("claude-api-key-input"), { target: { value: "sk-ant-test123" } });
    await userEvent.click(screen.getByTestId("claude-api-key-submit"));
    await waitFor(() => expect(onApiKey).toHaveBeenCalledWith("sk-ant-test123"));
  });

  it("shows Open Authentication Page link when authUrl is set", () => {
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} authUrl="https://auth.example.com" />);
    const link = screen.getByTestId("claude-open-auth-url");
    expect(link).toHaveTextContent("Open Authentication Page");
    expect(link).toHaveAttribute("href", "https://auth.example.com");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows Clear API key button when authenticated", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("claude-clear-api-key")).toHaveTextContent("Clear API key");
  });

  it("calls onClearApiKey when Clear API key is clicked", async () => {
    const onClearApiKey = vi.fn();
    render(<Settings {...defaultProps} onClearApiKey={onClearApiKey} />);
    await userEvent.click(screen.getByTestId("claude-clear-api-key"));
    expect(onClearApiKey).toHaveBeenCalledOnce();
  });

  it("does not show Clear API key when not authenticated", () => {
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} authUrl="https://auth.example.com" />);
    expect(screen.queryByTestId("claude-clear-api-key")).not.toBeInTheDocument();
  });
});

describe("Settings - GitHub tab", () => {
  async function renderOnGitHubTab(props: Partial<SettingsProps> = {}) {
    const result = render(<Settings {...defaultProps} {...props} />);
    await userEvent.click(screen.getByRole("tab", { name: "GitHub" }));
    return result;
  }

  it("shows GitHubTokenForm when not authenticated", async () => {
    await renderOnGitHubTab();
    expect(screen.getByTestId("github-token-form")).toBeInTheDocument();
  });

  it("calls onGitHubTokenSubmit with trimmed token", async () => {
    const onGitHubTokenSubmit = vi.fn();
    await renderOnGitHubTab({ onGitHubTokenSubmit });
    fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "  ghp_test123  " } });
    await userEvent.click(screen.getByTestId("github-token-submit"));
    await waitFor(() => expect(onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_test123"));
  });

  it("shows connected state with username when authenticated", async () => {
    await renderOnGitHubTab({ githubStatus: { authenticated: true, username: "octocat" } });
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows Disconnect button when authenticated", async () => {
    await renderOnGitHubTab({ githubStatus: { authenticated: true, username: "octocat" } });
    expect(screen.getByTestId("settings-disconnect")).toHaveTextContent("Disconnect");
  });

  it("Disconnect button requires double-click confirmation", async () => {
    const onGitHubLogout = vi.fn();
    await renderOnGitHubTab({
      githubStatus: { authenticated: true, username: "octocat" },
      onGitHubLogout,
    });
    const btn = screen.getByTestId("settings-disconnect");
    await userEvent.click(btn);
    expect(onGitHubLogout).not.toHaveBeenCalled();
    expect(btn).toHaveTextContent("Click again to disconnect");
    await userEvent.click(btn);
    expect(onGitHubLogout).toHaveBeenCalledOnce();
  });

  it("Disconnect confirmation resets on blur", async () => {
    await renderOnGitHubTab({ githubStatus: { authenticated: true, username: "octocat" } });
    const btn = screen.getByTestId("settings-disconnect");
    await userEvent.click(btn);
    expect(btn).toHaveTextContent("Click again to disconnect");
    fireEvent.blur(btn);
    expect(btn).toHaveTextContent("Disconnect");
  });
});

describe("Settings - Git tab", () => {
  async function renderOnGitTab(props: Partial<SettingsProps> = {}) {
    const result = render(<Settings {...defaultProps} {...props} />);
    await userEvent.click(screen.getByRole("tab", { name: "Git" }));
    return result;
  }

  it("shows description text", async () => {
    await renderOnGitTab();
    expect(screen.getByText(/git identity used for automatic commits/i)).toBeInTheDocument();
  });

  it("shows name and email inputs", async () => {
    await renderOnGitTab();
    expect(screen.getByTestId("settings-git-name")).toBeInTheDocument();
    expect(screen.getByTestId("settings-git-email")).toBeInTheDocument();
  });

  it("pre-fills inputs from gitIdentity prop", async () => {
    await renderOnGitTab({ gitIdentity: { name: "Alice", email: "alice@example.com" } });
    expect(screen.getByTestId("settings-git-name")).toHaveValue("Alice");
    expect(screen.getByTestId("settings-git-email")).toHaveValue("alice@example.com");
  });

  it("Save button is disabled when name is empty", async () => {
    await renderOnGitTab({ gitIdentity: { name: "", email: "a@b.com" } });
    expect(screen.getByTestId("settings-git-save")).toBeDisabled();
  });

  it("Save button is disabled when email is empty", async () => {
    await renderOnGitTab({ gitIdentity: { name: "Alice", email: "" } });
    fireEvent.change(screen.getByTestId("settings-git-email"), { target: { value: "" } });
    expect(screen.getByTestId("settings-git-save")).toBeDisabled();
  });

  it("calls onGitIdentitySave with trimmed values on Save click", async () => {
    const onGitIdentitySave = vi.fn();
    await renderOnGitTab({ onGitIdentitySave });
    fireEvent.change(screen.getByTestId("settings-git-name"), { target: { value: "  Bob  " } });
    fireEvent.change(screen.getByTestId("settings-git-email"), { target: { value: "  bob@test.com  " } });
    await userEvent.click(screen.getByTestId("settings-git-save"));
    expect(onGitIdentitySave).toHaveBeenCalledWith("Bob", "bob@test.com");
  });

  it("shows Saved label after saving", async () => {
    const onGitIdentitySave = vi.fn();
    await renderOnGitTab({ onGitIdentitySave });
    fireEvent.change(screen.getByTestId("settings-git-name"), { target: { value: "Bob" } });
    fireEvent.change(screen.getByTestId("settings-git-email"), { target: { value: "bob@test.com" } });
    await userEvent.click(screen.getByTestId("settings-git-save"));
    expect(screen.getByTestId("settings-git-save")).toHaveTextContent("Saved");
  });

  it("resets Saved label when input changes", async () => {
    const onGitIdentitySave = vi.fn();
    await renderOnGitTab({ onGitIdentitySave });
    fireEvent.change(screen.getByTestId("settings-git-name"), { target: { value: "Bob" } });
    fireEvent.change(screen.getByTestId("settings-git-email"), { target: { value: "bob@test.com" } });
    await userEvent.click(screen.getByTestId("settings-git-save"));
    expect(screen.getByTestId("settings-git-save")).toHaveTextContent("Saved");
    fireEvent.change(screen.getByTestId("settings-git-name"), { target: { value: "Charlie" } });
    expect(screen.getByTestId("settings-git-save")).toHaveTextContent("Save");
  });

});

describe("Settings - Instructions tab", () => {
  async function renderOnInstructionsTab(props: Partial<SettingsProps> = {}) {
    const result = render(<Settings {...defaultProps} {...props} />);
    await userEvent.click(screen.getByRole("tab", { name: "Instructions" }));
    return result;
  }

  it("renders textarea with placeholder", async () => {
    await renderOnInstructionsTab();
    const textarea = screen.getByTestId("settings-textarea");
    expect(textarea).toHaveValue("");
    expect(textarea).toHaveAttribute("placeholder");
  });

  it("renders with existing content from initialContent", async () => {
    await renderOnInstructionsTab({ initialContent: "Always use TypeScript." });
    expect(screen.getByTestId("settings-textarea")).toHaveValue("Always use TypeScript.");
  });

  it("displays character count", async () => {
    await renderOnInstructionsTab({ initialContent: "Hello" });
    expect(screen.getByText("5 / 50,000")).toBeInTheDocument();
  });

  it("updates character count as user types", async () => {
    await renderOnInstructionsTab();
    fireEvent.change(screen.getByTestId("settings-textarea"), {
      target: { value: "Use strict mode." },
    });
    expect(screen.getByText("16 / 50,000")).toBeInTheDocument();
  });

  it("calls onSaveInstructions when Save is clicked", async () => {
    const onSaveInstructions = vi.fn();
    await renderOnInstructionsTab({ initialContent: "Original", onSaveInstructions });
    fireEvent.change(screen.getByTestId("settings-textarea"), {
      target: { value: "Updated content" },
    });
    await userEvent.click(screen.getByTestId("settings-save"));
    expect(onSaveInstructions).toHaveBeenCalledWith("Updated content");
  });

  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    await renderOnInstructionsTab({ onClose });
    await userEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables Save when content exceeds 50,000 characters", async () => {
    await renderOnInstructionsTab({ initialContent: "x".repeat(50_001) });
    expect(screen.getByTestId("settings-save")).toBeDisabled();
  });

  it("shows CLAUDE.md note", async () => {
    await renderOnInstructionsTab();
    expect(screen.getByText(/CLAUDE\.md/)).toBeInTheDocument();
  });

  it("calls onSaveInstructions on Ctrl+Enter", async () => {
    const onSaveInstructions = vi.fn();
    await renderOnInstructionsTab({ initialContent: "Test content", onSaveInstructions });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(onSaveInstructions).toHaveBeenCalledWith("Test content");
  });

  it("saves with empty string when content is cleared", async () => {
    const onSaveInstructions = vi.fn();
    await renderOnInstructionsTab({ initialContent: "Existing", onSaveInstructions });
    fireEvent.change(screen.getByTestId("settings-textarea"), {
      target: { value: "" },
    });
    await userEvent.click(screen.getByTestId("settings-save"));
    expect(onSaveInstructions).toHaveBeenCalledWith("");
  });
});

describe("Settings - Agent → Codex tab", () => {
  const codexInstalled = {
    id: "codex",
    name: "Codex",
    installed: true,
    authConfigured: false,
    models: ["codex-mini-latest"],
    supportsReview: false,
  };

  async function switchToCodexTab() {
    await userEvent.click(screen.getByTestId("settings-tab-agent-codex"));
  }

  it("shows the Codex sub-tab when codex is in agentList", () => {
    render(<Settings {...defaultProps} agentList={[claudeAuthed, codexInstalled]} />);
    expect(screen.getByTestId("settings-tab-agent-codex")).toBeInTheDocument();
  });

  it("hides the Codex sub-tab when agentList has no codex", () => {
    render(<Settings {...defaultProps} agentList={[claudeAuthed]} />);
    expect(screen.queryByTestId("settings-tab-agent-codex")).not.toBeInTheDocument();
  });

  it("renders CodexAuthCard inside the Codex sub-tab", async () => {
    render(<Settings {...defaultProps} agentList={[claudeAuthed, codexInstalled]} />);
    await switchToCodexTab();
    const card = screen.getByTestId("codex-auth-card");
    expect(card).toBeInTheDocument();
    // Status badge inside the card shows the agent name.
    expect(card).toHaveTextContent("Codex");
  });

  it("calls onSetAgentEnv when codex API key is submitted", async () => {
    const onSetAgentEnv = vi.fn();
    render(<Settings {...defaultProps} agentList={[claudeAuthed, codexInstalled]} onSetAgentEnv={onSetAgentEnv} />);
    await switchToCodexTab();
    // The API key input is collapsed by default — feature 119 promotes the
    // ChatGPT subscription flow as the primary affordance. Expand the
    // disclosure first.
    await userEvent.click(screen.getByTestId("codex-toggle-api-key"));
    fireEvent.change(screen.getByTestId("codex-api-key-input"), { target: { value: "sk-test-key" } });
    await userEvent.click(screen.getByTestId("codex-api-key-submit"));
    await waitFor(() => expect(onSetAgentEnv).toHaveBeenCalledWith("codex", "OPENAI_API_KEY", "sk-test-key"));
  });

  it("calls onStartCodexDeviceAuth when Sign in with ChatGPT is clicked", async () => {
    const onStartCodexDeviceAuth = vi.fn();
    render(
      <Settings
        {...defaultProps}
        agentList={[claudeAuthed, codexInstalled]}
        onStartCodexDeviceAuth={onStartCodexDeviceAuth}
      />,
    );
    await switchToCodexTab();
    await userEvent.click(screen.getByTestId("codex-start-device-auth"));
    expect(onStartCodexDeviceAuth).toHaveBeenCalledTimes(1);
  });
});

describe("Settings - Advanced tab", () => {
  async function renderOnAdvancedTab(props: Partial<SettingsProps> = {}) {
    const result = render(<Settings {...defaultProps} {...props} />);
    await userEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    return result;
  }

  it("renders Reset Container section", async () => {
    await renderOnAdvancedTab();
    expect(screen.getByText("Reset Container")).toBeInTheDocument();
    expect(screen.getByText(/Delete all sessions/)).toBeInTheDocument();
  });

  it("renders Reset Everything button", async () => {
    await renderOnAdvancedTab();
    expect(screen.getByTestId("settings-reset")).toHaveTextContent("Reset Everything");
  });

  it("first click shows confirmation text", async () => {
    await renderOnAdvancedTab();
    await userEvent.click(screen.getByTestId("settings-reset"));
    expect(screen.getByTestId("settings-reset")).toHaveTextContent("Click again to confirm reset");
  });

  it("confirmation resets on blur", async () => {
    await renderOnAdvancedTab();
    const btn = screen.getByTestId("settings-reset");
    await userEvent.click(btn);
    expect(btn).toHaveTextContent("Click again to confirm reset");
    fireEvent.blur(btn);
    expect(btn).toHaveTextContent("Reset Everything");
  });

  it("second click calls onFullReset", async () => {
    const onFullReset = vi.fn();
    await renderOnAdvancedTab({ onFullReset });
    const btn = screen.getByTestId("settings-reset");
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(onFullReset).toHaveBeenCalledOnce();
  });

  it("button shows disabled state after confirmation", async () => {
    const onFullReset = vi.fn();
    await renderOnAdvancedTab({ onFullReset });
    const btn = screen.getByTestId("settings-reset");
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(btn).toHaveTextContent("Resetting...");
    expect(btn).toBeDisabled();
  });

  it("renders Max Idle Containers section", async () => {
    await renderOnAdvancedTab();
    expect(screen.getByText("Max Idle Containers")).toBeInTheDocument();
    expect(screen.getByTestId("settings-max-idle-containers")).toHaveValue(5);
  });

  it("calls onMaxIdleContainersSave when save is clicked", async () => {
    const onMaxIdleContainersSave = vi.fn();
    await renderOnAdvancedTab({ maxIdleContainers: 3, onMaxIdleContainersSave });
    const input = screen.getByTestId("settings-max-idle-containers");
    expect(input).toHaveValue(3);
    fireEvent.change(input, { target: { value: "7" } });
    await userEvent.click(screen.getByTestId("settings-max-idle-containers-save"));
    expect(onMaxIdleContainersSave).toHaveBeenCalledWith(7);
  });
});

describe("Settings - Sidebar groups", () => {
  it("renders Agent heading", () => {
    render(<Settings {...defaultProps} />);
    // The Agent group header is rendered as plain text in the sidebar (the
    // sub-tabs underneath are labelled "Claude" / "Codex").
    const headings = screen.getAllByText("Agent");
    expect(headings.length).toBeGreaterThan(0);
  });

  it("renders General heading", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("renders Project heading", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("renders Claude sub-tab in sidebar", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("settings-tab-agent-claude")).toBeInTheDocument();
  });

  it("renders Deployments tab in sidebar", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("settings-tab-deployments")).toBeInTheDocument();
  });
});

describe("Settings - Deployments tab", () => {
  it("shows setup guide when clicked", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByTestId("settings-tab-deployments"));
    expect(screen.getByTestId("deployments-tab")).toBeInTheDocument();
    expect(screen.getByText("Automatic Deployments")).toBeInTheDocument();
  });

  it("shows platform links", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByTestId("settings-tab-deployments"));
    expect(screen.getByText("Vercel")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare Pages")).toBeInTheDocument();
    expect(screen.getByText("Netlify")).toBeInTheDocument();
  });

  it("shows how-it-works steps", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByTestId("settings-tab-deployments"));
    expect(screen.getByText("How it works")).toBeInTheDocument();
    expect(screen.getByText(/Deploy status appears/)).toBeInTheDocument();
  });
});

describe("Settings - Tab switching", () => {
  it("Agent → Claude tab is selected by default", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("claude-auth-card")).toBeInTheDocument();
  });

  it("clicking GitHub tab switches to GitHub section", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "GitHub" }));
    expect(screen.getByTestId("github-token-form")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-auth-card")).not.toBeInTheDocument();
  });

  it("clicking Git tab switches to git section", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "Git" }));
    expect(screen.getByTestId("settings-git-name")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-auth-card")).not.toBeInTheDocument();
  });

  it("clicking Instructions tab switches to instructions section", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "Instructions" }));
    expect(screen.getByTestId("settings-textarea")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-auth-card")).not.toBeInTheDocument();
  });

  it("clicking Advanced tab switches to advanced section", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.getByTestId("settings-reset")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-auth-card")).not.toBeInTheDocument();
  });

  it("clicking Claude tab switches back", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "GitHub" }));
    await userEvent.click(screen.getByRole("tab", { name: "Claude" }));
    expect(screen.getByTestId("claude-auth-card")).toBeInTheDocument();
    expect(screen.queryByTestId("github-token-form")).not.toBeInTheDocument();
  });
});

describe("Settings - Secrets tab", () => {
  function renderOnSecretsTab(props: Partial<SettingsProps> = {}) {
    useUiStore.getState().setSettingsTab("secrets");
    return render(
      <Settings
        {...defaultProps}
        hasActiveSession={true}
        repoUrl="https://github.com/org/repo"
        onSecretsLoad={async () => ({})}
        onSecretsSave={vi.fn()}
        {...props}
      />,
    );
  }

  it("renders secrets tab content", async () => {
    renderOnSecretsTab();
    await waitFor(() => {
      expect(screen.getByTestId("secrets-tab")).toBeInTheDocument();
    });
    expect(screen.getByText("Environment Variables")).toBeInTheDocument();
  });

  it("loads existing secrets on render", async () => {
    const onSecretsLoad = vi.fn().mockResolvedValue({ API_KEY: "secret123" });
    renderOnSecretsTab({ onSecretsLoad });

    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toHaveValue("API_KEY");
    });
  });

  it("adds a new row when Add variable is clicked", async () => {
    renderOnSecretsTab({ onSecretsLoad: async () => ({}) });

    await waitFor(() => {
      expect(screen.getByTestId("secret-add")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-add"));
    expect(screen.getByTestId("secret-key-0")).toBeInTheDocument();
    expect(screen.getByTestId("secret-value-0")).toBeInTheDocument();
  });

  it("removes a row when remove button is clicked", async () => {
    const onSecretsLoad = vi.fn().mockResolvedValue({ KEY_A: "a", KEY_B: "b" });
    renderOnSecretsTab({ onSecretsLoad });

    await waitFor(() => {
      expect(screen.getByTestId("secret-key-0")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId("secret-remove-0"));
    expect(screen.queryByTestId("secret-key-1")).not.toBeInTheDocument();
  });

  it("calls onSecretsSave with key-value object on save", async () => {
    const onSecretsSave = vi.fn();
    const onSecretsLoad = vi.fn().mockResolvedValue({});
    renderOnSecretsTab({ onSecretsSave, onSecretsLoad });

    await waitFor(() => {
      expect(screen.getByTestId("secret-add")).toBeInTheDocument();
    });

    // Add a row and fill in values
    await userEvent.click(screen.getByTestId("secret-add"));
    fireEvent.change(screen.getByTestId("secret-key-0"), { target: { value: "MY_KEY" } });
    fireEvent.change(screen.getByTestId("secret-value-0"), { target: { value: "my_value" } });

    await userEvent.click(screen.getByTestId("secrets-save"));
    expect(onSecretsSave).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      { MY_KEY: "my_value" },
    );
  });

  it("Secrets tab is disabled when no active session", () => {
    render(<Settings {...defaultProps} hasActiveSession={false} />);
    expect(screen.getByTestId("settings-tab-secrets")).toBeDisabled();
  });

  it("Secrets tab is enabled when session is active", () => {
    render(<Settings {...defaultProps} hasActiveSession={true} />);
    expect(screen.getByTestId("settings-tab-secrets")).not.toBeDisabled();
  });

  it("secret values use password input type", async () => {
    const onSecretsLoad = vi.fn().mockResolvedValue({ KEY: "secret" });
    renderOnSecretsTab({ onSecretsLoad });

    await waitFor(() => {
      expect(screen.getByTestId("secret-value-0")).toBeInTheDocument();
    });
    expect(screen.getByTestId("secret-value-0")).toHaveAttribute("type", "password");
  });

  // ---- Phase 5: UI polish — declared section, required, agent, platform ----

  it("renders declared secrets from preview-store snapshot", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api", "web"] }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab({ onSecretsLoad: async () => ({}) });
    await waitFor(() => {
      expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toBeInTheDocument();
    });
    // Per-service scope chips
    expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toHaveTextContent("api");
    expect(screen.getByTestId("secret-declared-STRIPE_KEY")).toHaveTextContent("web");
  });

  it("shows description for declared secrets", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{
        name: "DATABASE_URL",
        description: "PostgreSQL connection string",
        services: ["api"],
      }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab({ onSecretsLoad: async () => ({}) });
    await waitFor(() => {
      expect(screen.getByText("PostgreSQL connection string")).toBeInTheDocument();
    });
  });

  it("shows Required indicator with warning style when value is missing", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{
        name: "DATABASE_URL",
        required: true,
        services: ["api"],
      }],
      missingByService: { api: ["DATABASE_URL"] },
      missingRequired: ["DATABASE_URL"],
    });
    renderOnSecretsTab({ onSecretsLoad: async () => ({}) });
    await waitFor(() => {
      expect(screen.getByTestId("secret-required-DATABASE_URL")).toBeInTheDocument();
    });
  });

  it("shows Agent badge for `agent: true` declarations", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{
        name: "DATABASE_URL",
        agent: true,
        services: ["api"],
      }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab({ onSecretsLoad: async () => ({}) });
    await waitFor(() => {
      expect(screen.getByTestId("secret-agent-DATABASE_URL")).toBeInTheDocument();
    });
  });

  it("renders platform-sourced rows as read-only", async () => {
    usePreviewStore.getState().setSecrets({
      declared: [{
        name: "GITHUB_TOKEN",
        source: "platform:github_token",
        services: ["orchestrator"],
      }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab({ onSecretsLoad: async () => ({}) });
    await waitFor(() => {
      expect(screen.getByTestId("secret-platform-GITHUB_TOKEN")).toBeInTheDocument();
    });
    // No editable input for platform-sourced row
    expect(screen.queryByTestId("secret-value-GITHUB_TOKEN")).not.toBeInTheDocument();
    // Helpful copy mentions the platform source
    expect(screen.getByText(/Provided automatically/)).toBeInTheDocument();
  });

  it("save excludes platform-sourced rows from the payload", async () => {
    const onSecretsSave = vi.fn();
    usePreviewStore.getState().setSecrets({
      declared: [{
        name: "GITHUB_TOKEN",
        source: "platform:github_token",
        services: ["orchestrator"],
      }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab({
      onSecretsSave,
      onSecretsLoad: async () => ({ GITHUB_TOKEN: "user-stale" }),
    });
    await waitFor(() => {
      expect(screen.getByTestId("secret-platform-GITHUB_TOKEN")).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId("secrets-save"));
    expect(onSecretsSave).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      {}, // platform row stripped, no other declared/custom values
    );
  });

  it("editing a declared (non-platform) value persists it on save", async () => {
    const onSecretsSave = vi.fn();
    usePreviewStore.getState().setSecrets({
      declared: [{ name: "STRIPE_KEY", services: ["api"] }],
      missingByService: {},
      missingRequired: [],
    });
    renderOnSecretsTab({
      onSecretsSave,
      onSecretsLoad: async () => ({}),
    });
    await waitFor(() => {
      expect(screen.getByTestId("secret-value-STRIPE_KEY")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("secret-value-STRIPE_KEY"), {
      target: { value: "sk_live_x" },
    });
    await userEvent.click(screen.getByTestId("secrets-save"));
    expect(onSecretsSave).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      { STRIPE_KEY: "sk_live_x" },
    );
  });
});
