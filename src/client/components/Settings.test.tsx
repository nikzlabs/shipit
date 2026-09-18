import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings, type SettingsProps } from "./Settings.js";
import type { AgentOption } from "../agent-types.js";
import { useUiStore } from "../stores/ui-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { initialSettingValues } from "../stores/setting-values.js";

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
  useSettingsStore.getState().setGithubStatus({ authenticated: false });
  useUiStore.setState({ agentList: [] });
  useSettingsStore.setState({
    providerAccountAuths: {},
    providerAccountAuthErrors: {},
    authDiagnostics: {},
    providerAccountNotices: {},
    // The generated rows' values outlive a render, so a test that changes one
    // would otherwise seed the next.
    settingValues: initialSettingValues(),
    settingDrafts: {},
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
  onClose: vi.fn(),
};


/**
 * The harnesses come from the UI store now, not from a prop: the Services and
 * Roles panes are components their declarations name, and a registered component
 * takes the setting's key and nothing else (docs/308 slice 6b).
 */
function renderSettings(agents: AgentOption[]) {
  useUiStore.setState({ agentList: agents });
  return render(<Settings {...defaultProps} />);
}

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

describe("Settings - Model providers → Anthropic subscription", () => {
  it("opens on Model providers, with no per-vendor tab to open on instead", () => {
    render(<Settings {...defaultProps} />);
    expect(screen.getByRole("tab", { name: "Model providers" })).toHaveAttribute("data-state", "active");
    expect(screen.queryByRole("tab", { name: "Claude" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Codex" })).not.toBeInTheDocument();
  });

  it("renders the account rows inside the service's own card, titled by service", () => {
    connectAnthropicSubscription();
    render(<Settings {...defaultProps} />);
    const card = screen.getByTestId("service-card-anthropic:sub");
    expect(within(card).getByTestId("provider-account-rows-claude")).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "Anthropic" })).toBeInTheDocument();
    // The harness vendor never titles a credential card (docs/252 D2).
    expect(screen.queryByText(/Claude subscriptions/i)).not.toBeInTheDocument();

    // must not be a different flow from connecting the second.
    expect(screen.queryByTestId("claude-auth-card")).not.toBeInTheDocument();
  });

  it("lists no card at all for a subscription with no credential (req 17)", () => {

    // card exists because a credential does.
    renderSettings([claudeUnauthed]);
    expect(screen.queryByTestId("service-card-anthropic:sub")).not.toBeInTheDocument();
  });

  it("gives a connected card no way of its own to add another (req 17)", () => {
    connectAnthropicSubscription();
    renderSettings([claudeUnauthed]);
    const card = screen.getByTestId("service-card-anthropic:sub");
    expect(within(card).queryByTestId("provider-account-add-claude")).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /add/i })).not.toBeInTheDocument();

    expect(screen.getByTestId("services-add")).toBeInTheDocument();
  });

  it("creates the account and starts its sign-in from inside the add-service dialog (req 17)", async () => {

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

    renderSettings([claudeUnauthed]);
    await userEvent.click(screen.getByTestId("services-add-empty"));
    await userEvent.click(screen.getByTestId("add-service-option-anthropic"));
    await userEvent.click(screen.getByTestId("add-service-mode-sub"));
    await userEvent.click(screen.getByTestId("add-service-sign-in"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/provider-accounts",
      expect.objectContaining({ method: "POST" }),
    ));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/provider-accounts/claude/acct-1/login",
      expect.objectContaining({ method: "POST" }),
    ));
    vi.unstubAllGlobals();
  });

  it("blocks a second concurrent sign-in while one account is authenticating", async () => {
    const now = Date.now();

    const base = { serviceId: "anthropic" as const, billingMode: "sub" as const, via: "account" as const, isPrimary: false, createdAt: now, updatedAt: now };
    useSettingsStore.getState().setProviderAccounts([
      { ...base, id: "acct-a", label: "Account A", isPrimary: true, status: "authenticating" as const, externalId: "ext-a" },
      { ...base, id: "acct-b", label: "Account B", status: "unavailable" as const, externalId: "ext-b" },
    ]);

    renderSettings([claudeUnauthed]);

    await userEvent.click(screen.getByLabelText("Manage Account B"));

    expect(screen.getByTestId("provider-account-connect-acct-b")).toHaveAttribute("data-disabled");
    await userEvent.keyboard("{Escape}");

    await userEvent.click(screen.getByLabelText("Manage Account A"));

    expect(screen.getByTestId("provider-account-cancel-login-acct-a")).not.toHaveAttribute("data-disabled");
  });

  /**
   * docs/150 — the Claude CLI-output buffer is keyed by account id, so a
   * sign-in can only ever render its OWN attempt's output. It was one
   * provider-wide buffer before, which read correctly only because the server
   * refuses a second concurrent per-provider sign-in; the scoping lives in the
   * data now.
   *
   * docs/252 req 19 moved WHERE it renders: the challenge left the row for the
   * add-service dialog's step 3, because `AccountChallenge` returns `null`
   * until the auth URL arrives and the row showed nothing in between. So the
   * keying is asserted through the reconnect that opens that dialog — the
   * account whose sign-in is running gets its own output, and the other
   * account's rows carry none.
   */
  it("renders the Claude CLI output of the account whose sign-in is running, and no other", async () => {
    const now = Date.now();
    const base = { serviceId: "anthropic" as const, billingMode: "sub" as const, via: "account" as const, isPrimary: false, status: "ready" as const, externalId: "ext", createdAt: now, updatedAt: now };
    useSettingsStore.getState().setProviderAccounts([
      { ...base, id: "acct-a", label: "Account A", isPrimary: true, externalId: "ext-a" },
      { ...base, id: "acct-b", label: "Account B", externalId: "ext-b" },
    ]);
    useSettingsStore.getState().setProviderAccountAuth("anthropic-oauth", "acct-a", {
      loginId: "anthropic-oauth",
      accountId: "acct-a",
      verificationUri: "https://claude.ai/oauth/authorize?acct-a",
    });
    useSettingsStore.getState().appendAuthLog("acct-a", {
      attemptId: "attempt-a",
      timestamp: "2026-08-03T00:00:00.000Z",
      level: "info",
      source: "cli_stdout",
      message: "A's CLI output.",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    renderSettings([claudeUnauthed]);
    await userEvent.click(screen.getByLabelText("Manage Account A"));
    await userEvent.click(screen.getByTestId("provider-account-connect-acct-a"));

    expect(await screen.findByTestId("provider-account-diagnostics-acct-a")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-account-diagnostics-acct-b")).not.toBeInTheDocument();
    expect(screen.getByText(/A's CLI output\./)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  // Sessions are never pinned to an account, so there is no replacement to

  it("disconnects the last account in one click with nothing to report (docs/260-turn-level-account-routing req 3)", async () => {
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
    await userEvent.click(screen.getByLabelText("Manage Account A"));
    await userEvent.click(screen.getByTestId("provider-account-disconnect-acct-a"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/provider-accounts/claude/acct-a",
      expect.objectContaining({ method: "DELETE" }),
    ));

    await waitFor(() => expect(screen.queryByTestId("provider-account-row-acct-a")).not.toBeInTheDocument());
    expect(screen.queryByTestId("service-card-anthropic:sub")).not.toBeInTheDocument();

    expect(screen.queryByTestId("provider-account-replacement-acct-a")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-accounts-notice-claude")).not.toBeInTheDocument();
    expect(useUiStore.getState().toast).toBeNull();
    vi.unstubAllGlobals();
  });

  it("offers no second API-key editor on the subscription card", () => {
    connectAnthropicSubscription();
    renderSettings([claudeUnauthed]);
    expect(screen.queryByTestId("provider-toggle-api-key-claude")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-api-key-input-claude")).not.toBeInTheDocument();
  });

  /**
   * docs/252 req 19/21 — the row is `label \u00b7 quota \u00b7 \u22ef`. It was a
   * permanently-mounted rename input over the account's UUID, with a status
   * pill and a *Primary* badge beside three ghost buttons; the name is now
   * text, the badge is gone with the concept (`isPrimary` is stamped on read
   * from position, so it was never a property to display), and a row that is
   * fine says nothing at all.
   */
  it("renders each account as one line of its own name, with no badge and no field", () => {
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
        externalId: "ext-backup",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    render(<Settings {...defaultProps} />);

    expect(screen.getByText("Primary Anthropic")).toBeInTheDocument();
    expect(screen.getByText("Backup Anthropic")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Primary Anthropic")).not.toBeInTheDocument();
    expect(screen.queryByText("Primary")).not.toBeInTheDocument();
    // The account this install cannot authenticate says so, in words.
    expect(screen.getByTestId("provider-account-row-acct-backup-status"))
      .toHaveTextContent("reconnect needed");
  });

  /**
   * docs/252 req 19 — the challenge renders in the add-service dialog, reached
   * here by *Reconnect*, because that dialog is the one sign-in surface. The
   * account-scoped code endpoint is what this really pins: a second account's
   * code must not be submitted against the provider's singleton path.
   */
  it("renders and submits the scoped Claude authorization flow for an authenticated secondary account", async () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([{
      id: "acct-secondary",
      serviceId: "anthropic", billingMode: "sub", via: "account",
      label: "Claude account 2",
      isPrimary: false,

      status: "unavailable",

      externalId: "ext-secondary",
      createdAt: now,
      updatedAt: now,
    }]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal("fetch", fetchMock);

    renderSettings([claudeAuthed]);
    await userEvent.click(screen.getByLabelText("Manage Claude account 2"));
    await userEvent.click(screen.getByTestId("provider-account-connect-acct-secondary"));

    act(() => {
      useSettingsStore.getState().setProviderAccountAuth("anthropic-oauth", "acct-secondary", {
        loginId: "anthropic-oauth",
        accountId: "acct-secondary",
        verificationUri: "https://claude.ai/oauth/authorize?secondary=true",
      });
    });

    expect(await screen.findByRole("link", { name: "Open Anthropic authentication page" })).toHaveAttribute(
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
  /*
    The connection is read from the store rather than passed in, because the
    account is one fact with readers all over the app and a generated component
    receives only its setting's key (docs/308-data-driven-settings slice 5).
  */
  /*
    Only the GitHub routes: the other panels on this tab fetch on mount, and a
    stub that answered them all with the token response left the MCP store
    holding `undefined` where a list belongs. An unstubbed `fetch` rejects,
    which is what those panels already cope with.
  */
  function githubOnlyFetch(body: unknown) {
    const mock = vi.fn((url: string, _init?: RequestInit) =>
      url.startsWith("/api/github/")
        ? Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
        : Promise.reject(new Error(`no stub for ${url}`)));
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  async function renderOnGitHubTab(status: { authenticated: boolean; username?: string } = { authenticated: false }) {
    useSettingsStore.getState().setGithubStatus(status);
    const result = render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "Integrations" }));
    return result;
  }

  it("offers the token box whether or not a credential is stored", async () => {
    await renderOnGitHubTab();
    expect(screen.getByTestId("github-token-form")).toBeInTheDocument();

    cleanup();
    await renderOnGitHubTab({ authenticated: true, username: "octocat" });
    expect(screen.getByTestId("github-token-form")).toBeInTheDocument();
  });

  it("posts a trimmed token to the address its declaration names", async () => {
    const fetchMock = githubOnlyFetch({
      status: { authenticated: true, username: "octocat" },
      repos: [],
    });
    try {
      await renderOnGitHubTab();
      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "  ghp_test123  " } });
      await userEvent.click(screen.getByTestId("github-token-submit"));
      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([url]) => url === "/api/github/token");
        expect(call).toBeDefined();
        expect(JSON.parse((call![1] as { body: string }).body)).toEqual({ token: "ghp_test123" });
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows connected state with username when authenticated", async () => {
    await renderOnGitHubTab({ authenticated: true, username: "octocat" });
    expect(screen.getByTestId("settings-github-status")).toHaveTextContent("Connected as octocat");
  });

  it("offers Disconnect only once a credential is stored", async () => {
    await renderOnGitHubTab();
    expect(screen.queryByTestId("settings-disconnect")).toBeNull();

    cleanup();
    await renderOnGitHubTab({ authenticated: true, username: "octocat" });
    expect(screen.getByTestId("settings-disconnect")).toHaveTextContent("Disconnect");
  });

  it("Disconnect button requires double-click confirmation", async () => {
    const fetchMock = githubOnlyFetch({ status: { authenticated: false } });
    try {
      await renderOnGitHubTab({ authenticated: true, username: "octocat" });
      const btn = screen.getByTestId("settings-disconnect");
      await userEvent.click(btn);
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/github/logout")).toBe(false);
      expect(btn).toHaveTextContent("Click again to disconnect");
      await userEvent.click(btn);
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => url === "/api/github/logout")).toBe(true));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Disconnect confirmation resets on blur", async () => {
    await renderOnGitHubTab({ authenticated: true, username: "octocat" });
    const btn = screen.getByTestId("settings-disconnect");
    await userEvent.click(btn);
    expect(btn).toHaveTextContent("Click again to disconnect");
    fireEvent.blur(btn);
    expect(btn).toHaveTextContent("Disconnect");
  });
});

describe("Settings - Git tab", () => {
  async function renderOnGitTab() {
    const result = render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "Git" }));
    return result;
  }

  it("shows the declared row: its description, and a box for each half", async () => {
    useSettingsStore.getState().setSettingValue("git.identity", { name: "Alice", email: "alice@example.com" });
    await renderOnGitTab();

    expect(screen.getByText(/git identity used for automatic commits/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Alice");
    expect(screen.getByLabelText("Email")).toHaveValue("alice@example.com");
  });
});

describe("Settings - Instructions tab", () => {
  async function renderOnInstructionsTab() {
    const result = render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "Instructions" }));
    return result;
  }

  it("shows both declared boxes with their stored values", async () => {
    useSettingsStore.getState().setSettingValue("instructions.userInstructions", "Always use TypeScript.");
    useSettingsStore.getState().setSettingValue("instructions.opsInstructions", "Report a timeline.");
    await renderOnInstructionsTab();

    expect(screen.getByRole("textbox", { name: "Your Instructions" })).toHaveValue("Always use TypeScript.");
    expect(screen.getByRole("textbox", { name: "Ops Session Instructions" })).toHaveValue("Report a timeline.");
  });

  it("shows CLAUDE.md note", async () => {
    await renderOnInstructionsTab();
    expect(screen.getByText(/CLAUDE\.md/)).toBeInTheDocument();
  });

  // The built-in instructions are not a setting: the toggle beside them is, and
  // this only shows and hides the text ShipIt ships.
  it("discloses the built-in agent instructions under their toggle", async () => {
    useSettingsStore.getState().setAgentSystemInstructions("You are working inside ShipIt.");
    await renderOnInstructionsTab();

    await userEvent.click(screen.getByTestId("agent-instructions-expand"));

    expect(screen.getByTestId("agent-instructions-content"))
      .toHaveTextContent("You are working inside ShipIt.");
  });

  // Closing is what discards an unsaved edit, now that the drafts outlive the
  // control that holds them (docs/308-data-driven-settings).
  it("drops an uncommitted draft when the dialog closes", async () => {
    useSettingsStore.getState().setSettingValue("instructions.userInstructions", "Be brief.");
    const { unmount } = await renderOnInstructionsTab();
    fireEvent.change(screen.getByRole("textbox", { name: "Your Instructions" }), {
      target: { value: "Be brief. Always." },
    });
    expect(useSettingsStore.getState().settingDrafts["instructions.userInstructions"]).toBeDefined();

    unmount();

    expect(useSettingsStore.getState().settingDrafts).toEqual({});
  });
});

