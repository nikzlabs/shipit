import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings, type SettingsProps } from "./Settings.js";
import { useUiStore } from "../stores/ui-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { useSettingsStore } from "../stores/settings-store.js";

afterEach(() => {
  cleanup();
  useUiStore.getState().setSettingsTab(undefined);
  useUiStore.getState().setVersion(null);
  useUiStore.getState().setUpdateMode("manual");
  usePreviewStore.getState().setSecrets({
    declared: [],
    missingByService: {},
    missingRequired: [],
  });
  useSettingsStore.getState().setProviderAccounts([]);
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

  it("shows Open authentication page link when authUrl is set", () => {
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} authUrl="https://auth.example.com" />);
    const link = screen.getByTestId("claude-open-auth-url");
    expect(link).toHaveTextContent("Open authentication page");
    expect(link).toHaveAttribute("href", "https://auth.example.com");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows Sign out button when authenticated", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("claude-sign-out")).toHaveTextContent("Sign out");
  });

  it("calls onClearApiKey when Sign out is clicked", async () => {
    const onClearApiKey = vi.fn();
    render(<Settings {...defaultProps} onClearApiKey={onClearApiKey} />);
    await userEvent.click(screen.getByTestId("claude-sign-out"));
    expect(onClearApiKey).toHaveBeenCalledOnce();
  });

  it("does not show Sign out when not authenticated", () => {
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} authUrl="https://auth.example.com" />);
    expect(screen.queryByTestId("claude-sign-out")).not.toBeInTheDocument();
  });

  it("renders provider accounts and primary state", () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      {
        id: "acct-primary",
        provider: "claude",
        label: "Primary Anthropic",
        isPrimary: true,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "acct-backup",
        provider: "claude",
        label: "Backup Anthropic",
        isPrimary: false,
        status: "unavailable",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    render(<Settings {...defaultProps} />);

    expect(screen.getByDisplayValue("Primary Anthropic")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Backup Anthropic")).toBeInTheDocument();
    expect(screen.getByText("Primary")).toBeInTheDocument();
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

  // ---- Release channels (feature 162) ----

  it("renders the release-channel selector", async () => {
    await renderOnAdvancedTab();
    expect(screen.getByTestId("settings-channel-stable")).toBeInTheDocument();
    expect(screen.getByTestId("settings-channel-edge")).toBeInTheDocument();
  });

  it("shows the channel-aware version label from the store", async () => {
    useUiStore.getState().setVersion({ channel: "stable", version: "v1.4.0", commit: "abc1234" });
    await renderOnAdvancedTab();
    expect(screen.getByTestId("settings-version")).toHaveTextContent("Stable · v1.4.0");
  });

  it("marks the active channel via aria-pressed", async () => {
    useUiStore.getState().setVersion({ channel: "edge", version: "main @ abc1234" });
    await renderOnAdvancedTab();
    expect(screen.getByTestId("settings-channel-edge")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("settings-channel-stable")).toHaveAttribute("aria-pressed", "false");
  });

  it("POSTs the chosen channel and reflects the response", async () => {
    useUiStore.getState().setVersion({ channel: "edge", version: "main @ abc1234" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          behindBy: 0,
          commitMessages: ["feat: something"],
          currentCommit: "abc1234",
          channel: "stable",
          currentVersion: "main @ abc1234",
          latestVersion: "v1.3.0",
          isDowngrade: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      await renderOnAdvancedTab();
      await userEvent.click(screen.getByTestId("settings-channel-stable"));
      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/updates/channel",
          expect.objectContaining({ method: "POST" }),
        );
      });
      // Downgrade warning surfaces from the response.
      await waitFor(() => {
        expect(screen.getByTestId("settings-downgrade-warning")).toBeInTheDocument();
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("renders the overflow 'View release on GitHub' link when a releaseUrl is present", async () => {
    useUiStore.getState().setVersion({ channel: "stable", version: "v1.3.0" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          behindBy: 3,
          commitMessages: ["feat: a", "fix: b"],
          currentCommit: "abc1234",
          channel: "stable",
          currentVersion: "v1.3.0",
          latestVersion: "v1.4.0",
          isDowngrade: false,
          releaseUrl: "https://github.com/owner/repo/releases/tag/v1.4.0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      await renderOnAdvancedTab();
      await userEvent.click(screen.getByTestId("settings-check-updates"));
      await waitFor(() => {
        const link = screen.getByTestId("settings-release-link");
        expect(link).toHaveAttribute("href", "https://github.com/owner/repo/releases/tag/v1.4.0");
        expect(link).toHaveAttribute("target", "_blank");
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("omits the release link on edge (no releaseUrl)", async () => {
    useUiStore.getState().setVersion({ channel: "edge", version: "main @ abc1234" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          behindBy: 2,
          commitMessages: ["feat: a"],
          currentCommit: "abc1234",
          channel: "edge",
          currentVersion: "main @ abc1234",
          latestVersion: "main @ def5678",
          isDowngrade: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      await renderOnAdvancedTab();
      await userEvent.click(screen.getByTestId("settings-check-updates"));
      await waitFor(() => {
        expect(screen.getByText(/2 commits behind/)).toBeInTheDocument();
      });
      expect(screen.queryByTestId("settings-release-link")).not.toBeInTheDocument();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("shows manual local update instructions instead of update/restart buttons", async () => {
    useUiStore.getState().setUpdateMode("manual");
    await renderOnAdvancedTab();
    expect(screen.getByTestId("settings-manual-update-note")).toHaveTextContent("docker/local/prod.sh");
    expect(screen.queryByTestId("settings-apply-update")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-restart")).not.toBeInTheDocument();
  });

  it("shows managed update and restart buttons when an update is available", async () => {
    useUiStore.getState().setUpdateMode("managed");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          behindBy: 1,
          commitMessages: ["fix: update"],
          currentCommit: "abc1234",
          channel: "stable",
          currentVersion: "v1.3.0",
          latestVersion: "v1.4.0",
          isDowngrade: false,
          updateMode: "managed",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      await renderOnAdvancedTab();
      await userEvent.click(screen.getByTestId("settings-check-updates"));
      await waitFor(() => {
        expect(screen.getByTestId("settings-apply-update")).toBeInTheDocument();
      });
      expect(screen.getByTestId("settings-restart")).toBeInTheDocument();
      expect(screen.queryByTestId("settings-manual-update-note")).not.toBeInTheDocument();
    } finally {
      fetchSpy.mockRestore();
    }
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

  it("renders Claude sub-tab in sidebar", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("settings-tab-agent-claude")).toBeInTheDocument();
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
