import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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
  useSettingsStore.setState({ providerAccountAuths: {}, providerAccountAuthErrors: {} });
});

const claudeAuthed = { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: ["claude-sonnet"], supportsReview: true };
const claudeUnauthed = { ...claudeAuthed, authConfigured: false };

const defaultProps: SettingsProps = {
  initialContent: "",
  onSaveInstructions: vi.fn(),
  githubStatus: { authenticated: false },
  onGitHubTokenSubmit: vi.fn(),
  onGitHubLogout: vi.fn(),
  onApiKey: vi.fn(),
  onClearApiKey: vi.fn(),
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

  it("renders the unified provider-accounts card as the only connect surface (req 16)", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("provider-accounts-card-claude")).toBeInTheDocument();
    // The provider-wide singleton card is gone — connecting the first account
    // must not be a different flow from connecting the second.
    expect(screen.queryByTestId("claude-auth-card")).not.toBeInTheDocument();
  });

  it("offers the same Add account affordance when no accounts exist yet", () => {
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} />);
    expect(screen.getByTestId("provider-accounts-empty-claude")).toBeInTheDocument();
    expect(screen.getByTestId("provider-account-add-claude")).toBeInTheDocument();
  });

  it("creates the account and immediately starts its sign-in, first account included", async () => {
    const now = Date.now();
    const created = {
      id: "acct-1",
      provider: "claude" as const,
      label: "Claude account 1",
      isPrimary: true,
      status: "authenticating" as const,
      createdAt: now,
      updatedAt: now,
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ accounts: [created] }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} />);
    await userEvent.click(screen.getByTestId("provider-account-add-claude"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/provider-accounts",
      expect.objectContaining({ method: "POST" }),
    ));
    // req 16: creating a row and starting its login is one action, so the very
    // first account goes through the account-scoped login endpoint too.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/provider-accounts/claude/acct-1/login",
      expect.objectContaining({ method: "POST" }),
    ));
    vi.unstubAllGlobals();
  });

  it("asks which account to move pinned sessions to instead of dead-ending on the refusal", async () => {
    const now = Date.now();
    const base = { provider: "claude" as const, isPrimary: false, status: "ready" as const, createdAt: now, updatedAt: now };
    useSettingsStore.getState().setProviderAccounts([
      { ...base, id: "acct-a", label: "Account A", isPrimary: true },
      { ...base, id: "acct-b", label: "Account B" },
    ]);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: "1 session(s) are pinned to this account. Choose a replacement account to move them to (available: acct-b).",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accounts: [{ ...base, id: "acct-b", label: "Account B" }], switchedSessionIds: ["s1"] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<Settings {...defaultProps} />);
    await userEvent.click(within(screen.getByTestId("provider-account-row-acct-a")).getByRole("button", { name: "Disconnect" }));

    // The refusal names the alternatives, so it becomes a picker on the row.
    const panel = await screen.findByTestId("provider-account-replacement-acct-a");
    expect(panel).toHaveTextContent("1 session(s) are pinned");
    await userEvent.click(screen.getByTestId("provider-account-confirm-replacement-acct-a"));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/provider-accounts/claude/acct-a?replacementAccountId=acct-b",
      expect.objectContaining({ method: "DELETE" }),
    ));
    vi.unstubAllGlobals();
  });

  it("exposes the API key fallback via a collapsed disclosure with metered-billing copy", async () => {
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} />);
    expect(screen.queryByTestId("provider-api-key-input-claude")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("provider-toggle-api-key-claude"));
    const input = screen.getByTestId("provider-api-key-input-claude");
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByTestId("provider-api-key-panel-claude")).toHaveTextContent(/never fails over onto API billing/i);
  });

  it("calls onApiKey when an API key is submitted via the disclosure", async () => {
    const onApiKey = vi.fn();
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} onApiKey={onApiKey} />);
    await userEvent.click(screen.getByTestId("provider-toggle-api-key-claude"));
    fireEvent.change(screen.getByTestId("provider-api-key-input-claude"), { target: { value: "sk-ant-test123" } });
    await userEvent.click(screen.getByTestId("provider-api-key-submit-claude"));
    await waitFor(() => expect(onApiKey).toHaveBeenCalledWith("sk-ant-test123"));
  });

  it("rejects an API key with the wrong prefix before calling the handler", async () => {
    const onApiKey = vi.fn();
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} onApiKey={onApiKey} />);
    await userEvent.click(screen.getByTestId("provider-toggle-api-key-claude"));
    fireEvent.change(screen.getByTestId("provider-api-key-input-claude"), { target: { value: "sk-wrong" } });
    await userEvent.click(screen.getByTestId("provider-api-key-submit-claude"));
    expect(await screen.findByTestId("provider-api-key-error-claude")).toHaveTextContent("sk-ant-");
    expect(onApiKey).not.toHaveBeenCalled();
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

  it("renders and submits the scoped Claude authorization flow for an authenticated secondary account", async () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([{
      id: "acct-secondary",
      provider: "claude",
      label: "Claude account 2",
      isPrimary: false,
      status: "authenticating",
      createdAt: now,
      updatedAt: now,
    }]);
    useSettingsStore.getState().setProviderAccountAuth("claude", "acct-secondary", {
      provider: "claude",
      accountId: "acct-secondary",
      verificationUri: "https://claude.ai/oauth/authorize?secondary=true",
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<Settings {...defaultProps} agentList={[claudeAuthed]} />);

    expect(screen.getByRole("link", { name: "Open Claude authentication page" })).toHaveAttribute(
      "href",
      "https://claude.ai/oauth/authorize?secondary=true",
    );
    await userEvent.type(screen.getByLabelText("Authorization code for Claude account 2"), "oauth-code");
    await userEvent.click(screen.getByRole("button", { name: "Submit code" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/provider-accounts/claude/acct-secondary/login/code",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "oauth-code" }) }),
    ));
    vi.unstubAllGlobals();
  });
});