describe("Settings - Model providers → OpenAI subscription", () => {
  const codexInstalled = {
    id: "codex",
    name: "Codex",
    installed: true,
    hasRunnableModels: false,
    models: ["codex-mini-latest"],
    supportsReview: false,
  };

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
    renderSettings([claudeAuthed, codexInstalled]);
    const card = screen.getByTestId("service-card-openai:sub");
    expect(within(card).getByTestId("provider-account-rows-codex")).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "OpenAI" })).toBeInTheDocument();
    expect(screen.queryByTestId("codex-auth-card")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Codex" })).not.toBeInTheDocument();
  });

  it("offers no second API-key editor for OpenAI either", () => {
    connectOpenAiSubscription();
    renderSettings([claudeAuthed, codexInstalled]);
    expect(screen.queryByTestId("provider-toggle-api-key-codex")).not.toBeInTheDocument();
  });

  it("renders a Codex device code in the sign-in it belongs to (req 16)", async () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([{
      id: "acct-codex-2",
      serviceId: "openai", billingMode: "sub", via: "account",
      label: "Codex account 2",
      isPrimary: false,
      status: "unavailable",
      externalId: "ext-codex-2",
      createdAt: now,
      updatedAt: now,
    }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    renderSettings([claudeAuthed, codexInstalled]);
    await userEvent.click(screen.getByLabelText("Manage Codex account 2"));
    await userEvent.click(screen.getByTestId("provider-account-connect-acct-codex-2"));
    act(() => {
      useSettingsStore.getState().setProviderAccountAuth("openai-chatgpt", "acct-codex-2", {
        loginId: "openai-chatgpt",
        accountId: "acct-codex-2",
        verificationUri: "https://auth.openai.com/device",
        userCode: "WXYZ-1234",
      });
    });

    expect(await screen.findByTestId("provider-account-user-code-acct-codex-2")).toHaveTextContent("WXYZ-1234");
    expect(screen.getByRole("link", { name: "Open OpenAI authentication page" })).toHaveAttribute(
      "href",
      "https://auth.openai.com/device",
    );
    vi.unstubAllGlobals();
  });

  it("renders no challenge on the rows themselves, whatever their state", () => {
    const now = Date.now();
    const base = { serviceId: "openai" as const, billingMode: "sub" as const, via: "account" as const, isPrimary: false, createdAt: now, updatedAt: now };
    useSettingsStore.getState().setProviderAccounts([
      { ...base, id: "acct-a", label: "Codex A", status: "authenticating", externalId: "ext-a" },
      { ...base, id: "acct-b", label: "Codex B", status: "authenticating", externalId: "ext-b" },
    ]);
    useSettingsStore.getState().setProviderAccountAuth("openai-chatgpt", "acct-a", {
      loginId: "openai-chatgpt", accountId: "acct-a", verificationUri: "https://auth.openai.com/device", userCode: "AAAA-1111",
    });
    useSettingsStore.getState().setProviderAccountAuth("openai-chatgpt", "acct-b", {
      loginId: "openai-chatgpt", accountId: "acct-b", verificationUri: "https://auth.openai.com/device", userCode: "BBBB-2222",
    });

    renderSettings([claudeAuthed, codexInstalled]);

    expect(screen.queryByTestId("provider-account-user-code-acct-a")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-account-user-code-acct-b")).not.toBeInTheDocument();

    expect(screen.getByTestId("provider-account-row-acct-a-status")).toHaveTextContent("signing in");
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

  // The generated block places these by section name, so a renamed section
  // would drop the prose silently rather than fail to compile (docs/308 P12).
  it("keeps each section's own prose beside its generated rows", async () => {
    await renderOnAdvancedTab();
    expect(
      within(screen.getByRole("region", { name: "Conversation" }))
        .getByText(/Saved for this browser/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Notifications" }))
        .getByText(/Get notified when a session needs your attention/),
    ).toBeInTheDocument();
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

  // The declaration names a component; the block renders it in the declaration's
  // place, with no branch in the tab file naming this setting (docs/308 req 3).
  it("renders the memory budget from its declared component", async () => {
    await renderOnAdvancedTab();
    expect(screen.getByText("Memory budget")).toBeInTheDocument();
    expect(screen.getByTestId("settings-memory-budget")).toHaveValue(null);
  });

  it("renders the release-channel selector, generated from its declaration", async () => {
    await renderOnAdvancedTab();
    expect(screen.getByRole("button", { name: "Stable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edge" })).toBeInTheDocument();
  });

  // The update panel is the Software Updates section's own chrome, so the
  // channel it acts on renders beneath it rather than three sections away.
  it("keeps the release channel inside the Software Updates section", async () => {
    await renderOnAdvancedTab();
    const section = screen.getByRole("region", { name: "Software Updates" });
    expect(within(section).getByTestId("settings-check-updates")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Stable" })).toBeInTheDocument();
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

  // The channel comes from the value record, which `refreshOwnRouteSettings`
  // fills from the declaration's own route — not from the running build's
  // version, which describes the image rather than the setting.
  it("marks the stored channel via aria-pressed", async () => {
    act(() => {
      useSettingsStore.getState().setSettingValue("advanced.releaseChannel", "edge");
    });
    await renderOnAdvancedTab();
    expect(screen.getByRole("button", { name: "Edge" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Stable" })).toHaveAttribute("aria-pressed", "false");
  });

  // The declaration carries the method, the path and the body field, so the
  // generated row posts the same request the hand-written one did (P2).
  it("POSTs the chosen channel to the route its declaration names", async () => {
    act(() => {
      useSettingsStore.getState().setSettingValue("advanced.releaseChannel", "edge");
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    try {
      await renderOnAdvancedTab();
      await userEvent.click(screen.getByRole("button", { name: "Stable" }));
      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/updates/channel",
          expect.objectContaining({ method: "POST", body: JSON.stringify({ channel: "stable" }) }),
        );
      });
      expect(screen.getByRole("button", { name: "Stable" })).toHaveAttribute("aria-pressed", "true");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // A check describes one channel. The route drops its own answer when the
  // channel moves, and the panel has to do the same or it shows the other
  // channel's update as this one's.
  it("replaces a stale update status by checking the channel just chosen", async () => {
    act(() => {
      useSettingsStore.getState().setSettingValue("advanced.releaseChannel", "edge");
    });
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
      await waitFor(() => expect(screen.getByText(/commits behind/)).toBeInTheDocument());

      // The switch stores the channel, and what was on screen described the one
      // just left — so the panel asks again and shows the new channel's answer,
      // which is what the write's own response used to carry.
      fetchSpy.mockImplementation((url: unknown) => Promise.resolve(
        String(url) === "/api/updates/check"
          ? new Response(JSON.stringify({
              available: true, behindBy: 0, commitMessages: [], currentCommit: "abc1234",
              channel: "stable", currentVersion: "main @ abc1234", latestVersion: "v1.3.0",
              isDowngrade: true,
            }), { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      ));

      await userEvent.click(screen.getByRole("button", { name: "Stable" }));
      await waitFor(() => expect(screen.queryByText(/commits behind/)).not.toBeInTheDocument());
      await waitFor(() =>
        expect(screen.getByTestId("settings-downgrade-warning")).toBeInTheDocument());
    } finally {
      fetchSpy.mockRestore();
    }
  });

  /*
    The other ordering: a check that was already running when the channel moved.
    Its answer names the channel it describes, and that is no longer the one on
    screen — showing it would put Edge's changelog and an enabled "Update Now"
    under a Stable selection.
  */
  it("drops a check that finishes after the channel it describes was left", async () => {
    act(() => {
      useSettingsStore.getState().setSettingValue("advanced.releaseChannel", "edge");
    });
    let finishCheck!: () => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url: unknown) => {
      if (String(url) !== "/api/updates/check") {
        return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return new Promise((resolve) => {
        finishCheck = () => { resolve(new Response(JSON.stringify({
          available: true, behindBy: 4, commitMessages: ["feat: a"], currentCommit: "abc1234",
          channel: "edge", currentVersion: "main @ abc1234", latestVersion: "main @ def5678",
          isDowngrade: false,
        }), { status: 200, headers: { "Content-Type": "application/json" } })); };
      });
    });
    try {
      await renderOnAdvancedTab();
      await userEvent.click(screen.getByTestId("settings-check-updates"));
      await userEvent.click(screen.getByRole("button", { name: "Stable" }));
      await act(async () => { finishCheck(); await Promise.resolve(); });

      expect(screen.queryByText(/commits behind/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Stable" })).toHaveAttribute("aria-pressed", "true");
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

  it("lists one flat group with Model providers first and no vendor tabs", () => {
    render(<Settings {...defaultProps} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveTextContent("Model providers");
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
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-auth-card")).not.toBeInTheDocument();
  });

  it("clicking Instructions tab switches to instructions section", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "Instructions" }));
    expect(screen.getByRole("textbox", { name: "Your Instructions" })).toBeInTheDocument();
    expect(screen.queryByTestId("claude-auth-card")).not.toBeInTheDocument();
  });

  it("clicking Advanced tab switches to advanced section", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.getByTestId("settings-reset")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-auth-card")).not.toBeInTheDocument();
  });

  it("clicking Model providers switches back", async () => {
    render(<Settings {...defaultProps} />);
    await userEvent.click(screen.getByRole("tab", { name: "Integrations" }));
    await userEvent.click(screen.getByRole("tab", { name: "Model providers" }));
    expect(screen.getByTestId("services-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("github-token-form")).not.toBeInTheDocument();
  });
});
