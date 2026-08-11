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
  useSettingsStore.getState().setCredentialRoutes([]);
  useSettingsStore.setState({
    providerAccountAuths: {},
    providerAccountAuthErrors: {},
    claudeAuthDiagnostics: {},
    providerAccountNotices: {},
  });
});

/**
 * docs/252 req 17 — a card exists because a credential does, and there is no
 * longer any way to summon an empty one: the reveal these tests used to call
 * went with the hand-off that needed it. So a test that wants Anthropic's
 * subscription card connects an account, which is what a user does.
 */
function connectAnthropicSubscription(status: "ready" | "authenticating" = "ready") {
  const now = Date.now();
  useSettingsStore.getState().setProviderAccounts([{
    id: "acct-seed",
    serviceId: "anthropic", billingMode: "sub", via: "account",
    label: "Anthropic account",
    isPrimary: true,
    status,
    createdAt: now,
    updatedAt: now,
  }]);
}

const claudeAuthed = { id: "claude", name: "Claude Code", installed: true, hasRunnableModels: true, models: ["claude-sonnet"], supportsReview: true };
const claudeUnauthed = { ...claudeAuthed, hasRunnableModels: false };

const defaultProps: SettingsProps = {
  initialContent: "",
  onSaveInstructions: vi.fn(),
  githubStatus: { authenticated: false },
  onGitHubTokenSubmit: vi.fn(),
  onGitHubLogout: vi.fn(),
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

describe("Settings - Services → Anthropic subscription", () => {
  it("opens on Services, with no per-vendor tab to open on instead", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByRole("tab", { name: "Services" })).toHaveAttribute("data-state", "active");
    expect(screen.queryByRole("tab", { name: "Claude" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Codex" })).not.toBeInTheDocument();
  });

  /**
   * The whole point of the unification: the account rows sit INSIDE the same
   * `ServiceCard` a string-delivered credential gets, rather than in a
   * borderless block above the list. A card-shaped assertion is what catches a
   * regression back to two components; asserting the rows exist would not.
   */
  it("renders the account rows inside the service's own card, titled by service", () => {
    connectAnthropicSubscription();
    render(<Settings {...defaultProps} />);
    const card = screen.getByTestId("service-card-anthropic:sub");
    expect(within(card).getByTestId("provider-account-rows-claude")).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "Anthropic" })).toBeInTheDocument();
    // The harness vendor never titles a credential card (docs/252 D2).
    expect(screen.queryByText(/Claude subscriptions/i)).not.toBeInTheDocument();
    // The provider-wide singleton card is gone — connecting the first account
    // must not be a different flow from connecting the second.
    expect(screen.queryByTestId("claude-auth-card")).not.toBeInTheDocument();
  });

  it("lists no card at all for a subscription with no credential (req 17)", () => {
    // The state the reveal used to create, and could not undo: a service listed
    // with nothing in it and no way to remove it. It is now unreachable — a
    // card exists because a credential does.
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} />);
    expect(screen.queryByTestId("service-card-anthropic:sub")).not.toBeInTheDocument();
  });

  it("gives a connected card no way of its own to add another (req 17)", () => {
    connectAnthropicSubscription();
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} />);
    const card = screen.getByTestId("service-card-anthropic:sub");
    expect(within(card).queryByTestId("provider-account-add-claude")).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /add/i })).not.toBeInTheDocument();
    // The one door, on the panel rather than the card.
    expect(screen.getByTestId("services-add")).toBeInTheDocument();
  });

  it("creates the account and starts its sign-in from inside the add-service dialog (req 17)", async () => {
    // req 17 — the sign-in is the last step of the one flow, not a hand-off to
    // a button on a card. The card does not exist yet at this point, and that
    // is the change: the account is what brings it into being.
    const now = Date.now();
    const created = {
      id: "acct-1",
      serviceId: "anthropic" as const, billingMode: "sub" as const, via: "account" as const,
      label: "Claude account 1",
      isPrimary: true,
      status: "authenticating" as const,
      createdAt: now,
      updatedAt: now,
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ accounts: [created] }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} />);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await userEvent.click(screen.getByTestId("add-service-sign-in"));

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

  // docs/150 — one login process per provider, so the server rejects a second
  // concurrent sign-in with a 409. Surface that as a disabled affordance rather
  // than letting the user click into the refusal.
  it("blocks a second concurrent sign-in while one account is authenticating", () => {
    const now = Date.now();
    const base = { serviceId: "anthropic" as const, billingMode: "sub" as const, via: "account" as const, isPrimary: false, createdAt: now, updatedAt: now };
    useSettingsStore.getState().setProviderAccounts([
      { ...base, id: "acct-a", label: "Account A", isPrimary: true, status: "authenticating" as const },
      { ...base, id: "acct-b", label: "Account B", status: "unavailable" as const },
    ]);

    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} />);

    // The row that is NOT signing in can't start a competing flow...
    expect(screen.getByTestId("provider-account-connect-acct-b")).toBeDisabled();
    // ...and the one that is keeps its own way out.
    expect(screen.getByTestId("provider-account-cancel-login-acct-a")).toBeEnabled();
  });

  // docs/150 — the Claude CLI-output buffer is keyed by account id, so a row
  // can only ever render its OWN attempt's output. It was one provider-wide
  // buffer before, which read correctly only because the server refuses a
  // second concurrent per-provider sign-in; the scoping now lives in the data.
  it("renders a row's Claude CLI output only on the account that produced it", () => {
    const now = Date.now();
    const base = { serviceId: "anthropic" as const, billingMode: "sub" as const, via: "account" as const, isPrimary: false, status: "ready" as const, createdAt: now, updatedAt: now };
    useSettingsStore.getState().setProviderAccounts([
      { ...base, id: "acct-a", label: "Account A", isPrimary: true },
      { ...base, id: "acct-b", label: "Account B" },
    ]);
    // Both rows carry a live challenge — the condition under which the shared
    // buffer would have rendered twice.
    for (const id of ["acct-a", "acct-b"]) {
      useSettingsStore.getState().setProviderAccountAuth("claude", id, {
        provider: "claude",
        accountId: id,
        verificationUri: `https://claude.ai/oauth/authorize?${id}`,
      });
    }
    useSettingsStore.getState().appendClaudeAuthLog("acct-a", {
      attemptId: "attempt-a",
      timestamp: "2026-08-03T00:00:00.000Z",
      level: "info",
      source: "claude_stdout",
      message: "A's CLI output.",
    });

    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} />);

    expect(screen.getByTestId("provider-account-diagnostics-acct-a")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-account-diagnostics-acct-b")).not.toBeInTheDocument();
    expect(screen.getByText(/A's CLI output\./)).toBeInTheDocument();
  });

  // docs/260 req 3 — disconnecting is one click, even for the last account.
  // Sessions are never pinned to an account, so there is no replacement to
  // pick and no moved/stranded bookkeeping to report: the row disappears, the
  // response carries `{accounts}` only, and each session simply routes among
  // whatever accounts remain at its next turn.
  it("disconnects the last account in one click with nothing to report (docs/260 req 3)", async () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      { serviceId: "anthropic", billingMode: "sub", via: "account", id: "acct-a", label: "Account A", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accounts: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Settings {...defaultProps} />);
    await userEvent.click(within(screen.getByTestId("provider-account-row-acct-a")).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/provider-accounts/claude/acct-a",
      expect.objectContaining({ method: "DELETE" }),
    ));
    // The row is gone, and with the last credential gone so is the card —
    // req 17's "a service the user has not connected does not appear", arrived
    // at from the other direction. There is nothing left to keep it on screen:
    // a *reported* disconnect keeps its card through the notice clause, and
    // this one has nothing to report.
    await waitFor(() => expect(screen.queryByTestId("provider-account-row-acct-a")).not.toBeInTheDocument());
    expect(screen.queryByTestId("service-card-anthropic:sub")).not.toBeInTheDocument();
    // No replacement picker, no moved/stranded notice, no toast (req 3).
    expect(screen.queryByTestId("provider-account-replacement-acct-a")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-accounts-notice-claude")).not.toBeInTheDocument();
    expect(useUiStore.getState().toast).toBeNull();
    vi.unstubAllGlobals();
  });

  /**
   * The collapsed "Use an API key instead" disclosure is gone with the vendor
   * tabs. It wrote through to the very credential the Services add-flow writes
   * (`anthropic:key`), so it was a second editor for one fact — and the card it
   * produced is one row down in the same list.
   */
  it("offers no second API-key editor on the subscription card", () => {
    connectAnthropicSubscription();
    render(<Settings {...defaultProps} agentList={[claudeUnauthed]} />);
    expect(screen.queryByTestId("provider-toggle-api-key-claude")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-api-key-input-claude")).not.toBeInTheDocument();
  });

  it("renders provider accounts and primary state", () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      {
        id: "acct-primary",
        serviceId: "anthropic", billingMode: "sub", via: "account",
        label: "Primary Anthropic",
        isPrimary: true,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "acct-backup",
        serviceId: "anthropic", billingMode: "sub", via: "account",
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
      serviceId: "anthropic", billingMode: "sub", via: "account",
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

    expect(screen.getByRole("link", { name: "Open Anthropic authentication page" })).toHaveAttribute(
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

describe("Settings - Services → OpenAI subscription", () => {
  const codexInstalled = {
    id: "codex",
    name: "Codex",
    installed: true,
    hasRunnableModels: false,
    models: ["codex-mini-latest"],
    supportsReview: false,
  };

  /** As above: the card is summoned by connecting an account, not by a reveal. */
  function connectOpenAiSubscription() {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([{
      id: "acct-openai",
      serviceId: "openai", billingMode: "sub", via: "account",
      label: "OpenAI account",
      isPrimary: true,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    }]);
  }

  it("renders OpenAI's account rows in the same card component, not a Codex tab", () => {
    connectOpenAiSubscription();
    render(<Settings {...defaultProps} agentList={[claudeAuthed, codexInstalled]} />);
    const card = screen.getByTestId("service-card-openai:sub");
    expect(within(card).getByTestId("provider-account-rows-codex")).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "OpenAI" })).toBeInTheDocument();
    expect(screen.queryByTestId("codex-auth-card")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Codex" })).not.toBeInTheDocument();
  });

  it("offers no second API-key editor for OpenAI either", () => {
    connectOpenAiSubscription();
    render(<Settings {...defaultProps} agentList={[claudeAuthed, codexInstalled]} />);
    expect(screen.queryByTestId("provider-toggle-api-key-codex")).not.toBeInTheDocument();
  });

  it("renders a Codex device code on the row that started the sign-in (req 16)", () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([{
      id: "acct-codex-2",
      serviceId: "openai", billingMode: "sub", via: "account",
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

    // The device code belongs to the row, not to a provider-wide card — the
    // shared row shell renders the device-code variant here and the
    // code-paste variant for Claude.
    expect(screen.getByTestId("provider-account-user-code-acct-codex-2")).toHaveTextContent("WXYZ-1234");
    expect(screen.getByRole("link", { name: "Open OpenAI authentication page" })).toHaveAttribute(
      "href",
      "https://auth.openai.com/device",
    );
  });

  it("keeps two concurrent row sign-ins independent", () => {
    const now = Date.now();
    const base = { serviceId: "openai" as const, billingMode: "sub" as const, via: "account" as const, isPrimary: false, createdAt: now, updatedAt: now };
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

describe("Settings - Sidebar", () => {
  /**
   * docs/252 — one flat list, led by Services. The "Agent" group and its two
   * per-vendor tabs are gone: a credential belongs to a service, not to the
   * harness that drives it, so there is no vendor axis left to group on.
   */
  it("lists one flat group with Services first and no vendor tabs", () => {
    render(<Settings {...defaultProps} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveTextContent("Services");
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("General")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-tab-agent-claude")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-tab-agent-codex")).not.toBeInTheDocument();
  });
});

describe("Settings - Tab switching", () => {
  it("Services is selected by default", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByTestId("services-panel")).toBeInTheDocument();
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

  it("clicking Services switches back", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "Integrations" }));
    await userEvent.click(screen.getByRole("tab", { name: "Services" }));
    expect(screen.getByTestId("services-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("github-token-form")).not.toBeInTheDocument();
  });
});