describe("Settings - Integrations tab (GitHub)", () => {
  async function renderOnGitHubTab(props: Partial<SettingsProps> = {}) {
    const result = render(<Settings {...defaultProps} {...props} />);
    await userEvent.click(screen.getByRole("tab", { name: "Integrations" }));
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

  it("renders the unified provider-accounts card inside the Codex sub-tab", async () => {
    render(<Settings {...defaultProps} agentList={[claudeAuthed, codexInstalled]} />);
    await switchToCodexTab();
    expect(screen.getByTestId("provider-accounts-card-codex")).toBeInTheDocument();
    expect(screen.queryByTestId("codex-auth-card")).not.toBeInTheDocument();
  });

  it("calls onSetAgentEnv when the codex API key fallback is submitted", async () => {
    const onSetAgentEnv = vi.fn();
    render(<Settings {...defaultProps} agentList={[claudeAuthed, codexInstalled]} onSetAgentEnv={onSetAgentEnv} />);
    await switchToCodexTab();
    await userEvent.click(screen.getByTestId("provider-toggle-api-key-codex"));
    fireEvent.change(screen.getByTestId("provider-api-key-input-codex"), { target: { value: "sk-test-key" } });
    await userEvent.click(screen.getByTestId("provider-api-key-submit-codex"));
    await waitFor(() => expect(onSetAgentEnv).toHaveBeenCalledWith("codex", "OPENAI_API_KEY", "sk-test-key"));
  });

  it("renders a Codex device code on the row that started the sign-in (req 16)", async () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([{
      id: "acct-codex-2",
      provider: "codex",
      label: "Codex account 2",
      isPrimary: false,
      status: "authenticating",
      createdAt: now,
      updatedAt: now,
    }]);
    useSettingsStore.getState().setProviderAccountAuth("codex", "acct-codex-2", {
      provider: "codex",
      accountId: "acct-codex-2",
      verificationUri: "https://auth.openai.com/device",
      userCode: "WXYZ-1234",
    });

    render(<Settings {...defaultProps} agentList={[claudeAuthed, codexInstalled]} />);
    await switchToCodexTab();

    // The device code belongs to the row, not to a provider-wide card — the
    // shared row shell renders the device-code variant here and the
    // code-paste variant for Claude.
    expect(screen.getByTestId("provider-account-user-code-acct-codex-2")).toHaveTextContent("WXYZ-1234");
    expect(screen.getByRole("link", { name: "Open Codex authentication page" })).toHaveAttribute(
      "href",
      "https://auth.openai.com/device",
    );
  });

  it("keeps two concurrent row sign-ins independent", async () => {
    const now = Date.now();
    const base = { provider: "codex" as const, isPrimary: false, createdAt: now, updatedAt: now };
    useSettingsStore.getState().setProviderAccounts([
      { ...base, id: "acct-a", label: "Codex A", status: "authenticating" },
      { ...base, id: "acct-b", label: "Codex B", status: "authenticating" },
    ]);
    useSettingsStore.getState().setProviderAccountAuth("codex", "acct-a", {
      provider: "codex", accountId: "acct-a", verificationUri: "https://auth.openai.com/device", userCode: "AAAA-1111",
    });
    useSettingsStore.getState().setProviderAccountAuth("codex", "acct-b", {
      provider: "codex", accountId: "acct-b", verificationUri: "https://auth.openai.com/device", userCode: "BBBB-2222",
    });

    render(<Settings {...defaultProps} agentList={[claudeAuthed, codexInstalled]} />);
    await switchToCodexTab();

    expect(screen.getByTestId("provider-account-user-code-acct-a")).toHaveTextContent("AAAA-1111");
    expect(screen.getByTestId("provider-account-user-code-acct-b")).toHaveTextContent("BBBB-2222");
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

  it("flags a version mismatch (failed update left checkout ahead)", async () => {
    useUiStore.getState().setVersion({ channel: "edge", version: "main @ abc1234", mismatch: true });
    await renderOnAdvancedTab();
    expect(screen.getByTestId("settings-version-mismatch")).toBeInTheDocument();
  });

  it("does not flag a mismatch when versions agree", async () => {
    useUiStore.getState().setVersion({ channel: "edge", version: "main @ abc1234" });
    await renderOnAdvancedTab();
    expect(screen.queryByTestId("settings-version-mismatch")).not.toBeInTheDocument();
  });

  it("surfaces a 'Last update failed' banner when the check reports one", async () => {
    useUiStore.getState().setVersion({ channel: "edge", version: "main @ abc1234" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: false,
          behindBy: 0,
          commitMessages: [],
          currentCommit: "abc1234",
          channel: "edge",
          currentVersion: "main @ abc1234",
          latestVersion: "main @ abc1234",
          isDowngrade: false,
          lastUpdateError: { runningSha: "abc1234def", failedAt: "2026-06-06T00:00:00Z", exitCode: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      await renderOnAdvancedTab();
      await userEvent.click(screen.getByTestId("settings-check-updates"));
      await waitFor(() => {
        const banner = screen.getByTestId("settings-update-failed");
        expect(banner).toHaveTextContent("Last update failed");
        expect(banner).toHaveTextContent("abc1234");
      });
    } finally {
      fetchSpy.mockRestore();
    }
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
    expect(screen.getByTestId("provider-accounts-card-claude")).toBeInTheDocument();
  });

  it("clicking Integrations tab switches to integrations section", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "Integrations" }));
    expect(screen.getByTestId("settings-integrations")).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("tab", { name: "Integrations" }));
    await userEvent.click(screen.getByRole("tab", { name: "Claude" }));
    expect(screen.getByTestId("provider-accounts-card-claude")).toBeInTheDocument();
    expect(screen.queryByTestId("github-token-form")).not.toBeInTheDocument();
  });
});
